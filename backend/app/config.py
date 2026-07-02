"""
ChainRPS 后端配置
"""
import os
from dotenv import load_dotenv

load_dotenv()

# 服务配置
HOST = os.getenv("HOST", "0.0.0.0")
PORT = int(os.getenv("PORT", 8000))

# Redis 配置
REDIS_URL = os.getenv("REDIS_URL", "redis://localhost:6379/0")

# SQLite 配置
DATABASE_PATH = os.getenv("DATABASE_PATH", "./data/rps.db")

# 合约配置
CONTRACT_ADDRESS = os.getenv("CONTRACT_ADDRESS", "")
RPC_URL = os.getenv("RPC_URL", "https://rpc-amoy.polygon.technology/")

# 钱包配置（用于自动超时判负）
OPERATOR_PRIVATE_KEY = os.getenv("OPERATOR_PRIVATE_KEY", "")

# 超时配置（秒）
COMMIT_TIMEOUT = 66  # 提交哈希超时
REVEAL_TIMEOUT = 88   # 揭晓超时

# WebSocket 配置
WS_HEARTBEAT_INTERVAL = 30  # 心跳间隔（秒）

# 匹配队列配置
MATCH_QUEUE_PREFIX = "rps:match:"  # 匹配队列 Redis Key 前缀