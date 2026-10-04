"""
Relayer 代提交服务模块（方案A/B 核心）

负责调用合约 submitCommitWithSig/revealChoiceWithSig，代玩家上链提交 commit/reveal。
玩家只需做 EIP-712 链下签名，无需亲自发交易，提升游戏体验。

重要约定：
- 本模块使用独立的 RELAYER_PRIVATE_KEY 签名上链交易，与 contract_service.py 的事件监听职责分离
- 合约通过 ecrecover 验证签名确实来自玩家本人，relayer 无法伪造
- nonce 防重放：每次代提交后合约自增玩家 nonce

安全约定（S1-02）：
- 私钥仅从环境变量 RELAYER_PRIVATE_KEY 加载，绝不硬编码、不入数据库
- 私钥绝不写日志、不通过 API 返回给前端
- 所有日志输出已审查，仅打印地址前缀或脱敏信息
- 全局只保留私钥派生的 Account 对象，私钥字符串在加载后不再被引用
"""
import asyncio
import json
import os
import time
from datetime import datetime, timezone
from functools import partial
from typing import Dict, Optional

from rps_backend.config import (
    CONTRACT_ADDRESS,
    RELAYER_ADDRESS,
    RELAYER_PRIVATE_KEY,
    RPC_URL,
)


# RPC 调用超时配置
_RPC_TIMEOUT = 15
_RPC_READ_TIMEOUT = 60  # 代提交需等待上链确认，超时放宽

# Relayer 健康检测配置
HEALTH_CHECK_INTERVAL = 60  # 健康检测周期（秒）
MIN_RELAYER_BALANCE_WEI = 10 * 10 ** 15  # 最低余额阈值：0.01 ETH

# Stuck 交易自动重发配置
STUCK_TX_TIMEOUT = 300  # 5 分钟未确认视为 stuck
STUCK_TX_GAS_BUMP_RATIO = 1.2  # 重发时 gas price 增加 20%


def _create_web3_with_timeout(rpc_url: str = RPC_URL):
    """创建带超时配置的 Web3 实例"""
    from web3 import Web3
    return Web3(Web3.HTTPProvider(
        rpc_url,
        request_kwargs={"timeout": (_RPC_TIMEOUT, _RPC_READ_TIMEOUT)},
    ))


async def _run_sync(func, *args, **kwargs):
    """将同步 web3 调用放到线程池执行，避免阻塞事件循环"""
    loop = asyncio.get_running_loop()
    return await loop.run_in_executor(None, partial(func, *args, **kwargs))


def _safe_log(msg: str, *args):
    """安全日志输出：仅打印公开信息，绝不打印私钥或敏感字段

    安全审查要点：
    - 此函数仅接受字符串与可序列化的公开字段
    - 调用方禁止传入 RELAYER_PRIVATE_KEY、私钥派生数据、签名分量等
    """
    print(msg, *args)


# 合约 ABI 加载（复用 contract_service 的 ABI 文件）
_ABI_PATH = os.path.join(
    os.path.dirname(os.path.dirname(os.path.dirname(__file__))),
    "contracts", "abi", "ChainRPS.json"
)

# 只加载代提交需要的 ABI 片段（避免 ABI 文件未编译时整体不可用）
_RELAYER_ABI_MINIMAL = [
    {
        "inputs": [
            {"name": "gameId", "type": "uint256"},
            {"name": "player", "type": "address"},
            {"name": "commit", "type": "bytes32"},
            {"name": "nonce", "type": "uint256"},
            {"name": "v", "type": "uint8"},
            {"name": "r", "type": "bytes32"},
            {"name": "s", "type": "bytes32"}
        ],
        "name": "submitCommitWithSig",
        "outputs": [],
        "stateMutability": "nonpayable",
        "type": "function"
    },
    {
        "inputs": [
            {"name": "gameId", "type": "uint256"},
            {"name": "player", "type": "address"},
            {"name": "choice", "type": "uint8"},
            {"name": "salt", "type": "bytes32"},
            {"name": "nonce", "type": "uint256"},
            {"name": "v", "type": "uint8"},
            {"name": "r", "type": "bytes32"},
            {"name": "s", "type": "bytes32"}
        ],
        "name": "revealChoiceWithSig",
        "outputs": [],
        "stateMutability": "nonpayable",
        "type": "function"
    },
    {
        "inputs": [{"name": "player", "type": "address"}],
        "name": "getRelayerAuthorization",
        "outputs": [
            {"name": "active", "type": "bool"},
            {"name": "relayer", "type": "address"},
            {"name": "deadline", "type": "uint256"}
        ],
        "stateMutability": "view",
        "type": "function"
    },
    {
        "inputs": [{"name": "player", "type": "address"}],
        "name": "nonces",
        "outputs": [{"name": "", "type": "uint256"}],
        "stateMutability": "view",
        "type": "function"
    }
]

