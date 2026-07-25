"""
SQLite 数据库管理模块（数据访问层）

负责 ChainRPS 后端的持久化数据存储，包含：
- 数据库连接管理
- 表与索引初始化
- 对局记录的增删改查
- 玩家统计的维护与查询

注意：本模块仅负责数据记录与缓存，不参与胜负判定，
胜负判定由链上合约完成，后端通过事件同步结果。
"""
import os
import sqlite3
from datetime import datetime
from typing import Optional, List

from ..config import DATABASE_PATH
from ..models import GameState


# ==================== 数据库连接 ====================

def get_connection():
    """
    获取数据库连接

    使用 sqlite3.Row 作为 row_factory，使查询结果可通过列名访问。
    同时确保数据库所在目录存在，避免首次启动时因目录缺失而失败。
    """
    db_dir = os.path.dirname(DATABASE_PATH)
    if db_dir:
        os.makedirs(db_dir, exist_ok=True)
    conn = sqlite3.connect(DATABASE_PATH)
    conn.row_factory = sqlite3.Row
    return conn


# ==================== 数据库初始化 ====================

def init_database():
    """
    初始化数据库表与索引

    创建 games（对局记录）和 players（玩家统计）两张表，
    以及针对常用查询字段的索引，保证重复调用时安全（IF NOT EXISTS）。
    """
    conn = get_connection()
    try:
        cursor = conn.cursor()

        # 创建对局记录表
        cursor.execute("""
            CREATE TABLE IF NOT EXISTS games (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                chain_game_id INTEGER,
                player1 TEXT,
                player2 TEXT,
                token TEXT,
                bet_amount REAL,
                state TEXT,
                commit1 TEXT,
                commit2 TEXT,
                choice1 TEXT,
                choice2 TEXT,
                salt1 TEXT,
                salt2 TEXT,
                winner TEXT,
                is_draw INTEGER,
                fee REAL,
                created_at TEXT,
                commit_deadline TEXT,
                reveal_deadline TEXT,
                finished_at TEXT,
                tx_hash TEXT
            )
        """)

        # 创建玩家统计表
        cursor.execute("""
            CREATE TABLE IF NOT EXISTS players (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                address TEXT UNIQUE,
                total_games INTEGER DEFAULT 0,
                wins INTEGER DEFAULT 0,
                losses INTEGER DEFAULT 0,
                draws INTEGER DEFAULT 0,
                total_wagered REAL DEFAULT 0,
                total_won REAL DEFAULT 0,
                first_played_at TEXT,
                last_played_at TEXT
            )
        """)

        # 创建索引以加速常用查询
        cursor.execute("CREATE INDEX IF NOT EXISTS idx_games_player1 ON games(player1)")
        cursor.execute("CREATE INDEX IF NOT EXISTS idx_games_player2 ON games(player2)")
        cursor.execute("CREATE INDEX IF NOT EXISTS idx_games_state ON games(state)")
        cursor.execute("CREATE INDEX IF NOT EXISTS idx_games_chain_game_id ON games(chain_game_id)")

        conn.commit()
    finally:
        conn.close()


# ==================== 对局记录操作 ====================

def create_game_record(game_data: dict) -> int:
    """
    创建对局记录

    game_data 至少包含 player1、token、bet_amount 三个字段。
    初始状态置为 WAITING，created_at 使用当前 UTC 时间。
    返回新创建的对局 ID。
    """
    conn = get_connection()
    try:
        cursor = conn.cursor()

        columns = ["player1", "token", "bet_amount", "state", "created_at"]
        values = [
            game_data["player1"],
            game_data["token"],
            game_data["bet_amount"],
            GameState.WAITING.value,
            datetime.utcnow().isoformat(),
        ]

        placeholders = ", ".join(["?" for _ in values])
        column_names = ", ".join(columns)

        cursor.execute(
            f"INSERT INTO games ({column_names}) VALUES ({placeholders})",
            values
        )
        game_id = cursor.lastrowid
        conn.commit()
        return game_id
    finally:
        conn.close()


