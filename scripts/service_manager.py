#!/usr/bin/env python3
"""
ChainRPS 本地服务启动管理模块

独立于后端应用的启动器，按依赖顺序管理所有本地服务的生命周期。
支持 start / stop / restart / status / test 子命令。

启动顺序：Redis(检查) → Ganache(本地链) → 后端(uvicorn)

可选 --scheduler 标志：通过 Windows Task Scheduler 启动，
进程完全脱离 TRAE/PowerShell job object，跨 session 存活。
适用于 TRAE Agent 会话或需要后台长期运行的场景。

用法:
    python scripts/service_manager.py start              # 直接启动（detached）
    python scripts/service_manager.py --scheduler start  # 通过调度器启动（推荐）
    python scripts/service_manager.py restart
    python scripts/service_manager.py stop
    python scripts/service_manager.py status
    python scripts/service_manager.py test               # 完整闭环测试: 停→启→验证→停
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
import time
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

# ───────────────────────── 路径 & 配置加载 ─────────────────────────

PROJECT_ROOT = Path(__file__).resolve().parent.parent
ENV_FILE = PROJECT_ROOT / ".env"
SCHEMA_FILE = PROJECT_ROOT / "rps_backend" / "config" / "config_schema.json"
DATA_DIR = PROJECT_ROOT / "data"
CHAIN_DATA_DIR = DATA_DIR / "chaindata_ganache"
ACCOUNT_KEYS_FILE = DATA_DIR / "ganache_accounts.json"
BACKEND_LOG_OUT = PROJECT_ROOT / "data" / "backend_stdout.log"
BACKEND_LOG_ERR = PROJECT_ROOT / "data" / "backend_stderr.log"

# 硬编码的默认值（与 config_schema.json 保持一致），在找不到配置时使用
DEFAULTS: Dict[str, Any] = {
    "HOST": "0.0.0.0",
    "PORT": 8000,
    "REDIS_URL": "redis://localhost:6379/0",
    "RPC_LOCAL_HOST": "127.0.0.1",
    "RPC_LOCAL_PORT": 8686,
    "RPC_CHAIN_ID": 5208888,
    "RPC_LOCAL_SYMBOL": "POL",
    "RPC_LOCAL_ACCOUNT_COUNT": 10,
    "RPC_LOCAL_BALANCE": 100000,
}


def _load_env() -> Dict[str, str]:
    """读取 .env 文件为字典（简单实现，支持 # 注释）"""
    result: Dict[str, str] = {}
    if not ENV_FILE.exists():
        return result
    for raw in ENV_FILE.read_text(encoding="utf-8").splitlines():
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        if "=" not in line:
            continue
        key, _, val = line.partition("=")
        result[key.strip()] = val.strip().strip('"').strip("'")
    return result


def _load_schema_defaults() -> Dict[str, Any]:
    """从 config_schema.json 提取 default 值"""
    result: Dict[str, Any] = {}
    if not SCHEMA_FILE.exists():
        return result
    try:
        data = json.loads(SCHEMA_FILE.read_text(encoding="utf-8"))
        for key, cfg in data.get("configs", {}).items():
            if "default" in cfg:
                result[key] = cfg["default"]
    except Exception:
        pass
    return result


def load_config() -> Dict[str, Any]:
    """合并默认值 + schema + .env，返回最终配置"""
    cfg: Dict[str, Any] = dict(DEFAULTS)
    cfg.update(_load_schema_defaults())
    env = _load_env()
    for k, v in env.items():
        if k in cfg:
            # 类型转换
            orig = cfg[k]
            try:
                if isinstance(orig, int):
                    cfg[k] = int(v)
                elif isinstance(orig, float):
                    cfg[k] = float(v)
                elif isinstance(orig, bool):
                    cfg[k] = v.lower() in ("true", "1", "yes")
                else:
                    cfg[k] = v
            except (ValueError, TypeError):
                cfg[k] = v
        else:
            cfg[k] = v
    return cfg


# ───────────────────────── 工具函数 ─────────────────────────

def log(level: str, msg: str) -> None:
    colors = {
        "INFO": "\033[96m",   # cyan
        "OK": "\033[92m",     # green
        "WARN": "\033[93m",   # yellow
        "ERR": "\033[91m",    # red
        "DIM": "\033[90m",    # gray
    }
    reset = "\033[0m"
    prefix = colors.get(level, "") + f"[{level:4s}]" + reset
    print(f"{prefix} {msg}", flush=True)


