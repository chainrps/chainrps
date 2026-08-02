"""
本地链管理服务

管理 Ganache 本地测试链：启动/停止/状态检查/账户管理/代币分发

说明："本地链"即本地测试链（Local Chain），同时也寓意"连胜"。
"""
import logging
import os
import json
import shutil
import subprocess
import threading
import time
from typing import Optional, List, Dict, Any

logger = logging.getLogger(__name__)

from web3 import Web3
from web3.exceptions import TimeExhausted

from rps_backend.config import RPC_CHAIN_ID, RPC_URL, RPC_LOCAL_PORT, RPC_LOCAL_BALANCE, RPC_LOCAL_SYMBOL, \
    RPC_LOCAL_ACCOUNT_COUNT, RPC_LOCAL_NETWORK

# RPC 连接配置
RPC_TIMEOUT = 15  # 连接超时时间（秒）
RPC_READ_TIMEOUT = 30  # 读取超时时间（秒）
MAX_RETRY_ATTEMPTS = 3  # 最大重试次数
RETRY_DELAY = 2  # 重试间隔（秒）


# 重试装饰器
def retry_on_failure(max_attempts: int = MAX_RETRY_ATTEMPTS, delay: float = RETRY_DELAY):
    def decorator(func):
        def wrapper(*args, **kwargs):
            last_exception = None
            for attempt in range(max_attempts):
                try:
                    return func(*args, **kwargs)
                except Exception as e:
                    last_exception = e
                    if attempt < max_attempts - 1:
                        time.sleep(delay)
            raise last_exception if last_exception else Exception("重试次数耗尽")

        return wrapper

    return decorator


# 创建带超时的 HTTPProvider
def _create_http_provider(rpc_url: str) -> Web3.HTTPProvider:
    """创建带有超时配置的 HTTPProvider"""
    return Web3.HTTPProvider(
        rpc_url,
        request_kwargs={
            "timeout": (RPC_TIMEOUT, RPC_READ_TIMEOUT)  # (连接超时, 读取超时)
        }
    )


# 查找 ganache 可执行文件
def _find_ganache_executable() -> Optional[str]:
    """
    在 Windows 上查找可执行的 ganache 命令路径。

    Python subprocess.Popen 不使用 shell=True 时无法直接执行 .ps1/.cmd 脚本，
    需要找到完整的 .cmd 或 .exe 路径。
    """
    # shutil.which 会按 PATHEXT 查找，优先返回 .cmd/.exe 而非 .ps1
    for name in ("ganache.cmd", "ganache.exe", "ganache.bat", "ganache"):
        path = shutil.which(name)
        if path:
            # 跳过 .ps1，因为 subprocess 无法直接执行
            if not path.lower().endswith(".ps1"):
                return path
    # 回退：尝试 npm 全局目录
    npm_prefix = os.path.expanduser("~\\AppData\\Roaming\\npm")
    for ext in (".cmd", ".exe", ""):
        candidate = os.path.join(npm_prefix, "ganache" + ext)
        if os.path.exists(candidate) and not candidate.lower().endswith(".ps1"):
            return candidate
    return None


# 查找 npx 可执行文件（用于启动 hardhat）
def _find_npx_executable() -> Optional[str]:
    """查找 npx 命令路径。"""
    for name in ("npx.cmd", "npx.exe", "npx"):
        path = shutil.which(name)
        if path and not path.lower().endswith(".ps1"):
            return path
    return shutil.which("npx")


# 获取项目根目录（hardhat 需要在项目目录中运行）
def _get_project_root() -> str:
    """获取项目根目录，用于 hardhat 启动时的 cwd。"""
    # 从当前文件向上回溯到项目根目录
    current_file = os.path.abspath(__file__)
    # rps_backend/service/local_chain_service.py -> 向上 3 层到项目根
    project_root = os.path.dirname(os.path.dirname(os.path.dirname(current_file)))
    return project_root


