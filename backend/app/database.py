"""
SQLite 数据库管理
"""
import sqlite3
import os
from datetime import datetime
from typing import Optional, List

from .config import DATABASE_PATH
from .models import GameRecord, PlayerRecord, GameState


def get_connection():
    """获取数据库连接"""
    # 确保数据目录存在
    os.makedirs(os.path.dirname(DATABASE_PATH), exist_ok=True)
    conn = sqlite3.connect(DATABASE_PATH)
    conn.row_factory = sqlite3.Row
    return conn


def init_database():
    """初始化数据库表"""
    conn = get_connection()
    cursor = conn.cursor()

    # 创建对局表
    game_columns = ", ".join([f"{k} {v}" for k, v in GameRecord.columns.items()])
    cursor.execute(f"CREATE TABLE IF NOT EXISTS {GameRecord.table_name} ({game_columns})")

    # 创建玩家表
    player_columns = ", ".join([f"{k} {v}" for k, v in PlayerRecord.columns.items()])
    cursor.execute(f"CREATE TABLE IF NOT EXISTS {PlayerRecord.table_name} ({player_columns})")

    # 创建索引
    cursor.execute("CREATE INDEX IF NOT EXISTS idx_games_player1 ON games(player1)")
    cursor.execute("CREATE INDEX IF NOT EXISTS idx_games_player2 ON games(player2)")
    cursor.execute("CREATE INDEX IF NOT EXISTS idx_games_state ON games(state)")

    conn.commit()
    conn.close()


def create_game_record(game_data: dict) -> int:
    """创建对局记录"""
    conn = get_connection()
    cursor = conn.cursor()

    columns = [
        "player1", "token", "bet_amount", "state", "created_at"
    ]
    values = [
        game_data["player1"],
        game_data["token"],
        game_data["bet_amount"],
        GameState.WAITING.value,
        datetime.utcnow().isoformat()
    ]

    placeholders = ", ".join(["?" for _ in values])
    column_names = ", ".join(columns)

    cursor.execute(
        f"INSERT INTO {GameRecord.table_name} ({column_names}) VALUES ({placeholders})",
        values
    )
    game_id = cursor.lastrowid

    conn.commit()
    conn.close()

    return game_id


def update_game_record(game_id: int, updates: dict):
    """更新对局记录"""
    conn = get_connection()
    cursor = conn.cursor()

    set_clause = ", ".join([f"{k} = ?" for k in updates.keys()])
    values = list(updates.values()) + [game_id]

    cursor.execute(
        f"UPDATE {GameRecord.table_name} SET {set_clause} WHERE id = ?",
        values
    )

    conn.commit()
    conn.close()


def get_game_record(game_id: int) -> Optional[dict]:
    """获取对局记录"""
    conn = get_connection()
    cursor = conn.cursor()

    cursor.execute(
        f"SELECT * FROM {GameRecord.table_name} WHERE id = ?",
        [game_id]
    )
    row = cursor.fetchone()

    conn.close()

    if row:
        return dict(row)
    return None


def get_player_games(address: str, limit: int = 50) -> List[dict]:
    """获取玩家的对局列表"""
    conn = get_connection()
    cursor = conn.cursor()

    cursor.execute(
        f"""
        SELECT * FROM {GameRecord.table_name}
        WHERE player1 = ? OR player2 = ?
        ORDER BY created_at DESC
        LIMIT ?
        """,
        [address, address, limit]
    )
    rows = cursor.fetchall()

    conn.close()

    return [dict(row) for row in rows]


def update_player_stats(address: str, result: str, amount: float = 0):
    """更新玩家统计数据"""
    conn = get_connection()
    cursor = conn.cursor()

    # 检查玩家是否存在
    cursor.execute(
        f"SELECT * FROM {PlayerRecord.table_name} WHERE address = ?",
        [address]
    )
    row = cursor.fetchone()

    now = datetime.utcnow().isoformat()

    if row:
        # 更新现有记录
        updates = {
            "total_games": row["total_games"] + 1,
            "last_played_at": now,
        }

        if result == "win":
            updates["wins"] = row["wins"] + 1
            updates["total_won"] = row["total_won"] + amount
        elif result == "loss":
            updates["losses"] = row["losses"] + 1
        elif result == "draw":
            updates["draws"] = row["draws"] + 1

        updates["total_wagered"] = row["total_wagered"] + amount

        set_clause = ", ".join([f"{k} = ?" for k in updates.keys()])
        values = list(updates.values()) + [address]

        cursor.execute(
            f"UPDATE {PlayerRecord.table_name} SET {set_clause} WHERE address = ?",
            values
        )
    else:
        # 创建新记录
        wins = 1 if result == "win" else 0
        losses = 1 if result == "loss" else 0
        draws = 1 if result == "draw" else 0
        won = amount if result == "win" else 0

        cursor.execute(
            f"""
            INSERT INTO {PlayerRecord.table_name} 
            (address, total_games, wins, losses, draws, total_wagered, total_won, first_played_at, last_played_at)
            VALUES (?, 1, ?, ?, ?, ?, ?, ?, ?)
            """,
            [address, wins, losses, draws, amount, won, now, now]
        )

    conn.commit()
    conn.close()


def get_player_stats(address: str) -> Optional[dict]:
    """获取玩家统计"""
    conn = get_connection()
    cursor = conn.cursor()

    cursor.execute(
        f"SELECT * FROM {PlayerRecord.table_name} WHERE address = ?",
        [address]
    )
    row = cursor.fetchone()

    conn.close()

    if row:
        return dict(row)
    return None


def get_active_games_by_state(state: str) -> List[dict]:
    """获取指定状态的活跃对局"""
    conn = get_connection()
    cursor = conn.cursor()

    cursor.execute(
        f"SELECT * FROM {GameRecord.table_name} WHERE state = ?",
        [state]
    )
    rows = cursor.fetchall()

    conn.close()

    return [dict(row) for row in rows]