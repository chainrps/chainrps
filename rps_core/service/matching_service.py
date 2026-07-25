"""
匹配服务模块

负责 ChainRPS 的玩家匹配撮合与超时提醒。

重要约定（后端无博弈权限）：
- 后端不做胜负判定与结算
- 超时只做提醒（timeout_warning），判负由玩家主动调用合约 claimTimeout() 完成
- 匹配队列基于 Redis List 实现，FIFO 顺序
"""
import asyncio
from datetime import datetime
from typing import Dict

from rps_core.config import COMMIT_TIMEOUT, REVEAL_TIMEOUT
from rps_core.models import GameState, WSMessage
from rps_core.repository import (
    create_game_record,
    update_game_record,
    get_game_record,
)
from rps_core.utils.helpers import now_timestamp, calculate_deadline, deadline_to_iso
from rps_core.utils.redis_client import redis_client
from rps_core.websocket import ws_manager


class MatchManager:
    """匹配管理器：负责撮合玩家、记录活跃请求、监控对局超时提醒"""

    def __init__(self):
        """初始化活跃匹配请求字典（player_address -> match_info）"""
        self.active_matches: Dict[str, dict] = {}

    async def request_match(self, player_address: str, token: str, bet_amount: float) -> dict:
        """
        请求匹配

        流程：
        1. 先尝试从匹配队列中弹出两个玩家进行匹配
        2. 匹配成功：创建对局记录、设置提交截止时间、缓存状态、通知双方、启动超时监控
        3. 匹配失败：将当前玩家加入队列等待

        Returns:
            {"status": "matched", "game_id": ..., "opponent": ...} 或
            {"status": "waiting", "queue_position": ...}
        """
        # 先尝试匹配队列中的玩家
        match_result = redis_client.try_match_players(token, bet_amount)

        if match_result:
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

            # 计算提交阶段截止时间
            commit_deadline_ts = calculate_deadline(COMMIT_TIMEOUT)
            commit_deadline_iso = deadline_to_iso(commit_deadline_ts)

            # 更新对局状态为提交阶段
            update_game_record(game_id, {
                "state": GameState.COMMIT_PHASE.value,
                "commit_deadline": commit_deadline_iso,
            })

            # 缓存对局状态
            redis_client.cache_game_state(game_id, {
                "player1": player1["address"],
                "player2": player2["address"],
                "token": token,
                "bet_amount": bet_amount,
                "state": GameState.COMMIT_PHASE.value,
                "commit_deadline": commit_deadline_ts,
                "commit1": None,
                "commit2": None,
            })

            # 通知双方匹配成功
            await ws_manager.send_to_player(player1["address"], WSMessage(
                type="match_success",
                data={
                    "game_id": game_id,
                    "opponent": player2["address"],
                    "token": token,
                    "bet_amount": bet_amount,
                    "commit_deadline": commit_deadline_ts,
                }
            ))

            await ws_manager.send_to_player(player2["address"], WSMessage(
                type="match_success",
                data={
                    "game_id": game_id,
                    "opponent": player1["address"],
                    "token": token,
                    "bet_amount": bet_amount,
                    "commit_deadline": commit_deadline_ts,
                }
            ))

            # 清理活跃匹配请求记录
            self.active_matches.pop(player1["address"], None)
            self.active_matches.pop(player2["address"], None)

            # 启动超时提醒任务
            asyncio.create_task(self.monitor_timeout(game_id))

            # 判定当前请求玩家是否为被匹配的玩家之一
            opponent = player2["address"] if player_address == player1["address"] else player1["address"]
            return {
                "status": "matched",
                "game_id": game_id,
                "opponent": opponent,
            }

        # 匹配失败，加入队列等待
        queue_position = redis_client.add_to_match_queue(player_address, token, bet_amount)

        # 记录活跃匹配请求
        self.active_matches[player_address] = {
            "token": token,
            "bet_amount": bet_amount,
            "joined_at": now_timestamp(),
        }

        return {
            "status": "waiting",
            "queue_position": queue_position,
        }

    async def cancel_match(self, player_address: str, token: str, bet_amount: float) -> bool:
        """
        取消匹配

        从匹配队列移除玩家并清理活跃匹配请求记录。
        """
        removed = redis_client.remove_from_match_queue(player_address, token, bet_amount)
        self.active_matches.pop(player_address, None)
        return removed

    async def get_match_status(self, player_address: str, token: str, bet_amount: float) -> dict:
        """
        查询匹配状态

        若玩家在活跃匹配请求中且 token/bet_amount 匹配，则返回队列位置；
        否则返回未在匹配中。
        """
        match_info = self.active_matches.get(player_address)
        if match_info and match_info["token"] == token and match_info["bet_amount"] == bet_amount:
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
        """
        监控对局超时（仅提醒，不判负）

        - 提交阶段：commit_deadline - 10 秒时推送 timeout_warning
        - 揭晓阶段：reveal_deadline - 10 秒时推送 timeout_warning

        注意：后端不做判负，玩家需主动调用合约 claimTimeout() 完成超时判负。
        """
        game = get_game_record(game_id)
        if not game:
            return

        # ===== 提交阶段超时提醒 =====
        commit_deadline_iso = game.get("commit_deadline")
        commit_deadline_ts = 0
        if commit_deadline_iso:
            try:
                commit_deadline_ts = datetime.fromisoformat(commit_deadline_iso).timestamp()
            except (ValueError, TypeError):
                commit_deadline_ts = 0

        if commit_deadline_ts > 0:
            # 等待到 commit_deadline - 10 秒
            now_ts = now_timestamp()
            wait_seconds = max(0, commit_deadline_ts - now_ts - 10)
            if wait_seconds > 0:
                await asyncio.sleep(wait_seconds)

            # 仍在提交阶段则推送提醒
            current_game = get_game_record(game_id)
            if current_game and current_game.get("state") == GameState.COMMIT_PHASE.value:
                await self._send_timeout_warning(game_id, "commit")

        # ===== 揭晓阶段超时提醒 =====
        # 揭晓截止时间在双方提交后才由 game_service 设置，需轮询等待对局进入揭晓阶段
        poll_interval = 5  # 轮询间隔（秒）
        # 最大轮询到 commit_deadline + REVEAL_TIMEOUT + 120 秒，避免无限等待
        max_poll_ts = (commit_deadline_ts or now_timestamp()) + REVEAL_TIMEOUT + 120

        while now_timestamp() < max_poll_ts:
            await asyncio.sleep(poll_interval)
            current_game = get_game_record(game_id)
            if not current_game:
                return

            state = current_game.get("state")
            # 对局已结束（含链上判负/平局），退出监控
            if state in (
                GameState.FINISHED.value,
                GameState.CANCELLED.value,
                GameState.DRAW.value,
            ):
                return

            # 进入揭晓阶段，处理揭晓提醒
            if state == GameState.REVEAL_PHASE.value and current_game.get("reveal_deadline"):
                try:
                    reveal_deadline_ts = datetime.fromisoformat(
                        current_game["reveal_deadline"]
                    ).timestamp()
                except (ValueError, TypeError):
                    return

                # 等待到 reveal_deadline - 10 秒
                now_ts = now_timestamp()
                wait_seconds = max(0, reveal_deadline_ts - now_ts - 10)
                if wait_seconds > 0:
                    await asyncio.sleep(wait_seconds)

                # 仍在揭晓阶段则推送提醒
                latest_game = get_game_record(game_id)
                if latest_game and latest_game.get("state") == GameState.REVEAL_PHASE.value:
                    await self._send_timeout_warning(game_id, "reveal")
                return

    async def _send_timeout_warning(self, game_id: int, phase: str):
        """向对局双方推送超时提醒消息"""
        game = get_game_record(game_id)
        if not game:
            return

        warning_data = {
            "game_id": game_id,
            "phase": phase,
            "message": "对局即将超时，请尽快操作，否则对手可调用合约 claimTimeout() 判负",
        }

        player1 = game.get("player1")
        player2 = game.get("player2")
        if player1:
            await ws_manager.send_to_player(player1, WSMessage(
                type="timeout_warning",
                data=warning_data,
            ))
        if player2:
            await ws_manager.send_to_player(player2, WSMessage(
                type="timeout_warning",
                data=warning_data,
            ))


# 全局匹配管理器实例
match_manager = MatchManager()
