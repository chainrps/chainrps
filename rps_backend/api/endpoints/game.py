"""
游戏相关 API 端点

定义 ChainRPS 后端的游戏匹配、对局查询、提交承诺、揭晓出拳、
处理平局等接口。所有接口路径以 /game 为前缀，最终通过 main.py
挂载到 /api 前缀下，形成 /api/game/... 的完整路径。
"""
from datetime import datetime

from fastapi import APIRouter, HTTPException

from rps_backend.models import (
    CancelMatchRequest,
    CreatePrivateMatchRequest,
    CreateRoomRequest,
    GameResponse,
    GameState,
    HandleDrawRequest,
    JoinMatchRequest,
    JoinPrivateMatchRequest,
    JoinRoomRequest,
    LeaveRoomRequest,
    MatchJoinResponse,
    MatchStatusResponse,
    ReportChainGameRequest,
    ResetRoomRequest,
    RevealChoiceRequest,
    RoomResponse,
    RoomListResponse,
    SubmitCommitRequest,
    ToggleReadyRequest,
    # 方案A：EIP-712 签名代提交
    SubmitCommitSigRequest,
    RevealChoiceSigRequest,
    # 方案B：Relayer 长期授权
    AuthorizeRelayerRequest,
)
from rps_backend.repository import get_game_record
from rps_backend.service import game_manager, match_manager, room_manager
from rps_backend.service.relayer_service import relayer_service


# 游戏相关路由，统一前缀 /game
router = APIRouter(prefix="/game", tags=["game"])


# 构造游戏响应
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

# 创建房间
@router.post("/room/create")
async def create_room(request: CreateRoomRequest):
    """创建房间（替代原来的寻找对手）"""
    result = room_manager.create_room(
        request.player_address,
        request.token.value,
        request.bet_amount,
    )

    if not result["success"]:
        response = {
            "success": False,
            "message": result.get("message", "创建房间失败"),
        }
        if "existing_room_id" in result:
            response["existing_room_id"] = result["existing_room_id"]
        return response

    return {
        "success": True,
        "room_id": result["room_id"],
        "message": result["message"],
    }


# 加入房间
@router.post("/room/join")
async def join_room(request: JoinRoomRequest):
    """加入房间"""
    result = room_manager.join_room(
        request.room_id,
        request.player_address,
    )

    if not result["success"]:
        response = {
            "success": False,
            "message": result.get("message", "加入房间失败"),
        }
        if "existing_room_id" in result:
            response["existing_room_id"] = result["existing_room_id"]
        return response

    room = result["room"]
    return {
        "success": True,
        "room_id": room["room_id"],
        "room": RoomResponse(
            room_id=room["room_id"],
            creator=room["creator"],
            player2=room.get("player2"),
            token=room["token"],
            bet_amount=room["bet_amount"],
            status=room["status"],
            creator_ready=room["creator_ready"],
            player2_ready=room["player2_ready"],
            created_at=room["created_at"],
            countdown_start=room.get("countdown_start"),
            game_started_at=room.get("game_started_at"),
            game_id=room.get("game_id"),
            chain_game_id=room.get("chain_game_id"),
            close_reason=room.get("close_reason"),
            closed_at=room.get("closed_at"),
            fund_stage=room.get("fund_stage"),
        ),
    }


# 准备/取消准备
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
        countdown_start=room.get("countdown_start"),
        game_id=room.get("game_id"),
        chain_game_id=room.get("chain_game_id"),
    )


# 退出房间
@router.post("/room/leave")
async def leave_room(request: LeaveRoomRequest):
    """
    退出房间

    - 创建者退出 → 解散房间（从游戏大厅移除）
    - player2 退出 → 房间重置为 CREATED 状态，保留在游戏大厅
    - 游戏已开始 → 不允许退出，需走索赔流程
    """
    result = room_manager.leave_room(
        request.room_id,
        request.player_address,
    )

    if not result.get("success"):
        raise HTTPException(status_code=400, detail=result.get("message", "退出失败"))

    return {
        "success": True,
        "action": result.get("action"),
        "message": result.get("message"),
    }


# 结算后重置房间（再来一局）
@router.post("/room/reset-rematch")
async def reset_room_for_rematch(request: ResetRoomRequest):
    """
    结算后重置房间以开启下一局（再来一局）。

    - 保留两位玩家不变，清除 game_id/准备状态，回到 JOINED/CREATED。
    房间内的双方都会收到 room_reset_for_rematch WS 事件通知。
    """
    result = room_manager.reset_room_for_rematch(
        request.room_id,
        request.player_address,
    )
    if not result.get("success"):
        raise HTTPException(status_code=400, detail=result.get("message", "重置失败"))
    return result


