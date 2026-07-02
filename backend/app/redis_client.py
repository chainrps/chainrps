"""
Redis 连接管理
"""
import redis
import json
from typing import Optional, List, Dict

from .config import REDIS_URL, MATCH_QUEUE_PREFIX


class RedisClient:
    """Redis 客户端"""

    def __init__(self):
        self.client = redis.from_url(REDIS_URL, decode_responses=True)

    def is_connected(self) -> bool:
        """检查连接状态"""
        try:
            self.client.ping()
            return True
        except:
            return False

    # ==================== 匹配队列操作 ====================

    def add_to_match_queue(self, player_address: str, token: str, bet_amount: float) -> int:
        """
        将玩家加入匹配队列
        
        Returns:
            队列位置
        """
        queue_key = f"{MATCH_QUEUE_PREFIX}{token}:{bet_amount}"

        # 存储玩家信息
        player_data = json.dumps({
            "address": player_address,
            "token": token,
            "bet_amount": bet_amount,
            "joined_at": None  # 加入时间，用于计算等待时长
        })

        # 加入队列（左侧推入，右侧弹出 = FIFO）
        self.client.lpush(queue_key, player_data)

        # 设置加入时间
        self.client.lpush(queue_key, json.dumps({
            "address": player_address,
            "token": token,
            "bet_amount": bet_amount,
            "joined_at": int(self.client.time()[0])
        }))
        # 删除旧记录
        self.client.lpop(queue_key)

        # 返回队列长度（位置）
        return self.client.llen(queue_key)

    def remove_from_match_queue(self, player_address: str, token: str, bet_amount: float) -> bool:
        """
        从匹配队列移除玩家
        
        Returns:
            是否成功移除
        """
        queue_key = f"{MATCH_QUEUE_PREFIX}{token}:{bet_amount}"

        # 获取队列所有元素
        items = self.client.lrange(queue_key, 0, -1)

        for item in items:
            data = json.loads(item)
            if data["address"] == player_address:
                # 移除匹配的元素
                self.client.lrem(queue_key, 1, item)
                return True

        return False

    def get_match_queue_length(self, token: str, bet_amount: float) -> int:
        """获取匹配队列长度"""
        queue_key = f"{MATCH_QUEUE_PREFIX}{token}:{bet_amount}"
        return self.client.llen(queue_key)

    def try_match_players(self, token: str, bet_amount: float) -> Optional[Dict]:
        """
        尝试匹配两个玩家
        
        Returns:
            匹配成功返回两个玩家信息，否则返回 None
        """
        queue_key = f"{MATCH_QUEUE_PREFIX}{token}:{bet_amount}"

        # 尝试弹出两个玩家（右侧弹出 = FIFO）
        player1_data = self.client.rpop(queue_key)

        if player1_data:
            player1 = json.loads(player1_data)
            player2_data = self.client.rpop(queue_key)

            if player2_data:
                player2 = json.loads(player2_data)
                return {
                    "player1": player1,
                    "player2": player2
                }
            else:
                # 只有一个玩家，重新放回队列
                self.client.rpush(queue_key, player1_data)
                return None

        return None

    def get_queue_position(self, player_address: str, token: str, bet_amount: float) -> Optional[int]:
        """
        获取玩家在队列中的位置
        
        Returns:
            位置（1开始），不在队列返回 None
        """
        queue_key = f"{MATCH_QUEUE_PREFIX}{token}:{bet_amount}"

        items = self.client.lrange(queue_key, 0, -1)

        for i, item in enumerate(items):
            data = json.loads(item)
            if data["address"] == player_address:
                return len(items) - i  # FIFO 队列，位置从尾部计算

        return None

    # ==================== WebSocket 连接管理 ====================

    def register_ws_connection(self, player_address: str, connection_id: str):
        """注册 WebSocket 连接"""
        self.client.set(f"ws:{player_address}", connection_id)

    def unregister_ws_connection(self, player_address: str):
        """注销 WebSocket 连接"""
        self.client.delete(f"ws:{player_address}")

    def get_ws_connection(self, player_address: str) -> Optional[str]:
        """获取 WebSocket 连接 ID"""
        return self.client.get(f"ws:{player_address}")

    # ==================== 游戏状态缓存 ====================

    def cache_game_state(self, game_id: int, state: dict):
        """缓存对局状态"""
        self.client.set(f"game:{game_id}", json.dumps(state))

    def get_cached_game_state(self, game_id: int) -> Optional[dict]:
        """获取缓存的对局状态"""
        data = self.client.get(f"game:{game_id}")
        if data:
            return json.loads(data)
        return None

    def delete_cached_game_state(self, game_id: int):
        """删除缓存的对局状态"""
        self.client.delete(f"game:{game_id}")


# 全局 Redis 客户端实例
redis_client = RedisClient()