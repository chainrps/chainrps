"""
房间管理服务模块

负责 ChainRPS 的房间模式功能：
- 创建房间（替代原来的寻找对手）
- 加入房间
- 准备/取消准备
- 双方准备后倒计时10秒开始游戏
- 交易大厅：查看所有已创建的房间

房间状态流转：
CREATED -> JOINED -> READY (双方准备) -> COUNTDOWN (10秒倒计时) -> GAME_STARTED
"""
import asyncio
import uuid
from datetime import datetime
from typing import Dict, Optional, List

from backend.models import GameState, WSMessage
from backend.repository import create_game_record, update_game_record
from backend.utils.helpers import now_timestamp, calculate_deadline, deadline_to_iso
from backend.utils.redis_client import redis_client
from backend.websocket import ws_manager


ROOM_STATUS = {
    "CREATED": "created",
    "JOINED": "joined",
    "READY": "ready",
    "COUNTDOWN": "countdown",
    "GAME_STARTED": "game_started",
    "FINISHED": "finished",
}


class RoomManager:
    """房间管理器：负责房间的创建、加入、准备和游戏开始"""

    def __init__(self):
        self._rooms: Dict[str, dict] = {}

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
        redis_client.cache_room_state(room_id, room)

        return {
            "success": True,
            "room_id": room_id,
            "message": "房间创建成功",
        }

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

        if room["creator"].lower() == player_address.lower():
            return {"success": False, "message": "不能加入自己创建的房间"}

        room["player2"] = player_address
        room["status"] = ROOM_STATUS["JOINED"]

        self._rooms[room_id] = room
        redis_client.cache_room_state(room_id, room)

        asyncio.create_task(ws_manager.send_to_player(room["creator"], WSMessage(
            type="room_joined",
            data={
                "room_id": room_id,
                "player2": player_address,
            }
        )))

        return {
            "success": True,
            "room": room,
        }

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

        if room["status"] not in [ROOM_STATUS["JOINED"], ROOM_STATUS["READY"], ROOM_STATUS["COUNTDOWN"]]:
            return {"success": False, "message": "当前阶段不能准备"}

        if is_creator:
            room["creator_ready"] = not room["creator_ready"]
        else:
            room["player2_ready"] = not room["player2_ready"]

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
            room["status"] = ROOM_STATUS["COUNTDOWN"]
            room["countdown_start"] = now_timestamp()
            self._rooms[room_id] = room
            redis_client.cache_room_state(room_id, room)

            asyncio.create_task(self._start_countdown(room_id))

        return {
            "success": True,
            "room": room,
        }

    async def _start_countdown(self, room_id: str):
        """
        15秒倒计时后开始游戏

        倒计时期间：
        - 每秒推送 countdown_tick 消息
        - 最后5秒标记为 danger，前端醒目提示
        - 如果任一方取消准备，倒计时取消
        - 倒计时结束后创建对局，进入提交阶段
        """
        room = self._rooms.get(room_id)
        if not room:
            return

        countdown_total = 15
        countdown_end = room["countdown_start"] + countdown_total

        while now_timestamp() < countdown_end:
            await asyncio.sleep(1)

            room = self._rooms.get(room_id)
            if not room:
                return

            if room["status"] != ROOM_STATUS["COUNTDOWN"]:
                return

            remaining = max(0, int(countdown_end - now_timestamp()))
            # 最后5秒标记为危险阶段，前端醒目提示
            is_danger = remaining <= 5

            player1 = room["creator"]
            player2 = room["player2"]

            tick_data = {
                "room_id": room_id,
                "remaining": remaining,
                "total": countdown_total,
                "is_danger": is_danger,
            }

            if player1:
                await ws_manager.send_to_player(player1, WSMessage(
                    type="countdown_tick",
                    data=tick_data
                ))
            if player2:
                await ws_manager.send_to_player(player2, WSMessage(
                    type="countdown_tick",
                    data=tick_data
                ))

        await self._start_game(room_id)

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

        from backend.config import COMMIT_TIMEOUT
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
        self._rooms[room_id] = room
        redis_client.cache_room_state(room_id, room)

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

    def get_room(self, room_id: str) -> Optional[dict]:
        """获取房间信息"""
        return self._rooms.get(room_id)

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

    def remove_room(self, room_id: str):
        """移除房间"""
        self._rooms.pop(room_id, None)
        redis_client.delete_cached_room_state(room_id)


room_manager = RoomManager()
