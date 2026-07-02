"""
游戏逻辑管理
"""
import asyncio
from datetime import datetime
from typing import Optional

from web3 import Web3
from eth_account import Account

from .config import RPC_URL, CONTRACT_ADDRESS, REVEAL_TIMEOUT, OPERATOR_PRIVATE_KEY
from .database import (
    get_game_record, update_game_record, update_player_stats
)
from .redis_client import redis_client
from .websocket import ws_manager
from .matching import match_manager
from .models import GameState, Choice, WSMessage


class GameManager:
    """游戏逻辑管理器"""

    def __init__(self):
        self.w3 = Web3(Web3.HTTPProvider(RPC_URL))

        # 加载合约 ABI（实际部署时需要替换）
        # self.contract = self.w3.eth.contract(address=CONTRACT_ADDRESS, abi=CONTRACT_ABI)

        # 自动超时处理（如果配置了运营钱包）
        if OPERATOR_PRIVATE_KEY:
            self.operator_account = Account.from_key(OPERATOR_PRIVATE_KEY)

    async def submit_commit(self, game_id: int, player_address: str, commit_hash: str) -> dict:
        """
        提交哈希承诺
        
        注意：实际哈希提交由前端直接调用合约，
        此函数用于后端记录状态和通知对手
        """
        game = get_game_record(game_id)
        if not game:
            return {"error": "Game not found"}

        if game["state"] != GameState.COMMIT_PHASE.value:
            return {"error": "Not in commit phase"}

        # 判断是哪个玩家
        is_player1 = game["player1"] == player_address
        is_player2 = game["player2"] == player_address

        if not (is_player1 or is_player2):
            return {"error": "Not a player in this game"}

        # 记录提交
        if is_player1:
            update_game_record(game_id, {"commit1": commit_hash})
        else:
            update_game_record(game_id, {"commit2": commit_hash})

        # 更新缓存
        cached_state = redis_client.get_cached_game_state(game_id)
        if cached_state:
            if is_player1:
                cached_state["commit1"] = commit_hash
            else:
                cached_state["commit2"] = commit_hash
            redis_client.cache_game_state(game_id, cached_state)

        # 通知对手
        opponent = game["player2"] if is_player1 else game["player1"]
        await ws_manager.send_to_player(opponent, WSMessage(
            type="opponent_commit",
            data={"game_id": game_id, "player": player_address}
        ))

        # 检查双方是否都已提交
        game = get_game_record(game_id)
        if game["commit1"] and game["commit2"]:
            # 进入揭晓阶段
            reveal_deadline = datetime.utcnow().timestamp() + REVEAL_TIMEOUT
            update_game_record(game_id, {
                "state": GameState.REVEAL_PHASE.value,
                "reveal_deadline": datetime.fromtimestamp(reveal_deadline).isoformat()
            })

            # 通知双方
            await ws_manager.send_to_player(game["player1"], WSMessage(
                type="reveal_start",
                data={"game_id": game_id, "reveal_deadline": reveal_deadline}
            ))

            await ws_manager.send_to_player(game["player2"], WSMessage(
                type="reveal_start",
                data={"game_id": game_id, "reveal_deadline": reveal_deadline}
            ))

        return {"success": True, "game_id": game_id}

    async def reveal_choice(self, game_id: int, player_address: str, choice: Choice, salt: int) -> dict:
        """
        揭晓出拳
        
        注意：实际揭晓由前端直接调用合约，
        此函数用于后端记录状态和通知结果
        """
        game = get_game_record(game_id)
        if not game:
            return {"error": "Game not found"}

        if game["state"] != GameState.REVEAL_PHASE.value:
            return {"error": "Not in reveal phase"}

        # 判断是哪个玩家
        is_player1 = game["player1"] == player_address
        is_player2 = game["player2"] == player_address

        if not (is_player1 or is_player2):
            return {"error": "Not a player in this game"}

        # 记录揭晓
        if is_player1:
            update_game_record(game_id, {"choice1": choice.value, "salt1": salt})
        else:
            update_game_record(game_id, {"choice2": choice.value, "salt2": salt})

        # 通知对手
        opponent = game["player2"] if is_player1 else game["player1"]
        await ws_manager.send_to_player(opponent, WSMessage(
            type="opponent_reveal",
            data={"game_id": game_id, "player": player_address, "choice": choice.value}
        ))

        # 检查双方是否都已揭晓
        game = get_game_record(game_id)
        if game["choice1"] and game["choice2"]:
            # 自动结算
            await self._settle_game(game_id)

        return {"success": True, "game_id": game_id}

    async def _settle_game(self, game_id: int):
        """结算对局"""
        game = get_game_record(game_id)

        choice1 = Choice(game["choice1"])
        choice2 = Choice(game["choice2"])

        # 判断胜负
        if choice1 == choice2:
            # 平局
            update_game_record(game_id, {
                "state": GameState.DRAW.value,
                "is_draw": 1,
                "finished_at": datetime.utcnow().isoformat()
            })

            # 更新统计
            update_player_stats(game["player1"], "draw", game["bet_amount"])
            update_player_stats(game["player2"], "draw", game["bet_amount"])

            # 通知双方
            await ws_manager.send_to_player(game["player1"], WSMessage(
                type="game_draw",
                data={"game_id": game_id, "choice1": choice1.value, "choice2": choice2.value}
            ))

            await ws_manager.send_to_player(game["player2"], WSMessage(
                type="game_draw",
                data={"game_id": game_id, "choice1": choice1.value, "choice2": choice2.value}
            ))

        else:
            # 判断胜负
            winner = self._check_winner(choice1, choice2)
            winner_address = game["player1"] if winner == 1 else game["player2"]
            loser_address = game["player2"] if winner == 1 else game["player1"]

            # 计算奖金（扣除 2% 手续费）
            total_prize = game["bet_amount"] * 2
            fee = total_prize * 0.02
            winner_prize = total_prize - fee

            update_game_record(game_id, {
                "state": GameState.FINISHED.value,
                "winner": winner_address,
                "finished_at": datetime.utcnow().isoformat()
            })

            # 更新统计
            update_player_stats(winner_address, "win", winner_prize)
            update_player_stats(loser_address, "loss", game["bet_amount"])

            # 通知双方
            await ws_manager.send_to_player(winner_address, WSMessage(
                type="game_win",
                data={
                    "game_id": game_id,
                    "choice1": choice1.value,
                    "choice2": choice2.value,
                    "prize": winner_prize,
                    "fee": fee
                }
            ))

            await ws_manager.send_to_player(loser_address, WSMessage(
                type="game_loss",
                data={
                    "game_id": game_id,
                    "choice1": choice1.value,
                    "choice2": choice2.value,
                }
            ))

        # 清理缓存
        redis_client.delete_cached_game_state(game_id)

    def _check_winner(self, choice1: Choice, choice2: Choice) -> int:
        """
        判断胜负
        
        Returns:
            1 = 玩家1获胜, 2 = 玩家2获胜
        """
        # 石头 > 剪刀 > 布 > 石头
        if choice1 == Choice.ROCK and choice2 == Choice.SCISSORS:
            return 1
        if choice1 == Choice.PAPER and choice2 == Choice.ROCK:
            return 1
        if choice1 == Choice.SCISSORS and choice2 == Choice.PAPER:
            return 1
        return 2

    async def handle_draw(self, game_id: int, player_address: str, action: str) -> dict:
        """处理平局后的玩家选择"""
        game = get_game_record(game_id)

        if not game:
            return {"error": "Game not found"}

        if game["state"] != GameState.DRAW.value:
            return {"error": "Not a draw game"}

        if action == "refund":
            # 退款（实际操作由前端调用合约）
            return {"success": True, "action": "refund"}

        elif action == "rematch":
            # 重新对战（二期功能）
            return {"error": "Rematch not implemented"}

        return {"error": "Invalid action"}


# 全局游戏管理器实例
game_manager = GameManager()