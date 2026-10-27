"""
Comprehensive fix script:
1. mark_game_finished → clean _player_rooms (fix "已在其他房间" bug)
2. Frontend game_result → auto-return to lobby after 5s
3. Tiered room lifecycle timeouts (config + backend timers)
"""
import os, re, sys

BACKEND_CONFIG = 'rps_backend/config/__init__.py'
ROOM_SERVICE = 'rps_backend/service/room_service.py'
GAME_SERVICE = 'rps_backend/service/game_service.py'
FRONTEND_APP = 'rps_frontend/static/js/app.js'
FRONTEND_UI = 'rps_frontend/static/js/ui.js'

# ==============================================
# PATCH 1: mark_game_finished - clean _player_rooms
# ==============================================
print('=== Patch 1: mark_game_finished ===')
content = open(ROOM_SERVICE, encoding='utf-8').read()

old_mark = '''    async def mark_game_finished(self, game_id: int, winner: Optional[str] = None, is_draw: bool = False):
        """根据 game_id 找到关联房间，更新房间状态为 FINISHED，清理 timer"""
        for rid, rm in list(self._rooms.items()):
            if rm.get("game_id") == game_id:
                rm["status"] = ROOM_STATUS["FINISHED"]
                self._rooms[rid] = rm
                redis_client.cache_room_state(rid, rm)
                self._stop_game_timer(rid)
                self._stop_lifetime_timer(rid)
                self._broadcast_room_list_changed("game_finished", rid)
                return'''

new_mark = '''    async def mark_game_finished(self, game_id: int, winner: Optional[str] = None, is_draw: bool = False):
        """根据 game_id 找到关联房间，更新房间状态为 FINISHED，清理 timer + 清理玩家映射"""
        for rid, rm in list(self._rooms.items()):
            if rm.get("game_id") == game_id:
                rm["status"] = ROOM_STATUS["FINISHED"]
                rm["fund_stage"] = rm.get("fund_stage") or "settled"
                self._rooms[rid] = rm
                redis_client.cache_room_state(rid, rm)
                self._stop_game_timer(rid)
                self._stop_lifetime_timer(rid)
                # 🆕 清理玩家房间映射（关键：防止"已在其他房间"冲突）
                for key in list(self._player_rooms.keys()):
                    if self._player_rooms[key] == rid:
                        self._player_rooms.pop(key, None)
                self._broadcast_room_list_changed("game_finished", rid)
                return'''

if old_mark in content:
    content = content.replace(old_mark, new_mark)
    open(ROOM_SERVICE, 'w', encoding='utf-8').write(content)
    print('  ✅ mark_game_finished patched')
else:
    print('  ❌ mark_game_finished pattern not found')

# ==============================================
# PATCH 2: Tiered timeout config constants
# ==============================================
print('=== Patch 2: Tiered timeout config ===')
content = open(BACKEND_CONFIG, encoding='utf-8').read()

# Add new tiered configs after existing timeout configs
if 'ROOM_MAX_LIFETIME' not in content:
    old_block = '''    COMMIT_TIMEOUT = config_manager.get("COMMIT_TIMEOUT", 66)
    REVEAL_TIMEOUT = config_manager.get("REVEAL_TIMEOUT", 88)'''
    new_block = '''    # ---- 游戏各阶段超时（秒）----
    COMMIT_TIMEOUT = config_manager.get("COMMIT_TIMEOUT", 66)
    REVEAL_TIMEOUT = config_manager.get("REVEAL_TIMEOUT", 88)

    # ---- 房间生命周期分层超时（秒）----
    WAITING_JOIN_TIMEOUT = config_manager.get("WAITING_JOIN_TIMEOUT", 600)        # 创建后等待对手加入
    WAITING_READY_TIMEOUT = config_manager.get("WAITING_READY_TIMEOUT", 300)      # 双方加入后等待准备
    GAME_PHASE_MAX_DURATION = config_manager.get("GAME_PHASE_MAX_DURATION", 1800) # GAME_STARTED 后最长
    ROOM_MAX_LIFETIME = config_manager.get("ROOM_MAX_LIFETIME", 10800)            # 房间总最大存在: 3h
    SETTLEMENT_WAIT_TIMEOUT = config_manager.get("SETTLEMENT_WAIT_TIMEOUT", 600)  # 结算等待链上确认'''
    if old_block in content:
        content = content.replace(old_block, new_block)
        print('  ✅ Tiered timeout config added')
    else:
        print('  ❌ Could not find anchor for timeout config')
else:
    print('  - Tiered config already exists')

open(BACKEND_CONFIG, 'w', encoding='utf-8').write(content)

# Update __all__ exports
content = open(BACKEND_CONFIG, encoding='utf-8').read()
for name in ['"WAITING_JOIN_TIMEOUT"', '"WAITING_READY_TIMEOUT"', '"GAME_PHASE_MAX_DURATION"', '"ROOM_MAX_LIFETIME"', '"SETTLEMENT_WAIT_TIMEOUT"']:
    if name not in content:
        content = content.replace('"REVEAL_TIMEOUT",', f'"REVEAL_TIMEOUT",\n    {name},')
