import json
import time
import requests

from web3 import Web3

BASE_URL = "http://127.0.0.1:8000"

PASS = 0
FAIL = 0
ERRORS = []


def test(name, fn):
    global PASS, FAIL
    try:
        fn()
        PASS += 1
        print(f"  ✅ {name}")
    except Exception as e:
        FAIL += 1
        err = f"❌ {name}: {e}"
        print(f"  {err}")
        ERRORS.append(err)


player1 = "0x7F72A2777539913086a5f2d5914F35a742F827FD"
player2 = "0xdE227eDB80A7c81C6bc3336F43247968AAbd1223"

# 出拳选项映射（与合约一致：1=石头, 2=布, 3=剪刀）
CHOICE_MAP = {"rock": 1, "paper": 2, "scissors": 3}


def compute_commit(choice, salt, address):
    """
    计算承诺哈希，与合约 keccak256(abi.encodePacked(choice, salt, player)) 一致。

    Args:
        choice: 出拳，数字 1/2/3（1=石头, 2=布, 3=剪刀）；兼容 "rock"/"paper"/"scissors" 字符串
        salt: 32 字节 hex 字符串（0x + 64 hex），即 bytes32
        address: 玩家地址（0x 开头的 20 字节地址）

    Returns:
        0x + 64 hex 的 bytes32 承诺哈希
    """
    # choice 统一为 uint8 (1/2/3)
    if isinstance(choice, str):
        choice_uint8 = CHOICE_MAP.get(choice.lower(), 0)
    else:
        choice_uint8 = int(choice)
    if choice_uint8 not in (1, 2, 3):
        raise ValueError(f"无效的出拳: {choice}（应为 1/2/3 或 rock/paper/scissors）")

    # salt 统一为 32 字节 bytes32
    salt_hex = salt[2:] if salt.startswith("0x") else salt
    salt_bytes = bytes.fromhex(salt_hex)
    if len(salt_bytes) != 32:
        raise ValueError(f"salt 必须为 32 字节（bytes32），当前 {len(salt_bytes)} 字节")

    # address 统一为 20 字节 canonical
    addr_bytes = Web3.to_bytes(hexstr=address)
    if len(addr_bytes) != 20:
        raise ValueError(f"地址长度异常: {address}")

    # abi.encodePacked(uint8, bytes32, address) = 1 + 32 + 20 = 53 bytes
    # 使用 web3.py 的 Web3.keccak（即 keccak256，与合约一致；注意 NOT SHA3-256）
    packed = bytes([choice_uint8]) + salt_bytes + addr_bytes
    return "0x" + Web3.keccak(packed).hex()


