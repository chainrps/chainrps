"""
用户相关 API 端点

定义 ChainRPS 后端的玩家历史记录查询、玩家统计、玩家对局列表等接口。
由于 /history 与 /player 路径前缀不统一，本路由不设置统一前缀，
由 routes.py 聚合后统一挂载到 /api 前缀下。
"""
from datetime import datetime

from fastapi import APIRouter

from rps_core.models import (
    GameResponse,
    GameState,
    PlayerHistoryResponse,
    PlayerStatsResponse,
)
from rps_core.repository import (
    get_player_games,
    get_player_games_count,
    get_player_stats,
)


# 用户相关路由，不设统一前缀（/history 与 /player 路径不统一）
router = APIRouter(prefix="", tags=["user"])


def _build_game_response(game: dict) -> GameResponse:
    """根据数据库记录构造对局详情响应"""
    return GameResponse(
        game_id=game["id"],
        player1=game.get("player1"),
        player2=game.get("player2"),
        token=game["token"],
        bet_amount=game["bet_amount"],
        state=GameState(game["state"]),
        created_at=datetime.fromisoformat(game["created_at"]),
        commit_deadline=datetime.fromisoformat(game["commit_deadline"]) if game.get("commit_deadline") else None,
        reveal_deadline=datetime.fromisoformat(game["reveal_deadline"]) if game.get("reveal_deadline") else None,
        winner=game.get("winner"),
        is_draw=bool(game.get("is_draw")),
    )


# ==================== 历史记录 ====================

@router.get("/history", response_model=PlayerHistoryResponse)
async def get_history(address: str, page: int = 1, size: int = 20):
    """查询历史记录"""
    games = get_player_games(address, page, size)
    stats = get_player_stats(address)

    game_responses = [_build_game_response(game) for game in games]

    return PlayerHistoryResponse(
        games=game_responses,
        total_games=len(game_responses),
        wins=stats.get("wins", 0) if stats else 0,
        losses=stats.get("losses", 0) if stats else 0,
        draws=stats.get("draws", 0) if stats else 0,
    )


# ==================== 玩家统计 ====================

@router.get("/player/{address}/stats", response_model=PlayerStatsResponse)
async def get_player_statistics(address: str):
    """获取玩家统计"""
    stats = get_player_stats(address)

    if not stats:
        return PlayerStatsResponse(
            address=address,
            total_games=0,
            wins=0,
            losses=0,
            draws=0,
            win_rate=0,
            total_wagered=0,
            total_won=0,
        )

    total_games = stats.get("total_games", 0)
    win_rate = stats["wins"] / total_games if total_games > 0 else 0

    return PlayerStatsResponse(
        address=address,
        total_games=total_games,
        wins=stats.get("wins", 0),
        losses=stats.get("losses", 0),
        draws=stats.get("draws", 0),
        win_rate=win_rate,
        total_wagered=stats.get("total_wagered", 0),
        total_won=stats.get("total_won", 0),
    )


# ==================== 玩家对局 ====================

@router.get("/player/{address}/games", response_model=PlayerHistoryResponse)
async def get_player_games_endpoint(address: str, page: int = 1, size: int = 20):
    """获取玩家对局列表"""
    games = get_player_games(address, page, size)
    total_count = get_player_games_count(address)
    stats = get_player_stats(address)

    game_responses = [_build_game_response(game) for game in games]

    return PlayerHistoryResponse(
        games=game_responses,
        total_games=total_count,
        wins=stats.get("wins", 0) if stats else 0,
        losses=stats.get("losses", 0) if stats else 0,
        draws=stats.get("draws", 0) if stats else 0,
    )
