"""
房间管理服务模块

负责 ChainRPS 的房间模式功能：
- 创建房间（替代原来的寻找对手）
- 加入房间
- 准备/取消准备
- 双方准备后倒计时15秒开始游戏
- 交易大厅：查看所有已创建的房间
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
from rps_backend.repository import create_game_record, update_game_record
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
        }

        self._rooms[room_id] = room
        self._player_rooms[creator_lower] = room_id
        redis_client.cache_room_state(room_id, room)

        # 广播房间列表变更，让交易大厅实时刷新
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

        if room["creator_ready"] and room["player2_ready"]:
            # 双方都准备了，停止双方的未准备超时
            self._stop_unready_timer(room["creator"])
            self._stop_unready_timer(room["player2"])
            room["status"] = ROOM_STATUS["COUNTDOWN"]
            room["countdown_start"] = now_timestamp()
            self._rooms[room_id] = room
            redis_client.cache_room_state(room_id, room)

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

    # 关闭房间
    def _close_room(self, room_id: str, reason: str, message: str):
        """
        关闭房间（超时、异常等情况）

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
        self._rooms[room_id] = room
        redis_client.cache_room_state(room_id, room)

        # 停止游戏超时计时器
        self._stop_game_timer(room_id)

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
        - 如果任一方取消准备，倒计时取消
        - 倒计时结束后创建对局，进入提交阶段
        """
        room = self._rooms.get(room_id)
        if not room:
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

        return {"success": True, "chain_game_id": chain_game_id}

    # 获取房间信息
    def get_room(self, room_id: str) -> Optional[dict]:
        """获取房间信息"""
        return self._rooms.get(room_id)

    # 获取交易大厅房间列表
    def get_room_list(self) -> List[dict]:
        """
        获取交易大厅的房间列表

        返回所有未开始游戏的房间（CREATED 和 JOINED 状态）
        """
        now = now_timestamp()
        active_rooms = []

        for room_id, room in self._rooms.items():
            if room["status"] in [ROOM_STATUS["CREATED"], ROOM_STATUS["JOINED"]]:
                if now - room["created_at"] < 3600:
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

        # 倒计时中或游戏已开始不允许通过此接口退出
        if room["status"] in [ROOM_STATUS["COUNTDOWN"], ROOM_STATUS["GAME_STARTED"]]:
            return {"success": False, "message": "游戏即将开始或已开始，无法退出房间"}

        is_creator = room["creator"].lower() == player_address.lower()
        is_player2 = room["player2"] and room["player2"].lower() == player_address.lower()

        if not (is_creator or is_player2):
            return {"success": False, "message": "你不在此房间中"}

        if is_creator:
            # 创建者退出 → 解散房间
            player2 = room.get("player2")
            self._rooms.pop(room_id, None)
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

        # player2 退出 → 重置房间为 CREATED 状态，保留在交易大厅
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

    # 广播房间列表变更事件
    def _broadcast_room_list_changed(self, event: str, room_id: str):
        """
        广播房间列表变更事件给所有已连接客户端

        交易大厅的客户端收到此事件后，应主动拉取一次房间列表，
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
