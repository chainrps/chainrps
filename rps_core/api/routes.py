"""
API 路由聚合

汇总所有端点路由（游戏、用户），由 main.py 通过
app.include_router(router, prefix="/api") 挂载到 /api 前缀下，
形成 /api/game/... 与 /api/history、/api/player/... 的完整路径。
"""
from fastapi import APIRouter

from rps_core.api.endpoints.game import router as game_router
from rps_core.api.endpoints.user import router as user_router

router = APIRouter()
router.include_router(game_router)
router.include_router(user_router)
