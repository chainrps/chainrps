"""
认证 API 端点

提供管理员登录、登出、当前用户信息、修改密码等接口。
"""
from typing import Optional

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel

from rps_backend.service.auth_service import (
    login as do_login,
    decode_token,
    get_admin_by_id,
    update_admin_password,
    list_admins,
)

router = APIRouter(prefix="/auth", tags=["auth"])


# 登录请求模型
class LoginRequest(BaseModel):
    username: str
    password: str


# 修改密码请求模型
class ChangePasswordRequest(BaseModel):
    old_password: str
    new_password: str


# 提取Token
def _extract_token(request: Request) -> Optional[str]:
    """从 Authorization 头提取 Bearer token"""
    auth = request.headers.get("Authorization", "")
    if auth.startswith("Bearer "):
        return auth[7:]
    return None


# 获取当前管理员
def get_current_admin(request: Request) -> dict:
    """
    FastAPI 依赖：校验 JWT 并返回当前管理员信息

    用法：admin_id: dict = Depends(get_current_admin)
    未登录或 token 无效时抛出 401。
    """
    token = _extract_token(request)
    if not token:
        raise HTTPException(status_code=401, detail="未登录，请先登录")

    payload = decode_token(token)
    if not payload:
        raise HTTPException(status_code=401, detail="登录已过期，请重新登录")

    admin_id = int(payload.get("sub", 0))
    admin = get_admin_by_id(admin_id)
    if not admin:
        raise HTTPException(status_code=401, detail="账户不存在或已被禁用")

    return {
        "id": admin["id"],
        "username": admin["username"],
        "role": admin.get("role", "admin"),
    }


# 管理员登录
@router.post("/login")
async def login(body: LoginRequest):
    """管理员登录，返回 JWT token"""
    result = do_login(body.username, body.password)
    if not result.get("success"):
        raise HTTPException(status_code=401, detail=result.get("message", "登录失败"))
    return result


# 获取当前管理员信息
@router.get("/me")
async def get_me(request: Request):
    """获取当前登录管理员信息"""
    admin = get_current_admin(request)
    return {"success": True, "admin": admin}


# 修改密码
@router.post("/change-password")
async def change_password(body: ChangePasswordRequest, request: Request):
    """修改当前管理员密码"""
    from rps_backend.service.auth_service import verify_password, get_admin_by_username
    admin = get_current_admin(request)
    full = get_admin_by_username(admin["username"])
    if not full or not verify_password(body.old_password, full["password_hash"]):
        raise HTTPException(status_code=400, detail="原密码错误")
    if len(body.new_password) < 1:
        raise HTTPException(status_code=400, detail="新密码至少 1 位")
    update_admin_password(admin["id"], body.new_password)
    return {"success": True, "message": "密码修改成功"}


# 获取管理员列表
@router.get("/admins")
async def get_admins(request: Request):
    """列出所有管理员（需要登录）"""
    get_current_admin(request)
    return {"success": True, "admins": list_admins()}