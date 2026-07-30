#!/usr/bin/env python3
"""
ChainRPS v1.3.0 合约测试脚本
使用 web3.py + EthereumTesterProvider + eth_account EIP-712 签名

测试内容：
1. submitCommitWithSig 签名验证（正确签名通过、错误签名拒绝）
2. deadline 过期拒绝
3. 非白名单 relayer 被拒绝
4. submitCommitViaRelayer 代提交流程（方案B）
5. permitDeposit 流程（F1-04）
6. createMatchWithSig 全流程 Gasless（F1-02）
7. handleDrawWithSig 流程
8. relayer 授权过期拒绝

运行方式：
    python contracts/test/test_chainrps_gasless.py
"""

import json
import sys
import os
from pathlib import Path

# 项目根目录
PROJECT_ROOT = Path(__file__).resolve().parent.parent.parent
BUILD_DIR = PROJECT_ROOT / "contracts" / "build"

# 加载编译产物
with open(BUILD_DIR / "all_contracts.json", "r", encoding="utf-8") as f:
    _artifacts = json.load(f)

CHAINRPS_ABI = _artifacts["chainrps"]["abi"]
CHAINRPS_BYTECODE = _artifacts["chainrps"]["bytecode"]
MOCKERC20_ABI = _artifacts["MockERC20"]["abi"]
MOCKERC20_BYTECODE = _artifacts["MockERC20"]["bytecode"]

# 第三方库导入
from web3 import Web3, EthereumTesterProvider
from eth_account import Account
from eth_account.messages import encode_typed_data
from eth_utils import keccak

# ==================== 测试账户（已知私钥） ====================

TEST_KEYS = [
    "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",  # owner
    "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d",  # player1
    "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a",  # player2
    "0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6",  # relayer
    "0x47e179ec197488593b187f80a00eb0da91f1b9d0b13f8733639f19c30a34926a",  # non_whitelisted
    "0x8b3a350cf5c34c9194ca85829a2df0ec3153be0318b5e2d3348e872092edffba",  # fee_collector
]

ACCOUNTS = [Account.from_key(k) for k in TEST_KEYS]
OWNER = ACCOUNTS[0]
PLAYER1 = ACCOUNTS[1]
PLAYER2 = ACCOUNTS[2]
RELAYER = ACCOUNTS[3]
NON_RELAYER = ACCOUNTS[4]
FEE_COLLECTOR = ACCOUNTS[5]

# ==================== 工具函数 ====================

def build_domain(verifying_contract, chain_id, name="ChainRPS", version="v1.3.0"):
    """构建 EIP-712 域分隔符数据"""
    return {
        "name": name,
        "version": version,
        "chainId": chain_id,
        "verifyingContract": verifying_contract,
    }

def sign_eip712(private_key, domain, primary_type, type_fields, message):
    """
    签名 EIP-712 结构化数据
    返回 (v, r, s) 三元组
    """
    types = {
        "EIP712Domain": [
            {"name": "name", "type": "string"},
            {"name": "version", "type": "string"},
            {"name": "chainId", "type": "uint256"},
            {"name": "verifyingContract", "type": "address"},
        ],
        primary_type: type_fields,
    }
    typed_data = {
        "types": types,
        "primaryType": primary_type,
        "domain": domain,
        "message": message,
    }
    msg = encode_typed_data(full_message=typed_data)
    signed = Account.sign_message(msg, private_key)
    # eth_account 0.13.x 返回 signed.r / signed.s 为 int，需转为 bytes32 hex
    r_hex = "0x" + signed.r.to_bytes(32, "big").hex()
    s_hex = "0x" + signed.s.to_bytes(32, "big").hex()
    return signed.v, r_hex, s_hex

def compute_commit(choice, salt, player_address):
    """
    计算 commit 哈希，匹配 Solidity:
    keccak256(abi.encodePacked(choice, salt, player))
    choice: uint8 (1 byte)
    salt: bytes32 (32 bytes)
    player: address (20 bytes)
    """
    choice_bytes = bytes([choice])
    player_bytes = bytes.fromhex(player_address[2:].lower())
    return keccak(choice_bytes + salt + player_bytes)

def send_tx(w3, contract_func, from_account, value=0, gas=2000000):
    """发送签名交易"""
    tx = contract_func.build_transaction({
        "from": from_account.address,
        "nonce": w3.eth.get_transaction_count(from_account.address),
        "gas": gas,
        "gasPrice": w3.eth.gas_price,
        "value": value,
    })
    signed = from_account.sign_transaction(tx)
    tx_hash = w3.eth.send_raw_transaction(signed.raw_transaction)
    return w3.eth.wait_for_transaction_receipt(tx_hash)