def port_in_use(port: int) -> Optional[int]:
    """返回占用指定端口的 PID，未占用返回 None（跨平台）"""
    try:
        if os.name == "nt":
            result = subprocess.run(
                ["netstat", "-ano", "-p", "TCP"],
                capture_output=True, text=True, timeout=5,
            )
            for line in result.stdout.splitlines():
                if f":{port}" in line and "LISTENING" in line:
                    parts = line.split()
                    if parts and parts[-1].isdigit():
                        return int(parts[-1])
        else:
            result = subprocess.run(
                ["lsof", "-ti", f"tcp:{port}"],
                capture_output=True, text=True, timeout=5,
            )
            if result.stdout.strip():
                return int(result.stdout.strip().splitlines()[0])
    except Exception:
        pass
    return None


def kill_pid(pid: int) -> bool:
    """尝试终止指定 PID 的进程"""
    try:
        if os.name == "nt":
            subprocess.run(
                ["taskkill", "/F", "/PID", str(pid)],
                capture_output=True, timeout=5,
            )
        else:
            os.kill(pid, 9)
        return True
    except Exception:
        return False


def wait_port_free(port: int, timeout: float = 15) -> bool:
    """等待端口释放"""
    deadline = time.time() + timeout
    while time.time() < deadline:
        pid = port_in_use(port)
        if pid is None:
            return True
        time.sleep(0.5)
    return port_in_use(port) is None


def wait_port_listen(port: int, timeout: float = 30) -> bool:
    """等待端口开始监听"""
    deadline = time.time() + timeout
    while time.time() < deadline:
        if port_in_use(port) is not None:
            return True
        time.sleep(0.5)
    return port_in_use(port) is not None


# ───────────────────────── Service 基类 ─────────────────────────

class Service:
    """服务抽象基类"""
    name: str = "unknown"

    def is_running(self) -> bool: ...
    def start(self, cfg: Dict[str, Any], use_scheduler: bool = False) -> Tuple[bool, str]: ...
    def stop(self) -> Tuple[bool, str]: ...
    def health_check(self, cfg: Dict[str, Any]) -> bool: ...


def _run_powershell(script: str) -> subprocess.CompletedProcess:
    """执行 PowerShell 脚本"""
    return subprocess.run(
        ["powershell", "-NoProfile", "-Command", script],
        capture_output=True, text=True, timeout=30,
    )


def _register_scheduled_task(task_name: str, exe: str, args: str, cwd: str) -> bool:
    """注册并立即执行一个 Windows 计划任务（进程完全脱离 TRAE job object）"""
    script = f"""
$action = New-ScheduledTaskAction -Execute '{exe}' -Argument '{args}' -WorkingDirectory '{cwd}'
$trigger = New-ScheduledTaskTrigger -Once -At (Get-Date)
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable
Register-ScheduledTask -TaskName '{task_name}' -Action $action -Trigger $trigger -Settings $settings -RunLevel Highest -Force | Out-Null
Start-ScheduledTask -TaskName '{task_name}'
"""
    try:
        result = _run_powershell(script)
        return result.returncode == 0
    except Exception:
        return False


def _unregister_scheduled_task(task_name: str) -> None:
    """注销计划任务"""
    script = f"Unregister-ScheduledTask -TaskName '{task_name}' -Confirm:$false -ErrorAction SilentlyContinue"
    try:
        _run_powershell(script)
    except Exception:
        pass


# ───────────────────────── Redis ─────────────────────────

class RedisService(Service):
    name = "Redis"

    def is_running(self) -> bool:
        # 简单：检查 6379 端口
        return port_in_use(6379) is not None

    def start(self, cfg: Dict[str, Any], use_scheduler: bool = False) -> Tuple[bool, str]:
        # Redis 在 Windows 上通常是 Memurai 服务，这里只做检查
        if self.is_running():
            return True, "已运行"
        return False, "未运行，请确认 Memurai 已启动 (Windows 服务)"

    def stop(self) -> Tuple[bool, str]:
        return True, "Redis 由 Windows 服务管理，不停止"

    def health_check(self, cfg: Dict[str, Any]) -> bool:
        return self.is_running()


