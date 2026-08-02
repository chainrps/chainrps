"""
ChainRPS 机器人（Bot）核心服务模块 v3.0（多实例版）

提供测试链环境下的 Bot 陪玩功能：
- BotInstance: 单个 Bot 实例，独立钱包地址，独立配置
- BotService: 保持向后兼容的单例入口（包装 BotInstance）

每个 BotInstance 支持：
- 独立钱包地址（Ganache 账户索引）
- 5 种出拳策略（random/aggressive/conservative/mimic/balanced）
- 自动创建/加入房间 → 自动准备 → 等待玩家
- 自动链上交互（createMatch/joinMatch）
- 自动生成签名、提交 commit/reveal（通过 Relayer 代提交）
- 监听对手状态，完成全流程对战
- 结算后自动清理，循环陪玩
- 持久化存储到 SQLite（bot_instances/bot_logs/bot_active_rooms）

安全约束：
- 仅限测试链（RPC_CHAIN_ID == 5208888）启用
- 操作频率限制，防止刷量
- 完整日志审计
- Bot 钱包独立，仅用于测试

版本: v3.0 - 多实例集群支持
"""
import asyncio
import logging
import os
import secrets
import time
from datetime import datetime, timezone
from functools import partial
from typing import Dict, Optional, List, Any

from rps_backend.config import (
    BOT_ENABLED,
    BOT_DEFAULT_STRATEGY,
    BOT_TOKEN,
    BOT_BET_AMOUNT,
    BOT_AUTO_CREATE_ROOM,
    BOT_AUTO_JOIN_ROOM,
    BOT_CREATE_INTERVAL,
    BOT_SCAN_INTERVAL,
    BOT_COMMIT_DELAY,
    BOT_REVEAL_DELAY,
    BOT_MAX_CONCURRENT_ROOMS,
    BOT_LABEL,
    BOT_WALLET_BALANCE_THRESHOLD,
    BOT_AUTO_CHAIN_MATCH,
    RPC_CHAIN_ID,
    RPC_URL,
    RPC_SYMBOL,
    CONTRACT_ADDRESS,
)
from rps_backend.models import Choice
from rps_backend.service.room_service import room_manager, ROOM_STATUS
from rps_backend.service.game_service import game_manager
from rps_backend.service.local_chain_service import get_local_chain_service
from rps_backend.service.relayer_service import relayer_service
from rps_backend.service.strategy import generate_choice, get_strategy_info, VALID_STRATEGIES
from rps_backend.repository import (
    create_bot_instance as db_create_bot_instance,
    get_bot_instance as db_get_bot_instance,
    list_bot_instances as db_list_bot_instances,
    update_bot_instance as db_update_bot_instance,
    delete_bot_instance as db_delete_bot_instance,
    add_bot_log,
    get_bot_logs,
    add_bot_active_room,
    remove_bot_active_room,
    increment_bot_stats,
)
from rps_backend.utils.helpers import now_timestamp

logger = logging.getLogger(__name__)

_ABI_PATH = os.path.join(
    os.path.dirname(os.path.dirname(os.path.dirname(__file__))),
    "contracts", "abi", "ChainRPS.json"
)


async def _run_sync(func, *args, **kwargs):
    loop = asyncio.get_running_loop()
    return await loop.run_in_executor(None, partial(func, *args, **kwargs))


# ==================== BotConfig ====================

class BotConfig:
    """Bot 行为配置类"""

    def __init__(self, **kwargs):
        self.strategy: str = kwargs.get("strategy", BOT_DEFAULT_STRATEGY)
        self.token: str = kwargs.get("token", BOT_TOKEN)
        self.bet_amount: float = kwargs.get("bet_amount", BOT_BET_AMOUNT)
        self.auto_create_room: bool = kwargs.get("auto_create_room", BOT_AUTO_CREATE_ROOM)
        self.auto_join_room: bool = kwargs.get("auto_join_room", BOT_AUTO_JOIN_ROOM)
        self.create_interval: int = kwargs.get("create_interval", BOT_CREATE_INTERVAL)
        self.scan_interval: int = kwargs.get("scan_interval", BOT_SCAN_INTERVAL)
        self.commit_delay: int = kwargs.get("commit_delay", BOT_COMMIT_DELAY)
        self.reveal_delay: int = kwargs.get("reveal_delay", BOT_REVEAL_DELAY)
        self.max_concurrent_rooms: int = kwargs.get("max_concurrent_rooms", BOT_MAX_CONCURRENT_ROOMS)
        self.bot_label: str = kwargs.get("bot_label", BOT_LABEL)
        self.wallet_balance_threshold: float = kwargs.get(
            "wallet_balance_threshold", BOT_WALLET_BALANCE_THRESHOLD
        )
        self.auto_chain_match: bool = kwargs.get("auto_chain_match", BOT_AUTO_CHAIN_MATCH)
        self.topup_eth_amount: float = kwargs.get("topup_eth_amount", 1000.0)
        self.topup_usdc_amount: float = kwargs.get("topup_usdc_amount", 10000.0)
        self.mimic_choice: int = kwargs.get("mimic_choice", 1)

    def update(self, **kwargs) -> None:
        for key, value in kwargs.items():
            if hasattr(self, key) and value is not None:
                setattr(self, key, value)

    def to_dict(self) -> dict:
        return {
            "strategy": self.strategy,
            "token": self.token,
            "bet_amount": self.bet_amount,
            "auto_create_room": self.auto_create_room,
            "auto_join_room": self.auto_join_room,
            "create_interval": self.create_interval,
            "scan_interval": self.scan_interval,
            "commit_delay": self.commit_delay,
            "reveal_delay": self.reveal_delay,
            "max_concurrent_rooms": self.max_concurrent_rooms,
            "bot_label": self.bot_label,
            "wallet_balance_threshold": self.wallet_balance_threshold,
            "auto_chain_match": self.auto_chain_match,
            "topup_eth_amount": self.topup_eth_amount,
            "topup_usdc_amount": self.topup_usdc_amount,
            "mimic_choice": self.mimic_choice,
        }


# ==================== BotInstance ====================

