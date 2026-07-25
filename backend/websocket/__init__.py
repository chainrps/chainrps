"""
WebSocket 模块

提供 WebSocket 连接管理、心跳检测和端点处理功能。
"""
from backend.websocket.manager import ws_manager, WebSocketManager
from backend.websocket.endpoint import websocket_endpoint
from backend.websocket.heartbeat import heartbeat_loop, check_connections

__all__ = [
    "ws_manager",
    "WebSocketManager",
    "websocket_endpoint",
    "heartbeat_loop",
    "check_connections",
]
