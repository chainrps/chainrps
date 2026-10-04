# -*- coding: utf-8 -*-
#!/usr/bin/env python
"""
ChainRPS 开发环境初始化脚本

全项目依赖检测与环境搭建工具，支持两种模式：
  模式1 - 智能安装（默认）: 已存在则跳过，不存在则安装
  模式2 - 强制重装: 不管是否存在都强制安装所有依赖与服务

支持检测与安装的依赖：
  - Python 虚拟环境及项目依赖 (pyproject.toml)
  - Node.js 依赖 (package.json)
  - Redis 服务
  - Ganache 本地测试链
  - Hardhat 智能合约开发环境
  - Foundry (remappings.txt) 编译依赖

使用方法：
    python scripts/init_env.py          # 交互菜单选择
    python scripts/init_env.py --mode 1  # 智能安装
    python scripts/init_env.py --mode 2  # 强制重装
    python scripts/init_env.py --check   # 仅检测环境，不安装
"""
import os
import sys
import json
import time
import shutil
import platform
import subprocess
import argparse
import datetime
from pathlib import Path
from typing import Dict, List, Optional, Tuple


# ============================================================
# 路径配置
# ============================================================
PROJECT_ROOT = Path(__file__).resolve().parent.parent
SCRIPTS_DIR = PROJECT_ROOT / "scripts"
PYPROJECT_PATH = PROJECT_ROOT / "pyproject.toml"
PACKAGE_JSON_PATH = PROJECT_ROOT / "package.json"
REMAPPINGS_PATH = PROJECT_ROOT / "remappings.txt"
FOUNDRY_TOML_PATH = PROJECT_ROOT / "foundry.toml"
ENV_EXAMPLE_PATH = PROJECT_ROOT / ".env.example"
VENV_DIR = PROJECT_ROOT / ".venv"
DATA_DIR = PROJECT_ROOT / "data"
FRONTEND_DIR = PROJECT_ROOT / "rps_frontend"
CONTRACTS_DIR = PROJECT_ROOT / "contracts"
NODE_MODULES_DIR = PROJECT_ROOT / "node_modules"


# ============================================================
# 日志与输出工具
# ============================================================
class Logger:
    """彩色日志输出器"""
    COLORS = {
        "RED": "\033[91m",
        "GREEN": "\033[92m",
        "YELLOW": "\033[93m",
        "BLUE": "\033[94m",
        "MAGENTA": "\033[95m",
        "CYAN": "\033[96m",
        "WHITE": "\033[97m",
        "RESET": "\033[0m",
        "BOLD": "\033[1m",
    }

    def __init__(self):
        self.use_color = sys.stdout.isatty()

    def _c(self, color: str) -> str:
        if self.use_color:
            return self.COLORS.get(color, "")
        return ""

    def info(self, msg: str):
        print(f"{self._c('BLUE')}[INFO]{self._c('RESET')} {msg}")

    def success(self, msg: str):
        print(f"{self._c('GREEN')}[OK]{self._c('RESET')} {msg}")

    def warn(self, msg: str):
        print(f"{self._c('YELLOW')}[WARN]{self._c('RESET')} {msg}")

    def error(self, msg: str):
        print(f"{self._c('RED')}[ERR]{self._c('RESET')} {msg}")

    def step(self, msg: str):
        print(f"{self._c('CYAN')}[STEP]{self._c('RESET')} {msg}")

    def banner(self, text: str):
        width = 64
        print()
        print(f"{self._c('BOLD')}{self._c('MAGENTA')}{'=' * width}{self._c('RESET')}")
        print(f"{self._c('BOLD')}{self._c('MAGENTA')}{text:^{width}}{self._c('RESET')}")
        print(f"{self._c('BOLD')}{self._c('MAGENTA')}{'=' * width}{self._c('RESET')}")
        print()


log = Logger()


# ============================================================
# 进度条
# ============================================================
class ProgressBar:
    """终端进度条"""

    def __init__(self, total: int, prefix: str = "Progress", bar_length: int = 40):
        self.total = total
        self.current = 0
        self.prefix = prefix
        self.bar_length = bar_length
        self.start_time = time.time()

    def update(self, current: int, suffix: str = ""):
        self.current = min(current, self.total)
        pct = self.current / self.total if self.total > 0 else 0
        filled = int(self.bar_length * pct)
        bar = "█" * filled + "░" * (self.bar_length - filled)
        elapsed = time.time() - self.start_time
        if elapsed > 0 and self.current > 0:
            eta = (elapsed / self.current) * (self.total - self.current)
            eta_str = f" | ETA: {eta:.0f}s"
        else:
            eta_str = ""
        sys.stdout.write(
            f"\r{self.prefix}: [{bar}] {pct * 100:.1f}% ({self.current}/{self.total}){eta_str} {suffix}"
        )
        sys.stdout.flush()
        if self.current >= self.total:
            sys.stdout.write("\n")
            sys.stdout.flush()

    def done(self):
        self.update(self.total, "完成")
        print()

    def skip(self, msg: str = "跳过"):
        self.update(self.total, msg)


# ============================================================
# 依赖检测结果
# ============================================================
class DependencyStatus:
    """依赖状态枚举"""
    OK = "ok"
    MISSING = "missing"
    OUTDATED = "outdated"
    ERROR = "error"


class DependencyInfo:
    """单个依赖的检测信息"""
    def __init__(self, name: str, category: str, status: str,
                 version: str = "", details: str = ""):
        self.name = name
        self.category = category
        self.status = status
        self.version = version
        self.details = details

    def to_dict(self) -> dict:
        return {
            "name": self.name,
            "category": self.category,
            "status": self.status,
            "version": self.version,
            "details": self.details,
        }