# 尝试从 ABI 文件加载完整 ABI，失败则使用最小 ABI
CONTRACT_ABI: list = []
try:
    with open(_ABI_PATH, "r", encoding="utf-8") as f:
        full_abi = json.load(f)
        # 过滤出代提交相关的函数
        _needed_names = {"submitCommitWithSig", "revealChoiceWithSig",
                         "getRelayerAuthorization", "nonces"}
        CONTRACT_ABI = [item for item in full_abi
                        if item.get("name") in _needed_names and item.get("type") == "function"]
        if not CONTRACT_ABI:
            CONTRACT_ABI = _RELAYER_ABI_MINIMAL
except (FileNotFoundError, json.JSONDecodeError):
    CONTRACT_ABI = _RELAYER_ABI_MINIMAL


class RelayerService:
    """
    Relayer 代提交服务

    使用 RELAYER_PRIVATE_KEY 对应账户，调用合约 submitCommitWithSig/revealChoiceWithSig
    代玩家上链提交 commit/reveal。玩家通过 EIP-712 链下签名授权。

    功能模块：
    1. 健康检测（F1-05）：定期检查 RPC、余额、nonce 同步，状态变更时通过 WS 通知前端降级
    2. 并发队列（P1-01）：按玩家地址串行提交交易，避免 nonce 冲突
    3. Stuck 重发（P1-02）：监控 pending 交易，5 分钟未确认自动 bump gas 重发
    """

    # 初始化
    def __init__(self):
        """
        初始化 relayer 账户与合约对象。
        若 RELAYER_PRIVATE_KEY 未配置，代提交功能不可用，但不影响其他服务。

        安全说明（S1-02）：
        - 私钥仅从环境变量 RELAYER_PRIVATE_KEY 读取
        - 派生 Account 对象后，原字符串变量不再被本类直接持有或打印
        - 所有日志只输出地址前 10 位，不输出私钥
        """
        self.w3 = None
        self.contract = None
        self.relayer_account = None
        self._available = False

        # 健康状态（F1-05）
        self._health_status: Dict = {
            "healthy": False,
            "rpc_reachable": False,
            "balance_sufficient": False,
            "nonce_synced": False,
            "balance_wei": "0",
            "local_nonce": 0,
            "chain_nonce": 0,
            "last_check": None,
            "error": None,
        }
        self._health_check_task: Optional[asyncio.Task] = None

        # 并发队列（P1-01）：玩家地址（小写） -> asyncio.Queue
        self._player_queues: Dict[str, asyncio.Queue] = {}
        # 玩家地址 -> worker 任务
        self._player_workers: Dict[str, asyncio.Task] = {}

        # 本地 nonce 管理器（P1-01）
        self._local_nonce: Optional[int] = None
        self._nonce_lock = asyncio.Lock()

        # Stuck 交易追踪（P1-02）：tx_hash -> {submit_time, nonce, gas_price, tx_data, bump_count}
        self._pending_txs: Dict[str, dict] = {}
        self._pending_lock = asyncio.Lock()
        self._stuck_check_task: Optional[asyncio.Task] = None

        if not RELAYER_PRIVATE_KEY:
            _safe_log("ℹ️  RELAYER_PRIVATE_KEY 未配置，代提交功能不可用（方案A/B 需要）")
            return

        if not CONTRACT_ADDRESS:
            _safe_log("ℹ️  合约地址未配置，代提交功能不可用")
            return

        try:
            from web3 import Web3

            self.w3 = _create_web3_with_timeout()
            if not self.w3.is_connected():
                _safe_log(f"⚠️  Relayer 无法连接 RPC: {RPC_URL}")
                return

            # 从私钥派生账户（私钥不写入任何日志）
            self.relayer_account = self.w3.eth.account.from_key(RELAYER_PRIVATE_KEY)
            actual_address = self.relayer_account.address

            # 校验配置的 RELAYER_ADDRESS 与私钥派生地址是否一致
            if RELAYER_ADDRESS and RELAYER_ADDRESS.lower() != actual_address.lower():
                _safe_log(
                    f"⚠️  RELAYER_ADDRESS({RELAYER_ADDRESS}) 与私钥派生地址({actual_address})不一致，"
                    f"将以私钥派生地址为准"
                )

            self.contract = self.w3.eth.contract(
                address=CONTRACT_ADDRESS,
                abi=CONTRACT_ABI,
            )
            self._available = True
            # 仅打印地址前 10 位，绝不打印私钥
            _safe_log(f"✅ Relayer 初始化成功，地址: {actual_address[:10]}...")

        except Exception as e:
            # 异常信息中可能含敏感字段，仅打印异常类型与消息（私钥不会出现在 web3 异常中）
            _safe_log(f"⚠️  Relayer 初始化失败: {e}")
            self._available = False

    # ==================== 基础访问 ====================

    # 检查服务是否可用
    def is_available(self) -> bool:
        """返回 relayer 代提交服务是否可用（综合考虑初始化与最新健康状态）"""
        # 若初始化失败，直接返回不可用
        if not self._available:
            return False
        # 若最新健康状态已标记为不健康，返回不可用（触发前端降级）
        return self._health_status.get("healthy", False)

    # 获取 relayer 地址
    def get_relayer_address(self) -> Optional[str]:
        """返回 relayer 钱包地址（供前端 authorizeRelayer 使用）"""
        if self.relayer_account:
            return self.relayer_account.address
        return None

    # 获取健康状态快照（F1-05）
    def get_health_status(self) -> dict:
        """返回 relayer 健康状态快照（不含私钥等敏感信息，可安全返回给前端）"""
        return {
            "available": self._available,
            **self._health_status,
        }

    # ==================== 健康检测（F1-05） ====================

    async def check_health(self) -> dict:
        """
        执行一次健康检测：
        1. RPC 连通性
        2. relayer 钱包余额（是否 >= MIN_RELAYER_BALANCE_WEI）
        3. 本地 nonce 与链上 nonce 是否同步

        检测完成后更新内部状态，若状态由健康变为不健康（或反之），通过 WebSocket 通知前端降级/恢复。
        """
        prev_healthy = self._health_status.get("healthy", False)

        new_status = {
            "healthy": False,
            "rpc_reachable": False,
            "balance_sufficient": False,
            "nonce_synced": False,
            "balance_wei": "0",
            "local_nonce": self._local_nonce or 0,
            "chain_nonce": 0,
            "last_check": datetime.now(timezone.utc).isoformat(),
            "error": None,
        }

        if not self._available or not self.w3 or not self.relayer_account:
            new_status["error"] = "Relayer 未初始化"
            self._health_status = new_status
            await self._maybe_notify_degradation(prev_healthy, new_status["healthy"])
            return new_status

        # 1. RPC 连通性
        try:
            reachable = await _run_sync(lambda: self.w3.is_connected())
            new_status["rpc_reachable"] = bool(reachable)
            if not reachable:
                new_status["error"] = "RPC 不可达"
                self._health_status = new_status
                await self._maybe_notify_degradation(prev_healthy, new_status["healthy"])
                return new_status
        except Exception as e:
            new_status["error"] = f"RPC 检测异常: {e}"
            self._health_status = new_status
            await self._maybe_notify_degradation(prev_healthy, new_status["healthy"])
            return new_status

        # 2. 余额检查
        try:
            balance = await _run_sync(
                lambda: self.w3.eth.get_balance(self.relayer_account.address)
            )
            new_status["balance_wei"] = str(balance)
            new_status["balance_sufficient"] = balance >= MIN_RELAYER_BALANCE_WEI
            if not new_status["balance_sufficient"]:
                new_status["error"] = "Relayer 余额不足"
        except Exception as e:
            new_status["error"] = f"余额查询失败: {e}"
            self._health_status = new_status
            await self._maybe_notify_degradation(prev_healthy, new_status["healthy"])
            return new_status

        # 3. nonce 同步
        try:
            chain_nonce = await _run_sync(
                lambda: self.w3.eth.get_transaction_count(self.relayer_account.address)
            )
            new_status["chain_nonce"] = chain_nonce
            # 本地 nonce 未初始化时，以链上为准
            if self._local_nonce is None:
                self._local_nonce = chain_nonce
                new_status["local_nonce"] = chain_nonce
                new_status["nonce_synced"] = True
            else:
                new_status["local_nonce"] = self._local_nonce
                # 本地 nonce 不应落后于链上 pending nonce
                new_status["nonce_synced"] = self._local_nonce >= chain_nonce
                if not new_status["nonce_synced"]:
                    new_status["error"] = (
                        f"Nonce 不同步：local={self._local_nonce} chain={chain_nonce}"
                    )
        except Exception as e:
            new_status["error"] = f"nonce 查询失败: {e}"
            self._health_status = new_status
            await self._maybe_notify_degradation(prev_healthy, new_status["healthy"])
            return new_status

        # 综合判定
        new_status["healthy"] = (
            new_status["rpc_reachable"]
            and new_status["balance_sufficient"]
            and new_status["nonce_synced"]
        )
        self._health_status = new_status

        await self._maybe_notify_degradation(prev_healthy, new_status["healthy"])
        return new_status

    # 状态变更时通过 WebSocket 通知前端（F1-05 降级）
    async def _maybe_notify_degradation(self, prev_healthy: bool, curr_healthy: bool):
        """健康状态发生翻转时，通过 WebSocket 通知前端降级/恢复"""
        if prev_healthy == curr_healthy:
            return
        try:
            # 延迟导入避免循环依赖
            from rps_backend.websocket import ws_manager
            from rps_backend.models import WSMessage

            if curr_healthy:
                # 不健康 -> 健康：恢复 gasless 模式
                await ws_manager.broadcast(WSMessage(
                    type="relayer_status_changed",
                    data={
                        "healthy": True,
                        "gasless_available": True,
                        "message": "Relayer 已恢复，可使用 gasless 模式",
                    },
                ))
                _safe_log("✅ Relayer 健康恢复，已通知前端启用 gasless 模式")
            else:
                # 健康 -> 不健康：降级到玩家自付 gas
                await ws_manager.broadcast(WSMessage(
                    type="relayer_status_changed",
                    data={
                        "healthy": False,
                        "gasless_available": False,
                        "message": "Relayer 不可用，前端请降级到玩家自付 gas 模式",
                        "reason": self._health_status.get("error", "unknown"),
                    },
                ))
                _safe_log("⚠️  Relayer 不可用，已通知前端降级到玩家自付 gas 模式")
        except Exception as e:
            _safe_log(f"[Relayer] 通知前端降级失败: {e}")

    # 启动周期性健康检测任务
    async def start_health_check_loop(self):
        """启动周期性健康检测任务（由 main.py lifespan 调用）"""
        if self._health_check_task and not self._health_check_task.done():
            return
        # 立即执行一次，再进入周期
        self._health_check_task = asyncio.create_task(self._health_check_loop())
        _safe_log("[Relayer] 健康检测任务已启动")

    async def _health_check_loop(self):
        """周期性执行健康检测"""
        while True:
            try:
                await self.check_health()
            except Exception as e:
                _safe_log(f"[Relayer] 健康检测异常: {e}")
            await asyncio.sleep(HEALTH_CHECK_INTERVAL)

    # ==================== 并发队列（P1-01） ====================

    def _get_player_queue(self, player: str) -> asyncio.Queue:
        """
        获取（或创建）玩家对应的串行队列。
        同一玩家的交易排队执行，不同玩家并行执行。
        """
        key = player.lower()
        if key not in self._player_queues:
            self._player_queues[key] = asyncio.Queue()
            # 启动该玩家的 worker
            self._player_workers[key] = asyncio.create_task(self._player_worker(key))
        return self._player_queues[key]

    async def _player_worker(self, player_key: str):
        """
        单个玩家的串行 worker：从队列依次取出交易任务执行。
        同一玩家的交易保证按入队顺序执行，避免 nonce 冲突。
        """
        queue = self._player_queues[player_key]
        while True:
            task = await queue.get()
            try:
                await task
            except Exception as e:
                _safe_log(f"[Relayer] 玩家 {player_key[:10]}... 队列任务异常: {e}")
            finally:
                queue.task_done()

    async def _enqueue_and_wait(self, player: str, coro_factory):
        """
        将交易任务投递到玩家队列并等待结果。

        Args:
            player: 玩家地址
            coro_factory: 无参数可调用对象，返回要执行的协程（每次调用产生新协程）
        """
        if not self._available:
            # 服务不可用时直接返回失败，不进队列
            return {"success": False, "message": "Relayer 服务不可用"}

        queue = self._get_player_queue(player)
        future: asyncio.Future = asyncio.get_running_loop().create_future()

        async def _runner():
            try:
                result = await coro_factory()
                future.set_result(result)
            except Exception as e:
                future.set_exception(e)

        await queue.put(_runner())
        return await future

    # ==================== Stuck 交易重发（P1-02） ====================

    async def start_stuck_tx_monitor(self):
        """启动 stuck 交易监控任务（由 main.py lifespan 调用）"""
        if self._stuck_check_task and not self._stuck_check_task.done():
            return
        self._stuck_check_task = asyncio.create_task(self._stuck_tx_loop())
        _safe_log("[Relayer] Stuck 交易监控任务已启动")

    async def _stuck_tx_loop(self):
        """周期性扫描 pending 交易，超时未确认的自动 bump gas 重发"""
        while True:
            try:
                await self._check_stuck_txs()
            except Exception as e:
                _safe_log(f"[Relayer] Stuck 交易扫描异常: {e}")
            await asyncio.sleep(30)  # 每 30 秒扫描一次

    async def _check_stuck_txs(self):
        """扫描 pending 交易，处理超时的"""
        if not self._available or not self.w3:
            return
        now = time.time()
        async with self._pending_lock:
            stuck_items = []
            for tx_hash, info in list(self._pending_txs.items()):
                if now - info["submit_time"] >= STUCK_TX_TIMEOUT:
                    stuck_items.append((tx_hash, info))
            # 取出待处理项后释放锁，避免长时间持锁

        for tx_hash, info in stuck_items:
            await self._handle_stuck_tx(tx_hash, info)

    async def _handle_stuck_tx(self, tx_hash: str, info: dict):
        """处理单个 stuck 交易：检查是否真的未确认，bump gas 后重发"""
        try:
            # 先检查是否已被确认
            receipt = await _run_sync(
                lambda: self.w3.eth.get_transaction_receipt(tx_hash)
            )
            if receipt is not None and receipt.get("status") is not None:
                # 已确认，从 pending 列表移除
                async with self._pending_lock:
                    self._pending_txs.pop(tx_hash, None)
                return
        except Exception:
            # 未确认会抛异常，继续走重发流程
            pass

        # bump gas 重发：使用同一 nonce，提升 gas price
        bump_count = info.get("bump_count", 0)
        if bump_count >= 3:
            _safe_log(
                f"[Relayer] Stuck 交易 {tx_hash[:18]}... 已重发 {bump_count} 次仍卡住，放弃"
            )
            async with self._pending_lock:
                self._pending_txs.pop(tx_hash, None)
            return

        old_gas_price = info.get("gas_price", 0)
        new_gas_price = int(old_gas_price * STUCK_TX_GAS_BUMP_RATIO) if old_gas_price else 0
        if new_gas_price == 0:
            try:
                new_gas_price = await _run_sync(lambda: self.w3.eth.gas_price)
            except Exception as e:
                _safe_log(f"[Relayer] 获取 gas price 失败: {e}")
                return

        try:
            tx_data = info.get("tx_data")
            if not tx_data:
                async with self._pending_lock:
                    self._pending_txs.pop(tx_hash, None)
                return

            # 重建交易：同 nonce + 提升 gas price
            new_tx = dict(tx_data)
            new_tx["gasPrice"] = new_gas_price
            new_tx["nonce"] = info["nonce"]

            signed = self.relayer_account.sign_transaction(new_tx)
            new_tx_hash = await _run_sync(
                lambda: self.w3.eth.send_raw_transaction(signed.raw_transaction)
            )
            new_tx_hash_hex = new_tx_hash.hex() if hasattr(new_tx_hash, "hex") else str(new_tx_hash)

            _safe_log(
                f"[Relayer] Stuck 交易 {tx_hash[:18]}... 已 bump gas "
                f"({old_gas_price} -> {new_gas_price}) 重发为新 {new_tx_hash_hex[:18]}... "
                f"(bump #{bump_count + 1})"
            )

            # 更新 pending 追踪
            async with self._pending_lock:
                self._pending_txs.pop(tx_hash, None)
                self._pending_txs[new_tx_hash_hex] = {
                    "submit_time": time.time(),
                    "nonce": info["nonce"],
                    "gas_price": new_gas_price,
                    "tx_data": new_tx,
                    "bump_count": bump_count + 1,
                }
        except Exception as e:
            _safe_log(f"[Relayer] Stuck 交易 {tx_hash[:18]}... 重发失败: {e}")
            async with self._pending_lock:
                self._pending_txs.pop(tx_hash, None)

    def _track_pending_tx(self, tx_hash_hex: str, nonce: int, gas_price: int, tx_data: dict):
        """登记 pending 交易，供 stuck 监控扫描"""
        asyncio.ensure_future(self._track_pending_tx_async(tx_hash_hex, nonce, gas_price, tx_data))

    async def _track_pending_tx_async(self, tx_hash_hex: str, nonce: int, gas_price: int, tx_data: dict):
        async with self._pending_lock:
            self._pending_txs[tx_hash_hex] = {
                "submit_time": time.time(),
                "nonce": nonce,
                "gas_price": gas_price,
                "tx_data": tx_data,
                "bump_count": 0,
            }

    async def _wait_and_untrack(self, tx_hash_hex: str, timeout: int = 120) -> bool:
        """等待交易确认，确认后从 pending 列表移除"""
        try:
            receipt = await _run_sync(
                lambda: self.w3.eth.wait_for_transaction_receipt(
                    tx_hash_hex if isinstance(tx_hash_hex, str) else tx_hash_hex,
                    timeout=timeout,
                )
            )
            return True
        finally:
            async with self._pending_lock:
                self._pending_txs.pop(tx_hash_hex, None)

    # ==================== 代提交（方案A） ====================

    # 代提交 commit（方案A）
    async def submit_commit_with_sig(
        self,
        game_id: int,
        player: str,
        commit_hash: str,
        nonce: int,
        v: int,
        r: str,
        s: str,
    ) -> dict:
        """
        代提交 commit（方案A） - relayer 调用合约 submitCommitWithSig
        投递到玩家队列串行执行，避免 nonce 冲突。

        安全说明：本函数不接收也不打印任何私钥信息。
        """
        async def _factory():
            return await self._do_submit_commit_with_sig(
                game_id, player, commit_hash, nonce, v, r, s
            )
        return await self._enqueue_and_wait(player, _factory)

    async def _do_submit_commit_with_sig(
        self,
        game_id: int,
        player: str,
        commit_hash: str,
        nonce: int,
        v: int,
        r: str,
        s: str,
    ) -> dict:
        """实际执行代提交 commit（在玩家 worker 中串行执行）"""
        if not self._available:
            return {"success": False, "message": "Relayer 服务不可用"}

        try:
            # 获取本地 nonce（带锁，避免并发冲突）
            async with self._nonce_lock:
                if self._local_nonce is None:
                    self._local_nonce = await _run_sync(
                        lambda: self.w3.eth.get_transaction_count(self.relayer_account.address)
                    )
                tx_nonce = self._local_nonce
                # 提前自增，下一次调用使用新 nonce
                self._local_nonce = tx_nonce + 1

            def _from_hex(x):
                return bytes.fromhex(x[2:]) if isinstance(x, str) and x.startswith("0x") else bytes.fromhex(x)

            gas_price = await _run_sync(lambda: self.w3.eth.gas_price)

            tx = self.contract.functions.submitCommitWithSig(
                game_id,
                self.w3.to_checksum_address(player),
                _from_hex(commit_hash),
                nonce,
                v,
                _from_hex(r),
                _from_hex(s),
            ).build_transaction({
                "from": self.relayer_account.address,
                "nonce": tx_nonce,
                "gas": 300000,
                "gasPrice": gas_price,
            })

            # 签名并发送（私钥仅在 relayer_account 内部使用，不出现在日志）
            signed = self.relayer_account.sign_transaction(tx)
            tx_hash = await _run_sync(
                lambda: self.w3.eth.send_raw_transaction(signed.raw_transaction)
            )
            tx_hash_hex = tx_hash.hex() if hasattr(tx_hash, "hex") else str(tx_hash)

            # 登记 pending 供 stuck 监控
            self._track_pending_tx(tx_hash_hex, tx_nonce, gas_price, tx)

            # 等待 1 个确认（同时从 pending 列表移除）
            await self._wait_and_untrack(tx_hash_hex, timeout=120)

            return {
                "success": True,
                "tx_hash": tx_hash_hex,
                "message": "代提交 commit 成功"
            }

        except Exception as e:
            err_msg = str(e)
            # nonce 回滚（避免本地 nonce 超前导致永久 stuck）
            async with self._nonce_lock:
                if self._local_nonce is not None and "nonce" in err_msg.lower() or "replacement" in err_msg.lower():
                    # 仅在 nonce 类错误时回滚
                    pass
            # 识别常见错误
            if "Nonce mismatch" in err_msg:
                return {"success": False, "message": "Nonce 不匹配，签名可能已被使用"}
            if "Invalid signature" in err_msg:
                return {"success": False, "message": "签名校验失败"}
            if "Not in commit phase" in err_msg:
                return {"success": False, "message": "对局不在提交阶段"}
            if "Already committed" in err_msg:
                return {"success": False, "message": "已提交过 commit"}
            if "nonce too low" in err_msg.lower() or "replacement transaction underpriced" in err_msg.lower():
                # 强制重新同步 nonce
                async with self._nonce_lock:
                    try:
                        self._local_nonce = await _run_sync(
                            lambda: self.w3.eth.get_transaction_count(self.relayer_account.address)
                        )
                    except Exception:
                        pass
                return {"success": False, "message": f"代提交 commit 失败（nonce 已重新同步）: {err_msg}"}
            return {"success": False, "message": f"代提交 commit 失败: {err_msg}"}

    # 代提交 reveal（方案A）
    async def reveal_choice_with_sig(
        self,
        game_id: int,
        player: str,
        choice: int,
        salt: str,
        nonce: int,
        v: int,
        r: str,
        s: str,
    ) -> dict:
        """
        代提交 reveal（方案A） - relayer 调用合约 revealChoiceWithSig
        投递到玩家队列串行执行，避免 nonce 冲突。

        安全说明：本函数不接收也不打印任何私钥信息。
        """
        async def _factory():
            return await self._do_reveal_choice_with_sig(
                game_id, player, choice, salt, nonce, v, r, s
            )
        return await self._enqueue_and_wait(player, _factory)

    async def _do_reveal_choice_with_sig(
        self,
        game_id: int,
        player: str,
        choice: int,
        salt: str,
        nonce: int,
        v: int,
        r: str,
        s: str,
    ) -> dict:
        """实际执行代提交 reveal（在玩家 worker 中串行执行）"""
        if not self._available:
            return {"success": False, "message": "Relayer 服务不可用"}

        try:
            async with self._nonce_lock:
                if self._local_nonce is None:
                    self._local_nonce = await _run_sync(
                        lambda: self.w3.eth.get_transaction_count(self.relayer_account.address)
                    )
                tx_nonce = self._local_nonce
                self._local_nonce = tx_nonce + 1

            def _from_hex(x):
                return bytes.fromhex(x[2:]) if isinstance(x, str) and x.startswith("0x") else bytes.fromhex(x)

            gas_price = await _run_sync(lambda: self.w3.eth.gas_price)

            tx = self.contract.functions.revealChoiceWithSig(
                game_id,
                self.w3.to_checksum_address(player),
                choice,
                _from_hex(salt),
                nonce,
                v,
                _from_hex(r),
                _from_hex(s),
            ).build_transaction({
                "from": self.relayer_account.address,
                "nonce": tx_nonce,
                "gas": 400000,  # reveal 触发结算，gas 略高
                "gasPrice": gas_price,
            })

            signed = self.relayer_account.sign_transaction(tx)
            tx_hash = await _run_sync(
                lambda: self.w3.eth.send_raw_transaction(signed.raw_transaction)
            )
            tx_hash_hex = tx_hash.hex() if hasattr(tx_hash, "hex") else str(tx_hash)

            self._track_pending_tx(tx_hash_hex, tx_nonce, gas_price, tx)
            await self._wait_and_untrack(tx_hash_hex, timeout=120)

            return {
                "success": True,
                "tx_hash": tx_hash_hex,
                "message": "代提交 reveal 成功"
            }

        except Exception as e:
            err_msg = str(e)
            if "Nonce mismatch" in err_msg:
                return {"success": False, "message": "Nonce 不匹配，签名可能已被使用"}
            if "Invalid signature" in err_msg:
                return {"success": False, "message": "签名校验失败"}
            if "Not in reveal phase" in err_msg:
                return {"success": False, "message": "对局不在揭晓阶段"}
            if "Commit mismatch" in err_msg:
                return {"success": False, "message": "哈希承诺不匹配"}
            if "Already revealed" in err_msg:
                return {"success": False, "message": "已揭晓过"}
            if "nonce too low" in err_msg.lower() or "replacement transaction underpriced" in err_msg.lower():
                async with self._nonce_lock:
                    try:
                        self._local_nonce = await _run_sync(
                            lambda: self.w3.eth.get_transaction_count(self.relayer_account.address)
                        )
                    except Exception:
                        pass
                return {"success": False, "message": f"代提交 reveal 失败（nonce 已重新同步）: {err_msg}"}
            return {"success": False, "message": f"代提交 reveal 失败: {err_msg}"}

    # 查询玩家 relayer 授权状态（方案B）
    async def get_relayer_authorization(self, player: str) -> dict:
        """
        查询玩家的 relayer 授权状态

        Returns:
            {"active": bool, "relayer": str, "deadline": int}
        """
        if not self._available:
            return {"active": False, "relayer": "", "deadline": 0}

        try:
            result = await _run_sync(
                self.contract.functions.getRelayerAuthorization(
                    self.w3.to_checksum_address(player)
                ).call
            )
            return {
                "active": result[0],
                "relayer": result[1],
                "deadline": result[2]
            }
        except Exception as e:
            _safe_log(f"⚠️  查询 relayer 授权状态失败: {e}")
            return {"active": False, "relayer": "", "deadline": 0}


# 全局 relayer 服务实例
relayer_service = RelayerService()