# 本地链管理服务
class LocalChainService:
    _instance = None
    _process: Optional[subprocess.Popen] = None
    _accounts: List[str] = []
    _private_keys: List[str] = []
    _rpc_url: str = RPC_URL
    _chain_id: int = RPC_CHAIN_ID
    _w3: Optional[Web3] = None
    _tokens: Dict[str, Dict[str, Any]] = {}

    _chain_type: str = "ganache"  # "ganache" | "hardhat"
    _persist_enabled: bool = True  # 是否启用持久化存储（仅 Ganache 生效）

    _keep_alive_enabled: bool = False
    _keep_alive_config: Dict[str, Any] = {}
    _keep_alive_thread: Optional[threading.Thread] = None
    _keep_alive_stop_event: Optional[threading.Event] = None
    _keep_alive_restart_count: int = 0
    _keep_alive_last_restart_at: Optional[float] = None
    _keep_alive_lock: threading.Lock = threading.Lock()

    # 单例模式实例化
    def __new__(cls):
        if cls._instance is None:
            cls._instance = super().__new__(cls)
            cls._instance._init_web3()
        return cls._instance

    # 独立 HTTP 健康检测（不依赖 web3.py 会话，防止僵尸连接干扰）
    def _check_http_health(self, timeout: int = 2) -> bool:
        """
        使用独立的 HTTP 请求检测 RPC 节点是否真正存活。
        
        不使用 self._w3，因为 web3.py 的 Session 可能持有僵尸连接，
        导致进程存活但 HTTP 假死的误判。
        """
        try:
            import requests
            r = requests.post(
                self._rpc_url,
                json={"jsonrpc": "2.0", "method": "eth_blockNumber", "params": [], "id": 1},
                timeout=timeout,
            )
            return r.status_code == 200 and "result" in r.json()
        except Exception:
            return False

    # 初始化 Web3 连接
    def _init_web3(self):
        try:
            if self._w3 is not None:
                try:
                    old_provider = self._w3.provider
                    if hasattr(old_provider, 'session') and old_provider.session:
                        old_provider.session.close()
                except Exception:
                    pass
            self._w3 = Web3(_create_http_provider(self._rpc_url))
            if self._w3.is_connected():
                try:
                    self._chain_id = self._w3.eth.chain_id
                except Exception:
                    pass
                self._load_accounts()
                self._load_tokens_from_db()
            else:
                self._w3 = None
        except Exception:
            self._w3 = None

    # 测试 RPC 连接是否稳定
    def _test_rpc_connection(self) -> bool:
        """测试 RPC 连接是否稳定，执行多个基础调用"""
        if not self._w3:
            return False
        try:
            self._w3.eth.chain_id
            self._w3.eth.block_number
            return True
        except Exception:
            return False

    # 加载账户列表
    def _load_accounts(self):
        try:
            self._accounts = self._w3.eth.accounts
        except Exception:
            self._accounts = []

    # 从数据库加载代币信息
    def _load_tokens_from_db(self):
        try:
            from rps_backend.repository import list_contracts
            contracts = list_contracts(network="localhost")
            # 先清空内存中的代币缓存（DB 是权威来源，防止旧缓存覆盖）
            self._tokens.clear()
            # list_contracts ORDER BY id DESC，同一 symbol 只保留第一次出现（最新的）
            seen_symbols = set()
            for c in contracts:
                name = c.get("name", "")
                if name.startswith("Mock") or name in ["USDC", "MockERC20"]:
                    symbol = name.replace("Mock ", "")
                    if symbol in seen_symbols:
                        # DB 中可能有多条同名记录（如多次重新部署），旧的丢弃
                        continue
                    seen_symbols.add(symbol)
                    addr = c.get("address")
                    # 额外验证：链上合约是否真正存在（防止残留历史记录指向已重置的链地址）
                    if self._w3 and addr:
                        try:
                            code = self._w3.eth.get_code(self._w3.to_checksum_address(addr))
                            if not code or code == b'' or code == b'0x':
                                # 跳过链上无效的历史记录
                                continue
                        except Exception:
                            pass  # 验证失败仍尝试保留，让调用方后续再次验证
                    self._tokens[symbol] = {
                        "address": addr,
                        "name": name,
                        "symbol": symbol,
                        "decimals": 6,
                    }
        except Exception:
            pass  # 别删除，用于人工代码审核 便利

    # 检查本地链是否运行（快速 HTTP 检测优先，防止假死误判）
    def is_running(self) -> bool:
        http_ok = self._check_http_health(timeout=3)
        if http_ok:
            if not self._w3:
                try:
                    self._init_web3()
                except Exception:
                    pass
            if self._w3:
                try:
                    self._chain_id = self._w3.eth.chain_id
                except Exception:
                    pass
            return True

        # 进程存活但 HTTP 短暂无响应：不立即清理，仅返回 False
        # 保活巡检会通过连续失败次数判断是否真正假死
        if self._process and self._process.poll() is None:
            return False

        try:
            if not self._w3:
                self._init_web3()
            if self._w3 and self._w3.is_connected():
                return self._test_rpc_connection()
        except Exception:
            pass
        return False

    # 启动本地链节点
    def start_node(
        self,
        deterministic: bool = True,
        host: str = "127.0.0.1",
        port: int = RPC_LOCAL_PORT,
        chain_id: int = RPC_CHAIN_ID,
        accounts_count: int = 10,
        default_balance: float = 100000,      # 每个账户的默认原生代币余额
        symbol: str = RPC_LOCAL_SYMBOL,
        chain_type: str = "ganache",
        persist: bool = True,                 # 是否启用持久化存储（仅 Ganache 支持）
    ) -> Dict[str, Any]:
        if self.is_running():
            # 链已在运行（持久化恢复）：确保 USDC 合约在链上有效
            # （防止 DB 残留旧合约地址但链数据已重置导致转账失败）
            try:
                usdc_result = self.ensure_usdc_ready()
                if usdc_result.get("success"):
                    if usdc_result.get("deployed"):
                        print(f"💰 {usdc_result.get('message', 'USDC 已重新部署并分发')}")
                else:
                    print(f"⚠️  USDC 就绪检查失败: {usdc_result.get('message')}")
            except Exception as e:
                print(f"⚠️  USDC 就绪检查异常: {e}")
            return {"success": True, "message": "本地链已在运行", "rpc_url": self._rpc_url}

        self._chain_type = chain_type
        self._persist_enabled = bool(persist) and chain_type == "ganache"

        try:
            if chain_type == "hardhat":
                # Hardhat node 原生不支持持久化存储，强制忽略 persist
                if persist:
                    print("⚠️  Hardhat node 不支持持久化存储，已自动忽略 persist 参数")
                return self._start_hardhat_node(
                    host=host, port=port, chain_id=chain_id,
                    accounts_count=accounts_count, default_balance=default_balance,
                    symbol=symbol,
                )
            else:
                return self._start_ganache_node(
                    deterministic=deterministic, host=host, port=port,
                    chain_id=chain_id, accounts_count=accounts_count,
                    default_balance=default_balance, symbol=symbol,
                    persist=self._persist_enabled,
                )
        except Exception as e:
            import traceback
            error_trace = traceback.format_exc()
            print(f"🔴 启动本地链异常: {error_trace}")
            return {"success": False, "message": f"启动失败: {str(e)}"}

    # 获取链数据持久化目录路径
    def _get_chain_data_dir(self) -> str:
        """获取本地链数据持久化目录路径。

        目录位于项目根目录下的 data/chaindata_<chain_type>，按链类型隔离避免冲突。
        """
        project_root = _get_project_root()
        data_dir = os.path.join(project_root, "data", f"chaindata_{self._chain_type or 'ganache'}")
        os.makedirs(data_dir, exist_ok=True)
        return data_dir

    # 重置（清空）链数据持久化目录
    def reset_chain_data(self) -> Dict[str, Any]:
        """清空持久化链数据目录。

        停止运行中的节点 → 删除数据目录 → 重新创建空目录。
        重启后链状态将恢复到初始（创世）状态，已部署合约将丢失。
        """
        try:
            # 必须先停止节点，否则文件占用无法删除
            if self.is_running():
                print("🛑 重置链数据：先停止运行中的节点")
                self.stop_node(keep_alive=True)

            data_dir = self._get_chain_data_dir()
            if os.path.exists(data_dir):
                # 重试机制：Windows 下文件可能被短暂占用
                last_err = None
                for attempt in range(3):
                    try:
                        shutil.rmtree(data_dir, ignore_errors=False)
                        last_err = None
                        break
                    except Exception as e:
                        last_err = e
                        time.sleep(1)
                if last_err:
                    return {"success": False, "message": f"删除数据目录失败: {last_err}"}
                print(f"🗑️  已清空链数据目录: {data_dir}")

            os.makedirs(data_dir, exist_ok=True)
            return {"success": True, "message": "链数据已重置，下次启动将使用全新状态"}
        except Exception as e:
            return {"success": False, "message": f"重置失败: {str(e)}"}

    # 启动 Ganache 节点
    def _start_ganache_node(
        self,
        deterministic: bool = True,
        host: str = "127.0.0.1",
        port: int = RPC_LOCAL_PORT,
        chain_id: int = RPC_CHAIN_ID,
        accounts_count: int = 10,
        default_balance: float = 1000,
        symbol: str = RPC_LOCAL_SYMBOL,
            persist: bool = True,
    ) -> Dict[str, Any]:
        ganache_path = _find_ganache_executable()
        if not ganache_path:
            return {
                "success": False,
                "message": "未找到 ganache 可执行文件。请先安装: npm install -g ganache",
            }
        print(f"🔍 找到 ganache 路径: {ganache_path}")

        cmd = [ganache_path]
        cmd.extend(["--server.host", host])
        cmd.extend(["--server.port", str(port)])
        cmd.extend(["--chain.chainId", str(chain_id)])
        if deterministic:
            cmd.append("--wallet.deterministic")
        cmd.extend(["--wallet.totalAccounts", str(accounts_count)])
        cmd.extend(["--wallet.defaultBalance", str(default_balance)])

        # 持久化存储：将链数据写入磁盘，重启后保留已部署合约和状态
        # 仅在 persist=True 时启用，目录按 chain_type 隔离
        if persist:
            data_dir = self._get_chain_data_dir()
            cmd.extend(["--database.dbPath", data_dir])
            print(f"💾 持久化存储已启用: {data_dir}")

        print(f"🚀 启动 ganache: {' '.join(cmd)}")

        # 输出重定向到 DEVNULL，避免管道缓冲区写满导致进程死锁
        # 若需排查启动失败，依赖进程退出码 + RPC 健康检测判断
        self._process = subprocess.Popen(
            cmd,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0) if os.name == "nt" else 0,
        )

        self._rpc_url = f"http://{host}:{port}"
        self._chain_id = chain_id

        return self._wait_node_ready(
            chain_type="ganache",
            host=host, port=port, chain_id=chain_id,
            accounts_count=accounts_count, default_balance=default_balance,
            symbol=symbol,
        )

    # 启动 Hardhat 节点
    def _start_hardhat_node(
        self,
        host: str = "127.0.0.1",
        port: int = RPC_LOCAL_PORT,
            chain_id: int = RPC_CHAIN_ID,
            accounts_count: int = RPC_LOCAL_ACCOUNT_COUNT,
            default_balance: float = RPC_LOCAL_BALANCE,
            symbol: str = RPC_LOCAL_SYMBOL,
    ) -> Dict[str, Any]:
        npx_path = _find_npx_executable()
        if not npx_path:
            return {
                "success": False,
                "message": "未找到 npx 命令。请先安装 Node.js 和 npm",
            }

        project_root = _get_project_root()
        print(f"🔍 项目根目录: {project_root}")

        cmd = [npx_path, "hardhat", "node"]
        cmd.extend(["--port", str(port)])
        cmd.extend(["--hostname", host])
        # 始终传递 --chain-id，确保命令行参数覆盖默认配置
        cmd.extend(["--chain-id", str(chain_id)])

        print(f"🚀 启动 hardhat node: {' '.join(cmd)}")

        # 输出重定向到 DEVNULL，避免管道缓冲区写满导致进程死锁
        self._process = subprocess.Popen(
            cmd,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            cwd=project_root,
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0) if os.name == "nt" else 0,
        )

        self._rpc_url = f"http://{host}:{port}"
        self._chain_id = chain_id

        return self._wait_node_ready(
            chain_type="hardhat",
            host=host, port=port, chain_id=chain_id,
            accounts_count=accounts_count, default_balance=default_balance,
            symbol=symbol,
        )

    # 等待节点启动完成（通用逻辑）
    def _wait_node_ready(
            self,
            chain_type: str,
            host: str,
            port: int,
            chain_id: int,
            accounts_count: int,
            default_balance: float,
            symbol: str,
    ) -> Dict[str, Any]:
        max_wait_time = 15
        wait_interval = 1
        elapsed_time = 0

        while elapsed_time < max_wait_time:
            if self._process.poll() is not None:
                # 进程已退出，通过返回码判断错误（输出已重定向到 DEVNULL，无法读取）
                return_code = self._process.returncode
                return {"success": False,
                        "message": f"{chain_type} 进程已退出（返回码: {return_code}），请检查命令参数或端口占用"}

            try:
                self._init_web3()
                if self._w3 and self._w3.is_connected() and self._test_rpc_connection():
                    break
            except Exception:
                pass

            time.sleep(wait_interval)
            elapsed_time += wait_interval

        if elapsed_time >= max_wait_time:
            return {"success": False, "message": f"等待节点启动超时（{max_wait_time}秒），RPC 连接失败"}

        if self._w3 and self._w3.is_connected():
            try:
                actual_chain_id = self._w3.eth.chain_id
                self._chain_id = actual_chain_id
            except Exception:
                pass

            self._keep_alive_config = {
                "chain_type": chain_type,
                "host": host,
                "port": port,
                "chain_id": self._chain_id,
                "accounts_count": accounts_count,
                "default_balance": default_balance,
                "symbol": symbol,
            }

            # 创世时自动部署 USDC 并向所有账户分发等额代币（默认结算币）
            # 仅在全新链（非持久化恢复）时自动部署；持久化恢复时 USDC 已在 DB 中
            usdc_result = None
            try:
                usdc_result = self.deploy_and_distribute_usdc(
                    from_index=0,
                    per_account_amount=default_balance,  # 与原生代币余额一致
                )
                if usdc_result.get("success"):
                    print(f"💰 {usdc_result['message']}")
                else:
                    print(f"⚠️  USDC 自动部署/分发失败: {usdc_result.get('message')}")
            except Exception as e:
                print(f"⚠️  USDC 自动部署/分发异常: {e}")
                usdc_result = {"success": False, "message": str(e)}

            return {
                "success": True,
                "message": "本地链启动成功",
                "rpc_url": self._rpc_url,
                "chain_id": self._chain_id,
                "accounts_count": len(self._accounts),
                "symbol": symbol,
                "default_balance": default_balance,
                "host": host,
                "port": port,
                "chain_type": chain_type,
                "usdc_distribution": usdc_result,
            }
        else:
            # 进程存活但 RPC 连不上，不读取管道（避免阻塞）
            return {"success": False, "message": "本地链进程已启动但 RPC 无法连接，进程可能仍在初始化中"}

    # 停止本地链节点
    def stop_node(self, keep_alive: bool = None) -> Dict[str, Any]:
        try:
            # 停止时如果未指定保活状态，则自动关闭保活（用户主动停止不需要保活）
            if keep_alive is None:
                self._keep_alive_enabled = False
            # 1. 如果是通过本服务启动的子进程，直接终止
            if self._process and self._process.poll() is None:
                self._process.terminate()
                try:
                    self._process.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    self._process.kill()
                    self._process.wait(timeout=3)
                self._process = None

            # 2. 通过端口查找并杀掉占用 RPC_LOCAL_PORT 的进程（Windows）
            killed_by_port = False
            if os.name == "nt":
                try:
                    # 用 netstat 查找占用 RPC_LOCAL_PORT 端口的 PID
                    netstat = subprocess.run(
                        ["netstat", "-ano", "-p", "TCP"],
                        capture_output=True, text=True, timeout=5,
                    )
                    pids = set()
                    for line in netstat.stdout.splitlines():
                        if f":{RPC_LOCAL_PORT}" in line and "LISTENING" in line:
                            parts = line.split()
                            if parts:
                                pid = parts[-1]
                                if pid.isdigit() and int(pid) > 0:
                                    pids.add(pid)
                    for pid in pids:
                        try:
                            subprocess.run(
                                ["taskkill", "/PID", pid, "/F"],
                                capture_output=True, timeout=5,
                            )
                            killed_by_port = True
                        except Exception:
                            pass  # 别删除，用于人工代码审核 便利
                except Exception:
                    pass  # 别删除，用于人工代码审核 便利
            else:
                # Linux/Mac: 用 fuser 或 lsof
                try:
                    subprocess.run(
                        ["fuser", "-k", f"{RPC_LOCAL_PORT}/tcp"],
                        capture_output=True, timeout=5,
                    )
                    killed_by_port = True
                except Exception:
                    pass  # 别删除，用于人工代码审核 便利

            # 3. 尝试通过 RPC 关闭（备用）
            try:
                import requests
                requests.post(
                    self._rpc_url,
                    json={"jsonrpc": "2.0", "method": "ganache_setServerStatus", "params": ["closed"], "id": 1},
                    timeout=2,
                )
            except Exception:
                pass  # 别删除，用于人工代码审核 便利

            # 4. 清理 Web3 连接
            self._w3 = None
            self._accounts = []

            # 等待端口释放
            time.sleep(1)

            # 验证是否真正停止
            try:
                test_w3 = Web3(_create_http_provider(self._rpc_url))
                if test_w3.is_connected():
                    return {"success": False, "message": "本地链仍在运行，请手动关闭 Ganache 进程"}
            except Exception:
                pass  # 别删除，用于人工代码审核 便利

            return {"success": True, "message": "本地链已停止"}
        except Exception as e:
            return {"success": False, "message": f"停止失败: {str(e)}"}

    # 获取节点状态
    def get_node_status(self) -> Dict[str, Any]:
        running = self.is_running()
        # 代币符号：统一读取系统配置 native_symbol，避免与 #/config 中的设置不一致
        # 说明：Ganache v7.9.2 不支持 --chain.nativeTokenSymbol 参数，节点本身默认返回 "GO"，
        # 因此这里返回系统配置的 native_symbol，确保前端展示与 #/config 配置一致
        try:
            from rps_backend.repository import get_system_config_value
            configured_symbol = get_system_config_value("native_symbol") or RPC_LOCAL_SYMBOL
            recommended_chain_name = get_system_config_value("recommended_chain_name") or RPC_LOCAL_NETWORK
        except Exception:
            configured_symbol = (self._keep_alive_config.get("symbol") if self._keep_alive_config else None) or RPC_LOCAL_SYMBOL
            recommended_chain_name = f"Localhost {RPC_LOCAL_PORT}"
        # 持久化支持信息：仅 Ganache 支持，Hardhat 始终为 False
        persist_supported = self._chain_type != "hardhat"
        persist_enabled = bool(self._persist_enabled) and persist_supported

        result = {
            "running": running,
            "rpc_url": self._rpc_url,
            "chain_id": self._chain_id,
            "chain_type": self._chain_type,
            "symbol": configured_symbol,
            "recommended_chain_name": recommended_chain_name,
            "keep_alive": self._keep_alive_enabled,
            "keep_alive_restart_count": self._keep_alive_restart_count,
            "keep_alive_last_restart_at": self._keep_alive_last_restart_at,
            "persist_supported": persist_supported,
            "persist_enabled": persist_enabled,
            "persist_data_dir": self._get_chain_data_dir() if persist_supported else None,
        }

        if running and self._w3:
            try:
                # 始终读取节点真实 chain_id，避免返回过期的缓存值
                actual_chain_id = self._w3.eth.chain_id
                self._chain_id = actual_chain_id
                result["chain_id"] = actual_chain_id

                block_number = self._w3.eth.block_number
                gas_price = self._w3.eth.gas_price
                result.update({
                    "block_number": block_number,
                    "gas_price": self._w3.from_wei(gas_price, 'gwei'),
                    "accounts_count": len(self._accounts),
                })
            except Exception as e:
                result["error"] = str(e)

        return result

    # 获取账户列表（含原生币和 USDC 余额）
    def get_accounts(self) -> List[Dict[str, Any]]:
        if not self.is_running() or not self._w3:
            return []

        # 确保 USDC 合约就绪（持久化恢复场景下 DB 可能残留无效地址）
        try:
            self.ensure_usdc_ready()
        except Exception:
            pass  # 别删除，用于人工代码审核 便利

        # 查找 USDC 合约（用于批量查询余额）
        usdc_contract = None
        usdc_decimals = 6
        usdc_addr = None
        usdc_token = self._tokens.get("USDC")
        if usdc_token:
            usdc_addr = usdc_token.get("address")
            try:
                abi_json = [
                    {"inputs": [{"name": "account", "type": "address"}],
                     "name": "balanceOf", "outputs": [{"name": "", "type": "uint256"}],
                     "stateMutability": "view", "type": "function"},
                    {"inputs": [], "name": "decimals", "outputs": [{"name": "", "type": "uint8"}],
                     "stateMutability": "view", "type": "function"},
                ]
                # address 归一化为 checksum，避免大小写不一致导致合约实例绑定到错误地址
                usdc_checksum = self._w3.to_checksum_address(usdc_addr)
                usdc_contract = self._w3.eth.contract(address=usdc_checksum, abi=abi_json)
                try:
                    usdc_decimals = int(usdc_contract.functions.decimals().call())
                except Exception as e:
                    print(f"⚠️  USDC decimals 查询失败（地址 {usdc_checksum}）: {e}，使用默认 6")
                    usdc_decimals = 6
            except Exception as e:
                print(f"⚠️  初始化 USDC 余额查询合约失败（地址 {usdc_addr}）: {e}")
                usdc_contract = None
        else:
            # 兜底：再次确保 USDC 就绪（ensure_usdc_ready 可能被异常吞掉没真正执行）
            try:
                r = self.ensure_usdc_ready()
                if r.get("success"):
                    usdc_token = self._tokens.get("USDC")
                    if usdc_token:
                        usdc_addr = usdc_token.get("address")
                        try:
                            abi_json = [
                                {"inputs": [{"name": "account", "type": "address"}],
                                 "name": "balanceOf", "outputs": [{"name": "", "type": "uint256"}],
                                 "stateMutability": "view", "type": "function"},
                                {"inputs": [], "name": "decimals", "outputs": [{"name": "", "type": "uint8"}],
                                 "stateMutability": "view", "type": "function"},
                            ]
                            usdc_checksum = self._w3.to_checksum_address(usdc_addr)
                            usdc_contract = self._w3.eth.contract(address=usdc_checksum, abi=abi_json)
                            usdc_decimals = int(usdc_contract.functions.decimals().call())
                        except Exception as e2:
                            print(f"⚠️  兜底初始化 USDC 合约失败: {e2}")
            except Exception as e:
                print(f"⚠️  兜底 ensure_usdc_ready 异常: {e}")

        accounts_info = []
        balance_err_count = 0
        last_balance_err = None
        for i, addr in enumerate(self._accounts):
            try:
                balance_wei = self._w3.eth.get_balance(addr)
                balance_eth = self._w3.from_wei(balance_wei, 'ether')

                # 查询 USDC 余额
                balance_usdc = 0
                if usdc_contract:
                    try:
                        raw = usdc_contract.functions.balanceOf(addr).call()
                        balance_usdc = raw / (10 ** usdc_decimals)
                    except Exception as e:
                        balance_usdc = 0
                        balance_err_count += 1
                        last_balance_err = str(e)

                accounts_info.append({
                    "index": i,
                    "address": addr,
                    "balance_eth": float(balance_eth),
                    "balance_usdc": float(balance_usdc),
                    "private_key": self._private_keys[i] if i < len(self._private_keys) else None,
                })
            except Exception:
                accounts_info.append({
                    "index": i,
                    "address": addr,
                    "balance_eth": 0,
                    "balance_usdc": 0,
                    "private_key": None,
                })

        if balance_err_count > 0:
            print(f"⚠️  USDC 余额查询异常 {balance_err_count}/{len(self._accounts)} 次，USDC 合约地址: {usdc_addr}，首个错误: {last_balance_err}")

        return accounts_info

    # 发送 ETH（带重试机制）
    def send_eth(self, from_index: int, to_address: str, amount_eth: float) -> Dict[str, Any]:
        if not self.is_running() or not self._w3:
            return {"success": False, "message": "本地链未运行"}

        last_error = None
        for attempt in range(MAX_RETRY_ATTEMPTS):
            try:
                # 每次重试前检查并重新建立连接
                if not self._w3 or not self._w3.is_connected():
                    self._init_web3()
                    if not self._w3 or not self._w3.is_connected():
                        raise Exception("无法重新建立 RPC 连接")

                # 账户列表可能为空或过期（节点重启后），每次重试都重新加载
                if not self._accounts:
                    self._load_accounts()
                if not self._accounts:
                    raise Exception("无法获取本地链账户列表")

                if from_index < 0 or from_index >= len(self._accounts):
                    raise Exception(f"账户索引无效: {from_index}（当前共 {len(self._accounts)} 个账户）")

                from_address = self._accounts[from_index]
                to_address = self._w3.to_checksum_address(to_address)
                value = self._w3.to_wei(amount_eth, 'ether')

                # 显式指定 gas 和 gasPrice，避免 Ganache 在估算大额转账时挂起
                tx_hash = self._w3.eth.send_transaction({
                    "from": from_address,
                    "to": to_address,
                    "value": value,
                    "gas": 21000,
                    "gasPrice": self._w3.to_wei(20, 'gwei'),
                })

                # 缩短等待超时，本地节点交易应秒级确认
                receipt = self._w3.eth.wait_for_transaction_receipt(tx_hash, timeout=15)
                new_balance = self._w3.eth.get_balance(to_address)
                new_balance_eth = float(self._w3.from_wei(new_balance, 'ether'))

                return {
                    "success": True,
                    "message": "转账成功",
                    "tx_hash": '0x' + tx_hash.hex(),
                    "from": from_address,
                    "to": to_address,
                    "amount_eth": amount_eth,
                    "new_balance_eth": new_balance_eth,
                    "block_number": receipt.blockNumber,
                }
            except Exception as e:
                last_error = str(e)
                if attempt < MAX_RETRY_ATTEMPTS - 1:
                    time.sleep(RETRY_DELAY)

        return {"success": False, "message": f"转账失败: {last_error}"}

    # 部署 Mock ERC20 代币
    def deploy_mock_erc20(
            self,
            from_index: int = 0,
            name: str = "Mock USDC",
            symbol: str = "USDC",
            decimals: int = 6,
            initial_supply: int = 1_000_000,
    ) -> Dict[str, Any]:
        if not self.is_running() or not self._w3:
            return {"success": False, "message": "本地链未运行"}

        abi = None
        bytecode = None
        project_root = os.path.dirname(os.path.dirname(os.path.dirname(__file__)))

        try:
            abi_path = os.path.join(project_root, "contracts", "abi", "MockERC20.json")
            if os.path.exists(abi_path):
                with open(abi_path, "r", encoding="utf-8") as f:
                    data = json.load(f)
                if isinstance(data, dict) and "abi" in data and "bytecode" in data:
                    abi = data["abi"]
                    bytecode = data["bytecode"]
        except Exception:
            pass  # 别删除，用于人工代码审核 便利

        if not abi or not bytecode:
            try:
                import solcx
                src_path = os.path.join(project_root, "contracts", "src", "MockERC20.sol")
                oz_base = os.path.join(project_root, "contracts", "lib", "openzeppelin-contracts")

                with open(src_path, "r", encoding="utf-8") as f:
                    source_content = f.read()

                input_json = {
                    "language": "Solidity",
                    "sources": {"MockERC20.sol": {"content": source_content}},
                    "settings": {
                        "outputSelection": {"*": {"*": ["abi", "evm.bytecode.object"]}},
                        "optimizer": {"enabled": True, "runs": 200},
                    },
                }

                def _import_cb(path: str):
                    if path.startswith("@openzeppelin/"):
                        rel = path.replace("@openzeppelin/", "")
                        full = os.path.join(oz_base, rel)
                        if os.path.exists(full):
                            with open(full, "r", encoding="utf-8") as f2:
                                return {"contents": f2.read()}
                    return None

                compiled = solcx.compile_standard(
                    input_json,
                    allow_paths=[oz_base],
                    import_callback=_import_cb,
                )

                for contract_name, contract_data in compiled["contracts"]["MockERC20.sol"].items():
                    if contract_name == "MockERC20":
                        abi = contract_data["abi"]
                        bytecode = contract_data["evm"]["bytecode"]["object"]
                        break
            except Exception:
                pass  # 别删除，用于人工代码审核 便利

        if not abi or not bytecode:
            return {"success": False, "message": "无法获取合约编译产物"}

        last_error = None
        for attempt in range(MAX_RETRY_ATTEMPTS):
            try:
                if not self._w3 or not self._w3.is_connected():
                    self._init_web3()
                    if not self._w3 or not self._w3.is_connected():
                        raise Exception("无法重新建立 RPC 连接")

                # 账户列表可能为空或过期，每次重试都重新加载
                if not self._accounts:
                    self._load_accounts()
                if not self._accounts:
                    raise Exception("无法获取本地链账户列表")

                if from_index < 0 or from_index >= len(self._accounts):
                    raise Exception(f"账户索引无效: {from_index}（当前共 {len(self._accounts)} 个账户）")

                from_address = self._accounts[from_index]
                contract = self._w3.eth.contract(abi=abi, bytecode=bytecode)
                supply_wei = initial_supply * (10 ** decimals)

                # 先估算 gas，加上 20% 安全余量，避免 Ganache 在 transact 内部估算时挂起
                try:
                    estimated_gas = contract.constructor(name, symbol, decimals, supply_wei).estimate_gas(
                        {"from": from_address})
                    gas_limit = int(estimated_gas * 1.2)
                except Exception:
                    gas_limit = 3000000  # 合约部署默认 3M gas

                tx_hash = contract.constructor(name, symbol, decimals, supply_wei).transact({
                    "from": from_address,
                    "gas": gas_limit,
                    "gasPrice": self._w3.to_wei(20, 'gwei'),
                })
                receipt = self._w3.eth.wait_for_transaction_receipt(tx_hash, timeout=30)
                contract_address = receipt.contractAddress

                self._tokens[symbol] = {
                    "address": contract_address,
                    "name": name,
                    "symbol": symbol,
                    "decimals": decimals,
                }

                try:
                    from rps_backend.repository import add_contract_record
                    add_contract_record({
                        "name": name,
                        "address": contract_address,
                        "version": "v1.0.0",
                        "network": "localhost",
                        "abi": json.dumps(abi),
                        "description": f"Mock ERC20 代币 - {name}",
                        "deployed_by": from_address,
                        "status": "active",
                    })
                except Exception:
                    pass

                return {
                    "success": True,
                    "message": f"{symbol} 部署成功",
                    "address": contract_address,
                    "name": name,
                    "symbol": symbol,
                    "decimals": decimals,
                    "initial_supply": initial_supply,
                    "tx_hash": '0x' + tx_hash.hex(),
                }

            except Exception as e:
                last_error = str(e)
                if attempt < MAX_RETRY_ATTEMPTS - 1:
                    time.sleep(RETRY_DELAY)

        return {"success": False, "message": f"部署失败: {last_error}"}

    # 铸造代币（带重试机制）
    def mint_tokens(
            self,
            token_symbol: str,
            to_address: str,
            amount: float,
            from_index: int = 0,
    ) -> Dict[str, Any]:
        if not self.is_running() or not self._w3:
            return {"success": False, "message": "本地链未运行"}

        token = self._tokens.get(token_symbol)
        if not token:
            return {"success": False, "message": f"代币 {token_symbol} 不存在"}

        last_error = None
        for attempt in range(MAX_RETRY_ATTEMPTS):
            try:
                if not self._w3 or not self._w3.is_connected():
                    self._init_web3()
                    if not self._w3 or not self._w3.is_connected():
                        raise Exception("无法重新建立 RPC 连接")

                # 账户列表可能为空或过期，每次重试都重新加载
                if not self._accounts:
                    self._load_accounts()
                if not self._accounts:
                    raise Exception("无法获取本地链账户列表")

                if from_index < 0 or from_index >= len(self._accounts):
                    raise Exception(f"账户索引无效: {from_index}（当前共 {len(self._accounts)} 个账户）")

                from_address = self._accounts[from_index]
                to_address = self._w3.to_checksum_address(to_address)
                abi_json = [
                    {"inputs": [{"name": "to", "type": "address"}, {"name": "amount", "type": "uint256"}],
                     "name": "mint", "outputs": [], "stateMutability": "nonpayable", "type": "function"},
                    {"inputs": [{"name": "account", "type": "address"}], "name": "balanceOf",
                     "outputs": [{"name": "", "type": "uint256"}], "stateMutability": "view", "type": "function"},
                    {"inputs": [], "name": "decimals", "outputs": [{"name": "", "type": "uint8"}],
                     "stateMutability": "view", "type": "function"},
                ]
                contract = self._w3.eth.contract(address=token["address"], abi=abi_json)
                decimals = contract.functions.decimals().call()
                amount_wei = int(amount * (10 ** decimals))

                # 先估算 gas，加上 20% 安全余量，避免 Ganache 在 transact 内部估算时挂起
                try:
                    estimated_gas = contract.functions.mint(to_address, amount_wei).estimate_gas({"from": from_address})
                    gas_limit = int(estimated_gas * 1.2)
                except Exception:
                    gas_limit = 200000  # ERC20 mint 默认 200K gas

                tx_hash = contract.functions.mint(to_address, amount_wei).transact({
                    "from": from_address,
                    "gas": gas_limit,
                    "gasPrice": self._w3.to_wei(20, 'gwei'),
                })
                receipt = self._w3.eth.wait_for_transaction_receipt(tx_hash, timeout=15)

                new_balance = contract.functions.balanceOf(to_address).call()
                balance_display = new_balance / (10 ** decimals)

                return {
                    "success": True,
                    "message": f"Mint 成功，当前余额: {balance_display} {token_symbol}",
                    "tx_hash": '0x' + tx_hash.hex(),
                    "to": to_address,
                    "amount": amount,
                    "symbol": token_symbol,
                    "new_balance": balance_display,
                }

            except Exception as e:
                last_error = str(e)
                if attempt < MAX_RETRY_ATTEMPTS - 1:
                    time.sleep(RETRY_DELAY)

        return {"success": False, "message": f"Mint 失败: {last_error}"}

    # 部署 USDC 并向所有本地链账户分发等额代币（创世时调用）
    def deploy_and_distribute_usdc(
            self,
            from_index: int = 0,
            symbol: str = "USDC",
            name: str = "Mock USDC",
            decimals: int = 6,
            per_account_amount: float = 10000,
    ) -> Dict[str, Any]:
        """部署 USDC 代币并为每个本地链账户铸造等额代币。

        - 若 USDC 已存在（self._tokens 或 DB 中）且链上合约代码有效，则跳过部署，仅执行分发。
        - 若 DB 记录的合约地址在链上无代码（链数据已重置），清理旧记录并重新部署。
        - 分发：对每个账户调用 mint，金额为 per_account_amount。
        - 若分发全部失败且本次未部署，自动尝试重新部署一次。
        """
        if not self.is_running() or not self._w3:
            return {"success": False, "message": "本地链未运行"}

        # 1. 检查 USDC 是否已存在
        token = self._tokens.get(symbol)
        if not token:
            # 从 DB 加载
            try:
                self._load_tokens_from_db()
                token = self._tokens.get(symbol)
            except Exception:
                pass

        # 2. 验证链上合约是否真实存在（防止 DB 残留旧记录导致 mint 全部失败）
        if token:
            try:
                code = self._w3.eth.get_code(self._w3.to_checksum_address(token["address"]))
                if not code or code == b'' or code == b'0x':
                    print(f"⚠️  DB 记录的 USDC 合约 {token['address']} 在链上无代码（链数据已重置），将重新部署")
                    token = None
                    self._tokens.pop(symbol, None)
            except Exception as e:
                print(f"⚠️  验证 USDC 合约存在性失败: {e}，将重新部署")
                token = None
                self._tokens.pop(symbol, None)

        deployed = False

        def _deploy_usdc():
            """内部函数：部署 USDC 合约"""
            deploy_result = self.deploy_mock_erc20(
                from_index=from_index,
                name=name,
                symbol=symbol,
                decimals=decimals,
                initial_supply=per_account_amount,  # 初始供应量给部署者
            )
            return deploy_result

        if not token:
            # 3. 部署 USDC
            deploy_result = _deploy_usdc()
            if not deploy_result.get("success"):
                return deploy_result
            deployed = True
            token = self._tokens.get(symbol)
            if not token:
                return {"success": False, "message": "USDC 部署后未找到代币记录"}
        else:
            print(f"💰 USDC 已存在（{token['address']}），跳过部署，直接分发")

        # 4. 向所有账户分发 USDC
        if not self._accounts:
            self._load_accounts()
        if not self._accounts:
            return {"success": False, "message": "无法获取本地链账户列表"}

        def _distribute():
            """内部函数：向所有账户分发 USDC，返回 (distributed, failed)"""
            dist, fail = [], []
            for addr in self._accounts:
                mint_result = self.mint_tokens(symbol, addr, per_account_amount, from_index)
                if mint_result.get("success"):
                    dist.append(addr)
                else:
                    fail.append({"address": addr, "error": mint_result.get("message")})
            return dist, fail

        distributed, failed = _distribute()

        # 5. 若分发全部失败且本次未重新部署，清理旧记录后自动重新部署一次
        if len(distributed) == 0 and len(failed) > 0 and not deployed:
            first_error = failed[0].get("error", "未知错误") if failed else "未知错误"
            print(f"⚠️  USDC 分发全部失败（{first_error}），尝试清理旧合约并重新部署...")
            self._tokens.pop(symbol, None)
            deploy_result = _deploy_usdc()
            if deploy_result.get("success"):
                token = self._tokens.get(symbol)
                if token:
                    deployed = True
                    distributed, failed = _distribute()

        return {
            "success": len(failed) == 0,
            "message": f"USDC 分发完成：成功 {len(distributed)}/{len(self._accounts)} 个账户"
                       + (f"，失败 {len(failed)} 个" if failed else "")
                       + (f" | 首个错误: {failed[0].get('error', '未知')}" if failed else ""),
            "deployed": deployed,
            "token_address": token["address"] if token else None,
            "symbol": symbol,
            "per_account_amount": per_account_amount,
            "distributed_count": len(distributed),
            "total_accounts": len(self._accounts),
            "failed": failed,
        }

    # 确保 USDC 合约在链上有效（幂等：有效则跳过，无效才重新部署+分发）
    def ensure_usdc_ready(
            self,
            from_index: int = 0,
            per_account_amount: float = 100000,
    ) -> Dict[str, Any]:
        """确保 USDC 合约在链上有效且已分发。

        - 链上已有有效 USDC 合约 → 跳过，返回就绪状态
        - 链上无 USDC 合约（未部署或链数据重置）→ 重新部署并分发

        幂等方法，可在链启动或转账前安全调用。
        """
        if not self.is_running() or not self._w3:
            return {"success": False, "message": "本地链未运行"}

        symbol = "USDC"
        token = self._tokens.get(symbol)
        if not token:
            try:
                self._load_tokens_from_db()
                token = self._tokens.get(symbol)
            except Exception:
                pass

        # 验证链上合约存在性
        if token:
            try:
                code = self._w3.eth.get_code(self._w3.to_checksum_address(token["address"]))
                if code and code != b'' and code != b'0x':
                    # 合约有效，无需重新部署
                    return {
                        "success": True,
                        "message": "USDC 合约已就绪",
                        "token_address": token["address"],
                        "deployed": False,
                    }
                print(f"⚠️  DB 记录的 USDC 合约 {token['address']} 在链上无代码，将重新部署")
            except Exception as e:
                print(f"⚠️  验证 USDC 合约存在性失败: {e}，将重新部署")
            # 清理无效记录
            self._tokens.pop(symbol, None)

        # 合约无效或不存在，重新部署并分发
        return self.deploy_and_distribute_usdc(
            from_index=from_index,
            per_account_amount=per_account_amount,
        )

    # 转账 ERC20 代币（从指定账户向目标地址发送代币）
    def send_token(
            self,
            token_symbol: str,
            to_address: str,
            amount: float,
            from_index: int = 0,
    ) -> Dict[str, Any]:
        """从本地链账户向目标地址转账 ERC20 代币。

        转账前会验证代币合约在链上是否存在；若无效（链数据重置），
        对于 USDC 会自动调用 ensure_usdc_ready 恢复后重试。
        """
        if not self.is_running() or not self._w3:
            return {"success": False, "message": "本地链未运行"}

        token = self._tokens.get(token_symbol)
        if not token:
            # USDC 特殊处理：尝试自动就绪
            if token_symbol.upper() == "USDC":
                ready_result = self.ensure_usdc_ready(from_index=from_index)
                if ready_result.get("success"):
                    token = self._tokens.get(token_symbol)
            if not token:
                return {"success": False, "message": f"代币 {token_symbol} 不存在，请先部署"}

        # 验证合约在链上是否有代码（防止 DB 残留旧地址）
        try:
            code = self._w3.eth.get_code(self._w3.to_checksum_address(token["address"]))
            if not code or code == b'' or code == b'0x':
                # 合约在链上不存在：USDC 自动恢复，其他代币直接报错
                if token_symbol.upper() == "USDC":
                    print(f"⚠️  {token_symbol} 合约 {token['address']} 在链上无代码，自动重新部署...")
                    self._tokens.pop(token_symbol, None)
                    ready_result = self.ensure_usdc_ready(from_index=from_index)
                    if ready_result.get("success"):
                        token = self._tokens.get(token_symbol)
                        if not token:
                            return {"success": False, "message": "USDC 重新部署后仍无代币记录"}
                    else:
                        return {"success": False, "message": f"USDC 自动恢复失败: {ready_result.get('message')}"}
                else:
                    return {"success": False, "message": f"代币 {token_symbol} 合约在链上不存在（可能链数据已重置）"}
        except Exception as e:
            return {"success": False, "message": f"验证代币合约失败: {e}"}

        last_error = None
        for attempt in range(MAX_RETRY_ATTEMPTS):
            try:
                if not self._w3 or not self._w3.is_connected():
                    self._init_web3()
                    if not self._w3 or not self._w3.is_connected():
                        raise Exception("无法重新建立 RPC 连接")

                if not self._accounts:
                    self._load_accounts()
                if not self._accounts:
                    raise Exception("无法获取本地链账户列表")

                if from_index < 0 or from_index >= len(self._accounts):
                    raise Exception(f"账户索引无效: {from_index}（当前共 {len(self._accounts)} 个账户）")

                from_address = self._accounts[from_index]
                to_address = self._w3.to_checksum_address(to_address)

                # 使用精简 ABI（transfer/balanceOf/decimals）
                abi_json = [
                    {"inputs": [{"name": "to", "type": "address"}, {"name": "amount", "type": "uint256"}],
                     "name": "transfer", "outputs": [{"name": "", "type": "bool"}],
                     "stateMutability": "nonpayable", "type": "function"},
                    {"inputs": [{"name": "account", "type": "address"}], "name": "balanceOf",
                     "outputs": [{"name": "", "type": "uint256"}], "stateMutability": "view", "type": "function"},
                    {"inputs": [], "name": "decimals", "outputs": [{"name": "", "type": "uint8"}],
                     "stateMutability": "view", "type": "function"},
                ]
                contract = self._w3.eth.contract(address=token["address"], abi=abi_json)
                decimals = contract.functions.decimals().call()
                amount_wei = int(amount * (10 ** decimals))

                try:
                    estimated_gas = contract.functions.transfer(to_address, amount_wei).estimate_gas({"from": from_address})
                    gas_limit = int(estimated_gas * 1.2)
                except Exception:
                    gas_limit = 100000  # ERC20 transfer 默认 100K gas

                tx_hash = contract.functions.transfer(to_address, amount_wei).transact({
                    "from": from_address,
                    "gas": gas_limit,
                    "gasPrice": self._w3.to_wei(20, 'gwei'),
                })
                receipt = self._w3.eth.wait_for_transaction_receipt(tx_hash, timeout=15)

                new_balance = contract.functions.balanceOf(to_address).call()
                balance_display = new_balance / (10 ** decimals)

                return {
                    "success": True,
                    "message": f"转账成功，接收方余额: {balance_display} {token_symbol}",
                    "tx_hash": '0x' + tx_hash.hex(),
                    "to": to_address,
                    "amount": amount,
                    "symbol": token_symbol,
                    "new_balance": balance_display,
                }

            except Exception as e:
                last_error = str(e)
                if attempt < MAX_RETRY_ATTEMPTS - 1:
                    time.sleep(RETRY_DELAY)

        return {"success": False, "message": f"代币转账失败: {last_error}"}

    # 获取代币列表
    def get_tokens(self) -> List[Dict[str, Any]]:
        return list(self._tokens.values())

    # ==================== 链浏览器查询 ====================

    # 查询最新区块号
    def get_latest_block_number(self) -> Optional[int]:
        if not self._ensure_connected():
            return None
        try:
            return self._w3.eth.block_number
        except Exception:
            return None

    # 查询区块详情
    def get_block(self, block_number: int) -> Optional[Dict[str, Any]]:
        if not self._ensure_connected():
            return None
        try:
            block = self._w3.eth.get_block(block_number, full_transactions=False)
            def _hex(val):
                if val is None:
                    return None
                s = val.hex() if hasattr(val, 'hex') else str(val)
                return s if s.startswith('0x') else '0x' + s
            tx_list = []
            for tx in block.transactions:
                if isinstance(tx, bytes):
                    tx_list.append('0x' + tx.hex())
                elif hasattr(tx, 'hex'):
                    tx_list.append('0x' + tx.hex())
                else:
                    tx_list.append(str(tx))
            return {
                "number": block.number,
                "hash": _hex(block.hash),
                "parent_hash": _hex(block.parentHash),
                "timestamp": block.timestamp,
                "miner": block.miner,
                "gas_used": block.gasUsed,
                "gas_limit": block.gasLimit,
                "size": block.size,
                "tx_count": len(block.transactions),
                "transactions": tx_list,
            }
        except Exception as e:
            logger.error(f"get_block error for {block_number}: {e}")
            return None

    # 查询交易详情
    def get_transaction(self, tx_hash: str) -> Optional[Dict[str, Any]]:
        if not self._ensure_connected():
            return None
        try:
            tx = self._w3.eth.get_transaction(tx_hash)
            receipt = self._w3.eth.get_transaction_receipt(tx_hash)
            tx_hash_str = tx.hash.hex() if hasattr(tx.hash, 'hex') else str(tx.hash)
            if not tx_hash_str.startswith('0x'):
                tx_hash_str = '0x' + tx_hash_str
            block_hash_str = None
            if tx.blockHash:
                block_hash_str = tx.blockHash.hex() if hasattr(tx.blockHash, 'hex') else str(tx.blockHash)
                if not block_hash_str.startswith('0x'):
                    block_hash_str = '0x' + block_hash_str
            gas_price_raw = getattr(tx, 'gasPrice', None)
            if gas_price_raw is None and isinstance(tx, dict):
                gas_price_raw = tx.get('gasPrice')
            gas_price_str = str(self._w3.from_wei(gas_price_raw, 'gwei')) if gas_price_raw is not None else '0'
            return {
                "hash": tx_hash_str,
                "block_number": tx.blockNumber,
                "block_hash": block_hash_str,
                "from": tx["from"],
                "to": tx.to,
                "value": str(self._w3.from_wei(tx.value, 'ether')),
                "gas": tx.gas,
                "gas_price": gas_price_str,
                "nonce": tx.nonce,
                "input": tx.input[:200] + "..." if len(tx.input) > 200 else tx.input,
                "status": receipt.status if receipt else None,
                "gas_used": receipt.gasUsed if receipt else None,
                "contract_address": receipt.contractAddress if receipt else None,
                "transaction_index": tx.transactionIndex,
            }
        except Exception as e:
            logger.error(f"get_transaction error for {tx_hash}: {e}")
            return None

    # 查询地址信息（余额、nonce、交易数）
    def get_address_info(self, address: str) -> Optional[Dict[str, Any]]:
        if not self._ensure_connected():
            return None
        try:
            checksum_addr = self._w3.to_checksum_address(address)
            balance_wei = self._w3.eth.get_balance(checksum_addr)
            nonce = self._w3.eth.get_transaction_count(checksum_addr)
            code = self._w3.eth.get_code(checksum_addr)
            return {
                "address": checksum_addr,
                "balance": str(self._w3.from_wei(balance_wei, 'ether')),
                "nonce": nonce,
                "is_contract": len(code) > 0,
                "code_size": len(code),
            }
        except Exception:
            return None

    # 查询地址的交易记录（扫描最近 N 个区块）
    def get_address_transactions(self, address: str, scan_blocks: int = 500, limit: int = 50) -> Optional[
        Dict[str, Any]]:
        """
        扫描最近 scan_blocks 个区块，提取与指定地址相关的交易（from 或 to 命中）。

        本地链没有以太坊主网那种索引服务，只能遍历区块扫描。
        scan_blocks 控制扫描深度，limit 控制返回条数。
        """
        if not self._ensure_connected():
            return None
        try:
            checksum_addr = self._w3.to_checksum_address(address)
            latest = self._w3.eth.block_number
            from_block = max(0, latest - scan_blocks + 1)

            txs = []
            for block_num in range(latest, from_block - 1, -1):
                try:
                    block = self._w3.eth.get_block(block_num, full_transactions=True)
                    for tx in block.transactions:
                        if tx.get("from", "").lower() == checksum_addr.lower() or \
                                (tx.get("to") and tx["to"].lower() == checksum_addr.lower()):
                            tx_hash_str = tx.hash.hex() if hasattr(tx.hash, 'hex') else str(tx.hash)
                            if not tx_hash_str.startswith('0x'):
                                tx_hash_str = '0x' + tx_hash_str
                            txs.append({
                                "hash": tx_hash_str,
                                "block_number": tx.blockNumber,
                                "from": tx["from"],
                                "to": tx.to,
                                "value": str(self._w3.from_wei(tx.value, 'ether')),
                                "timestamp": block.timestamp,
                                "status": None,
                            })
                            if len(txs) >= limit:
                                break
                except Exception:
                    continue
                if len(txs) >= limit:
                    break

            return {
                "address": checksum_addr,
                "transactions": txs,
                "count": len(txs),
                "scanned_from_block": from_block,
                "scanned_to_block": latest,
                "truncated": len(txs) >= limit,
            }
        except Exception:
            return None

    # 确保 web3 已连接（内部辅助方法）
    def _ensure_connected(self) -> bool:
        if not self._w3:
            self._init_web3()
        if not self._w3 or not self._w3.is_connected():
            return False
        return True

    # 添加代币
    def add_token(self, symbol: str, address: str, name: str, decimals: int = 6) -> Dict[str, Any]:
        self._tokens[symbol] = {
            "address": address,
            "name": name,
            "symbol": symbol,
            "decimals": decimals,
        }
        return {"success": True, "message": f"代币 {symbol} 已添加"}

    # 注册代币到 RPS 合约（使用合约 owner 权限）
    def register_token_on_contract(self, token_address: str, contract_address: str,
                                    from_index: int = 0) -> Dict[str, Any]:
        """
        调用 RPS 合约的 setTokenSupport 注册代币。
        使用 Ganache account[0]（合约部署者/owner）的权限。
        """
        if not self.is_running() or not self._w3:
            return {"success": False, "message": "本地链未运行"}

        if not self._accounts or from_index >= len(self._accounts):
            return {"success": False, "message": f"账户索引 {from_index} 无效"}

        try:
            from web3 import Web3
            import json

            # 加载 RPS 合约 ABI
            abi_path = os.path.join(
                os.path.dirname(os.path.dirname(os.path.dirname(__file__))),
                "contracts", "abi", "ChainRPS.json"
            )
            if not os.path.exists(abi_path):
                return {"success": False, "message": f"ABI 文件不存在: {abi_path}"}

            with open(abi_path, "r", encoding="utf-8") as f:
                abi = json.load(f)

            rps_contract = self._w3.eth.contract(
                address=Web3.to_checksum_address(contract_address),
                abi=abi,
            )

            # 检查是否已支持
            supported = rps_contract.functions.supportedTokens(
                Web3.to_checksum_address(token_address)
            ).call()
            if supported:
                return {"success": True, "message": "代币已在合约中注册", "already_registered": True}

            # 调用 setTokenSupport
            from_address = self._accounts[from_index]
            tx_params = {
                "from": from_address,
                "gas": 100000,
                "gasPrice": self._w3.to_wei(20, 'gwei'),
            }
            tx = rps_contract.functions.setTokenSupport(
                Web3.to_checksum_address(token_address), True
            ).build_transaction(tx_params)

            # 使用 Ganache 账户签名
            if from_index < len(self._private_keys) and self._private_keys[from_index]:
                private_key = self._private_keys[from_index]
                account = self._w3.eth.account.from_key(private_key)
                signed = account.sign_transaction(tx)
                tx_hash = self._w3.eth.send_raw_transaction(signed.raw_transaction)
            else:
                tx_hash = self._w3.eth.send_transaction(tx)

            receipt = self._w3.eth.wait_for_transaction_receipt(tx_hash, timeout=30)
            if receipt.get("status") == 1:
                return {"success": True, "message": "代币已注册到合约", "tx_hash": tx_hash.hex()}
            else:
                return {"success": False, "message": f"setTokenSupport 交易失败 status={receipt.get('status')}"}
        except Exception as e:
            return {"success": False, "message": f"注册代币异常: {e}"}

    # 设置保活开关
    def set_keep_alive(self, enabled: bool, **start_kwargs) -> Dict[str, Any]:
        """
        设置本地链保活模式。

        enabled=True 时：
          - 如果节点未运行，先按配置启动
          - 启动后台巡检线程，节点意外退出时自动重启
        enabled=False 时：
          - 停止保活巡检
          - 停止节点
        """
        with self._keep_alive_lock:
            if enabled:
                self._keep_alive_enabled = True
                if start_kwargs:
                    self._keep_alive_config.update(start_kwargs)

                cfg = self._keep_alive_config or {}
                desired_chain_type = cfg.get("chain_type", "ganache")

                # 链类型切换：当前运行的节点类型与期望不一致时，先停止旧节点
                if self.is_running() and self._chain_type and self._chain_type != desired_chain_type:
                    print(f"🔄 链类型切换: {self._chain_type} → {desired_chain_type}，先停止当前节点")
                    self.stop_node(keep_alive=True)

                # 节点未运行则按配置启动
                if not self.is_running():
                    result = self.start_node(**cfg)
                    if not result.get("success"):
                        self._keep_alive_enabled = False
                        return result

                # 启动巡检线程
                self._ensure_keep_alive_thread()
                return {
                    "success": True,
                    "message": "保活已启用，节点将持续运行",
                    "keep_alive": True,
                }
            else:
                self._keep_alive_enabled = False
                # 关闭保活时停止节点
                stop_result = self.stop_node(keep_alive=False)
                return {
                    "success": True,
                    "message": "节点已停止",
                    "keep_alive": False,
                }

    # 获取保活状态
    def get_keep_alive_status(self) -> Dict[str, Any]:
        return {
            "enabled": self._keep_alive_enabled,
            "config": self._keep_alive_config,
            "restart_count": self._keep_alive_restart_count,
            "last_restart_at": self._keep_alive_last_restart_at,
            "thread_running": (
                    self._keep_alive_thread is not None
                    and self._keep_alive_thread.is_alive()
            ),
        }

    # 确保保活巡检线程在运行
    def _ensure_keep_alive_thread(self):
        if self._keep_alive_thread and self._keep_alive_thread.is_alive():
            return
        self._keep_alive_stop_event = threading.Event()
        self._keep_alive_thread = threading.Thread(
            target=self._keep_alive_loop,
            daemon=True,
            name="local-chain-keep-alive",
        )
        self._keep_alive_thread.start()
        print("🔁 本地链保活巡检线程已启动")

    # 保活巡检主循环（自适应间隔 + 轻量 HTTP 检测）
    def _keep_alive_loop(self):
        healthy_interval = 30  # 健康时检查间隔（秒），降低对节点干扰
        recovery_interval = 15  # 异常时检查间隔（秒）
        check_timeout = 8  # 单次检测超时（秒），给 Ganache 足够响应时间
        consecutive_failures = 0
        max_consecutive_failures = 6  # 连续失败阈值，避免短暂卡顿误判
        restart_cooldown = 90  # 重启冷却期（秒），防止频繁重启
        last_state = None  # 0=健康, 1=异常, 用于状态变更日志

        while not self._keep_alive_stop_event.is_set():
            try:
                if not self._keep_alive_enabled:
                    self._keep_alive_stop_event.wait(healthy_interval)
                    continue

                http_ok = self._check_http_health(timeout=check_timeout)
                if http_ok:
                    if consecutive_failures > 0:
                        if last_state != 0:
                            print("✅ 保活：RPC 连接恢复正常")
                            last_state = 0
                        consecutive_failures = 0
                    interval = healthy_interval
                else:
                    consecutive_failures += 1
                    if last_state != 1:
                        print(f"⚠️  保活检测：RPC 无响应（连续 {consecutive_failures} 次）")
                        last_state = 1
                    interval = recovery_interval

                    if consecutive_failures >= max_consecutive_failures:
                        # 检查重启冷却期，防止频繁重启
                        now = time.time()
                        if self._keep_alive_last_restart_at and (
                                now - self._keep_alive_last_restart_at) < restart_cooldown:
                            remaining = int(restart_cooldown - (now - self._keep_alive_last_restart_at))
                            print(f"⏳ 保活：重启冷却中，还需等待 {remaining} 秒")
                            consecutive_failures = 0  # 重置计数，等待冷却期结束
                            interval = healthy_interval
                        else:
                            print(f"🔴 保活：连续 {max_consecutive_failures} 次检测失败，执行强制恢复...")
                            self._force_recover()
                            cfg = self._keep_alive_config or {}
                            try:
                                result = self.start_node(**cfg)
                                if result.get("success"):
                                    self._keep_alive_restart_count += 1
                                    self._keep_alive_last_restart_at = time.time()
                                    consecutive_failures = 0
                                    last_state = None
                                    print(f"✅ 保活：本地链已强制重启（第 {self._keep_alive_restart_count} 次）")
                                else:
                                    print(f"❌ 保活重启失败：{result.get('message', '未知错误')}")
                            except Exception as e:
                                print(f"❌ 保活重启异常：{e}")
                            interval = recovery_interval

            except Exception as e:
                print(f"🔴 保活巡检异常：{e}")
                interval = recovery_interval

            self._keep_alive_stop_event.wait(interval)

        print("🔁 本地链保活巡检线程已退出")

    # 强制恢复：处理假死进程并清理端口占用
    def _force_recover(self):
        """强制杀掉假死进程和清理端口，确保能重新启动"""
        if self._process:
            try:
                self._process.kill()
                self._process.wait(timeout=3)
            except Exception:
                pass
            self._process = None
            print("  已终止旧的 ganache 进程")

        if os.name == "nt":
            try:
                netstat = subprocess.run(
                    ["netstat", "-ano", "-p", "TCP"],
                    capture_output=True, text=True, timeout=5,
                )
                pids = set()
                for line in netstat.stdout.splitlines():
                    if f":{RPC_LOCAL_PORT}" in line and "LISTENING" in line:
                        parts = line.split()
                        if parts:
                            pid = parts[-1]
                            if pid.isdigit() and int(pid) > 0:
                                pids.add(pid)
                for pid in pids:
                    try:
                        subprocess.run(
                            ["taskkill", "/PID", pid, "/F"],
                            capture_output=True, timeout=5,
                        )
                        print(f"  已清理端口 {RPC_LOCAL_PORT} 占用进程 PID={pid}")
                    except Exception:
                        pass
            except Exception:
                pass

        self._w3 = None
        self._accounts = []
        time.sleep(1)


# 获取本地链服务实例
def get_local_chain_service() -> LocalChainService:
    return LocalChainService()