# ============================================================
# 环境检测器
# ============================================================
class EnvironmentDetector:
    """全项目环境依赖检测器"""

    def __init__(self):
        self.results: List[DependencyInfo] = []
        self.os_info = self._get_os_info()

    def _get_os_info(self) -> dict:
        return {
            "system": platform.system(),
            "release": platform.release(),
            "version": platform.version(),
            "machine": platform.machine(),
            "python": platform.python_version(),
            "python_implementation": platform.python_implementation(),
        }

    def detect_all(self) -> List[DependencyInfo]:
        """执行全项目依赖检测"""
        self.results = []
        log.step("开始全项目依赖检测...")
        log.info(f"操作系统: {self.os_info['system']} {self.os_info['release']}")
        log.info(f"Python版本: {self.os_info['python']} ({self.os_info['python_implementation']})")

        self._detect_python()
        self._detect_python_deps()
        self._detect_nodejs()
        self._detect_npm_deps()
        self._detect_redis()
        self._detect_ganache()
        self._detect_hardhat()
        self._detect_foundry()
        self._detect_config_files()
        self._detect_data_dirs()

        return self.results

    def _detect_python(self):
        """检测 Python 环境"""
        try:
            result = subprocess.run(
                [sys.executable, "--version"],
                capture_output=True, text=True, timeout=10
            )
            version = result.stdout.strip() or result.stderr.strip()
            self.results.append(DependencyInfo(
                "Python", "runtime", DependencyStatus.OK,
                version=version, details="Python 运行环境"
            ))
        except Exception as e:
            self.results.append(DependencyInfo(
                "Python", "runtime", DependencyStatus.ERROR,
                details=f"检测失败: {e}"
            ))

        if VENV_DIR.exists():
            self.results.append(DependencyInfo(
                ".venv", "python-env", DependencyStatus.OK,
                version=str(VENV_DIR), details="Python 虚拟环境已存在"
            ))
        else:
            self.results.append(DependencyInfo(
                ".venv", "python-env", DependencyStatus.MISSING,
                details="虚拟环境不存在"
            ))

        if PYPROJECT_PATH.exists():
            version = self._get_pyproject_version()
            self.results.append(DependencyInfo(
                "pyproject.toml", "config", DependencyStatus.OK,
                version=version, details="项目配置文件存在"
            ))
        else:
            self.results.append(DependencyInfo(
                "pyproject.toml", "config", DependencyStatus.MISSING,
                details="项目配置文件不存在"
            ))

    def _get_pyproject_version(self) -> str:
        try:
            content = PYPROJECT_PATH.read_text(encoding="utf-8")
            for line in content.split("\n"):
                if line.startswith("version"):
                    return line.split("=")[1].strip().strip('"').strip("'")
        except Exception:
            pass
        return "未知"

    def _detect_python_deps(self):
        """检测 Python 依赖包安装情况"""
        if not VENV_DIR.exists():
            self.results.append(DependencyInfo(
                "Python依赖包", "python-deps", DependencyStatus.MISSING,
                details="虚拟环境不存在，无法检测"
            ))
            return

        key_packages = [
            "fastapi", "uvicorn", "redis", "web3", "eth_account",
            "pydantic", "dotenv", "jwt", "passlib", "bcrypt"
        ]
        missing = []
        ok_list = []

        for pkg in key_packages:
            if self._check_pip_package(pkg):
                ok_list.append(pkg)
            else:
                missing.append(pkg)

        if not missing:
            self.results.append(DependencyInfo(
                "Python依赖包", "python-deps", DependencyStatus.OK,
                version=f"{len(ok_list)} 个包",
                details=f"所有关键依赖已安装: {', '.join(ok_list[:5])}..."
            ))
        else:
            self.results.append(DependencyInfo(
                "Python依赖包", "python-deps", DependencyStatus.MISSING,
                version=f"已安装 {len(ok_list)}/{len(key_packages)}",
                details=f"缺失: {', '.join(missing)}"
            ))

    def _check_pip_package(self, package: str) -> bool:
        """检查 pip 包是否已安装"""
        try:
            result = subprocess.run(
                [sys.executable, "-c", f"import {package}"],
                capture_output=True, text=True, timeout=5
            )
            return result.returncode == 0
        except Exception:
            return False

    def _detect_nodejs(self):
        """检测 Node.js 环境"""
        node_exists = self._check_command("node", "--version")
        npm_exists = self._check_command("npm", "--version")

        if node_exists:
            node_ver = self._get_version("node", "--version")
            self.results.append(DependencyInfo(
                "Node.js", "runtime", DependencyStatus.OK,
                version=node_ver, details="Node.js 运行环境"
            ))
        else:
            self.results.append(DependencyInfo(
                "Node.js", "runtime", DependencyStatus.MISSING,
                details="未检测到 Node.js，请先安装 Node.js >= 18"
            ))

        if npm_exists:
            npm_ver = self._get_version("npm", "--version")
            self.results.append(DependencyInfo(
                "npm", "runtime", DependencyStatus.OK,
                version=npm_ver, details="npm 包管理器"
            ))
        else:
            self.results.append(DependencyInfo(
                "npm", "runtime", DependencyStatus.MISSING,
                details="未检测到 npm"
            ))

    def _detect_npm_deps(self):
        """检测 npm 依赖安装情况"""
        if PACKAGE_JSON_PATH.exists():
            if NODE_MODULES_DIR.exists():
                self.results.append(DependencyInfo(
                    "npm依赖", "npm-deps", DependencyStatus.OK,
                    version=str(NODE_MODULES_DIR),
                    details="node_modules 已存在"
                ))
            else:
                self.results.append(DependencyInfo(
                    "npm依赖", "npm-deps", DependencyStatus.MISSING,
                    details="node_modules 不存在，需要 npm install"
                ))
        else:
            self.results.append(DependencyInfo(
                "npm依赖", "npm-deps", DependencyStatus.OK,
                details="项目无 package.json，跳过"
            ))

    def _detect_redis(self):
        """检测 Redis 服务"""
        redis_cmd = self._check_command("redis-server", "--version")
        redis_port = self._check_port_listening(6379)

        if redis_cmd:
            redis_ver = self._get_version("redis-server", "--version")
            self.results.append(DependencyInfo(
                "Redis", "service",
                DependencyStatus.OK if redis_port else DependencyStatus.MISSING,
                version=redis_ver,
                details="Redis 已安装" + ("，服务运行中" if redis_port else "，服务未启动")
            ))
        else:
            self.results.append(DependencyInfo(
                "Redis", "service", DependencyStatus.MISSING,
                details="未检测到 Redis，请安装 Redis 服务"
            ))

    def _detect_ganache(self):
        """检测 Ganache"""
        ganache_cmd = self._check_command("ganache", "--version")
        ganache_port = self._check_port_listening(8686)

        if ganache_cmd:
            self.results.append(DependencyInfo(
                "Ganache", "service",
                DependencyStatus.OK if ganache_port else DependencyStatus.MISSING,
                details="Ganache 已安装" + ("，运行中" if ganache_port else "，未启动")
            ))
        else:
            ganache_global = self._check_command("ganache-cli", "--version")
            if ganache_global:
                self.results.append(DependencyInfo(
                    "Ganache", "service",
                    DependencyStatus.OK if ganache_port else DependencyStatus.MISSING,
                    details="Ganache (ganache-cli) 已安装" + ("，运行中" if ganache_port else "，未启动")
                ))
            else:
                local_ganache = NODE_MODULES_DIR / ".bin" / "ganache"
                if local_ganache.exists():
                    self.results.append(DependencyInfo(
                        "Ganache", "service",
                        DependencyStatus.OK if ganache_port else DependencyStatus.MISSING,
                        details="Ganache 已安装在本地" + ("，运行中" if ganache_port else "，未启动")
                    ))
                else:
                    self.results.append(DependencyInfo(
                        "Ganache", "service", DependencyStatus.MISSING,
                        details="未检测到 Ganache，需要通过 npm 安装"
                    ))

    def _detect_hardhat(self):
        """检测 Hardhat"""
        hardhat_cmd = self._check_command("hardhat", "--version")
        if hardhat_cmd:
            hh_ver = self._get_version("hardhat", "--version")
            self.results.append(DependencyInfo(
                "Hardhat", "smart-contract", DependencyStatus.OK,
                version=hh_ver, details="Hardhat 智能合约开发框架"
            ))
        else:
            local_hardhat = NODE_MODULES_DIR / ".bin" / "hardhat"
            if local_hardhat.exists():
                self.results.append(DependencyInfo(
                    "Hardhat", "smart-contract", DependencyStatus.OK,
                    details="Hardhat 已安装在本地 node_modules"
                ))
            else:
                self.results.append(DependencyInfo(
                    "Hardhat", "smart-contract", DependencyStatus.MISSING,
                    details="未检测到 Hardhat"
                ))

    def _detect_foundry(self):
        """检测 Foundry"""
        foundry_cmd = self._check_command("foundryup", "--version")
        forge_cmd = self._check_command("forge", "--version")

        if foundry_cmd or forge_cmd:
            self.results.append(DependencyInfo(
                "Foundry", "smart-contract", DependencyStatus.OK,
                details="Foundry 已安装" + ("/forge" if forge_cmd else "")
            ))
        else:
            if FOUNDRY_TOML_PATH.exists() or REMAPPINGS_PATH.exists():
                self.results.append(DependencyInfo(
                    "Foundry", "smart-contract", DependencyStatus.MISSING,
                    details="项目使用 Foundry，但未检测到 foundryup/forge"
                ))
            else:
                self.results.append(DependencyInfo(
                    "Foundry", "smart-contract", DependencyStatus.OK,
                    details="项目无 Foundry 配置，跳过"
                ))

        if REMAPPINGS_PATH.exists():
            content = REMAPPINGS_PATH.read_text(encoding="utf-8").strip()
            if content:
                self.results.append(DependencyInfo(
                    "remappings.txt", "config", DependencyStatus.OK,
                    details=f"Foundry 映射配置存在: {content[:60]}..."
                ))
            else:
                self.results.append(DependencyInfo(
                    "remappings.txt", "config", DependencyStatus.MISSING,
                    details="remappings.txt 存在但为空"
                ))

    def _detect_config_files(self):
        """检测项目配置文件"""
        env_path = PROJECT_ROOT / ".env"
        if env_path.exists():
            self.results.append(DependencyInfo(
                ".env", "config", DependencyStatus.OK,
                details=".env 配置文件存在"
            ))
        elif ENV_EXAMPLE_PATH.exists():
            self.results.append(DependencyInfo(
                ".env", "config", DependencyStatus.MISSING,
                details=".env 不存在，但 .env.example 存在，需复制配置"
            ))
        else:
            self.results.append(DependencyInfo(
                ".env", "config", DependencyStatus.MISSING,
                details=".env 和 .env.example 都不存在"
            ))

        if FOUNDRY_TOML_PATH.exists():
            self.results.append(DependencyInfo(
                "foundry.toml", "config", DependencyStatus.OK,
                details="Foundry 配置文件存在"
            ))
        else:
            self.results.append(DependencyInfo(
                "foundry.toml", "config", DependencyStatus.MISSING,
                details="Foundry 配置文件不存在"
            ))

    def _detect_data_dirs(self):
        """检测数据目录"""
        if DATA_DIR.exists():
            db_file = DATA_DIR / "rps.db"
            if db_file.exists():
                self.results.append(DependencyInfo(
                    "data/rps.db", "data", DependencyStatus.OK,
                    details="SQLite 数据库已存在"
                ))
            else:
                self.results.append(DependencyInfo(
                    "data/rps.db", "data", DependencyStatus.MISSING,
                    details="数据库不存在，首次运行将自动创建"
                ))
        else:
            self.results.append(DependencyInfo(
                "data/", "data", DependencyStatus.MISSING,
                details="数据目录不存在"
            ))

        if FRONTEND_DIR.exists():
            self.results.append(DependencyInfo(
                "rps_frontend/", "frontend", DependencyStatus.OK,
                details="前端目录存在"
            ))
        else:
            self.results.append(DependencyInfo(
                "rps_frontend/", "frontend", DependencyStatus.MISSING,
                details="前端目录不存在"
            ))

    def _check_command(self, cmd: str, arg: str = "--version") -> bool:
        """检查命令是否可用"""
        try:
            subprocess.run(
                [cmd, arg],
                capture_output=True, text=True, timeout=5
            )
            return True
        except (FileNotFoundError, subprocess.TimeoutExpired):
            return False
        except Exception:
            return False

    def _get_version(self, cmd: str, arg: str = "--version") -> str:
        """获取命令版本"""
        try:
            result = subprocess.run(
                [cmd, arg],
                capture_output=True, text=True, timeout=5
            )
            output = (result.stdout or result.stderr).strip()
            return output.split("\n")[0][:80]
        except Exception:
            return "未知"

    def _check_port_listening(self, port: int) -> bool:
        """检查端口是否正在监听"""
        try:
            system = platform.system()
            if system == "Windows":
                result = subprocess.run(
                    ["netstat", "-ano"],
                    capture_output=True, text=True, timeout=10
                )
                return f":{port}" in (result.stdout or "")
            else:
                result = subprocess.run(
                    ["lsof", "-i", f":{port}"],
                    capture_output=True, text=True, timeout=10
                )
                return str(port) in (result.stdout or "")
        except Exception:
            return False

    def print_report(self):
        """打印检测报告"""
        log.banner("ChainRPS 开发环境检测报告")

        print(f"  检测时间: {datetime.datetime.now().strftime('%Y-%m-%d %H:%M:%S')}")
        print(f"  操作系统: {self.os_info['system']} {self.os_info['release']}")
        print(f"  平台架构: {self.os_info['machine']}")
        print()

        categories = {}
        for item in self.results:
            cat = item.category
            if cat not in categories:
                categories[cat] = []
            categories[cat].append(item)

        category_names = {
            "runtime": "运行时环境",
            "python-env": "Python 虚拟环境",
            "python-deps": "Python 依赖包",
            "config": "配置文件",
            "npm-deps": "Node.js 依赖",
            "service": "服务进程",
            "smart-contract": "智能合约工具",
            "data": "数据存储",
            "frontend": "前端资源",
        }

        total = len(self.results)
        ok_count = sum(1 for r in self.results if r.status == DependencyStatus.OK)
        missing_count = sum(1 for r in self.results if r.status == DependencyStatus.MISSING)
        error_count = sum(1 for r in self.results if r.status == DependencyStatus.ERROR)

        for cat, items in categories.items():
            cat_name = category_names.get(cat, cat)
            print(f"{log._c('BOLD')}{cat_name}:{log._c('RESET')}")
            for item in items:
                status_icon = {
                    DependencyStatus.OK: f"{log._c('GREEN')}OK{log._c('RESET')}",
                    DependencyStatus.MISSING: f"{log._c('YELLOW')}MISSING{log._c('RESET')}",
                    DependencyStatus.OUTDATED: f"{log._c('YELLOW')}OUTDATED{log._c('RESET')}",
                    DependencyStatus.ERROR: f"{log._c('RED')}ERROR{log._c('RESET')}",
                }.get(item.status, "?")

                version_str = f" ({item.version})" if item.version else ""
                print(f"  [{status_icon}] {item.name}{version_str}: {item.details}")
            print()

        print(f"{log._c('BOLD')}统计摘要:{log._c('RESET')}")
        print(f"  总项目: {total}")
        print(f"  {log._c('GREEN')}正常: {ok_count}{log._c('RESET')}")
        print(f"  {log._c('YELLOW')}缺失: {missing_count}{log._c('RESET')}")
        if error_count > 0:
            print(f"  {log._c('RED')}错误: {error_count}{log._c('RESET')}")
        print()

        return {
            "total": total,
            "ok": ok_count,
            "missing": missing_count,
            "error": error_count,
            "results": [r.to_dict() for r in self.results],
        }


