"""
游戏状态管理服务模块

负责 ChainRPS 对局过程中的状态记录与 WebSocket 通知。

重要约定（后端无博弈权限）：
- 不做胜负判定，胜负结果由链上合约事件同步
- 不做结算，结算由链上合约完成
- 仅记录玩家提交与揭晓、推送通知、同步链上事件结果
"""
from datetime import datetime
from typing import Optional
import hashlib

from rps_backend.config import REVEAL_TIMEOUT
from rps_backend.models import GameState, Choice, WSMessage
from rps_backend.repository import (
    get_game_record,
    update_game_record,
    update_player_stats,
)
from rps_backend.service.room_service import room_manager, ROOM_STATUS
from rps_backend.utils.helpers import calculate_deadline, deadline_to_iso
from rps_backend.utils.redis_client import redis_client
from rps_backend.websocket import ws_manager


# 校验承诺哈希
def _verify_commit(choice: str, salt: str, address: str, commit_hash: str) -> bool:
    """校验承诺哈希：keccak256(choice + salt + address)"""
    if not choice or not salt or not address or not commit_hash:
        return False
    raw = f"{choice}{salt}{address}"
    computed = "0x" + hashlib.sha3_256(raw.encode()).hexdigest()
    return computed.lower() == commit_hash.lower()


# 判定胜负
def _determine_winner(choice1: str, choice2: str) -> Optional[int]:
    """
    判定胜负
    返回: 1 - 玩家1胜, 2 - 玩家2胜, None - 平局
    """
    if choice1 == choice2:
        return None
    wins = {
        "rock": "scissors",
        "scissors": "paper",
        "paper": "rock",
    }
    if wins.get(choice1) == choice2:
        return 1
    return 2