# 获取房间列表
@router.get("/room/list", response_model=RoomListResponse)
async def get_room_list():
    """获取游戏大厅房间列表"""
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
            countdown_start=room.get("countdown_start"),
            game_started_at=room.get("game_started_at"),
            game_id=room.get("game_id"),
            chain_game_id=room.get("chain_game_id"),
            close_reason=room.get("close_reason"),
            closed_at=room.get("closed_at"),
            fund_stage=room.get("fund_stage"),
        ))

    return RoomListResponse(
        rooms=room_responses,
        total=len(room_responses),
    )


# 获取玩家房间
@router.get("/room/player/{player_address}")
async def get_player_room(player_address: str):
    """
    查询玩家当前所在的房间

    用于断网重连/刷新页面时，自动回到之前的房间。
    返回房间信息，如果不在任何房间中则返回 success=False
    """
    room = room_manager.get_player_room(player_address)

    if not room:
        return {"success": False, "message": "玩家当前不在任何房间中"}

    return {
        "success": True,
        "room": RoomResponse(
            room_id=room["room_id"],
            creator=room["creator"],
            player2=room.get("player2"),
            token=room["token"],
            bet_amount=room["bet_amount"],
            status=room["status"],
            creator_ready=room["creator_ready"],
            player2_ready=room["player2_ready"],
            created_at=room["created_at"],
            countdown_start=room.get("countdown_start"),
            game_started_at=room.get("game_started_at"),
            game_id=room.get("game_id"),
            chain_game_id=room.get("chain_game_id"),
            close_reason=room.get("close_reason"),
            closed_at=room.get("closed_at"),
            fund_stage=room.get("fund_stage"),
        ),
    }


# 获取房间信息
@router.get("/room/{room_id}")
async def get_room(room_id: str):
    """获取房间信息"""
    room = room_manager.get_room(room_id)

    if not room:
        return {"success": False, "message": "房间不存在或已关闭"}

    # 已关闭的房间视为不存在
    if room.get("status") == "closed":
        return {"success": False, "message": "房间已解散"}

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
        countdown_start=room.get("countdown_start"),
        game_id=room.get("game_id"),
        chain_game_id=room.get("chain_game_id"),
        close_reason=room.get("close_reason"),
        closed_at=room.get("closed_at"),
    )


# 上报链上对局ID
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


# ==================== 调试 / MOCK 接口 ====================

# 创建模拟游戏
@router.post("/debug/mock-game")
async def mock_game(request: dict):
    """
    调试用：直接进入游戏出拳阶段（无需链上交互）

    前端可以调用此接口来直接查看游戏界面效果。
    返回一个模拟的房间数据，前端收到后直接进入出拳界面。
    """
    from rps_backend.utils.helpers import now_timestamp
    import uuid

    player_address = request.get("player_address", "0xMockPlayer1234567890")
    opponent_address = request.get("opponent_address", "0xMockOpponent1234567890")
    token = request.get("token", "USDC")
    bet_amount = request.get("bet_amount", 100)
    phase = request.get("phase", "commit")  # commit / reveal / result

    room_id = f"DEBUG-{uuid.uuid4().hex[:8].upper()}"
    now = now_timestamp()

    mock_room = {
        "room_id": room_id,
        "creator": player_address,
        "player2": opponent_address,
        "token": token,
        "bet_amount": bet_amount,
        "status": "game_started",
        "creator_ready": True,
        "player2_ready": True,
        "created_at": now - 120,
        "countdown_start": now - 105,
        "game_started_at": now - 90,
        "game_id": 99999,
        "chain_game_id": 88888,
        "is_creator": True,
        "opponent": opponent_address,
        "mock_phase": phase,
        "commit_deadline": now + 300,
        "reveal_deadline": now + 600,
    }

    return {
        "success": True,
        "room": mock_room,
        "message": "MOCK 游戏已创建（仅用于界面调试）",
    }