# ───────────────────────── Ganache ─────────────────────────

class GanacheService(Service):
    name = "Ganache"

    def is_running(self) -> bool:
        pid = port_in_use(GANACHE_PORT)
        if pid is None:
            return False
        # 还需要通过 RPC 确认真正可用
        try:
            import requests
            r = requests.post(
                f"http://{GANACHE_HOST}:{GANACHE_PORT}",
                json={"jsonrpc": "2.0", "method": "eth_chainId", "params": [], "id": 1},
                timeout=2,
            )
            return r.status_code == 200 and "result" in r.json()
        except Exception:
            return False

    def _cleanup_stale_files(self) -> None:
        """清理残留的 LOCK 文件"""
        CHAIN_DATA_DIR.mkdir(parents=True, exist_ok=True)
        lock = CHAIN_DATA_DIR / "LOCK"
        if lock.exists():
            try:
                lock.unlink()
                log("WARN", f"清理残留 LOCK 文件: {lock}")
            except OSError:
                log("WARN", f"LOCK 文件被占用（可能有残留进程），强制清理进程后再试")

    TASK_NAME = "ChainRPS_Ganache"

    def start(self, cfg: Dict[str, Any], use_scheduler: bool = False) -> Tuple[bool, str]:
        if self.is_running():
            return True, f"已在运行 (端口 {GANACHE_PORT})"

        # 1. 清理残留进程（先杀所有 ganache/node，防止 LOCK 被占用）
        self._kill_all_ganache()
        pid = port_in_use(GANACHE_PORT)
        if pid is not None:
            log("WARN", f"端口 {GANACHE_PORT} 被 PID={pid} 占用，强制终止")
            kill_pid(pid)
            wait_port_free(GANACHE_PORT)

        # 2. 清理 stale LOCK
        self._cleanup_stale_files()

        # 3. 确保目录存在
        CHAIN_DATA_DIR.mkdir(parents=True, exist_ok=True)
        DATA_DIR.mkdir(parents=True, exist_ok=True)

        # 4. 查找 ganache 可执行文件
        ganache_exe = self._find_ganache()
        if not ganache_exe:
            return False, "未找到 ganache，请先执行: npm install -g ganache"

        # 5. 构建启动命令参数
        cmd_args_list = [
            "--server.host", GANACHE_HOST,
            "--server.port", str(GANACHE_PORT),
            "--chain.chainId", str(cfg["RPC_CHAIN_ID"]),
            "--wallet.deterministic",
            "--wallet.totalAccounts", str(cfg["RPC_LOCAL_ACCOUNT_COUNT"]),
            "--wallet.defaultBalance", str(cfg["RPC_LOCAL_BALANCE"]),
            "--wallet.accountKeysPath", str(ACCOUNT_KEYS_FILE),
            "--database.dbPath", str(CHAIN_DATA_DIR),
        ]
        cmd_args = " ".join(cmd_args_list)

        if use_scheduler:
            return self._start_via_scheduler(ganache_exe, cmd_args)
        else:
            return self._start_direct(ganache_exe, cmd_args_list)

    def _start_via_scheduler(self, ganache_exe: str, cmd_args: str) -> Tuple[bool, str]:
        """通过 Windows Task Scheduler 启动（进程跨 session 存活）"""
        log("INFO", f"[scheduler] 注册计划任务 {self.TASK_NAME} ...")
        ok = _register_scheduled_task(self.TASK_NAME, ganache_exe, cmd_args, str(PROJECT_ROOT))
        if not ok:
            return False, "计划任务注册失败"
        log("INFO", f"等待 Ganache 就绪 (最多 20s)...")
        if self._wait_ready(timeout=20):
            chain_id_hex = self._query_chain_id()
            return True, f"就绪 chainId={chain_id_hex} port={GANACHE_PORT} (scheduler)"
        return False, "启动超时"

    def _start_direct(self, ganache_exe: str, cmd_args_list: List[str]) -> Tuple[bool, str]:
        """直接用 subprocess.Popen 启动"""
        cmd = [ganache_exe] + cmd_args_list
        log("INFO", f"启动 Ganache: {' '.join(cmd[:4])} ...")
        try:
            DETACHED = 0x00000008
            NEW_GROUP = 0x00000200
            env = os.environ.copy()
            node_paths = [
                r"C:\Program Files\nodejs",
                os.path.join(os.environ.get("APPDATA", ""), "npm"),
                r"C:\Program Files\Git\cmd",
            ]
            env["PATH"] = ";".join(node_paths) + ";" + env.get("PATH", "")
            subprocess.Popen(
                cmd, cwd=str(PROJECT_ROOT), env=env,
                stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                creationflags=(DETACHED | NEW_GROUP) if os.name == "nt" else 0,
                close_fds=True,
            )
        except Exception as e:
            return False, f"启动进程失败: {e}"

        log("INFO", f"等待 Ganache 就绪 (最多 20s)...")
        if self._wait_ready(timeout=20):
            chain_id_hex = self._query_chain_id()
            return True, f"就绪 chainId={chain_id_hex} port={GANACHE_PORT}"
        return False, "启动超时"

    def _wait_ready(self, timeout: float = 20) -> bool:
        deadline = time.time() + timeout
        while time.time() < deadline:
            if self.is_running():
                return True
            time.sleep(1.0)
        return self.is_running()

    def _query_chain_id(self) -> str:
        try:
            import requests
            r = requests.post(
                f"http://{GANACHE_HOST}:{GANACHE_PORT}",
                json={"jsonrpc": "2.0", "method": "eth_chainId", "params": [], "id": 1},
                timeout=2,
            )
            return r.json().get("result", "?")
        except Exception:
            return "?"

    @staticmethod
    def _find_ganache() -> Optional[str]:
        # 构建包含 node/npm 的 PATH（venv Python 运行时 PATH 可能没有这些）
        node_paths = [
            r"C:\Program Files\nodejs",
            os.path.join(os.environ.get("APPDATA", ""), "npm"),
            r"C:\Program Files\Git\cmd",
        ]
        extra_path = ";".join(p for p in node_paths if os.path.exists(p))
        full_path = extra_path + ";" + os.environ.get("PATH", "")
        env = os.environ.copy()
        env["PATH"] = full_path

        for hint in ("ganache.cmd", "ganache", "ganache-cli.cmd", "ganache-cli"):
            try:
                if os.name == "nt":
                    result = subprocess.run(
                        ["where", hint], capture_output=True, text=True, timeout=3,
                        env=env,
                    )
                    if result.returncode == 0 and result.stdout.strip():
                        return result.stdout.strip().splitlines()[0]
                else:
                    result = subprocess.run(
                        ["which", hint], capture_output=True, text=True, timeout=3,
                        env=env,
                    )
                    if result.returncode == 0:
                        return result.stdout.strip()
            except Exception:
                pass

        # 兜底：直接查 npm 全局目录
        npm_bin = os.path.join(os.environ.get("APPDATA", ""), "npm", "ganache.cmd")
        if os.path.exists(npm_bin):
            return npm_bin

        return None

    def _kill_all_ganache(self) -> None:
        """杀掉所有 ganache 残留进程（不管端口是否还在监听）"""
        killed = []
        try:
            if os.name == "nt":
                # 方法 1: 直接 taskkill 所有 node.exe（本环境只有 ganache 用 node）
                result = subprocess.run(
                    ["tasklist", "/FI", "IMAGENAME eq node.exe", "/FO", "CSV", "/NH"],
                    capture_output=True, text=True, timeout=5,
                )
                for line in result.stdout.splitlines():
                    parts = line.split('","')
                    if len(parts) >= 2:
                        pid_str = parts[1].replace('"', "")
                        if pid_str.isdigit():
                            killed_pid = int(pid_str)
                            kill_pid(killed_pid)
                            killed.append(killed_pid)
                            log("WARN", f"终止残留 node 进程 PID={killed_pid}")
        except Exception:
            pass

        if killed:
            time.sleep(1.5)  # 等 LOCK 文件释放

    def stop(self) -> Tuple[bool, str]:
        pid = port_in_use(GANACHE_PORT)
        # 额外清理所有 ganache 残留进程（不管端口）
        self._kill_all_ganache()
        if pid is None:
            return True, "未运行"
        wait_port_free(GANACHE_PORT)
        return True, f"已停止 PID={pid}"

    def health_check(self, cfg: Dict[str, Any]) -> bool:
        return self.is_running()


