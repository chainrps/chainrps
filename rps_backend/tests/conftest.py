"""
pytest 全局夹具

- 在导入 rps_backend 之前清空相关环境变量，避免开发机 .env 污染测试
- 提供常用 mock 工具
"""
import os
import sys
import asyncio
from typing import Optional

import pytest

# 确保项目根目录在 sys.path 中（pyproject.toml 已配置 pythonpath=["."]，
# 但保险起见在测试运行入口显式加上）
_PROJECT_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
if _PROJECT_ROOT not in sys.path:
    sys.path.insert(0, _PROJECT_ROOT)


# 清空可能影响测试的敏感环境变量，确保 RelayerService 在测试中默认不初始化
_ENV_KEYS_TO_CLEAR = [
    "RELAYER_PRIVATE_KEY",
    "RELAYER_ADDRESS",
    "CONTRACT_ADDRESS",
    "RPC_URL",
    "RPC_CHAIN_ID",
]


@pytest.fixture(scope="session", autouse=True)
def _clear_relayer_env():
    """会话级自动夹具：清空 relayer/contract 相关环境变量"""
    saved = {}
    for key in _ENV_KEYS_TO_CLEAR:
        if key in os.environ:
            saved[key] = os.environ.pop(key)
    yield
    # 恢复
    for key, val in saved.items():
        os.environ[key] = val


@pytest.fixture
def make_relayer_service():
    """
    工厂夹具：构造一个未初始化的 RelayerService 实例，
    供测试中手动注入 mock 的 w3/contract/account。
    """
    from rps_backend.service.relayer_service import RelayerService

    def _factory():
        # 直接构造实例，绕过 __init__ 中的环境变量检查
        svc = RelayerService.__new__(RelayerService)
        # 手动初始化基础字段
        svc.w3 = None
        svc.contract = None
        svc.relayer_account = None
        svc._available = False
        svc._health_status = {
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
        svc._health_check_task = None
        svc._player_queues = {}
        svc._player_workers = {}
        svc._local_nonce = None
        svc._nonce_lock = asyncio.Lock()
        svc._pending_txs = {}
        svc._pending_lock = asyncio.Lock()
        svc._stuck_check_task = None
        return svc

    return _factory


class FakeAccount:
    """模拟 web3 Account 对象"""

    def __init__(self, address: str):
        self.address = address

    def sign_transaction(self, tx):
        class _Signed:
            raw_transaction = b"\x00" * 32
        return _Signed()


class FakeEth:
    """模拟 web3.eth 接口"""

    def __init__(self, *,
                 connected: bool = True,
                 balance: int = 10 ** 18,
                 chain_nonce: int = 0,
                 gas_price: int = 10 ** 9,
                 raise_on_balance: Optional[Exception] = None,
                 raise_on_nonce: Optional[Exception] = None,
                 receipt_status: int = 1,
                 receipt_raise: bool = False):
        self._connected = connected
        self._balance = balance
        self._chain_nonce = chain_nonce
        self._gas_price = gas_price
        self._raise_on_balance = raise_on_balance
        self._raise_on_nonce = raise_on_nonce
        self._receipt_status = receipt_status
        self._receipt_raise = receipt_raise
        # 记录调用
        self.calls = []

    def is_connected(self):
        return self._connected

    def get_balance(self, addr):
        self.calls.append(("get_balance", addr))
        if self._raise_on_balance:
            raise self._raise_on_balance
        return self._balance

    def get_transaction_count(self, addr):
        self.calls.append(("get_transaction_count", addr))
        if self._raise_on_nonce:
            raise self._raise_on_nonce
        return self._chain_nonce

    @property
    def gas_price(self):
        return self._gas_price

    def get_transaction_receipt(self, tx_hash):
        if self._receipt_raise:
            raise Exception("TransactionNotFound")
        return {"status": self._receipt_status}

    def wait_for_transaction_receipt(self, tx_hash, timeout=120):
        return {"status": self._receipt_status}

    def send_raw_transaction(self, raw):
        class _H:
            def hex(self_):
                return "0x" + "ab" * 32
        return _H()


class FakeWeb3:
    """模拟 web3.Web3 对象"""

    def __init__(self, eth: FakeEth):
        self.eth = eth

    def is_connected(self):
        return self.eth.is_connected()

    @staticmethod
    def to_checksum_address(addr: str) -> str:
        return addr


@pytest.fixture
def fake_account_factory():
    return FakeAccount


@pytest.fixture
def fake_eth_factory():
    return FakeEth


@pytest.fixture
def fake_web3_factory():
    return FakeWeb3
