"""
Redis 客户端模块

提供 ChainRPS 后端的 Redis 操作封装，包括：
- 匹配队列管理（基于 Redis List 实现 FIFO 队列）
- WebSocket 连接注册（用于跨进程查询玩家连接）
- 对局状态缓存（降低数据库读压力）

放置在 utils 目录下以避免与 service 层形成循环导入。

降级方案：当 Redis 不可用时，自动切换到内存模式，确保开发环境无 Redis 也能正常运行。
"""
import json
from typing import Optional, Dict, List

try:
    import redis
    _REDIS_AVAILABLE = True
except ImportError:
    _REDIS_AVAILABLE = False

from rps_backend.config import (
    REDIS_URL,
    MATCH_QUEUE_PREFIX,
    GAME_CACHE_PREFIX,
    ROOM_CACHE_PREFIX,
    WS_PREFIX,
)


# Redis客户端
class RedisClient:
    """Redis 客户端，封装匹配队列、WebSocket 注册与对局缓存操作

    当 Redis 不可用时自动降级为内存模式，确保开发环境可用。
    """

    # 初始化
    def __init__(self):
        """使用 REDIS_URL 创建 Redis 客户端，开启 decode_responses 自动解码

        若 Redis 库未安装或连接失败，则启用内存降级模式。
        """
        self._memory_mode = False
        self.client = None

        if not _REDIS_AVAILABLE:
            print("⚠️  redis-py 未安装，使用内存降级模式")
            self._memory_mode = True
            self._init_memory_store()
            return

        try:
            # 强制使用 RESP2 协议（protocol=2），避免向旧版 Redis 发送 HELLO 命令
            # redis-py 5.x 默认会尝试 RESP3（HELLO 命令），Redis < 6.0 不支持
            self.client = redis.from_url(REDIS_URL, decode_responses=True, protocol=2)
            self.client.ping()
        except Exception as e:
            print(f"⚠️  Redis 连接失败，使用内存降级模式: {e}")
            self._memory_mode = True
            self._init_memory_store()

    # 初始化内存存储
    def _init_memory_store(self):
        """初始化内存存储（降级模式使用）"""
        self._match_queues: Dict[str, List[str]] = {}
        self._ws_connections: Dict[str, str] = {}
        self._game_cache: Dict[str, str] = {}
        self._room_cache: Dict[str, str] = {}

    # 检查Redis连接状态
    def is_connected(self) -> bool:
        """通过 ping 检查 Redis 连接是否正常"""
        if self._memory_mode:
            return False
        try:
            self.client.ping()
            return True
        except Exception:
            return False

    # ==================== 匹配队列操作 ====================

    # 构造队列键名
    def _queue_key(self, token: str, bet_amount: float) -> str:
        """构造匹配队列的 Redis Key"""
        return f"{MATCH_QUEUE_PREFIX}{token}:{bet_amount}"

    # 添加到匹配队列
    def add_to_match_queue(self, player_address: str, token: str, bet_amount: float) -> int:
        """
        将玩家加入匹配队列尾部

        使用 rpush 推入 List 尾部，llen 返回当前队列长度作为位置。
        注意：单次调用只推送一次，避免重复推送导致队列污染。
        """
        queue_key = self._queue_key(token, bet_amount)

        player_data = json.dumps({
            "address": player_address,
            "token": token,
            "bet_amount": bet_amount,
        })

        if self._memory_mode:
            if queue_key not in self._match_queues:
                self._match_queues[queue_key] = []
            self._match_queues[queue_key].append(player_data)
            return len(self._match_queues[queue_key])

        self.client.rpush(queue_key, player_data)
        return self.client.llen(queue_key)

    # 从匹配队列移除
    def remove_from_match_queue(self, player_address: str, token: str, bet_amount: float) -> bool:
        """
        从匹配队列移除指定玩家

        遍历 lrange 结果，找到 address 匹配的元素后用 lrem 删除。
        """
        queue_key = self._queue_key(token, bet_amount)

        if self._memory_mode:
            queue = self._match_queues.get(queue_key, [])
            for i, item in enumerate(queue):
                try:
                    data = json.loads(item)
                except json.JSONDecodeError:
                    continue
                if data.get("address") == player_address:
                    queue.pop(i)
                    return True
            return False

        items = self.client.lrange(queue_key, 0, -1)
        for item in items:
            try:
                data = json.loads(item)
            except json.JSONDecodeError:
                continue
            if data.get("address") == player_address:
                self.client.lrem(queue_key, 1, item)
                return True

        return False

    # 获取队列长度
    def get_match_queue_length(self, token: str, bet_amount: float) -> int:
        """获取匹配队列长度"""
        queue_key = self._queue_key(token, bet_amount)

        if self._memory_mode:
            return len(self._match_queues.get(queue_key, []))

        return self.client.llen(queue_key)

    # 尝试匹配玩家
    def try_match_players(self, token: str, bet_amount: float) -> Optional[Dict]:
        """
        尝试从队列头部弹出两个玩家进行匹配

        - 队列为空：返回 None
        - 队列只有一个玩家：将其放回队列并返回 None
        - 队列有两个及以上：弹出两个并返回 {"player1": ..., "player2": ...}
        """
        queue_key = self._queue_key(token, bet_amount)

        if self._memory_mode:
            queue = self._match_queues.get(queue_key, [])
            if len(queue) < 2:
                return None
            player1_data = queue.pop(0)
            player2_data = queue.pop(0)
            return {
                "player1": json.loads(player1_data),
                "player2": json.loads(player2_data),
            }

        player1_data = self.client.lpop(queue_key)
        if not player1_data:
            return None

        player2_data = self.client.lpop(queue_key)
        if not player2_data:
            self.client.rpush(queue_key, player1_data)
            return None

        return {
            "player1": json.loads(player1_data),
            "player2": json.loads(player2_data),
        }

    # 获取队列位置
    def get_queue_position(self, player_address: str, token: str, bet_amount: float) -> Optional[int]:
        """
        获取玩家在匹配队列中的位置（1 开始）

        队列头部（最早加入）位置为 1，依次递增。不在队列返回 None。
        """
        queue_key = self._queue_key(token, bet_amount)

        if self._memory_mode:
            queue = self._match_queues.get(queue_key, [])
            for i, item in enumerate(queue):
                try:
                    data = json.loads(item)
                except json.JSONDecodeError:
                    continue
                if data.get("address") == player_address:
                    return i + 1
            return None

        items = self.client.lrange(queue_key, 0, -1)
        for i, item in enumerate(items):
            try:
                data = json.loads(item)
            except json.JSONDecodeError:
                continue
            if data.get("address") == player_address:
                return i + 1

        return None

    # ==================== WebSocket 连接管理 ====================

    # 注册WebSocket连接
    def register_ws_connection(self, player_address: str, connection_id: str):
        """注册玩家 WebSocket 连接 ID"""
        if self._memory_mode:
            self._ws_connections[player_address] = connection_id
            return
        self.client.set(f"{WS_PREFIX}{player_address}", connection_id)

    # 注销WebSocket连接
    def unregister_ws_connection(self, player_address: str):
        """注销玩家 WebSocket 连接"""
        if self._memory_mode:
            self._ws_connections.pop(player_address, None)
            return
        self.client.delete(f"{WS_PREFIX}{player_address}")

    # 获取WebSocket连接
    def get_ws_connection(self, player_address: str) -> Optional[str]:
        """获取玩家 WebSocket 连接 ID，不存在返回 None"""
        if self._memory_mode:
            return self._ws_connections.get(player_address)
        return self.client.get(f"{WS_PREFIX}{player_address}")

    # ==================== 游戏状态缓存 ====================

    # 缓存游戏状态
    def cache_game_state(self, game_id: int, state: dict):
        """缓存对局状态（JSON 序列化后存储）"""
        if self._memory_mode:
            self._game_cache[str(game_id)] = json.dumps(state)
            return
        self.client.set(f"{GAME_CACHE_PREFIX}{game_id}", json.dumps(state))

    # 获取缓存的游戏状态
    def get_cached_game_state(self, game_id: int) -> Optional[dict]:
        """获取缓存的对局状态，不存在或解析失败返回 None"""
        if self._memory_mode:
            data = self._game_cache.get(str(game_id))
        else:
            data = self.client.get(f"{GAME_CACHE_PREFIX}{game_id}")

        if not data:
            return None
        try:
            return json.loads(data)
        except json.JSONDecodeError:
            return None

    # 删除缓存的游戏状态
    def delete_cached_game_state(self, game_id: int):
        """删除缓存的对局状态"""
        if self._memory_mode:
            self._game_cache.pop(str(game_id), None)
            return
        self.client.delete(f"{GAME_CACHE_PREFIX}{game_id}")

    # ==================== 房间状态缓存 ====================

    # 缓存房间状态
    def cache_room_state(self, room_id: str, state: dict):
        """缓存房间状态（JSON 序列化后存储）"""
        if self._memory_mode:
            self._room_cache[room_id] = json.dumps(state)
            return
        self.client.set(f"{ROOM_CACHE_PREFIX}{room_id}", json.dumps(state))

    # 获取缓存的房间状态
    def get_cached_room_state(self, room_id: str) -> Optional[dict]:
        """获取缓存的房间状态，不存在或解析失败返回 None"""
        if self._memory_mode:
            data = self._room_cache.get(room_id)
        else:
            data = self.client.get(f"{ROOM_CACHE_PREFIX}{room_id}")

        if not data:
            return None
        try:
            return json.loads(data)
        except json.JSONDecodeError:
            return None

    # 删除缓存的房间状态
    def delete_cached_room_state(self, room_id: str):
        """删除缓存的房间状态"""
        if self._memory_mode:
            self._room_cache.pop(room_id, None)
            return
        self.client.delete(f"{ROOM_CACHE_PREFIX}{room_id}")


# 全局 Redis 客户端实例
redis_client = RedisClient()