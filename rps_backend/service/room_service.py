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
import logging
from datetime import datetime
from typing import Dict, Optional, List

logger = logging.getLogger(__name__)

from rps_backend.config import BOT_AUTO_CHAIN_MATCH, ROOM_STATUS
from rps_backend.models import GameState, WSMessage
from rps_backend.repository import create_game_record, update_game_record, get_system_config_value
from rps_backend.utils.helpers import now_timestamp, calculate_deadline, deadline_to_iso
from rps_backend.utils.redis_client import redis_client
from rps_backend.websocket import ws_manager

# 未准备超时时间（秒）：加入房间后 60 秒未准备则自动踢出
UNREADY_TIMEOUT = 60

# 房间游戏总超时时间（秒）：游戏开始后 10 分钟未结束则自动关闭房间
ROOM_GAME_TIMEOUT = 600

# 空房间清理超时（秒）：创建后 5 分钟没玩家加入 = 僵尸房间，自动清理
EMPTY_ROOM_TIMEOUT = 300

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


def _compute_deadlines(room: dict) -> dict:
    """
    计算房间当前所有阶段的超时 deadline（unix 秒时间戳）。
    前端可以直接用这些值渲染倒计时 UI。
    """
    now = now_timestamp()
    status = room.get("status")
    created_at = room.get("created_at", now)
    has_player2 = bool(room.get("player2"))
    creator_ready = bool(room.get("creator_ready"))
    player2_ready = bool(room.get("player2_ready"))
    countdown_start = room.get("countdown_start")

    lifetime = _get_room_max_lifetime()
    deadlines = {
        "empty_room": None,            # CREATED 阶段：无玩家加入自动关闭
        "unready_player": None,        # JOINED 阶段：未准备方被踢出
        "countdown": None,             # COUNTDOWN 阶段：进入游戏
        "game_timeout": None,          # GAME_STARTED 阶段：游戏总超时
        "lifetime": created_at + lifetime,  # 房间绝对生命周期截止（创建时就定好）
        # 附带超时常量（前端用来显示提示）
        "constants": {
            "empty_room_timeout": EMPTY_ROOM_TIMEOUT,
            "unready_timeout": UNREADY_TIMEOUT,
            "countdown_duration": 15,
            "game_timeout": ROOM_GAME_TIMEOUT,
            "lifetime": lifetime,
        }
    }

    if status == ROOM_STATUS["CREATED"]:
        # 空房间倒计时：从创建起 EMPTY_ROOM_TIMEOUT 秒
        deadlines["empty_room"] = created_at + EMPTY_ROOM_TIMEOUT

    if status == ROOM_STATUS["JOINED"] and has_player2:
        # 等待准备：谁没准备谁有 UNREADY_TIMEOUT 秒倒计时
        # 用 room 里记录的 started_at 来算（toggle_ready 时会写）
        unready_since = room.get("_unready_since", created_at)
        deadlines["unready_player"] = unready_since + UNREADY_TIMEOUT

    if status == ROOM_STATUS["COUNTDOWN"] and countdown_start:
        # 双方都 ready 后 15 秒倒计时
        deadlines["countdown"] = countdown_start + 15

    if status == ROOM_STATUS["GAME_STARTED"]:
        # 游戏开始后 ROOM_GAME_TIMEOUT 秒
        game_started_at = room.get("game_started_at", now)
        deadlines["game_timeout"] = game_started_at + ROOM_GAME_TIMEOUT

    return deadlines


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
        # 空房间清理计时器：创建后 5 分钟没玩家加入则自动关闭
        self._empty_room_timers: Dict[str, asyncio.Task] = {}
        # 倒计时取消信号：room_id -> asyncio.Event
        self._countdown_cancel_events: Dict[str, asyncio.Event] = {}
        # 链上设置阶段超时：game_started 后 creator 必须在 CHAIN_SETUP_TIMEOUT 内上报 chain_game_id
        self._chain_setup_timers: Dict[str, asyncio.Task] = {}

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

        room_id = str(uuid.uuid4())[:12]

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
            "game_started_at": None,
            "game_id": None,
            # 内部字段（不下发前端，只用于超时计算）
            "_unready_since": now_timestamp(),  # 谁"不准备"的起始时间
            # 资金状态标记
            # fund_stage:
            #   local_frozen:  准备阶段，资金仅本地冻结（未上链）
            #   chain_frozen:  游戏启动，资金已通过 createMatch/joinMatch 上链冻结
            #   revealing:     揭晓中，至少 1 人已揭晓
            #   settled:       已结算
            "fund_stage": "local_frozen",
            # seat_mode: "open" = 空位对其他玩家开放, "ai" = 空位保留给 AI
            "seat_mode": "open",
        }

        self._rooms[room_id] = room
        self._player_rooms[creator_lower] = room_id
        redis_client.cache_room_state(room_id, room)

        # 启动房间生命周期总超时计时器
        self._start_lifetime_timer(room_id)

        # 启动空房间清理计时器（5 分钟内没玩家加入就自动关闭）
        self._start_empty_room_timer(room_id)

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
        logger.info(f"[Room] ✅ join_room #{room_id}: status={room['status']} p2={player_address[:10]}")

        # 有玩家加入了，停止空房间清理计时器
        self._stop_empty_room_timer(room_id)
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

        # 通知 Bot：玩家加入房间
        self._notify_bot_room_joined(room_id, player_address)

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

        # 🔥 游戏已结束（FINISHED/GAME_STARTED）→ 自动重置为再来一局
        if room["status"] in [ROOM_STATUS["FINISHED"], ROOM_STATUS["GAME_STARTED"]]:
            reset_result = self.reset_room_for_rematch(room_id, player_address)
            if not reset_result["success"]:
                return reset_result
            room = reset_result["room"]  # 拿重置后的 room 继续走下面的 ready 流程

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
                self._unready_since = now_timestamp()  # 重新开始倒计时
                self._start_unready_timer(player_address, room_id)
        else:
            room["player2_ready"] = not room["player2_ready"]
            if room["player2_ready"]:
                self._stop_unready_timer(player_address)
            else:
                room["_unready_since"] = now_timestamp()  # 重新开始倒计时
                self._start_unready_timer(player_address, room_id)

        # 关键修复：如果在 COUNTDOWN 阶段任一方取消准备，状态回退到 JOINED
        # _start_countdown 协程会检测到状态变化自动退出（并发送 countdown_cancelled）
        if was_countdown and not (room["creator_ready"] and room["player2_ready"]):
            room["status"] = ROOM_STATUS["JOINED"]
            room["countdown_start"] = None
            # 立即中断倒计时协程的 sleep（F-01 修复：之前要等 sleep 结束才退出）
            cancel_evt = self._countdown_cancel_events.pop(room_id, None)
            if cancel_evt and not cancel_evt.is_set():
                cancel_evt.set()
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

        # 通知 Bot：有玩家准备了，可能需要立即加入该房间
        self._notify_bot_player_ready(room_id)

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

            # 通知 Bot：准备状态变更
            self._notify_bot_ready_changed(room_id)

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

    # 启动空房间清理计时器（创建后 EMPTY_ROOM_TIMEOUT 秒内没玩家加入则关闭）
    def _start_empty_room_timer(self, room_id: str):
        """启动空房间自动清理计时器"""
        self._stop_empty_room_timer(room_id)

        async def timeout_task():
            await asyncio.sleep(EMPTY_ROOM_TIMEOUT)
            room = self._rooms.get(room_id)
            if not room:
                return
            # 只要还没 player2 加入，就清理（保护创建者）
            if not room.get("player2") and room["status"] in (ROOM_STATUS["CREATED"],):
                self._close_room(
                    room_id,
                    "empty_room_timeout",
                    f"房间创建后 {EMPTY_ROOM_TIMEOUT // 60} 分钟无玩家加入，已自动关闭",
                )

        task = asyncio.create_task(timeout_task())
        self._empty_room_timers[room_id] = task

    def _stop_empty_room_timer(self, room_id: str):
        """停止空房间清理计时器（有玩家加入后调用）"""
        if not room_id:
            return
        task = self._empty_room_timers.pop(room_id, None)
        if task:
            task.cancel()

    def _start_chain_setup_timer(self, room_id: str):
        """F-07 启动链上设置阶段超时计时器（creator 必须在 CHAIN_SETUP_TIMEOUT 内 createMatch + 上报 chain_game_id）"""
        self._stop_chain_setup_timer(room_id)

        async def timeout_task():
            from rps_backend.config import CHAIN_SETUP_TIMEOUT
            await asyncio.sleep(CHAIN_SETUP_TIMEOUT)
            room = self._rooms.get(room_id)
            if not room:
                return
            # 超时后 chain_game_id 仍为 None → creator 没完成 createMatch
            if room["status"] == ROOM_STATUS["GAME_STARTED"] and not room.get("chain_game_id"):
                logger.warning(f"[Room] F-07 chain setup timeout room={room_id} creator={room.get('creator','')[:10]}.. closing")
                self._close_room(
                    room_id,
                    "chain_setup_timeout",
                    f"游戏开始后 {CHAIN_SETUP_TIMEOUT}s 内未完成链上对局创建，房间已关闭",
                )
                self._broadcast_room_list_changed("room_closed", room_id)

        task = asyncio.create_task(timeout_task())
        self._chain_setup_timers[room_id] = task

    def _stop_chain_setup_timer(self, room_id: str):
        """链上设置完成后停止计时器（report_chain_game 里调用）"""
        if not room_id:
            return
        task = self._chain_setup_timers.pop(room_id, None)
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

        # 停止所有计时器（B-02 修复：之前遗漏了 unready 和 empty_room）
        self._stop_game_timer(room_id)
        self._stop_lifetime_timer(room_id)
        self._stop_empty_room_timer(room_id)
        self._stop_chain_setup_timer(room_id)
        self._stop_unready_timer(room["creator"])
        player2_in_room = room.get("player2")
        if player2_in_room:
            self._stop_unready_timer(player2_in_room)

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

        # 通知 Bot：房间已关闭，释放其本地房间槽位与游戏任务
        self._notify_bot_room_closed(room_id)

    def _is_bot_address(self, address: str) -> bool:
        """检测地址是否为已知 Bot 钱包地址"""
        if not address:
            return False
        addr_lower = address.lower()
        try:
            from rps_backend.service.bot_service import bot_service
            if bot_service._is_running:
                bot_addr = bot_service._wallet_address
                if bot_addr and bot_addr.lower() == addr_lower:
                    return True
        except Exception:
            pass
        try:
            from rps_backend.service.bot_manager import bot_manager
            for instance in bot_manager._instances.values():
                if instance._is_running and instance._wallet_address:
                    if instance._wallet_address.lower() == addr_lower:
                        return True
        except Exception:
            pass
        return False

    # 开始倒计时
    async def _start_countdown(self, room_id: str):
        """
        双方准备后倒计时开始游戏

        倒计时规则：
        - 普通玩家对局：15 秒
        - 有 Bot 参与的对局：5 秒（快速开始陪玩）

        倒计时同步机制：
        - 开始时发送 countdown_start 事件（包含结束时间戳），前端基于此本地计算剩余时间
        - 每3秒发送一次 countdown_tick 作为同步校准（最后阶段每秒）
        - 如果任一方取消准备，倒计时取消（cancel_event.set()，sleep 立即中断）
        - 倒计时结束后创建对局，进入提交阶段
        """
        room = self._rooms.get(room_id)
        if not room:
            return

        if room["status"] != ROOM_STATUS["COUNTDOWN"]:
            return

        # 创建取消信号
        cancel_event = asyncio.Event()
        self._countdown_cancel_events[room_id] = cancel_event

        creator = room.get("creator")
        player2 = room.get("player2")
        has_bot = self._is_bot_address(creator) or self._is_bot_address(player2)
        countdown_total = 5 if has_bot else 15
        logger.info(f"[Room] _start_countdown room={room_id} creator={creator} player2={player2} has_bot={has_bot} countdown={countdown_total}s")
        countdown_end = room["countdown_start"] + countdown_total

        player1 = room["creator"]

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

        # 倒计时循环：sleep 可被 cancel_event 立即中断（F-01 修复）
        while True:
            remaining = max(0, int(countdown_end - now_timestamp()))
            if remaining <= 0:
                break

            if remaining > 5:
                sleep_time = min(3, remaining - 5)
            else:
                sleep_time = 1

            # 用 gather 实现可中断 sleep：哪个先完成就继续
            try:
                sleep_task = asyncio.create_task(asyncio.sleep(sleep_time))
                cancel_task = asyncio.create_task(cancel_event.wait())
                done, pending = await asyncio.wait(
                    [sleep_task, cancel_task],
                    return_when=asyncio.FIRST_COMPLETED,
                )
                cancel_task.cancel()
                sleep_task.cancel()
                if cancel_event.is_set():
                    logger.info(f"[Room] countdown cancelled room={room_id}")
                    self._countdown_cancel_events.pop(room_id, None)
                    return
            except asyncio.CancelledError:
                self._countdown_cancel_events.pop(room_id, None)
                raise

            room = self._rooms.get(room_id)
            if not room:
                self._countdown_cancel_events.pop(room_id, None)
                return

            if room["status"] != ROOM_STATUS["COUNTDOWN"]:
                self._countdown_cancel_events.pop(room_id, None)
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

        # 倒计时结束，清理 event
        self._countdown_cancel_events.pop(room_id, None)

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

        # F-07 修复：链上模式下，creator 必须在 CHAIN_SETUP_TIMEOUT 内 createMatch + 上报 chain_game_id
        if BOT_AUTO_CHAIN_MATCH:
            self._start_chain_setup_timer(room_id)

        # 启动 commit 超时监控（提交阶段超时未操作 → 后端主动判负）
        from rps_backend.service.game_service import game_manager
        game_manager.start_commit_timeout_timer(game_id, commit_deadline_ts)

        player1 = room["creator"]
        player2 = room["player2"]
        creator_is_bot = self._is_bot_address(player1)
        player2_is_bot = self._is_bot_address(player2)

        # P-05 修复：双方 WS 消息并行发送（之前串行 await）
        msg1_data = {
            "room_id": room_id, "game_id": game_id, "is_creator": True,
            "opponent": player2, "token": room["token"],
            "bet_amount": room["bet_amount"], "commit_deadline": commit_deadline_ts,
            "creator_is_bot": creator_is_bot, "player2_is_bot": player2_is_bot,
            "local_only": not BOT_AUTO_CHAIN_MATCH,
        }
        msg2_data = {
            "room_id": room_id, "game_id": game_id, "is_creator": False,
            "opponent": player1, "token": room["token"],
            "bet_amount": room["bet_amount"], "commit_deadline": commit_deadline_ts,
            "creator_is_bot": creator_is_bot, "player2_is_bot": player2_is_bot,
            "local_only": not BOT_AUTO_CHAIN_MATCH,
        }
        await asyncio.gather(
            ws_manager.send_to_player(player1, WSMessage(type="game_started", data=msg1_data)) if player1 else asyncio.sleep(0),
            ws_manager.send_to_player(player2, WSMessage(type="game_started", data=msg2_data)) if player2 else asyncio.sleep(0),
            return_exceptions=False,
        )

        # 广播房间列表变更（房间状态变为 game_started，大厅卡片需要更新）
        self._broadcast_room_list_changed("game_started", room_id)

        # 通知 Bot：游戏开始
        self._notify_bot_game_started(room_id, game_id)

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
        # 链上对局已创建，停止链上设置超时计时器（F-07 修复）
        self._stop_chain_setup_timer(room_id)
        # 双方资金已通过 createMatch + joinMatch 上链锁定
        room["fund_stage"] = "chain_frozen"
        self._rooms[room_id] = room
        redis_client.cache_room_state(room_id, room)

        # 同步到本地对局记录
        local_game_id = room.get("game_id")
        if local_game_id:
            update_game_record(local_game_id, {"chain_game_id": chain_game_id})

        # P-05 修复：双方 WS 消息并行发送
        player2 = room["player2"]
        p2_task = ws_manager.send_to_player(player2, WSMessage(
            type="chain_game_created",
            data={
                "room_id": room_id,
                "chain_game_id": chain_game_id,
                "creator": room["creator"],
                "token": room["token"],
                "bet_amount": room["bet_amount"],
            },
        )) if player2 else asyncio.sleep(0)

        creator = room["creator"]
        creator_task = ws_manager.send_to_player(creator, WSMessage(
            type="chain_game_reported",
            data={
                "room_id": room_id,
                "chain_game_id": chain_game_id,
                "message": "链上对局 ID 已上报，等待对手加入",
                "timestamp": now_timestamp(),
            },
        )) if creator else asyncio.sleep(0)

        await asyncio.gather(p2_task, creator_task)

        # 通知 Bot：链上对局已创建
        self._notify_bot_chain_game_created(room_id, chain_game_id)

        return {"success": True, "chain_game_id": chain_game_id}

    # 获取房间信息
    def get_room(self, room_id: str) -> Optional[dict]:
        """获取房间信息（副本，包含 bot 标识 + deadlines 倒计时字段）"""
        room = self._rooms.get(room_id)
        if not room:
            return None
        result = dict(room)
        result["creator_is_bot"] = self._is_bot_address(room.get("creator"))
        result["player2_is_bot"] = self._is_bot_address(room.get("player2"))
        # 计算并附加所有阶段的超时 deadline（前端用来渲染倒计时）
        result["deadlines"] = _compute_deadlines(room)
        # 清理内部字段（不下发前端）
        result.pop("_unready_since", None)
        return result

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
                "creator_is_bot": self._is_bot_address(room["creator"]),
                "player2_is_bot": self._is_bot_address(room["player2"]),
            })

        return sorted(active_rooms, key=lambda r: r["created_at"], reverse=True)

    def cleanup_player_rooms(self, player_address: str) -> None:
        """
        清理玩家的残留状态
        
        从 _player_rooms 中移除玩家记录，并将相关房间重置为可用状态。
        用于 Bot 启动时的状态恢复，防止异常退出后的状态残留。
        """
        player_lower = player_address.lower()
        if player_lower not in self._player_rooms:
            return

        room_id = self._player_rooms.pop(player_lower, None)
        if room_id:
            room = self._rooms.get(room_id)
            if room:
                # 如果玩家是 player2，移除 player2
                if room.get("player2", "").lower() == player_lower:
                    room["player2"] = None
                    room["player2_ready"] = False
                    if room["status"] == ROOM_STATUS["JOINED"]:
                        room["status"] = ROOM_STATUS["CREATED"]
                # 如果玩家是 creator，不清理（房间由 creator 拥有）
                self._rooms[room_id] = room
                redis_client.cache_room_state(room_id, room)
                self._broadcast_room_list_changed("room_reopened", room_id)

    def is_player_in_room(self, player_address: str) -> bool:
        """检查玩家是否已在某个房间中"""
        return player_address.lower() in self._player_rooms

    def get_player_room_id(self, player_address: str) -> Optional[str]:
        """获取玩家所在的房间 ID，如不在房间中返回 None"""
        return self._player_rooms.get(player_address.lower())

    def set_seat_mode(self, room_id: str, creator_address: str, seat_mode: str) -> dict:
        """
        设置房间空位模式

        Args:
            room_id: 房间ID
            creator_address: 创建者地址（权限校验）
            seat_mode: "open" 或 "ai"

        Returns:
            {"success": True} 或 {"success": False, "message": "..."}
        """
        room = self._rooms.get(room_id)
        if not room:
            return {"success": False, "message": "房间不存在"}

        if room["creator"].lower() != creator_address.lower():
            return {"success": False, "message": "仅创建者可设置空位模式"}

        if seat_mode not in ("open", "ai"):
            return {"success": False, "message": "无效的空位模式"}

        if room["status"] not in [ROOM_STATUS["CREATED"], ROOM_STATUS["JOINED"]]:
            return {"success": False, "message": "当前阶段不可设置空位模式"}

        room["seat_mode"] = seat_mode
        self._rooms[room_id] = room
        redis_client.cache_room_state(room_id, room)

        self._broadcast_room_list_changed("seat_mode_changed", room_id)

        # 如果切换到 AI 模式，通知 Bot 加入
        if seat_mode == "ai" and not room.get("player2"):
            self._notify_bot_seat_ai(room_id)

        return {"success": True, "seat_mode": seat_mode}

    # 房主移出对手（关闭空位）
    def kick_player(self, room_id: str, creator_address: str) -> dict:
        """
        房主将当前对手（player2）移出房间。

        规则与 player2 主动退出一致：
        - 仅房主可操作
        - 空位无人时返回错误
        - GAME_STARTED 且资金已上链（chain_frozen/revealing）时不允许
        - COUNTDOWN 阶段自动取消倒计时并重置准备状态
        - 房间重置为 CREATED，空位重新开放

        Returns:
            {"success": True, "kicked": address, "message": "..."} 或错误 dict
        """
        room = self._rooms.get(room_id)
        if not room:
            return {"success": False, "message": "房间不存在"}

        if room["creator"].lower() != creator_address.lower():
            return {"success": False, "message": "仅房主可移出对手"}

        player2 = room.get("player2")
        if not player2:
            return {"success": False, "message": "空位暂无玩家"}

        # 对局进行中且资金已上链 → 禁止踢出（走链上索赔/撤销流程）
        if room["status"] == ROOM_STATUS["GAME_STARTED"]:
            fund_stage = room.get("fund_stage", "local_frozen")
            if fund_stage not in ("local_frozen", "settled"):
                return {"success": False, "message": "对局进行中（资金已上链），无法移出对手"}

        # COUNTDOWN 阶段：取消倒计时
        if room["status"] == ROOM_STATUS["COUNTDOWN"]:
            self._stop_game_timer(room_id)

        # 房间重置为 CREATED，空位重新对玩家开放
        room["player2"] = None
        room["status"] = ROOM_STATUS["CREATED"]
        room["creator_ready"] = False
        room["player2_ready"] = False
        room["countdown_start"] = None
        room["seat_mode"] = "open"
        room["chain_game_id"] = None
        room["game_id"] = None
        if room.get("fund_stage") not in ("settled",):
            room["fund_stage"] = "local_frozen"
        self._rooms[room_id] = room
        redis_client.cache_room_state(room_id, room)

        # 清理被踢玩家的映射与计时器
        player2_lower = player2.lower()
        if self._player_rooms.get(player2_lower) == room_id:
            self._player_rooms.pop(player2_lower, None)
        self._stop_unready_timer(player2)

        # 房主准备状态重置，重启其未准备超时
        creator = room.get("creator")
        if creator:
            self._start_unready_timer(creator, room_id)

        # 通知被踢玩家
        asyncio.create_task(ws_manager.send_to_player(player2, WSMessage(
            type="player_kicked",
            data={
                "room_id": room_id,
                "reason": "kicked_by_creator",
                "message": "你已被房主移出房间",
            }
        )))

        # 若被踢的是 Bot，通知它 cancelMatch 回收已锁定资金
        self._notify_bot_opponent_left(room_id)
        # 被踢者若为 Bot，通知其释放本地房间槽位
        self._notify_bot_player_removed(room_id, player2)
        # 房间已重置，若房主是 Bot，需要重新自动准备
        self._notify_bot_room_reset(room_id)

        # 广播房间列表变更（房间重新开放）
        self._broadcast_room_list_changed("room_reopened", room_id)

        return {"success": True, "kicked": player2, "message": "已将对手移出房间"}

    # 玩家退出房间
    def leave_room(self, room_id: str, player_address: str,
                   player2_chain_joined: bool = True) -> dict:
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
        # - GAME_STARTED 但 player2 自己尚未 join 链上对局（其资金还没锁）→ 允许退出
        # - GAME_STARTED 但资金仍为 local_frozen（链上对局创建失败/取消）→ 允许退出
        # - GAME_STARTED 且 fund_stage=settled（已结算）→ 允许退出
        # - FINISHED 状态 → 无条件允许退出（已结算完毕）
        # - COUNTDOWN/JOINED/CREATED → 均允许退出
        #   * COUNTDOWN 退出时自动取消倒计时，重置准备状态
        if room["status"] == ROOM_STATUS["FINISHED"]:
            # 🆕 FINISHED 状态无条件允许退出 — 不管 fund_stage 是什么
            self._close_room(room_id, "game_finished", "对局已结束，房间已关闭")
            return {"success": True, "action": "dissolved", "message": "对局已结束，房间已关闭"}

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
            # player2 自己还没 join 链上对局（资金尚未上链）→ 允许离开
            # 创建者已创建的链上对局由创建者自行 cancelMatch 回收资金
            if not is_creator and not player2_chain_joined:
                room["chain_game_id"] = None
                room["game_id"] = None
                room["fund_stage"] = "local_frozen"
            else:
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

            # 通知 Bot：房间已解散，释放其本地房间槽位
            self._notify_bot_room_closed(room_id)

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
            # 通知 Bot（若创建者是 Bot）：对手离开了，需 cancelMatch 回收已锁定的资金
            self._notify_bot_opponent_left(room_id)
            # 房间已重置，若创建者是 Bot，需要重新自动准备
            self._notify_bot_room_reset(room_id)

        # 若离开者本身是 Bot（含未准备超时踢出），通知其释放本地房间槽位
        self._notify_bot_player_removed(room_id, player_address)

        # 广播房间列表变更（房间重新开放，回到大厅）
        self._broadcast_room_list_changed("room_reopened", room_id)

        return {"success": True, "action": "left", "message": "已离开房间"}

    # 玩家 WebSocket 断开后的延迟房间清理
    async def handle_player_disconnect(self, player_address: str):
        """
        玩家 WebSocket 断开后，延迟检查房间是否需要清理。

        策略：
        - 延迟 30 秒后检查（给页面刷新/短暂断网/钱包切换留出充足重连窗口）
        - 延迟结束时立即二次检查：若该玩家已重新建立 WebSocket 连接 → 放弃清理
        - 仅处理 CREATED/JOINED/COUNTDOWN 状态（无链上资金的安全阶段）
        - 若房间内所有玩家均不在线 → 关闭房间并广播
        - 若仅 player2 断开且创建者仍在线 → 重置房间为 CREATED

        关键修复（Issue #3：取消准备提示"你不是本房间玩家"）：
        之前仅延迟 10 秒，用户刷新页面/钱包切换导致 WS 短暂断开，10 秒内
        新 WS 尚未建立时 handle_player_disconnect 已把 player2 清成 None，
        后端 toggle_ready 校验到 room["player2"] == None，返回
        "你不是这个房间的玩家"。现在延迟 30 秒 + 二次重连检查，彻底避免
        短暂断网导致的误清理。
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

        creator = room.get("creator")
        player2 = room.get("player2")

        # 确定断开者角色（B-05 修复：延迟期间可能有新玩家加入同一位置）
        disconnected_is_creator = (creator and addr_lower == creator.lower())
        disconnected_is_player2 = (player2 and addr_lower == player2.lower())

        # 延迟 30 秒检查，给页面刷新重连留出充足窗口
        await asyncio.sleep(30)

        # === 关键修复：二次重连检查 ===
        # 若该玩家在延迟期间已重新建立 WS 连接 → 放弃清理
        if addr_lower in ws_manager.active_connections:
            logger.info(f"[Room] 玩家 {player_address} 在延迟期间已重连，跳过房间清理")
            return

        # 重新获取房间（可能在延迟期间已被关闭或移除）
        room = self._rooms.get(room_id)
        if not room:
            return
        if room["status"] in [ROOM_STATUS["CLOSED"], ROOM_STATUS["FINISHED"]]:
            return
        if room["status"] == ROOM_STATUS["GAME_STARTED"]:
            # 延迟期间游戏已开始，不再清理
            return

        # B-05 修复：延迟结束时检查断开者的角色位置是否已被新玩家替换
        # 例如：A 断开 player2，延迟期间 B 加入成为新 player2 → 不再清理
        current_creator = room.get("creator")
        current_player2 = room.get("player2")
        if disconnected_is_player2 and current_player2 and current_player2.lower() != addr_lower:
            logger.info(f"[Room] B-05 fix: player2 slot already taken by {current_player2[:10]}.. skipping cleanup")
            return
        if disconnected_is_creator and current_creator and current_creator.lower() != addr_lower:
            logger.info(f"[Room] B-05 fix: creator slot changed, skipping cleanup")
            return

        creator = room.get("creator")
        player2 = room.get("player2")

        # 二次重连检查：延迟结束时再看一次是否已恢复连接
        # 某些情况下玩家 re-connect 的 WS 可能还在 ws_manager.connect 的 accept() 过程中
        # 这里给一个宽松窗口：只要 creator 或 player2 中任意一方已重连，就保留房间
        if creator and creator.lower() in ws_manager.active_connections:
            # 创建者还在线 → 保留 player2 玩家记录（哪怕 player2 此刻离线）
            # 因为 player2 可能只是 F5 刷新页面，马上会回来
            # 只有当 creator 在线且 player2 已经连续 30s 不在线时才清理
            pass  # 下面的 creator_online / player2_online 会处理

        # Bot 是服务端实体，不维护 WebSocket 连接，视为始终在线，
        # 否则人类玩家短暂刷新页面时，Bot 房间会被误判为"所有人离线"而关闭
        creator_online = bool(creator) and (
            creator.lower() in ws_manager.active_connections
            or self._is_bot_address(creator)
        )
        player2_online = bool(player2) and (
            player2.lower() in ws_manager.active_connections
            or self._is_bot_address(player2)
        )

        if not creator_online and not player2_online:
            # 所有人都不在线 → 关闭房间
            self._close_room(room_id, "all_players_disconnected", "所有玩家已离线，房间已关闭")
            self._broadcast_room_list_changed("room_closed", room_id)
            logger.info(f"[Room] 房间 {room_id} 因所有玩家离线已关闭")
            return

        # 若创建者在线但 player2 断开且房间在 JOINED/COUNTDOWN → 重置为 CREATED
        logger.info(f"[Room] _handle_player_disconnect #{room_id}: creator_online={creator_online} p2_online={player2_online} status={room['status']}")
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
                # 房间已重置，若创建者是 Bot，需要重新自动准备
                self._notify_bot_room_reset(room_id)
                logger.info(f"[Room] 房间 {room_id} 的 player2 离线，重置为 CREATED")

    async def mark_game_finished(self, game_id: int, winner: Optional[str] = None, is_draw: bool = False):
        """根据 game_id 找到关联房间，更新房间状态为 FINISHED，清理 timer"""
        for rid, rm in list(self._rooms.items()):
            if rm.get("game_id") == game_id:
                rm["status"] = ROOM_STATUS["FINISHED"]
                self._rooms[rid] = rm
                redis_client.cache_room_state(rid, rm)
                self._stop_game_timer(rid)
                self._stop_lifetime_timer(rid)
                self._broadcast_room_list_changed("game_finished", rid)
                return

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
        # 🆕 重置 fund_stage！后端 reveal 完成后设了 settled，但 reset 必须回到 local_frozen
        room["fund_stage"] = "local_frozen"
        room["close_reason"] = None
        room["closed_at"] = None
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

        # 通知房间内 Bot：房间已重置，需重新自动准备以开启下一局
        self._notify_bot_room_reset(room_id)

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
        # 通知 Bot：房间已移除，释放其本地房间槽位
        self._notify_bot_room_closed(room_id)

    # ==================== Bot 通知辅助方法 ====================

    def _notify_bot_room_joined(self, room_id: str, player_address: str) -> None:
        """通知 Bot：有玩家加入房间"""
        try:
            from rps_backend.service.bot_service import bot_service
            if bot_service._is_running:
                asyncio.create_task(bot_service.on_room_joined(room_id, player_address))
        except Exception:
            pass
        try:
            from rps_backend.service.bot_manager import bot_manager
            asyncio.create_task(bot_manager.dispatch_room_joined(room_id, player_address))
        except Exception:
            pass

    def _notify_bot_player_ready(self, room_id: str) -> None:
        """通知 Bot：有玩家准备好了，可能需要立即扫描并加入该房间"""
        try:
            from rps_backend.service.bot_service import bot_service
            if bot_service._is_running:
                asyncio.create_task(bot_service.on_player_ready(room_id))
        except Exception:
            pass
        try:
            from rps_backend.service.bot_manager import bot_manager
            asyncio.create_task(bot_manager.dispatch_player_ready(room_id))
        except Exception:
            pass

    def _notify_bot_ready_changed(self, room_id: str) -> None:
        """通知 Bot：准备状态变更"""
        try:
            from rps_backend.service.bot_service import bot_service
            if bot_service._is_running:
                asyncio.create_task(bot_service.on_room_ready_changed(room_id))
        except Exception:
            pass
        try:
            from rps_backend.service.bot_manager import bot_manager
            asyncio.create_task(bot_manager.dispatch_room_ready_changed(room_id))
        except Exception:
            pass

    def _notify_bot_game_started(self, room_id: str, game_id: int) -> None:
        """通知 Bot：游戏开始"""
        try:
            from rps_backend.service.bot_service import bot_service
            if bot_service._is_running:
                asyncio.create_task(bot_service.on_game_started_event(room_id, game_id))
        except Exception:
            pass
        try:
            from rps_backend.service.bot_manager import bot_manager
            asyncio.create_task(bot_manager.dispatch_game_started(room_id, game_id))
        except Exception:
            pass

    def _notify_bot_chain_game_created(self, room_id: str, chain_game_id: int) -> None:
        """通知 Bot：链上对局已创建"""
        try:
            from rps_backend.service.bot_service import bot_service
            if bot_service._is_running:
                asyncio.create_task(bot_service.on_chain_game_created(room_id, chain_game_id))
        except Exception:
            pass
        try:
            from rps_backend.service.bot_manager import bot_manager
            asyncio.create_task(bot_manager.dispatch_chain_game_created(room_id, chain_game_id))
        except Exception:
            pass

    def _notify_bot_opponent_left(self, room_id: str) -> None:
        """通知 Bot：对手已离开（可能需要 cancelMatch 回收链上资金）"""
        try:
            from rps_backend.service.bot_service import bot_service
            if bot_service._is_running:
                asyncio.create_task(bot_service.on_opponent_left(room_id))
        except Exception:
            pass
        try:
            from rps_backend.service.bot_manager import bot_manager
            asyncio.create_task(bot_manager.dispatch_opponent_left(room_id))
        except Exception:
            pass

    def _notify_bot_seat_ai(self, room_id: str) -> None:
        """通知 Bot：玩家邀请 AI 加入空位"""
        try:
            from rps_backend.service.bot_service import bot_service
            if bot_service._is_running:
                asyncio.create_task(bot_service.on_seat_ai_invited(room_id))
        except Exception:
            pass
        try:
            from rps_backend.service.bot_manager import bot_manager
            asyncio.create_task(bot_manager.dispatch_seat_ai_invited(room_id))
        except Exception:
            pass

    def _notify_bot_room_closed(self, room_id: str) -> None:
        """通知 Bot：房间已关闭/解散/移除，释放其本地房间槽位与游戏任务"""
        try:
            from rps_backend.service.bot_service import bot_service
            if bot_service._is_running:
                asyncio.create_task(bot_service.on_room_closed(room_id))
        except Exception:
            pass
        try:
            from rps_backend.service.bot_manager import bot_manager
            asyncio.create_task(bot_manager.dispatch_room_closed(room_id))
        except Exception:
            pass

    def _notify_bot_room_reset(self, room_id: str) -> None:
        """
        通知 Bot：房间已重置（对手离开/被踢/再来一局）。

        重置后双方准备标志会被清零，仍在房间内的 Bot 需要重新自动准备，
        否则人类对手准备后无法进入倒计时、无法自动开始对局。
        """
        try:
            from rps_backend.service.bot_service import bot_service
            if bot_service._is_running:
                asyncio.create_task(bot_service.on_room_reset(room_id))
        except Exception:
            pass
        try:
            from rps_backend.service.bot_manager import bot_manager
            asyncio.create_task(bot_manager.dispatch_room_reset(room_id))
        except Exception:
            pass

    def _notify_bot_player_removed(self, room_id: str, player_address: str) -> None:
        """通知指定地址的 Bot（若该玩家确为 Bot）：已不在房间中，释放其本地槽位"""
        if not player_address or not self._is_bot_address(player_address):
            return
        try:
            from rps_backend.service.bot_service import bot_service
            bot_addr = bot_service._wallet_address
            if (
                bot_service._is_running
                and bot_addr
                and bot_addr.lower() == player_address.lower()
            ):
                asyncio.create_task(bot_service.on_room_closed(room_id))
        except Exception:
            pass
        try:
            from rps_backend.service.bot_manager import bot_manager
            asyncio.create_task(
                bot_manager.dispatch_player_removed(room_id, player_address)
            )
        except Exception:
            pass


# 房间管理器实例
room_manager = RoomManager()