def test_full_game_flow():
    print("\n🎮 完整游戏流程测试")

    game_id = None

    def step1_join_match():
        nonlocal game_id
        r = requests.post(BASE_URL + "/api/game/join", json={
            "player_address": player1,
            "token": "USDC",
            "bet_amount": 10
        })
        assert r.status_code == 200, f"玩家1加入失败: {r.status_code}"

        r2 = requests.post(BASE_URL + "/api/game/join", json={
            "player_address": player2,
            "token": "USDC",
            "bet_amount": 10
        })
        assert r2.status_code == 200, f"玩家2加入失败: {r2.status_code}"
        data = r2.json()
        assert data.get("matched") is True, "未配对成功"
        game_id = data.get("game_id")
        assert game_id, "未返回 game_id"

    test("1. 双方加入匹配并配对成功", step1_join_match)

    def step2_get_game_info():
        r = requests.get(BASE_URL + f"/api/game/{game_id}")
        assert r.status_code == 200, f"获取对局失败: {r.status_code}"
        data = r.json()
        assert data["game_id"] == game_id
        assert data["state"] == "commit"

    test("2. 获取对局信息", step2_get_game_info)

    salt1 = "0x" + "11" * 32  # 32 字节 salt（与合约 bytes32 一致）
    salt2 = "0x" + "22" * 32
    choice1 = "rock"
    choice2 = "scissors"
    commit1 = compute_commit(choice1, salt1, player1)
    commit2 = compute_commit(choice2, salt2, player2)

    def step3_submit_commits():
        r1 = requests.post(BASE_URL + "/api/game/commit", json={
            "game_id": game_id,
            "player_address": player1,
            "commit_hash": commit1
        })
        assert r1.status_code == 200, f"玩家1提交失败: {r1.status_code}"

        r2 = requests.post(BASE_URL + "/api/game/commit", json={
            "game_id": game_id,
            "player_address": player2,
            "commit_hash": commit2
        })
        assert r2.status_code == 200, f"玩家2提交失败: {r2.status_code}"

    test("3. 双方提交哈希承诺", step3_submit_commits)

    def step4_reveal_choices():
        r1 = requests.post(BASE_URL + "/api/game/reveal", json={
            "game_id": game_id,
            "player_address": player1,
            "choice": choice1,
            "salt": salt1
        })
        assert r1.status_code == 200, f"玩家1揭晓失败: {r1.status_code}"

        r2 = requests.post(BASE_URL + "/api/game/reveal", json={
            "game_id": game_id,
            "player_address": player2,
            "choice": choice2,
            "salt": salt2
        })
        assert r2.status_code == 200, f"玩家2揭晓失败: {r2.status_code}"

    test("4. 双方揭晓出拳", step4_reveal_choices)

    def step5_verify_result():
        r = requests.get(BASE_URL + f"/api/game/{game_id}")
        assert r.status_code == 200
        data = r.json()
        assert data["state"] == "finished", f"游戏状态错误: {data['state']}"
        assert data["winner"] and data["winner"].lower() == player1.lower(), f"胜者错误: {data['winner']}"
        assert data["is_draw"] is False

    test("5. 验证游戏结果(玩家1获胜)", step5_verify_result)

    def step6_check_history():
        r = requests.get(BASE_URL + f"/api/history?address={player1}")
        assert r.status_code == 200
        data = r.json()
        assert data["total_games"] >= 1

    test("6. 验证历史记录", step6_check_history)

    def step7_check_stats():
        r = requests.get(BASE_URL + f"/api/player/{player1}/stats")
        assert r.status_code == 200
        data = r.json()
        assert data["wins"] >= 1

    test("7. 验证玩家统计", step7_check_stats)


def test_draw_flow():
    print("\n🤝 平局流程测试")

    game_id = None

    def step1_join():
        nonlocal game_id
        requests.post(BASE_URL + "/api/game/join", json={
            "player_address": player1, "token": "USDC", "bet_amount": 20
        })
        r = requests.post(BASE_URL + "/api/game/join", json={
            "player_address": player2, "token": "USDC", "bet_amount": 20
        })
        game_id = r.json()["game_id"]

    test("1. 加入匹配", step1_join)

    def step2_commit():
        salt1 = "0x" + "aa" * 32
        salt2 = "0x" + "bb" * 32
        commit = compute_commit("rock", salt1, player1)
        requests.post(BASE_URL + "/api/game/commit", json={
            "game_id": game_id, "player_address": player1, "commit_hash": commit
        })
        commit2 = compute_commit("rock", salt2, player2)
        requests.post(BASE_URL + "/api/game/commit", json={
            "game_id": game_id, "player_address": player2, "commit_hash": commit2
        })

    test("2. 提交相同出拳承诺", step2_commit)

    def step3_reveal():
        salt1 = "0x" + "aa" * 32
        salt2 = "0x" + "bb" * 32
        requests.post(BASE_URL + "/api/game/reveal", json={
            "game_id": game_id, "player_address": player1,
            "choice": "rock", "salt": salt1
        })
        requests.post(BASE_URL + "/api/game/reveal", json={
            "game_id": game_id, "player_address": player2,
            "choice": "rock", "salt": salt2
        })

    test("3. 揭晓相同出拳", step3_reveal)

    def step4_check_draw():
        r = requests.get(BASE_URL + f"/api/game/{game_id}")
        data = r.json()
        assert data["is_draw"] is True, f"应该是平局: {data}"
        assert data["state"] == "draw", f"状态应该是draw: {data['state']}"

    test("4. 验证平局状态", step4_check_draw)


if __name__ == "__main__":
    print("=" * 60)
    print("ChainRPS 游戏流程测试")
    print("=" * 60)

    test_full_game_flow()
    test_draw_flow()

    print("\n" + "=" * 60)
    print(f"测试结果: ✅ 通过 {PASS}, ❌ 失败 {FAIL}")
    print("=" * 60)

    if FAIL > 0:
        print("\n失败详情:")
        for e in ERRORS:
            print(f"  {e}")
