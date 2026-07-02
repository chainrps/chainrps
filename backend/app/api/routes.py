"""
API 路由
"""
from datetime import datetime
from typing import List, Optional

from fastapi import APIRouter, HTTPException, WebSocket

from .models import (
    CreateGameRequest, JoinGameRequest, CancelMatchRequest,
    SubmitCommitRequest, RevealChoiceRequest, HandleDrawRequest,
    GameResponse, MatchStatusResponse, PlayerHistoryResponse,
    Choice, GameState
)
from .matching import match_manager
from .game_manager import game_manager
from .database import get_game_record, get_player_games, get_player_stats, init_database
from .websocket import websocket_endpoint
from .redis_client import redis_client

router = APIRouter()


# ==================== 初始化 ====================

@router.on_event("startup")
async def startup():
    """服务启动时初始化"""
    init_database()

    # 检查 Redis 连接
    if not redis_client.is_connected():
        print("警告：Redis 未连接，匹配功能将不可用")


# ==================== 匹配相关 ====================

@router.post("/match/request")
async def request_match(request: CreateGameRequest):
    """请求匹配"""
    result = await match_manager.request_match(
        request.player_address,
        request.token.value,
        request.bet_amount
    )

    if result["status"] == "matched":
        return {
            "success": True,
            "matched": True,
            "game_id": result["game_id"],
            "opponent": result["opponent"]
        }
    else:
        return {
            "success": True,
            "matched": False,
            "queue_position": result["queue_position"]
        }


@router.post("/match/cancel")
async def cancel_match(request: CancelMatchRequest):
    """取消匹配"""
    removed = await match_manager.cancel_match(
        request.player_address,
        request.token.value,
        request.bet_amount
    )

    if removed:
        return {"success": True, "cancelled": True}
    else:
        return {"success": True, "cancelled": False, "message": "Not in queue"}


@router.get("/match/status/{player_address}")
async def get_match_status(player_address: str, token: str, bet_amount: float):
    """获取匹配状态"""
    result = await match_manager.get_match_status(
        player_address,
        token,
        bet_amount
    )

    return MatchStatusResponse(
        is_matching=result["is_matching"],
        queue_position=result["queue_position"],
        estimated_wait=None  # 可以根据历史数据估算
    )


# ==================== 游戏相关 ====================

@router.post("/game/commit")
async def submit_commit(request: SubmitCommitRequest):
    """提交哈希承诺"""
    result = await game_manager.submit_commit(
        request.game_id,
        request.player_address,
        request.commit_hash
    )

    if "error" in result:
        raise HTTPException(status_code=400, detail=result["error"])

    return result


@router.post("/game/reveal")
async def reveal_choice(request: RevealChoiceRequest):
    """揭晓出拳"""
    result = await game_manager.reveal_choice(
        request.game_id,
        request.player_address,
        request.choice,
        request.salt
    )

    if "error" in result:
        raise HTTPException(status_code=400, detail=result["error"])

    return result


@router.post("/game/handle-draw")
async def handle_draw(request: HandleDrawRequest):
    """处理平局"""
    result = await game_manager.handle_draw(
        request.game_id,
        request.player_address,
        request.action
    )

    if "error" in result:
        raise HTTPException(status_code=400, detail=result["error"])

    return result


@router.get("/game/{game_id}")
async def get_game(game_id: int):
    """获取对局详情"""
    game = get_game_record(game_id)

    if not game:
        raise HTTPException(status_code=404, detail="Game not found")

    return GameResponse(
        game_id=game["id"],
        player1=game["player1"],
        player2=game["player2"],
        token=game["token"],
        bet_amount=game["bet_amount"],
        state=GameState(game["state"]),
        created_at=datetime.fromisoformat(game["created_at"]),
        commit_deadline=datetime.fromisoformat(game["commit_deadline"]) if game["commit_deadline"] else None,
        reveal_deadline=datetime.fromisoformat(game["reveal_deadline"]) if game["reveal_deadline"] else None,
        winner=game["winner"],
        is_draw=bool(game["is_draw"])
    )


# ==================== 玩家相关 ====================

@router.get("/player/{address}/games")
async def get_player_history(address: str, limit: int = 50):
    """获取玩家对局历史"""
    games = get_player_games(address, limit)

    game_responses = []
    for game in games:
        game_responses.append(GameResponse(
            game_id=game["id"],
            player1=game["player1"],
            player2=game["player2"],
            token=game["token"],
            bet_amount=game["bet_amount"],
            state=GameState(game["state"]),
            created_at=datetime.fromisoformat(game["created_at"]),
            commit_deadline=datetime.fromisoformat(game["commit_deadline"]) if game["commit_deadline"] else None,
            reveal_deadline=datetime.fromisoformat(game["reveal_deadline"]) if game["reveal_deadline"] else None,
            winner=game["winner"],
            is_draw=bool(game["is_draw"])
        ))

    # 获取统计
    stats = get_player_stats(address)

    return PlayerHistoryResponse(
        games=game_responses,
        total_games=len(game_responses),
        wins=stats["wins"] if stats else 0,
        losses=stats["losses"] if stats else 0,
        draws=stats["draws"] if stats else 0
    )


@router.get("/player/{address}/stats")
async def get_player_statistics(address: str):
    """获取玩家统计"""
    stats = get_player_stats(address)

    if not stats:
        return {
            "address": address,
            "total_games": 0,
            "wins": 0,
            "losses": 0,
            "draws": 0,
            "win_rate": 0,
            "total_wagered": 0,
            "total_won": 0
        }

    win_rate = stats["wins"] / stats["total_games"] if stats["total_games"] > 0 else 0

    return {
        "address": address,
        "total_games": stats["total_games"],
        "wins": stats["wins"],
        "losses": stats["losses"],
        "draws": stats["draws"],
        "win_rate": win_rate,
        "total_wagered": stats["total_wagered"],
        "total_won": stats["total_won"]
    }


# ==================== WebSocket ====================

@router.websocket("/ws/{player_address}")
async def ws_endpoint(websocket: WebSocket, player_address: str):
    """WebSocket 连接"""
    await websocket_endpoint(websocket, player_address)