# 获取模拟UI数据
@router.get("/debug/mock-ui/{stage}")
async def mock_ui_stage(stage: str):
    """
    调试用：直接查看指定界面的模拟数据

    stage 可选值：
    - lobby: 大厅
    - room_wait: 房间等待中
    - countdown: 倒计时中
    - game_commit: 游戏提交阶段（出拳）
    - game_reveal: 游戏揭晓阶段
    - result_win: 胜利结果
    - result_lose: 失败结果
    - result_draw: 平局结果
    """
    from rps_backend.utils.helpers import now_timestamp
    import uuid

    now = now_timestamp()
    room_id = f"DEBUG-{uuid.uuid4().hex[:8].upper()}"

    base_room = {
        "room_id": room_id,
        "creator": "0xMockPlayer1234567890",
        "player2": "0xMockOpponent1234567890",
        "token": "USDC",
        "bet_amount": 100,
        "status": "joined",
        "creator_ready": False,
        "player2_ready": False,
        "created_at": now - 60,
        "countdown_start": None,
        "game_started_at": None,
        "game_id": None,
        "chain_game_id": None,
    }

    stages = {
        "lobby": {
            "rooms": [
                {**base_room, "room_id": "ROOM-A1B2C3", "creator": "0xAlice1234...", "bet_amount": 50},
                {**base_room, "room_id": "ROOM-D4E5F6", "creator": "0xBob5678...", "bet_amount": 100},
                {**base_room, "room_id": "ROOM-G7H8I9", "creator": "0xCarol9012...", "bet_amount": 200},
            ],
            "total": 3,
        },
        "room_wait": {
            **base_room,
            "status": "joined",
            "creator_ready": True,
            "player2_ready": False,
        },
        "countdown": {
            **base_room,
            "status": "countdown",
            "creator_ready": True,
            "player2_ready": True,
            "countdown_start": now - 5,
        },
        "game_commit": {
            **base_room,
            "status": "game_started",
            "creator_ready": True,
            "player2_ready": True,
            "countdown_start": now - 20,
            "game_started_at": now - 5,
            "game_id": 99999,
            "chain_game_id": 88888,
            "is_creator": True,
            "opponent": base_room["player2"],
            "commit_deadline": now + 300,
            "mock_phase": "commit",
        },
        "game_reveal": {
            **base_room,
            "status": "game_started",
            "creator_ready": True,
            "player2_ready": True,
            "game_id": 99999,
            "chain_game_id": 88888,
            "is_creator": True,
            "opponent": base_room["player2"],
            "reveal_deadline": now + 180,
            "mock_phase": "reveal",
            "my_choice": 1,
            "opponent_committed": True,
        },
        "result_win": {
            "result": "win",
            "my_choice": 1,
            "opponent_choice": 3,
            "amount": 100,
            "prize": 196,
            "fee": 4,
            "token": "USDC",
        },
        "result_lose": {
            "result": "lose",
            "my_choice": 3,
            "opponent_choice": 1,
            "amount": 100,
            "prize": 0,
            "fee": 0,
            "token": "USDC",
        },
        "result_draw": {
            "result": "draw",
            "my_choice": 1,
            "opponent_choice": 1,
            "amount": 100,
            "prize": 100,
            "fee": 0,
            "token": "USDC",
        },
    }

    if stage not in stages:
        return {"success": False, "message": f"未知阶段: {stage}，可选：{', '.join(stages.keys())}"}

    return {"success": True, "stage": stage, "data": stages[stage]}


# ==================== 匹配相关 ====================

# 加入匹配队列
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


# 创建私密对局
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


# 取消匹配
@router.post("/cancel")
async def cancel_match(request: CancelMatchRequest):
    """取消匹配"""
    removed = await match_manager.cancel_match(
        request.player_address,
        request.token.value,
        request.bet_amount,
    )

    return {"success": True, "cancelled": removed}


# 获取匹配状态
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


# ==================== 方案A：EIP-712 签名代提交 ====================

# 代提交 commit（玩家签名授权 relayer 代为上链）
@router.post("/submit-commit-sig")
async def submit_commit_with_sig(request: SubmitCommitSigRequest):
    """代提交 commit（方案A）

    玩家用 EIP-712 链下签名授权，relayer 调用合约 submitCommitWithSig 代为上链。
    无需玩家亲自发交易，无 gas 费，秒级完成。
    """
    if not relayer_service.is_available():
        return {"success": False, "message": "代提交服务未启用（未配置 RELAYER_PRIVATE_KEY）"}

    result = await relayer_service.submit_commit_with_sig(
        game_id=request.game_id,
        player=request.player_address,
        commit_hash=request.commit_hash,
        nonce=request.nonce,
        v=request.v,
        r=request.r,
        s=request.s,
    )
    return result


