"""
ChainRPS 后端服务入口
"""
import asyncio

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from contextlib import asynccontextmanager

from .config import HOST, PORT, WS_HEARTBEAT_INTERVAL
from .api.routes import router
from .websocket import ws_manager
from .database import init_database
from .redis_client import redis_client


@asynccontextmanager
async def lifespan(app: FastAPI):
    """应用生命周期管理"""
    # 启动时初始化
    init_database()

    # 检查 Redis 连接
    if not redis_client.is_connected():
        print("⚠️  Redis 未连接，匹配功能将不可用")
    else:
        print("✅ Redis 连接成功")

    # 启动心跳任务
    heartbeat_task = asyncio.create_task(heartbeat_loop())

    print(f"🚀 ChainRPS 后端服务启动")
    print(f"📡 API: http://{HOST}:{PORT}")
    print(f"🔌 WebSocket: ws://{HOST}:{PORT}/ws/{'{player_address}'}")

    yield

    # 关闭时清理
    heartbeat_task.cancel()
    print("👋 ChainRPS 后端服务关闭")


async def heartbeat_loop():
    """WebSocket 心跳循环"""
    while True:
        await asyncio.sleep(WS_HEARTBEAT_INTERVAL)
        await ws_manager.send_heartbeat()


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
    allow_origins=["*"],  # 生产环境应限制来源
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# 注册路由
app.include_router(router, prefix="/api")

# 健康检查
@app.get("/health")
async def health_check():
    """健康检查"""
    return {
        "status": "healthy",
        "redis": redis_client.is_connected(),
        "timestamp": int(asyncio.get_event_loop().time())
    }


# 根路径
@app.get("/")
async def root():
    """根路径"""
    return {
        "name": "ChainRPS Backend",
        "version": "1.0.0",
        "docs": "/docs"
    }


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(
        "app.main:app",
        host=HOST,
        port=PORT,
        reload=True
    )