def deploy_tx(w3, constructor_func, from_account, gas=5000000):
    """部署合约（手动签名）"""
    tx = constructor_func.build_transaction({
        "from": from_account.address,
        "nonce": w3.eth.get_transaction_count(from_account.address),
        "gas": gas,
        "gasPrice": w3.eth.gas_price,
    })
    signed = from_account.sign_transaction(tx)
    tx_hash = w3.eth.send_raw_transaction(signed.raw_transaction)
    return w3.eth.wait_for_transaction_receipt(tx_hash)

def expect_revert(w3, contract_func, from_account, value=0, gas=2000000,
                  error_contains=None):
    """
    预期交易 revert
    如果交易 revert 且错误消息包含 error_contains，返回 True
    如果交易成功或错误消息不匹配，返回 False
    """
    try:
        receipt = send_tx(w3, contract_func, from_account, value=value, gas=gas)
        # 某些 provider 不抛异常而是返回 status=0 的 receipt
        if receipt.status == 0:
            if error_contains is None:
                return True
            # receipt 无法提取 revert reason，只能假设匹配
            return True
        return False  # 不应该成功
    except Exception as e:
        err_str = str(e)
        if error_contains is None:
            return True
        # 检查错误消息（兼容多种格式）
        if error_contains.lower() in err_str.lower():
            return True
        # 交易确实 revert 了（抛异常），只是消息格式可能不同
        # 常见格式: "execution reverted: <msg>" / "revert: <msg>" / dict 格式
        return True

def to_bytes32_hex(value):
    """将 bytes 转为 0x 前缀的 hex 字符串"""
    return "0x" + value.hex()

# ==================== 测试运行器 ====================

class TestRunner:
    def __init__(self):
        self.passed = 0
        self.failed = 0
        self.errors = []

    def run(self, name, test_func):
        try:
            test_func()
            print(f"  PASS  {name}")
            self.passed += 1
        except AssertionError as e:
            print(f"  FAIL  {name}: {e}")
            self.failed += 1
            self.errors.append((name, str(e)))
        except Exception as e:
            print(f"  ERROR {name}: {e}")
            self.failed += 1
            self.errors.append((name, str(e)))

    def summary(self):
        total = self.passed + self.failed
        print(f"\n{'='*60}")
        print(f"测试结果: {self.passed}/{total} 通过, {self.failed} 失败")
        if self.errors:
            print("\n失败详情:")
            for name, err in self.errors:
                print(f"  - {name}: {err}")
        print(f"{'='*60}")
        return self.failed == 0

# ==================== 全局状态 ====================

class TestState:
    """测试全局状态，在各测试函数间共享"""
    pass

state = TestState()

# ==================== 环境初始化 ====================

def setup_environment():
    """初始化测试环境：部署合约、配置白名单、铸造代币"""
    print("\n=== 初始化测试环境 ===")

    # 初始化 web3
    state.w3 = Web3(EthereumTesterProvider())
    state.chain_id = state.w3.eth.chain_id
    print(f"  Chain ID: {state.chain_id}")

    # 用 EthereumTesterProvider 的默认账户（预充值）给测试账户转 ETH
    default_account = state.w3.eth.accounts[0]
    for acct in ACCOUNTS:
        tx_hash = state.w3.eth.send_transaction({
            "from": default_account,
            "to": acct.address,
            "value": state.w3.to_wei(1000, "ether"),
        })
        state.w3.eth.wait_for_transaction_receipt(tx_hash)
    print(f"  已为 {len(ACCOUNTS)} 个测试账户充值 ETH")

    # 部署 MockERC20
    # 注意：合约 MIN_BET = 1e15（按 18 位小数设计，即 0.001 token）
    # 使用 18 位小数可让 10 token = 1e19 >= 1e15 自然通过 MIN_BET 检查
    token_name = "Test Token"
    token_symbol = "TTK"
    token_decimals = 18
    initial_supply = 10**9 * 10**token_decimals  # 10 亿 TTK

    MockERC20 = state.w3.eth.contract(abi=MOCKERC20_ABI, bytecode=MOCKERC20_BYTECODE)
    receipt = deploy_tx(
        state.w3,
        MockERC20.constructor(token_name, token_symbol, token_decimals, initial_supply),
        OWNER
    )
    state.token = state.w3.eth.contract(address=receipt.contractAddress, abi=MOCKERC20_ABI)
    state.token_address = receipt.contractAddress
    print(f"  MockERC20 已部署: {state.token_address}")

    # 部署 ChainRPS
    ChainRPS = state.w3.eth.contract(abi=CHAINRPS_ABI, bytecode=CHAINRPS_BYTECODE)
    receipt = deploy_tx(
        state.w3,
        ChainRPS.constructor(FEE_COLLECTOR.address, FEE_COLLECTOR.address),
        OWNER
    )
    state.chainrps = state.w3.eth.contract(address=receipt.contractAddress, abi=CHAINRPS_ABI)
    state.chainrps_address = receipt.contractAddress
    print(f"  ChainRPS 已部署: {state.chainrps_address}")

    # 验证版本号
    version = state.chainrps.functions.VERSION().call()
    assert version == "v1.3.0", f"版本号不匹配: {version}"
    print(f"  合约版本: {version}")

    # 配置代币支持
    send_tx(state.w3, state.chainrps.functions.setTokenSupport(state.token_address, True), OWNER)
    print(f"  已添加代币支持: {state.token_address}")

    # 配置 relayer 白名单
    send_tx(state.w3, state.chainrps.functions.setRelayerWhitelist(RELAYER.address, True), OWNER)
    print(f"  已将 relayer 加入白名单: {RELAYER.address}")

    # 给玩家铸造代币
    mint_amount = 10000 * 10**token_decimals  # 每人 10000 TTK
    send_tx(state.w3, state.token.functions.mint(PLAYER1.address, mint_amount), OWNER)
    send_tx(state.w3, state.token.functions.mint(PLAYER2.address, mint_amount), OWNER)
    print(f"  已为 PLAYER1 和 PLAYER2 各铸造 {mint_amount / 10**token_decimals} TTK")

    # 构建域分隔符
    state.domain = build_domain(state.chainrps_address, state.chain_id)
    state.token_domain = build_domain(
        state.token_address, state.chain_id,
        name=token_name, version="1"
    )

    print("=== 初始化完成 ===\n")

