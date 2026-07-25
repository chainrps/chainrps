"""
WebSocket 端点处理

提供 WebSocket 连接的入口处理函数，负责接收并分发客户端消息。
"""
from fastapi import WebSocket, WebSocketDisconnect

from rps_backend.websocket.manager import ws_manager


async def websocket_endpoint(websocket: WebSocket, player_address: str):
    """WebSocket 连接处理函数，循环接收消息并交由管理器处理"""
    # 建立连接
    await ws_manager.connect(websocket, player_address)

    try:
        while True:
            # 接收客户端消息
            data = await websocket.receive_json()
            await ws_manager.handle_message(player_address, data)

    except WebSocketDisconnect:
        # 客户端主动断开
        await ws_manager.disconnect(player_address)

    except Exception as e:
        # 其他异常：打印日志并断开连接
        print(f"WebSocket error ({player_address}): {e}")
        await ws_manager.disconnect(player_address)
