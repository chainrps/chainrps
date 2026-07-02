"""
数据模型定义
"""
from pydantic import BaseModel
from typing import Optional, List
from enum import Enum
from datetime import datetime


class Choice(str, Enum):
    ROCK = "rock"
    PAPER = "paper"
    SCISSORS = "scissors"


class GameState(str, Enum):
    WAITING = "waiting"           # 等待玩家加入
    COMMIT_PHASE = "commit"       # 提交哈希阶段
    REVEAL_PHASE = "reveal"       # 揭晓阶段
    FINISHED = "finished"         # 已结算
    CANCELLED = "cancelled"       # 已取消
    DRAW = "draw"                 # 平局


class Token(str, Enum):
    USDC = "USDC"
    USDT = "USDT"


# API 请求模型
class CreateGameRequest(BaseModel):
    token: Token
    bet_amount: float
    player_address: str


class JoinGameRequest(BaseModel):
    game_id: int
    player_address: str


class CancelMatchRequest(BaseModel):
    player_address: str
    token: Token
    bet_amount: float


class SubmitCommitRequest(BaseModel):
    game_id: int
    player_address: str
    commit_hash: str


class RevealChoiceRequest(BaseModel):
    game_id: int
    player_address: str
    choice: Choice
    salt: int


class HandleDrawRequest(BaseModel):
    game_id: int
    player_address: str
    action: str  # "refund" or "rematch"


# API 响应模型
class GameResponse(BaseModel):
    game_id: int
    player1: Optional[str]
    player2: Optional[str]
    token: str
    bet_amount: float
    state: GameState
    created_at: datetime
    commit_deadline: Optional[datetime]
    reveal_deadline: Optional[datetime]
    winner: Optional[str]
    is_draw: bool


class MatchStatusResponse(BaseModel):
    is_matching: bool
    queue_position: Optional[int]
    estimated_wait: Optional[int]  # 秒


class PlayerHistoryResponse(BaseModel):
    games: List[GameResponse]
    total_games: int
    wins: int
    losses: int
    draws: int


class BalanceResponse(BaseModel):
    address: str
    usdc: float
    usdt: float


# WebSocket 消息模型
class WSMessage(BaseModel):
    type: str  # "match_success", "opponent_commit", "reveal_start", "game_result", "timeout_warning"
    data: dict
    timestamp: datetime = datetime.utcnow()


# 数据库模型（用于 SQLite）
class GameRecord:
    """对局记录表结构"""
    table_name = "games"
    
    columns = {
        "id": "INTEGER PRIMARY KEY AUTOINCREMENT",
        "chain_game_id": "INTEGER",  # 链上对局ID
        "player1": "TEXT",
        "player2": "TEXT",
        "token": "TEXT",
        "bet_amount": "REAL",
        "state": "TEXT",
        "commit1": "TEXT",
        "commit2": "TEXT",
        "choice1": "TEXT",
        "choice2": "TEXT",
        "salt1": "INTEGER",
        "salt2": "INTEGER",
        "winner": "TEXT",
        "is_draw": "INTEGER",
        "created_at": "TEXT",
        "commit_deadline": "TEXT",
        "reveal_deadline": "TEXT",
        "finished_at": "TEXT",
        "tx_hash": "TEXT",
    }


class PlayerRecord:
    """玩家记录表结构"""
    table_name = "players"
    
    columns = {
        "id": "INTEGER PRIMARY KEY AUTOINCREMENT",
        "address": "TEXT UNIQUE",
        "total_games": "INTEGER DEFAULT 0",
        "wins": "INTEGER DEFAULT 0",
        "losses": "INTEGER DEFAULT 0",
        "draws": "INTEGER DEFAULT 0",
        "total_wagered": "REAL DEFAULT 0",
        "total_won": "REAL DEFAULT 0",
        "first_played_at": "TEXT",
        "last_played_at": "TEXT",
    }