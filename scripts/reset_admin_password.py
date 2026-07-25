#!/usr/bin/env python
"""
ChainRPS 管理员密码重置脚本

用途：忘记管理员密码时，将指定账户的密码重置为默认值（ADMIN）。
使用方法：
    # 重置默认 admin 账户
    .venv\\Scripts\\python.exe scripts\\reset_admin_password.py

    # 重置指定用户名
    .venv\\Scripts\\python.exe scripts\\reset_admin_password.py myuser

    # 指定新密码（不使用默认值）
    .venv\\Scripts\\python.exe scripts\\reset_admin_password.py admin MyNewPass123

执行后重启后端即可用新密码登录。
"""
import sys
import os

# 将项目根目录加入 path，确保能导入 backend
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from backend.repository.database import get_connection
from backend.service.auth_service import hash_password
from backend.config import DEFAULT_ADMIN_USERNAME, DEFAULT_ADMIN_PASSWORD


def reset_password(username: str, new_password: str):
    conn = get_connection()
    try:
        conn.row_factory = __import__("sqlite3").Row
        row = conn.execute(
            "SELECT id, username FROM admins WHERE username = ?", (username,)
        ).fetchone()

        if not row:
            print(f"❌ 用户名 '{username}' 不存在")
            print("当前已存在的管理员：")
            rows = conn.execute("SELECT id, username, role FROM admins").fetchall()
            for r in rows:
                print(f"  - {r['username']} (角色: {r['role']})")
            return False

        conn.execute(
            "UPDATE admins SET password_hash = ? WHERE id = ?",
            (hash_password(new_password), row["id"]),
        )
        conn.commit()
        print(f"✅ 管理员 '{username}' 的密码已重置成功")
        print(f"   新密码：{new_password}")
        print("   请重启后端服务后使用新密码登录。")
        return True
    finally:
        conn.close()


def main():
    # 解析命令行参数
    args = sys.argv[1:]
    username = args[0] if len(args) >= 1 else DEFAULT_ADMIN_USERNAME
    new_password = args[1] if len(args) >= 2 else DEFAULT_ADMIN_PASSWORD

    print("=" * 50)
    print("  ChainRPS 管理员密码重置工具")
    print("=" * 50)
    print(f"  目标用户：{username}")
    print(f"  新密码  ：{new_password}")
    print("-" * 50)

    # 二次确认
    if not args:
        confirm = input("确认重置？(y/N): ").strip().lower()
        if confirm != "y":
            print("已取消")
            return

    reset_password(username, new_password)


if __name__ == "__main__":
    main()
