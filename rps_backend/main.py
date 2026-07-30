"""
ChainRPS 后端服务入口

负责创建 FastAPI 应用、注册路由、管理生命周期。
"""
import asyncio
import os

from fastapi import FastAPI, WebSocket, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse, RedirectResponse, JSONResponse
from contextlib import asynccontextmanager

from rps_backend.config import HOST, PORT, WS_HEARTBEAT_INTERVAL, RPC_CHAIN_ID
from rps_backend.api.routes import router
from rps_backend.websocket import ws_manager, websocket_endpoint, heartbeat_loop
from rps_backend.websocket.heartbeat import check_connections
from rps_backend.websocket.signaling_endpoint import signaling_endpoint
from rps_backend.repository import init_database
from rps_backend.utils.redis_client import redis_client
from rps_backend.service import contract_service
from rps_backend.service.local_chain_service import get_local_chain_service


# 应用生命周期管理
@asynccontextmanager
async def lifespan(app: FastAPI):
    """
    应用生命周期管理

    启动时初始化数据库、检查 Redis、启动心跳、合约事件监听和本地链保活。
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

    # 启动 WebSocket Pub/Sub 监听器（用于跨进程广播）
    await ws_manager._start_pubsub_listener()
    # 启动 WebSocket 点对点路由监听器（用于跨进程点对点消息）
    await ws_manager._start_direct_pubsub_listener()

    # 启动 Relayer 健康检测 + Stuck 交易监控（F1-05 / P1-02）
    try:
        from rps_backend.service.relayer_service import relayer_service
        await relayer_service.start_health_check_loop()
        await relayer_service.start_stuck_tx_monitor()
    except Exception as e:
        print(f"⚠️  Relayer 监控任务启动失败（不影响主服务）: {e}")

    # 初始化本地链服务并启用保活
    try:
        print("🔄 初始化本地链服务...")
        chain_svc = get_local_chain_service()
        chain_svc.set_keep_alive(
            True,
            deterministic=True,
            chain_id=RPC_CHAIN_ID,
            persist=True,
        )
        status = chain_svc.get_node_status()
        if status.get("running"):
            print(f"✅ 本地链服务已就绪 (Chain ID: {status.get('chain_id')})")
        else:
            print("ℹ️  本地链节点未运行，保活机制已启动（将自动尝试连接）")
    except Exception as e:
        print(f"⚠️  本地链服务初始化失败: {e}")

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
    
    # 停止本地链保活
    try:
        chain_svc = get_local_chain_service()
        chain_svc.set_keep_alive(False)
        print("🛑 本地链保活已停止")
    except Exception:
        pass
    
    print("👋 ChainRPS 后端服务关闭")


# 定期清理断开的连接
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


# HTTP 异常处理
@app.exception_handler(HTTPException)
async def http_exception_handler(request, exc):
    if exc.status_code == 404:
        return RedirectResponse(url="/")
    return JSONResponse(
        status_code=exc.status_code,
        content={"detail": exc.detail},
    )


# 注册 API 路由
app.include_router(router, prefix="/api")

# 静态文件服务
STATIC_DIR = os.path.join(os.path.dirname(os.path.dirname(__file__)), "rps_frontend", "static")

# 挂载静态文件到根路径，使相对路径能正确解析
app.mount("/css", StaticFiles(directory=os.path.join(STATIC_DIR, "css")), name="css")
app.mount("/js", StaticFiles(directory=os.path.join(STATIC_DIR, "js")), name="js")
app.mount("/img", StaticFiles(directory=os.path.join(STATIC_DIR, "img")), name="img")
app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")

# WebSocket 端点
@app.websocket("/ws/{player_address}")
async def ws_endpoint(websocket: WebSocket, player_address: str):
    """
    WebSocket 连接端点

    通过玩家地址建立 WebSocket 连接，用于实时推送对局状态。
    """
    await websocket_endpoint(websocket, player_address)


# WebSocket 信令端点（P2P 私密通信方案）
@app.websocket("/ws/signaling/{room_id}/{player_address}")
async def ws_signaling_endpoint(websocket: WebSocket, room_id: str, player_address: str):
    """
    WebSocket 信令端点

    用于房间内两个玩家之间交换 WebRTC 信令（SDP/ICE）。
    后端仅作信令中转，不转发游戏数据。
    """
    await signaling_endpoint(websocket, room_id, player_address)


# 健康检查
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


# favicon.ico
@app.get("/favicon.ico")
async def favicon():
    """返回网站图标"""
    favicon_path = os.path.join(STATIC_DIR, "favicon.ico")
    if os.path.exists(favicon_path):
        return FileResponse(favicon_path)
    return RedirectResponse(url="/")


# 根路径
@app.get("/")
async def root():
    """根路径，返回前端页面"""
    index_path = os.path.join(STATIC_DIR, "html", "index.html")
    return FileResponse(index_path)


# 管理员面板
@app.get("/admin")
async def admin_page():
    """管理员面板页面"""
    admin_path = os.path.join(STATIC_DIR, "html", "admin.html")
    return FileResponse(admin_path)


# 使用文档（公共页面，无需登录）
@app.get("/guide")
async def guide_page():
    """使用文档与演示页面（公共，无需登录）"""
    guide_path = os.path.join(STATIC_DIR, "html", "guide.html")
    return FileResponse(guide_path)


# 链上查询（公共页面，无需登录）
@app.get("/explorer")
async def explorer_page():
    """链上查询独立公开页面（公共，无需登录）"""
    explorer_path = os.path.join(STATIC_DIR, "html", "explorer.html")
    return FileResponse(explorer_path)


# 阶段演示（公共页面，无需登录）
@app.get("/demo")
async def demo_page():
    """阶段演示独立公开页面（公共，无需登录）"""
    demo_path = os.path.join(STATIC_DIR, "html", "demo.html")
    return FileResponse(demo_path)


# 静态 HTML 页面
@app.get("/html/{filename}")
async def html_pages(filename: str):
    """静态 HTML 页面路由"""
    safe_name = filename.replace("..", "")
    page_path = os.path.join(STATIC_DIR, "html", safe_name)
    if os.path.exists(page_path):
        return FileResponse(page_path)
    return RedirectResponse(url="/")


# 捕获所有未匹配的路由
@app.get("/{full_path:path}")
async def catch_all(full_path: str):
    """捕获所有未匹配的路由，重定向到首页"""
    return RedirectResponse(url="/")


# 启动服务
def main():
    """启动服务"""
    import uvicorn
    import webbrowser
    import threading
    import time
    import urllib.request
    import urllib.error

    def open_browser():
        """等待服务器就绪后打开浏览器"""
        if HOST == "localhost" or HOST == "127.0.0.1" or HOST == "0.0.0.0":
            url = f"http://127.0.0.1:{PORT}/"
        else:
            url = f"http://{HOST}:{PORT}/"
        
        max_wait = 15  # 最大等待时间（秒）
        wait_interval = 0.5  # 检查间隔（秒）
        elapsed = 0
        
        print(f"Waiting for server to start at {url}...")
        
        # 等待服务启动
        while elapsed < max_wait:
            try:
                # 尝试连接服务器
                with urllib.request.urlopen(url, timeout=2):
                    print(f"Server is ready! Opening browser at {url}")
                    webbrowser.open(url)
                    return
            except urllib.error.URLError:
                # 服务器还没就绪，继续等待
                time.sleep(wait_interval)
                elapsed += wait_interval
            except Exception as e:
                time.sleep(wait_interval)
                elapsed += wait_interval
        
        # 超时处理
        print(f"Server did not start within {max_wait} seconds. Opening browser anyway...")
        webbrowser.open(url)

    # 在启动服务器前启动浏览器线程
    threading.Thread(target=open_browser, daemon=True).start()

    uvicorn.run(
        "rps_backend.main:app",
        host=HOST,
        port=PORT,
        reload=False
    )


if __name__ == "__main__":
    main()