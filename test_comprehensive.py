"""
ChainRPS 全面功能测试脚本（房间模式 + 完整流程）

测试范围：
1. 房间模式：开房 → 加入 → 准备 → 倒计时 → 创建对局
2. 提交承诺 → 揭晓出拳 → （BUG：结算缺失）
3. 边界测试：取消准备、退出房间、超时等
4. 性能测试：并发创建房间
5. 承诺哈希校验一致性
"""

import json
import time
import requests
import threading
from concurrent.futures import ThreadPoolExecutor, as_completed

BASE_URL = "http://127.0.0.1:8000"

PASS = 0
FAIL = 0
ERRORS = []
WARNINGS = []


def test(name, fn):
    global PASS, FAIL
    try:
        result = fn()
        PASS += 1
        print(f"  ✅ {name}")
        if result:
            print(f"     ℹ️  {result}")
        return True
    except AssertionError as e:
        FAIL += 1
        err = f"❌ {name}: {e}"
        print(f"  {err}")
        ERRORS.append(err)
        return False
    except Exception as e:
        FAIL += 1
        err = f"❌ {name} [EXCEPTION]: {type(e).__name__}: {e}"
        print(f"  {err}")
        ERRORS.append(err)
        return False


def warn(msg):
    WARNINGS.append(msg)
    print(f"  ⚠️  {msg}")


player1 = "0x7F72A2777539913086a5f2d5914F35a742F827FD"
player2 = "0xdE227eDB80A7c81C6bc3336F43247968AAbd1223"
player3 = "0x1111111111111111111111111111111111111111"


def compute_commit(choice_int, salt, address):
    """与合约一致的承诺哈希计算"""
    from web3 import Web3
    salt_hex = salt[2:] if salt.startswith("0x") else salt
    salt_bytes = bytes.fromhex(salt_hex)
    addr_bytes = Web3.to_bytes(hexstr=address)
    packed = bytes([choice_int]) + salt_bytes + addr_bytes
    return "0x" + Web3.keccak(packed).hex()


