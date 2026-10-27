import random, secrets, sys

filepath = 'rps_backend/service/game_service.py'
lines = open(filepath, encoding='utf-8').readlines()

new_forfeit = '''    async def _handle_local_timeout_random(self, game_id: int, phase: str, reason: str):
        game = get_game_record(game_id)
        if not game:
            return
        if game.get("state") in (GameState.FINISHED.value, GameState.CANCELLED.value):
            return

        player1 = game.get("player1")
        player2 = game.get("player2")
        bet_amount = game.get("bet_amount", 0.0) or 0.0
        auto_random = []

        updates = {}
        for idx, (addr, commit_f, choice_f, salt_f) in enumerate([
            (player1, 'commit1', 'choice1', 'salt1'),
            (player2, 'commit2', 'choice2', 'salt2'),
        ], start=1):
            if not addr:
                continue
            existing_choice = game.get(choice_f)
            if existing_choice is not None:
                continue
            choice_str, salt_hex, commit_hash = _generate_random_choice_and_commit(addr)
            updates[choice_f] = choice_str
            updates[salt_f] = salt_hex
            if not game.get(commit_f):
                updates[commit_f] = commit_hash
            auto_random.append(addr[:12])
            logger.warning(f"[Timeout] game_id={game_id} auto-assigned random choice={choice_str} to player{idx}={addr[:12]}")

        if updates:
            update_game_record(game_id, updates)

        latest_game = get_game_record(game_id)
        c1 = latest_game.get('choice1')
        c2 = latest_game.get('choice2')
        if c1 and c2:
            self.stop_commit_timeout_timer(game_id)
            self.stop_reveal_timeout_timer(game_id)

            c1_int = _CHOICE_NAME_TO_INT.get(c1, c1)
            c2_int = _CHOICE_NAME_TO_INT.get(c2, c2)
            result = _determine_rps_result(c1_int, c2_int, player1, player2)

            update_game_record(game_id, {
                'state': GameState.FINISHED.value,
                'winner': result.get('winner'),
                'is_draw': 1 if result.get('is_draw') else 0,
                'finished_at': datetime.utcnow().isoformat(),
                'settlement_source': 'local_timeout_random',
                'provisional': True,
            })

            try:
                if result.get('winner'):
                    update_player_stats(result['winner'], 'win', bet_amount)
                if not result.get('is_draw'):
                    loser_addr = player2 if result.get('winner') and result['winner'].lower() == (player1 or '').lower() else player1
                    if loser_addr:
                        update_player_stats(loser_addr, 'loss', bet_amount)
            except Exception as e:
                logger.warning(f'Failed to update stats after timeout random: {e}')

            winner = result.get('winner')
            is_draw = result.get('is_draw', False)
            try:
                await room_manager.mark_game_finished(game_id, winner, is_draw=is_draw)
            except Exception as e:
                logger.warning(f'Failed to mark game finished: {e}')

            for addr in [player1, player2]:
                if not addr:
                    continue
                my_choice = c1 if addr.lower() == (player1 or '').lower() else c2
                opp_choice = c2 if my_choice == c1 else c1
                await ws_manager.send_to_player(addr, WSMessage(
                    type='game_result',
                    data={
                        'game_id': game_id,
                        'winner': winner,
                        'is_draw': is_draw,
                        'my_choice': my_choice,
                        'opponent_choice': opp_choice,
                        'settlement_source': 'local_timeout_random',
                        'auto_random_choices': auto_random,
                        'reason': reason,
                    }
                ))
        else:
            logger.error(f'[Timeout] game_id={game_id} still missing choices after random fill: c1={c1} c2={c2}')
            update_game_record(game_id, {
                'state': GameState.FINISHED.value,
                'is_draw': 1,
                'finished_at': datetime.utcnow().isoformat(),
                'settlement_source': 'local_timeout_fallback_draw',
                'provisional': True,
            })
            self.stop_commit_timeout_timer(game_id)
            self.stop_reveal_timeout_timer(game_id)

        redis_client.delete_cached_game_state(game_id)

'''

start_idx = None
end_idx = None
for i, l in enumerate(lines):
    if 'async def _handle_local_timeout_forfeit' in l:
        start_idx = i
    elif start_idx is not None and 'async def submit_commit' in l:
        end_idx = i
        break

if start_idx is not None and end_idx is not None:
    lines[start_idx:end_idx] = new_forfeit.splitlines(keepends=True)
    open(filepath, 'w', encoding='utf-8').writelines(lines)
    print(f'Step 3 OK: replaced _handle_local_timeout_forfeit ({start_idx+1}-{end_idx})')
else:
    print(f'ERROR: start={start_idx} end={end_idx}')
    sys.exit(1)

# Step 4: Update timer calls (commit timer + reveal timer) - they pass forfeit, now pass reason
content = open(filepath, encoding='utf-8').read()

# commit timeout timer call
old1 = '''forfeiter = game.get("player1") if not p1_committed else game.get("player2")
            await self._handle_local_timeout_forfeit(
                game_id, "commit", forfeiter,
                reason=f"提交超时（COMMIT_TIMEOUT={config.COMMIT_TIMEOUT}s）"
            )'''
new1 = '''await self._handle_local_timeout_random(
                game_id, "commit",
                reason=f"提交超时（COMMIT_TIMEOUT={config.COMMIT_TIMEOUT}s）"
            )'''

if old1 in content:
    content = content.replace(old1, new1)
    print('Step 4a OK: commit timer call updated')
else:
    print('WARN: commit timer call pattern not found')

# reveal timeout timer call
old2 = '''forfeiter = game.get("player1") if not p1_revealed else game.get("player2")
            await self._handle_local_timeout_forfeit(
                game_id, "reveal", forfeiter,
                reason=f"揭晓超时（REVEAL_TIMEOUT={config.REVEAL_TIMEOUT}s）"
            )'''
new2 = '''await self._handle_local_timeout_random(
                game_id, "reveal",
                reason=f"揭晓超时（REVEAL_TIMEOUT={config.REVEAL_TIMEOUT}s）"
            )'''

if old2 in content:
    content = content.replace(old2, new2)
    print('Step 4b OK: reveal timer call updated')
else:
    print('WARN: reveal timer call pattern not found')

open(filepath, 'w', encoding='utf-8').write(content)

# Verify compile
compile(content, filepath, 'exec')
print('COMPILE OK')