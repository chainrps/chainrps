"""
WebSocket 连接管理
"""
import asyncio
from typing import Dict, Set
from datetime import datetime

from fastapi import WebSocket, WebSocketDisconnect

from .models import WSMessage
from .redis_client import redis_client


class WebSocketManager:
    """WebSocket 连接管理器"""

    def __init__(self):
        self.active_connections: Dict[str, WebSocket] = {}  # address -> WebSocket
        self.connection_by_id: Dict[str, Set[str]] = {}  # connection_id -> addresses

    async def connect(self, websocket: WebSocket, player_address: str):
        """建立连接"""
        await websocket.accept()
        self.active_connections[player_address] = websocket

        # 注册到 Redis（用于跨进程通信）
        connection_id = f"ws_{player_address}_{datetime.utcnow().timestamp()}"
        redis_client.register_ws_connection(player_address, connection_id)

        # 发送欢迎消息
        await self.send_to_player(player_address, WSMessage(
            type="connected",
            data={"address": player_address}
        ))

    async def disconnect(self, player_address: str):
        """断开连接"""
        if player_address in self.active_connections:
            del self.active_connections[player_address]

        redis_client.unregister_ws_connection(player_address)

    async def send_to_player(self, player_address: str, message: WSMessage):
        """发送消息给指定玩家"""
        if player_address in self.active_connections:
            websocket = self.active_connections[player_address]
            try:
                await websocket.send_json(message.model_dump())
            except:
                # 连接已断开
                await self.disconnect(player_address)

    async def broadcast(self, message: WSMessage):
        """广播消息给所有连接"""
        disconnected = []

        for address, websocket in self.active_connections.items():
            try:
                await websocket.send_json(message.model_dump())
            except:
                disconnected.append(address)

        # 清理断开的连接
        for address in disconnected:
            await self.disconnect(address)

    async def send_heartbeat(self):
        """发送心跳"""
        await self.broadcast(WSMessage(
            type="heartbeat",
            data={}
        ))

    async def handle_message(self, player_address: str, message: dict):
        """处理接收到的消息"""
        msg_type = message.get("type")

        if msg_type == "ping":
            # 心跳响应
            await self.send_to_player(player_address, WSMessage(
                type="pong",
                data={}
            ))
        elif msg_type == "subscribe_game":
            # 订阅特定对局更新
            game_id = message.get("game_id")
            # 在实际实现中可以维护订阅列表
        else:
            # 其他消息类型
            pass


# 全局 WebSocket 管理器实例
ws_manager = WebSocketManager()


async def websocket_endpoint(websocket: WebSocket, player_address: str):
    """WebSocket 连接处理函数"""
    await ws_manager.connect(websocket, player_address)

    try:
        while True:
            # 接收消息
            data = await websocket.receive_json()
            await ws_manager.handle_message(player_address, data)

    except WebSocketDisconnect:
        await ws_manager.disconnect(player_address)

    except Exception as e:
        print(f"WebSocket error: {e}")
        await ws_manager.disconnect(player_address)