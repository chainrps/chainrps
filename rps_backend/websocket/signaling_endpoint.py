"""
WebSocket 信令端点（P2P 私密通信方案）

用于在房间内两个玩家之间交换 WebRTC 信令（SDP offer/answer、ICE candidate）。
后端仅作为信令中转，不转发任何游戏数据，确保私密通信不被平台窃听。

路由：/ws/signaling/{room_id}/{player_address}
"""
import asyncio
import json
from typing import Dict, Set

from fastapi import WebSocket, WebSocketDisconnect


# 房间信令连接管理：room_id -> {player_address_lower: WebSocket}
_signaling_connections: Dict[str, Dict[str, WebSocket]] = {}
# 锁，避免并发修改
_signaling_lock = asyncio.Lock()


async def signaling_endpoint(websocket: WebSocket, room_id: str, player_address: str):
    """
    WebSocket 信令端点

    流程：
    1. 玩家连接时注册到房间信令池
    2. 收到 offer/answer/candidate 消息时转发给房间内其他玩家
    3. 断开时从房间信令池移除

    消息格式：
    - {"type": "offer", "sdp": "..."}
    - {"type": "answer", "sdp": "..."}
    - {"type": "candidate", "candidate": "..."}
    - {"type": "bye", "reason": "..."}  主动离开
    """
    addr_lower = player_address.lower()
    await websocket.accept()

    async with _signaling_lock:
        if room_id not in _signaling_connections:
            _signaling_connections[room_id] = {}
        _signaling_connections[room_id][addr_lower] = websocket

    print(f"[Signaling] 玩家 {player_address} 加入房间 {room_id} 信令通道")

    # 通知房间内其他玩家有新对端加入（用于触发 offer 创建）
    async with _signaling_lock:
        peers = _signaling_connections.get(room_id, {})
        for peer_addr, peer_ws in list(peers.items()):
            if peer_addr == addr_lower:
                continue
            try:
                await peer_ws.send_json({
                    "type": "peer_joined",
                    "data": {"player": player_address}
                })
            except Exception:
                pass

    try:
        while True:
            data = await websocket.receive_json()
            msg_type = data.get("type")

            # 仅转发信令消息，不处理业务逻辑
            if msg_type in ("offer", "answer", "candidate", "bye"):
                target_payload = {
                    "type": msg_type,
                    "data": data,
                    "from": player_address,
                }
                async with _signaling_lock:
                    peers = _signaling_connections.get(room_id, {})
                    for peer_addr, peer_ws in list(peers.items()):
                        if peer_addr == addr_lower:
                            continue
                        try:
                            await peer_ws.send_json(target_payload)
                        except Exception:
                            pass
            elif msg_type == "ping":
                await websocket.send_json({"type": "pong", "data": {}})

    except WebSocketDisconnect:
        pass
    except Exception as e:
        print(f"[Signaling] 错误 ({player_address}): {e}")
    finally:
        async with _signaling_lock:
            peers = _signaling_connections.get(room_id, {})
            peers.pop(addr_lower, None)
            if not peers:
                _signaling_connections.pop(room_id, None)
            # 通知其他对端该玩家已离开
            for peer_addr, peer_ws in list(peers.items()):
                try:
                    await peer_ws.send_json({
                        "type": "peer_left",
                        "data": {"player": player_address}
                    })
                except Exception:
                    pass
        print(f"[Signaling] 玩家 {player_address} 离开房间 {room_id} 信令通道")
