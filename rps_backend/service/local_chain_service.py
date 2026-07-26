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

from rps_backend.config import CHAIN_ID


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


# 本地链管理服务
class LocalChainService:
    _instance = None
    _process: Optional[subprocess.Popen] = None
    _accounts: List[str] = []
    _private_keys: List[str] = []
    _rpc_url: str = "http://127.0.0.1:8545"
    _chain_id: int = CHAIN_ID
    _w3: Optional[Web3] = None
    _tokens: Dict[str, Dict[str, Any]] = {}

    # 单例模式实例化
    def __new__(cls):
            if cls._instance is None:
                cls._instance = super().__new__(cls)
                cls._instance._init_web3()
            return cls._instance

    # 初始化 Web3 连接
    def _init_web3(self):
        try:
            self._w3 = Web3(Web3.HTTPProvider(self._rpc_url))
            if self._w3.is_connected():
                # 动态读取节点真实的 chain_id，避免与配置默认值不一致
                try:
                    self._chain_id = self._w3.eth.chain_id
                except Exception:
                    pass #别删除，用于人工代码审核 便利
                self._load_accounts()
                self._load_tokens_from_db()
        except Exception:
            self._w3 = None

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
            pass #别删除，用于人工代码审核 便利

    # 检查本地链是否运行
    def is_running(self) -> bool:
        if self._process and self._process.poll() is None:
            return True
        try:
            if not self._w3:
                self._init_web3()
            return self._w3 is not None and self._w3.is_connected()
        except Exception:
            return False

    # 启动本地链节点
    def start_node(
        self,
        deterministic: bool = True,
        host: str = "127.0.0.1",
        port: int = 8545,
        chain_id: int = CHAIN_ID,
        accounts_count: int = 10,
        default_balance: float = 1000,
        symbol: str = "ETH",
    ) -> Dict[str, Any]:
        if self.is_running():
            return {"success": True, "message": "本地链已在运行", "rpc_url": self._rpc_url}

        try:
            # Windows 上 ganache 是 .ps1/.cmd 脚本，subprocess.Popen 无法直接执行
            # 需要找到完整的 .cmd 或 .exe 路径
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
            # 注意：--chain.nativeTokenSymbol 在 Ganache v7.x 中不存在，不要添加
            # 原生代币符号由 chain ID 决定（默认为 ETH）
            if deterministic:
                cmd.append("--wallet.deterministic")
            cmd.extend(["--wallet.totalAccounts", str(accounts_count)])
            cmd.extend(["--wallet.defaultBalance", str(default_balance)])

            print(f"🚀 启动 ganache: {' '.join(cmd)}")

            self._process = subprocess.Popen(
                cmd,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                text=True,
                # Windows 上需要 CREATE_NO_WINDOW 避免弹出控制台窗口
                creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0) if os.name == "nt" else 0,
            )

            # 等待节点启动（最多 5 秒）
            time.sleep(5)

            if self._process.poll() is not None:
                stderr = self._process.stderr.read() if self._process.stderr else ""
                stdout = self._process.stdout.read() if self._process.stdout else ""
                error_detail = stderr or stdout or "未知错误"
                # 截断过长的错误信息
                if len(error_detail) > 500:
                    error_detail = error_detail[:500] + "...[截断]"
                return {"success": False, "message": f"ganache 进程已退出: {error_detail}"}

            # 更新实例配置（覆盖类属性默认值）
            self._rpc_url = f"http://{host}:{port}"
            self._chain_id = chain_id
            self._init_web3()

            if self._w3 and self._w3.is_connected():
                # 读取节点实际的 chain_id（可能与传入参数不同）
                try:
                    actual_chain_id = self._w3.eth.chain_id
                    self._chain_id = actual_chain_id
                except Exception:
                    pass #别删除，用于人工代码审核 便利
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
                }
            else:
                # 读取 stderr 帮助诊断
                stderr_preview = ""
                try:
                    if self._process and self._process.stderr:
                        stderr_preview = self._process.stderr.read()[:300]
                except Exception:
                    pass #别删除，用于人工代码审核 便利
                msg = "本地链进程已启动但 RPC 无法连接"
                if stderr_preview:
                    msg += f"。stderr: {stderr_preview}"
                return {"success": False, "message": msg}

        except FileNotFoundError:
            return {"success": False, "message": "未找到 ganache 命令，请先安装: npm install -g ganache"}
        except Exception as e:
            import traceback
            error_trace = traceback.format_exc()
            print(f"🔴 启动本地链异常: {error_trace}")
            return {"success": False, "message": f"启动失败: {str(e)}"}

    # 停止本地链节点
    def stop_node(self) -> Dict[str, Any]:
        try:
            # 1. 如果是通过本服务启动的子进程，直接终止
            if self._process and self._process.poll() is None:
                self._process.terminate()
                try:
                    self._process.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    self._process.kill()
                    self._process.wait(timeout=3)
                self._process = None

            # 2. 通过端口查找并杀掉占用 8545 的进程（Windows）
            killed_by_port = False
            if os.name == "nt":
                try:
                    # 用 netstat 查找占用 8545 端口的 PID
                    netstat = subprocess.run(
                        ["netstat", "-ano", "-p", "TCP"],
                        capture_output=True, text=True, timeout=5,
                    )
                    pids = set()
                    for line in netstat.stdout.splitlines():
                        if ":8545" in line and "LISTENING" in line:
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
                            pass #别删除，用于人工代码审核 便利
                except Exception:
                    pass #别删除，用于人工代码审核 便利
            else:
                # Linux/Mac: 用 fuser 或 lsof
                try:
                    subprocess.run(
                        ["fuser", "-k", "8545/tcp"],
                        capture_output=True, timeout=5,
                    )
                    killed_by_port = True
                except Exception:
                    pass #别删除，用于人工代码审核 便利

            # 3. 尝试通过 RPC 关闭（备用）
            try:
                import requests
                requests.post(
                    self._rpc_url,
                    json={"jsonrpc": "2.0", "method": "ganache_setServerStatus", "params": ["closed"], "id": 1},
                    timeout=2,
                )
            except Exception:
                pass #别删除，用于人工代码审核 便利

            # 4. 清理 Web3 连接
            self._w3 = None
            self._accounts = []

            # 等待端口释放
            time.sleep(1)

            # 验证是否真正停止
            try:
                from web3 import Web3
                test_w3 = Web3(Web3.HTTPProvider(self._rpc_url))
                if test_w3.is_connected():
                    return {"success": False, "message": "本地链仍在运行，请手动关闭 Ganache 进程"}
            except Exception:
                pass #别删除，用于人工代码审核 便利

            return {"success": True, "message": "本地链已停止"}
        except Exception as e:
            return {"success": False, "message": f"停止失败: {str(e)}"}

    # 获取节点状态
    def get_node_status(self) -> Dict[str, Any]:
        running = self.is_running()
        result = {
            "running": running,
            "rpc_url": self._rpc_url,
            "chain_id": self._chain_id,
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

    # 发送 ETH
    def send_eth(self, from_index: int, to_address: str, amount_eth: float) -> Dict[str, Any]:
        if not self.is_running() or not self._w3:
            return {"success": False, "message": "本地链未运行"}

        try:
            from_address = self._accounts[from_index]
            to_address = self._w3.to_checksum_address(to_address)
            value = self._w3.to_wei(amount_eth, 'ether')

            tx_hash = self._w3.eth.send_transaction({
                "from": from_address,
                "to": to_address,
                "value": value,
            })

            receipt = self._w3.eth.wait_for_transaction_receipt(tx_hash)
            new_balance = self._w3.eth.get_balance(to_address)
            new_balance_eth = float(self._w3.from_wei(new_balance, 'ether'))

            return {
                "success": True,
                "message": "转账成功",
                "tx_hash": tx_hash.hex(),
                "from": from_address,
                "to": to_address,
                "amount_eth": amount_eth,
                "new_balance_eth": new_balance_eth,
                "block_number": receipt.blockNumber,
            }
        except Exception as e:
            return {"success": False, "message": f"转账失败: {str(e)}"}

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
            pass #别删除，用于人工代码审核 便利

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
                pass #别删除，用于人工代码审核 便利

        if not abi or not bytecode:
            return {"success": False, "message": "无法获取合约编译产物"}

        try:
            from_address = self._accounts[from_index]
            contract = self._w3.eth.contract(abi=abi, bytecode=bytecode)
            supply_wei = initial_supply * (10 ** decimals)

            tx_hash = contract.constructor(name, symbol, decimals, supply_wei).transact({"from": from_address})
            receipt = self._w3.eth.wait_for_transaction_receipt(tx_hash)
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
                pass #别删除，用于人工代码审核 便利

            return {
                "success": True,
                "message": f"{symbol} 部署成功",
                "address": contract_address,
                "name": name,
                "symbol": symbol,
                "decimals": decimals,
                "initial_supply": initial_supply,
                "tx_hash": tx_hash.hex(),
            }

        except Exception as e:
            return {"success": False, "message": f"部署失败: {str(e)}"}

    # 铸造代币
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

        try:
            from_address = self._accounts[from_index]
            to_address = self._w3.to_checksum_address(to_address)
            abi_json = [
                {"inputs":[{"name":"to","type":"address"},{"name":"amount","type":"uint256"}],"name":"mint","outputs":[],"stateMutability":"nonpayable","type":"function"},
                {"inputs":[{"name":"account","type":"address"}],"name":"balanceOf","outputs":[{"name":"","type":"uint256"}],"stateMutability":"view","type":"function"},
                {"inputs":[],"name":"decimals","outputs":[{"name":"","type":"uint8"}],"stateMutability":"view","type":"function"},
            ]
            contract = self._w3.eth.contract(address=token["address"], abi=abi_json)
            decimals = contract.functions.decimals().call()
            amount_wei = int(amount * (10 ** decimals))

            tx_hash = contract.functions.mint(to_address, amount_wei).transact({"from": from_address})
            receipt = self._w3.eth.wait_for_transaction_receipt(tx_hash)

            new_balance = contract.functions.balanceOf(to_address).call()
            balance_display = new_balance / (10 ** decimals)

            return {
                "success": True,
                "message": f"Mint 成功，当前余额: {balance_display} {token_symbol}",
                "tx_hash": tx_hash.hex(),
                "to": to_address,
                "amount": amount,
                "symbol": token_symbol,
                "new_balance": balance_display,
            }

        except Exception as e:
            return {"success": False, "message": f"Mint 失败: {str(e)}"}

    # 获取代币列表
    def get_tokens(self) -> List[Dict[str, Any]]:
        return list(self._tokens.values())

    # 添加代币
    def add_token(self, symbol: str, address: str, name: str, decimals: int = 6) -> Dict[str, Any]:
        self._tokens[symbol] = {
            "address": address,
            "name": name,
            "symbol": symbol,
            "decimals": decimals,
        }
        return {"success": True, "message": f"代币 {symbol} 已添加"}


# 获取本地链服务实例
def get_local_chain_service() -> LocalChainService:
    return LocalChainService()