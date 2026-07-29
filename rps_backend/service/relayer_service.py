"""
Relayer 代提交服务模块（方案A/B 核心）

负责调用合约 submitCommitWithSig/revealChoiceWithSig，代玩家上链提交 commit/reveal。
玩家只需做 EIP-712 链下签名，无需亲自发交易，提升游戏体验。

重要约定：
- 本模块使用独立的 RELAYER_PRIVATE_KEY 签名上链交易，与 contract_service.py 的事件监听职责分离
- 合约通过 ecrecover 验证签名确实来自玩家本人，relayer 无法伪造
- nonce 防重放：每次代提交后合约自增玩家 nonce
"""
import asyncio
import json
import os
from functools import partial
from typing import Optional

from rps_backend.config import (
    CONTRACT_ADDRESS,
    RELAYER_ADDRESS,
    RELAYER_PRIVATE_KEY,
    RPC_URL,
)


# RPC 调用超时配置
_RPC_TIMEOUT = 15
_RPC_READ_TIMEOUT = 60  # 代提交需等待上链确认，超时放宽


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
    """

    # 初始化
    def __init__(self):
        """
        初始化 relayer 账户与合约对象。
        若 RELAYER_PRIVATE_KEY 未配置，代提交功能不可用，但不影响其他服务。
        """
        self.w3 = None
        self.contract = None
        self.relayer_account = None
        self._available = False

        if not RELAYER_PRIVATE_KEY:
            print("ℹ️  RELAYER_PRIVATE_KEY 未配置，代提交功能不可用（方案A/B 需要）")
            return

        if not CONTRACT_ADDRESS:
            print("ℹ️  合约地址未配置，代提交功能不可用")
            return

        try:
            from web3 import Web3

            self.w3 = _create_web3_with_timeout()
            if not self.w3.is_connected():
                print(f"⚠️  Relayer 无法连接 RPC: {RPC_URL}")
                return

            # 从私钥派生账户
            self.relayer_account = self.w3.eth.account.from_key(RELAYER_PRIVATE_KEY)
            actual_address = self.relayer_account.address

            # 校验配置的 RELAYER_ADDRESS 与私钥派生地址是否一致
            if RELAYER_ADDRESS and RELAYER_ADDRESS.lower() != actual_address.lower():
                print(f"⚠️  RELAYER_ADDRESS({RELAYER_ADDRESS}) 与私钥派生地址({actual_address})不一致，"
                      f"将以私钥派生地址为准")

            self.contract = self.w3.eth.contract(
                address=CONTRACT_ADDRESS,
                abi=CONTRACT_ABI,
            )
            self._available = True
            print(f"✅ Relayer 初始化成功，地址: {actual_address[:10]}...")

        except Exception as e:
            print(f"⚠️  Relayer 初始化失败: {e}")
            self._available = False

    # 检查服务是否可用
    def is_available(self) -> bool:
        """返回 relayer 代提交服务是否可用"""
        return self._available

    # 获取 relayer 地址
    def get_relayer_address(self) -> Optional[str]:
        """返回 relayer 钱包地址（供前端 authorizeRelayer 使用）"""
        if self.relayer_account:
            return self.relayer_account.address
        return None

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

        Args:
            game_id: 链上对局 ID
            player: 玩家地址
            commit_hash: 哈希承诺（bytes32 hex）
            nonce: 玩家当前 nonce
            v, r, s: EIP-712 签名分量

        Returns:
            {"success": bool, "tx_hash": str, "message": str}
        """
        if not self._available:
            return {"success": False, "message": "Relayer 服务不可用"}

        try:
            # 构造交易
            nonce_tx = await _run_sync(
                lambda: self.w3.eth.get_transaction_count(self.relayer_account.address)
            )

            def _from_hex(x):
                return bytes.fromhex(x[2:]) if isinstance(x, str) and x.startswith("0x") else bytes.fromhex(x)

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
                "nonce": nonce_tx,
                "gas": 300000,
                "gasPrice": self.w3.eth.gas_price,
            })

            # 签名并发送
            signed = self.relayer_account.sign_transaction(tx)
            tx_hash = await _run_sync(
                lambda: self.w3.eth.send_raw_transaction(signed.raw_transaction)
            )

            # 等待 1 个确认
            await _run_sync(
                lambda: self.w3.eth.wait_for_transaction_receipt(tx_hash, timeout=120)
            )

            return {
                "success": True,
                "tx_hash": tx_hash.hex(),
                "message": "代提交 commit 成功"
            }

        except Exception as e:
            err_msg = str(e)
            # 识别常见错误
            if "Nonce mismatch" in err_msg:
                return {"success": False, "message": "Nonce 不匹配，签名可能已被使用"}
            if "Invalid signature" in err_msg:
                return {"success": False, "message": "签名校验失败"}
            if "Not in commit phase" in err_msg:
                return {"success": False, "message": "对局不在提交阶段"}
            if "Already committed" in err_msg:
                return {"success": False, "message": "已提交过 commit"}
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

        Args:
            game_id: 链上对局 ID
            player: 玩家地址
            choice: 出拳 (1=石头, 2=布, 3=剪刀)
            salt: 盐值（bytes32 hex）
            nonce: 玩家当前 nonce
            v, r, s: EIP-712 签名分量

        Returns:
            {"success": bool, "tx_hash": str, "message": str}
        """
        if not self._available:
            return {"success": False, "message": "Relayer 服务不可用"}

        try:
            nonce_tx = await _run_sync(
                lambda: self.w3.eth.get_transaction_count(self.relayer_account.address)
            )

            def _from_hex(x):
                return bytes.fromhex(x[2:]) if isinstance(x, str) and x.startswith("0x") else bytes.fromhex(x)

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
                "nonce": nonce_tx,
                "gas": 400000,  # reveal 触发结算，gas 略高
                "gasPrice": self.w3.eth.gas_price,
            })

            signed = self.relayer_account.sign_transaction(tx)
            tx_hash = await _run_sync(
                lambda: self.w3.eth.send_raw_transaction(signed.raw_transaction)
            )

            await _run_sync(
                lambda: self.w3.eth.wait_for_transaction_receipt(tx_hash, timeout=120)
            )

            return {
                "success": True,
                "tx_hash": tx_hash.hex(),
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
            print(f"⚠️  查询 relayer 授权状态失败: {e}")
            return {"active": False, "relayer": "", "deadline": 0}


# 全局 relayer 服务实例
relayer_service = RelayerService()
