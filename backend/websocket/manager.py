"""
WebSocket 连接管理器

负责管理所有 WebSocket 连接的生命周期，包括：
- 连接的建立与断开
- 消息的点对点发送、对局广播和全局广播
- 对局订阅管理
- 客户端消息处理
"""
from typing import Dict, Set
from datetime import datetime

from fastapi import WebSocket

from backend.models import WSMessage
from backend.utils.redis_client import redis_client
from backend.config import WS_PREFIX


class WebSocketManager:
    """WebSocket 连接管理器，维护玩家连接与对局订阅关系"""

    def __init__(self):
        # 玩家地址 -> WebSocket 连接
        self.active_connections: Dict[str, WebSocket] = {}
        # 对局 ID -> 订阅该对局的玩家地址集合
        self.game_subscriptions: Dict[int, Set[str]] = {}

    async def connect(self, websocket: WebSocket, player_address: str):
        """建立 WebSocket 连接，注册并发送欢迎消息"""
        # 接收连接
        await websocket.accept()
        self.active_connections[player_address] = websocket

        # 注册到 Redis（用于跨进程通信），连接 ID 使用 WS_PREFIX 前缀
        connection_id = f"{WS_PREFIX}{player_address}_{datetime.utcnow().timestamp()}"
        redis_client.register_ws_connection(player_address, connection_id)

        # 发送欢迎消息
        await self.send_to_player(player_address, WSMessage(
            type="connected",
            data={"address": player_address}
        ))

    async def disconnect(self, player_address: str):
        """断开连接，移除连接记录并清理所有订阅"""
        # 移除活跃连接
        if player_address in self.active_connections:
            del self.active_connections[player_address]

        # 清理所有对局订阅
        for game_id, subscribers in list(self.game_subscriptions.items()):
            subscribers.discard(player_address)
            # 若该对局已无订阅者，移除整个集合
            if not subscribers:
                del self.game_subscriptions[game_id]

        # 注销 Redis 中的连接记录
        redis_client.unregister_ws_connection(player_address)

    async def send_to_player(self, player_address: str, message: WSMessage):
        """发送消息给指定玩家，失败时断开连接"""
        if player_address not in self.active_connections:
            return
        websocket = self.active_connections[player_address]
        try:
            await websocket.send_json(message.model_dump())
        except Exception:
            # 连接已断开，清理资源
            await self.disconnect(player_address)

    async def send_to_game(self, game_id: int, message: WSMessage):
        """发送消息给订阅了指定对局的所有玩家"""
        subscribers = self.game_subscriptions.get(game_id, set())
        # 复制一份，避免发送过程中订阅集合发生变化
        for player_address in list(subscribers):
            await self.send_to_player(player_address, message)

    async def broadcast(self, message: WSMessage):
        """广播消息给所有已连接的玩家"""
        # 复制一份地址列表，避免广播过程中连接集合发生变化
        for player_address in list(self.active_connections.keys()):
            await self.send_to_player(player_address, message)

    async def subscribe_game(self, player_address: str, game_id: int):
        """订阅指定对局的更新消息"""
        if game_id not in self.game_subscriptions:
            self.game_subscriptions[game_id] = set()
        self.game_subscriptions[game_id].add(player_address)

    async def unsubscribe_game(self, player_address: str, game_id: int):
        """取消订阅指定对局"""
        if game_id in self.game_subscriptions:
            self.game_subscriptions[game_id].discard(player_address)
            # 若该对局已无订阅者，移除整个集合
            if not self.game_subscriptions[game_id]:
                del self.game_subscriptions[game_id]

    async def handle_message(self, player_address: str, message: dict):
        """处理客户端发来的消息，支持 ping 与对局订阅"""
        msg_type = message.get("type")

        if msg_type == "ping":
            # 心跳探测响应
            await self.send_to_player(player_address, WSMessage(
                type="pong",
                data={}
            ))
        elif msg_type == "subscribe_game":
            # 订阅对局更新
            game_id = message.get("game_id")
            if game_id is not None:
                await self.subscribe_game(player_address, int(game_id))


# 全局 WebSocket 管理器实例
ws_manager = WebSocketManager()
