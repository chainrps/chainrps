"""
房间管理服务模块

负责 ChainRPS 的房间模式功能：
- 创建房间（替代原来的寻找对手）
- 加入房间
- 准备/取消准备
- 双方准备后倒计时15秒开始游戏
- 游戏大厅：查看所有已创建的房间
- 房间超时自动关闭（最长10分钟）

房间状态流转：
CREATED (等待加入) -> JOINED (已加入，等待准备) -> COUNTDOWN (15秒倒计时) 
-> GAME_STARTED (游戏中) -> FINISHED (已完成) / CLOSED (超时关闭)
"""
import asyncio
import uuid
from datetime import datetime
from typing import Dict, Optional, List

from rps_backend.models import GameState, WSMessage
from rps_backend.repository import create_game_record, update_game_record, get_system_config_value
from rps_backend.utils.helpers import now_timestamp, calculate_deadline, deadline_to_iso
from rps_backend.utils.redis_client import redis_client
from rps_backend.websocket import ws_manager

ROOM_STATUS = {
    "CREATED": "created",
    "JOINED": "joined",
    "COUNTDOWN": "countdown",
    "GAME_STARTED": "game_started",
    "FINISHED": "finished",
    "CLOSED": "closed",
}

# 未准备超时时间（秒）：加入房间后 60 秒未准备则自动踢出
UNREADY_TIMEOUT = 60

# 房间游戏总超时时间（秒）：游戏开始后 10 分钟未结束则自动关闭房间
ROOM_GAME_TIMEOUT = 600

# 房间默认最大生命周期（秒）：1 小时（可通过配置 room_max_lifetime 覆盖）
DEFAULT_ROOM_MAX_LIFETIME = 3600


def _get_room_max_lifetime() -> int:
    """获取房间最大生命周期（秒），优先使用系统配置，失败则回退默认值"""
    try:
        val = get_system_config_value("room_max_lifetime")
        if val:
            return max(60, int(val))
    except Exception:
        pass
    return DEFAULT_ROOM_MAX_LIFETIME