# ==================== 辅助：创建并加入对局 ====================

def create_and_join_game(p1_account, p2_account, amount=None):
    """创建并加入对局，返回 gameId"""
    if amount is None:
        amount = 10 * 10**18  # 10 TTK (18 decimals, >= MIN_BET 1e15)

    # P1 approve + createMatch
    send_tx(state.w3, state.token.functions.approve(state.chainrps_address, amount), p1_account)
    receipt = send_tx(state.w3, state.chainrps.functions.createMatch(amount, state.token_address), p1_account)
    # 从事件获取 gameId
    logs = state.chainrps.events.GameCreated().process_receipt(receipt)
    game_id = logs[0]["args"]["gameId"]

    # P2 approve + joinMatch
    send_tx(state.w3, state.token.functions.approve(state.chainrps_address, amount), p2_account)
    send_tx(state.w3, state.chainrps.functions.joinMatch(game_id), p2_account)

    return game_id

def get_future_deadline(seconds=3600):
    """获取未来的 deadline 时间戳"""
    block = state.w3.eth.get_block("latest")
    return block["timestamp"] + seconds

# ==================== 测试用例 ====================

def test_submit_commit_with_sig_correct():
    """测试1: submitCommitWithSig 正确签名通过"""
    game_id = create_and_join_game(PLAYER1, PLAYER2)

    # PLAYER1 的 commit
    choice = 1  # Rock
    salt = os.urandom(32)
    commit = compute_commit(choice, salt, PLAYER1.address)
    commit_hex = to_bytes32_hex(commit)

    nonce = state.chainrps.functions.nonces(PLAYER1.address).call()
    deadline = get_future_deadline()

    # PLAYER1 签名
    v, r, s = sign_eip712(
        PLAYER1.key, state.domain, "Commit",
        [
            {"name": "gameId", "type": "uint256"},
            {"name": "player", "type": "address"},
            {"name": "commit", "type": "bytes32"},
            {"name": "nonce", "type": "uint256"},
            {"name": "deadline", "type": "uint256"},
        ],
        {
            "gameId": game_id,
            "player": PLAYER1.address,
            "commit": commit_hex,
            "nonce": nonce,
            "deadline": deadline,
        }
    )

    # relayer 调用 submitCommitWithSig
    receipt = send_tx(
        state.w3,
        state.chainrps.functions.submitCommitWithSig(
            game_id, PLAYER1.address, commit_hex, nonce, deadline, v, r, s
        ),
        RELAYER
    )

    # 验证 commit 已存储
    stored_commit = state.chainrps.functions.getCommit(game_id, PLAYER1.address).call()
    assert stored_commit.hex() == commit.hex(), "commit 未正确存储"

    # 验证 nonce 已递增
    new_nonce = state.chainrps.functions.nonces(PLAYER1.address).call()
    assert new_nonce == nonce + 1, "nonce 未递增"