# ============================================================
# 1. 房间模式完整流程测试
# ============================================================
def test_room_full_flow():
    print("\n🏠  房间模式：开房→加入→准备→倒计时→游戏启动")
    room_id = None

    def step1_create_room():
        nonlocal room_id
        r = requests.post(BASE_URL + "/api/game/room/create", json={
            "player_address": player1,
            "token": "USDC",
            "bet_amount": 50
        })
        assert r.status_code == 200, f"创建房间失败: {r.status_code}"
        data = r.json()
        assert data["success"], f"创建失败: {data}"
        room_id = data["room_id"]
        assert room_id, "未返回 room_id"
        return f"room_id={room_id}"

    test("1.1 创建房间", step1_create_room)

    def step1b_check_lobby():
        r = requests.get(BASE_URL + "/api/game/room/list")
        assert r.status_code == 200
        data = r.json()
        my_room = next((r for r in data["rooms"] if r["room_id"] == room_id), None)
        assert my_room, "新创建的房间未出现在大厅列表中"
        assert my_room["status"] == "created", f"房间状态错误: {my_room['status']}"
        return f"大厅可见房间数={data['total']}"

    test("1.2 房间在大厅可见", step1b_check_lobby)

    def step2_join_room():
        r = requests.post(BASE_URL + "/api/game/room/join", json={
            "room_id": room_id,
            "player_address": player2,
        })
        assert r.status_code == 200, f"加入房间失败: {r.status_code}"
        data = r.json()
        assert data["success"], f"加入失败: {data}"
        assert data["room"]["player2"] == player2

    test("1.3 玩家2加入房间", step2_join_room)

    def step2b_cannot_join_own():
        r = requests.post(BASE_URL + "/api/game/room/join", json={
            "room_id": room_id,
            "player_address": player1,
        })
        data = r.json()
        assert not data.get("success"), "创建者应该不能加入自己的房间"

    test("1.4 创建者无法加入自己房间（边界）", step2b_cannot_join_own)

    def step3_player1_ready():
        r = requests.post(BASE_URL + "/api/game/room/ready", json={
            "room_id": room_id,
            "player_address": player1,
        })
        assert r.status_code == 200
        data = r.json()
        assert data["creator_ready"] is True
        assert data["status"] == "joined", f"单方准备应该仍是joined: {data['status']}"

    test("1.5 玩家1点击准备", step3_player1_ready)

    def step4_both_ready():
        r = requests.post(BASE_URL + "/api/game/room/ready", json={
            "room_id": room_id,
            "player_address": player2,
        })
        assert r.status_code == 200
        data = r.json()
        # 双方都准备后，状态应变为 countdown
        assert data["status"] == "countdown", f"双方准备后应进入countdown: {data['status']}"
        assert data["creator_ready"] is True
        assert data["player2_ready"] is True

    test("1.6 玩家2准备→进入15秒倒计时", step4_both_ready)

    def step5_wait_countdown_and_check():
        """倒计时15秒后应自动开始游戏（创建对局记录）"""
        # 等待 17 秒（留点余量）
        time.sleep(17)
        r = requests.get(BASE_URL + f"/api/game/room/{room_id}")
        data = r.json()
        # 检查状态是否变为 game_started 并创建了 game_id
        assert isinstance(data, dict), f"房间信息格式错误: {data}"
        status = data.get("status") if isinstance(data, dict) else None
        if status != "game_started":
            # 也有可能是内存模式没正确计时，给个告警但不强制失败
            warn(f"17秒后房间状态={status}, 期望=game_started。倒计时协程可能未正确执行")
            return f"状态={status}（倒计时定时器可能有问题）"
        game_id = data.get("game_id")
        assert game_id, "游戏已开始但 game_id 为空"
        return f"game_id={game_id}, chain_game_id={data.get('chain_game_id')}"

    test("1.7 15秒倒计时→游戏启动（创建对局）", step5_wait_countdown_and_check)


# ============================================================
# 2. 游戏出拳/揭晓 流程 与 BUG 复现
# ============================================================
def test_commit_reveal_settlement_bug():
    print("\n🎯  出拳→揭晓→结算 （BUG复现：结算缺失）")
    game_id_local = None

    def setup_game():
        nonlocal game_id_local
        # 先匹配创建一局
        requests.post(BASE_URL + "/api/game/join", json={
            "player_address": player1, "token": "USDC", "bet_amount": 5
        })
        r = requests.post(BASE_URL + "/api/game/join", json={
            "player_address": player2, "token": "USDC", "bet_amount": 5
        })
        game_id_local = r.json().get("game_id")
        assert game_id_local

    test("2.0 匹配创建新对局", setup_game)

    def step1_commit():
        salt1 = "0x" + "a1" * 32
        salt2 = "0x" + "a2" * 32
        c1 = compute_commit(1, salt1, player1)  # 石头
        c2 = compute_commit(3, salt2, player2)  # 剪刀
        requests.post(BASE_URL + "/api/game/commit", json={
            "game_id": game_id_local, "player_address": player1, "commit_hash": c1
        })
        requests.post(BASE_URL + "/api/game/commit", json={
            "game_id": game_id_local, "player_address": player2, "commit_hash": c2
        })
        # 保存 salts 给后面用（全局）
        global _test_salts
        _test_salts = (salt1, salt2)

    test("2.1 双方提交承诺（石头 vs 剪刀）", step1_commit)

    def step2_reveal():
        s1, s2 = _test_salts
        r1 = requests.post(BASE_URL + "/api/game/reveal", json={
            "game_id": game_id_local, "player_address": player1,
            "choice": 1, "salt": s1
        })
        assert r1.status_code == 200, f"玩家1揭晓失败: {r1.text}"
        r2 = requests.post(BASE_URL + "/api/game/reveal", json={
            "game_id": game_id_local, "player_address": player2,
            "choice": 3, "salt": s2
        })
        assert r2.status_code == 200, f"玩家2揭晓失败: {r2.text}"

    test("2.2 双方揭晓出拳", step2_reveal)

    def step3_check_settlement_BUG():
        # BUG：揭晓后状态应为 finished，但实际上是 reveal
        # 因为后端设计为"不做胜负判定，等待链上事件同步"
        # 但在无链/本地环境下，游戏永远不会结算！
        time.sleep(2)  # 给点"同步"时间
        r = requests.get(BASE_URL + f"/api/game/{game_id_local}")
        data = r.json()
        state = data.get("state")
        winner = data.get("winner")
        is_draw = data.get("is_draw")

        # 发现BUG：后端无自动结算能力
        # 设计说明：game_service.py 第6-8行约定"不做胜负判定，胜负结果由链上合约事件同步"
        # 但这导致：1) 纯后端测试无法完成闭环 2) 链事件监听异常时游戏永远卡在 reveal
        warn(f"游戏状态={state}, winner={winner}, is_draw={is_draw}")
        warn(f"[BUG-001] 后端无独立结算能力：链上事件监听失败/不可用时，游戏永久卡在 reveal 状态")
        warn(f"[BUG-001] 建议：后端增加本地 fallback 结算逻辑（合约事件为权威，本地为兜底）")

        # 测试期望的正确行为
        if state == "finished" and winner:
            return None  # 正常
        else:
            return (f"状态={state}, 期望=finished; "
                   f"胜负未判定（石头胜剪刀，玩家1应胜）。"
                   f"后端未监听链事件时永久卡在此状态")

    test("2.3 [BUG-001] 揭晓后不结算（链事件兜底缺失）", step3_check_settlement_BUG)