# ============================================================
# 环境安装器
# ============================================================
class EnvironmentInstaller:
    """开发环境安装器"""

    def __init__(self, mode: int = 1):
        """
        安装器初始化

        Args:
            mode: 1=智能安装(存在跳过), 2=强制重装
        """
        self.mode = mode
        self.progress = None
        self.install_log = []
        self._setup_progress_items()

    def _setup_progress_items(self):
        """设置需要执行的安装步骤"""
        self.progress_items = [
            {"key": "python_venv", "label": "Python 虚拟环境"},
            {"key": "python_deps", "label": "Python 依赖包 (pip install)"},
            {"key": "npm_deps", "label": "Node.js 依赖 (npm install)"},
            {"key": "redis", "label": "Redis 服务"},
            {"key": "ganache", "label": "Ganache 本地测试链"},
            {"key": "hardhat", "label": "Hardhat 智能合约工具"},
            {"key": "foundry", "label": "Foundry (foundryup)"},
            {"key": "config_files", "label": "配置文件 (.env 等)"},
            {"key": "data_dirs", "label": "数据目录与初始化"},
            {"key": "compile_contracts", "label": "智能合约编译"},
        ]

    def run(self):
        """执行环境安装"""
        mode_desc = "智能安装" if self.mode == 1 else "强制重装"
        log.banner(f"ChainRPS 开发环境搭建 - {mode_desc}模式")

        detector = EnvironmentDetector()
        current_status = detector.detect_all()
        detector.print_report()

        if self.mode == 1:
            log.info("智能安装模式: 已存在的依赖将跳过，不存在的将安装")
        else:
            log.warn("强制重装模式: 将强制安装所有依赖，包括已存在的")

        to_execute = self._filter_executable_steps(current_status)
        if not to_execute:
            log.success("所有依赖已就绪，无需额外安装！")
            self._print_final_summary(current_status, [])
            return True

        log.info(f"需要执行 {len(to_execute)} 个安装步骤")
        print()

        self.progress = ProgressBar(len(to_execute), "安装进度")
        executed = []
        skipped = []
        failed = []

        for i, item in enumerate(to_execute, 1):
            key = item["key"]
            label = item["label"]
            self.progress.update(i - 1, f"正在处理: {label}")

            result = self._execute_step(key, label)
            if result is True:
                executed.append(label)
                self.progress.update(i, f"完成: {label}")
            elif result is None:
                skipped.append(label)
                self.progress.update(i, f"跳过: {label}")
            else:
                failed.append(label)
                self.progress.update(i, f"失败: {label}")

        self.progress.done()

        log.banner("安装完成总结")
        log.success(f"成功: {len(executed)} 项 ({', '.join(executed) if executed else '无'})")
        if skipped:
            log.warn(f"跳过: {len(skipped)} 项 ({', '.join(skipped)})")
        if failed:
            log.error(f"失败: {len(failed)} 项 ({', '.join(failed)})")

        log.info("正在进行最终环境检查...")
        final_detector = EnvironmentDetector()
        final_status = final_detector.detect_all()
        final_detector.print_report()

        self._print_final_summary(final_status, failed)

        return len(failed) == 0

    def _filter_executable_steps(self, status: List[DependencyInfo]) -> List[dict]:
        """根据模式筛选需要执行的步骤"""
        status_map = {}
        for s in status:
            status_map[s.name] = s.status

        executable = []

        for item in self.progress_items:
            key = item["key"]

            if self.mode == 2:
                executable.append(item)
                continue

            need_install = self._check_step_needed(key, status_map)
            if need_install:
                executable.append(item)

        return executable

    def _check_step_needed(self, key: str, status_map: Dict[str, str]) -> bool:
        """检查步骤是否需要执行"""
        checks = {
            "python_venv": ".venv" in status_map and status_map[".venv"] == DependencyStatus.MISSING,
            "python_deps": "Python依赖包" in status_map and status_map["Python依赖包"] == DependencyStatus.MISSING,
            "npm_deps": "npm依赖" in status_map and status_map["npm依赖"] == DependencyStatus.MISSING,
            "redis": "Redis" in status_map and status_map["Redis"] != DependencyStatus.OK,
            "ganache": "Ganache" in status_map and status_map["Ganache"] != DependencyStatus.OK,
            "hardhat": "Hardhat" in status_map and status_map["Hardhat"] != DependencyStatus.OK,
            "foundry": "Foundry" in status_map and status_map["Foundry"] == DependencyStatus.MISSING,
            "config_files": ".env" in status_map and status_map[".env"] == DependencyStatus.MISSING,
            "data_dirs": True,
            "compile_contracts": True,
        }
        return checks.get(key, True)

    def _execute_step(self, key: str, label: str) -> Optional[bool]:
        """执行单个安装步骤"""
        log.step(f"[{self.progress.current + 1}/{self.progress.total}] {label}")

        try:
            handlers = {
                "python_venv": self._install_python_venv,
                "python_deps": self._install_python_deps,
                "npm_deps": self._install_npm_deps,
                "redis": self._install_redis,
                "ganache": self._install_ganache,
                "hardhat": self._install_hardhat,
                "foundry": self._install_foundry,
                "config_files": self._setup_config_files,
                "data_dirs": self._setup_data_dirs,
                "compile_contracts": self._compile_contracts,
            }

            handler = handlers.get(key)
            if handler:
                return handler()
            return True
        except Exception as e:
            log.error(f"执行 {label} 失败: {e}")
            self.install_log.append(f"[FAIL] {label}: {e}")
            return False

    def _install_python_venv(self) -> Optional[bool]:
        """安装 Python 虚拟环境"""
        if VENV_DIR.exists() and self.mode == 1:
            log.info("虚拟环境已存在，跳过")
            return None

        if VENV_DIR.exists() and self.mode == 2:
            log.info("强制模式：删除旧虚拟环境并重建")
            shutil.rmtree(VENV_DIR, ignore_errors=True)

        log.info("正在创建 Python 虚拟环境...")
        try:
            result = subprocess.run(
                [sys.executable, "-m", "venv", str(VENV_DIR)],
                capture_output=True, text=True, timeout=120,
                cwd=str(PROJECT_ROOT)
            )
            if result.returncode == 0:
                log.success("Python 虚拟环境创建成功")
                self.install_log.append("[OK] Python 虚拟环境创建成功")
                return True
            else:
                log.error(f"创建失败: {result.stderr}")
                return False
        except subprocess.TimeoutExpired:
            log.error("创建虚拟环境超时")
            return False
        except Exception as e:
            log.error(f"创建虚拟环境异常: {e}")
            return False

    def _install_python_deps(self) -> Optional[bool]:
        """安装 Python 依赖包"""
        python_exe = self._get_venv_python()

        if self.mode == 1:
            missing = self._get_missing_python_deps(python_exe)
            if not missing:
                log.info("所有 Python 依赖已安装，跳过")
                return None
            log.info(f"需要安装 {len(missing)} 个缺失依赖")

        log.info("正在安装 Python 依赖包...")

        try:
            subprocess.run(
                [python_exe, "-m", "pip", "install", "--upgrade", "pip", "setuptools", "wheel"],
                capture_output=True, text=True, timeout=120,
                cwd=str(PROJECT_ROOT)
            )
        except Exception:
            log.warn("pip 升级失败，继续安装依赖")

        try:
            cmd = [python_exe, "-m", "pip", "install", "-e", "."]
            result = subprocess.run(
                cmd,
                capture_output=True, text=True, timeout=300,
                cwd=str(PROJECT_ROOT)
            )
            if result.returncode == 0:
                log.success("Python 依赖安装成功")
                self.install_log.append("[OK] Python 依赖安装成功")
                return True
            else:
                log.error(f"安装失败: {result.stderr[:500]}")
                return False
        except subprocess.TimeoutExpired:
            log.error("依赖安装超时")
            return False
        except Exception as e:
            log.error(f"安装异常: {e}")
            return False

    def _get_missing_python_deps(self, python_exe: str) -> List[str]:
        """获取缺失的 Python 依赖"""
        required = [
            "fastapi", "uvicorn", "redis", "web3", "eth_account",
            "pydantic", "dotenv", "jwt", "passlib", "bcrypt"
        ]
        missing = []
        for pkg in required:
            try:
                result = subprocess.run(
                    [python_exe, "-c", f"import {pkg}"],
                    capture_output=True, text=True, timeout=5
                )
                if result.returncode != 0:
                    missing.append(pkg)
            except Exception:
                missing.append(pkg)
        return missing

    def _get_venv_python(self) -> str:
        """获取虚拟环境的 Python 可执行文件路径"""
        if platform.system() == "Windows":
            return str(VENV_DIR / "Scripts" / "python.exe")
        else:
            return str(VENV_DIR / "bin" / "python")

    def _install_npm_deps(self) -> Optional[bool]:
        """安装 Node.js 依赖"""
        if not PACKAGE_JSON_PATH.exists():
            log.info("项目无 package.json，跳过 npm 依赖安装")
            return None

        if NODE_MODULES_DIR.exists() and self.mode == 1:
            log.info("node_modules 已存在，跳过")
            return None

        if not self._check_command("npm"):
            log.warn("npm 不可用，跳过 npm 依赖安装")
            return None

        log.info("正在安装 Node.js 依赖 (npm install)...")
        try:
            cmd = ["npm", "install"]
            if self.mode == 2:
                if NODE_MODULES_DIR.exists():
                    shutil.rmtree(NODE_MODULES_DIR, ignore_errors=True)
                if (PROJECT_ROOT / "package-lock.json").exists():
                    (PROJECT_ROOT / "package-lock.json").unlink(ignore_errors=True)

            result = subprocess.run(
                cmd,
                capture_output=True, text=True, timeout=300,
                cwd=str(PROJECT_ROOT)
            )
            if result.returncode == 0:
                log.success("Node.js 依赖安装成功")
                self.install_log.append("[OK] Node.js 依赖安装成功")
                return True
            else:
                log.error(f"安装失败: {result.stderr[:500]}")
                return False
        except subprocess.TimeoutExpired:
            log.error("npm install 超时")
            return False
        except Exception as e:
            log.error(f"npm install 异常: {e}")
            return False

    def _install_redis(self) -> Optional[bool]:
        """安装 Redis 服务"""
        redis_installed = self._check_command("redis-server")

        if redis_installed and self.mode == 1:
            log.info("Redis 已安装，跳过")
            return None

        if redis_installed and self.mode == 2:
            log.warn("Redis 已安装，强制模式下不重装（需手动处理）")
            return None

        log.info("正在安装 Redis...")
        system = platform.system()

        if system == "Windows":
            log.info("Windows 平台：Redis 推荐使用 Memurai 或 WSL")
            log.info("下载地址: https://www.memurai.com/")

            if self._check_command("winget"):
                log.info("尝试通过 winget 安装 Redis...")
                result = subprocess.run(
                    ["winget", "install", "Redis.Redis", "--accept-source-agreements", "--accept-package-agreements"],
                    capture_output=True, text=True, timeout=120
                )
                if result.returncode == 0:
                    log.success("Redis 安装命令执行成功")
                    return True
                else:
                    log.warn(f"winget 安装失败: {result.stderr[:200]}")
            elif self._check_command("choco"):
                log.info("尝试通过 chocolatey 安装 Redis...")
                result = subprocess.run(
                    ["choco", "install", "redis", "-y"],
                    capture_output=True, text=True, timeout=120
                )
                if result.returncode == 0:
                    log.success("Redis 安装命令执行成功")
                    return True
                else:
                    log.warn(f"choco 安装失败: {result.stderr[:200]}")

            log.warn("请手动安装 Redis 或使用 Memurai")
            return None
        elif system == "Linux":
            if self._check_command("apt-get"):
                subprocess.run(["sudo", "apt-get", "update"], capture_output=True, timeout=60)
                result = subprocess.run(
                    ["sudo", "apt-get", "install", "-y", "redis-server"],
                    capture_output=True, text=True, timeout=120
                )
                if result.returncode == 0:
                    log.success("Redis 安装成功")
                    return True
                return False
            elif self._check_command("yum"):
                result = subprocess.run(
                    ["sudo", "yum", "install", "-y", "redis"],
                    capture_output=True, text=True, timeout=120
                )
                return result.returncode == 0
            return None
        elif system == "Darwin":
            if self._check_command("brew"):
                result = subprocess.run(
                    ["brew", "install", "redis"],
                    capture_output=True, text=True, timeout=120
                )
                if result.returncode == 0:
                    log.success("Redis 安装成功")
                    return True
                return False
            return None

        return None

    def _install_ganache(self) -> Optional[bool]:
        """安装 Ganache"""
        ganache_cmd = self._find_ganache()

        if ganache_cmd and self.mode == 1:
            log.info("Ganache 已安装，跳过")
            return None

        if ganache_cmd and self.mode == 2:
            log.info("强制模式：重新安装 Ganache")
            self._npm_uninstall("ganache")
            self._npm_uninstall("ganache-cli")

        log.info("正在安装 Ganache (npm install ganache-cli)...")

        if not self._check_command("npm"):
            log.warn("npm 不可用，无法安装 Ganache")
            return None

        try:
            if self.mode == 2:
                result = subprocess.run(
                    ["npm", "install", "ganache-cli", "--save-dev", "--force"],
                    capture_output=True, text=True, timeout=120,
                    cwd=str(PROJECT_ROOT)
                )
            else:
                result = subprocess.run(
                    ["npm", "install", "ganache-cli", "--save-dev"],
                    capture_output=True, text=True, timeout=120,
                    cwd=str(PROJECT_ROOT)
                )

            if result.returncode == 0:
                log.success("Ganache 安装成功")
                self.install_log.append("[OK] Ganache 安装成功")
                return True
            else:
                log.error(f"Ganache 安装失败: {result.stderr[:300]}")
                return False
        except subprocess.TimeoutExpired:
            log.error("Ganache 安装超时")
            return False

    def _install_hardhat(self) -> Optional[bool]:
        """安装 Hardhat"""
        hardhat_installed = self._find_hardhat()

        if hardhat_installed and self.mode == 1:
            log.info("Hardhat 已安装，跳过")
            return None

        log.info("正在安装/更新 Hardhat...")

        if not self._check_command("npm"):
            log.warn("npm 不可用，无法安装 Hardhat")
            return None

        packages = [
            "@nomicfoundation/hardhat-toolbox",
            "@nomicfoundation/hardhat-ethers",
            "@nomicfoundation/hardhat-chai-matchers",
            "@nomicfoundation/hardhat-verify",
            "hardhat"
        ]

        try:
            if self.mode == 2:
                result = subprocess.run(
                    ["npm", "install", "--save-dev"] + packages + ["--force"],
                    capture_output=True, text=True, timeout=180,
                    cwd=str(PROJECT_ROOT)
                )
            else:
                result = subprocess.run(
                    ["npm", "install", "--save-dev"] + packages,
                    capture_output=True, text=True, timeout=180,
                    cwd=str(PROJECT_ROOT)
                )

            if result.returncode == 0:
                log.success("Hardhat 安装成功")
                self.install_log.append("[OK] Hardhat 安装成功")
                return True
            else:
                log.error(f"Hardhat 安装失败: {result.stderr[:300]}")
                return False
        except subprocess.TimeoutExpired:
            log.error("Hardhat 安装超时")
            return False

    def _install_foundry(self) -> Optional[bool]:
        """安装 Foundry"""
        foundry_installed = self._check_command("foundryup") or self._check_command("forge")

        if foundry_installed and self.mode == 1:
            log.info("Foundry 已安装，跳过")
            return None

        log.info("正在安装 Foundry...")

        system = platform.system()

        if system == "Windows":
            log.info("Windows 平台 Foundry 安装说明：")
            log.info("  1. 访问 https://github.com/foundry-rs/foundry/releases")
            log.info("  2. 下载 foundry_stable_windows_amd64.zip")
            log.info("  3. 解压并添加到 PATH")
            log.info("  4. 或使用 WSL 安装: curl -L https://foundry.paradigm.xyz | bash")
            return None
        elif system in ("Linux", "Darwin"):
            try:
                install_script = "curl -L https://foundry.paradigm.xyz | bash"
                result = subprocess.run(
                    ["bash", "-c", install_script],
                    capture_output=True, text=True, timeout=60
                )
                if result.returncode == 0 or "foundryup" in (result.stdout or ""):
                    subprocess.run(
                        ["bash", "-c", "source ~/.bashrc && foundryup"],
                        capture_output=True, text=True, timeout=120
                    )
                    log.success("Foundry 安装成功")
                    self.install_log.append("[OK] Foundry 安装成功")
                    return True
                else:
                    log.error(f"Foundry 安装失败: {result.stderr[:300]}")
                    return False
            except Exception as e:
                log.error(f"Foundry 安装异常: {e}")
                return False

        return None

    def _setup_config_files(self) -> Optional[bool]:
        """设置配置文件"""
        env_path = PROJECT_ROOT / ".env"

        if env_path.exists() and self.mode == 1:
            log.info(".env 配置文件已存在，跳过")
            return None

        if env_path.exists() and self.mode == 2:
            log.info("强制模式：备份旧 .env 并重新生成")
            backup_path = PROJECT_ROOT / ".env.bak"
            if backup_path.exists():
                backup_path.unlink()
            shutil.copy2(env_path, backup_path)

        if ENV_EXAMPLE_PATH.exists():
            log.info("正在从 .env.example 复制生成 .env...")
            shutil.copy2(ENV_EXAMPLE_PATH, env_path)

            content = env_path.read_text(encoding="utf-8")

            import secrets
            jwt_secret = secrets.token_urlsafe(32)
            content += f"\n# JWT 密钥（自动生成）\nJWT_SECRET={jwt_secret}\n"
            content += "# 默认管理员配置\nDEFAULT_ADMIN_USERNAME=admin\nDEFAULT_ADMIN_PASSWORD=ADMIN\n"
            content += "DEBUG=true\n"

            env_path.write_text(content, encoding="utf-8")

            log.success(".env 配置文件已生成")
            self.install_log.append("[OK] .env 配置文件已生成")
            return True
        else:
            log.error(".env.example 不存在，无法自动生成 .env")
            return False

    def _setup_data_dirs(self) -> Optional[bool]:
        """设置数据目录"""
        dirs_to_create = [
            DATA_DIR,
            PROJECT_ROOT / "logs",
        ]

        created = []
        for d in dirs_to_create:
            if not d.exists():
                d.mkdir(parents=True, exist_ok=True)
                created.append(str(d))

        if created:
            log.info(f"已创建 {len(created)} 个数据目录: {', '.join(created)}")

        python_exe = self._get_venv_python()
        if os.path.exists(python_exe):
            try:
                result = subprocess.run(
                    [python_exe, "-c", "import sys; sys.path.insert(0, '.'); from rps_backend.repository import init_database; init_database(); print('数据库初始化成功')"],
                    capture_output=True, text=True, timeout=30,
                    cwd=str(PROJECT_ROOT)
                )
                if result.returncode == 0:
                    log.success("数据库初始化成功")
                    self.install_log.append("[OK] 数据库初始化成功")
                    return True
                else:
                    log.warn(f"数据库初始化警告: {result.stderr[:200]}")
            except Exception as e:
                log.warn(f"数据库初始化异常（可忽略）: {e}")

        return True

    def _compile_contracts(self) -> Optional[bool]:
        """编译智能合约"""
        contracts_src = CONTRACTS_DIR / "src"
        if not contracts_src.exists() or not list(contracts_src.glob("*.sol")):
            log.info("无智能合约源码，跳过编译")
            return None

        compile_script = CONTRACTS_DIR / "scripts" / "compile.py"
        if not compile_script.exists():
            log.info("合约编译脚本不存在，跳过")
            return None

        build_dir = CONTRACTS_DIR / "build"
        build_file = build_dir / "chainrps.json"

        if build_file.exists() and self.mode == 1:
            log.info("合约编译产物已存在，跳过")
            return None

        log.info("正在编译智能合约...")

        python_exe = self._get_venv_python()

        try:
            result = subprocess.run(
                [python_exe, str(compile_script)],
                capture_output=True, text=True, timeout=60,
                cwd=str(PROJECT_ROOT)
            )
            if result.returncode == 0:
                log.success("智能合约编译成功")
                self.install_log.append("[OK] 智能合约编译成功")
                return True
            else:
                log.error(f"合约编译失败: {result.stdout}\n{result.stderr[:500]}")
                return False
        except subprocess.TimeoutExpired:
            log.error("合约编译超时")
            return False
        except Exception as e:
            log.error(f"合约编译异常: {e}")
            return False

    def _find_ganache(self) -> bool:
        """查找 Ganache"""
        if self._check_command("ganache") or self._check_command("ganache-cli"):
            return True
        local = NODE_MODULES_DIR / ".bin" / "ganache"
        return local.exists()

    def _find_hardhat(self) -> bool:
        """查找 Hardhat"""
        if self._check_command("hardhat"):
            return True
        local = NODE_MODULES_DIR / ".bin" / "hardhat"
        return local.exists()

    def _check_command(self, cmd: str) -> bool:
        """检查命令是否可用"""
        try:
            subprocess.run(
                [cmd, "--version"],
                capture_output=True, text=True, timeout=5
            )
            return True
        except (FileNotFoundError, subprocess.TimeoutExpired):
            return False
        except Exception:
            return False

    def _npm_uninstall(self, package: str):
        """npm 卸载包"""
        try:
            subprocess.run(
                ["npm", "uninstall", package],
                capture_output=True, text=True, timeout=30,
                cwd=str(PROJECT_ROOT)
            )
        except Exception:
            pass

    def _print_final_summary(self, status: List[DependencyInfo], failed: List[str]):
        """打印最终启动指南"""
        log.banner("ChainRPS 启动指南")

        python_exe = self._get_venv_python()
        system = platform.system()

        print("  1. 启动 Redis:")
        if system == "Windows":
            print("     redis-server  (或通过服务管理器启动)")
        elif system == "Linux":
            print("     sudo systemctl start redis-server")
        elif system == "Darwin":
            print("     brew services start redis")

        print()
        print("  2. 启动 Ganache (本地测试链):")
        print(f"     cd {PROJECT_ROOT}")
        if system == "Windows":
            print("     .\\node_modules\\.bin\\ganache-cli -h 127.0.0.1 -p 8686 --chain.chainId 5208888")
        else:
            print("./node_modules/.bin/ganache-cli -h 127.0.0.1 -p 8686 --chain.chainId 5208888")

        print()
        print("  3. 部署合约:")
        print(f"     cd {PROJECT_ROOT}")
        print(f"     {python_exe} contracts/scripts/deploy_local.py")

        print()
        print("  4. 启动后端服务:")
        print(f"     cd {PROJECT_ROOT}")
        print(f"     {python_exe} main.py")

        print()
        print("  5. 访问应用:")
        print("     http://127.0.0.1:8000")
        print()

        if failed:
            log.warn(f"有 {len(failed)} 个步骤失败，请手动处理: {', '.join(failed)}")

        log.success("环境搭建完成！")