# ───────────────────────── 后端 ─────────────────────────

class BackendService(Service):
    name = "Backend"

    def is_running(self) -> bool:
        pid = port_in_use(BACKEND_PORT)
        if pid is None:
            return False
        try:
            import requests
            r = requests.get(f"http://127.0.0.1:{BACKEND_PORT}/docs", timeout=3)
            return r.status_code == 200
        except Exception:
            return False

    TASK_NAME = "ChainRPS_Backend"

    def start(self, cfg: Dict[str, Any], use_scheduler: bool = False) -> Tuple[bool, str]:
        if self.is_running():
            return True, f"已在运行 (端口 {BACKEND_PORT})"

        # 1. 清理残留
        pid = port_in_use(BACKEND_PORT)
        if pid is not None:
            log("WARN", f"端口 {BACKEND_PORT} 被 PID={pid} 占用，强制终止")
            kill_pid(pid)
            wait_port_free(BACKEND_PORT)

        # 2. 找到 venv Python
        venv_py = self._find_python()
        if not venv_py:
            return False, "未找到项目虚拟环境 .venv"

        # 3. 确保 Ganache 端口和 .env 配置一致
        self._ensure_ganache_port_consistent(cfg)

        # 4. 构建启动参数
        cmd_args_list = [
            "-m", "uvicorn",
            "rps_backend.main:app",
            "--host", cfg["HOST"],
            "--port", str(cfg["PORT"]),
        ]
        cmd_args = " ".join(cmd_args_list)

        if use_scheduler:
            return self._start_via_scheduler(str(venv_py), cmd_args)
        else:
            return self._start_direct(str(venv_py), cmd_args_list)

    def _start_via_scheduler(self, py_exe: str, cmd_args: str) -> Tuple[bool, str]:
        """通过 Windows Task Scheduler 启动（进程跨 session 存活）"""
        log("INFO", f"[scheduler] 注册计划任务 {self.TASK_NAME} ...")
        ok = _register_scheduled_task(self.TASK_NAME, py_exe, cmd_args, str(PROJECT_ROOT))
        if not ok:
            return False, "计划任务注册失败"
        log("INFO", "等待后端就绪 (最多 30s)...")
        if self._wait_ready(timeout=30):
            return True, f"就绪 port={BACKEND_PORT} (scheduler)"
        return False, "启动超时"

    def _start_direct(self, py_exe: str, cmd_args_list: List[str]) -> Tuple[bool, str]:
        """直接用 subprocess.Popen 启动"""
        BACKEND_LOG_OUT.parent.mkdir(parents=True, exist_ok=True)
        DETACHED = 0x00000008
        NEW_GROUP = 0x00000200
        env = os.environ.copy()
        node_paths = [
            r"C:\Program Files\nodejs",
            os.path.join(os.environ.get("APPDATA", ""), "npm"),
            r"C:\Program Files\Git\cmd",
        ]
        env["PATH"] = ";".join(node_paths) + ";" + env.get("PATH", "")

        cmd = [py_exe] + cmd_args_list
        log("INFO", f"启动后端: {' '.join(cmd[:5])} ...")
        try:
            subprocess.Popen(
                cmd,
                cwd=str(PROJECT_ROOT),
                env=env,
                stdout=open(str(BACKEND_LOG_OUT), "a"),
                stderr=open(str(BACKEND_LOG_ERR), "a"),
                creationflags=(DETACHED | NEW_GROUP) if os.name == "nt" else 0,
                close_fds=True,
            )
        except Exception as e:
            return False, f"启动失败: {e}"

        log("INFO", "等待后端就绪 (最多 30s)...")
        if self._wait_ready(timeout=30):
            return True, f"就绪 port={BACKEND_PORT}"
        return False, "启动超时，请查看 data/backend_stderr.log"

    def _ensure_ganache_port_consistent(self, cfg: Dict[str, Any]) -> None:
        """确保 .env 中 Ganache 端口与 config 一致，防止后端连错端口"""
        env_map = _load_env()
        expected_url = f"http://{GANACHE_HOST}:{GANACHE_PORT}"
        need_update = False

        # 检查 RPC_URL
        cur_url = env_map.get("RPC_URL", "")
        if cur_url and GANACHE_PORT not in cur_url:
            log("WARN", f".env RPC_URL={cur_url} 端口与预期 {GANACHE_PORT} 不一致")
            need_update = True
        # 检查 RPC_LOCAL_PORT
        cur_port = env_map.get("RPC_LOCAL_PORT", "")
        if cur_port and str(cur_port) != str(GANACHE_PORT):
            log("WARN", f".env RPC_LOCAL_PORT={cur_port} 与预期 {GANACHE_PORT} 不一致")
            need_update = True

        if need_update:
            log("WARN", "建议: 修改 .env 中 RPC_URL/RPC_LOCAL_PORT 使后端连接正确的端口")

    def _wait_ready(self, timeout: float = 30) -> bool:
        deadline = time.time() + timeout
        while time.time() < deadline:
            if self.is_running():
                return True
            time.sleep(1.0)
        return self.is_running()

    @staticmethod
    def _find_python() -> Optional[Path]:
        venv_py = PROJECT_ROOT / ".venv" / "Scripts" / "python.exe"
        if venv_py.exists():
            return venv_py
        # fallback: 检查系统 python
        try:
            result = subprocess.run(
                [sys.executable, "-c", "import uvicorn; print(uvicorn.__version__)"],
                capture_output=True, text=True, timeout=3,
                cwd=str(PROJECT_ROOT),
            )
            if result.returncode == 0:
                return Path(sys.executable)
        except Exception:
            pass
        return None

    def stop(self) -> Tuple[bool, str]:
        pid = port_in_use(BACKEND_PORT)
        if pid is None:
            return True, "未运行"
        kill_pid(pid)
        wait_port_free(BACKEND_PORT)
        return True, f"已停止 PID={pid}"

    def health_check(self, cfg: Dict[str, Any]) -> bool:
        return self.is_running()