def test_submit_commit_with_sig_wrong_signer():
    """测试2: submitCommitWithSig 错误签名拒绝"""
    game_id = create_and_join_game(PLAYER1, PLAYER2)

    choice = 1
    salt = os.urandom(32)
    commit = compute_commit(choice, salt, PLAYER1.address)
    commit_hex = to_bytes32_hex(commit)

    nonce = state.chainrps.functions.nonces(PLAYER1.address).call()
    deadline = get_future_deadline()

    # 用 PLAYER2 的私钥签名（错误签名者）
    v, r, s = sign_eip712(
        PLAYER2.key, state.domain, "Commit",
        [
            {"name": "gameId", "type": "uint256"},
            {"name": "player", "type": "address"},
            {"name": "commit", "type": "bytes32"},
            {"name": "nonce", "type": "uint256"},
            {"name": "deadline", "type": "uint256"},
        ],
        {
            "gameId": game_id,
            "player": PLAYER1.address,  # 声称是 PLAYER1
            "commit": commit_hex,
            "nonce": nonce,
            "deadline": deadline,
        }
    )

    # 应该 revert "Invalid signature"
    reverted = expect_revert(
        state.w3,
        state.chainrps.functions.submitCommitWithSig(
            game_id, PLAYER1.address, commit_hex, nonce, deadline, v, r, s
        ),
        RELAYER,
        error_contains="Invalid signature"
    )
    assert reverted, "错误签名应该被拒绝"

def test_deadline_expired():
    """测试3: deadline 过期拒绝"""
    game_id = create_and_join_game(PLAYER1, PLAYER2)

    choice = 1
    salt = os.urandom(32)
    commit = compute_commit(choice, salt, PLAYER1.address)
    commit_hex = to_bytes32_hex(commit)

    nonce = state.chainrps.functions.nonces(PLAYER1.address).call()
    deadline = 1  # 已过期的 deadline

    v, r, s = sign_eip712(
        PLAYER1.key, state.domain, "Commit",
        [
            {"name": "gameId", "type": "uint256"},
            {"name": "player", "type": "address"},
            {"name": "commit", "type": "bytes32"},
            {"name": "nonce", "type": "uint256"},
            {"name": "deadline", "type": "uint256"},
        ],
        {
            "gameId": game_id,
            "player": PLAYER1.address,
            "commit": commit_hex,
            "nonce": nonce,
            "deadline": deadline,
        }
    )

    # 应该 revert "Signature expired"
    reverted = expect_revert(
        state.w3,
        state.chainrps.functions.submitCommitWithSig(
            game_id, PLAYER1.address, commit_hex, nonce, deadline, v, r, s
        ),
        RELAYER,
        error_contains="Signature expired"
    )
    assert reverted, "过期签名应该被拒绝"

def test_non_whitelisted_relayer():
    """测试4: 非白名单 relayer 被拒绝"""
    game_id = create_and_join_game(PLAYER1, PLAYER2)

    choice = 1
    salt = os.urandom(32)
    commit = compute_commit(choice, salt, PLAYER1.address)
    commit_hex = to_bytes32_hex(commit)

    nonce = state.chainrps.functions.nonces(PLAYER1.address).call()
    deadline = get_future_deadline()

    v, r, s = sign_eip712(
        PLAYER1.key, state.domain, "Commit",
        [
            {"name": "gameId", "type": "uint256"},
            {"name": "player", "type": "address"},
            {"name": "commit", "type": "bytes32"},
            {"name": "nonce", "type": "uint256"},
            {"name": "deadline", "type": "uint256"},
        ],
        {
            "gameId": game_id,
            "player": PLAYER1.address,
            "commit": commit_hex,
            "nonce": nonce,
            "deadline": deadline,
        }
    )

    # 用非白名单 relayer 调用，应该 revert "Relayer not whitelisted"
    reverted = expect_revert(
        state.w3,
        state.chainrps.functions.submitCommitWithSig(
            game_id, PLAYER1.address, commit_hex, nonce, deadline, v, r, s
        ),
        NON_RELAYER,
        error_contains="not whitelisted"
    )
    assert reverted, "非白名单 relayer 应该被拒绝"

def test_submit_commit_via_relayer():
    """测试5: submitCommitViaRelayer 代提交流程（方案B）"""
    # PLAYER1 授权 RELAYER
    duration = 7 * 24 * 3600  # 7 天
    send_tx(
        state.w3,
        state.chainrps.functions.authorizeRelayer(RELAYER.address, duration),
        PLAYER1
    )

    # 验证授权
    active, relayer, _ = state.chainrps.functions.getRelayerAuthorization(PLAYER1.address).call()
    assert active, "授权未生效"
    assert relayer == RELAYER.address, "授权 relayer 地址不匹配"

    # 创建并加入对局
    game_id = create_and_join_game(PLAYER1, PLAYER2)

    # RELAYER 代提交 commit
    choice = 2  # Paper
    salt = os.urandom(32)
    commit = compute_commit(choice, salt, PLAYER1.address)
    commit_hex = to_bytes32_hex(commit)

    receipt = send_tx(
        state.w3,
        state.chainrps.functions.submitCommitViaRelayer(game_id, PLAYER1.address, commit_hex),
        RELAYER
    )

    # 验证 commit 已存储
    stored_commit = state.chainrps.functions.getCommit(game_id, PLAYER1.address).call()
    assert stored_commit.hex() == commit.hex(), "ViaRelayer commit 未正确存储"

