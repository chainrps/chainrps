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

from ..config import DATABASE_PATH, RPC_LOCAL_PORT, RPC_LOCAL_NETWORK
from ..models import GameState


# ==================== 数据库连接 ====================

# 获取数据库连接
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

# 初始化数据库
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

        # 创建用户配置表
        cursor.execute("""
            CREATE TABLE IF NOT EXISTS user_preferences (
                user_address TEXT PRIMARY KEY,
                nickname TEXT,
                avatar TEXT,
                theme TEXT DEFAULT 'light',
                default_mode TEXT DEFAULT 'A',
                default_token TEXT DEFAULT 'USDC',
                quick_amounts TEXT,
                notifications_enabled INTEGER DEFAULT 1,
                sound_enabled INTEGER DEFAULT 1,
                auto_reveal INTEGER DEFAULT 0,
                timeout_choice TEXT DEFAULT 'random',
                preferences_json TEXT,
                created_at TEXT,
                updated_at TEXT
            )
        """)

        # 创建系统配置表
        cursor.execute("""
            CREATE TABLE IF NOT EXISTS system_config (
                config_key TEXT PRIMARY KEY,
                config_value TEXT,
                category TEXT,
                description TEXT,
                updated_by TEXT,
                updated_at TEXT
            )
        """)

        # 创建合约记录表
        cursor.execute("""
            CREATE TABLE IF NOT EXISTS contracts (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                name TEXT,
                address TEXT UNIQUE,
                abi TEXT,
                bytecode TEXT,
                version TEXT,
                network TEXT,
                deployed_by TEXT,
                deployed_at TEXT,
                status TEXT DEFAULT 'active',
                description TEXT
            )
        """)

        # 创建操作审计日志表
        cursor.execute("""
            CREATE TABLE IF NOT EXISTS admin_audit_logs (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                admin_address TEXT,
                action TEXT,
                target TEXT,
                old_value TEXT,
                new_value TEXT,
                tx_hash TEXT,
                ip_address TEXT,
                created_at TEXT
            )
        """)

        cursor.execute("CREATE INDEX IF NOT EXISTS idx_contracts_network ON contracts(network)")
        cursor.execute("CREATE INDEX IF NOT EXISTS idx_contracts_status ON contracts(status)")
        cursor.execute("CREATE INDEX IF NOT EXISTS idx_system_config_category ON system_config(category)")
        cursor.execute("CREATE INDEX IF NOT EXISTS idx_admin_logs_admin ON admin_audit_logs(admin_address)")
        cursor.execute("CREATE INDEX IF NOT EXISTS idx_admin_logs_action ON admin_audit_logs(action)")

        # 创建管理员账户表（用于登录认证）
        cursor.execute("""
            CREATE TABLE IF NOT EXISTS admins (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                username TEXT UNIQUE NOT NULL,
                password_hash TEXT NOT NULL,
                role TEXT DEFAULT 'admin',
                is_active INTEGER DEFAULT 1,
                created_at TEXT,
                last_login_at TEXT
            )
        """)

        # 初始化默认系统配置
        _init_default_config(cursor)

        conn.commit()
    finally:
        conn.close()

    # 初始化默认超级管理员（admin / ADMIN）
    try:
        from rps_backend.service.auth_service import init_default_admin
        init_default_admin()
    except Exception as e:
        print(f"⚠️  初始化默认管理员失败: {e}")


