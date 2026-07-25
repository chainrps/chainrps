"""
游戏相关 API 端点

定义 ChainRPS 后端的游戏匹配、对局查询、提交承诺、揭晓出拳、
处理平局等接口。所有接口路径以 /game 为前缀，最终通过 main.py
挂载到 /api 前缀下，形成 /api/game/... 的完整路径。
"""
from datetime import datetime

from fastapi import APIRouter, HTTPException

from rps_core.models import (
    CancelMatchRequest,
    CreatePrivateMatchRequest,
    GameResponse,
    GameState,
    HandleDrawRequest,
    JoinMatchRequest,
    JoinPrivateMatchRequest,
    MatchJoinResponse,
    MatchStatusResponse,
    RevealChoiceRequest,
    SubmitCommitRequest,
)
from rps_core.repository import get_game_record
from rps_core.service import game_manager, match_manager


# 游戏相关路由，统一前缀 /game
router = APIRouter(prefix="/game", tags=["game"])


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


# ==================== 匹配相关 ====================

@router.post("/join", response_model=MatchJoinResponse)
async def join_match(request: JoinMatchRequest):
    """加入公共匹配队列"""
    result = await match_manager.request_match(
        request.player_address,
        request.token.value,
        request.bet_amount,
    )

    if "error" in result:
        raise HTTPException(status_code=400, detail=result["error"])

    queue_position = result.get("queue_position")
    return MatchJoinResponse(
        success=True,
        matched=result.get("status") == "matched",
        queue_id=str(queue_position) if queue_position is not None else None,
        game_id=result.get("game_id"),
        opponent=result.get("opponent"),
    )


@router.post("/create")
async def create_private_match(request: CreatePrivateMatchRequest):
    """创建私密对局（模式A用，返回 match_id 供分享）"""
    result = await match_manager.request_match(
        request.player_address,
        request.token.value,
        request.bet_amount,
    )

    if "error" in result:
        raise HTTPException(status_code=400, detail=result["error"])

    return {
        "success": True,
        "match_id": result.get("game_id"),
        "status": result.get("status"),
    }


@router.post("/cancel")
async def cancel_match(request: CancelMatchRequest):
    """取消匹配"""
    removed = await match_manager.cancel_match(
        request.player_address,
        request.token.value,
        request.bet_amount,
    )

    return {"success": True, "cancelled": removed}


@router.get("/match/status/{player_address}", response_model=MatchStatusResponse)
async def get_match_status(player_address: str, token: str, bet_amount: float):
    """获取匹配状态"""
    result = await match_manager.get_match_status(
        player_address,
        token,
        bet_amount,
    )

    return MatchStatusResponse(
        is_matching=result.get("is_matching", False),
        queue_position=result.get("queue_position"),
        estimated_wait=None,
    )


# ==================== 游戏流程相关 ====================

@router.post("/commit")
async def submit_commit(request: SubmitCommitRequest):
    """提交哈希承诺（记录状态+通知对手）"""
    result = await game_manager.submit_commit(
        request.game_id,
        request.player_address,
        request.commit_hash,
    )

    if "error" in result:
        raise HTTPException(status_code=400, detail=result["error"])

    return result


@router.post("/reveal")
async def reveal_choice(request: RevealChoiceRequest):
    """揭晓出拳（记录状态+通知对手）"""
    result = await game_manager.reveal_choice(
        request.game_id,
        request.player_address,
        request.choice,
        request.salt,
    )

    if "error" in result:
        raise HTTPException(status_code=400, detail=result["error"])

    return result


@router.post("/draw")
async def handle_draw(request: HandleDrawRequest):
    """处理平局"""
    result = await game_manager.handle_draw(
        request.game_id,
        request.player_address,
    )

    if "error" in result:
        raise HTTPException(status_code=400, detail=result["error"])

    return result


# ==================== 对局查询与加入 ====================
# 注意：参数化路径需放在字面量路径之后，避免误匹配

@router.post("/{match_id}/join")
async def join_private_match(match_id: int, request: JoinPrivateMatchRequest):
    """加入私密对局"""
    # 校验 body 中的 match_id 与 path 中一致
    if request.match_id != match_id:
        raise HTTPException(status_code=400, detail="match_id mismatch")

    # 查询对局信息以获取 token 与 bet_amount
    game = get_game_record(match_id)
    if not game:
        raise HTTPException(status_code=404, detail="Game not found")

    result = await match_manager.request_match(
        request.player_address,
        game["token"],
        game["bet_amount"],
    )

    if "error" in result:
        raise HTTPException(status_code=400, detail=result["error"])

    return {
        "success": True,
        "match_id": match_id,
        "game_id": result.get("game_id"),
    }


@router.get("/{match_id}", response_model=GameResponse)
async def get_game(match_id: int):
    """查询对局状态"""
    game = get_game_record(match_id)

    if not game:
        raise HTTPException(status_code=404, detail="Game not found")

    return _build_game_response(game)
