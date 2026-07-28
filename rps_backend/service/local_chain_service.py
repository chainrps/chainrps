"""
本地链管理服务

管理 Ganache 本地测试链：启动/停止/状态检查/账户管理/代币分发

说明："本地链"即本地测试链（Local Chain），同时也寓意"连胜"。
"""
import os
import json
import shutil
import subprocess
import threading
import time
from typing import Optional, List, Dict, Any

from web3 import Web3
from web3.exceptions import TimeExhausted

from rps_backend.config import RPC_CHAIN_ID, RPC_URL, RPC_LOCAL_PORT, RPC_DEFAULT_BALANCE, RPC_SYMBOL, \
    RPC_DEFAULT_ACCOUNT_COUNT

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
            for c in contracts:
                name = c.get("name", "")
                if name.startswith("Mock") or name in ["USDC", "USDT", "MockERC20"]:
                    symbol = name.replace("Mock ", "")
                    self._tokens[symbol] = {
                        "address": c.get("address"),
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
        symbol: str = "ETH",
        chain_type: str = "ganache",
        persist: bool = True,                 # 是否启用持久化存储（仅 Ganache 支持）
    ) -> Dict[str, Any]:
        if self.is_running():
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
            symbol: str = "ETH",
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
            accounts_count: int = RPC_DEFAULT_ACCOUNT_COUNT,
            default_balance: float = RPC_DEFAULT_BALANCE,
            symbol: str = RPC_SYMBOL,
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
        # 代币符号：优先使用用户启动节点时配置的 symbol
        # 说明：Ganache v7.9.2 不支持 --chain.nativeTokenSymbol 参数，节点本身默认返回 "GO"，
        # 因此这里返回用户配置的 symbol（保存在 _keep_alive_config 中），而非节点默认值
        configured_symbol = (self._keep_alive_config.get("symbol") if self._keep_alive_config else None) or "ETH"
        # 持久化支持信息：仅 Ganache 支持，Hardhat 始终为 False
        persist_supported = self._chain_type != "hardhat"
        persist_enabled = bool(self._persist_enabled) and persist_supported

        # 读取推荐主链名称
        try:
            from rps_backend.repository import get_system_config_value
            recommended_chain_name = get_system_config_value("recommended_chain_name") or "ChainRPS_Sim"
        except Exception:
            recommended_chain_name = f"Localhost {RPC_LOCAL_PORT}"

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

    # 获取账户列表
    def get_accounts(self) -> List[Dict[str, Any]]:
        if not self.is_running() or not self._w3:
            return []

        accounts_info = []
        for i, addr in enumerate(self._accounts):
            try:
                balance_wei = self._w3.eth.get_balance(addr)
                balance_eth = self._w3.from_wei(balance_wei, 'ether')
                accounts_info.append({
                    "index": i,
                    "address": addr,
                    "balance_eth": float(balance_eth),
                    "private_key": self._private_keys[i] if i < len(self._private_keys) else None,
                })
            except Exception:
                accounts_info.append({
                    "index": i,
                    "address": addr,
                    "balance_eth": 0,
                    "private_key": None,
                })

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
            return {
                "number": block.number,
                "hash": ('0x' + block.hash.hex()) if block.hash else None,
                "parent_hash": ('0x' + block.parentHash.hex()) if block.parentHash else None,
                "timestamp": block.timestamp,
                "miner": block.miner,
                "gas_used": block.gasUsed,
                "gas_limit": block.gasLimit,
                "size": block.size,
                "tx_count": len(block.transactions),
                "transactions": [('0x' + tx.hex()) if isinstance(tx, bytes) else tx for tx in block.transactions],
            }
        except Exception:
            return None

    # 查询交易详情
    def get_transaction(self, tx_hash: str) -> Optional[Dict[str, Any]]:
        if not self._ensure_connected():
            return None
        try:
            tx = self._w3.eth.get_transaction(tx_hash)
            receipt = self._w3.eth.get_transaction_receipt(tx_hash)
            return {
                "hash": '0x' + tx.hash.hex(),
                "block_number": tx.blockNumber,
                "block_hash": ('0x' + tx.blockHash.hex()) if tx.blockHash else None,
                "from": tx["from"],
                "to": tx.to,
                "value": str(self._w3.from_wei(tx.value, 'ether')),
                "gas": tx.gas,
                "gas_price": str(self._w3.from_wei(tx.gasPrice, 'gwei')),
                "nonce": tx.nonce,
                "input": tx.input[:200] + "..." if len(tx.input) > 200 else tx.input,
                "status": receipt.status if receipt else None,
                "gas_used": receipt.gasUsed if receipt else None,
                "contract_address": receipt.contractAddress if receipt else None,
                "transaction_index": tx.transactionIndex,
            }
        except Exception:
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
                            txs.append({
                                "hash": '0x' + tx.hash.hex(),
                                "block_number": tx.blockNumber,
                                "from": tx["from"],
                                "to": tx.to,
                                "value": str(self._w3.from_wei(tx.value, 'ether')),
                                "timestamp": block.timestamp,
                                "status": None,  # 不逐笔查 receipt，性能考虑
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