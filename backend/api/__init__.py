"""
API 模块

提供 ChainRPS 后端的 RESTful API 路由定义。
通过 routes.router 聚合所有端点路由，供 main.py 挂载使用。
"""
from backend.api.routes import router

__all__ = ["router"]