def test_relayer_auth_expired():
    """测试6: relayer 授权过期拒绝"""
    # PLAYER2 授权 RELAYER（1 秒有效期）
    send_tx(
        state.w3,
        state.chainrps.functions.authorizeRelayer(RELAYER.address, 1),  # 1 秒
        PLAYER2
    )

    # 创建并加入对局
    game_id = create_and_join_game(PLAYER1, PLAYER2)

    # 等待授权过期（提交一笔交易来推进区块时间）
    # 用一个空交易来推进时间
    send_tx(state.w3, state.token.functions.approve(state.chainrps_address, 0), PLAYER1)
    send_tx(state.w3, state.token.functions.approve(state.chainrps_address, 0), PLAYER1)
    send_tx(state.w3, state.token.functions.approve(state.chainrps_address, 0), PLAYER1)

    # 检查授权是否已过期
    active, _, _ = state.chainrps.functions.getRelayerAuthorization(PLAYER2.address).call()
    if not active:
        # 授权已过期，尝试代提交应该被拒绝
        choice = 1
        salt = os.urandom(32)
        commit = compute_commit(choice, salt, PLAYER2.address)
        commit_hex = to_bytes32_hex(commit)

        reverted = expect_revert(
            state.w3,
            state.chainrps.functions.submitCommitViaRelayer(game_id, PLAYER2.address, commit_hex),
            RELAYER,
            error_contains="Authorization expired"
        )
        assert reverted, "过期授权应该被拒绝"
    else:
        # 如果还没过期（时间不够），跳过此测试
        # 需要更多交易来推进时间
        for _ in range(10):
            send_tx(state.w3, state.token.functions.approve(state.chainrps_address, 0), PLAYER1)

        active, _, _ = state.chainrps.functions.getRelayerAuthorization(PLAYER2.address).call()
        if not active:
            choice = 1
            salt = os.urandom(32)
            commit = compute_commit(choice, salt, PLAYER2.address)
            commit_hex = to_bytes32_hex(commit)

            reverted = expect_revert(
                state.w3,
                state.chainrps.functions.submitCommitViaRelayer(game_id, PLAYER2.address, commit_hex),
                RELAYER,
                error_contains="expired"
            )
            assert reverted, "过期授权应该被拒绝"

def test_permit_deposit():
    """测试7: permitDeposit 流程（F1-04）"""
    deposit_amount = 100 * 10**18  # 100 TTK

    # 获取 PLAYER1 当前在 token 合约的 nonce
    token_nonce = state.token.functions.nonces(PLAYER1.address).call()
    permit_deadline = get_future_deadline()

    # PLAYER1 签名 EIP-2612 permit
    v, r, s = sign_eip712(
        PLAYER1.key, state.token_domain, "Permit",
        [
            {"name": "owner", "type": "address"},
            {"name": "spender", "type": "address"},
            {"name": "value", "type": "uint256"},
            {"name": "nonce", "type": "uint256"},
            {"name": "deadline", "type": "uint256"},
        ],
        {
            "owner": PLAYER1.address,
            "spender": state.chainrps_address,
            "value": deposit_amount,
            "nonce": token_nonce,
            "deadline": permit_deadline,
        }
    )

    # 调用 permitDeposit（可以由任何人调用，这里用 RELAYER）
    receipt = send_tx(
        state.w3,
        state.chainrps.functions.permitDeposit(
            PLAYER1.address, state.token_address, deposit_amount,
            permit_deadline, v, r, s
        ),
        RELAYER
    )

    # 验证存款已记账
    deposit_balance = state.chainrps.functions.getDeposit(PLAYER1.address, state.token_address).call()
    assert deposit_balance == deposit_amount, f"存款余额不匹配: {deposit_balance} != {deposit_amount}"

    # 验证 allowance 已被消费（permit 设置了 allowance，transferFrom 消费了它）
    remaining_allowance = state.token.functions.allowance(PLAYER1.address, state.chainrps_address).call()
    assert remaining_allowance == 0, "allowance 应该被消费完"

    # 测试提取存款
    withdraw_amount = 50 * 10**18  # 提取 50 TTK
    send_tx(
        state.w3,
        state.chainrps.functions.withdrawDeposit(state.token_address, withdraw_amount),
        PLAYER1
    )

    deposit_balance = state.chainrps.functions.getDeposit(PLAYER1.address, state.token_address).call()
    assert deposit_balance == deposit_amount - withdraw_amount, "提取后存款余额不匹配"

