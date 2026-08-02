"""
ChainRPS 后端配置管理模块

配置加载顺序（优先级从低到高）：
1. config_schema.json - 配置元数据和默认值
2. .env 环境变量 - 环境相关覆盖
3. SQLite 数据库 - 运行时存储值

敏感配置（密钥、密码）应通过 .env 或系统环境变量设置。
"""
import os

from rps_backend.config.config_manager import config_manager, init_config

# 初始化配置（加载 JSON schema + 环境变量 + 数据库）
init_config()

# ==================== 从配置管理器获取所有配置 ====================

# 服务配置
HOST = config_manager.get("HOST", "0.0.0.0")
PORT = config_manager.get("PORT", 8000)

# Redis 配置
REDIS_URL = config_manager.get("REDIS_URL", "redis://localhost:6379/0")

# SQLite 配置
DATABASE_PATH = config_manager.get("DATABASE_PATH", "./data/rps.db")

# 合约配置
CONTRACT_ADDRESS = config_manager.get("CONTRACT_ADDRESS", "")

# 本地链配置(RPC)
RPC_LOCAL_NETWORK = config_manager.get("RPC_LOCAL_NETWORK", "ChainRPS_Local")
RPC_LOCAL_HOST = config_manager.get("RPC_LOCAL_HOST", "127.0.0.1")
RPC_LOCAL_PORT = config_manager.get("RPC_LOCAL_PORT", 8686)
RPC_LOCAL_URL = f"http://{RPC_LOCAL_HOST}:{RPC_LOCAL_PORT}"

RPC_LOCAL_ACCOUNT_COUNT = config_manager.get("RPC_LOCAL_ACCOUNT_COUNT", 10)
RPC_LOCAL_BALANCE = config_manager.get("RPC_LOCAL_BALANCE", 100000)
RPC_LOCAL_SYMBOL = config_manager.get("RPC_LOCAL_SYMBOL", "POL")

# ChainRPS 配置链(RPC)
RPC_NETWORK = config_manager.get("RPC_NETWORK", "ChainRPS_Local")
RPC_URL = config_manager.get("RPC_URL", RPC_LOCAL_URL)
RPC_CHAIN_ID = config_manager.get("RPC_CHAIN_ID", 5208888)
RPC_SYMBOL = config_manager.get("RPC_SYMBOL", "POL")

# 超时配置（秒）
COMMIT_TIMEOUT = config_manager.get("COMMIT_TIMEOUT", 66)
REVEAL_TIMEOUT = config_manager.get("REVEAL_TIMEOUT", 88)

# WebSocket 配置
WS_HEARTBEAT_INTERVAL = config_manager.get("WS_HEARTBEAT_INTERVAL", 30)

# Redis Key 前缀配置
MATCH_QUEUE_PREFIX = config_manager.get("MATCH_QUEUE_PREFIX", "rps:match:")
GAME_CACHE_PREFIX = config_manager.get("GAME_CACHE_PREFIX", "rps:game:")
ROOM_CACHE_PREFIX = config_manager.get("ROOM_CACHE_PREFIX", "rps:room:")
WS_PREFIX = config_manager.get("WS_PREFIX", "rps:ws:")
REDIS_BROADCAST_CHANNEL = config_manager.get("REDIS_BROADCAST_CHANNEL", "rps:broadcast")
REDIS_DIRECT_CHANNEL = config_manager.get("REDIS_DIRECT_CHANNEL", "rps:direct")

# Bot 配置
BOT_ENABLED = config_manager.get("BOT_ENABLED", True)
BOT_WALLET_INDEX = config_manager.get("BOT_WALLET_INDEX", 9)
BOT_TOKEN = config_manager.get("BOT_TOKEN", "USDC")
BOT_BET_AMOUNT = config_manager.get("BOT_BET_AMOUNT", 10.0)
BOT_AUTO_CREATE_ROOM = config_manager.get("BOT_AUTO_CREATE_ROOM", True)
BOT_AUTO_JOIN_ROOM = config_manager.get("BOT_AUTO_JOIN_ROOM", False)
BOT_CREATE_INTERVAL = config_manager.get("BOT_CREATE_INTERVAL", 60)
BOT_SCAN_INTERVAL = config_manager.get("BOT_SCAN_INTERVAL", 10)
BOT_COMMIT_DELAY = config_manager.get("BOT_COMMIT_DELAY", 3)
BOT_REVEAL_DELAY = config_manager.get("BOT_REVEAL_DELAY", 2)
BOT_MAX_CONCURRENT_ROOMS = config_manager.get("BOT_MAX_CONCURRENT_ROOMS", 3)
BOT_LABEL = config_manager.get("BOT_LABEL", "🤖 AI陪玩")
BOT_WALLET_BALANCE_THRESHOLD = config_manager.get("BOT_WALLET_BALANCE_THRESHOLD", 1.0)