class BotInstance:
    """
    单个 Bot 实例（v3.0 多实例版）

    每个 BotInstance 拥有独立的钱包地址、配置和运行状态，
    支持完整的机器人陪玩流程：
    1. 大厅扫描 → 创建/加入房间
    2. 自动准备 → 等待玩家 → 倒计时 → 游戏开始
    3. 创建链上对局（createMatch/joinMatch）
    4. 按策略生成出拳 → 提交 commit → Reveal
    5. 等待结算 → 记录结果 → 循环
    """

    def __init__(self, bot_id: str, name: str, wallet_index: int,
                 wallet_address: str, **config_kwargs):
        self.bot_id: str = bot_id
        self.name: str = name
        self.wallet_index: int = wallet_index
        self.wallet_address: str = wallet_address
        self._wallet_address: str = wallet_address  # 私有属性，与公开属性同步

        self._config = BotConfig(**config_kwargs)
        self._status: str = "idle"  # idle/running/paused/error
        self._error_message: Optional[str] = None

        self._is_running: bool = False
        self._wallet_private_key: Optional[str] = None
        self._wallet_account = None
        self._wallet_available: bool = False

        self._w3 = None
        self._contract = None
        self._contract_abi = []

        self._active_rooms: Dict[str, dict] = {}
        self._active_games: Dict[int, dict] = {}

        self._total_rooms_created: int = 0
        self._total_rooms_joined: int = 0
        self._total_games_played: int = 0
        self._total_wins: int = 0
        self._total_losses: int = 0
        self._total_draws: int = 0
        self._total_chain_matches: int = 0
        self._started_at: Optional[datetime] = None

        self._scan_task: Optional[asyncio.Task] = None
        self._game_tasks: Dict[int, asyncio.Task] = {}

        self._last_create_time: float = 0
        self._wallet_nonce: Optional[int] = None
        self._nonce_lock = asyncio.Lock()

        self._choice_history: List[int] = []

    # ==================== 日志 ====================

    def _log(self, level: str, message: str, details: str = None) -> None:
        """写入 Bot 日志（内存+数据库）"""
        log_func = getattr(logger, level.lower(), logger.info)
        log_func(f"[Bot:{self.bot_id}] {message}")
        try:
            add_bot_log(self.bot_id, level, message, details)
        except Exception:
            pass

    # ==================== 初始化 ====================

    async def initialize(self) -> bool:
        """初始化 Bot 钱包、Web3 连接和合约"""
        if RPC_CHAIN_ID != 5208888:
            self._log("WARN", f"Bot 仅在测试链 (5208888) 启用，当前: {RPC_CHAIN_ID}")
            return False

        chain_svc = get_local_chain_service()
        if not chain_svc.is_running():
            self._log("WARN", "本地链未运行，Bot 无法初始化")
            return False

        self._contract_abi = self._load_contract_abi()
        if self._contract_abi and CONTRACT_ADDRESS:
            try:
                from web3 import Web3
                self._w3 = chain_svc._w3
                if self._w3 and self._w3.is_connected():
                    if Web3.is_address(CONTRACT_ADDRESS):
                        self._contract = self._w3.eth.contract(
                            address=CONTRACT_ADDRESS, abi=self._contract_abi,
                        )
                        self._log("INFO", f"合约已加载: {CONTRACT_ADDRESS[:10]}...")
            except Exception as e:
                self._log("WARN", f"合约初始化失败: {e}")

        self._wallet_private_key = self._derive_private_key(chain_svc)
        if self._wallet_private_key:
            try:
                from web3 import Web3
                self._wallet_account = self._w3.eth.account.from_key(
                    self._wallet_private_key
                )
                self._wallet_available = True
                self._wallet_address = self._wallet_account.address
                self._wallet_nonce = await _run_sync(
                    lambda: self._w3.eth.get_transaction_count(self._wallet_address)
                )
                self._log("INFO", f"钱包初始化成功: {self._wallet_address}")
            except Exception as e:
                self._log("ERROR", f"钱包账户创建失败: {e}")
                return False
        else:
            self._log("ERROR", "私钥派生失败")
            return False

        return True

    def _load_contract_abi(self) -> list:
        if os.path.exists(_ABI_PATH):
            try:
                import json
                with open(_ABI_PATH, "r", encoding="utf-8") as f:
                    return json.load(f)
            except Exception as e:
                self._log("WARN", f"ABI 加载失败: {e}")
        return []

    def _derive_private_key(self, chain_svc) -> Optional[str]:
        if chain_svc._private_keys and self.wallet_index < len(chain_svc._private_keys):
            pk = chain_svc._private_keys[self.wallet_index]
            if pk:
                return pk

        default_keys = [
            "0x4c0883a69102937d6231471b5dbb6204fe512961708279f5d6e8e0a2e7a7f1e",
            "0x5de41c302889a5678c4b7a0b3c4e5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f0a1b2",
            "0x3c7d9f2e4a1b5c6d8e9f0a2b4c6d8e0a2b4c6d8e9f0a2b4c6d8e9f0a2b4c6d8",
            "0x4b6c8d9e0f1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b1c2d3e4f5a6b7",
            "0x5c7d9e0f1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b1c2d3e4f5a6b7c8",
            "0x6d8e9f0a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d9",
            "0x7e9f0a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e0",
            "0x8f0a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f1",
            "0x9a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f0a2",
            "0xab2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f0a1b3",
        ]
        if self.wallet_index < len(default_keys):
            return default_keys[self.wallet_index]

        import hashlib
        seed = f"chainrps_bot_wallet_{RPC_CHAIN_ID}_{self.wallet_index}"
        key_bytes = hashlib.sha256(seed.encode()).digest()
        return "0x" + key_bytes.hex()

    # ==================== 启动/停止 ====================

    async def start(self) -> bool:
        if self._is_running:
            return False

        if not self._wallet_available:
            success = await self.initialize()
            if not success:
                self._status = "error"
                self._error_message = "钱包初始化失败"
                return False

        # 清理残留状态：确保 Bot 钱包不在任何房间的 _player_rooms 中
        # 防止上次异常退出导致的状态残留
        if self._wallet_address:
            room_manager.cleanup_player_rooms(self._wallet_address)

        self._is_running = True
        self._status = "running"
        self._error_message = None
        self._started_at = datetime.now(timezone.utc)

        self._scan_task = asyncio.create_task(self._scan_lobby_loop())
        self._log("INFO", f"Bot 已启动，钱包: {self._wallet_address}")

        db_update_bot_instance(self.bot_id, {
            "status": "running",
            "started_at": self._started_at.isoformat(),
            "error_message": None,
        })
        return True

    async def stop(self) -> bool:
        if not self._is_running:
            return False

        self._is_running = False
        self._status = "paused"

        if self._scan_task and not self._scan_task.done():
            self._scan_task.cancel()

        for game_id, task in self._game_tasks.items():
            if not task.done():
                task.cancel()
        self._game_tasks.clear()
        self._active_rooms.clear()
        self._active_games.clear()

        self._log("INFO", "Bot 已停止")
        db_update_bot_instance(self.bot_id, {"status": "paused"})
        return True

    async def restart(self) -> bool:
        await self.stop()
        await asyncio.sleep(1)
        return await self.start()

    # ==================== 状态查询 ====================

    def get_status(self) -> dict:
        return {
            "bot_id": self.bot_id,
            "name": self.name,
            "is_running": self._is_running,
            "status": self._status,
            "wallet_address": self._wallet_address,
            "wallet_available": self._wallet_available,
            "active_rooms": len(self._active_rooms),
            "active_games": len(self._active_games),
            "total_rooms_created": self._total_rooms_created,
            "total_rooms_joined": self._total_rooms_joined,
            "total_games_played": self._total_games_played,
            "total_wins": self._total_wins,
            "total_losses": self._total_losses,
            "total_draws": self._total_draws,
            "total_chain_matches": self._total_chain_matches,
            "started_at": self._started_at.isoformat() if self._started_at else None,
            "config": self._config.to_dict(),
            "error_message": self._error_message,
        }

    def get_wallet_info(self) -> dict:
        result = {
            "address": self._wallet_address,
            "balance_eth": 0.0,
            "balance_usdc": 0.0,
            "sufficient": False,
            "threshold": self._config.wallet_balance_threshold,
        }
        if not self._w3 or not self._wallet_address:
            return result
        try:
            from web3 import Web3
            if self._w3.is_connected():
                balance_wei = self._w3.eth.get_balance(self._wallet_address)
                result["balance_eth"] = float(self._w3.from_wei(balance_wei, 'ether'))
                chain_svc = get_local_chain_service()
                usdc_token = chain_svc._tokens.get("USDC")
                if usdc_token:
                    abi_json = [
                        {"inputs": [{"name": "account", "type": "address"}],
                         "name": "balanceOf", "outputs": [{"name": "", "type": "uint256"}],
                         "stateMutability": "view", "type": "function"},
                        {"inputs": [], "name": "decimals",
                         "outputs": [{"name": "", "type": "uint8"}],
                         "stateMutability": "view", "type": "function"},
                    ]
                    usdc_addr = self._w3.to_checksum_address(usdc_token["address"])
                    usdc_contract = self._w3.eth.contract(address=usdc_addr, abi=abi_json)
                    decimals = usdc_contract.functions.decimals().call()
                    raw = usdc_contract.functions.balanceOf(self._wallet_address).call()
                    result["balance_usdc"] = float(raw / (10 ** decimals))
                result["sufficient"] = (
                    result["balance_eth"] >= self._config.wallet_balance_threshold
                    and result["balance_usdc"] >= self._config.bet_amount
                )
        except Exception as e:
            self._log("ERROR", f"钱包余额查询失败: {e}")
        return result

    def update_config(self, **kwargs) -> dict:
        self._config.update(**kwargs)
        db_update_bot_instance(self.bot_id, {
            "strategy": self._config.strategy,
            "token": self._config.token,
            "bet_amount": self._config.bet_amount,
            "auto_create_room": 1 if self._config.auto_create_room else 0,
            "auto_join_room": 1 if self._config.auto_join_room else 0,
            "create_interval": self._config.create_interval,
            "scan_interval": self._config.scan_interval,
            "commit_delay": self._config.commit_delay,
            "reveal_delay": self._config.reveal_delay,
            "max_concurrent_rooms": self._config.max_concurrent_rooms,
            "wallet_balance_threshold": self._config.wallet_balance_threshold,
        })
        return self._config.to_dict()

    # ==================== 钱包充值 ====================

    async def ensure_wallet_funded(self) -> dict:
        wallet_info = self.get_wallet_info()
        result = {"address": self._wallet_address, "eth_topup": False,
                   "usdc_topup": False, "message": ""}
        chain_svc = get_local_chain_service()
        if not chain_svc.is_running():
            result["message"] = "本地链未运行"
            return result
        if wallet_info["balance_eth"] < self._config.wallet_balance_threshold:
            try:
                chain_svc.send_eth(0, self._wallet_address, self._config.topup_eth_amount)
                result["eth_topup"] = True
                result["message"] += "原生币已充值; "
                self._wallet_nonce = None
            except Exception as e:
                result["message"] += f"原生币充值失败: {e}; "
        if wallet_info["balance_usdc"] < self._config.bet_amount * 10:
            try:
                chain_svc.mint_tokens("USDC", self._wallet_address,
                                       self._config.topup_usdc_amount, 0)
                result["usdc_topup"] = True
                result["message"] += "USDC 已充值; "
            except Exception as e:
                result["message"] += f"USDC 充值失败: {e}; "
        if not result["message"]:
            result["message"] = "钱包余额充足"
        return result

    # ==================== 房间行为 ====================

    async def _create_room(self) -> Optional[dict]:
        now = time.time()
        if now - self._last_create_time < self._config.create_interval:
            return None
        if len(self._active_rooms) >= self._config.max_concurrent_rooms:
            return None

        result = room_manager.create_room(
            self._wallet_address, self._config.token, self._config.bet_amount,
        )
        if result.get("success"):
            room_id = result["room_id"]
            self._active_rooms[room_id] = {
                "room_id": room_id, "role": "creator",
                "created_at": now_timestamp(), "status": "waiting", "auto_ready": True,
            }
            self._total_rooms_created += 1
            self._last_create_time = now
            add_bot_active_room(self.bot_id, room_id, "waiting")
            increment_bot_stats(self.bot_id, "total_rooms_created")
            self._log("INFO", f"创建房间 #{room_id}")

            await asyncio.sleep(0.5)
            ready_ok = await self._ready_in_room(room_id)
            if ready_ok:
                self._log("INFO", f"房间 #{room_id} 已自动准备")
            return result
        else:
            self._log("WARN", f"创建房间失败: {result.get('message')}")
            return None

    async def _join_room(self, room_id: str) -> bool:
        if len(self._active_rooms) >= self._config.max_concurrent_rooms:
            return False
        result = room_manager.join_room(room_id, self._wallet_address)
        if result.get("success"):
            self._active_rooms[room_id] = {
                "room_id": room_id, "role": "player2",
                "joined_at": now_timestamp(), "status": "joined", "auto_ready": True,
            }
            self._total_rooms_joined += 1
            add_bot_active_room(self.bot_id, room_id, "joined")
            increment_bot_stats(self.bot_id, "total_rooms_joined")
            self._log("INFO", f"加入房间 #{room_id}")

            await asyncio.sleep(0.5)
            ready_ok = await self._ready_in_room(room_id)
            if not ready_ok:
                self._log("WARN", f"房间 #{room_id} 自动准备失败，尝试离开房间")
                await self._leave_room(room_id)
                return False
            return True
        else:
            self._log("WARN", f"加入房间 #{room_id} 失败: {result.get('message')}")
            return False

    async def _ready_in_room(self, room_id: str) -> bool:
        result = room_manager.toggle_ready(room_id, self._wallet_address)
        if result.get("success"):
            rd = self._active_rooms.get(room_id)
            if rd:
                rd["status"] = "ready"
            self._log("INFO", f"房间 #{room_id} 已自动准备")
            return True
        else:
            self._log("WARN", f"房间 #{room_id} 自动准备失败: {result.get('message')}")
            return False

    async def _leave_room(self, room_id: str) -> None:
        try:
            room_manager.leave_room(room_id, self._wallet_address)
        except Exception:
            pass
        self._active_rooms.pop(room_id, None)
        try:
            remove_bot_active_room(self.bot_id, room_id)
        except Exception:
            pass

    # ==================== 大厅扫描 ====================

    async def _scan_lobby_loop(self) -> None:
        self._log("INFO", "大厅扫描任务已启动")
        while self._is_running:
            try:
                await self._scan_lobby()
            except Exception as e:
                self._log("ERROR", f"扫描异常: {e}")
            await asyncio.sleep(self._config.scan_interval)
        self._log("INFO", "大厅扫描任务已停止")

    async def _scan_lobby(self) -> None:
        await self.ensure_wallet_funded()
        if len(self._active_rooms) >= self._config.max_concurrent_rooms:
            return

        # 如果 Bot 钱包已在某个房间中，确保 _active_rooms 状态同步
        if room_manager.is_player_in_room(self._wallet_address):
            player_room_id = room_manager.get_player_room_id(self._wallet_address)
            if player_room_id:
                room = room_manager._rooms.get(player_room_id)
                if room:
                    # 房间仍然存在，确保 _active_rooms 状态同步
                    if player_room_id not in self._active_rooms:
                        # 判断 Bot 在房间中的角色
                        if room.get("creator", "").lower() == self._wallet_address.lower():
                            role = "creator"
                            room_data = {
                                "room_id": player_room_id, "role": role,
                                "created_at": now_timestamp(), "status": "waiting", "auto_ready": True,
                            }
                        elif room.get("player2", "").lower() == self._wallet_address.lower():
                            role = "player2"
                            room_data = {
                                "room_id": player_room_id, "role": role,
                                "joined_at": now_timestamp(), "status": "joined", "auto_ready": True,
                            }
                        else:
                            role = "player2"  # 默认
                            room_data = {
                                "room_id": player_room_id, "role": role,
                                "joined_at": now_timestamp(), "status": "joined", "auto_ready": True,
                            }
                        self._active_rooms[player_room_id] = room_data
                        self._log("INFO", f"_scan_lobby: 同步房间 #{player_room_id}, role={role}")
                        add_bot_active_room(self.bot_id, player_room_id, role)
                else:
                    # 房间已解散但状态残留，清理
                    self._log("WARN", f"清理残留状态：房间 #{player_room_id} 已不存在")
                    room_manager.cleanup_player_rooms(self._wallet_address)
            return

        rooms = room_manager.get_room_list()

        if self._config.auto_join_room:
            for room in rooms:
                if len(self._active_rooms) >= self._config.max_concurrent_rooms:
                    break
                room_id = room["room_id"]
                try:
                    if room_id in self._active_rooms:
                        continue
                    if room.get("creator", "").lower() == self._wallet_address.lower():
                        continue
                    if room.get("player2"):
                        continue
                    if room.get("status") not in [
                        ROOM_STATUS.get("CREATED", "created"),
                        ROOM_STATUS.get("JOINED", "joined"),
                    ]:
                        continue
                    await self._join_room(room_id)
                    break
                except Exception as e:
                    self._log("ERROR", f"扫描房间 #{room_id} 异常: {e}")
                    continue

        if self._config.auto_create_room:
            available = self._config.max_concurrent_rooms - len(self._active_rooms)
            if available > 0:
                try:
                    has_joinable = any(
                        r.get("player2") is None
                        and r.get("status") in [
                            ROOM_STATUS.get("CREATED", "created"),
                            ROOM_STATUS.get("JOINED", "joined"),
                        ]
                        and r.get("creator", "").lower() != self._wallet_address.lower()
                        for r in rooms
                    )
                    if not has_joinable:
                        await self._create_room()
                except Exception as e:
                    self._log("ERROR", f"创建房间异常: {e}")

    # ==================== 链上交互 ====================

    async def _ensure_token_supported(self, token_address: str) -> bool:
        """确保代币在合约 supportedTokens 中注册"""
        if not self._contract:
            return False
        try:
            supported = await _run_sync(
                lambda: self._contract.functions.supportedTokens(
                    self._w3.to_checksum_address(token_address)
                ).call()
            )
            if supported:
                return True

            # 先尝试 Bot 自己调用 setTokenSupport（如果 Bot 是 owner）
            self._log("INFO", f"代币 {token_address} 未注册，尝试 Bot 直接注册")
            try:
                async with self._nonce_lock:
                    if self._wallet_nonce is None:
                        self._wallet_nonce = await _run_sync(
                            lambda: self._w3.eth.get_transaction_count(self._wallet_address)
                        )
                    tx_nonce = self._wallet_nonce
                    self._wallet_nonce = tx_nonce + 1

                tx_params = {
                    "from": self._wallet_address,
                    "nonce": tx_nonce,
                    "gas": 100000,
                    "gasPrice": await _run_sync(lambda: self._w3.eth.gas_price),
                }
                tx = self._contract.functions.setTokenSupport(
                    self._w3.to_checksum_address(token_address), True
                ).build_transaction(tx_params)
                signed = self._wallet_account.sign_transaction(tx)
                tx_hash = await _run_sync(
                    lambda: self._w3.eth.send_raw_transaction(signed.raw_transaction)
                )
                receipt = await _run_sync(
                    lambda: self._w3.eth.wait_for_transaction_receipt(tx_hash, timeout=30)
                )
                if receipt.get("status") == 1:
                    self._log("INFO", f"代币 {token_address} 已通过 Bot 注册")
                    return True
            except Exception as e:
                self._log("WARN", f"Bot setTokenSupport 失败（可能不是 owner）: {e}")

            # 回退：使用 local_chain_service 调用（Ganache account[0]）
            self._log("INFO", f"尝试通过 local_chain_service 注册代币")
            chain_svc = get_local_chain_service()
            result = await _run_sync(
                lambda: chain_svc.register_token_on_contract(
                    token_address, self._contract.address, from_index=0
                )
            )
            if result.get("success"):
                self._log("INFO", f"代币 {token_address} 已通过 local_chain_service 注册")
                return True
            else:
                self._log("ERROR", f"local_chain_service 注册失败: {result.get('message')}")
            return False
        except Exception as e:
            self._log("ERROR", f"检查代币支持状态异常: {e}")
            return False

    async def _ensure_token_approved(self, token_address: str, amount: int) -> bool:
        """确保 RPS 合约已获得代币授权"""
        if not self._contract or not self._wallet_account:
            return False
        try:
            # 获取 ERC20 合约
            erc20_abi = [
                {"inputs": [{"name": "", "type": "address"}, {"name": "", "type": "address"}],
                 "name": "allowance", "outputs": [{"name": "", "type": "uint256"}],
                 "stateMutability": "view", "type": "function"},
                {"inputs": [{"name": "spender", "type": "address"}, {"name": "amount", "type": "uint256"}],
                 "name": "approve", "outputs": [{"name": "", "type": "bool"}],
                 "stateMutability": "nonpayable", "type": "function"},
            ]
            token_contract = self._w3.eth.contract(
                address=self._w3.to_checksum_address(token_address), abi=erc20_abi
            )
            current_allowance = await _run_sync(
                lambda: token_contract.functions.allowance(
                    self._wallet_address, self._contract.address
                ).call()
            )
            if current_allowance >= amount:
                return True

            self._log("INFO", f"代币授权不足: current={current_allowance}, need={amount}, 执行 approve")
            async with self._nonce_lock:
                if self._wallet_nonce is None:
                    self._wallet_nonce = await _run_sync(
                        lambda: self._w3.eth.get_transaction_count(self._wallet_address)
                    )
                tx_nonce = self._wallet_nonce
                self._wallet_nonce = tx_nonce + 1

            tx_params = {
                "from": self._wallet_address,
                "nonce": tx_nonce,
                "gas": 100000,
                "gasPrice": await _run_sync(lambda: self._w3.eth.gas_price),
            }
            tx = token_contract.functions.approve(
                self._contract.address, amount
            ).build_transaction(tx_params)
            signed = self._wallet_account.sign_transaction(tx)
            tx_hash = await _run_sync(
                lambda: self._w3.eth.send_raw_transaction(signed.raw_transaction)
            )
            receipt = await _run_sync(
                lambda: self._w3.eth.wait_for_transaction_receipt(tx_hash, timeout=30)
            )
            if receipt.get("status") == 1:
                self._log("INFO", f"代币授权成功: {amount}")
                return True
            else:
                self._log("ERROR", f"approve 交易失败 status={receipt.get('status')}")
                return False
        except Exception as e:
            self._log("ERROR", f"代币授权异常: {e}")
            self._wallet_nonce = None
            return False

    async def _get_transaction_revert_reason(self, tx_hash) -> str:
        """尝试获取交易回退原因"""
        try:
            tx = await _run_sync(lambda: self._w3.eth.get_transaction(tx_hash))
            block = await _run_sync(lambda: self._w3.eth.get_block(tx["blockNumber"]))
            receipt = await _run_sync(lambda: self._w3.eth.get_transaction_receipt(tx_hash))
            if receipt.get("status") == 0:
                # 尝试 trace
                try:
                    result = await _run_sync(
                        lambda: self._w3.provider.make_request(
                            "debug_traceTransaction",
                            [tx_hash.hex() if hasattr(tx_hash, "hex") else tx_hash, {"tracer": "callTracer"}]
                        )
                    )
                    if result and "result" in result:
                        return f"revert: {result['result']}"
                except Exception:
                    pass
                return "reverted (status=0)"
        except Exception:
            pass
        return "unknown"

    async def _create_chain_match(self, room_id: str, game_id: int) -> Optional[int]:
        if not self._contract or not self._wallet_account:
            self._log("ERROR", f"_create_chain_match: 合约或钱包未初始化 contract={self._contract is not None}, wallet={self._wallet_account is not None}")
            return None
        room = room_manager._rooms.get(room_id)
        if not room:
            self._log("ERROR", f"_create_chain_match: 房间 #{room_id} 不存在")
            return None
        try:
            from web3 import Web3
            token = room.get("token", self._config.token)
            token_address = self._get_token_address(token)
            if not token_address:
                self._log("ERROR", f"_create_chain_match: 无法获取代币 {token} 的地址")
                return None
            bet_amount = float(room.get("bet_amount", self._config.bet_amount))
            deposit_amount = self._calculate_deposit(token, bet_amount)
            is_eth = token_address == "0x0000000000000000000000000000000000000000"

            self._log("INFO", f"_create_chain_match: 准备创建链上对局, token={token}, amount={bet_amount}, deposit={deposit_amount}, is_eth={is_eth}")

            # 1. 确保代币在合约中注册（非 ETH）
            if not is_eth:
                token_supported = await self._ensure_token_supported(token_address)
                if not token_supported:
                    self._log("ERROR", f"_create_chain_match: 代币 {token} 未在合约中注册")
                    return None

            # 2. 确保 RPS 合约已获得代币授权（非 ETH）
            if not is_eth:
                approved = await self._ensure_token_approved(token_address, deposit_amount * 2)
                if not approved:
                    self._log("ERROR", f"_create_chain_match: 代币授权失败")
                    return None

            async with self._nonce_lock:
                if self._wallet_nonce is None:
                    self._wallet_nonce = await _run_sync(
                        lambda: self._w3.eth.get_transaction_count(self._wallet_address)
                    )
                tx_nonce = self._wallet_nonce
                self._wallet_nonce = tx_nonce + 1

            # 合约签名: createMatch(uint256 amount, address token)
            tx_params = {
                "from": self._wallet_address,
                "nonce": tx_nonce,
                "gas": 200000,
                "gasPrice": await _run_sync(lambda: self._w3.eth.gas_price),
            }
            if is_eth:
                tx_params["value"] = deposit_amount

            tx = self._contract.functions.createMatch(
                deposit_amount,
                self._w3.to_checksum_address(token_address),
            ).build_transaction(tx_params)
            signed = self._wallet_account.sign_transaction(tx)
            tx_hash = await _run_sync(
                lambda: self._w3.eth.send_raw_transaction(signed.raw_transaction)
            )
            tx_hash_hex = tx_hash.hex() if hasattr(tx_hash, "hex") else str(tx_hash)
            self._log("INFO", f"createMatch 已发送: {tx_hash_hex}, amount={deposit_amount}, token={token}")

            receipt = await _run_sync(
                lambda: self._w3.eth.wait_for_transaction_receipt(tx_hash, timeout=60)
            )
            if receipt.get("status") == 1:
                chain_game_id = self._extract_game_created_id(receipt)
                if chain_game_id:
                    self._log("INFO", f"链上对局已创建: chain_game_id={chain_game_id}")
                    self._total_chain_matches += 1
                    await room_manager.report_chain_game(
                        room_id, self._wallet_address, chain_game_id
                    )
                    return chain_game_id
                else:
                    self._log("ERROR", f"_create_chain_match: 无法从 receipt 中提取 game_id, receipt={receipt}")
            else:
                revert_reason = await self._get_transaction_revert_reason(tx_hash)
                self._log("ERROR", f"createMatch 交易失败: status={receipt.get('status')}, reason={revert_reason}, logs={receipt.get('logs', [])}")
            return None
        except Exception as e:
            self._log("ERROR", f"createMatch 异常: {e}")
            self._wallet_nonce = None
            return None

    async def _join_chain_match(self, room_id: str, game_id: int,
                                 chain_game_id: int) -> bool:
        if not self._contract or not self._wallet_account:
            return False
        room = room_manager._rooms.get(room_id)
        if not room:
            return False
        try:
            from web3 import Web3
            token = room.get("token", self._config.token)
            token_address = self._get_token_address(token)
            if not token_address:
                return False
            bet_amount = float(room.get("bet_amount", self._config.bet_amount))
            deposit_amount = self._calculate_deposit(token, bet_amount)
            is_eth = token_address == "0x0000000000000000000000000000000000000000"

            # 1. 确保代币在合约中注册（非 ETH）
            if not is_eth:
                token_supported = await self._ensure_token_supported(token_address)
                if not token_supported:
                    self._log("ERROR", f"_join_chain_match: 代币 {token} 未在合约中注册")
                    return False

            # 2. 确保 RPS 合约已获得代币授权（非 ETH）
            if not is_eth:
                approved = await self._ensure_token_approved(token_address, deposit_amount * 2)
                if not approved:
                    self._log("ERROR", f"_join_chain_match: 代币授权失败")
                    return False

            async with self._nonce_lock:
                if self._wallet_nonce is None:
                    self._wallet_nonce = await _run_sync(
                        lambda: self._w3.eth.get_transaction_count(self._wallet_address)
                    )
                tx_nonce = self._wallet_nonce
                self._wallet_nonce = tx_nonce + 1

            # 合约签名: joinMatch(uint256 gameId)
            tx_params = {
                "from": self._wallet_address,
                "nonce": tx_nonce,
                "gas": 200000,
                "gasPrice": await _run_sync(lambda: self._w3.eth.gas_price),
            }
            if is_eth:
                tx_params["value"] = deposit_amount

            tx = self._contract.functions.joinMatch(
                chain_game_id,
            ).build_transaction(tx_params)
            signed = self._wallet_account.sign_transaction(tx)
            tx_hash = await _run_sync(
                lambda: self._w3.eth.send_raw_transaction(signed.raw_transaction)
            )
            tx_hash_hex = tx_hash.hex() if hasattr(tx_hash, "hex") else str(tx_hash)
            self._log("INFO", f"joinMatch 已发送: {tx_hash_hex}, gameId={chain_game_id}")

            receipt = await _run_sync(
                lambda: self._w3.eth.wait_for_transaction_receipt(tx_hash, timeout=60)
            )
            if receipt.get("status") == 1:
                self._log("INFO", f"已加入链上对局: chain_game_id={chain_game_id}")
                self._total_chain_matches += 1
                return True
            else:
                revert_reason = await self._get_transaction_revert_reason(tx_hash)
                self._log("ERROR", f"joinMatch 交易失败: status={receipt.get('status')}, reason={revert_reason}")
            return False
        except Exception as e:
            self._log("ERROR", f"joinMatch 异常: {e}")
            self._wallet_nonce = None
            return False

    async def _submit_commit_via_relayer(self, game_id: int,
                                          commit_hash: str) -> bool:
        if not self._wallet_account:
            return False
        try:
            contract_nonce = 0
            try:
                contract_nonce = await _run_sync(
                    lambda: self._contract.functions.nonces(self._wallet_address).call()
                )
            except Exception:
                contract_nonce = 0
            deadline = int(time.time()) + 1800
            signature = self._sign_commit(game_id, commit_hash, contract_nonce, deadline)
            if not signature:
                return False
            v, r, s = signature
            result = await relayer_service.submit_commit_with_sig(
                game_id, self._wallet_address, commit_hash, contract_nonce, v, r, s
            )
            if result.get("success"):
                self._log("INFO", f"commit 代提交成功: game_id={game_id}")
                return True
            else:
                self._log("ERROR", f"commit 代提交失败: {result.get('message')}")
                return False
        except Exception as e:
            self._log("ERROR", f"commit 代提交异常: {e}")
            return False

    async def _submit_reveal_via_relayer(self, game_id: int, choice: int,
                                          salt: str) -> bool:
        if not self._wallet_account:
            return False
        try:
            contract_nonce = 0
            try:
                contract_nonce = await _run_sync(
                    lambda: self._contract.functions.nonces(self._wallet_address).call()
                )
            except Exception:
                contract_nonce = 0
            deadline = int(time.time()) + 1800
            signature = self._sign_reveal(game_id, choice, salt, contract_nonce, deadline)
            if not signature:
                return False
            v, r, s = signature
            result = await relayer_service.reveal_choice_with_sig(
                game_id, self._wallet_address, choice, salt, contract_nonce, v, r, s
            )
            if result.get("success"):
                self._log("INFO", f"reveal 代提交成功: game_id={game_id}")
                return True
            return False
        except Exception as e:
            self._log("ERROR", f"reveal 代提交异常: {e}")
            return False

    # ==================== 签名生成 ====================

    def _sign_commit(self, game_id: int, commit_hash: str,
                     nonce: int, deadline: int) -> Optional[tuple]:
        try:
            from web3 import Web3
            import eth_abi
            try:
                domain_separator = self._contract.functions.domainSeparator().call()
            except Exception:
                domain_separator = Web3.keccak(text="ChainRPS")
            commit_bytes = bytes.fromhex(commit_hash[2:]
                                         if commit_hash.startswith("0x")
                                         else bytes.fromhex(commit_hash))
            struct_encoded = eth_abi.encode(
                ["uint256", "address", "bytes32", "uint256", "uint256"],
                [game_id, self._wallet_address, commit_bytes, nonce, deadline]
            )
            struct_hash = Web3.keccak(struct_encoded)
            digest = Web3.keccak(
                bytes.fromhex("1901") + domain_separator + struct_hash
            )
            signed = self._wallet_account.signHash(digest)
            return (signed.v - 27, "0x" + signed.r.hex(), "0x" + signed.s.hex())
        except Exception as e:
            self._log("ERROR", f"commit 签名失败: {e}")
            return None

    def _sign_reveal(self, game_id: int, choice: int, salt: str,
                     nonce: int, deadline: int) -> Optional[tuple]:
        try:
            from web3 import Web3
            import eth_abi
            try:
                domain_separator = self._contract.functions.domainSeparator().call()
            except Exception:
                domain_separator = Web3.keccak(text="ChainRPS")
            salt_bytes = bytes.fromhex(salt[2:] if salt.startswith("0x") else bytes.fromhex(salt))
            struct_encoded = eth_abi.encode(
                ["uint256", "address", "uint8", "bytes32", "uint256", "uint256"],
                [game_id, self._wallet_address, choice, salt_bytes, nonce, deadline]
            )
            struct_hash = Web3.keccak(struct_encoded)
            digest = Web3.keccak(
                bytes.fromhex("1901") + domain_separator + struct_hash
            )
            signed = self._wallet_account.signHash(digest)
            return (signed.v - 27, "0x" + signed.r.hex(), "0x" + signed.s.hex())
        except Exception as e:
            self._log("ERROR", f"reveal 签名失败: {e}")
            return None

    # ==================== 辅助方法 ====================

    def _get_token_address(self, token: str) -> Optional[str]:
        # ETH / POL 原生代币使用零地址
        if token.upper() in ("ETH", "POL", "NATIVE", "BASE"):
            return "0x0000000000000000000000000000000000000000"
        chain_svc = get_local_chain_service()
        token_info = chain_svc._tokens.get(token)
        if token_info:
            return token_info.get("address")
        usdc_info = chain_svc._tokens.get("USDC")
        if usdc_info:
            return usdc_info.get("address")
        return None

    def _calculate_deposit(self, token: str, bet_amount: float) -> int:
        from web3 import Web3
        if token == "USDC":
            return int(bet_amount * 1_000_000)
        return Web3.to_wei(bet_amount, "ether")

    # GameCreated 事件签名: keccak256("GameCreated(uint256,address,uint256,address)")
    _GAME_CREATED_TOPIC0 = None

    @classmethod
    def _get_game_created_topic0(cls):
        if cls._GAME_CREATED_TOPIC0 is None:
            from web3 import Web3
            cls._GAME_CREATED_TOPIC0 = Web3.keccak(
                text="GameCreated(uint256,address,uint256,address)"
            ).hex()
        return cls._GAME_CREATED_TOPIC0

    def _extract_game_created_id(self, receipt: dict) -> Optional[int]:
        try:
            expected_topic0 = self._get_game_created_topic0()
            for log in receipt.get("logs", []):
                topics = log.get("topics", [])
                if len(topics) >= 2:
                    topic0 = topics[0]
                    if hasattr(topic0, 'hex'):
                        topic0 = topic0.hex()
                    elif isinstance(topic0, str) and not topic0.startswith('0x'):
                        topic0 = '0x' + topic0
                    if topic0 == expected_topic0:
                        try:
                            game_id = int(topics[1], 16) if isinstance(topics[1], str) else int.from_bytes(topics[1], 'big')
                            if game_id > 0:
                                return game_id
                        except (ValueError, TypeError):
                            pass
        except Exception:
            pass
        return None

    # ==================== 游戏主循环 ====================

    async def handle_game_started(self, game_id: int, room_id: str) -> None:
        if not self._is_running:
            self._log("WARN", f"handle_game_started: Bot 未运行，跳过游戏开始事件")
            return
        room_data = self._active_rooms.get(room_id)
        if not room_data:
            # 尝试从 room_manager 同步（可能 Bot 重启导致 _active_rooms 丢失）
            room = room_manager._rooms.get(room_id)
            if room and room.get("creator", "").lower() == self._wallet_address.lower():
                room_data = {
                    "room_id": room_id, "role": "creator",
                    "created_at": now_timestamp(), "status": "waiting", "auto_ready": True,
                }
                self._active_rooms[room_id] = room_data
                self._log("INFO", f"handle_game_started: 从 room_manager 同步房间 #{room_id}, role=creator")
            elif room and room.get("player2", "").lower() == self._wallet_address.lower():
                room_data = {
                    "room_id": room_id, "role": "player2",
                    "joined_at": now_timestamp(), "status": "joined", "auto_ready": True,
                }
                self._active_rooms[room_id] = room_data
                self._log("INFO", f"handle_game_started: 从 room_manager 同步房间 #{room_id}, role=player2")
            else:
                self._log("ERROR", f"handle_game_started: 房间 #{room_id} 不在 _active_rooms 且 Bot 钱包不在房间中")
                return

        role = room_data.get("role")
        self._log("INFO", f"handle_game_started: game_id={game_id}, room_id={room_id}, role={role}, auto_chain_match={self._config.auto_chain_match}, has_contract={self._contract is not None}, has_wallet={self._wallet_account is not None}")

        self._active_games[game_id] = {
            "game_id": game_id, "room_id": room_id,
            "choice": None, "salt": None, "commit_hash": None,
            "committed": False, "revealed": False,
            "chain_game_id": None, "status": "game_started",
        }
        self._log("INFO", f"游戏开始: game_id={game_id}, 策略={self._config.strategy}")
        task = asyncio.create_task(self._game_loop_full(game_id))
        self._game_tasks[game_id] = task

    async def _game_loop_full(self, game_id: int) -> None:
        game_data = self._active_games.get(game_id)
        if not game_data:
            self._log("ERROR", f"_game_loop_full: game_data 不存在 game_id={game_id}")
            return
        room_id = game_data["room_id"]
        room_data = self._active_rooms.get(room_id)
        if not room_data:
            self._log("ERROR", f"_game_loop_full: room_data 不存在 room_id={room_id}")
            return

        role = room_data.get("role")
        self._log("INFO", f"_game_loop_full: 进入游戏循环 game_id={game_id}, room_id={room_id}, role={role}")

        try:
            if self._config.auto_chain_match and self._contract and self._wallet_account:
                self._log("INFO", f"_game_loop_full: 开始链上对局阶段 (auto_chain_match=True)")
                chain_ok = await self._chain_match_phase(game_id, room_id, room_data)
                if not chain_ok:
                    self._log("WARN", "链上对局阶段失败，继续本地游戏")
                else:
                    self._log("INFO", "链上对局阶段成功")
            else:
                reasons = []
                if not self._config.auto_chain_match:
                    reasons.append("auto_chain_match=False")
                if not self._contract:
                    reasons.append("_contract=None")
                if not self._wallet_account:
                    reasons.append("_wallet_account=None")
                self._log("WARN", f"_game_loop_full: 跳过链上对局创建，原因: {', '.join(reasons)}")

            await asyncio.sleep(self._config.commit_delay)
            await self._do_commit(game_id)
            await self._wait_for_opponent_commit(game_id)

            await self._wait_for_reveal_start(game_id)
            await asyncio.sleep(self._config.reveal_delay)
            await self._do_reveal(game_id)
            await self._wait_for_game_result(game_id)

        except asyncio.CancelledError:
            self._log("INFO", f"游戏任务被取消: game_id={game_id}")
        except Exception as e:
            self._log("ERROR", f"游戏任务异常: game_id={game_id}, error={e}")
        finally:
            self._game_tasks.pop(game_id, None)
            self._active_games.pop(game_id, None)
            if room_id and room_id in self._active_rooms:
                rd = self._active_rooms.get(room_id)
                if rd and rd.get("role") == "player2":
                    await self._leave_room(room_id)

    async def _chain_match_phase(self, game_id: int, room_id: str,
                                  room_data: dict) -> bool:
        role = room_data.get("role")
        self._log("INFO", f"_chain_match_phase: 开始链上对局阶段, role={role}, game_id={game_id}")
        chain_game_id = None
        if role == "creator":
            self._log("INFO", f"_chain_match_phase: Bot 是 creator，调用 _create_chain_match")
            chain_game_id = await self._create_chain_match(room_id, game_id)
            if chain_game_id:
                gd = self._active_games.get(game_id)
                if gd:
                    gd["chain_game_id"] = chain_game_id
                    gd["status"] = "chain_created"
                self._log("INFO", f"_chain_match_phase: createMatch 成功 chain_game_id={chain_game_id}")
            else:
                self._log("ERROR", f"_chain_match_phase: createMatch 失败 chain_game_id=None")
        elif role == "player2":
            self._log("INFO", f"_chain_match_phase: Bot 是 player2，等待链上对局创建")
            chain_game_id = await self._wait_for_chain_game(room_id, timeout=30)
            if chain_game_id:
                join_ok = await self._join_chain_match(room_id, game_id, chain_game_id)
                if join_ok:
                    gd = self._active_games.get(game_id)
                    if gd:
                        gd["chain_game_id"] = chain_game_id
                        gd["status"] = "chain_joined"
                else:
                    self._log("ERROR", f"_chain_match_phase: joinMatch 失败")
                    return False
            else:
                self._log("ERROR", f"_chain_match_phase: 等待链上对局超时")
                return False
        else:
            self._log("ERROR", f"_chain_match_phase: 未知 role={role}")
            return False
        return chain_game_id is not None

    async def _wait_for_chain_game(self, room_id: str, timeout: int = 30) -> Optional[int]:
        elapsed = 0
        while elapsed < timeout and self._is_running:
            room = room_manager._rooms.get(room_id)
            if room and room.get("chain_game_id"):
                return room["chain_game_id"]
            await asyncio.sleep(1)
            elapsed += 1
        return None

    # ==================== 游戏行为 ====================

    async def _do_commit(self, game_id: int) -> None:
        game_data = self._active_games.get(game_id)
        if not game_data:
            return

        choice = self._generate_choice()
        salt = self._generate_salt()
        commit_hash = self._compute_commit(choice, salt, self._wallet_address)

        game_data["choice"] = choice
        game_data["salt"] = salt
        game_data["commit_hash"] = commit_hash

        result = await game_manager.submit_commit(
            game_id, self._wallet_address, commit_hash
        )
        if result.get("success"):
            game_data["committed"] = True
            self._log("INFO", f"commit 本地记录成功: choice={choice}")
            if game_data.get("chain_game_id"):
                chain_ok = await self._submit_commit_via_relayer(game_id, commit_hash)
                if chain_ok:
                    self._log("INFO", "commit 链上代提交成功")
        else:
            self._log("ERROR", f"commit 本地记录失败: {result.get('error')}")

    async def _do_reveal(self, game_id: int) -> None:
        game_data = self._active_games.get(game_id)
        if not game_data:
            return
        choice = game_data["choice"]
        salt = game_data["salt"]
        choice_map = {1: Choice.ROCK, 2: Choice.PAPER, 3: Choice.SCISSORS}
        choice_enum = choice_map.get(choice, Choice.ROCK)

        result = await game_manager.reveal_choice(
            game_id, self._wallet_address, choice_enum, salt
        )
        if result.get("success"):
            game_data["revealed"] = True
            self._log("INFO", f"reveal 本地记录成功: choice={choice}")
            if game_data.get("chain_game_id"):
                chain_ok = await self._submit_reveal_via_relayer(game_id, choice, salt)
                if chain_ok:
                    self._log("INFO", "reveal 链上代提交成功")
        else:
            self._log("ERROR", f"reveal 本地记录失败: {result.get('error')}")

    async def _wait_for_opponent_commit(self, game_id: int) -> None:
        timeout, elapsed = 120, 0
        while elapsed < timeout and self._is_running:
            try:
                from rps_backend.utils.redis_client import redis_client
                cached = redis_client.get_cached_game_state(game_id)
                if cached:
                    from rps_backend.repository import get_game_record
                    record = get_game_record(game_id)
                    if record:
                        is_p1 = record.get("player1", "").lower() == self._wallet_address.lower()
                        opponent_field = "commit2" if is_p1 else "commit1"
                        if cached.get(opponent_field):
                            return
            except Exception:
                pass
            await asyncio.sleep(2)
            elapsed += 2

    async def _wait_for_reveal_start(self, game_id: int) -> None:
        timeout, elapsed = 30, 0
        while elapsed < timeout and self._is_running:
            try:
                from rps_backend.utils.redis_client import redis_client
                cached = redis_client.get_cached_game_state(game_id)
                if cached and cached.get("state") == "reveal_phase":
                    return
            except Exception:
                pass
            await asyncio.sleep(1)
            elapsed += 1

    async def _wait_for_game_result(self, game_id: int) -> None:
        timeout, elapsed = 300, 0
        while elapsed < timeout and self._is_running:
            try:
                from rps_backend.repository import get_game_record
                record = get_game_record(game_id)
                if record and record.get("state") == "finished":
                    self._total_games_played += 1
                    increment_bot_stats(self.bot_id, "total_games_played")
                    self._log("INFO", f"游戏结算完成: game_id={game_id}")
                    result_winner = record.get("winner", "")
                    if result_winner:
                        if result_winner.lower() == self._wallet_address.lower():
                            self._total_wins += 1
                            increment_bot_stats(self.bot_id, "total_wins")
                            self._log("INFO", "游戏结果: 胜利 🎉")
                        elif record.get("is_draw"):
                            self._total_draws += 1
                            increment_bot_stats(self.bot_id, "total_draws")
                            self._log("INFO", "游戏结果: 平局")
                        else:
                            self._total_losses += 1
                            increment_bot_stats(self.bot_id, "total_losses")
                            self._log("INFO", "游戏结果: 失败")
                    return
            except Exception:
                pass
            await asyncio.sleep(2)
            elapsed += 2

    # ==================== 核心算法 ====================

    def _compute_commit(self, choice: int, salt: str, address: str) -> str:
        addr_clean = address[2:] if address.startswith("0x") else address
        salt_clean = salt[2:] if salt.startswith("0x") else salt
        packed = bytes([choice]) + bytes.fromhex(salt_clean) + bytes.fromhex(addr_clean)
        try:
            from eth_hash.auto import keccak
            return "0x" + keccak(packed).hex()
        except ImportError:
            from web3 import Web3
            return "0x" + Web3.keccak(packed).hex()

    def _generate_choice(self) -> int:
        choice = generate_choice(
            self._config.strategy,
            history=self._choice_history,
            mimic_choice=self._config.mimic_choice,
        )
        self._choice_history.append(choice)
        if len(self._choice_history) > 20:
            self._choice_history = self._choice_history[-20:]
        return choice

    def _generate_salt(self) -> str:
        return "0x" + secrets.token_hex(32)

    # ==================== 事件处理 ====================

    async def on_room_joined(self, room_id: str, player_address: str) -> None:
        if not self._is_running:
            return
        rd = self._active_rooms.get(room_id)
        if rd and rd.get("role") == "creator" and player_address.lower() != self._wallet_address.lower():
            self._log("INFO", f"玩家加入房间 #{room_id}")

    async def on_player_ready(self, room_id: str) -> None:
        """玩家准备了，Bot 尝试立即加入该房间"""
        if not self._is_running:
            return
        room = room_manager._rooms.get(room_id)
        if not room:
            return
        if room_id in self._active_rooms:
            return
        if len(self._active_rooms) >= self._config.max_concurrent_rooms:
            return
        if room.get("creator", "").lower() == self._wallet_address.lower():
            return
        if room.get("player2"):
            return
        if room.get("status") not in [
            ROOM_STATUS.get("CREATED", "created"),
            ROOM_STATUS.get("JOINED", "joined"),
        ]:
            return
        self._log("INFO", f"玩家已准备，Bot 尝试加入房间 #{room_id}")
        await self._join_room(room_id)

    async def on_room_ready_changed(self, room_id: str) -> None:
        if not self._is_running:
            return
        room = room_manager._rooms.get(room_id)
        if room and room.get("creator_ready") and room.get("player2_ready"):
            self._log("INFO", f"房间 #{room_id} 双方已准备")

    async def on_game_started_event(self, room_id: str, game_id: int) -> None:
        if not self._is_running:
            self._log("WARN", f"on_game_started_event: Bot 未运行，跳过 game_id={game_id}")
            return
        self._log("INFO", f"on_game_started_event: 收到游戏开始事件, room_id={room_id}, game_id={game_id}")
        await self.handle_game_started(game_id, room_id)

    async def on_chain_game_created(self, room_id: str, chain_game_id: int) -> None:
        if not self._is_running:
            return
        rd = self._active_rooms.get(room_id)
        if rd and rd.get("role") == "player2" and self._config.auto_chain_match:
            game_id = rd.get("game_id")
            if game_id:
                asyncio.create_task(
                    self._join_chain_match_and_proceed(room_id, game_id, chain_game_id)
                )

    async def _join_chain_match_and_proceed(self, room_id: str, game_id: int,
                                              chain_game_id: int) -> None:
        join_ok = await self._join_chain_match(room_id, game_id, chain_game_id)
        if join_ok:
            gd = self._active_games.get(game_id)
            if gd:
                gd["chain_game_id"] = chain_game_id
                gd["status"] = "chain_joined"

    async def on_game_result_event(self, game_id: int, result: dict) -> None:
        self._active_games.pop(game_id, None)
        self._game_tasks.pop(game_id, None)

    async def on_room_closed(self, room_id: str) -> None:
        self._active_rooms.pop(room_id, None)

    async def on_seat_ai_invited(self, room_id: str) -> None:
        """玩家邀请 AI 加入房间空位"""
        if not self._is_running:
            return
        room = room_manager._rooms.get(room_id)
        if not room:
            return
        if room.get("player2"):
            return
        if len(self._active_rooms) >= self._config.max_concurrent_rooms:
            return
        self._log("INFO", f"玩家邀请 AI 加入房间 #{room_id}")
        await self._join_room(room_id)

    async def reset_wallet(self) -> dict:
        self._wallet_available = False
        self._wallet_address = None
        self._wallet_private_key = None
        self._wallet_account = None
        self._wallet_nonce = None
        self._w3 = None
        self._contract = None
        self._active_rooms.clear()
        self._active_games.clear()
        self._game_tasks.clear()
        success = await self.initialize()
        if success:
            await self.ensure_wallet_funded()
            return {"success": True, "message": "钱包已重置并充值"}
        return {"success": False, "message": "钱包重置失败"}


