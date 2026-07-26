"""
WebSocket 心跳检测模块

提供心跳广播与连接状态检查功能，用于维持长连接可用性并清理失效连接。
"""
import asyncio

from starlette.websockets import WebSocketState

from rps_backend.models import WSMessage
from rps_backend.websocket.manager import WebSocketManager


# 心跳循环
async def heartbeat_loop(ws_manager: WebSocketManager, interval: int):
    """心跳循环，每隔 interval 秒向所有连接广播一次心跳消息"""
    while True:
        await asyncio.sleep(interval)
        # 广播心跳消息
        await ws_manager.broadcast(WSMessage(
            type="heartbeat",
            data={}
        ))


# 检查连接状态
async def check_connections(ws_manager: WebSocketManager):
    """检查所有连接的状态，清理已断开的连接"""
    # 收集已断开的玩家地址，避免遍历时修改字典
    disconnected = []
    for player_address, websocket in ws_manager.active_connections.items():
        # 通过客户端状态判断连接是否已关闭
        if websocket.client_state == WebSocketState.DISCONNECTED:
            disconnected.append(player_address)

    # 清理失效连接
    for player_address in disconnected:
        await ws_manager.disconnect(player_address)