# Bot 钱包池配置
BOT_WALLET_POOL_START = config_manager.get("BOT_WALLET_POOL_START", 1)
BOT_WALLET_POOL_END = config_manager.get("BOT_WALLET_POOL_END", 9)
BOT_WALLET_INITIAL_ETH = config_manager.get("BOT_WALLET_INITIAL_ETH", 1000.0)
BOT_WALLET_INITIAL_USDC = config_manager.get("BOT_WALLET_INITIAL_USDC", 1000000.0)

# Bot 默认策略配置
BOT_DEFAULT_STRATEGY = config_manager.get("BOT_DEFAULT_STRATEGY", "random")
BOT_AUTO_CHAIN_MATCH = config_manager.get("BOT_AUTO_CHAIN_MATCH", True)

# 部署配置
FEE_COLLECTOR = config_manager.get("FEE_COLLECTOR", "")
OFFICIAL_DEVELOPER = config_manager.get("OFFICIAL_DEVELOPER", "")
CONTRACT_NAME = config_manager.get("CONTRACT_NAME", "ChainRPS")
CONTRACT_VERSION = config_manager.get("CONTRACT_VERSION", "v1.0.0")
NETWORK = config_manager.get("NETWORK", "amoy")


# ==================== 敏感配置（只能通过环境变量/.env设置） ====================

# Relayer 配置（代提交）
RELAYER_PRIVATE_KEY = os.getenv("RELAYER_PRIVATE_KEY", "")
RELAYER_ADDRESS = os.getenv("RELAYER_ADDRESS", "")

# 部署者私钥（部署脚本使用）
DEPLOYER_PRIVATE_KEY = os.getenv("DEPLOYER_PRIVATE_KEY", "")

# 管理员钱包地址白名单
ADMIN_WHITELIST = [
    addr.strip() for addr in os.getenv("ADMIN_WHITELIST", "").split(",") if addr.strip()
]

# 认证配置
JWT_SECRET = os.getenv("JWT_SECRET", "chainrps-dev-secret-change-in-production-please")
JWT_ALGORITHM = "HS256"  # 固定值，不允许修改
JWT_EXPIRE_HOURS = config_manager.get("JWT_EXPIRE_HOURS", 24)

# 默认管理员配置
DEFAULT_ADMIN_USERNAME = config_manager.get("DEFAULT_ADMIN_USERNAME", "admin")
DEFAULT_ADMIN_PASSWORD = os.getenv("DEFAULT_ADMIN_PASSWORD", "ADMIN")

# 环境标记
DEBUG = os.getenv("DEBUG", "false").lower() == "true"

# 检查生产环境警告
if not ADMIN_WHITELIST and not DEBUG:
    import warnings
    warnings.warn(
        "ADMIN_WHITELIST 未配置！生产环境下所有管理员接口将无权限校验。"
        "请在 .env 中设置 ADMIN_WHITELIST 或设置 DEBUG=true 以消除此警告。",
        RuntimeWarning,
        stacklevel=2,
    )