# ==================== BotService (向后兼容包装) ====================

class BotService:
    """
    保持向后兼容的 Bot 服务入口

    v3.0 中将 BotService 重构为 BotInstance 的包装，
    默认使用 bot_001 实例。
    """

    def __init__(self):
        self._instances: Dict[str, BotInstance] = {}
        self._default_instance_id: str = "bot_001"

    async def initialize(self) -> bool:
        """初始化默认 Bot 实例"""
        from rps_backend.repository import get_next_bot_id
        bot_id = self._default_instance_id
        instance = self._instances.get(bot_id)
        if instance:
            return await instance.initialize()

        from rps_backend.service.wallet_pool_manager import wallet_pool_manager
        idx, addr = wallet_pool_manager.allocate()
        if idx < 0 or not addr:
            logger.error("无法分配钱包，Bot 初始化失败")
            return False

        instance = BotInstance(
            bot_id=bot_id,
            name="默认 Bot",
            wallet_index=idx,
            wallet_address=addr,
        )
        self._instances[bot_id] = instance

        # 持久化
        try:
            from rps_backend.repository import create_bot_instance
            create_bot_instance({
                "bot_id": bot_id,
                "name": "默认 Bot",
                "strategy": BOT_DEFAULT_STRATEGY,
                "wallet_index": idx,
                "wallet_address": addr,
                "token": BOT_TOKEN,
                "bet_amount": BOT_BET_AMOUNT,
            })
        except Exception:
            pass

        return await instance.initialize()

    async def start(self) -> bool:
        instance = self._instances.get(self._default_instance_id)
        if instance:
            return await instance.start()
        return False

    async def stop(self) -> bool:
        instance = self._instances.get(self._default_instance_id)
        if instance:
            return await instance.stop()
        return False

    def get_status(self) -> dict:
        instance = self._instances.get(self._default_instance_id)
        if instance:
            status = instance.get_status()
            status["chain_id"] = RPC_CHAIN_ID
            status["chain_name"] = "ChainRPS Local"
            return status
        return {"is_running": False, "chain_id": RPC_CHAIN_ID}

    @property
    def _is_running(self) -> bool:
        instance = self._instances.get(self._default_instance_id)
        return instance._is_running if instance else False

    @property
    def _wallet_address(self) -> Optional[str]:
        instance = self._instances.get(self._default_instance_id)
        return instance._wallet_address if instance else None

    @property
    def _wallet_available(self) -> bool:
        instance = self._instances.get(self._default_instance_id)
        return instance._wallet_available if instance else False

    @property
    def _config(self) -> BotConfig:
        instance = self._instances.get(self._default_instance_id)
        return instance._config if instance else BotConfig()

    @property
    def _active_rooms(self) -> Dict:
        instance = self._instances.get(self._default_instance_id)
        return instance._active_rooms if instance else {}

    @property
    def _active_games(self) -> Dict:
        instance = self._instances.get(self._default_instance_id)
        return instance._active_games if instance else {}

    @property
    def _scan_task(self):
        instance = self._instances.get(self._default_instance_id)
        return instance._scan_task if instance else None

    async def ensure_wallet_funded(self) -> dict:
        instance = self._instances.get(self._default_instance_id)
        if instance:
            return await instance.ensure_wallet_funded()
        return {"message": "Bot 未初始化"}

    async def reset_wallet(self) -> dict:
        instance = self._instances.get(self._default_instance_id)
        if instance:
            return await instance.reset_wallet()
        return {"success": False, "message": "Bot 未初始化"}

    def get_wallet_info(self) -> dict:
        instance = self._instances.get(self._default_instance_id)
        if instance:
            return instance.get_wallet_info()
        return {"address": None, "balance_eth": 0.0, "balance_usdc": 0.0}

    def update_config(self, **kwargs) -> dict:
        instance = self._instances.get(self._default_instance_id)
        if instance:
            return instance.update_config(**kwargs)
        return {}

    async def _create_room(self) -> Optional[dict]:
        instance = self._instances.get(self._default_instance_id)
        if instance:
            return await instance._create_room()
        return None

    async def on_room_joined(self, room_id: str, player_address: str) -> None:
        instance = self._instances.get(self._default_instance_id)
        if instance:
            await instance.on_room_joined(room_id, player_address)

    async def on_player_ready(self, room_id: str) -> None:
        instance = self._instances.get(self._default_instance_id)
        if instance:
            await instance.on_player_ready(room_id)

    async def on_room_ready_changed(self, room_id: str) -> None:
        instance = self._instances.get(self._default_instance_id)
        if instance:
            await instance.on_room_ready_changed(room_id)

    async def on_game_started_event(self, room_id: str, game_id: int) -> None:
        instance = self._instances.get(self._default_instance_id)
        if instance:
            logger.info(f"BotService.on_game_started_event: room_id={room_id}, game_id={game_id}, instance={self._default_instance_id}")
            await instance.on_game_started_event(room_id, game_id)
        else:
            logger.error(f"BotService.on_game_started_event: 实例 {self._default_instance_id} 不存在")

    async def on_chain_game_created(self, room_id: str, chain_game_id: int) -> None:
        instance = self._instances.get(self._default_instance_id)
        if instance:
            await instance.on_chain_game_created(room_id, chain_game_id)

    async def on_game_result_event(self, game_id: int, result: dict) -> None:
        instance = self._instances.get(self._default_instance_id)
        if instance:
            await instance.on_game_result_event(game_id, result)

    async def on_room_closed(self, room_id: str) -> None:
        instance = self._instances.get(self._default_instance_id)
        if instance:
            await instance.on_room_closed(room_id)

    async def on_seat_ai_invited(self, room_id: str) -> None:
        instance = self._instances.get(self._default_instance_id)
        if instance:
            await instance.on_seat_ai_invited(room_id)

    async def handle_game_started(self, game_id: int, room_id: str) -> None:
        instance = self._instances.get(self._default_instance_id)
        if instance:
            await instance.handle_game_started(game_id, room_id)


# 向后兼容单例
bot_service = BotService()