"""
数据访问层（Repository）

集中暴露 ChainRPS 后端所有数据库操作函数，供 service / api 层调用。
本包仅负责数据持久化与缓存，不包含业务逻辑与胜负判定。
"""
from .database import (
    # 数据库连接与初始化
    get_connection,
    init_database,
    # 对局记录操作
    create_game_record,
    update_game_record,
    get_game_record,
    get_game_by_chain_id,
    get_player_games,
    get_player_games_count,
    get_active_games_by_state,
    update_game_from_chain_event,
    # 玩家统计操作
    update_player_stats,
    get_player_stats,
    upsert_player_from_chain,
)

__all__ = [
    # 数据库连接与初始化
    "get_connection",
    "init_database",
    # 对局记录操作
    "create_game_record",
    "update_game_record",
    "get_game_record",
    "get_game_by_chain_id",
    "get_player_games",
    "get_player_games_count",
    "get_active_games_by_state",
    "update_game_from_chain_event",
    # 玩家统计操作
    "update_player_stats",
    "get_player_stats",
    "upsert_player_from_chain",
]