# ───────────────────────── 全局配置入口 ─────────────────────────

# 延迟赋值，等 load_config() 执行后
GANACHE_HOST = "127.0.0.1"
GANACHE_PORT = 8686
BACKEND_HOST = "0.0.0.0"
BACKEND_PORT = 8000


def _init_globals(cfg: Dict[str, Any]) -> None:
    global GANACHE_HOST, GANACHE_PORT, BACKEND_HOST, BACKEND_PORT
    GANACHE_HOST = cfg["RPC_LOCAL_HOST"]
    GANACHE_PORT = cfg["RPC_LOCAL_PORT"]
    BACKEND_HOST = cfg["HOST"]
    BACKEND_PORT = cfg["PORT"]


# ───────────────────────── 编排 ─────────────────────────

class ServiceManager:
    """编排所有服务的生命周期管理"""

    def __init__(self) -> None:
        self.cfg = load_config()
        _init_globals(self.cfg)
        self.services: List[Service] = [
            RedisService(),
            GanacheService(),
            BackendService(),
        ]

    # ── start ──
    def start(self, use_scheduler: bool = False) -> None:
        mode = "[scheduler] " if use_scheduler else ""
        log("INFO", f"=== {mode}启动所有服务 ===")
        results = []
        for svc in self.services:
            ok, msg = svc.start(self.cfg, use_scheduler=use_scheduler)
            tag = "OK" if ok else "ERR"
            log(tag, f"{svc.name}: {msg}")
            results.append((svc, ok, msg))
        self._print_summary(results)

    # ── stop ──
    def stop(self) -> None:
        log("INFO", "=== 停止所有服务 ===")
        # 反向停止（后端 → Ganache → Redis）
        results = []
        for svc in reversed(self.services):
            ok, msg = svc.stop()
            tag = "OK" if ok else "ERR"
            log(tag, f"{svc.name}: {msg}")
            results.append((svc, ok, msg))
        self._print_summary(results)

    # ── restart ──
    def restart(self, use_scheduler: bool = False) -> None:
        self.stop()
        time.sleep(2)
        self.start(use_scheduler=use_scheduler)

    # ── status ──
    def status(self) -> None:
        log("INFO", "=== 服务状态 ===")
        print()
        all_ok = True
        for svc in self.services:
            running = svc.is_running()
            pid = port_in_use(
                GANACHE_PORT if isinstance(svc, GanacheService)
                else BACKEND_PORT if isinstance(svc, BackendService)
                else 6379
            )
            health = svc.health_check(self.cfg)
            ok_mark = "\033[92m✅\033[0m" if health else "\033[91m❌\033[0m"
            pid_str = f" PID={pid}" if pid else ""
            if not health:
                all_ok = False
            print(f"  {ok_mark} {svc.name:8s}  running={running}  healthy={health}{pid_str}")
        print()
        overall = "\033[92m全部正常\033[0m" if all_ok else "\033[91m存在异常\033[0m"
        log("INFO", f"总体状态: {overall}")

    # ── test ──
    def test(self) -> int:
        """完整测试闭环: 停 → 启 → 验证 → 停 → 报告"""
        log("INFO", "============ 完整测试闭环 ============")

        # Step 1: 先停干净
        log("INFO", "[1/5] 清理旧进程 ...")
        self.stop()
        time.sleep(2)

        # Step 2: 启动
        log("INFO", "[2/5] 启动所有服务 ...")
        self.start()
        time.sleep(3)

        # Step 3: 逐项验证
        log("INFO", "[3/5] 健康检查 ...")
        checks = {
            "Redis (6379)": port_in_use(6379) is not None,
            f"Ganache RPC ({GANACHE_PORT})": self._test_ganache_rpc(),
            f"Backend HTTP ({BACKEND_PORT})": self._test_backend_http(),
        }
        passed = 0
        for name, ok in checks.items():
            tag = "OK" if ok else "ERR"
            log(tag, f"  {name}")
            if ok:
                passed += 1
        total = len(checks)

        # Step 4: 停止
        log("INFO", "[4/5] 停止所有服务 ...")
        self.stop()

        # Step 5: 报告
        log("INFO", f"[5/5] 测试结果: {passed}/{total} 通过")
        if passed == total:
            log("OK", "🎉 全部通过!")
            return 0
        else:
            log("ERR", "❌ 存在失败项，请检查日志")
            return 1

    # ── 验证辅助 ──
    def _test_ganache_rpc(self) -> bool:
        try:
            import requests
            r = requests.post(
                f"http://{GANACHE_HOST}:{GANACHE_PORT}",
                json={"jsonrpc": "2.0", "method": "eth_blockNumber", "params": [], "id": 1},
                timeout=3,
            )
            return r.status_code == 200 and "result" in r.json()
        except Exception as e:
            log("DIM", f"  Ganache RPC error: {e}")
            return False

    def _test_backend_http(self) -> bool:
        try:
            import requests
            # 测试 /docs 和根路径
            for path in ("/docs", "/"):
                r = requests.get(f"http://127.0.0.1:{BACKEND_PORT}{path}", timeout=3)
                if r.status_code != 200:
                    log("DIM", f"  Backend {path} returned {r.status_code}")
                    return False
            return True
        except Exception as e:
            log("DIM", f"  Backend HTTP error: {e}")
            return False

    # ── 内部 ──
    @staticmethod
    def _print_summary(results: List[Tuple[Service, bool, str]]) -> None:
        total = len(results)
        ok_count = sum(1 for _, ok, _ in results if ok)
        log("INFO", f"完成 {ok_count}/{total} 项")


# ───────────────────────── CLI 入口 ─────────────────────────

def main() -> int:
    if len(sys.argv) < 2:
        print(__doc__)
        return 0

    # 解析 --scheduler 全局选项
    args = sys.argv[1:]
    use_scheduler = False
    if "--scheduler" in args:
        use_scheduler = True
        args = [a for a in args if a != "--scheduler"]

    if not args:
        print(__doc__)
        return 0

    cmd = args[0].lower()
    mgr = ServiceManager()

    actions = {
        "start": lambda: mgr.start(use_scheduler=use_scheduler),
        "stop": mgr.stop,
        "restart": lambda: mgr.restart(use_scheduler=use_scheduler),
        "status": mgr.status,
        "test": lambda: sys.exit(mgr.test()),
    }

    if cmd not in actions:
        print(f"未知命令: {cmd}")
        print(__doc__)
        return 1

    actions[cmd]()
    return 0


if __name__ == "__main__":
    sys.exit(main())
