"""
ChainRPS 后端服务入口

负责创建 FastAPI 应用、注册路由、管理生命周期。
"""
import asyncio

from fastapi import FastAPI, WebSocket
from fastapi.middleware.cors import CORSMiddleware
from contextlib import asynccontextmanager

from rps_core.config import HOST, PORT, WS_HEARTBEAT_INTERVAL
from rps_core.api.routes import router
from rps_core.websocket import ws_manager, websocket_endpoint, heartbeat_loop
from rps_core.websocket.heartbeat import check_connections
from rps_core.repository import init_database
from rps_core.utils.redis_client import redis_client
from rps_core.service import contract_service


@asynccontextmanager
async def lifespan(app: FastAPI):
    """
    应用生命周期管理

    启动时初始化数据库、检查 Redis、启动心跳和合约事件监听。
    """
    # 初始化数据库
    init_database()

    # 检查 Redis 连接
    if not redis_client.is_connected():
        print("⚠️  Redis 未连接，匹配功能将不可用")
    else:
        print("✅ Redis 连接成功")

    # 启动 WebSocket 心跳任务
    heartbeat_task = asyncio.create_task(
        heartbeat_loop(ws_manager, WS_HEARTBEAT_INTERVAL)
    )

    # 启动连接检查任务
    cleanup_task = asyncio.create_task(cleanup_loop())

    # 启动合约事件监听
    contract_task = asyncio.create_task(contract_service.start_listening())

    print(f"🚀 ChainRPS 后端服务启动")
    print(f"📡 API: http://{HOST}:{PORT}")
    print(f"📡 API 文档: http://{HOST}:{PORT}/docs")
    print(f"🔌 WebSocket: ws://{HOST}:{PORT}/ws/{{player_address}}")

    yield

    # 关闭时清理
    heartbeat_task.cancel()
    cleanup_task.cancel()
    contract_task.cancel()
    await contract_service.stop_listening()
    print("👋 ChainRPS 后端服务关闭")


async def cleanup_loop():
    """定期清理断开的 WebSocket 连接"""
    while True:
        await asyncio.sleep(60)
        await check_connections(ws_manager)


# 创建 FastAPI 应用
app = FastAPI(
    title="ChainRPS Backend",
    description="链上公平猜拳后端服务",
    version="1.0.0",
    lifespan=lifespan
)

# CORS 配置
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# 注册 API 路由
app.include_router(router, prefix="/api")

# WebSocket 端点
@app.websocket("/ws/{player_address}")
async def ws_endpoint(websocket: WebSocket, player_address: str):
    """
    WebSocket 连接端点

    通过玩家地址建立 WebSocket 连接，用于实时推送对局状态。
    """
    await websocket_endpoint(websocket, player_address)


@app.get("/health")
async def health_check():
    """
    健康检查端点

    返回服务状态和 Redis 连接状态。
    """
    import time
    return {
        "status": "healthy",
        "redis": redis_client.is_connected(),
        "timestamp": int(time.time())
    }


@app.get("/")
async def root():
    """根路径，返回服务基本信息"""
    return {
        "name": "ChainRPS Backend",
        "version": "1.0.0",
        "docs": "/docs",
        "health": "/health"
    }


def main():
    """启动服务"""
    import uvicorn

    uvicorn.run(
        "rps_core.main:app",
        host=HOST,
        port=PORT,
        reload=True
    )


if __name__ == "__main__":
    main()