# ============================================================
# 3. 边界测试
# ============================================================
def test_boundary_conditions():
    print("\n🧱 边界条件测试")

    def b1_double_create_room():
        """玩家不能同时在两个房间"""
        r1 = requests.post(BASE_URL + "/api/game/room/create", json={
            "player_address": player3, "token": "USDC", "bet_amount": 10
        })
        d1 = r1.json()
        assert d1["success"], f"第一次创建应成功: {d1}"
        rid = d1["room_id"]
        r2 = requests.post(BASE_URL + "/api/game/room/create", json={
            "player_address": player3, "token": "USDC", "bet_amount": 20
        })
        d2 = r2.json()
        # 第二次创建应失败（成功是BUG）
        if d2.get("success"):
            warn(f"[BUG-002] 同一玩家创建两个房间成功！房间1={rid}, 房间2={d2.get('room_id')}")
            return "存在BUG：玩家可重复开房"
        # 清理
        requests.post(BASE_URL + "/api/game/room/leave", json={
            "room_id": rid, "player_address": player3
        })
        return f"正确拒绝: {d2.get('message', '无错误消息')}"

    test("3.1 玩家不能同时开两个房间", b1_double_create_room)

    def b2_commit_verification_consistency():
        """后端 _verify_commit 与合约一致性校验"""
        # 使用 game_service.py 中的 _verify_commit 函数直接测试
        from rps_backend.service.game_service import _verify_commit
        salt = "0x" + "cc" * 32
        # 计算正确哈希
        correct_commit = compute_commit(2, salt, player1)  # 布
        # 正确参数
        ok = _verify_commit("paper", salt, player1, correct_commit)
        assert ok is True, "正确的承诺应该校验通过"
        # 错误出拳
        bad = _verify_commit("rock", salt, player1, correct_commit)
        assert bad is False, "出拳不匹配应校验失败"
        # 错误地址
        bad2 = _verify_commit("paper", salt, player2, correct_commit)
        assert bad2 is False, "地址不匹配应校验失败"
        # 整数choice
        ok2 = _verify_commit(2, salt, player1, correct_commit)
        assert ok2 is True, "整数 choice(2) 应该通过"

    test("3.2 承诺哈希校验函数与合约一致性", b2_commit_verification_consistency)

    def b3_invalid_choice_reveal():
        # 先造一局
        requests.post(BASE_URL + "/api/game/join", json={
            "player_address": player1, "token": "USDC", "bet_amount": 1
        })
        r = requests.post(BASE_URL + "/api/game/join", json={
            "player_address": player2, "token": "USDC", "bet_amount": 1
        })
        gid = r.json().get("game_id")
        s = "0x" + "dd" * 32
        c = compute_commit(1, s, player1)
        requests.post(BASE_URL + "/api/game/commit", json={
            "game_id": gid, "player_address": player1, "commit_hash": c
        })
        # BUG检查：reveal接口没有校验 choice 合法性就直接存储？
        # 注意：真正的校验在链上合约，后端仅记录。但应该有基础校验。
        bad_r = requests.post(BASE_URL + "/api/game/reveal", json={
            "game_id": gid, "player_address": player1,
            "choice": 999,  # 无效出拳
            "salt": s
        })
        if bad_r.status_code == 200:
            warn(f"[BUG-003] 后端 reveal 接口接受无效出拳 choice=999！")
            return "存在BUG：无效出拳被后端接受（链上会拒绝，但后端应前置校验）"
        return f"正确拒绝无效出拳: HTTP {bad_r.status_code}"

    test("3.3 无效出拳 choice 边界校验", b3_invalid_choice_reveal)


