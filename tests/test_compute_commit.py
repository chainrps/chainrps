"""
F1-14 测试：验证 compute_commit 修复后的哈希与合约
keccak256(abi.encodePacked(choice, salt, sender)) 一致。

运行：pytest tests/test_compute_commit.py -v
"""
import importlib.util
import os
import sys
from pathlib import Path

import pytest
from web3 import Web3

PROJECT_ROOT = Path(__file__).resolve().parent.parent


def _load_compute_commit():
    """从项目根目录的 test_game_flow.py 动态导入 compute_commit 函数。

    test_game_flow.py 顶层会在 __main__ 时运行集成测试，
    此处仅导入模块（不执行 __main__ 块），拿到 compute_commit 即可。
    """
    module_path = PROJECT_ROOT / "test_game_flow.py"
    spec = importlib.util.spec_from_file_location("test_game_flow", module_path)
    module = importlib.util.module_from_spec(spec)
    # 把项目根目录加入 sys.path，确保 test_game_flow.py 内的 import 能解析
    if str(PROJECT_ROOT) not in sys.path:
        sys.path.insert(0, str(PROJECT_ROOT))
    spec.loader.exec_module(module)
    return module.compute_commit


compute_commit = _load_compute_commit()

# 测试用固定数据
PLAYER = "0x7F72A2777539913086a5f2d5914F35a742F827FD"
SALT = "0x" + "11" * 32  # 32 字节 bytes32


def _expected_hash(choice_uint8, salt_hex, address):
    """用 web3.py 的 solidity_keccak 作为独立参考实现（等价于 keccak256(abi.encodePacked(...))）。"""
    salt_bytes = bytes.fromhex(salt_hex[2:])
    # web3.py v6: Web3.solidity_keccak(abi_types, values) 位置参数
    raw = Web3.solidity_keccak(
        ["uint8", "bytes32", "address"],
        [choice_uint8, salt_bytes, Web3.to_checksum_address(address)],
    )
    # 统一返回 0x 前缀的小写 hex
    return "0x" + raw.hex()


def _norm(h):
    """统一为 0x 前缀小写 hex。"""
    h = h.lower()
    return h if h.startswith("0x") else "0x" + h


class TestComputeCommit:
    """验证 compute_commit 输出与合约 keccak256(abi.encodePacked(...)) 一致。"""

    def test_accepts_numeric_choice(self):
        """choice 接受数字 1/2/3。"""
        for choice in (1, 2, 3):
            h = compute_commit(choice, SALT, PLAYER)
            assert h.startswith("0x") and len(h) == 66, f"哈希格式错误: {h}"

    def test_accepts_string_choice_backward_compat(self):
        """choice 兼容字符串 'rock'/'paper'/'scissors'。"""
        mapping = {"rock": 1, "paper": 2, "scissors": 3}
        for name, num in mapping.items():
            h_str = compute_commit(name, SALT, PLAYER)
            h_num = compute_commit(num, SALT, PLAYER)
            assert h_str == h_num, f"字符串与数字结果不一致: {name}"

    def test_matches_solidity_keccak_rock(self):
        """rock(1) 的哈希与 solidityKeccak 一致。"""
        h = compute_commit(1, SALT, PLAYER)
        expected = _expected_hash(1, SALT, PLAYER)
        assert _norm(h) == _norm(expected)

    def test_matches_solidity_keccak_all_choices(self):
        """所有出拳(1/2/3)的哈希都与 solidityKeccak 一致。"""
        for choice in (1, 2, 3):
            h = compute_commit(choice, SALT, PLAYER)
            expected = _expected_hash(choice, SALT, PLAYER)
            assert _norm(h) == _norm(expected), f"choice={choice} 哈希不匹配"

    def test_known_fixed_hash(self):
        """固定输入产生固定哈希（回归基线）。"""
        h = compute_commit(1, SALT, PLAYER)
        expected = _expected_hash(1, SALT, PLAYER)
        assert _norm(h) == _norm(expected)
        # 哈希应为 32 字节（64 hex + 0x）
        assert len(_norm(h)) == 66

    def test_different_choices_produce_different_hashes(self):
        """不同出拳产生不同哈希。"""
        h1 = compute_commit(1, SALT, PLAYER)
        h2 = compute_commit(2, SALT, PLAYER)
        h3 = compute_commit(3, SALT, PLAYER)
        assert h1 != h2 != h3 != h1

    def test_different_salt_produces_different_hash(self):
        """不同 salt 产生不同哈希。"""
        salt_a = "0x" + "aa" * 32
        salt_b = "0x" + "bb" * 32
        assert compute_commit(1, salt_a, PLAYER) != compute_commit(1, salt_b, PLAYER)

    def test_different_player_produces_different_hash(self):
        """不同玩家地址产生不同哈希。"""
        player2 = "0xdE227eDB80A7c81C6bc3336F43247968AAbd1223"
        assert compute_commit(1, SALT, PLAYER) != compute_commit(1, SALT, player2)

    def test_invalid_choice_raises(self):
        """非法出拳抛出 ValueError。"""
        with pytest.raises(ValueError):
            compute_commit(0, SALT, PLAYER)
        with pytest.raises(ValueError):
            compute_commit(4, SALT, PLAYER)

    def test_invalid_salt_length_raises(self):
        """非 32 字节 salt 抛出 ValueError。"""
        bad_salt = "0x" + "11" * 16  # 只有 16 字节
        with pytest.raises(ValueError):
            compute_commit(1, bad_salt, PLAYER)

    def test_keccak_not_sha3_256(self):
        """确保使用的是 keccak256（而非 SHA3-256，二者结果不同）。"""
        import hashlib
        choice_uint8 = 1
        salt_bytes = bytes.fromhex(SALT[2:])
        addr_bytes = Web3.to_bytes(hexstr=PLAYER)
        packed = bytes([choice_uint8]) + salt_bytes + addr_bytes

        sha3_256_hash = hashlib.sha3_256(packed).hexdigest()
        keccak_hash = compute_commit(1, SALT, PLAYER)

        # keccak256 与 SHA3-256 不同（padding 不同），二者不应相等
        assert _norm("0x" + sha3_256_hash) != _norm(keccak_hash), \
            "compute_commit 似乎使用了 SHA3-256 而非 keccak256！"
