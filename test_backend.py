import requests

BASE_URL = "http://127.0.0.1:8000"

PASS = 0
FAIL = 0
ERRORS = []


def test(name, method, path, body=None, expected_status=200, check_fn=None):
    global PASS, FAIL
    url = BASE_URL + path
    try:
        if method == "GET":
            resp = requests.get(url, params=body if method == "GET" else None)
        elif method == "POST":
            resp = requests.post(url, json=body)
        elif method == "PUT":
            resp = requests.put(url, json=body)
        else:
            resp = requests.request(method, url, json=body)
        status = resp.status_code
        try:
            result = resp.json()
        except Exception:
            result = resp.text
    except Exception as e:
        status = -1
        result = {"error": str(e)}

    ok = status == expected_status
    if check_fn and ok:
        try:
            ok = check_fn(result)
        except Exception as e:
            ok = False
            result["check_error"] = str(e)

    if ok:
        PASS += 1
        print(f"  ✅ {name}")
    else:
        FAIL += 1
        err = f"❌ {name} - 状态码: {status}, 期望: {expected_status}"
        print(f"  {err}")
        if result:
            print(f"     响应: {str(result)[:300]}")
        ERRORS.append(err)


print("=" * 60)
print("ChainRPS 后端全面测试")
print("=" * 60)

print("\n📡 基础健康检查")
test("健康检查", "GET", "/health")
test("根路径", "GET", "/")
test("管理面板页面", "GET", "/admin")

print("\n👤 管理员接口")
test("管理员仪表盘", "GET", "/api/admin/dashboard")
test("合约列表", "GET", "/api/admin/contracts")
test("系统配置列表", "GET", "/api/admin/config")
test("审计日志", "GET", "/api/admin/audit-logs")

print("\n🎮 游戏接口")
player1 = "0x7F72A2777539913086a5f2d5914F35a742F827FD"
player2 = "0xdE227eDB80A7c81C6bc3336F43247968AAbd1223"

test(
    "玩家1加入匹配",
    "POST",
    "/api/game/join",
    {"player_address": player1, "token": "USDC", "bet_amount": 10},
)
test(
    "玩家2加入匹配(配对)",
    "POST",
    "/api/game/join",
    {"player_address": player2, "token": "USDC", "bet_amount": 10},
)

test(
    "查询匹配状态",
    "GET",
    f"/api/game/match/status/{player1}?token=USDC&bet_amount=10",
)

test(
    "取消匹配",
    "POST",
    "/api/game/cancel",
    {"player_address": player1, "token": "USDC", "bet_amount": 10},
)

print("\n👤 用户接口")
test(
    "获取用户偏好",
    "GET",
    f"/api/user/preferences/{player1}",
)
test(
    "更新用户偏好",
    "PUT",
    f"/api/user/preferences/{player1}",
    {"theme": "dark", "default_mode": "B"},
)

print("\n📊 历史记录接口")
test("历史记录", "GET", f"/api/history?address={player1}")
test("玩家统计", "GET", f"/api/player/{player1}/stats")
test("玩家对局列表", "GET", f"/api/player/{player1}/games")

print("\n🔧 扩展接口")
test("代币信息", "GET", "/api/ext/tokens")
test("游戏配置", "GET", "/api/ext/config")
test("排行榜", "GET", "/api/ext/leaderboard")

print("\n" + "=" * 60)
print(f"测试结果: ✅ 通过 {PASS}, ❌ 失败 {FAIL}")
print("=" * 60)

if FAIL > 0:
    print("\n失败详情:")
    for e in ERRORS:
        print(f"  {e}")
