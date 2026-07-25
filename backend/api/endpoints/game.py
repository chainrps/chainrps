"""
游戏相关 API 端点

定义 ChainRPS 后端的游戏匹配、对局查询、提交承诺、揭晓出拳、
处理平局等接口。所有接口路径以 /game 为前缀，最终通过 main.py
挂载到 /api 前缀下，形成 /api/game/... 的完整路径。
"""
from datetime import datetime

from fastapi import APIRouter, HTTPException

from backend.models import (
    CancelMatchRequest,
    CreatePrivateMatchRequest,
    CreateRoomRequest,
    GameResponse,
    GameState,
    HandleDrawRequest,
    JoinMatchRequest,
    JoinPrivateMatchRequest,
    JoinRoomRequest,
    MatchJoinResponse,
    MatchStatusResponse,
    ReportChainGameRequest,
    RevealChoiceRequest,
    RoomResponse,
    RoomListResponse,
    SubmitCommitRequest,
    ToggleReadyRequest,
)
from backend.repository import get_game_record
from backend.service import game_manager, match_manager, room_manager


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


# ==================== 房间模式相关（必须放在参数化路径之前） ====================

@router.post("/room/create")
async def create_room(request: CreateRoomRequest):
    """创建房间（替代原来的寻找对手）"""
    result = room_manager.create_room(
        request.player_address,
        request.token.value,
        request.bet_amount,
    )

    if not result["success"]:
        raise HTTPException(status_code=400, detail=result.get("message", "创建房间失败"))

    return {
        "success": True,
        "room_id": result["room_id"],
        "message": result["message"],
    }


@router.post("/room/join")
async def join_room(request: JoinRoomRequest):
    """加入房间"""
    result = room_manager.join_room(
        request.room_id,
        request.player_address,
    )

    if not result["success"]:
        raise HTTPException(status_code=400, detail=result.get("message", "加入房间失败"))

    room = result["room"]
    return RoomResponse(
        room_id=room["room_id"],
        creator=room["creator"],
        player2=room.get("player2"),
        token=room["token"],
        bet_amount=room["bet_amount"],
        status=room["status"],
        creator_ready=room["creator_ready"],
        player2_ready=room["player2_ready"],
        created_at=room["created_at"],
        game_id=room.get("game_id"),
    )


@router.post("/room/ready")
async def toggle_ready(request: ToggleReadyRequest):
    """准备/取消准备"""
    result = room_manager.toggle_ready(
        request.room_id,
        request.player_address,
    )

    if not result["success"]:
        raise HTTPException(status_code=400, detail=result.get("message", "操作失败"))

    room = result["room"]
    return RoomResponse(
        room_id=room["room_id"],
        creator=room["creator"],
        player2=room.get("player2"),
        token=room["token"],
        bet_amount=room["bet_amount"],
        status=room["status"],
        creator_ready=room["creator_ready"],
        player2_ready=room["player2_ready"],
        created_at=room["created_at"],
        game_id=room.get("game_id"),
    )


@router.get("/room/list", response_model=RoomListResponse)
async def get_room_list():
    """获取交易大厅房间列表"""
    rooms = room_manager.get_room_list()

    room_responses = []
    for room in rooms:
        room_responses.append(RoomResponse(
            room_id=room["room_id"],
            creator=room["creator"],
            player2=room.get("player2"),
            token=room["token"],
            bet_amount=room["bet_amount"],
            status=room["status"],
            creator_ready=room["creator_ready"],
            player2_ready=room["player2_ready"],
            created_at=room["created_at"],
            game_id=room.get("game_id"),
        ))

    return RoomListResponse(
        rooms=room_responses,
        total=len(room_responses),
    )


@router.get("/room/{room_id}")
async def get_room(room_id: str):
    """获取房间信息"""
    room = room_manager.get_room(room_id)

    if not room:
        return {"success": False, "message": "房间不存在或已关闭"}

    return RoomResponse(
        room_id=room["room_id"],
        creator=room["creator"],
        player2=room.get("player2"),
        token=room["token"],
        bet_amount=room["bet_amount"],
        status=room["status"],
        creator_ready=room["creator_ready"],
        player2_ready=room["player2_ready"],
        created_at=room["created_at"],
        game_id=room.get("game_id"),
    )


@router.post("/room/{room_id}/chain-game")
async def report_chain_game(room_id: str, request: ReportChainGameRequest):
    """
    创建者上报链上对局 ID

    房间模式倒计时结束后，创建者调用合约 createMatch 创建链上对局，
    然后通过此接口上报 chain_game_id，后端会通知 player2 加入链上对局。
    """
    result = await room_manager.report_chain_game(
        room_id, request.player_address, request.chain_game_id
    )

    if not result.get("success"):
        raise HTTPException(status_code=400, detail=result.get("message", "上报失败"))

    return result


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
    """
    创建私密对局（模式B）

    模式B 的对局创建由前端直接调用链上合约 createMatch 完成，
    此端点仅用于记录链下匹配意图，便于后端追踪对局状态。
    """
    return {
        "success": True,
        "message": "私密对局由前端直接调用链上合约创建，后端通过事件监听自动同步",
        "status": "chain_only",
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


# ==================== 参数化路径（必须放在最后） ====================

@router.post("/{match_id}/join")
async def join_private_match(match_id: int, request: JoinPrivateMatchRequest):
    """加入私密对局"""
    if request.match_id != match_id:
        raise HTTPException(status_code=400, detail="match_id mismatch")

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