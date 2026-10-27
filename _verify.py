import py_compile
files = [
    'rps_backend/config/__init__.py',
    'rps_backend/config/room_states.py',
    'rps_backend/models/__init__.py',
    'rps_backend/main.py',
    'rps_backend/api/endpoints/auth.py',
    'rps_backend/api/endpoints/game.py',
    'rps_backend/service/room_service.py',
    'rps_backend/service/game_service.py',
    'rps_backend/service/bot_service.py',
]
for f in files:
    py_compile.compile(f, doraise=True)
    print(f'  OK  {f}')

from rps_backend.config import ROOM_STATUS, TERMINAL_STATES, PRE_GAME_STATES, LOBBY_VISIBLE_STATES
from rps_backend.service.room_service import room_manager
from rps_backend.service.game_service import game_manager
from rps_backend.service.bot_service import bot_service
from rps_backend.models import CreateRoomRequest, JoinRoomRequest

# GAP-01 验证
assert hasattr(game_manager, 'start_commit_timeout_timer')
assert hasattr(game_manager, 'start_reveal_timeout_timer')
assert hasattr(room_manager, 'mark_game_finished')

# 状态常量验证
assert TERMINAL_STATES == {'closed', 'finished'}
assert hasattr(game_manager, '_commit_timeout_timers')

# validator 验证
try:
    CreateRoomRequest(token='POL', bet_amount=0, player_address='0xAbc1234567890123456789012345678901234567')
    assert False, 'should have raised'
except Exception:
    pass

try:
    CreateRoomRequest(token='POL', bet_amount=10, player_address='badaddress')
    assert False, 'should have raised'
except Exception:
    pass

r = CreateRoomRequest(token='POL', bet_amount=10.5, player_address='0xABC1234567890123456789012345678901234567')
assert r.player_address == '0xabc1234567890123456789012345678901234567'

print()
print('======================================')
print('ALL CHECKS PASSED')
print('======================================')
print(f'  ROOM_STATUS keys: {list(ROOM_STATUS.keys())}')
gm_methods = [m for m in dir(game_manager) if not m.startswith('_')]
print(f'  GAME_MANAGER methods: {gm_methods}')
print(f'  mark_game_finished: {hasattr(room_manager, "mark_game_finished")}')