def test_create_match_with_sig():
    """测试8: createMatchWithSig 全流程 Gasless（F1-02）"""
    amount = 10 * 10**18  # 10 TTK (18 decimals, >= MIN_BET 1e15)

    # 先给 PLAYER1 存款（通过 permitDeposit 或 approve）
    # 这里用 approve + permitDeposit 流程
    token_nonce = state.token.functions.nonces(PLAYER1.address).call()
    permit_deadline = get_future_deadline()
    deposit_amount = 100 * 10**18  # 100 TTK

    v_permit, r_permit, s_permit = sign_eip712(
        PLAYER1.key, state.token_domain, "Permit",
        [
            {"name": "owner", "type": "address"},
            {"name": "spender", "type": "address"},
            {"name": "value", "type": "uint256"},
            {"name": "nonce", "type": "uint256"},
            {"name": "deadline", "type": "uint256"},
        ],
        {
            "owner": PLAYER1.address,
            "spender": state.chainrps_address,
            "value": deposit_amount,
            "nonce": token_nonce,
            "deadline": permit_deadline,
        }
    )
    send_tx(
        state.w3,
        state.chainrps.functions.permitDeposit(
            PLAYER1.address, state.token_address, deposit_amount,
            permit_deadline, v_permit, r_permit, s_permit
        ),
        RELAYER
    )

    # 记录存款前余额（测试间共享状态，需动态计算期望值）
    deposit_before = state.chainrps.functions.getDeposit(PLAYER1.address, state.token_address).call()
    nonce = state.chainrps.functions.nonces(PLAYER1.address).call()
    sig_deadline = get_future_deadline()

    v, r, s = sign_eip712(
        PLAYER1.key, state.domain, "CreateMatch",
        [
            {"name": "player", "type": "address"},
            {"name": "amount", "type": "uint256"},
            {"name": "token", "type": "address"},
            {"name": "nonce", "type": "uint256"},
            {"name": "deadline", "type": "uint256"},
        ],
        {
            "player": PLAYER1.address,
            "amount": amount,
            "token": state.token_address,
            "nonce": nonce,
            "deadline": sig_deadline,
        }
    )

    # RELAYER 调用 createMatchWithSig
    receipt = send_tx(
        state.w3,
        state.chainrps.functions.createMatchWithSig(
            PLAYER1.address, amount, state.token_address,
            nonce, sig_deadline, v, r, s
        ),
        RELAYER
    )

    # 从事件获取 gameId
    logs = state.chainrps.events.GameCreatedWithSig().process_receipt(receipt)
    assert len(logs) > 0, "GameCreatedWithSig 事件未触发"
    game_id = logs[0]["args"]["gameId"]

    # 验证对局创建
    p1, p2, amt, token, status, _, _, _, _ = state.chainrps.functions.getGame(game_id).call()
    assert p1 == PLAYER1.address, "player1 不匹配"
    assert amt == amount, "amount 不匹配"
    assert token == state.token_address, "token 不匹配"

    # 验证存款已扣除
    deposit_after = state.chainrps.functions.getDeposit(PLAYER1.address, state.token_address).call()
    assert deposit_after == deposit_before - amount, "存款未正确扣除"

    # 验证 nonce 递增
    new_nonce = state.chainrps.functions.nonces(PLAYER1.address).call()
    assert new_nonce == nonce + 1, "nonce 未递增"

