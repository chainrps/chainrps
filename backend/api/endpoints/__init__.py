"""
API 端点模块

聚合游戏相关、用户相关、管理员与扩展预留的端点路由，供 routes.py 统一挂载。
"""
from backend.api.endpoints.game import router as game_router
from backend.api.endpoints.user import router as user_router
from backend.api.endpoints.extension import router as extension_router
from backend.api.endpoints.admin import router as admin_router
from backend.api.endpoints.auth import router as auth_router

__all__ = ["game_router", "user_router", "extension_router", "admin_router", "auth_router"]
