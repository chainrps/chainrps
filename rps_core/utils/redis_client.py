"""
Redis 客户端模块

提供 ChainRPS 后端的 Redis 操作封装，包括：
- 匹配队列管理（基于 Redis List 实现 FIFO 队列）
- WebSocket 连接注册（用于跨进程查询玩家连接）
- 对局状态缓存（降低数据库读压力）

放置在 utils 目录下以避免与 service 层形成循环导入。
"""
import json
from typing import Optional, Dict

import redis

from rps_core.config import (
    REDIS_URL,
    MATCH_QUEUE_PREFIX,
    GAME_CACHE_PREFIX,
    WS_PREFIX,
)


class RedisClient:
    """Redis 客户端，封装匹配队列、WebSocket 注册与对局缓存操作"""

    def __init__(self):
        """使用 REDIS_URL 创建 Redis 客户端，开启 decode_responses 自动解码"""
        self.client = redis.from_url(REDIS_URL, decode_responses=True)

    def is_connected(self) -> bool:
        """通过 ping 检查 Redis 连接是否正常"""
        try:
            self.client.ping()
            return True
        except Exception:
            return False

    # ==================== 匹配队列操作 ====================

    def _queue_key(self, token: str, bet_amount: float) -> str:
        """构造匹配队列的 Redis Key"""
        return f"{MATCH_QUEUE_PREFIX}{token}:{bet_amount}"

    def add_to_match_queue(self, player_address: str, token: str, bet_amount: float) -> int:
        """
        将玩家加入匹配队列尾部

        使用 rpush 推入 List 尾部，llen 返回当前队列长度作为位置。
        注意：单次调用只推送一次，避免重复推送导致队列污染。
        """
        queue_key = self._queue_key(token, bet_amount)

        # 序列化玩家信息
        player_data = json.dumps({
            "address": player_address,
            "token": token,
            "bet_amount": bet_amount,
        })

        # 推入队列尾部（FIFO：头部是最早加入的玩家）
        self.client.rpush(queue_key, player_data)

        # 返回当前队列长度作为位置
        return self.client.llen(queue_key)

    def remove_from_match_queue(self, player_address: str, token: str, bet_amount: float) -> bool:
        """
        从匹配队列移除指定玩家

        遍历 lrange 结果，找到 address 匹配的元素后用 lrem 删除。
        """
        queue_key = self._queue_key(token, bet_amount)
        items = self.client.lrange(queue_key, 0, -1)

        for item in items:
            try:
                data = json.loads(item)
            except json.JSONDecodeError:
                continue
            if data.get("address") == player_address:
                # 按原始字符串值删除一个匹配元素
                self.client.lrem(queue_key, 1, item)
                return True

        return False

    def get_match_queue_length(self, token: str, bet_amount: float) -> int:
        """获取匹配队列长度"""
        return self.client.llen(self._queue_key(token, bet_amount))

    def try_match_players(self, token: str, bet_amount: float) -> Optional[Dict]:
        """
        尝试从队列头部弹出两个玩家进行匹配

        - 队列为空：返回 None
        - 队列只有一个玩家：将其放回队列并返回 None
        - 队列有两个及以上：弹出两个并返回 {"player1": ..., "player2": ...}
        """
        queue_key = self._queue_key(token, bet_amount)

        # 从头部弹出（FIFO：头部是最早加入的玩家）
        player1_data = self.client.lpop(queue_key)
        if not player1_data:
            return None

        player2_data = self.client.lpop(queue_key)
        if not player2_data:
            # 队列中只有一个玩家，放回原位
            self.client.rpush(queue_key, player1_data)
            return None

        return {
            "player1": json.loads(player1_data),
            "player2": json.loads(player2_data),
        }

    def get_queue_position(self, player_address: str, token: str, bet_amount: float) -> Optional[int]:
        """
        获取玩家在匹配队列中的位置（1 开始）

        队列头部（最早加入）位置为 1，依次递增。不在队列返回 None。
        """
        queue_key = self._queue_key(token, bet_amount)
        items = self.client.lrange(queue_key, 0, -1)

        for i, item in enumerate(items):
            try:
                data = json.loads(item)
            except json.JSONDecodeError:
                continue
            if data.get("address") == player_address:
                # i 是 0 索引，位置从 1 开始
                return i + 1

        return None

    # ==================== WebSocket 连接管理 ====================

    def register_ws_connection(self, player_address: str, connection_id: str):
        """注册玩家 WebSocket 连接 ID"""
        self.client.set(f"{WS_PREFIX}{player_address}", connection_id)

    def unregister_ws_connection(self, player_address: str):
        """注销玩家 WebSocket 连接"""
        self.client.delete(f"{WS_PREFIX}{player_address}")

    def get_ws_connection(self, player_address: str) -> Optional[str]:
        """获取玩家 WebSocket 连接 ID，不存在返回 None"""
        return self.client.get(f"{WS_PREFIX}{player_address}")

    # ==================== 游戏状态缓存 ====================

    def cache_game_state(self, game_id: int, state: dict):
        """缓存对局状态（JSON 序列化后存储）"""
        self.client.set(f"{GAME_CACHE_PREFIX}{game_id}", json.dumps(state))

    def get_cached_game_state(self, game_id: int) -> Optional[dict]:
        """获取缓存的对局状态，不存在或解析失败返回 None"""
        data = self.client.get(f"{GAME_CACHE_PREFIX}{game_id}")
        if not data:
            return None
        try:
            return json.loads(data)
        except json.JSONDecodeError:
            return None

    def delete_cached_game_state(self, game_id: int):
        """删除缓存的对局状态"""
        self.client.delete(f"{GAME_CACHE_PREFIX}{game_id}")


# 全局 Redis 客户端实例
redis_client = RedisClient()