# ============================================================
# 主入口
# ============================================================
def main():
    parser = argparse.ArgumentParser(
        description="ChainRPS 开发环境初始化脚本",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
示例:
  python scripts/init_env.py          交互菜单选择模式
  python scripts/init_env.py --mode 1  智能安装 (默认)
  python scripts/init_env.py --mode 2  强制重装
  python scripts/init_env.py --check   仅检测环境
        """
    )
    parser.add_argument(
        "--mode", "-m", type=int, choices=[1, 2],
        help="安装模式: 1=智能安装(默认), 2=强制重装"
    )
    parser.add_argument(
        "--check", "-c", action="store_true",
        help="仅检测环境，不执行安装"
    )

    args = parser.parse_args()

    if args.check:
        detector = EnvironmentDetector()
        detector.detect_all()
        report = detector.print_report()

        report_path = PROJECT_ROOT / "env_report.json"
        with open(report_path, "w", encoding="utf-8") as f:
            json.dump(report, f, ensure_ascii=False, indent=2)
        log.info(f"检测报告已保存: {report_path}")
        return 0

    mode = args.mode
    if mode is None:
        mode = select_mode()

    installer = EnvironmentInstaller(mode=mode)
    success = installer.run()

    return 0 if success else 1


def select_mode() -> int:
    """交互式选择安装模式"""
    log.banner("ChainRPS 开发环境初始化")
    print("请选择安装模式:")
    print()
    print("  1. 智能安装 (推荐)")
    print("     - 已存在的依赖将跳过")
    print("     - 不存在的依赖将自动安装")
    print("     - 安全高效，适合日常开发")
    print()
    print("  2. 强制重装")
    print("     - 不管依赖是否存在都重新安装")
    print("     - 适合环境损坏或版本更新场景")
    print("     - 耗时较长")
    print()

    while True:
        choice = input("请输入选项 [1/2] (默认: 1): ").strip()
        if choice == "" or choice == "1":
            return 1
        elif choice == "2":
            return 2
        else:
            log.warn("无效选项，请输入 1 或 2")


if __name__ == "__main__":
    sys.exit(main())