# 房间管理器
class RoomManager:
    """房间管理器：负责房间的创建、加入、准备和游戏开始"""

    def __init__(self):
        self._rooms: Dict[str, dict] = {}
        # 玩家地址 -> 房间ID 的映射（用于检查玩家是否已在其他房间）
        self._player_rooms: Dict[str, str] = {}
        # 玩家未准备超时任务：player_address -> asyncio.Task
        self._unready_timers: Dict[str, asyncio.Task] = {}
        # 房间游戏超时任务：room_id -> asyncio.Task
        self._game_timers: Dict[str, asyncio.Task] = {}
        # 房间生命周期超时任务（总最大存在时间）
        self._lifetime_timers: Dict[str, asyncio.Task] = {}

    # 创建房间
    def create_room(self, creator_address: str, token: str, bet_amount: float) -> dict:
        """
        创建房间

        Args:
            creator_address: 创建者地址
            token: 代币类型
            bet_amount: 下注金额

        Returns:
            {"success": True, "room_id": "...", "message": "..."}
        """
        # 检查是否已在其他房间中
        creator_lower = creator_address.lower()
        if creator_lower in self._player_rooms:
            existing_room_id = self._player_rooms[creator_lower]
            return {
                "success": False,
                "message": f"你已在房间 #{existing_room_id} 中，同一时间只能加入一个房间",
                "existing_room_id": existing_room_id,
            }

        room_id = str(uuid.uuid4())[:8]

        room = {
            "room_id": room_id,
            "creator": creator_address,
            "player2": None,
            "token": token,
            "bet_amount": bet_amount,
            "status": ROOM_STATUS["CREATED"],
            "creator_ready": False,
            "player2_ready": False,
            "created_at": now_timestamp(),
            "countdown_start": None,
            "game_id": None,
            # 资金状态标记
            # fund_stage:
            #   local_frozen:  准备阶段，资金仅本地冻结（未上链）
            #   chain_frozen:  游戏启动，资金已通过 createMatch/joinMatch 上链冻结
            #   revealing:     揭晓中，至少 1 人已揭晓
            #   settled:       已结算
            "fund_stage": "local_frozen",
        }

        self._rooms[room_id] = room
        self._player_rooms[creator_lower] = room_id
        redis_client.cache_room_state(room_id, room)

        # 启动房间生命周期总超时计时器
        self._start_lifetime_timer(room_id)

        # 广播房间列表变更，让游戏大厅实时刷新
        self._broadcast_room_list_changed("room_created", room_id)

        return {
            "success": True,
            "room_id": room_id,
            "message": "房间创建成功",
        }

    # 加入房间
    def join_room(self, room_id: str, player_address: str) -> dict:
        """
        加入房间

        Args:
            room_id: 房间ID
            player_address: 加入者地址

        Returns:
            {"success": True, "room": {...}} 或 {"success": False, "message": "..."}
        """
        room = self._rooms.get(room_id)
        if not room:
            return {"success": False, "message": "房间不存在"}

        if room["status"] != ROOM_STATUS["CREATED"]:
            return {"success": False, "message": "房间已满或已开始"}

        player_lower = player_address.lower()

        # 检查是否已在其他房间中
        if player_lower in self._player_rooms:
            existing_room_id = self._player_rooms[player_lower]
            if existing_room_id != room_id:
                return {
                    "success": False,
                    "message": f"你已在房间 #{existing_room_id} 中，同一时间只能加入一个房间",
                    "existing_room_id": existing_room_id,
                }

        if room["creator"].lower() == player_lower:
            return {"success": False, "message": "不能加入自己创建的房间"}

        room["player2"] = player_address
        room["status"] = ROOM_STATUS["JOINED"]

        self._rooms[room_id] = room
        self._player_rooms[player_lower] = room_id
        redis_client.cache_room_state(room_id, room)

        # 启动 player2 的未准备超时计时器
        self._start_unready_timer(player_address, room_id)

        asyncio.create_task(ws_manager.send_to_player(room["creator"], WSMessage(
            type="room_joined",
            data={
                "room_id": room_id,
                "player2": player_address,
            }
        )))

        # 广播房间列表变更（房间被占用，从大厅消失）
        self._broadcast_room_list_changed("room_joined", room_id)

        return {
            "success": True,
            "room": room,
        }

    # 准备/取消准备
    def toggle_ready(self, room_id: str, player_address: str) -> dict:
        """
        准备/取消准备

        Args:
            room_id: 房间ID
            player_address: 玩家地址

        Returns:
            {"success": True, "room": {...}} 或 {"success": False, "message": "..."}
        """
        room = self._rooms.get(room_id)
        if not room:
            return {"success": False, "message": "房间不存在"}

        is_creator = room["creator"].lower() == player_address.lower()
        is_player2 = room["player2"] and room["player2"].lower() == player_address.lower()

        if not (is_creator or is_player2):
            return {"success": False, "message": "你不是这个房间的玩家"}

        if room["status"] not in [ROOM_STATUS["CREATED"], ROOM_STATUS["JOINED"], ROOM_STATUS["COUNTDOWN"]]:
            return {"success": False, "message": "当前阶段不能准备"}

        # 记录准备前的状态，用于判断是否需要回退 COUNTDOWN
        was_countdown = room["status"] == ROOM_STATUS["COUNTDOWN"]

        if is_creator:
            room["creator_ready"] = not room["creator_ready"]
            # 准备/取消准备时更新未准备超时计时器
            if room["creator_ready"]:
                self._stop_unready_timer(player_address)
            else:
                self._start_unready_timer(player_address, room_id)
        else:
            room["player2_ready"] = not room["player2_ready"]
            if room["player2_ready"]:
                self._stop_unready_timer(player_address)
            else:
                self._start_unready_timer(player_address, room_id)

        # 关键修复：如果在 COUNTDOWN 阶段任一方取消准备，状态回退到 JOINED
        # _start_countdown 协程会检测到状态变化自动退出（并发送 countdown_cancelled）
        if was_countdown and not (room["creator_ready"] and room["player2_ready"]):
            room["status"] = ROOM_STATUS["JOINED"]
            room["countdown_start"] = None
            # 通知双方倒计时已取消
            cancel_data = {
                "room_id": room_id,
                "reason": "player_unready",
                "player": player_address,
                "message": "对手取消了准备，倒计时已停止",
                "timestamp": now_timestamp(),
            }
            creator = room["creator"]
            player2 = room.get("player2")
            if creator:
                asyncio.create_task(ws_manager.send_to_player(creator, WSMessage(
                    type="countdown_cancelled",
                    data=cancel_data
                )))
            if player2:
                asyncio.create_task(ws_manager.send_to_player(player2, WSMessage(
                    type="countdown_cancelled",
                    data=cancel_data
                )))

        self._rooms[room_id] = room
        redis_client.cache_room_state(room_id, room)

        opponent = room["player2"] if is_creator else room["creator"]
        asyncio.create_task(ws_manager.send_to_player(opponent, WSMessage(
            type="room_ready_change",
            data={
                "room_id": room_id,
                "player": player_address,
                "ready": room["creator_ready"] if is_creator else room["player2_ready"],
            }
        )))

        # 准备状态变化也通知大厅（房间卡片上的准备标记需要同步）
        self._broadcast_room_list_changed("ready_changed", room_id)

        if room["creator_ready"] and room["player2_ready"]:
            # 双方都准备了，停止双方的未准备超时
            self._stop_unready_timer(room["creator"])
            self._stop_unready_timer(room["player2"])
            room["status"] = ROOM_STATUS["COUNTDOWN"]
            room["countdown_start"] = now_timestamp()
            self._rooms[room_id] = room
            redis_client.cache_room_state(room_id, room)

            # 倒计时开始也通知大厅（房间卡片状态变为 countdown）
            self._broadcast_room_list_changed("countdown_start", room_id)

            asyncio.create_task(self._start_countdown(room_id))

        return {
            "success": True,
            "room": room,
        }

    # 启动玩家未准备超时计时器
    def _start_unready_timer(self, player_address: str, room_id: str):
        """
        启动玩家未准备超时计时器

        60秒后如果玩家仍未准备，则自动踢出房间
        """
        player_lower = player_address.lower()

        # 先停止已有的计时器
        self._stop_unready_timer(player_address)

        async def timeout_task():
            await asyncio.sleep(UNREADY_TIMEOUT)
            # 检查玩家是否还在房间中且未准备
            room = self._rooms.get(room_id)
            if not room:
                return
            if player_lower not in self._player_rooms:
                return
            if self._player_rooms[player_lower] != room_id:
                return

            is_creator = room["creator"].lower() == player_lower
            is_player2 = room["player2"] and room["player2"].lower() == player_lower

            if not (is_creator or is_player2):
                return

            player_ready = room["creator_ready"] if is_creator else room["player2_ready"]
            if player_ready:
                return  # 已经准备了，不处理

            # 自动踢出房间
            self.leave_room(room_id, player_address)

            # 通知被踢出的玩家
            asyncio.create_task(ws_manager.send_to_player(player_address, WSMessage(
                type="kicked_for_unready",
                data={
                    "room_id": room_id,
                    "reason": "unready_timeout",
                    "message": f"未在 {UNREADY_TIMEOUT} 秒内准备，已自动离开房间",
                }
            )))

        task = asyncio.create_task(timeout_task())
        self._unready_timers[player_lower] = task

    # 停止玩家未准备超时计时器
    def _stop_unready_timer(self, player_address: str):
        """停止玩家的未准备超时计时器"""
        if not player_address:
            return
        player_lower = player_address.lower()
        task = self._unready_timers.pop(player_lower, None)
        if task:
            task.cancel()

    # 启动房间游戏总超时计时器
    def _start_game_timer(self, room_id: str):
        """启动房间游戏总超时计时器（10分钟）"""
        self._stop_game_timer(room_id)

        async def timeout_task():
            await asyncio.sleep(ROOM_GAME_TIMEOUT)
            # 检查房间是否还在游戏中
            room = self._rooms.get(room_id)
            if not room:
                return
            if room["status"] not in [ROOM_STATUS["GAME_STARTED"]]:
                return
            # 游戏超时，自动关闭房间
            self._close_room(room_id, "game_timeout", f"游戏超时（{ROOM_GAME_TIMEOUT // 60}分钟），房间已关闭")

        task = asyncio.create_task(timeout_task())
        self._game_timers[room_id] = task

    # 停止房间游戏超时计时器
    def _stop_game_timer(self, room_id: str):
        """停止房间游戏超时计时器"""
        if not room_id:
            return
        task = self._game_timers.pop(room_id, None)
        if task:
            task.cancel()

    # 启动房间生命周期总超时计时器
    def _start_lifetime_timer(self, room_id: str):
        """
        启动房间生命周期总超时计时器（根据配置 room_max_lifetime 决定）

        超时处理逻辑：
        - 房间处于 CREATED/JOINED/COUNTDOWN：立即关闭
        - 房间处于 GAME_STARTED 且未到揭晓阶段（commit_phase 或 无 commit/reveal 数据）：立即关闭
        - 房间处于 GAME_STARTED 且已进入揭晓/结算阶段（至少 1 人揭晓 或 已写入结果）：不关闭，继续完成
        """
        self._stop_lifetime_timer(room_id)

        lifetime = _get_room_max_lifetime()

        async def timeout_task():
            await asyncio.sleep(lifetime)
            room = self._rooms.get(room_id)
            if not room:
                return

            # 如果已 FINISHED / CLOSED，不处理
            if room["status"] in [ROOM_STATUS["FINISHED"], ROOM_STATUS["CLOSED"]]:
                return

            # 准备/倒计时阶段：直接关闭
            if room["status"] in [ROOM_STATUS["CREATED"], ROOM_STATUS["JOINED"], ROOM_STATUS["COUNTDOWN"]]:
                self._close_room(
                    room_id,
                    "room_lifetime_expired",
                    f"房间已超过最长存在时间（{lifetime // 60}分钟），已关闭",
                )
                return

            # GAME_STARTED 阶段：判断是否进入了揭晓/结算
            if room["status"] == ROOM_STATUS["GAME_STARTED"]:
                game_id = room.get("game_id")
                force_close = True
                if game_id:
                    try:
                        game_state = redis_client.get_cached_game_state(game_id)
                        if game_state:
                            state = game_state.get("state")
                            commit1 = game_state.get("commit1")
                            commit2 = game_state.get("commit2")
                            reveal1 = game_state.get("reveal1")
                            reveal2 = game_state.get("reveal2")
                            # 已揭晓至少 1 人，或 state 已越过 reveal_phase → 等待结算完成
                            if (
                                reveal1 is not None
                                or reveal2 is not None
                                or state in ["reveal_phase", "finished", "settled"]
                            ):
                                force_close = False
                    except Exception:
                        pass
                if force_close:
                    self._close_room(
                        room_id,
                        "room_lifetime_expired",
                        f"房间存在超时（{lifetime // 60}分钟，仍未进入揭晓阶段），已关闭",
                    )
                # else: 已在揭晓/结算中，不强制关闭，等待其自行结束

        task = asyncio.create_task(timeout_task())
        self._lifetime_timers[room_id] = task

    # 停止房间生命周期总超时计时器
    def _stop_lifetime_timer(self, room_id: str):
        """停止房间生命周期总超时计时器"""
        if not room_id:
            return
        task = self._lifetime_timers.pop(room_id, None)
        if task:
            task.cancel()

    # 关闭房间
    def _close_room(self, room_id: str, reason: str, message: str):
        """
        关闭房间（超时、异常等情况）

        资金状态处理：
        - local_frozen 阶段关闭：本地冻结已解除（fund_stage 标记为 cancelled）
        - chain_frozen 阶段关闭：需要玩家自行在链上申请退款（超时自动退款机制）
        - revealing / settled 阶段：通常不会被强制关闭（在生命周期超时判断中已跳过）

        Args:
            room_id: 房间ID
            reason: 关闭原因
            message: 显示给用户的消息
        """
        room = self._rooms.get(room_id)
        if not room:
            return

        room["status"] = ROOM_STATUS["CLOSED"]
        room["close_reason"] = reason
        room["closed_at"] = now_timestamp()
        # 同步资金状态：本地冻结阶段关闭 → 标记为 cancelled（本地冻结解除）
        # 链上冻结阶段关闭 → 保留 chain_frozen 标记，提醒用户在链上处理超时退款
        current_fund = room.get("fund_stage", "local_frozen")
        if current_fund in ("local_frozen",):
            room["fund_stage"] = "cancelled"
        self._rooms[room_id] = room
        redis_client.cache_room_state(room_id, room)

        # 停止所有计时器
        self._stop_game_timer(room_id)
        self._stop_lifetime_timer(room_id)

        # 清理玩家房间映射
        creator_lower = room["creator"].lower()
        if self._player_rooms.get(creator_lower) == room_id:
            self._player_rooms.pop(creator_lower, None)
        player2 = room.get("player2")
        if player2:
            player2_lower = player2.lower()
            if self._player_rooms.get(player2_lower) == room_id:
                self._player_rooms.pop(player2_lower, None)

        # 通知双方
        player1 = room["creator"]
        player2_addr = room.get("player2")

        if player1:
            asyncio.create_task(ws_manager.send_to_player(player1, WSMessage(
                type="room_closed",
                data={
                    "room_id": room_id,
                    "reason": reason,
                    "message": message,
                }
            )))
        if player2_addr:
            asyncio.create_task(ws_manager.send_to_player(player2_addr, WSMessage(
                type="room_closed",
                data={
                    "room_id": room_id,
                    "reason": reason,
                    "message": message,
                }
            )))

        # 广播房间列表变更
        self._broadcast_room_list_changed("room_closed", room_id)

    # 开始倒计时
    async def _start_countdown(self, room_id: str):
        """
        15秒倒计时后开始游戏

        倒计时同步机制：
        - 开始时发送 countdown_start 事件（包含结束时间戳），前端基于此本地计算剩余时间
        - 每3秒发送一次 countdown_tick 作为同步校准
        - 最后5秒每秒发送一次，确保危险阶段同步
        - 如果任一方取消准备，倒计时取消（toggle_ready 已发送 countdown_cancelled）
        - 倒计时结束后创建对局，进入提交阶段
        """
        room = self._rooms.get(room_id)
        if not room:
            return

        # 协程启动时再次校验状态（防止在 create_task 调度间隙状态已被回退）
        if room["status"] != ROOM_STATUS["COUNTDOWN"]:
            return

        countdown_total = 15
        countdown_end = room["countdown_start"] + countdown_total

        player1 = room["creator"]
        player2 = room["player2"]

        # 发送倒计时开始事件（包含结束时间戳，用于前端精确同步）
        start_data = {
            "room_id": room_id,
            "end_time": countdown_end,
            "total": countdown_total,
            "server_time": now_timestamp(),
        }
        if player1:
            asyncio.create_task(ws_manager.send_to_player(player1, WSMessage(
                type="countdown_start",
                data=start_data
            )))
        if player2:
            asyncio.create_task(ws_manager.send_to_player(player2, WSMessage(
                type="countdown_start",
                data=start_data
            )))

        # 倒计时循环：每3秒同步一次，最后5秒每秒同步一次
        while True:
            remaining = max(0, int(countdown_end - now_timestamp()))
            if remaining <= 0:
                break

            # 计算下一次同步的间隔
            if remaining > 5:
                sleep_time = min(3, remaining - 5)
            else:
                sleep_time = 1

            await asyncio.sleep(sleep_time)

            room = self._rooms.get(room_id)
            if not room:
                return

            if room["status"] != ROOM_STATUS["COUNTDOWN"]:
                return

            remaining = max(0, int(countdown_end - now_timestamp()))
            is_danger = remaining <= 5

            tick_data = {
                "room_id": room_id,
                "remaining": remaining,
                "total": countdown_total,
                "is_danger": is_danger,
                "end_time": countdown_end,
                "server_time": now_timestamp(),
            }

            if player1:
                asyncio.create_task(ws_manager.send_to_player(player1, WSMessage(
                    type="countdown_tick",
                    data=tick_data
                )))
            if player2:
                asyncio.create_task(ws_manager.send_to_player(player2, WSMessage(
                    type="countdown_tick",
                    data=tick_data
                )))

        # 倒计时结束，确保再等待一下到精确的结束时间
        final_remaining = countdown_end - now_timestamp()
        if final_remaining > 0:
            await asyncio.sleep(final_remaining)

        await self._start_game(room_id)

    # 开始游戏
    async def _start_game(self, room_id: str):
        """
        开始游戏：创建本地对局记录，通知双方进入链上对局创建流程

        流程：
        1. 创建对局记录（player1=creator, player2=player2）
        2. 设置提交截止时间
        3. 更新房间状态为 GAME_STARTED
        4. 通知双方 game_started（包含 token/bet_amount/角色信息）
        5. 创建者收到事件后调用合约 createMatch 创建链上对局
        6. 创建者上报 chain_game_id，后端通知 player2
        7. player2 调用合约 joinMatch 加入链上对局
        8. 双方使用 chain_game_id 进入提交/揭晓阶段
        """
        room = self._rooms.get(room_id)
        if not room:
            return

        game_data = {
            "player1": room["creator"],
            "player2": room["player2"],
            "token": room["token"],
            "bet_amount": room["bet_amount"],
        }
        game_id = create_game_record(game_data)

        from rps_backend.config import COMMIT_TIMEOUT
        commit_deadline_ts = calculate_deadline(COMMIT_TIMEOUT)
        commit_deadline_iso = deadline_to_iso(commit_deadline_ts)

        update_game_record(game_id, {
            "state": GameState.COMMIT_PHASE.value,
            "commit_deadline": commit_deadline_iso,
        })

        redis_client.cache_game_state(game_id, {
            "player1": room["creator"],
            "player2": room["player2"],
            "token": room["token"],
            "bet_amount": room["bet_amount"],
            "state": GameState.COMMIT_PHASE.value,
            "commit_deadline": commit_deadline_ts,
            "commit1": None,
            "commit2": None,
        })

        room["status"] = ROOM_STATUS["GAME_STARTED"]
        room["game_id"] = game_id
        room["chain_game_id"] = None
        room["game_started_at"] = now_timestamp()
        self._rooms[room_id] = room
        redis_client.cache_room_state(room_id, room)

        # 启动游戏总超时计时器（10分钟）
        self._start_game_timer(room_id)

        player1 = room["creator"]
        player2 = room["player2"]

        # 通知创建者：需要调用 createMatch 创建链上对局
        if player1:
            await ws_manager.send_to_player(player1, WSMessage(
                type="game_started",
                data={
                    "room_id": room_id,
                    "game_id": game_id,
                    "is_creator": True,
                    "opponent": player2,
                    "token": room["token"],
                    "bet_amount": room["bet_amount"],
                    "commit_deadline": commit_deadline_ts,
                },
            ))

        # 通知 player2：等待创建者创建链上对局
        if player2:
            await ws_manager.send_to_player(player2, WSMessage(
                type="game_started",
                data={
                    "room_id": room_id,
                    "game_id": game_id,
                    "is_creator": False,
                    "opponent": player1,
                    "token": room["token"],
                    "bet_amount": room["bet_amount"],
                    "commit_deadline": commit_deadline_ts,
                },
            ))

        # 广播房间列表变更（房间状态变为 game_started，大厅卡片需要更新）
        self._broadcast_room_list_changed("game_started", room_id)

    # 上报链上对局ID
    async def report_chain_game(self, room_id: str, creator_address: str, chain_game_id: int) -> dict:
        """
        创建者上报链上对局 ID，后端通知 player2 加入链上对局

        Args:
            room_id: 房间ID
            creator_address: 创建者地址（校验权限）
            chain_game_id: 链上对局 ID

        Returns:
            {"success": True} 或 {"success": False, "message": "..."}
        """
        room = self._rooms.get(room_id)
        if not room:
            return {"success": False, "message": "房间不存在"}

        # 校验调用者是创建者
        if room["creator"].lower() != creator_address.lower():
            return {"success": False, "message": "仅创建者可上报链上对局 ID"}

        room["chain_game_id"] = chain_game_id
        # 双方资金已通过 createMatch + joinMatch 上链锁定
        room["fund_stage"] = "chain_frozen"
        self._rooms[room_id] = room
        redis_client.cache_room_state(room_id, room)

        # 同步到本地对局记录
        local_game_id = room.get("game_id")
        if local_game_id:
            update_game_record(local_game_id, {"chain_game_id": chain_game_id})

        # 通知 player2 链上对局已创建，可以加入
        player2 = room["player2"]
        if player2:
            await ws_manager.send_to_player(player2, WSMessage(
                type="chain_game_created",
                data={
                    "room_id": room_id,
                    "chain_game_id": chain_game_id,
                    "creator": room["creator"],
                    "token": room["token"],
                    "bet_amount": room["bet_amount"],
                },
            ))

        # 同时通知创建者：上报已成功接收，后端已通知 player2 加入
        creator = room["creator"]
        if creator:
            await ws_manager.send_to_player(creator, WSMessage(
                type="chain_game_reported",
                data={
                    "room_id": room_id,
                    "chain_game_id": chain_game_id,
                    "message": "链上对局 ID 已上报，等待对手加入",
                    "timestamp": now_timestamp(),
                },
            ))

        return {"success": True, "chain_game_id": chain_game_id}

    # 获取房间信息
    def get_room(self, room_id: str) -> Optional[dict]:
        """获取房间信息"""
        return self._rooms.get(room_id)

    # 获取游戏大厅房间列表
    def get_room_list(self) -> List[dict]:
        """
        获取游戏大厅的房间列表

        返回所有活跃房间（准备中、倒计时中、游戏中），供大厅展示完整状态。
        无人在线的房间由 handle_player_disconnect 延迟 10 秒后自动关闭，
        关闭后状态变为 CLOSED 自然从列表中消失，无需在此额外过滤。
        """
        now = now_timestamp()
        active_rooms = []
        lifetime = _get_room_max_lifetime()

        # 大厅展示的状态：准备中(created/joined)、倒计时中(countdown)、游戏中(game_started)
        visible_statuses = {
            ROOM_STATUS["CREATED"],
            ROOM_STATUS["JOINED"],
            ROOM_STATUS["COUNTDOWN"],
            ROOM_STATUS["GAME_STARTED"],
        }

        for room_id, room in self._rooms.items():
            if room["status"] not in visible_statuses:
                continue
            if now - room["created_at"] >= lifetime:
                continue

            active_rooms.append({
                "room_id": room_id,
                "creator": room["creator"],
                "player2": room["player2"],
                "token": room["token"],
                "bet_amount": room["bet_amount"],
                "status": room["status"],
                "creator_ready": room["creator_ready"],
                "player2_ready": room["player2_ready"],
                "created_at": room["created_at"],
            })

        return sorted(active_rooms, key=lambda r: r["created_at"], reverse=True)

    # 玩家退出房间
    def leave_room(self, room_id: str, player_address: str) -> dict:
        """
        玩家退出房间

        规则：
        - 房间不存在 → 返回错误
        - 非房间玩家 → 返回错误
        - 创建者退出：
            * 无 player2 → 直接解散房间（从内存和缓存移除）
            * 有 player2 → 通知 player2 房间已解散，移除房间
        - player2 退出：
            * 重置房间为 CREATED 状态，player2 置空
            * 通知创建者 player2 已离开
            * 双方准备状态重置
        - 游戏已开始（GAME_STARTED）→ 不允许通过此接口退出，需走索赔流程

        Args:
            room_id: 房间ID
            player_address: 退出者地址

        Returns:
            {"success": True, "action": "dissolved" | "left", "message": "..."}
        """
        room = self._rooms.get(room_id)
        if not room:
            return {"success": False, "message": "房间不存在"}

        is_creator = room["creator"].lower() == player_address.lower()
        is_player2 = room["player2"] and room["player2"].lower() == player_address.lower()

        if not (is_creator or is_player2):
            return {"success": False, "message": "你不在此房间中"}

        # 退出规则（与用户期望一致：除"游戏中（资金已上链）"外，所有阶段均可退出）：
        # - GAME_STARTED 且资金已上链（chain_frozen/revealing）→ 不允许退出（对局进行中）
        # - GAME_STARTED 但资金仍为 local_frozen（链上对局创建失败/取消）→ 允许退出
        # - GAME_STARTED 且 fund_stage=settled（已结算）→ 允许退出
        # - COUNTDOWN/JOINED/CREATED/FINISHED → 均允许退出
        #   * COUNTDOWN 退出时自动取消倒计时，重置准备状态
        if room["status"] == ROOM_STATUS["GAME_STARTED"]:
            fund_stage = room.get("fund_stage", "local_frozen")
            # 资金未上链（createMatch 失败/取消）→ 允许安全退出
            if fund_stage == "local_frozen":
                self._close_room(room_id, "creator_chain_game_failed", "链上对局未创建，房间已关闭")
                return {"success": True, "action": "dissolved", "message": "链上对局未创建成功，房间已关闭"}
            # 已结算 → 允许退出（关闭房间）
            if fund_stage == "settled":
                self._close_room(room_id, "game_finished", "对局已结束，房间已关闭")
                return {"success": True, "action": "dissolved", "message": "对局已结束，房间已关闭"}
            return {"success": False, "message": "游戏进行中（资金已上链），无法退出房间"}

        # COUNTDOWN 阶段退出：取消倒计时，重置准备状态
        if room["status"] == ROOM_STATUS["COUNTDOWN"]:
            room["status"] = ROOM_STATUS["JOINED"]
            room["countdown_start"] = None
            room["creator_ready"] = False
            room["player2_ready"] = False
            self._stop_game_timer(room_id)
            # 通知对方倒计时已取消
            opponent_addr = room["player2"] if is_creator else room["creator"]
            if opponent_addr:
                asyncio.create_task(ws_manager.send_to_player(opponent_addr, WSMessage(
                    type="countdown_cancelled",
                    data={"room_id": room_id, "message": "对手已退出房间，倒计时已取消"}
                )))

        if is_creator:
            # 创建者退出 → 解散房间
            player2 = room.get("player2")
            self._rooms.pop(room_id, None)
            # 清理所有计时器
            self._stop_game_timer(room_id)
            self._stop_lifetime_timer(room_id)
            redis_client.delete_cached_room_state(room_id)

            # 清理玩家房间映射
            creator_lower = player_address.lower()
            self._player_rooms.pop(creator_lower, None)
            self._stop_unready_timer(player_address)
            if player2:
                player2_lower = player2.lower()
                if self._player_rooms.get(player2_lower) == room_id:
                    self._player_rooms.pop(player2_lower, None)
                self._stop_unready_timer(player2)

            # 通知 player2（如有）房间已解散
            if player2:
                asyncio.create_task(ws_manager.send_to_player(player2, WSMessage(
                    type="room_dissolved",
                    data={
                        "room_id": room_id,
                        "reason": "creator_left",
                        "message": "创建者已离开，房间已解散",
                    }
                )))

            # 广播房间列表变更（房间已从大厅消失）
            self._broadcast_room_list_changed("room_dissolved", room_id)

            return {"success": True, "action": "dissolved", "message": "房间已解散"}

        # player2 退出 → 重置房间为 CREATED 状态，保留在游戏大厅
        room["player2"] = None
        room["status"] = ROOM_STATUS["CREATED"]
        room["creator_ready"] = False
        room["player2_ready"] = False
        room["countdown_start"] = None
        self._rooms[room_id] = room
        redis_client.cache_room_state(room_id, room)

        # 清理 player2 的玩家房间映射
        player_lower = player_address.lower()
        if self._player_rooms.get(player_lower) == room_id:
            self._player_rooms.pop(player_lower, None)
        self._stop_unready_timer(player_address)

        # 创建者的准备状态也重置，需要重新准备
        creator = room.get("creator")
        if creator:
            room["creator_ready"] = False
            # 重启创建者的未准备超时（因为需要重新准备）
            self._start_unready_timer(creator, room_id)
            asyncio.create_task(ws_manager.send_to_player(creator, WSMessage(
                type="player_left",
                data={
                    "room_id": room_id,
                    "player2": player_address,
                    "message": "对手已离开房间",
                }
            )))

        # 广播房间列表变更（房间重新开放，回到大厅）
        self._broadcast_room_list_changed("room_reopened", room_id)

        return {"success": True, "action": "left", "message": "已离开房间"}

    # 玩家 WebSocket 断开后的延迟房间清理
    async def handle_player_disconnect(self, player_address: str):
        """
        玩家 WebSocket 断开后，延迟检查房间是否需要清理。

        策略：
        - 延迟 10 秒后检查（给页面刷新/短暂断网留出重连窗口）
        - 仅处理 CREATED/JOINED/COUNTDOWN 状态（无链上资金的安全阶段）
        - 若房间内所有玩家均不在线 → 关闭房间并广播
        - 若仅 player2 断开且创建者仍在线 → 重置房间为 CREATED
        """
        addr_lower = player_address.lower()
        room_id = self._player_rooms.get(addr_lower)
        if not room_id:
            return

        room = self._rooms.get(room_id)
        if not room:
            return

        # 仅处理未上链的安全阶段
        if room["status"] not in [
            ROOM_STATUS["CREATED"],
            ROOM_STATUS["JOINED"],
            ROOM_STATUS["COUNTDOWN"],
        ]:
            return

        # 延迟 10 秒检查，给页面刷新重连留出窗口
        await asyncio.sleep(10)

        # 重新获取房间（可能在延迟期间已被关闭或移除）
        room = self._rooms.get(room_id)
        if not room:
            return
        if room["status"] in [ROOM_STATUS["CLOSED"], ROOM_STATUS["FINISHED"]]:
            return
        if room["status"] == ROOM_STATUS["GAME_STARTED"]:
            # 延迟期间游戏已开始，不再清理
            return

        creator = room.get("creator")
        player2 = room.get("player2")
        creator_online = bool(creator) and creator.lower() in ws_manager.active_connections
        player2_online = bool(player2) and player2.lower() in ws_manager.active_connections

        if not creator_online and not player2_online:
            # 所有人都不在线 → 关闭房间
            self._close_room(room_id, "all_players_disconnected", "所有玩家已离线，房间已关闭")
            self._broadcast_room_list_changed("room_closed", room_id)
            print(f"[Room] 房间 {room_id} 因所有玩家离线已关闭")
            return

        # 若创建者在线但 player2 断开且房间在 JOINED/COUNTDOWN → 重置为 CREATED
        if creator_online and not player2_online and player2:
            if room["status"] in [ROOM_STATUS["JOINED"], ROOM_STATUS["COUNTDOWN"]]:
                room["player2"] = None
                room["status"] = ROOM_STATUS["CREATED"]
                room["creator_ready"] = False
                room["player2_ready"] = False
                room["countdown_start"] = None
                self._rooms[room_id] = room
                redis_client.cache_room_state(room_id, room)
                self._stop_game_timer(room_id)

                # 清理 player2 的映射
                p2_lower = player2.lower()
                if self._player_rooms.get(p2_lower) == room_id:
                    self._player_rooms.pop(p2_lower, None)

                # 通知创建者
                asyncio.create_task(ws_manager.send_to_player(creator, WSMessage(
                    type="player_left",
                    data={"room_id": room_id, "message": "对手已离线，房间回到等待状态"}
                )))
                self._broadcast_room_list_changed("room_reopened", room_id)
                print(f"[Room] 房间 {room_id} 的 player2 离线，重置为 CREATED")

    def reset_room_for_rematch(self, room_id: str, player_address: str) -> dict:
        """
        结算后重置房间以开启下一局（再来一局）。

        规则：
        - 仅 GAME_STARTED 或 FINISHED 状态（对局已结束）可调用
        - 仅房间内玩家可操作
        - 保留玩家不变，清除 game_id/准备状态/倒计时，回到 JOINED（有两人）或 CREATED（仅创建者）
        """
        room = self._rooms.get(room_id)
        if not room:
            return {"success": False, "message": "房间不存在"}

        is_creator = room["creator"].lower() == player_address.lower()
        is_player2 = bool(room["player2"]) and room["player2"].lower() == player_address.lower()
        if not (is_creator or is_player2):
            return {"success": False, "message": "你不是该房间的玩家"}

        if room["status"] not in [ROOM_STATUS["GAME_STARTED"], ROOM_STATUS["FINISHED"],
                                  ROOM_STATUS["COUNTDOWN"], ROOM_STATUS["JOINED"],
                                  ROOM_STATUS["CREATED"]]:
            return {"success": False, "message": "当前状态无法重置房间"}

        # 清理计时器
        self._stop_game_timer(room_id)
        self._stop_lifetime_timer(room_id)
        # 双方重新准备倒计时
        if room.get("creator"):
            self._stop_unready_timer(room["creator"])
            self._start_unready_timer(room["creator"], room_id)
        if room.get("player2"):
            self._stop_unready_timer(room["player2"])
            self._start_unready_timer(room["player2"], room_id)

        room["game_id"] = None
        room["commit_deadline"] = None
        room["reveal_deadline"] = None
        room["creator_ready"] = False
        room["player2_ready"] = False
        room["countdown_start"] = None
        # 回到对应状态
        if room.get("player2"):
            room["status"] = ROOM_STATUS["JOINED"]
        else:
            room["status"] = ROOM_STATUS["CREATED"]

        self._rooms[room_id] = room
        redis_client.cache_room_state(room_id, room)

        # 通知房间内双方：房间已重置，可重新准备
        asyncio.create_task(ws_manager.send_to_room(room_id, WSMessage(
            type="room_reset_for_rematch",
            data={
                "room_id": room_id,
                "room": room,
                "message": "已重置房间，可重新准备开始下一局",
            }
        )))

        self._broadcast_room_list_changed("room_reopened", room_id)
        return {"success": True, "room": room, "message": "已重置房间"}

    # 广播房间列表变更事件
    def _broadcast_room_list_changed(self, event: str, room_id: str):
        """
        广播房间列表变更事件给所有已连接客户端

        游戏大厅的客户端收到此事件后，应主动拉取一次房间列表，
        以获取最新状态（新增/消失/状态变化的房间）。

        Args:
            event: 变更事件类型（room_created/room_joined/room_dissolved/room_reopened）
            room_id: 相关房间ID
        """
        asyncio.create_task(ws_manager.broadcast(WSMessage(
            type="room_list_changed",
            data={
                "event": event,
                "room_id": room_id,
                "timestamp": now_timestamp(),
            }
        )))

    # 查询玩家当前所在房间
    def get_player_room(self, player_address: str) -> Optional[dict]:
        """
        查询玩家当前所在的房间

        Args:
            player_address: 玩家地址

        Returns:
            房间信息 dict，如果不在任何房间则返回 None
        """
        player_lower = player_address.lower()
        room_id = self._player_rooms.get(player_lower)
        if not room_id:
            return None
        room = self._rooms.get(room_id)
        if not room:
            # 房间不存在了，清理映射
            self._player_rooms.pop(player_lower, None)
            return None
        return room

    # 移除房间
    def remove_room(self, room_id: str):
        """移除房间"""
        room = self._rooms.pop(room_id, None)
        if room:
            # 清理所有计时器
            self._stop_game_timer(room_id)
            self._stop_lifetime_timer(room_id)
            # 清理玩家房间映射
            creator = room.get("creator")
            player2 = room.get("player2")
            if creator:
                creator_lower = creator.lower()
                if self._player_rooms.get(creator_lower) == room_id:
                    self._player_rooms.pop(creator_lower, None)
                self._stop_unready_timer(creator)
            if player2:
                player2_lower = player2.lower()
                if self._player_rooms.get(player2_lower) == room_id:
                    self._player_rooms.pop(player2_lower, None)
                self._stop_unready_timer(player2)
        redis_client.delete_cached_room_state(room_id)
        # 广播房间列表变更
        self._broadcast_room_list_changed("room_removed", room_id)


# 房间管理器实例
room_manager = RoomManager()
