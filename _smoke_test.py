import requests, time, hashlib, json, sys, random

API = "http://127.0.0.1:8000/api/game"
import secrets
P1 = "0x" + secrets.token_hex(20)
P2 = "0x" + secrets.token_hex(20)

def h(s):
    return hashlib.sha256(s.encode()).hexdigest()[:40]

def check(name, ok, detail=""):
    icon = "OK " if ok else "FAIL"
    print(f"  [{icon}] {name}")
    if detail and not ok:
        print(f"       {str(detail)[:200]}")
    return ok

results = []
print("=" * 60)
print("ChainRPS Full Flow Smoke Test (localOnly)")
print(f"P1={P1}")
print(f"P2={P2}")
print("=" * 60)

# 1. create
print("\n[1] Create Room")
r = requests.post(f"{API}/room/create", json={
    "player_address": P1, "token": "USDC", "bet_amount": 10.0, "use_boost": False,
})
d = r.json()
room_id = d.get("room_id")
print(f"  -> {r.status_code}: {json.dumps(d, ensure_ascii=False)[:150]}")
results.append(check("create_room", r.ok and room_id, d))

if not room_id:
    print("\nFATAL: Cannot create room, aborting")
    sys.exit(1)

# 2. join
print("\n[2] Join Room")
r = requests.post(f"{API}/room/join", json={"room_id": room_id, "player_address": P2})
d = r.json()
print(f"  -> {r.status_code}: {json.dumps(d, ensure_ascii=False)[:150]}")
results.append(check("join_room", r.ok and d.get("success"), d))

# 3. ready P1
print("\n[3] Toggle Ready P1")
r = requests.post(f"{API}/room/ready", json={"room_id": room_id, "player_address": P1})
d = r.json()
print(f"  -> {r.status_code}: status={d.get('status')} c_ready={d.get('creator_ready')} p_ready={d.get('player2_ready')}")
results.append(check("ready_p1", r.ok and d.get("creator_ready") is True, d))

# 4. ready P2 (triggers countdown)
print("\n[4] Toggle Ready P2 (-> countdown)")
r = requests.post(f"{API}/room/ready", json={"room_id": room_id, "player_address": P2})
d = r.json()
print(f"  -> {r.status_code}: status={d.get('status')} c_ready={d.get('creator_ready')} p_ready={d.get('player2_ready')} countdown_start={d.get('countdown_start')}")
results.append(check("ready_p2 -> countdown", r.ok and d.get("status") == "countdown", d))

if d.get("status") != "countdown":
    print("\nFATAL: countdown not triggered! Aborting.")
    sys.exit(1)

# 5. wait 16s
print("\n[5] Waiting 16s for countdown + game start...")
time.sleep(16)

# 6. check room state
print("\n[6] Check Room State After Countdown")
r = requests.get(f"{API}/room/{room_id}")
room = r.json()
status = room.get("status")
game_id = room.get("game_id")
fund_stage = room.get("fund_stage")
print(f"  status={status}  game_id={game_id}  fund_stage={fund_stage}")
results.append(check("countdown -> GAME_STARTED",
                     status == "game_started" and game_id is not None,
                     f"status={status}, game_id={game_id}"))

if game_id:
    # 7. commit P1
    print(f"\n[7] Commit P1 (game_id={game_id})")
    r = requests.post(f"{API}/commit", json={
        "game_id": game_id, "player_address": P1,
        "commit_hash": h("rock_salt_12345"),
    })
    d = r.json()
    print(f"  -> {r.status_code}: {json.dumps(d)[:150]}")
    results.append(check("commit_p1", r.ok and d.get("success"), d))

    # 8. commit P2
    print(f"\n[8] Commit P2")
    r = requests.post(f"{API}/commit", json={
        "game_id": game_id, "player_address": P2,
        "commit_hash": h("paper_salt_67890"),
    })
    d = r.json()
    print(f"  -> {r.status_code}: {json.dumps(d)[:150]}")
    results.append(check("commit_p2", r.ok and d.get("success"), d))

    # 9. reveal P1
    print(f"\n[9] Reveal P1 (choice=rock)")
    r = requests.post(f"{API}/reveal", json={
        "game_id": game_id, "player_address": P1, "choice": "rock", "salt": "salt_12345",
    })
    d = r.json()
    print(f"  -> {r.status_code}: {json.dumps(d)[:150]}")
    results.append(check("reveal_p1", r.ok and d.get("success"), d))

    # 10. reveal P2
    print(f"\n[10] Reveal P2 (choice=paper)")
    r = requests.post(f"{API}/reveal", json={
        "game_id": game_id, "player_address": P2, "choice": "paper", "salt": "salt_67890",
    })
    d = r.json()
    print(f"  -> {r.status_code}: {json.dumps(d)[:150]}")
    results.append(check("reveal_p2", r.ok and d.get("success"), d))

# 11. wait for settlement
print("\n[11] Waiting 3s for localOnly settlement...")
time.sleep(3)

# 12. final room
print("\n[12] Final Room State")
r = requests.get(f"{API}/room/{room_id}")
room = r.json()
print(f"  status={room.get('status')}  fund_stage={room.get('fund_stage')}  close_reason={room.get('close_reason')}  winner={room.get('winner')}")
results.append(check("room -> FINISHED", room.get("status") == "finished", room))

# 13. leaderboard
print("\n[13] Leaderboard")
r = requests.get(f"{API}/leaderboard?limit=3")
results.append(check("leaderboard", r.ok))

# Summary
ok_count = sum(1 for x in results if x)
total = len(results)
print("\n" + "=" * 60)
print(f"RESULTS: {ok_count} OK / {total - ok_count} FAIL / {total} total")
if ok_count == total:
    print("ALL TESTS PASSED!")
else:
    print("SOME TESTS FAILED - see above")
print("=" * 60)

sys.exit(0 if ok_count == total else 1)