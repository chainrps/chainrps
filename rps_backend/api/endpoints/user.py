"""
用户相关 API 端点

定义 ChainRPS 后端的玩家历史记录查询、玩家统计、玩家对局列表、
用户配置管理等接口。由于 /history 与 /player 路径前缀不统一，
本路由不设置统一前缀，由 routes.py 聚合后统一挂载到 /api 前缀下。
"""
from datetime import datetime

from fastapi import APIRouter, HTTPException

from rps_backend.models import (
    GameResponse,
    GameState,
    NotificationSettings,
    PlayerHistoryResponse,
    PlayerStatsResponse,
    ThemeUpdateRequest,
    UserPreferencesUpdate,
    UserProfile,
)
from rps_backend.repository import (
    get_player_games,
    get_player_games_count,
    get_player_stats,
    get_user_preferences,
    set_user_notifications,
    set_user_theme,
    update_user_preferences,
)


# 用户相关路由，不设统一前缀（/history 与 /player 路径不统一）
router = APIRouter(prefix="", tags=["user"])


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


# ==================== 历史记录 ====================

# 查询历史记录
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

# 获取玩家统计
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

# 获取玩家对局列表
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


# ==================== 用户个人资料 ====================

# 获取用户个人资料
@router.get("/user/profile/{address}", response_model=UserProfile)
async def get_user_profile(address: str):
    """获取用户个人资料"""
    prefs = get_user_preferences(address)
    if prefs:
        return UserProfile(
            address=address,
            nickname=prefs.get("nickname"),
            avatar=prefs.get("avatar"),
            theme=prefs.get("theme", "light"),
            default_mode=prefs.get("default_mode", "A"),
            default_token=prefs.get("default_token", "USDC"),
            notifications_enabled=bool(prefs.get("notifications_enabled", 1)),
            sound_enabled=bool(prefs.get("sound_enabled", 1)),
            auto_reveal=bool(prefs.get("auto_reveal", 0)),
            timeout_choice=prefs.get("timeout_choice", "random"),
        )
    return UserProfile(address=address)


# 更新用户个人资料
@router.put("/user/profile/{address}")
async def update_user_profile(address: str, body: UserPreferencesUpdate):
    """更新用户个人资料"""
    updates = {}
    for field_name, value in body.model_dump().items():
        if value is not None:
            if field_name in ("notifications_enabled", "sound_enabled", "auto_reveal"):
                updates[field_name] = 1 if value else 0
            else:
                updates[field_name] = value

    update_user_preferences(address, updates)
    return {"success": True, "message": "Profile updated"}


# ==================== 用户偏好设置 ====================

# 获取用户偏好设置
@router.get("/user/preferences/{address}")
async def get_user_prefs(address: str):
    """获取用户偏好设置"""
    prefs = get_user_preferences(address)
    if prefs:
        return {"success": True, "preferences": prefs}
    return {"success": True, "preferences": {}}


# 更新用户偏好设置
@router.put("/user/preferences/{address}")
async def update_user_prefs(address: str, body: UserPreferencesUpdate):
    """更新用户偏好设置"""
    updates = {}
    for field_name, value in body.model_dump().items():
        if value is not None:
            if field_name in ("notifications_enabled", "sound_enabled", "auto_reveal"):
                updates[field_name] = 1 if value else 0
            else:
                updates[field_name] = value

    if updates:
        update_user_preferences(address, updates)

    return {"success": True, "updated": list(updates.keys())}


# ==================== 主题设置 ====================

# 设置用户主题
@router.post("/user/theme")
async def set_theme(body: ThemeUpdateRequest):
    """设置用户主题"""
    if body.theme not in ("light", "dark"):
        raise HTTPException(status_code=400, detail="Invalid theme, must be 'light' or 'dark'")
    set_user_theme(body.address, body.theme)
    return {"success": True, "theme": body.theme}


# ==================== 通知设置 ====================

# 获取用户通知设置
@router.get("/user/notifications/{address}")
async def get_notification_settings(address: str):
    """获取用户通知设置"""
    prefs = get_user_preferences(address)
    enabled = bool(prefs.get("notifications_enabled", 1)) if prefs else True
    return {"address": address, "notifications_enabled": enabled}


# 更新用户通知设置
@router.put("/user/notifications/{address}")
async def update_notification_settings(address: str, body: NotificationSettings):
    """更新用户通知设置"""
    if body.address != address:
        raise HTTPException(status_code=400, detail="Address mismatch")
    set_user_notifications(address, body.enabled)
    return {"success": True, "notifications_enabled": body.enabled}