"""
F1-16: _verify_commit 修复后的哈希计算单元测试

验证：
- 与合约 keccak256(abi.encodePacked(choice, salt, player)) 一致
- choice 接受 int 1/2/3 或字符串 "rock"/"paper"/"scissors"
- salt 必须是 32 字节 hex
- address 必须是 20 字节 hex
- 不再使用 sha3_256 + 字符串拼接
"""
import os
import pytest

# 使用 web3.py 的 keccak 作为参考实现，验证我们的实现与合约一致
# 合约：bytes32 commit = keccak256(abi.encodePacked(choice, salt, player));
# - choice: uint8 (1 byte)
# - salt: bytes32 (32 bytes)
# - player: address (20 bytes)


def _expected_commit(choice_int: int, salt_bytes: bytes, addr_bytes: bytes) -> str:
    """独立计算的参考哈希，模拟 Solidity abi.encodePacked"""
    from web3 import Web3
    packed = bytes([choice_int]) + salt_bytes + addr_bytes
    return "0x" + Web3.keccak(packed).hex()


def test_verify_commit_matches_contract_algorithm():
    """核心测试：_verify_commit 计算结果应与合约算法一致"""
    from rps_backend.service.game_service import _verify_commit

    choice_int = 1  # rock
    salt_bytes = bytes(range(32))  # 0x000102...1f
    addr_bytes = bytes.fromhex("11" * 20)  # 0x1111...1111

    salt_hex = "0x" + salt_bytes.hex()
    addr_hex = "0x" + addr_bytes.hex()
    expected = _expected_commit(choice_int, salt_bytes, addr_bytes)

    # choice 传 int
    assert _verify_commit(choice_int, salt_hex, addr_hex, expected) is True
    # choice 传 字符串 "rock"
    assert _verify_commit("rock", salt_hex, addr_hex, expected) is True
    # choice 传 字符串 "1"
    assert _verify_commit("1", salt_hex, addr_hex, expected) is True


def test_verify_commit_all_choices():
    """三种出拳都能正确计算"""
    from rps_backend.service.game_service import _verify_commit

    salt_bytes = bytes([0xaa] * 32)
    addr_bytes = bytes.fromhex("22" * 20)
    salt_hex = "0x" + salt_bytes.hex()
    addr_hex = "0x" + addr_bytes.hex()

    for choice_int, choice_name in [(1, "rock"), (2, "paper"), (3, "scissors")]:
        expected = _expected_commit(choice_int, salt_bytes, addr_bytes)
        assert _verify_commit(choice_int, salt_hex, addr_hex, expected) is True, \
            f"choice={choice_int} should match"
        assert _verify_commit(choice_name, salt_hex, addr_hex, expected) is True, \
            f"choice={choice_name} should match"


def test_verify_commit_wrong_choice_returns_false():
    """错误的 choice 应返回 False"""
    from rps_backend.service.game_service import _verify_commit

    salt_bytes = bytes(range(32))
    addr_bytes = bytes.fromhex("11" * 20)
    salt_hex = "0x" + salt_bytes.hex()
    addr_hex = "0x" + addr_bytes.hex()

    expected_for_rock = _expected_commit(1, salt_bytes, addr_bytes)
    # 用 rock 的 commit 去校验 paper，应失败
    assert _verify_commit(2, salt_hex, addr_hex, expected_for_rock) is False
    assert _verify_commit("paper", salt_hex, addr_hex, expected_for_rock) is False


def test_verify_commit_wrong_salt_returns_false():
    """错误的 salt 应返回 False"""
    from rps_backend.service.game_service import _verify_commit

    salt_bytes = bytes(range(32))
    wrong_salt_bytes = bytes([0xff] * 32)
    addr_bytes = bytes.fromhex("11" * 20)

    salt_hex = "0x" + salt_bytes.hex()
    wrong_salt_hex = "0x" + wrong_salt_bytes.hex()
    addr_hex = "0x" + addr_bytes.hex()

    expected = _expected_commit(1, salt_bytes, addr_bytes)
    assert _verify_commit(1, salt_hex, addr_hex, expected) is True
    assert _verify_commit(1, wrong_salt_hex, addr_hex, expected) is False


