"""
WebSocket 连接管理器

负责管理所有 WebSocket 连接的生命周期，包括：
- 连接的建立与断开
- 消息的点对点发送、对局广播和全局广播
- 对局订阅管理
- 客户端消息处理
- 通过 Redis Pub/Sub 实现跨进程广播
"""
import asyncio
import json
from typing import Dict, Set
from datetime import datetime

from fastapi import WebSocket

from rps_backend.models import WSMessage
from rps_backend.utils.redis_client import redis_client
from rps_backend.config import WS_PREFIX, REDIS_BROADCAST_CHANNEL


# WebSocket连接管理器
class WebSocketManager:
    """WebSocket 连接管理器，维护玩家连接与对局订阅关系"""

    # 初始化
    def __init__(self):
        # 玩家地址（小写） -> WebSocket 连接
        self.active_connections: Dict[str, WebSocket] = {}
        # 原始地址映射：小写地址 -> 原始地址
        self._original_addresses: Dict[str, str] = {}
        # 对局 ID -> 订阅该对局的玩家地址集合（小写）
        self.game_subscriptions: Dict[int, Set[str]] = {}
        # 是否已启动 Redis Pub/Sub 订阅
        self._pubsub_running = False

    # 建立连接
    async def connect(self, websocket: WebSocket, player_address: str):
        """建立 WebSocket 连接，注册并发送欢迎消息"""
        # 统一使用小写地址作为 key
        addr_lower = player_address.lower()
        # 接收连接
        await websocket.accept()
        self.active_connections[addr_lower] = websocket
        self._original_addresses[addr_lower] = player_address
        
        print(f"[WS Connect] 玩家 {player_address} 已连接，当前连接数: {len(self.active_connections)}")

        # 注册到 Redis（用于跨进程通信），连接 ID 使用 WS_PREFIX 前缀
        connection_id = f"{WS_PREFIX}{addr_lower}_{datetime.utcnow().timestamp()}"
        redis_client.register_ws_connection(addr_lower, connection_id)

        # 发送欢迎消息
        await self.send_to_player(player_address, WSMessage(
            type="connected",
            data={"address": player_address}
        ))

    # 断开连接
    async def disconnect(self, player_address: str):
        """断开连接，移除连接记录并清理所有订阅"""
        addr_lower = player_address.lower()
        # 移除活跃连接
        if addr_lower in self.active_connections:
            del self.active_connections[addr_lower]
        self._original_addresses.pop(addr_lower, None)

        # 清理所有对局订阅
        for game_id, subscribers in list(self.game_subscriptions.items()):
            subscribers.discard(addr_lower)
            # 若该对局已无订阅者，移除整个集合
            if not subscribers:
                del self.game_subscriptions[game_id]

        # 注销 Redis 中的连接记录
        redis_client.unregister_ws_connection(addr_lower)

    # 发送消息给指定玩家
    async def send_to_player(self, player_address: str, message: WSMessage):
        """发送消息给指定玩家，失败时断开连接"""
        addr_lower = player_address.lower()
        if addr_lower not in self.active_connections:
            return
        websocket = self.active_connections[addr_lower]
        try:
            await websocket.send_json(message.model_dump())
        except Exception:
            # 连接已断开，清理资源
            await self.disconnect(player_address)

    # 发送消息给对局订阅者
    async def send_to_game(self, game_id: int, message: WSMessage):
        """发送消息给订阅了指定对局的所有玩家"""
        subscribers = self.game_subscriptions.get(game_id, set())
        # 复制一份，避免发送过程中订阅集合发生变化
        for addr_lower in list(subscribers):
            original_addr = self._original_addresses.get(addr_lower, addr_lower)
            await self.send_to_player(original_addr, message)

    # 启动Redis订阅监听
    async def _start_pubsub_listener(self):
        """启动 Redis Pub/Sub 订阅监听器，处理跨进程广播消息"""
        if self._pubsub_running or redis_client._memory_mode:
            return
        
        if not redis_client.client:
            print("[WS Pub/Sub] Redis 客户端不可用，跳过 Pub/Sub 启动")
            return
        
        self._pubsub_running = True
        print("[WS Pub/Sub] 启动 Redis Pub/Sub 监听器")
        
        async def listener():
            try:
                pubsub = redis_client.client.pubsub()
                pubsub.subscribe(REDIS_BROADCAST_CHANNEL)
                print(f"[WS Pub/Sub] 已订阅频道: {REDIS_BROADCAST_CHANNEL}")
                
                while self._pubsub_running:
                    message = pubsub.get_message(ignore_subscribe_messages=True)
                    if message:
                        try:
                            data = json.loads(message['data'])
                            msg_type = data.get('type')
                            msg_data = data.get('data', {})
                            
                            print(f"[WS Pub/Sub] 收到消息: {msg_type}, 当前连接数: {len(self.active_connections)}")
                            
                            ws_message = WSMessage(type=msg_type, data=msg_data)
                            # 广播给当前进程的所有连接
                            for addr_lower in list(self.active_connections.keys()):
                                original_addr = self._original_addresses.get(addr_lower, addr_lower)
                                await self.send_to_player(original_addr, ws_message)
                        except json.JSONDecodeError as e:
                            print(f"[WS Pub/Sub JSON Error] {e}")
                    await asyncio.sleep(0.01)
            except Exception as e:
                print(f"[WS Pub/Sub Error] {e}")
                self._pubsub_running = False
        
        asyncio.create_task(listener())

    # 广播消息给所有玩家
    async def broadcast(self, message: WSMessage):
        """广播消息给所有已连接的玩家（通过 Redis Pub/Sub 实现跨进程）"""
        print(f"[WS Broadcast] 发送消息类型: {message.type}, 连接数: {len(self.active_connections)}")
        
        # 通过 Redis Pub/Sub 广播到所有进程
        if not redis_client._memory_mode and redis_client.is_connected():
            await self._start_pubsub_listener()
            message_data = {
                'type': message.type,
                'data': message.data
            }
            redis_client.client.publish(REDIS_BROADCAST_CHANNEL, json.dumps(message_data))
        
        # 同时广播给当前进程的所有连接
        for addr_lower in list(self.active_connections.keys()):
            original_addr = self._original_addresses.get(addr_lower, addr_lower)
            await self.send_to_player(original_addr, message)

    # 订阅对局
    async def subscribe_game(self, player_address: str, game_id: int):
        """订阅指定对局的更新消息"""
        addr_lower = player_address.lower()
        if game_id not in self.game_subscriptions:
            self.game_subscriptions[game_id] = set()
        self.game_subscriptions[game_id].add(addr_lower)

    # 取消订阅对局
    async def unsubscribe_game(self, player_address: str, game_id: int):
        """取消订阅指定对局"""
        addr_lower = player_address.lower()
        if game_id in self.game_subscriptions:
            self.game_subscriptions[game_id].discard(addr_lower)
            # 若该对局已无订阅者，移除整个集合
            if not self.game_subscriptions[game_id]:
                del self.game_subscriptions[game_id]

    # 处理客户端消息
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