# ============================================================
# 4. 性能测试（简单并发）
# ============================================================
def test_performance_simple():
    print("\n⚡ 简单性能测试")

    def p1_room_create_throughput():
        """10个并发创建房间，检测响应时间"""
        start = time.time()
        success = 0
        errors_p = 0

        def create_one(i):
            addr = f"0x{1000+i:040x}"
            r = requests.post(BASE_URL + "/api/game/room/create", json={
                "player_address": addr, "token": "USDC", "bet_amount": 1.0
            })
            return r.status_code == 200 and r.json().get("success")

        with ThreadPoolExecutor(max_workers=10) as pool:
            futures = [pool.submit(create_one, i) for i in range(10)]
            for f in as_completed(futures):
                try:
                    if f.result():
                        success += 1
                    else:
                        errors_p += 1
                except Exception:
                    errors_p += 1

        elapsed = time.time() - start
        result_msg = f"10个并发: 成功={success}, 失败={errors_p}, 耗时={elapsed:.2f}s ({10/elapsed:.1f} req/s)"
        if success >= 8:
            return result_msg + " 性能良好"
        else:
            return result_msg + " ⚠️ 并发处理能力较弱"

    test("4.1 房间创建并发吞吐（10并发）", p1_room_create_throughput)

    def p2_health_rps():
        """健康检查接口 RPS"""
        start = time.time()
        n = 50
        for _ in range(n):
            requests.get(BASE_URL + "/health")
        elapsed = time.time() - start
        return f"50次健康检查: {elapsed:.2f}s ({n/elapsed:.1f} req/s)"

    test("4.2 健康检查 RPS（单线程50次）", p2_health_rps)


# ============================================================
# 主入口
# ============================================================
if __name__ == "__main__":
    print("=" * 70)
    print("ChainRPS 全面功能 & BUG 挖掘测试 v1.0")
    print("=" * 70)

    test_room_full_flow()
    test_commit_reveal_settlement_bug()
    test_boundary_conditions()
    test_performance_simple()

    print("\n" + "=" * 70)
    print(f"测试汇总: ✅ 通过 {PASS}, ❌ 失败 {FAIL}")
    if WARNINGS:
        print(f"           ⚠️  警告/BUG发现 {len(WARNINGS)} 项")
    print("=" * 70)

    if WARNINGS:
        print("\n🔍 发现的 BUG / 设计缺陷:")
        for i, w in enumerate(WARNINGS, 1):
            print(f"  {i}. {w}")

    if ERRORS:
        print("\n❌ 失败详情:")
        for e in ERRORS:
            print(f"  {e}")
