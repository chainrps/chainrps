#!/usr/bin/env python3
"""
版本号自动递增脚本 —— ChainRPS 项目

单一真相（Single Source of Truth）：pyproject.toml 的 [project] version

用法:
    python scripts/bump_version.py              # 递增 patch 版本号 (1.0.0 → 1.0.1)
    python scripts/bump_version.py --major      # 递增 major 版本号 (1.0.0 → 2.0.0)
    python scripts/bump_version.py --minor      # 递增 minor 版本号 (1.0.0 → 1.1.0)
    python scripts/bump_version.py --set 2.5.0 # 直接设置指定版本

Git pre-push hook 会自动调用此脚本（patch 模式），然后 amend 最后一次 commit。
"""
import argparse
import json
import os
import re
import subprocess
import sys

# 需要同步版本号的文件列表（相对于项目根目录）
# 格式: (文件路径, 查找正则, 替换模板)
#   查找正则中必须有一个捕获组匹配 "1.2.3" 格式的版本号
TARGET_FILES = [
    # (路径, 正则, 说明)
    ("pyproject.toml", r'^version\s*=\s*"(\d+\.\d+\.\d+)"$', "Python 包版本"),
    ("package.json", r'^\s*"version"\s*:\s*"(\d+\.\d+\.\d+)"\s*,?\s*$', "NPM 包版本"),
    ("rps_backend/main.py", r'version="(\d+\.\d+\.\d+)"', "FastAPI 应用版本"),
    ("rps_frontend/static/html/index.html", r'ChainRPS v(\d+\.\d+\.\d+)', "前端页面标题版本"),
]


def get_project_root() -> str:
    """获取项目根目录（本脚本的上级目录）"""
    return os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def read_version_from_pyproject(project_root: str) -> str:
    """从 pyproject.toml 读取当前版本（单一真相）"""
    pyproject = os.path.join(project_root, "pyproject.toml")
    with open(pyproject, "r", encoding="utf-8") as f:
        for line in f:
            m = re.match(r'^\s*version\s*=\s*"(\d+\.\d+\.\d+)"', line)
            if m:
                return m.group(1)
    raise RuntimeError(f"未在 {pyproject} 中找到版本号")


def bump_version(current: str, bump_type: str) -> str:
    """根据类型递增版本号"""
    parts = list(map(int, current.split(".")))
    major, minor, patch = parts[0], parts[1], parts[2]

    if bump_type == "major":
        return f"{major + 1}.0.0"
    elif bump_type == "minor":
        return f"{major}.{minor + 1}.0"
    elif bump_type == "patch":
        return f"{major}.{minor}.{patch + 1}"
    else:
        raise ValueError(f"未知的版本类型: {bump_type}")


def update_file(project_root: str, rel_path: str, pattern: str, new_version: str) -> bool:
    """更新单个文件中的版本号，返回是否有修改"""
    filepath = os.path.join(project_root, rel_path)
    if not os.path.exists(filepath):
        print(f"  ⚠️  文件不存在，跳过: {rel_path}")
        return False

    # 用默认 newline 模式读取，自动处理 Windows CRLF → LF
    with open(filepath, "r", encoding="utf-8") as f:
        content = f.read()

    # 在正则的 $ 之前允许可选的 \r，兼容 CRLF 文件
    # 修改后的 pattern: 允许行尾有 \r
    cr_aware_pattern = pattern.replace('$', r'\r?$')

    # 用 re.MULTILINE 让 ^ $ 按行工作；re.DOTALL 不需要
    new_content, count = re.subn(
        cr_aware_pattern,
        lambda m: m.group(0).replace(m.group(1), new_version).rstrip('\r'),
        content,
        flags=re.MULTILINE,
    )

    if count == 0:
        # 宽松检查：文件里是否有版本号
        if re.search(r'\d+\.\d+\.\d+', content):
            print(f"  ⚠️  正则未匹配但文件含版本号，需检查: {rel_path}")
        return False

    if new_content == content:
        return False

    # 保留原始换行风格（检查最后一个换行符）
    with open(filepath, "w", encoding="utf-8", newline="") as f:
        f.write(new_content)

    print(f"  ✅ 更新: {rel_path}")
    return True


