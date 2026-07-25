"""
ChainRPS 数据模型定义模块

定义 API 请求/响应模型、WebSocket 消息模型以及游戏相关枚举。
基于 Pydantic v2 实现，用于 FastAPI 请求校验与序列化。
"""
from datetime import datetime
from enum import Enum
from typing import List, Optional

from pydantic import BaseModel


# ==================== 枚举定义 ====================
class Choice(str, Enum):
    """出拳选择"""
    ROCK = "rock"          # 石头
    PAPER = "paper"        # 布
    SCISSORS = "scissors"  # 剪刀


class GameState(str, Enum):
    """对局状态"""
    WAITING = "waiting"          # 等待玩家加入
    COMMIT_PHASE = "commit"      # 提交哈希阶段
    REVEAL_PHASE = "reveal"      # 揭晓阶段
    FINISHED = "finished"        # 已结算
    CANCELLED = "cancelled"       # 已取消
    DRAW = "draw"                 # 平局


class Token(str, Enum):
    """下注代币类型"""
    USDC = "USDC"
    USDT = "USDT"


# ==================== API 请求模型 ====================
class JoinMatchRequest(BaseModel):
    """加入公共匹配队列请求"""
    token: Token
    bet_amount: float
    player_address: str


class CreatePrivateMatchRequest(BaseModel):
    """创建私人对局请求"""
    token: Token
    bet_amount: float
    player_address: str


class JoinPrivateMatchRequest(BaseModel):
    """加入私人对局请求"""
    match_id: int
    player_address: str


class CancelMatchRequest(BaseModel):
    """取消匹配请求"""
    player_address: str
    token: Token
    bet_amount: float


class SubmitCommitRequest(BaseModel):
    """提交哈希承诺请求"""
    game_id: int
    player_address: str
    commit_hash: str


class RevealChoiceRequest(BaseModel):
    """揭晓出拳请求

    salt 为 bytes32 的 hex 字符串
    """
    game_id: int
    player_address: str
    choice: Choice
    salt: str


class HandleDrawRequest(BaseModel):
    """处理平局请求"""
    game_id: int
    player_address: str


# ==================== API 响应模型 ====================
class MatchJoinResponse(BaseModel):
    """匹配加入响应"""
    success: bool
    matched: bool
    queue_id: Optional[str] = None
    game_id: Optional[int] = None
    opponent: Optional[str] = None


class GameResponse(BaseModel):
    """对局详情响应"""
    game_id: int
    player1: Optional[str] = None
    player2: Optional[str] = None
    token: str
    bet_amount: float
    state: GameState
    created_at: datetime
    commit_deadline: Optional[datetime] = None
    reveal_deadline: Optional[datetime] = None
    winner: Optional[str] = None
    is_draw: bool


class MatchStatusResponse(BaseModel):
    """匹配状态响应"""
    is_matching: bool
    queue_position: Optional[int] = None
    estimated_wait: Optional[int] = None  # 预计等待秒数


class PlayerHistoryResponse(BaseModel):
    """玩家对局历史响应"""
    games: List[GameResponse]
    total_games: int
    wins: int
    losses: int
    draws: int


class PlayerStatsResponse(BaseModel):
    """玩家统计响应"""
    address: str
    total_games: int
    wins: int
    losses: int
    draws: int
    win_rate: float
    total_wagered: float
    total_won: float


# ==================== WebSocket 消息模型 ====================
class WSMessage(BaseModel):
    """WebSocket 推送消息

    type 取值如: "match_success", "opponent_commit", "reveal_start",
    "game_result", "timeout_warning"
    """
    type: str
    data: dict
    timestamp: datetime = datetime.utcnow


__all__ = [
    # 枚举
    "Choice",
    "GameState",
    "Token",
    # 请求模型
    "JoinMatchRequest",
    "CreatePrivateMatchRequest",
    "JoinPrivateMatchRequest",
    "CancelMatchRequest",
    "SubmitCommitRequest",
    "RevealChoiceRequest",
    "HandleDrawRequest",
    # 响应模型
    "MatchJoinResponse",
    "GameResponse",
    "MatchStatusResponse",
    "PlayerHistoryResponse",
    "PlayerStatsResponse",
    # WebSocket 消息
    "WSMessage",
]
