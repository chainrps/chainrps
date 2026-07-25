"""
ChainRPS 后端配置管理模块

从环境变量读取配置，使用 python-dotenv 加载 .env 文件。
提供全局变量供其他模块直接导入使用。
"""
import os

from dotenv import load_dotenv

# 加载项目根目录下的 .env 文件
load_dotenv()

# ==================== 服务配置 ====================
HOST = os.getenv("HOST", "0.0.0.0")
PORT = int(os.getenv("PORT", 8000))

# ==================== Redis 配置 ====================
REDIS_URL = os.getenv("REDIS_URL", "redis://localhost:6379/0")

# ==================== SQLite 配置 ====================
DATABASE_PATH = os.getenv("DATABASE_PATH", "./data/rps.db")

# ==================== 合约配置 ====================
CONTRACT_ADDRESS = os.getenv("CONTRACT_ADDRESS", "")
RPC_URL = os.getenv("RPC_URL", "http://127.0.0.1:8545")
CHAIN_ID = int(os.getenv("CHAIN_ID", 1337))

# ==================== 超时配置（秒） ====================
COMMIT_TIMEOUT = int(os.getenv("COMMIT_TIMEOUT", 66))    # 提交哈希超时
REVEAL_TIMEOUT = int(os.getenv("REVEAL_TIMEOUT", 88))    # 揭晓超时

# ==================== WebSocket 配置 ====================
WS_HEARTBEAT_INTERVAL = int(os.getenv("WS_HEARTBEAT_INTERVAL", 30))  # 心跳间隔（秒）

# ==================== 管理员配置 ====================
# 管理员钱包地址白名单（逗号分隔）
# 生产环境必须配置，为空时所有管理员接口无权限校验（仅限开发环境）
ADMIN_WHITELIST = [
    addr.strip() for addr in os.getenv("ADMIN_WHITELIST", "").split(",") if addr.strip()
]

# ==================== 认证配置 ====================
# JWT 密钥：生产环境必须通过环境变量 JWT_SECRET 设置一个高强度随机字符串
JWT_SECRET = os.getenv("JWT_SECRET", "chainrps-dev-secret-change-in-production-please")
JWT_ALGORITHM = "HS256"
JWT_EXPIRE_HOURS = int(os.getenv("JWT_EXPIRE_HOURS", "24"))

# 默认超级管理员账号（首次启动时自动写入数据库）
DEFAULT_ADMIN_USERNAME = os.getenv("DEFAULT_ADMIN_USERNAME", "admin")
DEFAULT_ADMIN_PASSWORD = os.getenv("DEFAULT_ADMIN_PASSWORD", "ADMIN")

# 环境标记：是否为开发环境
DEBUG = os.getenv("DEBUG", "false").lower() == "true"

if not ADMIN_WHITELIST and not DEBUG:
    import warnings
    warnings.warn(
        "ADMIN_WHITELIST 未配置！生产环境下所有管理员接口将无权限校验。"
        "请在 .env 中设置 ADMIN_WHITELIST 或设置 DEBUG=true 以消除此警告。",
        RuntimeWarning,
        stacklevel=2,
    )

# ==================== Redis Key 前缀配置 ====================
MATCH_QUEUE_PREFIX = os.getenv("MATCH_QUEUE_PREFIX", "rps:match:")  # 匹配队列前缀
GAME_CACHE_PREFIX = os.getenv("GAME_CACHE_PREFIX", "rps:game:")     # 对局缓存前缀
ROOM_CACHE_PREFIX = os.getenv("ROOM_CACHE_PREFIX", "rps:room:")     # 房间缓存前缀
WS_PREFIX = os.getenv("WS_PREFIX", "rps:ws:")                        # WebSocket 会话前缀


__all__ = [
    "HOST",
    "PORT",
    "REDIS_URL",
    "DATABASE_PATH",
    "CONTRACT_ADDRESS",
    "RPC_URL",
    "CHAIN_ID",
    "COMMIT_TIMEOUT",
    "REVEAL_TIMEOUT",
    "WS_HEARTBEAT_INTERVAL",
    "ADMIN_WHITELIST",
    "DEBUG",
    "MATCH_QUEUE_PREFIX",
    "GAME_CACHE_PREFIX",
    "ROOM_CACHE_PREFIX",
    "WS_PREFIX",
]
