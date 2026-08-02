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
    get_system_config_default,
    get_all_system_config_defaults,
    SYSTEM_CONFIG_DEFAULTS,
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
    # Bot 实例操作
    create_bot_instance,
    get_bot_instance,
    list_bot_instances,
    update_bot_instance,
    delete_bot_instance,
    get_next_bot_id,
    get_used_wallet_indices,
    increment_bot_stats,
    # Bot 日志操作
    add_bot_log,
    get_bot_logs,
    clear_bot_logs,
    # Bot 活跃房间操作
    add_bot_active_room,
    update_bot_active_room,
    remove_bot_active_room,
    get_bot_active_rooms,
    # Bot 集群统计
    get_cluster_stats,
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
    "get_system_config_default",
    "get_all_system_config_defaults",
    "SYSTEM_CONFIG_DEFAULTS",
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
    # Bot 实例操作
    "create_bot_instance",
    "get_bot_instance",
    "list_bot_instances",
    "update_bot_instance",
    "delete_bot_instance",
    "get_next_bot_id",
    "get_used_wallet_indices",
    "increment_bot_stats",
    # Bot 日志操作
    "add_bot_log",
    "get_bot_logs",
    "clear_bot_logs",
    # Bot 活跃房间操作
    "add_bot_active_room",
    "update_bot_active_room",
    "remove_bot_active_room",
    "get_bot_active_rooms",
    # Bot 集群统计
    "get_cluster_stats",
]