def reload_config():
    """重新加载配置（从 .env 和数据库重新读取）"""
    global HOST, PORT, REDIS_URL, DATABASE_PATH, CONTRACT_ADDRESS
    global RPC_LOCAL_HOST, RPC_LOCAL_PORT, RPC_LOCAL_URL, RPC_URL, RPC_CHAIN_ID
    global RPC_LOCAL_ACCOUNT_COUNT, RPC_LOCAL_BALANCE, RPC_LOCAL_SYMBOL
    global COMMIT_TIMEOUT, REVEAL_TIMEOUT, WS_HEARTBEAT_INTERVAL
    global ADMIN_WHITELIST, JWT_SECRET, JWT_ALGORITHM, JWT_EXPIRE_HOURS
    global DEFAULT_ADMIN_USERNAME, DEFAULT_ADMIN_PASSWORD, DEBUG
    global MATCH_QUEUE_PREFIX, GAME_CACHE_PREFIX, ROOM_CACHE_PREFIX
    global WS_PREFIX, REDIS_BROADCAST_CHANNEL, REDIS_DIRECT_CHANNEL
    global RELAYER_PRIVATE_KEY, RELAYER_ADDRESS
    global BOT_ENABLED, BOT_WALLET_INDEX, BOT_TOKEN, BOT_BET_AMOUNT
    global BOT_AUTO_CREATE_ROOM, BOT_AUTO_JOIN_ROOM
    global BOT_CREATE_INTERVAL, BOT_SCAN_INTERVAL
    global BOT_COMMIT_DELAY, BOT_REVEAL_DELAY, BOT_MAX_CONCURRENT_ROOMS
    global BOT_LABEL, BOT_WALLET_BALANCE_THRESHOLD
    global BOT_WALLET_POOL_START, BOT_WALLET_POOL_END
    global BOT_WALLET_INITIAL_ETH, BOT_WALLET_INITIAL_USDC
    global BOT_DEFAULT_STRATEGY, BOT_AUTO_CHAIN_MATCH
    global FEE_COLLECTOR, OFFICIAL_DEVELOPER, CONTRACT_NAME, CONTRACT_VERSION, NETWORK

    # 重新初始化配置管理器
    config_manager._loaded = False
    config_manager.load()

    # 重新读取所有配置
    HOST = config_manager.get("HOST", "0.0.0.0")
    PORT = config_manager.get("PORT", 8000)
    REDIS_URL = config_manager.get("REDIS_URL", "redis://localhost:6379/0")
    DATABASE_PATH = config_manager.get("DATABASE_PATH", "./data/rps.db")
    CONTRACT_ADDRESS = config_manager.get("CONTRACT_ADDRESS", "")
    RPC_LOCAL_HOST = config_manager.get("RPC_LOCAL_HOST", "127.0.0.1")
    RPC_LOCAL_PORT = config_manager.get("RPC_LOCAL_PORT", 8686)
    RPC_LOCAL_URL = f"http://{RPC_LOCAL_HOST}:{RPC_LOCAL_PORT}"
    RPC_URL = config_manager.get("RPC_URL", RPC_LOCAL_URL)
    RPC_CHAIN_ID = config_manager.get("RPC_CHAIN_ID", 5208888)
    RPC_LOCAL_ACCOUNT_COUNT = config_manager.get("RPC_LOCAL_ACCOUNT_COUNT", 10)
    RPC_LOCAL_BALANCE = config_manager.get("RPC_LOCAL_BALANCE", 100000)
    RPC_LOCAL_SYMBOL = config_manager.get("RPC_LOCAL_SYMBOL", "POL")
    COMMIT_TIMEOUT = config_manager.get("COMMIT_TIMEOUT", 66)
    REVEAL_TIMEOUT = config_manager.get("REVEAL_TIMEOUT", 88)
    WS_HEARTBEAT_INTERVAL = config_manager.get("WS_HEARTBEAT_INTERVAL", 30)
    ADMIN_WHITELIST = [
        addr.strip() for addr in os.getenv("ADMIN_WHITELIST", "").split(",") if addr.strip()
    ]
    JWT_SECRET = os.getenv("JWT_SECRET", "chainrps-dev-secret-change-in-production-please")
    JWT_EXPIRE_HOURS = config_manager.get("JWT_EXPIRE_HOURS", 24)
    DEFAULT_ADMIN_USERNAME = config_manager.get("DEFAULT_ADMIN_USERNAME", "admin")
    DEFAULT_ADMIN_PASSWORD = os.getenv("DEFAULT_ADMIN_PASSWORD", "ADMIN")
    DEBUG = os.getenv("DEBUG", "false").lower() == "true"
    MATCH_QUEUE_PREFIX = config_manager.get("MATCH_QUEUE_PREFIX", "rps:match:")
    GAME_CACHE_PREFIX = config_manager.get("GAME_CACHE_PREFIX", "rps:game:")
    ROOM_CACHE_PREFIX = config_manager.get("ROOM_CACHE_PREFIX", "rps:room:")
    WS_PREFIX = config_manager.get("WS_PREFIX", "rps:ws:")
    REDIS_BROADCAST_CHANNEL = config_manager.get("REDIS_BROADCAST_CHANNEL", "rps:broadcast")
    REDIS_DIRECT_CHANNEL = config_manager.get("REDIS_DIRECT_CHANNEL", "rps:direct")
    BOT_ENABLED = config_manager.get("BOT_ENABLED", True)
    BOT_WALLET_INDEX = config_manager.get("BOT_WALLET_INDEX", 9)
    BOT_TOKEN = config_manager.get("BOT_TOKEN", "USDC")
    BOT_BET_AMOUNT = config_manager.get("BOT_BET_AMOUNT", 10.0)
    BOT_AUTO_CREATE_ROOM = config_manager.get("BOT_AUTO_CREATE_ROOM", True)
    BOT_AUTO_JOIN_ROOM = config_manager.get("BOT_AUTO_JOIN_ROOM", False)
    BOT_CREATE_INTERVAL = config_manager.get("BOT_CREATE_INTERVAL", 60)
    BOT_SCAN_INTERVAL = config_manager.get("BOT_SCAN_INTERVAL", 10)
    BOT_COMMIT_DELAY = config_manager.get("BOT_COMMIT_DELAY", 3)
    BOT_REVEAL_DELAY = config_manager.get("BOT_REVEAL_DELAY", 2)
    BOT_MAX_CONCURRENT_ROOMS = config_manager.get("BOT_MAX_CONCURRENT_ROOMS", 3)
    BOT_LABEL = config_manager.get("BOT_LABEL", "🤖 AI陪玩")
    BOT_WALLET_BALANCE_THRESHOLD = config_manager.get("BOT_WALLET_BALANCE_THRESHOLD", 1.0)
    BOT_WALLET_POOL_START = config_manager.get("BOT_WALLET_POOL_START", 1)
    BOT_WALLET_POOL_END = config_manager.get("BOT_WALLET_POOL_END", 9)
    BOT_WALLET_INITIAL_ETH = config_manager.get("BOT_WALLET_INITIAL_ETH", 1000.0)
    BOT_WALLET_INITIAL_USDC = config_manager.get("BOT_WALLET_INITIAL_USDC", 1000000.0)
    BOT_DEFAULT_STRATEGY = config_manager.get("BOT_DEFAULT_STRATEGY", "random")
    BOT_AUTO_CHAIN_MATCH = config_manager.get("BOT_AUTO_CHAIN_MATCH", True)
    FEE_COLLECTOR = config_manager.get("FEE_COLLECTOR", "")
    OFFICIAL_DEVELOPER = config_manager.get("OFFICIAL_DEVELOPER", "")
    CONTRACT_NAME = config_manager.get("CONTRACT_NAME", "ChainRPS")
    CONTRACT_VERSION = config_manager.get("CONTRACT_VERSION", "v1.0.0")
    NETWORK = config_manager.get("NETWORK", "amoy")


