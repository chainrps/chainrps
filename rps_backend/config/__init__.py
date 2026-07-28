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

# ==================== 本地链配置(RPC) ====================
RPC_LOCAL_HOST = os.getenv("RPC_LOCAL_HOST", "127.0.0.1")
RPC_LOCAL_PORT = int(os.getenv("RPC_LOCAL_PORT", 8686))
RPC_LOCAL_URL = f"http://{RPC_LOCAL_HOST}:{RPC_LOCAL_PORT}"
RPC_URL = os.getenv("RPC_URL", RPC_LOCAL_URL)
RPC_CHAIN_ID = int(os.getenv("CHAIN_ID", 5208888))
RPC_DEFAULT_ACCOUNT_COUNT = int(os.getenv("RPC_DEFAULT_ACCOUNT_COUNT", 10))
RPC_DEFAULT_BALANCE = float(os.getenv("RPC_DEFAULT_BALANCE", 100000))
RPC_SYMBOL = os.getenv("RPC_SYMBOL", "ETH")

# ==================== 超时配置（秒） ====================
COMMIT_TIMEOUT = int(os.getenv("COMMIT_TIMEOUT", 66))  # 提交哈希超时
REVEAL_TIMEOUT = int(os.getenv("REVEAL_TIMEOUT", 88))  # 揭晓超时

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
GAME_CACHE_PREFIX = os.getenv("GAME_CACHE_PREFIX", "rps:game:")  # 对局缓存前缀
ROOM_CACHE_PREFIX = os.getenv("ROOM_CACHE_PREFIX", "rps:room:")  # 房间缓存前缀
WS_PREFIX = os.getenv("WS_PREFIX", "rps:ws:")  # WebSocket 会话前缀
REDIS_BROADCAST_CHANNEL = os.getenv("REDIS_BROADCAST_CHANNEL", "rps:broadcast")  # Redis 广播频道名称


def reload_config():
    """重新加载 .env 文件并更新全局变量"""
    global HOST, PORT, REDIS_URL, DATABASE_PATH, CONTRACT_ADDRESS
    global RPC_LOCAL_HOST, RPC_LOCAL_PORT, RPC_LOCAL_URL, RPC_URL, RPC_CHAIN_ID
    global RPC_DEFAULT_ACCOUNT_COUNT, RPC_DEFAULT_BALANCE, RPC_SYMBOL
    global COMMIT_TIMEOUT, REVEAL_TIMEOUT, WS_HEARTBEAT_INTERVAL
    global ADMIN_WHITELIST, JWT_SECRET, JWT_ALGORITHM, JWT_EXPIRE_HOURS
    global DEFAULT_ADMIN_USERNAME, DEFAULT_ADMIN_PASSWORD, DEBUG
    global MATCH_QUEUE_PREFIX, GAME_CACHE_PREFIX, ROOM_CACHE_PREFIX
    global WS_PREFIX, REDIS_BROADCAST_CHANNEL

    # 重新加载 .env 文件
    load_dotenv(override=True)

    HOST = os.getenv("HOST", "0.0.0.0")
    PORT = int(os.getenv("PORT", 8000))
    REDIS_URL = os.getenv("REDIS_URL", "redis://localhost:6379/0")
    DATABASE_PATH = os.getenv("DATABASE_PATH", "./data/rps.db")
    CONTRACT_ADDRESS = os.getenv("CONTRACT_ADDRESS", "")
    RPC_LOCAL_HOST = os.getenv("RPC_LOCAL_HOST", "127.0.0.1")
    RPC_LOCAL_PORT = int(os.getenv("RPC_LOCAL_PORT", 8686))
    RPC_LOCAL_URL = f"http://{RPC_LOCAL_HOST}:{RPC_LOCAL_PORT}"
    RPC_URL = os.getenv("RPC_URL", RPC_LOCAL_URL)
    RPC_CHAIN_ID = int(os.getenv("CHAIN_ID", 5208888))
    RPC_DEFAULT_ACCOUNT_COUNT = int(os.getenv("RPC_DEFAULT_ACCOUNT_COUNT", 10))
    RPC_DEFAULT_BALANCE = float(os.getenv("RPC_DEFAULT_BALANCE", 100000))
    RPC_SYMBOL = os.getenv("RPC_SYMBOL", "ETH")
    COMMIT_TIMEOUT = int(os.getenv("COMMIT_TIMEOUT", 66))
    REVEAL_TIMEOUT = int(os.getenv("REVEAL_TIMEOUT", 88))
    WS_HEARTBEAT_INTERVAL = int(os.getenv("WS_HEARTBEAT_INTERVAL", 30))
    ADMIN_WHITELIST = [
        addr.strip() for addr in os.getenv("ADMIN_WHITELIST", "").split(",") if addr.strip()
    ]
    JWT_SECRET = os.getenv("JWT_SECRET", "chainrps-dev-secret-change-in-production-please")
    JWT_ALGORITHM = "HS256"
    JWT_EXPIRE_HOURS = int(os.getenv("JWT_EXPIRE_HOURS", "24"))
    DEFAULT_ADMIN_USERNAME = os.getenv("DEFAULT_ADMIN_USERNAME", "admin")
    DEFAULT_ADMIN_PASSWORD = os.getenv("DEFAULT_ADMIN_PASSWORD", "ADMIN")
    DEBUG = os.getenv("DEBUG", "false").lower() == "true"
    MATCH_QUEUE_PREFIX = os.getenv("MATCH_QUEUE_PREFIX", "rps:match:")
    GAME_CACHE_PREFIX = os.getenv("GAME_CACHE_PREFIX", "rps:game:")
    ROOM_CACHE_PREFIX = os.getenv("ROOM_CACHE_PREFIX", "rps:room:")
    WS_PREFIX = os.getenv("WS_PREFIX", "rps:ws:")
    REDIS_BROADCAST_CHANNEL = os.getenv("REDIS_BROADCAST_CHANNEL", "rps:broadcast")


__all__ = [
    "HOST",
    "PORT",
    "REDIS_URL",
    "DATABASE_PATH",
    "CONTRACT_ADDRESS",
    "RPC_URL",
    "RPC_CHAIN_ID",
    "COMMIT_TIMEOUT",
    "REVEAL_TIMEOUT",
    "WS_HEARTBEAT_INTERVAL",
    "ADMIN_WHITELIST",
    "DEBUG",
    "MATCH_QUEUE_PREFIX",
    "GAME_CACHE_PREFIX",
    "ROOM_CACHE_PREFIX",
    "WS_PREFIX",
    "REDIS_BROADCAST_CHANNEL",
    "reload_config",
]