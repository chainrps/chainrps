"""
API 路由聚合

汇总所有端点路由（游戏、用户、管理员、认证、扩展预留），由 main.py 通过
app.include_router(router, prefix="/api") 挂载到 /api 前缀下，
形成 /api/game/...、/api/history、/api/player/...、/api/admin/...、/api/auth/...、/api/ext/... 的完整路径。
"""
from fastapi import APIRouter

from backend.api.endpoints.game import router as game_router
from backend.api.endpoints.user import router as user_router
from backend.api.endpoints.extension import router as extension_router
from backend.api.endpoints.admin import router as admin_router
from backend.api.endpoints.auth import router as auth_router

router = APIRouter()
router.include_router(game_router)
router.include_router(user_router)
router.include_router(admin_router)
router.include_router(auth_router)
router.include_router(extension_router)