def git_amend(project_root: str, new_version: str) -> bool:
    """将版本号变更加入 index 并 amend 到最后一次 commit"""
    try:
        subprocess.run(["git", "add", "-A"], cwd=project_root, check=True, capture_output=True, text=True)
        # 只 amend 如果有变更
        status = subprocess.run(["git", "diff", "--cached", "--name-only"], cwd=project_root, capture_output=True, text=True)
        if not status.stdout.strip():
            print("  ℹ️  没有版本号变更，跳过 amend")
            return True

        subprocess.run(
            ["git", "commit", "--amend", "--no-edit"],
            cwd=project_root, check=True, capture_output=True, text=True
        )
        print(f"  📝 已 amend 到最近一次 commit")
        return True
    except subprocess.CalledProcessError as e:
        print(f"  ❌ git 操作失败: {e.stderr.strip() if e.stderr else e}")
        return False


def main():
    parser = argparse.ArgumentParser(description="ChainRPS 版本号递增工具")
    group = parser.add_mutually_exclusive_group()
    group.add_argument("--major", action="store_true", help="递增 major 版本 (1.0.0 → 2.0.0)")
    group.add_argument("--minor", action="store_true", help="递增 minor 版本 (1.0.0 → 1.1.0)")
    group.add_argument("--patch", action="store_true", help="递增 patch 版本 (默认, 1.0.0 → 1.0.1)")
    group.add_argument("--set", type=str, metavar="VERSION", help="直接设置为指定版本")
    parser.add_argument("--dry-run", action="store_true", help="仅显示要做什么，不实际修改")
    parser.add_argument("--no-amend", action="store_true", help="不执行 git commit --amend")
    args = parser.parse_args()

    project_root = get_project_root()

    # 1. 读取当前版本
    try:
        current = read_version_from_pyproject(project_root)
    except Exception as e:
        print(f"❌ 读取版本号失败: {e}")
        sys.exit(1)

    # 2. 计算新版本
    if args.set:
        new_version = args.set
        if not re.match(r'^\d+\.\d+\.\d+$', new_version):
            print(f"❌ 版本号格式无效: {new_version} (需要 X.Y.Z)")
            sys.exit(1)
    elif args.major:
        new_version = bump_version(current, "major")
    elif args.minor:
        new_version = bump_version(current, "minor")
    else:
        new_version = bump_version(current, "patch")

    print("=" * 50)
    print(f"🔢 ChainRPS 版本号更新")
    print("=" * 50)
    print(f"  {current}  →  {new_version}")
    print()

    if args.dry_run:
        print("  (dry-run 模式，不实际修改)")
        sys.exit(0)

    # 3. 更新所有目标文件
    changed_count = 0
    for rel_path, pattern, desc in TARGET_FILES:
        if update_file(project_root, rel_path, pattern, new_version):
            changed_count += 1

    if changed_count == 0:
        print("\nℹ️  没有任何文件被修改")
        sys.exit(0)

    print(f"\n✅ 共更新 {changed_count} 个文件")

    # 4. Git amend（如果在 git 仓库中且有变更）
    is_git = os.path.exists(os.path.join(project_root, ".git"))
    if is_git and not args.no_amend:
        print("\n📦 正在 amend 最近一次 commit...")
        ok = git_amend(project_root, new_version)
        if not ok:
            print("  ℹ️  你可以手动执行: git add -A && git commit --amend --no-edit")
    elif not is_git:
        print("\nℹ️  非 git 仓库，跳过 amend")
    elif args.no_amend:
        print("\nℹ️  --no-amend 已指定，跳过 amend")

    print()
    print("=" * 50)
    print(f"✅ 版本更新完成: {current} → {new_version}")
    print("=" * 50)


if __name__ == "__main__":
    main()