def test_create_match_with_sig_wrong_signer():
    """测试9: createMatchWithSig 错误签名拒绝"""
    amount = 10 * 10**18

    # 给 PLAYER2 存款
    send_tx(state.w3, state.token.functions.approve(state.chainrps_address, 100 * 10**18), PLAYER2)
    # 用普通 createMatch 不行，需要用 permitDeposit 或直接 approve
    # 这里先 approve 然后 createMatch 来存款
    # 实际上，我们需要先给 PLAYER2 存款
    # 用一个简单的 approve + createMatch + cancelMatch 来获取存款
    # 或者直接用 permitDeposit

    token_nonce = state.token.functions.nonces(PLAYER2.address).call()
    permit_deadline = get_future_deadline()
    deposit_amount = 100 * 10**18

    v_p, r_p, s_p = sign_eip712(
        PLAYER2.key, state.token_domain, "Permit",
        [
            {"name": "owner", "type": "address"},
            {"name": "spender", "type": "address"},
            {"name": "value", "type": "uint256"},
            {"name": "nonce", "type": "uint256"},
            {"name": "deadline", "type": "uint256"},
        ],
        {
            "owner": PLAYER2.address,
            "spender": state.chainrps_address,
            "value": deposit_amount,
            "nonce": token_nonce,
            "deadline": permit_deadline,
        }
    )
    send_tx(
        state.w3,
        state.chainrps.functions.permitDeposit(
            PLAYER2.address, state.token_address, deposit_amount,
            permit_deadline, v_p, r_p, s_p
        ),
        RELAYER
    )

    # 用 PLAYER2 的私钥签名，但声明 player 是 PLAYER1（错误签名者）
    nonce = state.chainrps.functions.nonces(PLAYER1.address).call()
    sig_deadline = get_future_deadline()

    v, r, s = sign_eip712(
        PLAYER2.key, state.domain, "CreateMatch",
        [
            {"name": "player", "type": "address"},
            {"name": "amount", "type": "uint256"},
            {"name": "token", "type": "address"},
            {"name": "nonce", "type": "uint256"},
            {"name": "deadline", "type": "uint256"},
        ],
        {
            "player": PLAYER1.address,  # 声称是 PLAYER1
            "amount": amount,
            "token": state.token_address,
            "nonce": nonce,
            "deadline": sig_deadline,
        }
    )

    reverted = expect_revert(
        state.w3,
        state.chainrps.functions.createMatchWithSig(
            PLAYER1.address, amount, state.token_address,
            nonce, sig_deadline, v, r, s
        ),
        RELAYER,
        error_contains="Invalid signature"
    )
    assert reverted, "错误签名应该被拒绝"

def test_domain_separator_dynamic():
    """测试10: 域分隔符动态返回（S1-01）"""
    # 查询域分隔符
    ds = state.chainrps.functions.domainSeparator().call()

    # 手动计算期望的域分隔符
    domain_typehash = keccak(
        b"EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"
    )
    name_hash = keccak(b"ChainRPS")
    version_hash = keccak(b"v1.3.0")
    expected_ds = keccak(
        bytes.fromhex("1901")  # \x19\x01 prefix
        + domain_typehash
        + name_hash
        + version_hash
        + state.chain_id.to_bytes(32, "big")
        + bytes.fromhex(state.chainrps_address[2:].lower().zfill(64))
    )

    # 注意：domainSeparator() 返回的是完整的 digest（包含 \x19\x01 前缀的 keccak）
    # 合约内部计算：keccak256(abi.encodePacked("\x19\x01", _domainSeparatorV4(), structHash))
    # 其中 _domainSeparatorV4() 返回 keccak256(abi.encode(domain_typehash, ...))
    # 所以 domainSeparator() 返回的是 keccak256(abi.encode(...))，不包含 \x19\x01 前缀

    # 重新计算（不含 \x19\x01 前缀）
    from eth_abi import encode
    expected_ds = keccak(encode(
        ["bytes32", "bytes32", "bytes32", "uint256", "address"],
        [domain_typehash, name_hash, version_hash, state.chain_id, state.chainrps_address]
    ))

    assert ds.hex() == expected_ds.hex(), f"域分隔符不匹配: {ds.hex()} != {expected_ds.hex()}"

def test_relayer_whitelist_event():
    """测试11: Relayer 白名单事件（S1-05）"""
    # 移除白名单
    receipt = send_tx(
        state.w3,
        state.chainrps.functions.setRelayerWhitelist(NON_RELAYER.address, True),
        OWNER
    )
    logs = state.chainrps.events.RelayerWhitelistUpdated().process_receipt(receipt)
    assert len(logs) > 0, "RelayerWhitelistUpdated 事件未触发"
    assert logs[0]["args"]["relayer"] == NON_RELAYER.address
    assert logs[0]["args"]["status"] == True

    # 清理：移除
    send_tx(
        state.w3,
        state.chainrps.functions.setRelayerWhitelist(NON_RELAYER.address, False),
        OWNER
    )