# 代提交 reveal（玩家签名授权 relayer 代为上链揭晓）
@router.post("/reveal-choice-sig")
async def reveal_choice_with_sig(request: RevealChoiceSigRequest):
    """代提交 reveal（方案A）

    玩家用 EIP-712 链下签名授权，relayer 调用合约 revealChoiceWithSig 代为上链揭晓。
    reveal 数据一次性上链完成结算。
    """
    if not relayer_service.is_available():
        return {"success": False, "message": "代提交服务未启用（未配置 RELAYER_PRIVATE_KEY）"}

    # 参数校验：choice 必须 1-3
    if request.choice not in (1, 2, 3):
        return {"success": False, "message": "出拳无效（1=石头, 2=布, 3=剪刀）"}

    result = await relayer_service.reveal_choice_with_sig(
        game_id=request.game_id,
        player=request.player_address,
        choice=request.choice,
        salt=request.salt,
        nonce=request.nonce,
        v=request.v,
        r=request.r,
        s=request.s,
    )
    return result


# ==================== 方案B：Relayer 长期授权 ====================

# 获取 relayer 地址（前端用此地址调用合约 authorizeRelayer）
@router.get("/relayer/address")
async def get_relayer_address():
    """获取 relayer 钱包地址

    前端拿到此地址后调用合约 authorizeRelayer(relayerAddress, 0) 授权 7 天。
    """
    addr = relayer_service.get_relayer_address()
    if not addr:
        return {"success": False, "message": "Relayer 未配置", "available": False}
    return {"success": True, "available": True, "relayer_address": addr}


# 查询玩家 relayer 授权状态
@router.get("/relayer/authorization/{player_address}")
async def get_relayer_authorization(player_address: str):
    """查询玩家的 relayer 授权状态（方案B）"""
    result = await relayer_service.get_relayer_authorization(player_address)
    return {"success": True, **result}


# 查询 relayer 健康状态（F1-05：Gasless 开关 + 降级）
@router.get("/relayer/status")
async def get_relayer_status():
    """
    查询 Relayer 健康状态（F1-05）

    返回：
    - success: 检测动作是否完成
    - available: Relayer 是否已初始化（配置是否就绪）
    - healthy: 综合健康判定（RPC 可达 + 余额充足 + nonce 同步）
    - gasless_available: 前端是否可使用 gasless 模式（等同于 healthy）
    - rpc_reachable / balance_sufficient / nonce_synced: 分项状态
    - balance_wei: relayer 钱包余额（wei 字符串）
    - local_nonce / chain_nonce: 本地与链上 nonce
    - last_check: 上次检测时间（UTC ISO）
    - error: 不健康时的原因

    前端可定期轮询此端点；当 healthy 由 true 变为 false 时，
    后端会通过 WebSocket 推送 type="relayer_status_changed" 消息通知前端降级。
    本端点不返回任何私钥或敏感信息（S1-02）。
    """
    status = relayer_service.get_health_status()
    return {
        "success": True,
        "available": status.get("available", False),
        "healthy": status.get("healthy", False),
        "gasless_available": status.get("healthy", False),
        "rpc_reachable": status.get("rpc_reachable", False),
        "balance_sufficient": status.get("balance_sufficient", False),
        "nonce_synced": status.get("nonce_synced", False),
        "balance_wei": status.get("balance_wei", "0"),
        "local_nonce": status.get("local_nonce", 0),
        "chain_nonce": status.get("chain_nonce", 0),
        "last_check": status.get("last_check"),
        "error": status.get("error"),
        "relayer_address": relayer_service.get_relayer_address(),
    }


# 手动触发一次 Relayer 健康检测（运维/前端降级排查用）
@router.post("/relayer/status/check")
async def trigger_relayer_health_check():
    """
    手动触发一次 Relayer 健康检测（F1-05）

    通常后端周期性自动检测（60 秒一次），此端点供运维或前端在关键操作前主动触发。
    检测完成后若状态翻转，仍会通过 WebSocket 通知前端降级/恢复。
    """
    status = await relayer_service.check_health()
    return {
        "success": True,
        "healthy": status.get("healthy", False),
        "gasless_available": status.get("healthy", False),
        "error": status.get("error"),
        "last_check": status.get("last_check"),
    }


# ==================== 游戏流程相关 ====================

# 提交哈希承诺
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


# 揭晓出拳
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


# 处理平局
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

# 加入私密对局
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


# 查询对局状态
@router.get("/{match_id}", response_model=GameResponse)
async def get_game(match_id: int):
    """查询对局状态"""
    game = get_game_record(match_id)

    if not game:
        raise HTTPException(status_code=404, detail="Game not found")

    return _build_game_response(game)