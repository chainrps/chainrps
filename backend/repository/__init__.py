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
    # 用户配置操作
    get_user_preferences,
    update_user_preferences,
    set_user_theme,
    set_user_notifications,
    # 系统配置操作
    get_all_system_config,
    get_system_config_value,
    set_system_config,
    batch_set_system_config,
    # 合约记录操作
    add_contract_record,
    get_contract_by_id,
    get_contract_by_address,
    list_contracts,
    update_contract_record,
    update_contract_abi,
    # 审计日志操作
    add_audit_log,
    list_audit_logs,
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
    # 用户配置操作
    "get_user_preferences",
    "update_user_preferences",
    "set_user_theme",
    "set_user_notifications",
    # 系统配置操作
    "get_all_system_config",
    "get_system_config_value",
    "set_system_config",
    "batch_set_system_config",
    # 合约记录操作
    "add_contract_record",
    "get_contract_by_id",
    "get_contract_by_address",
    "list_contracts",
    "update_contract_record",
    "update_contract_abi",
    # 审计日志操作
    "add_audit_log",
    "list_audit_logs",
]