# 游戏状态管理器
class GameManager:
    """
    游戏状态管理器

    仅负责对局状态的记录与通知，不做胜负判定与结算。
    胜负结果由 contract_service 从链上事件同步后调用 update_game_result_from_chain 写入。
    """

    # 初始化
    def __init__(self):
        """初始化，后端不需要 Web3 实例（不发起任何链上交易）"""
        pass #别删除，用于人工代码审核 便利

    # 提交哈希承诺
    async def submit_commit(self, game_id: int, player_address: str, commit_hash: str) -> dict:
        """
        提交哈希承诺

        流程：
        1. 记录提交到数据库（update_game_record）
        2. 更新缓存
        3. 通知对手 opponent_commit
        4. 双方都提交后：更新状态为 REVEAL_PHASE，设置 reveal_deadline，通知双方 reveal_start

        注意：不做任何校验或判定，仅记录与通知。
        """
        game = get_game_record(game_id)
        if not game:
            return {"error": "Game not found"}

        # 判断是哪一方玩家
        is_player1 = game.get("player1") == player_address
        is_player2 = game.get("player2") == player_address
        if not (is_player1 or is_player2):
            return {"error": "Not a player in this game"}

        # 记录提交
        commit_field = "commit1" if is_player1 else "commit2"
        update_game_record(game_id, {commit_field: commit_hash})

        # 更新缓存
        cached_state = redis_client.get_cached_game_state(game_id)
        if cached_state:
            cached_state[commit_field] = commit_hash
            redis_client.cache_game_state(game_id, cached_state)

        # 通知对手已提交
        opponent = game.get("player2") if is_player1 else game.get("player1")
        if opponent:
            await ws_manager.send_to_player(opponent, WSMessage(
                type="opponent_commit",
                data={"game_id": game_id, "player": player_address}
            ))

        # 检查双方是否都已提交
        latest_game = get_game_record(game_id)
        if latest_game and latest_game.get("commit1") and latest_game.get("commit2"):
            # 进入揭晓阶段
            reveal_deadline_ts = calculate_deadline(REVEAL_TIMEOUT)
            reveal_deadline_iso = deadline_to_iso(reveal_deadline_ts)

            update_game_record(game_id, {
                "state": GameState.REVEAL_PHASE.value,
                "reveal_deadline": reveal_deadline_iso,
            })

            # 更新缓存
            if cached_state:
                cached_state["state"] = GameState.REVEAL_PHASE.value
                cached_state["reveal_deadline"] = reveal_deadline_ts
                redis_client.cache_game_state(game_id, cached_state)

            # 通知双方进入揭晓阶段
            player1 = latest_game.get("player1")
            player2 = latest_game.get("player2")
            reveal_start_data = {
                "game_id": game_id,
                "reveal_deadline": reveal_deadline_ts,
            }
            if player1:
                await ws_manager.send_to_player(player1, WSMessage(
                    type="reveal_start",
                    data=reveal_start_data,
                ))
            if player2:
                await ws_manager.send_to_player(player2, WSMessage(
                    type="reveal_start",
                    data=reveal_start_data,
                ))

        return {"success": True, "game_id": game_id}

    # 揭晓出拳
    async def reveal_choice(self, game_id: int, player_address: str, choice: Choice, salt: str) -> dict:
        """
        揭晓出拳（仅记录状态与通知，不做胜负判定与结算）

        重要约定（后端无博弈权限）：
        - 胜负判定与结算完全由链上合约完成
        - 后端仅记录揭晓状态、通知对手
        - 链上 GameSettled / DrawHandled 事件由 contract_service 同步结果

        流程：
        1. 记录揭晓到数据库
        2. 更新缓存
        3. 通知对手 opponent_reveal
        """
        game = get_game_record(game_id)
        if not game:
            return {"error": "Game not found"}

        # 判断是哪一方玩家
        is_player1 = game.get("player1") == player_address
        is_player2 = game.get("player2") == player_address
        if not (is_player1 or is_player2):
            return {"error": "Not a player in this game"}

        # 统一处理 choice 取值
        choice_value = choice.value if isinstance(choice, Choice) else choice

        # 记录揭晓
        choice_field = "choice1" if is_player1 else "choice2"
        salt_field = "salt1" if is_player1 else "salt2"
        update_game_record(game_id, {
            choice_field: choice_value,
            salt_field: salt,
        })

        # 更新缓存
        cached_state = redis_client.get_cached_game_state(game_id)
        if cached_state:
            cached_state[choice_field] = choice_value
            cached_state[salt_field] = salt
            redis_client.cache_game_state(game_id, cached_state)

        # 房间标记：进入揭晓阶段（资金流程状态更新）
        try:
            room_info = room_manager.get_player_room(game.get("player1") or "")
            if not room_info:
                room_info = room_manager.get_player_room(game.get("player2") or "")
            if room_info and room_info.get("game_id") == game_id:
                r = room_manager._rooms.get(room_info["room_id"])
                if r:
                    r["fund_stage"] = "revealing"
                    redis_client.cache_room_state(room_info["room_id"], r)
        except Exception:
            pass

        # 通知对手已揭晓
        opponent = game.get("player2") if is_player1 else game.get("player1")
        if opponent:
            await ws_manager.send_to_player(opponent, WSMessage(
                type="opponent_reveal",
                data={
                    "game_id": game_id,
                    "player": player_address,
                    "choice": choice_value,
                }
            ))

        # 胜负结果由链上合约事件同步（contract_service 监听 GameSettled / DrawHandled）
        return {"success": True, "game_id": game_id}

    # 处理平局
    async def handle_draw(self, game_id: int, player_address: str) -> dict:
        """
        处理平局

        后端仅返回成功，实际退款由前端调用合约完成。
        """
        return {"success": True, "game_id": game_id, "player": player_address}

    # 从链上同步对局结果
    async def update_game_result_from_chain(
        self,
        game_id: int,
        winner: Optional[str],
        is_draw: bool,
        fee: float = 0.0,
    ) -> dict:
        """
        从链上事件同步对局结果到数据库

        流程：
        1. 更新对局记录（state、winner、is_draw、fee、finished_at）
        2. 更新双方玩家统计
        3. 通知双方 game_result

        此函数由 contract_service 监听到 GameSettled / TimeoutClaimed / DrawHandled 事件后调用。
        """
        game = get_game_record(game_id)
        if not game:
            return {"error": "Game not found"}

        # 更新对局记录
        updates = {
            "state": GameState.FINISHED.value,
            "is_draw": 1 if is_draw else 0,
            "fee": fee,
            "finished_at": datetime.utcnow().isoformat(),
        }
        if winner:
            updates["winner"] = winner
        update_game_record(game_id, updates)

        # 更新玩家统计
        player1 = game.get("player1")
        player2 = game.get("player2")
        bet_amount = game.get("bet_amount", 0.0) or 0.0

        if is_draw:
            # 平局：双方均记为 draw
            if player1:
                update_player_stats(player1, "draw", bet_amount)
            if player2:
                update_player_stats(player2, "draw", bet_amount)
        elif winner:
            # 有胜者：胜者 win，败者 loss
            loser = player2 if winner == player1 else player1
            # 胜者奖金 = 下注金额 - 手续费（双方下注相同）
            winner_prize = bet_amount - fee if bet_amount > fee else 0
            update_player_stats(winner, "win", winner_prize)
            if loser:
                update_player_stats(loser, "loss", bet_amount)

        # 通知双方对局结果
        result_data = {
            "game_id": game_id,
            "winner": winner,
            "is_draw": is_draw,
            "fee": fee,
        }
        if player1:
            await ws_manager.send_to_player(player1, WSMessage(
                type="game_result",
                data=result_data,
            ))
        if player2:
            await ws_manager.send_to_player(player2, WSMessage(
                type="game_result",
                data=result_data,
            ))

        # 清理对局缓存
        redis_client.delete_cached_game_state(game_id)

        # 同步：关联房间标记为已完成，停止所有计时器
        try:
            room_info = room_manager.get_player_room(player1 or "")
            if not room_info:
                room_info = room_manager.get_player_room(player2 or "")
            if room_info and room_info.get("game_id") == game_id:
                rid = room_info["room_id"]
                # 将房间标记为 FINISHED（已完成），生命周期计时器会自动跳过
                r = room_manager._rooms.get(rid)
                if r:
                    r["status"] = ROOM_STATUS["FINISHED"]
                    r["fund_stage"] = "settled"
                    r["finished_at"] = datetime.utcnow().isoformat()
                    redis_client.cache_room_state(rid, r)
                    # 停止计时器
                    room_manager._stop_game_timer(rid)
                    room_manager._stop_lifetime_timer(rid)
                    # 广播房间列表变更（从大厅移除）
                    room_manager._broadcast_room_list_changed("game_finished", rid)
        except Exception:
            pass

        return {"success": True, "game_id": game_id}


# 全局游戏管理器实例
game_manager = GameManager()