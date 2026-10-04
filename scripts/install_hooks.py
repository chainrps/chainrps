#!/usr/bin/env python3
"""
安装 ChainRPS Git hooks —— 每次 git push 前自动递增 patch 版本号

安装后，每次 push 时会：
  1. 运行 scripts/bump_version.py（默认 patch 递增）
  2. amend 最后一次 commit（把版本号变更合入）
  3. 继续执行 push（push 的是 amend 后的 commit）

安装:  python scripts/install_hooks.py
卸载:  rm .git/hooks/pre-push
"""
import os
import stat
import sys


PRE_PUSH_HOOK = r'''#!/usr/bin/env bash
# ChainRPS pre-push hook: 自动递增 patch 版本号
# 由 scripts/install_hooks.py 自动安装

set -e

PROJECT_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
BUMP_SCRIPT="$PROJECT_ROOT/scripts/bump_version.py"

if [ -f "$BUMP_SCRIPT" ]; then
    echo ""
    echo "🔢 ChainRPS pre-push hook: 自动递增版本号"
    python "$BUMP_SCRIPT" --patch
    echo ""
fi

# 正常退出，让 push 继续
exit 0
'''


def get_project_root() -> str:
    return os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def main():
    project_root = get_project_root()
    hooks_dir = os.path.join(project_root, ".git", "hooks")

    if not os.path.isdir(hooks_dir):
        print(f"❌ 找不到 .git/hooks 目录: {hooks_dir}")
        print("   请在 Git 仓库根目录下运行")
        sys.exit(1)

    hook_path = os.path.join(hooks_dir, "pre-push")

    # 检查是否已有 hook
    existing = None
    if os.path.exists(hook_path):
        with open(hook_path, "r", encoding="utf-8") as f:
            existing = f.read()

    if existing and "ChainRPS pre-push hook" in existing:
        print("✅ ChainRPS pre-push hook 已安装，跳过")
    elif existing and existing.strip():
        # 已有非 ChainRPS 的 hook，追加调用
        print("⚠️  发现已有的 pre-push hook，将追加调用...")
        with open(hook_path, "a", encoding="utf-8") as f:
            f.write("\n# === ChainRPS auto bump ===\n")
            f.write(PRE_PUSH_HOOK)
        print("✅ 已追加到现有 hook")
    else:
        # 直接写入
        with open(hook_path, "w", encoding="utf-8") as f:
            f.write(PRE_PUSH_HOOK)
        # 设置可执行权限（Unix/macOS）
        try:
            os.chmod(hook_path, stat.S_IRWXU | stat.S_IRGRP | stat.S_IXGRP | stat.S_IROTH | stat.S_IXOTH)
        except Exception:
            pass  # Windows 不需要

        print("✅ pre-push hook 已安装")

    print(f"   路径: {hook_path}")
    print()
    print("💡 以后每次 git push 会自动递增 patch 版本号")
    print("💡 手动触发: python scripts/bump_version.py --patch")
    print("💡 卸载:     直接删除 .git/hooks/pre-push")


if __name__ == "__main__":
    main()
