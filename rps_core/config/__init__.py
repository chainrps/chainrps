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
RPC_URL = os.getenv("RPC_URL", "https://rpc-amoy.polygon.technology/")
CHAIN_ID = int(os.getenv("CHAIN_ID", 80002))

# ==================== 超时配置（秒） ====================
COMMIT_TIMEOUT = int(os.getenv("COMMIT_TIMEOUT", 66))    # 提交哈希超时
REVEAL_TIMEOUT = int(os.getenv("REVEAL_TIMEOUT", 88))    # 揭晓超时

# ==================== WebSocket 配置 ====================
WS_HEARTBEAT_INTERVAL = int(os.getenv("WS_HEARTBEAT_INTERVAL", 30))  # 心跳间隔（秒）

# ==================== Redis Key 前缀配置 ====================
MATCH_QUEUE_PREFIX = os.getenv("MATCH_QUEUE_PREFIX", "rps:match:")  # 匹配队列前缀
GAME_CACHE_PREFIX = os.getenv("GAME_CACHE_PREFIX", "rps:game:")     # 对局缓存前缀
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
    "MATCH_QUEUE_PREFIX",
    "GAME_CACHE_PREFIX",
    "WS_PREFIX",
]