__all__ = [
    # 服务配置
    "HOST",
    "PORT",
    # Redis 配置
    "REDIS_URL",
    # SQLite 配置
    "DATABASE_PATH",
    # 合约配置
    "CONTRACT_ADDRESS",
    # Relayer 配置
    "RELAYER_PRIVATE_KEY",
    "RELAYER_ADDRESS",
    # 本地链配置 (RPC[Ganache|Hardhat])
    "RPC_LOCAL_NETWORK",
    "RPC_LOCAL_HOST",
    "RPC_LOCAL_PORT",
    "RPC_LOCAL_URL",
    "RPC_LOCAL_ACCOUNT_COUNT",
    "RPC_LOCAL_BALANCE",
    "RPC_LOCAL_SYMBOL",
    "RPC_NETWORK",
    "RPC_URL",
    "RPC_CHAIN_ID",
    "RPC_SYMBOL",
    # 超时配置
    "COMMIT_TIMEOUT",
    "REVEAL_TIMEOUT",
    # WebSocket 配置
    "WS_HEARTBEAT_INTERVAL",
    # 管理员配置
    "ADMIN_WHITELIST",
    # 认证配置
    "JWT_SECRET",
    "JWT_ALGORITHM",
    "JWT_EXPIRE_HOURS",
    "DEFAULT_ADMIN_USERNAME",
    "DEFAULT_ADMIN_PASSWORD",
    "DEBUG",
    # Redis Key 前缀配置
    "MATCH_QUEUE_PREFIX",
    "GAME_CACHE_PREFIX",
    "ROOM_CACHE_PREFIX",
    "WS_PREFIX",
    "REDIS_BROADCAST_CHANNEL",
    "REDIS_DIRECT_CHANNEL",
    # 工具函数
    "reload_config",
    "config_manager",
    # Bot 配置
    "BOT_ENABLED",
    "BOT_WALLET_INDEX",
    "BOT_TOKEN",
    "BOT_BET_AMOUNT",
    "BOT_AUTO_CREATE_ROOM",
    "BOT_AUTO_JOIN_ROOM",
    "BOT_CREATE_INTERVAL",
    "BOT_SCAN_INTERVAL",
    "BOT_COMMIT_DELAY",
    "BOT_REVEAL_DELAY",
    "BOT_MAX_CONCURRENT_ROOMS",
    "BOT_LABEL",
    "BOT_WALLET_BALANCE_THRESHOLD",
    # Bot 钱包池配置
    "BOT_WALLET_POOL_START",
    "BOT_WALLET_POOL_END",
    "BOT_WALLET_INITIAL_ETH",
    "BOT_WALLET_INITIAL_USDC",
    # Bot 默认策略配置
    "BOT_DEFAULT_STRATEGY",
    "BOT_AUTO_CHAIN_MATCH",
    # 部署配置
    "FEE_COLLECTOR",
    "OFFICIAL_DEVELOPER",
    "CONTRACT_NAME",
    "CONTRACT_VERSION",
    "NETWORK",
    # 部署者私钥
    "DEPLOYER_PRIVATE_KEY",
]