def test_verify_commit_wrong_address_returns_false():
    """错误的 address 应返回 False"""
    from rps_backend.service.game_service import _verify_commit

    salt_bytes = bytes(range(32))
    addr_bytes = bytes.fromhex("11" * 20)
    wrong_addr_bytes = bytes.fromhex("22" * 20)

    salt_hex = "0x" + salt_bytes.hex()
    addr_hex = "0x" + addr_bytes.hex()
    wrong_addr_hex = "0x" + wrong_addr_bytes.hex()

    expected = _expected_commit(1, salt_bytes, addr_bytes)
    assert _verify_commit(1, salt_hex, addr_hex, expected) is True
    assert _verify_commit(1, salt_hex, wrong_addr_hex, expected) is False


def test_verify_commit_invalid_choice_returns_false():
    """非法 choice（0, 4, 无效字符串）应返回 False"""
    from rps_backend.service.game_service import _verify_commit

    salt_hex = "0x" + "00" * 32
    addr_hex = "0x" + "11" * 20
    # 任意 commit_hash，重点是参数校验失败
    fake_hash = "0x" + "ab" * 32

    assert _verify_commit(0, salt_hex, addr_hex, fake_hash) is False
    assert _verify_commit(4, salt_hex, addr_hex, fake_hash) is False
    assert _verify_commit("invalid", salt_hex, addr_hex, fake_hash) is False
    assert _verify_commit(None, salt_hex, addr_hex, fake_hash) is False


def test_verify_commit_invalid_salt_length_returns_false():
    """salt 不是 32 字节应返回 False"""
    from rps_backend.service.game_service import _verify_commit

    addr_hex = "0x" + "11" * 20
    fake_hash = "0x" + "ab" * 32

    # 16 字节
    assert _verify_commit(1, "0x" + "00" * 16, addr_hex, fake_hash) is False
    # 33 字节
    assert _verify_commit(1, "0x" + "00" * 33, addr_hex, fake_hash) is False
    # 非法 hex
    assert _verify_commit(1, "0xGG" * 32, addr_hex, fake_hash) is False


def test_verify_commit_invalid_address_length_returns_false():
    """address 不是 20 字节应返回 False"""
    from rps_backend.service.game_service import _verify_commit

    salt_hex = "0x" + "00" * 32
    fake_hash = "0x" + "ab" * 32

    # 10 字节
    assert _verify_commit(1, salt_hex, "0x" + "11" * 10, fake_hash) is False
    # 21 字节
    assert _verify_commit(1, salt_hex, "0x" + "11" * 21, fake_hash) is False


def test_verify_commit_empty_inputs_returns_false():
    """空输入应返回 False"""
    from rps_backend.service.game_service import _verify_commit

    assert _verify_commit("", "", "", "") is False
    assert _verify_commit(1, "", "0x" + "11" * 20, "0x" + "ab" * 32) is False
    assert _verify_commit(1, "0x" + "00" * 32, "", "0x" + "ab" * 32) is False


def test_verify_commit_not_sha3_256():
    """验证不再使用 sha3_256 + 字符串拼接（与旧实现不同）"""
    import hashlib
    from rps_backend.service.game_service import _verify_commit

    choice = "rock"
    salt_hex = "0x" + bytes(range(32)).hex()
    addr_hex = "0x" + "11" * 20

    # 旧实现的哈希
    old_raw = f"{choice}{salt_hex}{addr_hex}"
    old_hash = "0x" + hashlib.sha3_256(old_raw.encode()).hexdigest()

    # 旧哈希不应通过新实现的校验
    assert _verify_commit(choice, salt_hex, addr_hex, old_hash) is False


def test_verify_commit_without_0x_prefix():
    """salt 和 address 不带 0x 前缀也能正确解析"""
    from rps_backend.service.game_service import _verify_commit

    salt_bytes = bytes(range(32))
    addr_bytes = bytes.fromhex("33" * 20)

    salt_hex_no_prefix = salt_bytes.hex()
    addr_hex_no_prefix = addr_bytes.hex()
    expected = _expected_commit(1, salt_bytes, addr_bytes)

    assert _verify_commit(1, salt_hex_no_prefix, addr_hex_no_prefix, expected) is True


def test_verify_commit_case_insensitive_hash():
    """commit_hash 大小写不敏感"""
    from rps_backend.service.game_service import _verify_commit

    salt_bytes = bytes(range(32))
    addr_bytes = bytes.fromhex("44" * 20)
    salt_hex = "0x" + salt_bytes.hex()
    addr_hex = "0x" + addr_bytes.hex()

    expected = _expected_commit(1, salt_bytes, addr_bytes)
    assert _verify_commit(1, salt_hex, addr_hex, expected.upper()) is True
    assert _verify_commit(1, salt_hex, addr_hex, expected.lower()) is True
