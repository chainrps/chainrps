"""
API 端点模块

聚合游戏相关与用户相关的端点路由，供 routes.py 统一挂载。
"""
from rps_core.api.endpoints.game import router as game_router
from rps_core.api.endpoints.user import router as user_router

__all__ = ["game_router", "user_router"]