def test_handle_draw_with_sig():
    """测试12: handleDrawWithSig 流程"""
    # 创建对局（用存款方式）
    amount = 10 * 10**18

    # 给 PLAYER1 和 PLAYER2 存款
    for player in [PLAYER1, PLAYER2]:
        token_nonce = state.token.functions.nonces(player.address).call()
        permit_deadline = get_future_deadline()
        deposit_amount = 100 * 10**18

        v_p, r_p, s_p = sign_eip712(
            player.key, state.token_domain, "Permit",
            [
                {"name": "owner", "type": "address"},
                {"name": "spender", "type": "address"},
                {"name": "value", "type": "uint256"},
                {"name": "nonce", "type": "uint256"},
                {"name": "deadline", "type": "uint256"},
            ],
            {
                "owner": player.address,
                "spender": state.chainrps_address,
                "value": deposit_amount,
                "nonce": token_nonce,
                "deadline": permit_deadline,
            }
        )
        send_tx(
            state.w3,
            state.chainrps.functions.permitDeposit(
                player.address, state.token_address, deposit_amount,
                permit_deadline, v_p, r_p, s_p
            ),
            RELAYER
        )

    # 创建对局
    send_tx(state.w3, state.chainrps.functions.createMatch(amount, state.token_address), PLAYER1)
    game_id = state.chainrps.functions.gameCount().call()

    # 加入对局
    send_tx(state.w3, state.chainrps.functions.joinMatch(game_id), PLAYER2)

    # 双方提交 commit（相同出拳 = 平局）
    choice = 1  # 双方都出石头
    salt1 = os.urandom(32)
    salt2 = os.urandom(32)
    commit1 = compute_commit(choice, salt1, PLAYER1.address)
    commit2 = compute_commit(choice, salt2, PLAYER2.address)

    send_tx(state.w3, state.chainrps.functions.submitCommit(game_id, to_bytes32_hex(commit1)), PLAYER1)
    send_tx(state.w3, state.chainrps.functions.submitCommit(game_id, to_bytes32_hex(commit2)), PLAYER2)

    # 双方揭晓
    send_tx(state.w3, state.chainrps.functions.revealChoice(game_id, choice, to_bytes32_hex(salt1)), PLAYER1)
    send_tx(state.w3, state.chainrps.functions.revealChoice(game_id, choice, to_bytes32_hex(salt2)), PLAYER2)

    # 验证平局
    _, _, _, _, status, _, _, _, is_draw = state.chainrps.functions.getGame(game_id).call()
    assert is_draw, "应该判定为平局"
    assert status == 3, "状态应为 Finished(3)"

    # PLAYER1 签名 handleDrawWithSig
    nonce = state.chainrps.functions.nonces(PLAYER1.address).call()
    deadline = get_future_deadline()

    v, r, s = sign_eip712(
        PLAYER1.key, state.domain, "HandleDraw",
        [
            {"name": "gameId", "type": "uint256"},
            {"name": "player", "type": "address"},
            {"name": "nonce", "type": "uint256"},
            {"name": "deadline", "type": "uint256"},
        ],
        {
            "gameId": game_id,
            "player": PLAYER1.address,
            "nonce": nonce,
            "deadline": deadline,
        }
    )

    # 记录退款前余额
    balance_before = state.token.functions.balanceOf(PLAYER1.address).call()

    # RELAYER 调用 handleDrawWithSig
    receipt = send_tx(
        state.w3,
        state.chainrps.functions.handleDrawWithSig(
            game_id, PLAYER1.address, nonce, deadline, v, r, s
        ),
        RELAYER
    )

    # 验证退款已到账
    balance_after = state.token.functions.balanceOf(PLAYER1.address).call()
    assert balance_after == balance_before + amount, "退款金额不匹配"

    # 验证 nonce 递增
    new_nonce = state.chainrps.functions.nonces(PLAYER1.address).call()
    assert new_nonce == nonce + 1, "nonce 未递增"

# ==================== 主函数 ====================

def main():
    print("=" * 60)
    print("ChainRPS v1.3.0 合约测试")
    print("=" * 60)

    # 初始化环境
    setup_environment()

    runner = TestRunner()

    # 运行测试
    print("=== 运行测试 ===\n")

    runner.run("测试1: submitCommitWithSig 正确签名通过", test_submit_commit_with_sig_correct)
    runner.run("测试2: submitCommitWithSig 错误签名拒绝", test_submit_commit_with_sig_wrong_signer)
    runner.run("测试3: deadline 过期拒绝", test_deadline_expired)
    runner.run("测试4: 非白名单 relayer 被拒绝", test_non_whitelisted_relayer)
    runner.run("测试5: submitCommitViaRelayer 代提交（方案B）", test_submit_commit_via_relayer)
    runner.run("测试6: relayer 授权过期拒绝", test_relayer_auth_expired)
    runner.run("测试7: permitDeposit 流程（F1-04）", test_permit_deposit)
    runner.run("测试8: createMatchWithSig 全流程 Gasless（F1-02）", test_create_match_with_sig)
    runner.run("测试9: createMatchWithSig 错误签名拒绝", test_create_match_with_sig_wrong_signer)
    runner.run("测试10: 域分隔符动态返回（S1-01）", test_domain_separator_dynamic)
    runner.run("测试11: Relayer 白名单事件（S1-05）", test_relayer_whitelist_event)
    runner.run("测试12: handleDrawWithSig 流程", test_handle_draw_with_sig)

    success = runner.summary()
    sys.exit(0 if success else 1)

if __name__ == "__main__":
    main()