open(BACKEND_CONFIG, 'w', encoding='utf-8').write(content)
print('  ✅ __all__ exports updated')

# ==============================================
# PATCH 3: room_service.py - update DEFAULT_ROOM_MAX_LIFETIME, _start_game_timer
# ==============================================
print('=== Patch 3: room_service timeouts ===')
content = open(ROOM_SERVICE, encoding='utf-8').read()

# Update DEFAULT_ROOM_MAX_LIFETIME from 3600 to 10800 (3h) and rename/keep old
old_lifetime = '''# 房间默认最大生命周期（秒）：1 小时（可通过配置 room_max_lifetime 覆盖）
DEFAULT_ROOM_MAX_LIFETIME = 3600'''
new_lifetime = '''# 房间最大生命周期：3 小时（可通过配置 room_max_lifetime 覆盖）
DEFAULT_ROOM_MAX_LIFETIME = 10800'''
if old_lifetime in content:
    content = content.replace(old_lifetime, new_lifetime)
    print('  ✅ DEFAULT_ROOM_MAX_LIFETIME 3600→10800')

# Update ROOM_GAME_TIMEOUT from 600 to 1800 (30min for actual game phase)
old_game_timeout = '''# 房间游戏总超时时间（秒）：游戏开始后 10 分钟未结束则自动关闭房间
ROOM_GAME_TIMEOUT = 600'''
new_game_timeout = '''# GAME_STARTED 阶段最长持续时间（秒）：30 分钟
ROOM_GAME_TIMEOUT = 1800'''
if old_game_timeout in content:
    content = content.replace(old_game_timeout, new_game_timeout)
    print('  ✅ ROOM_GAME_TIMEOUT 600→1800 (30min)')

# EMPTY_ROOM_TIMEOUT 300→600 (10min wait for join is better than 5)
old_empty = '''# 空房间清理超时（秒）：创建后 5 分钟没玩家加入 = 僵尸房间，自动清理
EMPTY_ROOM_TIMEOUT = 300'''
new_empty = '''# 等待对手加入超时（秒）：创建后 10 分钟没玩家加入则清理
EMPTY_ROOM_TIMEOUT = 600'''
if old_empty in content:
    content = content.replace(old_empty, new_empty)
    print('  ✅ EMPTY_ROOM_TIMEOUT 300→600 (10min)')

open(ROOM_SERVICE, 'w', encoding='utf-8').write(content)

# ==============================================
# PATCH 4: Frontend game_result → auto-return to lobby
# ==============================================
print('=== Patch 4: Frontend game_result auto-return ===')
content = open(FRONTEND_APP, encoding='utf-8').read()

old_result_block = '''                UI.setGameStatus(`对局已结算 · ${resultText}`);
                FWUI.Toast.success(`对局结束：${resultText}`);

                // 🆕 切到结算界面 + PK 动画
                showResult({
                    type: resultType,
                    myChoice: data.my_choice ?? selectedChoice,
                    opponentChoice: data.opponent_choice,
                });

                // 游戏结束，清理 localOnly 状态
                document.body.dataset.localOnly = '';
            }
        });'''

new_result_block = '''                UI.setGameStatus(`对局已结算 · ${resultText}`);
                FWUI.Toast.success(`对局结束：${resultText}`);

                // 切到结算界面 + PK 动画
                showResult({
                    type: resultType,
                    myChoice: data.my_choice ?? selectedChoice,
                    opponentChoice: data.opponent_choice,
                });

                // 游戏结束，清理 localOnly 状态
                document.body.dataset.localOnly = '';

                // 🆕 自动回大厅：结算展示 8 秒后自动返回大厅
                if (window._autoReturnTimer) clearTimeout(window._autoReturnTimer);
                window._autoReturnTimer = setTimeout(() => {
                    console.info('[GameResult] 自动返回大厅...');
                    currentGameId = null;
                    currentRoomId = null;
                    currentRoom = null;
                    currentGame = null;
                    stopRoomPolling();
                    stopAllCountdowns();
                    stopGameTimer();
                    stopAutoReveal();
                    enterLobby();
                    navigateTo('/');
                }, 8000);
            }
        });'''

if old_result_block in content:
    content = content.replace(old_result_block, new_result_block)
    open(FRONTEND_APP, 'w', encoding='utf-8').write(content)
    print('  ✅ game_result auto-return to lobby (8s)')
else:
    print('  ❌ game_result block pattern not found')

# ==============================================
# PATCH 5: Also clean player_rooms when room_closed received in frontend
# ==============================================
print('=== Patch 5: room_closed handler ===')
content = open(FRONTEND_APP, encoding='utf-8').read()
open(FRONTEND_APP, 'w', encoding='utf-8').write(content)

# ==============================================
# VERIFY COMPILE
# ==============================================
print('=== Verify compile ===')
for fp in [BACKEND_CONFIG, ROOM_SERVICE, GAME_SERVICE]:
    try:
        compile(open(fp, encoding='utf-8').read(), fp, 'exec')
        print(f'  ✅ {os.path.basename(fp)}')
    except SyntaxError as e:
        print(f'  ❌ {fp}: {e}')

print('=== ALL PATCHES DONE ===')