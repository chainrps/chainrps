"""
WebSocket 连接管理器

负责管理所有 WebSocket 连接的生命周期，包括：
- 连接的建立与断开
- 消息的点对点发送、房间广播和全局广播
- 对局/房间订阅管理
- 客户端消息处理
- 通过 Redis Pub/Sub 实现跨进程广播（全局 + 点对点）

跨进程通信设计：
- REDIS_BROADCAST_CHANNEL：全局广播，所有进程订阅并下发给本地连接
- REDIS_DIRECT_CHANNEL：点对点路由，发布时携带 target_address，
  每个进程订阅后检查 target_address 是否在本地，命中则下发
"""
import asyncio
import json
from functools import partial
from typing import Dict, Set, List, Optional
from datetime import datetime

from fastapi import WebSocket

from rps_backend.models import WSMessage
from rps_backend.utils.redis_client import redis_client
from rps_backend.config import WS_PREFIX, REDIS_BROADCAST_CHANNEL, REDIS_DIRECT_CHANNEL


async def _run_sync(func, *args, **kwargs):
    """将同步的 Redis 调用放到线程池执行，避免阻塞事件循环"""
    loop = asyncio.get_running_loop()
    return await loop.run_in_executor(None, partial(func, *args, **kwargs))


# WebSocket连接管理器
class WebSocketManager:
    """WebSocket 连接管理器，维护玩家连接与对局/房间订阅关系"""

    # 初始化
    def __init__(self):
        # 玩家地址（小写） -> WebSocket 连接
        self.active_connections: Dict[str, WebSocket] = {}
        # 原始地址映射：小写地址 -> 原始地址
        self._original_addresses: Dict[str, str] = {}
        # 对局 ID -> 订阅该对局的玩家地址集合（小写）
        self.game_subscriptions: Dict[int, Set[str]] = {}
        # 房间 ID -> 订阅该房间的玩家地址集合（小写）
        self.room_subscriptions: Dict[str, Set[str]] = {}
        # 是否已启动 Redis Pub/Sub 订阅
        self._pubsub_running = False
        # 是否已启动点对点路由订阅
        self._direct_pubsub_running = False

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

        # 注册到 Redis（用于跨进程查询玩家连接是否存在）
        connection_id = f"{WS_PREFIX}{addr_lower}_{datetime.utcnow().timestamp()}"
        # 同步 Redis 调用放到线程池，避免阻塞事件循环
        await _run_sync(redis_client.register_ws_connection, addr_lower, connection_id)

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

        # 清理所有房间订阅
        for room_id, subscribers in list(self.room_subscriptions.items()):
            subscribers.discard(addr_lower)
            if not subscribers:
                del self.room_subscriptions[room_id]

        # 注销 Redis 中的连接记录（同步 Redis 调用放到线程池）
        await _run_sync(redis_client.unregister_ws_connection, addr_lower)

    # 发送消息给指定玩家（自动跨进程路由）
    async def send_to_player(self, player_address: str, message: WSMessage):
        """
        发送消息给指定玩家

        路由策略：
        1. 若玩家连接在当前进程，直接下发
        2. 若不在当前进程，发布到 REDIS_DIRECT_CHANNEL，由目标进程接收并下发
        3. 失败时断开本地连接（如果是本地连接）
        """
        addr_lower = player_address.lower()
        # 本地命中：直接发送
        if addr_lower in self.active_connections:
            websocket = self.active_connections[addr_lower]
            try:
                await websocket.send_json(message.model_dump())
                return
            except Exception:
                # 连接已断开，清理资源
                await self.disconnect(player_address)
                return

        # 本地未命中：通过 Redis Pub/Sub 跨进程路由
        # 内存模式下没有跨进程，直接返回（避免开发环境无谓的 publish）
        if redis_client._memory_mode or not redis_client.client:
            return

        # 检查 Redis 中是否注册了该玩家连接（避免无意义 publish）
        registered = await _run_sync(redis_client.get_ws_connection, addr_lower)
        if not registered:
            # 玩家不在线，丢弃消息
            return

        # 发布到点对点路由频道
        def _publish_direct():
            payload = {
                "target": addr_lower,
                "type": message.type,
                "data": message.data,
                "timestamp": message.timestamp.isoformat() if message.timestamp else None,
            }
            redis_client.client.publish(REDIS_DIRECT_CHANNEL, json.dumps(payload))

        await _run_sync(_publish_direct)
        # 确保订阅器已启动
        await self._start_direct_pubsub_listener()

    # 批量发送消息给多个玩家（用于房间双方通知）
    async def send_to_players(self, addresses: List[str], message: WSMessage):
        """
        批量发送消息给多个玩家

        Args:
            addresses: 玩家地址列表（自动去重、去空）
            message: 要发送的 WSMessage
        """
        seen = set()
        for addr in addresses:
            if not addr:
                continue
            addr_lower = addr.lower()
            if addr_lower in seen:
                continue
            seen.add(addr_lower)
            await self.send_to_player(addr, message)

    # 发送消息给房间内所有订阅者
    async def send_to_room(self, room_id: str, message: WSMessage):
        """
        发送消息给订阅了指定房间的所有玩家

        Args:
            room_id: 房间ID
            message: 要发送的 WSMessage
        """
        subscribers = self.room_subscriptions.get(room_id, set())
        for addr_lower in list(subscribers):
            original_addr = self._original_addresses.get(addr_lower, addr_lower)
            await self.send_to_player(original_addr, message)

    # 发送消息给对局订阅者
    async def send_to_game(self, game_id: int, message: WSMessage):
        """发送消息给订阅了指定对局的所有玩家"""
        subscribers = self.game_subscriptions.get(game_id, set())
        # 复制一份，避免发送过程中订阅集合发生变化
        for addr_lower in list(subscribers):
            original_addr = self._original_addresses.get(addr_lower, addr_lower)
            await self.send_to_player(original_addr, message)

    # 启动 Redis 全局广播订阅监听
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

                            # heartbeat 类型降低日志级别，避免刷屏
                            if msg_type != "heartbeat":
                                print(f"[WS Pub/Sub] 收到广播: {msg_type}, 当前连接数: {len(self.active_connections)}")

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

    # 启动 Redis 点对点路由订阅监听
    async def _start_direct_pubsub_listener(self):
        """启动 Redis 点对点路由订阅监听器，处理跨进程点对点消息"""
        if self._direct_pubsub_running or redis_client._memory_mode:
            return

        if not redis_client.client:
            return

        self._direct_pubsub_running = True
        print("[WS Direct] 启动 Redis 点对点路由监听器")

        async def listener():
            try:
                pubsub = redis_client.client.pubsub()
                pubsub.subscribe(REDIS_DIRECT_CHANNEL)
                print(f"[WS Direct] 已订阅频道: {REDIS_DIRECT_CHANNEL}")

                while self._direct_pubsub_running:
                    message = pubsub.get_message(ignore_subscribe_messages=True)
                    if message:
                        try:
                            payload = json.loads(message['data'])
                            target_lower = payload.get('target', '').lower()
                            if not target_lower:
                                continue

                            # 仅当目标连接在当前进程时才下发
                            if target_lower not in self.active_connections:
                                continue

                            msg_type = payload.get('type')
                            msg_data = payload.get('data', {})
                            ws_message = WSMessage(type=msg_type, data=msg_data)

                            original_addr = self._original_addresses.get(target_lower, target_lower)
                            # 直接调用本地发送（避免再次走 Redis 路由）
                            websocket = self.active_connections[target_lower]
                            try:
                                await websocket.send_json(ws_message.model_dump())
                            except Exception:
                                await self.disconnect(original_addr)
                        except json.JSONDecodeError as e:
                            print(f"[WS Direct JSON Error] {e}")
                    await asyncio.sleep(0.01)
            except Exception as e:
                print(f"[WS Direct Error] {e}")
                self._direct_pubsub_running = False

        asyncio.create_task(listener())

    # 广播消息给所有玩家
    async def broadcast(self, message: WSMessage):
        """广播消息给所有已连接的玩家（通过 Redis Pub/Sub 实现跨进程）"""
        # heartbeat 类型降低日志级别，避免每 30 秒刷屏
        if message.type != "heartbeat":
            print(f"[WS Broadcast] 发送消息类型: {message.type}, 连接数: {len(self.active_connections)}")

        # 通过 Redis Pub/Sub 广播到所有进程
        # 同步 Redis 调用（is_connected + publish）放到线程池，避免阻塞事件循环
        if not redis_client._memory_mode:
            def _publish():
                if not redis_client.is_connected():
                    return False
                message_data = {
                    'type': message.type,
                    'data': message.data
                }
                redis_client.client.publish(REDIS_BROADCAST_CHANNEL, json.dumps(message_data))
                return True

            published = await _run_sync(_publish)
            if published:
                await self._start_pubsub_listener()

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

    # 订阅房间
    async def subscribe_room(self, player_address: str, room_id: str):
        """订阅指定房间的更新消息"""
        addr_lower = player_address.lower()
        if room_id not in self.room_subscriptions:
            self.room_subscriptions[room_id] = set()
        self.room_subscriptions[room_id].add(addr_lower)

    # 取消订阅房间
    async def unsubscribe_room(self, player_address: str, room_id: str):
        """取消订阅指定房间"""
        addr_lower = player_address.lower()
        if room_id in self.room_subscriptions:
            self.room_subscriptions[room_id].discard(addr_lower)
            if not self.room_subscriptions[room_id]:
                del self.room_subscriptions[room_id]

    # 处理客户端消息
    async def handle_message(self, player_address: str, message: dict):
        """
        处理客户端发来的消息

        支持的消息类型：
        - ping: 心跳探测响应
        - subscribe_game: 订阅对局
        - unsubscribe_game: 取消订阅对局
        - subscribe_room: 订阅房间
        - unsubscribe_room: 取消订阅房间
        """
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
        elif msg_type == "unsubscribe_game":
            game_id = message.get("game_id")
            if game_id is not None:
                await self.unsubscribe_game(player_address, int(game_id))
        elif msg_type == "subscribe_room":
            # 订阅房间更新
            room_id = message.get("room_id")
            if room_id:
                await self.subscribe_room(player_address, str(room_id))
        elif msg_type == "unsubscribe_room":
            room_id = message.get("room_id")
            if room_id:
                await self.unsubscribe_room(player_address, str(room_id))


# 全局 WebSocket 管理器实例
ws_manager = WebSocketManager()