def update_game_record(game_id: int, updates: dict):
    """
    更新对局记录

    根据 game_id 定位记录，将 updates 中的字段逐一更新。
    updates 为空时不执行任何操作。
    """
    if not updates:
        return

    conn = get_connection()
    try:
        cursor = conn.cursor()

        set_clause = ", ".join([f"{k} = ?" for k in updates.keys()])
        values = list(updates.values()) + [game_id]

        cursor.execute(
            f"UPDATE games SET {set_clause} WHERE id = ?",
            values
        )
        conn.commit()
    finally:
        conn.close()


def get_game_record(game_id: int) -> Optional[dict]:
    """
    获取对局记录

    按主键 id 查询单条对局记录，不存在则返回 None。
    """
    conn = get_connection()
    try:
        cursor = conn.cursor()
        cursor.execute(
            "SELECT * FROM games WHERE id = ?",
            [game_id]
        )
        row = cursor.fetchone()
        return dict(row) if row else None
    finally:
        conn.close()


def get_game_by_chain_id(chain_game_id: int) -> Optional[dict]:
    """
    通过链上对局 ID 获取对局记录

    链上合约会为每局对局分配一个 chain_game_id，
    本函数用于根据该 ID 反查本地数据库中的对局记录。
    """
    conn = get_connection()
    try:
        cursor = conn.cursor()
        cursor.execute(
            "SELECT * FROM games WHERE chain_game_id = ?",
            [chain_game_id]
        )
        row = cursor.fetchone()
        return dict(row) if row else None
    finally:
        conn.close()


def get_player_games(address: str, page: int = 1, size: int = 20) -> List[dict]:
    """
    分页获取玩家对局列表

    返回该玩家（无论作为 player1 还是 player2）参与的对局，
    按 created_at 倒序排列。page 从 1 开始计数。
    """
    conn = get_connection()
    try:
        cursor = conn.cursor()
        offset = (page - 1) * size

        cursor.execute(
            """
            SELECT * FROM games
            WHERE player1 = ? OR player2 = ?
            ORDER BY created_at DESC
            LIMIT ? OFFSET ?
            """,
            [address, address, size, offset]
        )
        rows = cursor.fetchall()
        return [dict(row) for row in rows]
    finally:
        conn.close()


def get_player_games_count(address: str) -> int:
    """
    获取玩家参与的对局总数

    用于配合分页接口计算总页数等统计信息。
    """
    conn = get_connection()
    try:
        cursor = conn.cursor()
        cursor.execute(
            """
            SELECT COUNT(*) AS count FROM games
            WHERE player1 = ? OR player2 = ?
            """,
            [address, address]
        )
        row = cursor.fetchone()
        return row["count"] if row else 0
    finally:
        conn.close()


def get_active_games_by_state(state: str) -> List[dict]:
    """
    获取指定状态的活跃对局

    主要用于后台任务扫描超时对局、监听未结算对局等场景。
    """
    conn = get_connection()
    try:
        cursor = conn.cursor()
        cursor.execute(
            "SELECT * FROM games WHERE state = ?",
            [state]
        )
        rows = cursor.fetchall()
        return [dict(row) for row in rows]
    finally:
        conn.close()


def update_game_from_chain_event(chain_game_id: int, updates: dict):
    """
    从链上事件更新对局记录

    如果该 chain_game_id 已存在本地记录，则按 updates 更新对应字段；
    如果不存在，则使用 updates 中的字段创建一条新的对局记录。
    适用于链上事件监听器同步对局状态。
    """
    conn = get_connection()
    try:
        cursor = conn.cursor()

        cursor.execute(
            "SELECT id FROM games WHERE chain_game_id = ?",
            [chain_game_id]
        )
        row = cursor.fetchone()

        if row:
            # 已存在记录，执行更新
            if updates:
                set_clause = ", ".join([f"{k} = ?" for k in updates.keys()])
                values = list(updates.values()) + [chain_game_id]
                cursor.execute(
                    f"UPDATE games SET {set_clause} WHERE chain_game_id = ?",
                    values
                )
        else:
            # 不存在记录，创建新对局
            columns = ["chain_game_id"] + list(updates.keys())
            values = [chain_game_id] + list(updates.values())
            placeholders = ", ".join(["?" for _ in values])
            column_names = ", ".join(columns)
            cursor.execute(
                f"INSERT INTO games ({column_names}) VALUES ({placeholders})",
                values
            )

        conn.commit()
    finally:
        conn.close()