# ==================== 对局记录操作 ====================
pass #别删除，用于人工代码审核 便利
# 创建对局记录
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

        columns = ["player1", "player2", "token", "bet_amount", "state", "created_at"]
        values = [
            game_data["player1"],
            game_data.get("player2"),
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


# 更新对局记录
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


# 获取对局记录
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


# 通过链上对局ID获取记录
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


# 获取玩家对局列表
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


# 获取玩家对局总数
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


# 获取指定状态的活跃对局
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


# 从链上事件更新对局记录
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

# 更新玩家统计数据
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


# 获取玩家统计
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


# ==================== 默认配置初始化 ====================

# 初始化默认配置
# 系统配置默认值（唯一来源，初始化和重置都使用此表）
# 格式: { config_key: (default_value, category, description)
SYSTEM_CONFIG_DEFAULTS = {
    # 合约配置
    "fee_rate": ("200", "contract", "手续费率（基点，100=1%）"),
    # 游戏配置
    "commit_timeout": ("66", "game", "提交哈希超时时间（秒）"),
    "reveal_timeout": ("88", "game", "揭晓出拳超时时间（秒）"),
    "room_max_lifetime": ("3600", "game", "房间最大存在时间（秒），超时自动关闭（1小时=3600）"),
    "supported_tokens": ("USDC,USDT", "game", "支持的代币列表（逗号分隔）"),
    "max_bet_amount": ("10000", "game", "最大下注金额"),
    "min_bet_amount": ("1", "game", "最小下注金额"),
    # 主链配置
    "chain_id": ("5208888", "chain", "目标区块链网络 Chain ID"),
    "recommended_chain_name": (RPC_LOCAL_NETWORK, "chain", "推荐主链名称（统一标识名）"),
    "network_name": ("ChainRPS Local", "chain", "网络显示名称"),
    "rpc_url": (f"http://127.0.0.1:{RPC_LOCAL_PORT}", "chain", "RPC 节点 URL"),
    "block_explorer": ("", "chain", "区块浏览器 URL（可选）"),
    "contract_address": ("", "chain", "ChainRPS 游戏合约地址"),
    "native_symbol": ("ETH", "chain", "网络原生代币符号"),
    "native_name": ("Ether", "chain", "网络原生代币名称"),
    "native_decimals": ("18", "chain", "原生代币精度"),
    # 系统配置
    "maintenance_mode": ("0", "system", "维护模式开关（0=关闭, 1=开启）"),
    "official_website": ("https://chainrps.io", "system", "官方网站"),
    "official_twitter": ("@ChainRPS", "system", "官方 Twitter"),
    "official_discord": ("discord.gg/chainrps", "system", "官方 Discord"),
}


def _init_default_config(cursor):
    now = datetime.utcnow().isoformat()
    for key, (value, category, desc) in SYSTEM_CONFIG_DEFAULTS.items():
        # INSERT OR IGNORE 仅对新 key 生效；已存在的 key 保留原值。
        # 这样新增配置项（如 room_max_lifetime）会自动写入现有数据库，
        # 而老配置项的用户修改值不会被默认值覆盖。
        cursor.execute(
            "INSERT OR IGNORE INTO system_config (config_key, config_value, category, description, updated_by, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
            [key, value, category, desc, None, now]
        )
        # 对于已存在但缺少 description/category 的老记录，补齐元数据（不改 config_value）
        cursor.execute(
            """
            UPDATE system_config
               SET category = COALESCE(NULLIF(category, ''), ?),
                   description = COALESCE(NULLIF(description, ''), ?)
             WHERE config_key = ?
            """,
            [category, desc, key],
        )

    # 历史遗留修正：曾使用 108108 作为本地链端口，已统一改为 8686。
    cursor.execute(
        "UPDATE system_config SET config_value = ? WHERE config_key = 'rpc_url' AND config_value LIKE '%:108108%'",
        [f"http://127.0.0.1:{RPC_LOCAL_PORT}"],
    )


# ==================== 用户配置操作 ====================

# 获取用户偏好设置
def get_user_preferences(address: str) -> Optional[dict]:
    conn = get_connection()
    try:
        cursor = conn.cursor()
        cursor.execute("SELECT * FROM user_preferences WHERE user_address = ?", [address])
        row = cursor.fetchone()
        return dict(row) if row else None
    finally:
        conn.close()


def update_user_preferences(address: str, updates: dict) -> bool:
    conn = get_connection()
    try:
        cursor = conn.cursor()
        now = datetime.utcnow().isoformat()
        cursor.execute("SELECT user_address FROM user_preferences WHERE user_address = ?", [address])
        exists = cursor.fetchone()
        if exists:
            updates["updated_at"] = now
            set_clause = ", ".join([f"{k} = ?" for k in updates.keys()])
            values = list(updates.values()) + [address]
            cursor.execute(f"UPDATE user_preferences SET {set_clause} WHERE user_address = ?", values)
        else:
            columns = ["user_address", "created_at", "updated_at"] + list(updates.keys())
            values = [address, now, now] + list(updates.values())
            placeholders = ", ".join(["?" for _ in values])
            column_names = ", ".join(columns)
            cursor.execute(f"INSERT INTO user_preferences ({column_names}) VALUES ({placeholders})", values)
        conn.commit()
        return True
    finally:
        conn.close()


# 设置用户主题
def set_user_theme(address: str, theme: str) -> bool:
    return update_user_preferences(address, {"theme": theme})


# 设置用户通知开关
def set_user_notifications(address: str, enabled: bool) -> bool:
    return update_user_preferences(address, {"notifications_enabled": 1 if enabled else 0})


# ==================== 系统配置操作 ====================

# 获取所有系统配置
def get_system_config_default(key: str) -> Optional[str]:
    """获取指定配置项的默认值"""
    entry = SYSTEM_CONFIG_DEFAULTS.get(key)
    return entry[0] if entry else None


def get_all_system_config_defaults() :
    """获取所有配置项的默认值字典 {config_key: default_value}"""
    return {k: v[0] for k, v in SYSTEM_CONFIG_DEFAULTS.items()}


def get_all_system_config(category: str = None) -> List[dict]:
    conn = get_connection()
    try:
        cursor = conn.cursor()
        if category:
            cursor.execute("SELECT * FROM system_config WHERE category = ? ORDER BY config_key", [category])
        else:
            cursor.execute("SELECT * FROM system_config ORDER BY category, config_key")
        rows = cursor.fetchall()
        return [dict(row) for row in rows]
    finally:
        conn.close()


# 获取系统配置值
def get_system_config_value(key: str) -> Optional[str]:
    conn = get_connection()
    try:
        cursor = conn.cursor()
        cursor.execute("SELECT config_value FROM system_config WHERE config_key = ?", [key])
        row = cursor.fetchone()
        return row["config_value"] if row else None
    finally:
        conn.close()


def set_system_config(key: str, value: str, updated_by: str = None, description: str = None) -> bool:
    conn = get_connection()
    try:
        cursor = conn.cursor()
        now = datetime.utcnow().isoformat()
        cursor.execute("SELECT config_key FROM system_config WHERE config_key = ?", [key])
        exists = cursor.fetchone()
        if exists:
            updates = {"config_value": value, "updated_at": now}
            if updated_by:
                updates["updated_by"] = updated_by
            if description:
                updates["description"] = description
            set_clause = ", ".join([f"{k} = ?" for k in updates.keys()])
            values = list(updates.values()) + [key]
            cursor.execute(f"UPDATE system_config SET {set_clause} WHERE config_key = ?", values)
        else:
            cursor.execute(
                "INSERT INTO system_config (config_key, config_value, description, updated_by, updated_at) VALUES (?, ?, ?, ?, ?)",
                [key, value, description, updated_by, now]
            )
        conn.commit()
        return True
    finally:
        conn.close()


# 批量设置系统配置
def batch_set_system_config(items: dict, updated_by: str = None) -> bool:
    conn = get_connection()
    try:
        cursor = conn.cursor()
        now = datetime.utcnow().isoformat()
        for key, value in items.items():
            # 使用 UPSERT 语义，仅更新 value/updated_by/updated_at，保留原有 category/description
            cursor.execute(
                """INSERT INTO system_config (config_key, config_value, updated_by, updated_at)
                   VALUES (?, ?, ?, ?)
                   ON CONFLICT(config_key) DO UPDATE SET
                       config_value = excluded.config_value,
                       updated_by = excluded.updated_by,
                       updated_at = excluded.updated_at""",
                [key, value, updated_by, now]
            )
        conn.commit()
        return True
    finally:
        conn.close()


# ==================== 合约记录操作 ====================

# 添加合约记录
def add_contract_record(data: dict) -> int:
    conn = get_connection()
    try:
        cursor = conn.cursor()
        now = datetime.utcnow().isoformat()
        columns = ["name", "address", "abi", "bytecode", "version", "network", "deployed_by", "deployed_at", "status", "description"]
        values = [
            data.get("name"),
            data.get("address"),
            data.get("abi"),
            data.get("bytecode"),
            data.get("version", "v1.0.0"),
            data.get("network"),
            data.get("deployed_by"),
            data.get("deployed_at", now),
            data.get("status", "active"),
            data.get("description"),
        ]
        placeholders = ", ".join(["?" for _ in values])
        column_names = ", ".join(columns)
        cursor.execute(f"INSERT INTO contracts ({column_names}) VALUES ({placeholders})", values)
        conn.commit()
        return cursor.lastrowid
    finally:
        conn.close()


# 按ID获取合约记录
def get_contract_by_id(contract_id: int) -> Optional[dict]:
    conn = get_connection()
    try:
        cursor = conn.cursor()
        cursor.execute("SELECT * FROM contracts WHERE id = ?", [contract_id])
        row = cursor.fetchone()
        return dict(row) if row else None
    finally:
        conn.close()


# 按地址获取合约记录
def get_contract_by_address(address: str) -> Optional[dict]:
    conn = get_connection()
    try:
        cursor = conn.cursor()
        cursor.execute("SELECT * FROM contracts WHERE address = ?", [address])
        row = cursor.fetchone()
        return dict(row) if row else None
    finally:
        conn.close()


# 列出合约记录
def list_contracts(network: str = None, status: str = None) -> List[dict]:
    conn = get_connection()
    try:
        cursor = conn.cursor()
        query = "SELECT * FROM contracts WHERE 1=1"
        params = []
        if network:
            query += " AND network = ?"
            params.append(network)
        if status:
            query += " AND status = ?"
            params.append(status)
        query += " ORDER BY id DESC"
        cursor.execute(query, params)
        rows = cursor.fetchall()
        return [dict(row) for row in rows]
    finally:
        conn.close()


# 更新合约记录
def update_contract_record(contract_id: int, updates: dict) -> bool:
    conn = get_connection()
    try:
        cursor = conn.cursor()
        if not updates:
            return False
        set_clause = ", ".join([f"{k} = ?" for k in updates.keys()])
        values = list(updates.values()) + [contract_id]
        cursor.execute(f"UPDATE contracts SET {set_clause} WHERE id = ?", values)
        conn.commit()
        return cursor.rowcount > 0
    finally:
        conn.close()


# 更新合约ABI
def update_contract_abi(contract_id: int, abi: str) -> bool:
    return update_contract_record(contract_id, {"abi": abi})


# ==================== 审计日志操作 ====================

# 添加审计日志
def add_audit_log(admin_address: str, action: str, target: str = None,
                  old_value: str = None, new_value: str = None,
                  tx_hash: str = None, ip_address: str = None) -> int:
    conn = get_connection()
    try:
        cursor = conn.cursor()
        now = datetime.utcnow().isoformat()
        cursor.execute(
            """
            INSERT INTO admin_audit_logs
            (admin_address, action, target, old_value, new_value, tx_hash, ip_address, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            """,
            [admin_address, action, target, old_value, new_value, tx_hash, ip_address, now]
        )
        conn.commit()
        return cursor.lastrowid
    finally:
        conn.close()


# 列出审计日志
def list_audit_logs(admin_address: str = None, action: str = None,
                    page: int = 1, size: int = 20) -> List[dict]:
    conn = get_connection()
    try:
        cursor = conn.cursor()
        query = "SELECT * FROM admin_audit_logs WHERE 1=1"
        params = []
        if admin_address:
            query += " AND admin_address = ?"
            params.append(admin_address)
        if action:
            query += " AND action = ?"
            params.append(action)
        query += " ORDER BY id DESC LIMIT ? OFFSET ?"
        params.extend([size, (page - 1) * size])
        cursor.execute(query, params)
        rows = cursor.fetchall()
        return [dict(row) for row in rows]
    finally:
        conn.close()


# 从链上更新玩家记录
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