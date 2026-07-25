"""
认证授权服务

提供管理员账户管理、密码哈希校验、JWT 令牌签发与验证。
默认超级管理员账号在数据库初始化时自动创建（admin / ADMIN）。
"""
import sqlite3
from datetime import datetime, timedelta, timezone
from typing import Optional, Dict, Any

import jwt
from passlib.context import CryptContext

from ..config import (
    JWT_SECRET,
    JWT_ALGORITHM,
    JWT_EXPIRE_HOURS,
    DEFAULT_ADMIN_USERNAME,
    DEFAULT_ADMIN_PASSWORD,
)
from ..repository.database import get_connection


# 密码哈希上下文（bcrypt）
_pwd_context = CryptContext(schemes=["bcrypt"], deprecated="auto")


# ==================== 密码工具 ====================

def hash_password(password: str) -> str:
    """对明文密码进行 bcrypt 哈希"""
    return _pwd_context.hash(password)


def verify_password(plain: str, hashed: str) -> bool:
    """校验明文密码与哈希是否匹配"""
    try:
        return _pwd_context.verify(plain, hashed)
    except Exception:
        return False


# ==================== JWT 工具 ====================

def create_token(admin: Dict[str, Any]) -> str:
    """为管理员签发 JWT 令牌"""
    now = datetime.now(timezone.utc)
    payload = {
        "sub": str(admin["id"]),
        "username": admin["username"],
        "role": admin.get("role", "admin"),
        "iat": int(now.timestamp()),
        "exp": int((now + timedelta(hours=JWT_EXPIRE_HOURS)).timestamp()),
    }
    return jwt.encode(payload, JWT_SECRET, algorithm=JWT_ALGORITHM)


def decode_token(token: str) -> Optional[Dict[str, Any]]:
    """解码并验证 JWT 令牌，失败返回 None"""
    try:
        return jwt.decode(token, JWT_SECRET, algorithms=[JWT_ALGORITHM])
    except Exception:
        return None


# ==================== 管理员账户 CRUD ====================

def get_admin_by_username(username: str) -> Optional[Dict[str, Any]]:
    """按用户名查询管理员"""
    conn = get_connection()
    try:
        conn.row_factory = sqlite3.Row
        row = conn.execute(
            "SELECT * FROM admins WHERE username = ? AND is_active = 1",
            (username,),
        ).fetchone()
        return dict(row) if row else None
    finally:
        conn.close()


def get_admin_by_id(admin_id: int) -> Optional[Dict[str, Any]]:
    """按 ID 查询管理员"""
    conn = get_connection()
    try:
        conn.row_factory = sqlite3.Row
        row = conn.execute(
            "SELECT * FROM admins WHERE id = ? AND is_active = 1",
            (admin_id,),
        ).fetchone()
        return dict(row) if row else None
    finally:
        conn.close()


def list_admins() -> list:
    """列出所有管理员"""
    conn = get_connection()
    try:
        conn.row_factory = sqlite3.Row
        rows = conn.execute(
            "SELECT id, username, role, is_active, created_at, last_login_at FROM admins ORDER BY id"
        ).fetchall()
        return [dict(r) for r in rows]
    finally:
        conn.close()


def create_admin(username: str, password: str, role: str = "admin") -> Dict[str, Any]:
    """创建新管理员"""
    conn = get_connection()
    try:
        now = datetime.now(timezone.utc).isoformat()
        conn.execute(
            "INSERT INTO admins (username, password_hash, role, is_active, created_at) VALUES (?, ?, ?, 1, ?)",
            (username, hash_password(password), role, now),
        )
        conn.commit()
        return {"success": True, "message": f"管理员 {username} 创建成功"}
    except sqlite3.IntegrityError:
        return {"success": False, "message": f"用户名 {username} 已存在"}
    finally:
        conn.close()


def update_admin_password(admin_id: int, new_password: str) -> Dict[str, Any]:
    """修改管理员密码"""
    conn = get_connection()
    try:
        conn.execute(
            "UPDATE admins SET password_hash = ? WHERE id = ?",
            (hash_password(new_password), admin_id),
        )
        conn.commit()
        return {"success": True, "message": "密码修改成功"}
    finally:
        conn.close()


def update_last_login(admin_id: int):
    """更新最后登录时间"""
    conn = get_connection()
    try:
        conn.execute(
            "UPDATE admins SET last_login_at = ? WHERE id = ?",
            (datetime.now(timezone.utc).isoformat(), admin_id),
        )
        conn.commit()
    finally:
        conn.close()


def init_default_admin():
    """
    初始化默认超级管理员（admin / ADMIN）

    - 账户不存在时自动创建
    - 账户存在但 password_hash 为空时（忘记密码重置场景），自动恢复为默认密码
    """
    existing = get_admin_by_username(DEFAULT_ADMIN_USERNAME)
    if existing:
        # 忘记密码重置：SQL 将 password_hash 清空后重启后端，自动恢复默认密码
        if not existing.get("password_hash"):
            conn = get_connection()
            try:
                conn.execute(
                    "UPDATE admins SET password_hash = ? WHERE id = ?",
                    (hash_password(DEFAULT_ADMIN_PASSWORD), existing["id"]),
                )
                conn.commit()
                print(f"✅ 管理员 {DEFAULT_ADMIN_USERNAME} 密码已重置为默认值")
            finally:
                conn.close()
        return
    create_admin(DEFAULT_ADMIN_USERNAME, DEFAULT_ADMIN_PASSWORD, role="superadmin")


# ==================== 登录 ====================

def login(username: str, password: str) -> Dict[str, Any]:
    """登录校验，成功返回 token 和管理员信息"""
    admin = get_admin_by_username(username)
    if not admin:
        return {"success": False, "message": "用户名或密码错误"}
    if not verify_password(password, admin["password_hash"]):
        return {"success": False, "message": "用户名或密码错误"}

    update_last_login(admin["id"])
    token = create_token(admin)
    return {
        "success": True,
        "message": "登录成功",
        "token": token,
        "admin": {
            "id": admin["id"],
            "username": admin["username"],
            "role": admin.get("role", "admin"),
        },
    }