# ==================== 玩家统计操作 ====================

def update_player_stats(address: str, result: str, amount: float = 0):
    """
    更新玩家统计数据

    result 取值为 "win" / "loss" / "draw"，
    amount 为本次对局的下注金额（用于累计 total_wagered），
    胜利时会将奖金累加到 total_won。
    若玩家记录不存在，则自动创建。
    """
    conn = get_connection()
    try:
        cursor = conn.cursor()

        cursor.execute(
            "SELECT * FROM players WHERE address = ?",
            [address]
        )
        row = cursor.fetchone()

        now = datetime.utcnow().isoformat()

        if row:
            # 更新已有玩家记录
            updates = {
                "total_games": row["total_games"] + 1,
                "total_wagered": row["total_wagered"] + amount,
                "last_played_at": now,
            }

            if result == "win":
                updates["wins"] = row["wins"] + 1
                updates["total_won"] = row["total_won"] + amount
            elif result == "loss":
                updates["losses"] = row["losses"] + 1
            elif result == "draw":
                updates["draws"] = row["draws"] + 1

            set_clause = ", ".join([f"{k} = ?" for k in updates.keys()])
            values = list(updates.values()) + [address]

            cursor.execute(
                f"UPDATE players SET {set_clause} WHERE address = ?",
                values
            )
        else:
            # 创建新玩家记录
            wins = 1 if result == "win" else 0
            losses = 1 if result == "loss" else 0
            draws = 1 if result == "draw" else 0
            won = amount if result == "win" else 0

            cursor.execute(
                """
                INSERT INTO players
                (address, total_games, wins, losses, draws, total_wagered, total_won, first_played_at, last_played_at)
                VALUES (?, 1, ?, ?, ?, ?, ?, ?, ?)
                """,
                [address, wins, losses, draws, amount, won, now, now]
            )

        conn.commit()
    finally:
        conn.close()


def get_player_stats(address: str) -> Optional[dict]:
    """
    获取玩家统计

    返回该玩家的累计对局数、胜负平场次、总下注、总奖金等统计信息。
    若玩家不存在则返回 None。
    """
    conn = get_connection()
    try:
        cursor = conn.cursor()
        cursor.execute(
            "SELECT * FROM players WHERE address = ?",
            [address]
        )
        row = cursor.fetchone()
        return dict(row) if row else None
    finally:
        conn.close()


def upsert_player_from_chain(address: str):
    """
    从链上数据更新玩家记录

    当链上事件发现某个地址参与了对局但本地尚未记录时，
    通过本函数为其创建一条默认的玩家统计记录；
    若记录已存在，则刷新 last_played_at 时间戳。
    """
    conn = get_connection()
    try:
        cursor = conn.cursor()

        cursor.execute(
            "SELECT id FROM players WHERE address = ?",
            [address]
        )
        row = cursor.fetchone()

        now = datetime.utcnow().isoformat()

        if row:
            # 已有记录，更新最后参与时间
            cursor.execute(
                "UPDATE players SET last_played_at = ? WHERE address = ?",
                [now, address]
            )
        else:
            # 创建新玩家记录，统计字段保持默认值 0
            cursor.execute(
                """
                INSERT INTO players
                (address, total_games, wins, losses, draws, total_wagered, total_won, first_played_at, last_played_at)
                VALUES (?, 0, 0, 0, 0, 0, 0, ?, ?)
                """,
                [address, now, now]
            )

        conn.commit()
    finally:
        conn.close()
