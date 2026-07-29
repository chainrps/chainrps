"""
ChainRPS 数据模型定义模块

定义 API 请求/响应模型、WebSocket 消息模型以及游戏相关枚举。
基于 Pydantic v2 实现，用于 FastAPI 请求校验与序列化。
"""
from datetime import datetime
from enum import Enum
from typing import List, Optional

from pydantic import BaseModel, Field


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
    ETH = "ETH"
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


# ==================== 方案A：EIP-712 签名代提交请求 ====================

class SubmitCommitSigRequest(BaseModel):
    """代提交 commit 请求（方案A）

    玩家用 EIP-712 链下签名授权 relayer 代为上链 submitCommitWithSig。
    r/s 为 bytes32 的 hex 字符串。
    """
    game_id: int
    player_address: str
    commit_hash: str
    nonce: int
    v: int
    r: str
    s: str


class RevealChoiceSigRequest(BaseModel):
    """代提交 reveal 请求（方案A）

    玩家用 EIP-712 链下签名授权 relayer 代为上链 revealChoiceWithSig。
    salt 为 bytes32 的 hex 字符串。
    """
    game_id: int
    player_address: str
    choice: int  # 1=石头, 2=布, 3=剪刀
    salt: str
    nonce: int
    v: int
    r: str
    s: str


class AuthorizeRelayerRequest(BaseModel):
    """查询/授权 relayer 请求（方案B）"""
    player_address: str
    duration: int = 0  # 0 表示默认 7 天


class HandleDrawRequest(BaseModel):
    """处理平局请求"""
    game_id: int
    player_address: str


# ==================== 房间模式模型 ====================
class CreateRoomRequest(BaseModel):
    """创建房间请求"""
    token: Token
    bet_amount: float
    player_address: str


class JoinRoomRequest(BaseModel):
    """加入房间请求"""
    room_id: str
    player_address: str


class ToggleReadyRequest(BaseModel):
    """准备/取消准备请求"""
    room_id: str
    player_address: str


class LeaveRoomRequest(BaseModel):
    """退出房间请求"""
    room_id: str
    player_address: str


class ResetRoomRequest(BaseModel):
    """重置房间（再来一局）请求"""
    room_id: str
    player_address: str


class ReportChainGameRequest(BaseModel):
    """上报链上对局 ID 请求"""
    chain_game_id: int
    player_address: str


class RoomResponse(BaseModel):
    """房间信息响应"""
    room_id: str
    creator: str
    player2: Optional[str] = None
    token: str
    bet_amount: float
    status: str
    creator_ready: bool
    player2_ready: bool
    created_at: int
    countdown_start: Optional[int] = None
    game_started_at: Optional[int] = None
    game_id: Optional[int] = None
    chain_game_id: Optional[int] = None
    close_reason: Optional[str] = None
    closed_at: Optional[int] = None
    fund_stage: Optional[str] = None


class RoomListResponse(BaseModel):
    """房间列表响应"""
    rooms: List[RoomResponse]
    total: int


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
    timestamp: datetime = Field(default_factory=datetime.utcnow)


# ==================== 用户配置模型 ====================
class UserProfile(BaseModel):
    """用户个人资料"""
    address: str
    nickname: Optional[str] = None
    avatar: Optional[str] = None
    theme: str = "light"
    default_mode: str = "A"
    default_token: str = "USDC"
    notifications_enabled: bool = True
    sound_enabled: bool = True
    auto_reveal: bool = False
    timeout_choice: str = "random"


class UserPreferencesUpdate(BaseModel):
    """用户偏好更新请求"""
    nickname: Optional[str] = None
    avatar: Optional[str] = None
    theme: Optional[str] = None
    default_mode: Optional[str] = None
    default_token: Optional[str] = None
    notifications_enabled: Optional[bool] = None
    sound_enabled: Optional[bool] = None
    auto_reveal: Optional[bool] = None
    timeout_choice: Optional[str] = None


class ThemeUpdateRequest(BaseModel):
    """主题更新请求"""
    theme: str
    address: str


class NotificationSettings(BaseModel):
    """通知设置"""
    address: str
    enabled: bool


# ==================== 管理员/系统配置模型 ====================
class SystemConfigItem(BaseModel):
    """系统配置项"""
    config_key: str
    config_value: str
    category: Optional[str] = None
    description: Optional[str] = None
    updated_by: Optional[str] = None
    updated_at: Optional[datetime] = None
    default_value: Optional[str] = None


class SystemConfigUpdate(BaseModel):
    """系统配置更新请求"""
    value: str
    admin_address: Optional[str] = None


class SystemConfigBatchUpdate(BaseModel):
    """批量更新系统配置"""
    items: dict
    admin_address: Optional[str] = None


# ==================== 合约管理模型 ====================
class ContractRecord(BaseModel):
    """合约记录"""
    id: Optional[int] = None
    name: str
    address: str
    abi: Optional[str] = None
    bytecode: Optional[str] = None
    version: str = "v1.0.0"
    network: Optional[str] = None
    deployed_by: Optional[str] = None
    deployed_at: Optional[datetime] = None
    status: str = "active"
    description: Optional[str] = None


class ContractDeployRequest(BaseModel):
    """合约部署请求"""
    name: str
    network: str
    private_key: str
    fee_collector: Optional[str] = None
    developer: Optional[str] = None


class ContractAbiUpdate(BaseModel):
    """ABI 更新请求"""
    abi: str
    admin_address: Optional[str] = None


# ==================== 审计日志模型 ====================
class AuditLogEntry(BaseModel):
    """审计日志条目"""
    id: Optional[int] = None
    admin_address: str
    action: str
    target: Optional[str] = None
    old_value: Optional[str] = None
    new_value: Optional[str] = None
    tx_hash: Optional[str] = None
    ip_address: Optional[str] = None
    created_at: Optional[datetime] = None


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
    # 房间模式模型
    "CreateRoomRequest",
    "JoinRoomRequest",
    "ToggleReadyRequest",
    "LeaveRoomRequest",
    "ResetRoomRequest",
    "ReportChainGameRequest",
    "RoomResponse",
    "RoomListResponse",
    # 响应模型
    "MatchJoinResponse",
    "GameResponse",
    "MatchStatusResponse",
    "PlayerHistoryResponse",
    "PlayerStatsResponse",
    # WebSocket 消息
    "WSMessage",
    # 用户配置模型
    "UserProfile",
    "UserPreferencesUpdate",
    "ThemeUpdateRequest",
    "NotificationSettings",
    # 管理员/系统配置模型
    "SystemConfigItem",
    "SystemConfigUpdate",
    "SystemConfigBatchUpdate",
    # 合约管理模型
    "ContractRecord",
    "ContractDeployRequest",
    "ContractAbiUpdate",
    # 审计日志模型
    "AuditLogEntry",
]