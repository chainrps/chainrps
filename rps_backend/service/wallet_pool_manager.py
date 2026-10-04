"""
ChainRPS 钱包池管理器

管理 Bot 钱包的自动分配、回收与充值：
- 从钱包池范围（默认索引 1~9）中分配可用钱包
- 归还钱包至池（不删除 Ganache 账户，方便复用）
- 自动充值 ETH + USDC 到 Bot 钱包
- 查询钱包池状态

安全约束：
- 仅限测试链（Chain ID: 5208888）使用
- 钱包独立账户，不与管理员/Relayer 混用
"""
import logging
from typing import Optional, List, Tuple

from rps_backend.config import (
    BOT_WALLET_POOL_START,
    BOT_WALLET_POOL_END,
    BOT_WALLET_INITIAL_ETH,
    BOT_WALLET_INITIAL_USDC,
    RPC_CHAIN_ID,
)
from rps_backend.repository import get_used_wallet_indices
from rps_backend.service.local_chain_service import get_local_chain_service

logger = logging.getLogger(__name__)


class WalletPoolManager:
    """Bot 钱包池管理器"""

    def __init__(self):
        self._start_index: int = BOT_WALLET_POOL_START
        self._end_index: int = BOT_WALLET_POOL_END
        self._initial_eth: float = BOT_WALLET_INITIAL_ETH
        self._initial_usdc: float = BOT_WALLET_INITIAL_USDC
        self._max_capacity: int = self._end_index - self._start_index + 1

    def _get_chain_account_count(self) -> int:
        """获取当前本地链可用的账户数量"""
        chain_svc = get_local_chain_service()
        if chain_svc.is_running():
            return len(chain_svc._accounts)
        return 0

    def _get_safe_end_index(self) -> int:
        """根据 Ganache 实际账户数调整钱包池结束索引"""
        account_count = self._get_chain_account_count()
        if account_count <= 0:
            return self._end_index
        return min(self._end_index, account_count - 1)

    def get_status(self) -> dict:
        """获取钱包池状态"""
        used_indices = self._get_used_indices()
        safe_end = self._get_safe_end_index()
        effective_capacity = max(0, safe_end - self._start_index + 1)
        return {
            "start_index": self._start_index,
            "end_index": self._end_index,
            "safe_end_index": safe_end,
            "max_capacity": self._max_capacity,
            "effective_capacity": effective_capacity,
            "used_count": len(used_indices),
            "available_count": max(0, effective_capacity - len(used_indices)),
            "used_indices": used_indices,
            "initial_eth": self._initial_eth,
            "initial_usdc": self._initial_usdc,
        }

    def get_pool_status(self) -> dict:
        """获取钱包池状态（API 友好格式）"""
        status = self.get_status()
        return {
            "start_index": status["start_index"],
            "end_index": status["end_index"],
            "max_capacity": status["max_capacity"],
            "allocated_count": status["used_count"],
            "available_count": status["available_count"],
            "allocated_wallets": status["used_indices"],
        }

    def allocate(self, wallet_index: Optional[int] = None) -> Tuple[int, Optional[str]]:
        """
        分配钱包

        Args:
            wallet_index: 指定钱包索引（不指定则自动分配）

        Returns:
            (wallet_index, wallet_address) 或 (-1, None) 分配失败
        """
        chain_svc = get_local_chain_service()
        if not chain_svc.is_running():
            logger.error("本地链未运行，无法分配钱包")
            return (-1, None)

        if wallet_index is not None:
            return self._allocate_specific(chain_svc, wallet_index)
        else:
            return self._allocate_auto(chain_svc)

    def _allocate_specific(self, chain_svc, wallet_index: int) -> Tuple[int, Optional[str]]:
        """分配指定钱包"""
        if not self._is_in_range(wallet_index):
            logger.error(f"钱包索引 {wallet_index} 不在池范围 [{self._start_index}, {self._end_index}]")
            return (-1, None)

        safe_end = self._get_safe_end_index()
        if wallet_index > safe_end:
            logger.error(f"钱包索引 {wallet_index} 超出 Ganache 账户范围 (最大可用: {safe_end})")
            return (-1, None)

        used_indices = self._get_used_indices()
        if wallet_index in used_indices:
            logger.warning(f"钱包索引 {wallet_index} 已被占用")
            return (-1, None)

        address = self._get_or_create_account(chain_svc, wallet_index)
        if not address:
            return (-1, None)

        return (wallet_index, address)

    def _allocate_auto(self, chain_svc) -> Tuple[int, Optional[str]]:
        """自动分配下一个可用钱包"""
        used_indices = self._get_used_indices()
        safe_end = self._get_safe_end_index()

        for idx in range(self._start_index, safe_end + 1):
            if idx not in used_indices:
                address = self._get_or_create_account(chain_svc, idx)
                if address:
                    logger.info(f"钱包池分配: 索引 {idx} → {address}")
                    return (idx, address)

        if safe_end < self._start_index:
            logger.error(f"钱包池起始索引 {self._start_index} 超出 Ganache 账户范围 (账户数={self._get_chain_account_count()})")
        else:
            logger.error(f"钱包池已满，无法分配新钱包 (可用范围: {self._start_index}-{safe_end}, 已用: {used_indices})")
        return (-1, None)

    def release(self, wallet_index: int) -> bool:
        """
        归还钱包至池（不删除 Ganache 账户，保留余额）

        实际归还逻辑由 BotManager 在删除 Bot 实例时调用
        """
        logger.info(f"钱包索引 {wallet_index} 已归还至池")
        return True

    def ensure_funds(self, wallet_index: int, wallet_address: str) -> bool:
        """
        确保钱包有足够余额

        自动充值 ETH 和 USDC 到指定钱包。
        """
        chain_svc = get_local_chain_service()
        if not chain_svc.is_running():
            logger.error("本地链未运行，无法充值")
            return False

        try:
            balance_wei = chain_svc._w3.eth.get_balance(wallet_address)
            balance_eth = float(chain_svc._w3.from_wei(balance_wei, 'ether'))

            if balance_eth < 1.0:
                logger.info(f"钱包 {wallet_address} ETH 余额不足 ({balance_eth:.2f}), 充值中...")
                chain_svc.send_eth(0, wallet_address, self._initial_eth)
                logger.info(f"ETH 充值完成: {self._initial_eth}")

            usdc_token = chain_svc._tokens.get("USDC")
            if usdc_token:
                try:
                    abi_json = [
                        {"inputs": [{"name": "account", "type": "address"}],
                         "name": "balanceOf", "outputs": [{"name": "", "type": "uint256"}],
                         "stateMutability": "view", "type": "function"},
                        {"inputs": [], "name": "decimals",
                         "outputs": [{"name": "", "type": "uint8"}],
                         "stateMutability": "view", "type": "function"},
                    ]
                    usdc_addr = chain_svc._w3.to_checksum_address(usdc_token["address"])
                    usdc_contract = chain_svc._w3.eth.contract(address=usdc_addr, abi=abi_json)
                    decimals = usdc_contract.functions.decimals().call()
                    raw_balance = usdc_contract.functions.balanceOf(wallet_address).call()
                    balance_usdc = float(raw_balance / (10 ** decimals))

                    if balance_usdc < 100:
                        logger.info(f"钱包 {wallet_address} USDC 余额不足 ({balance_usdc:.2f}), 充值中...")
                        chain_svc.mint_tokens("USDC", wallet_address, self._initial_usdc, 0)
                        logger.info(f"USDC 充值完成: {self._initial_usdc}")
                except Exception as e:
                    logger.warning(f"USDC 余额查询/充值失败: {e}")

            return True
        except Exception as e:
            logger.error(f"钱包充值失败: {e}")
            return False

    def _get_or_create_account(self, chain_svc, index: int) -> Optional[str]:
        """获取或创建 Ganache 账户"""
        accounts = chain_svc._accounts
        if index < len(accounts):
            return accounts[index]

        logger.warning(f"Ganache 账户索引 {index} 不存在 (总账户数: {len(accounts)})")
        return None

    def _is_in_range(self, index: int) -> bool:
        """检查索引是否在钱包池范围内"""
        return self._start_index <= index <= self._end_index

    def _get_used_indices(self) -> List[int]:
        """获取已使用的钱包索引列表"""
        try:
            return get_used_wallet_indices()
        except Exception:
            return []


# 钱包池管理器单例
wallet_pool_manager = WalletPoolManager()