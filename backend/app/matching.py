"""
匹配队列管理
"""
import asyncio
from datetime import datetime
from typing import Optional, Dict

from .config import COMMIT_TIMEOUT
from .redis_client import redis_client
from .database import create_game_record, update_game_record, get_game_record
from .websocket import ws_manager
from .models import WSMessage, GameState


class MatchManager:
    """匹配管理器"""

    def __init__(self):
        self.active_matches: Dict[str, dict] = {}  # player_address -> match_info

    async def request_match(self, player_address: str, token: str, bet_amount: float) -> dict:
        """
        请求匹配
        
        Returns:
            匹配结果：{"status": "matched"} 或 {"status": "waiting", "queue_position": n}
        """
        # 先尝试匹配现有队列中的玩家
        match_result = redis_client.try_match_players(token, bet_amount)

        if match_result:
            # 匹配成功
            player1 = match_result["player1"]
            player2 = match_result["player2"]

            # 创建对局记录
            game_data = {
                "player1": player1["address"],
                "player2": player2["address"],
                "token": token,
                "bet_amount": bet_amount,
            }
            game_id = create_game_record(game_data)

            # 更新状态为提交阶段
            commit_deadline = datetime.utcnow().timestamp() + COMMIT_TIMEOUT
            update_game_record(game_id, {
                "state": GameState.COMMIT_PHASE.value,
                "commit_deadline": datetime.fromtimestamp(commit_deadline).isoformat()
            })

            # 缓存游戏状态
            redis_client.cache_game_state(game_id, {
                "player1": player1["address"],
                "player2": player2["address"],
                "token": token,
                "bet_amount": bet_amount,
                "state": GameState.COMMIT_PHASE.value,
                "commit_deadline": commit_deadline,
                "commit1": None,
                "commit2": None,
            })

            # 发送 WebSocket 通知
            await ws_manager.send_to_player(player1["address"], WSMessage(
                type="match_success",
                data={
                    "game_id": game_id,
                    "opponent": player2["address"],
                    "token": token,
                    "bet_amount": bet_amount,
                    "commit_deadline": commit_deadline,
                }
            ))

            await ws_manager.send_to_player(player2["address"], WSMessage(
                type="match_success",
                data={
                    "game_id": game_id,
                    "opponent": player1["address"],
                    "token": token,
                    "bet_amount": bet_amount,
                    "commit_deadline": commit_deadline,
                }
            ))

            # 移除活跃匹配记录
            self.active_matches.pop(player1["address"], None)
            self.active_matches.pop(player2["address"], None)

            # 启动超时监控
            asyncio.create_task(self.monitor_timeout(game_id))

            return {
                "status": "matched",
                "game_id": game_id,
                "opponent": player2["address"] if player_address == player1["address"] else player1["address"],
            }

        else:
            # 加入队列等待
            queue_position = redis_client.add_to_match_queue(player_address, token, bet_amount)

            # 记录活跃匹配请求
            self.active_matches[player_address] = {
                "token": token,
                "bet_amount": bet_amount,
                "joined_at": datetime.utcnow().timestamp(),
            }

            return {
                "status": "waiting",
                "queue_position": queue_position,
            }

    async def cancel_match(self, player_address: str, token: str, bet_amount: float) -> bool:
        """取消匹配"""
        # 从队列移除
        removed = redis_client.remove_from_match_queue(player_address, token, bet_amount)

        # 移除活跃匹配记录
        self.active_matches.pop(player_address, None)

        return removed

    async def get_match_status(self, player_address: str, token: str, bet_amount: float) -> dict:
        """获取匹配状态"""
        # 检查是否在活跃匹配中
        if player_address in self.active_matches:
            match_info = self.active_matches[player_address]
            if match_info["token"] == token and match_info["bet_amount"] == bet_amount:
                queue_position = redis_client.get_queue_position(player_address, token, bet_amount)
                return {
                    "is_matching": True,
                    "queue_position": queue_position,
                }

        return {
            "is_matching": False,
            "queue_position": None,
        }

    async def monitor_timeout(self, game_id: int):
        """监控对局超时"""
        from .config import REVEAL_TIMEOUT

        # 获取游戏状态
        game = get_game_record(game_id)
        if not game:
            return

        commit_deadline = datetime.fromisoformat(game["commit_deadline"]).timestamp() if game["commit_deadline"] else 0

        # 等待提交阶段结束
        wait_time = max(0, commit_deadline - datetime.utcnow().timestamp())
        await asyncio.sleep(wait_time)

        # 检查是否双方都已提交
        game = get_game_record(game_id)
        if game["state"] == GameState.COMMIT_PHASE.value:
            # 还在提交阶段，检查谁没提交
            commit1 = game["commit1"]
            commit2 = game["commit2"]

            if not commit1 and not commit2:
                # 双方都没提交，平局退款
                await self._handle_timeout_draw(game_id)
            elif not commit1:
                # 玩家1没提交，玩家2获胜
                await self._handle_timeout_win(game_id, game["player2"], game["player1"])
            elif not commit2:
                # 玩家2没提交，玩家1获胜
                await self._handle_timeout_win(game_id, game["player1"], game["player2"])

        # 如果进入揭晓阶段，继续监控揭晓超时
        game = get_game_record(game_id)
        if game and game["state"] == GameState.REVEAL_PHASE.value:
            reveal_deadline = datetime.fromisoformat(game["reveal_deadline"]).timestamp() if game["reveal_deadline"] else 0

            wait_time = max(0, reveal_deadline - datetime.utcnow().timestamp())
            await asyncio.sleep(wait_time)

            # 检查揭晓状态
            game = get_game_record(game_id)
            if game["state"] == GameState.REVEAL_PHASE.value:
                choice1 = game["choice1"]
                choice2 = game["choice2"]

                if not choice1 and not choice2:
                    await self._handle_timeout_draw(game_id)
                elif not choice1:
                    await self._handle_timeout_win(game_id, game["player2"], game["player1"])
                elif not choice2:
                    await self._handle_timeout_win(game_id, game["player1"], game["player2"])

    async def _handle_timeout_win(self, game_id: int, winner: str, loser: str):
        """处理超时判负"""
        update_game_record(game_id, {
            "state": GameState.FINISHED.value,
            "winner": winner,
            "finished_at": datetime.utcnow().isoformat(),
        })

        # 发送通知
        await ws_manager.send_to_player(winner, WSMessage(
            type="timeout_win",
            data={"game_id": game_id, "winner": True}
        ))

        await ws_manager.send_to_player(loser, WSMessage(
            type="timeout_loss",
            data={"game_id": game_id, "winner": False}
        ))

        # 清理缓存
        redis_client.delete_cached_game_state(game_id)

    async def _handle_timeout_draw(self, game_id: int):
        """处理超时平局"""
        update_game_record(game_id, {
            "state": GameState.FINISHED.value,
            "is_draw": 1,
            "finished_at": datetime.utcnow().isoformat(),
        })

        game = get_game_record(game_id)

        # 发送通知
        await ws_manager.send_to_player(game["player1"], WSMessage(
            type="timeout_draw",
            data={"game_id": game_id}
        ))

        await ws_manager.send_to_player(game["player2"], WSMessage(
            type="timeout_draw",
            data={"game_id": game_id}
        ))

        # 清理缓存
        redis_client.delete_cached_game_state(game_id)


# 全局匹配管理器实例
match_manager = MatchManager()