"""
工具函数模块

提供时间、地址校验、ID 生成、类型转换、分页等通用工具函数，
以及 Redis 客户端实例。
"""
from rps_backend.utils.helpers import (
    now_timestamp,
    now_iso,
    calculate_deadline,
    deadline_to_iso,
    validate_address,
    generate_match_id,
    safe_float,
    paginate,
)
from rps_backend.utils.redis_client import redis_client, RedisClient

__all__ = [
    "now_timestamp",
    "now_iso",
    "calculate_deadline",
    "deadline_to_iso",
    "validate_address",
    "generate_match_id",
    "safe_float",
    "paginate",
    "redis_client",
    "RedisClient",
]
