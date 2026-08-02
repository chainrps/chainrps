"""
ChainRPS Bot 集群管理器 (BotManager)

提供多 Bot 实例的统一管理接口：
- 创建/删除 Bot 实例（自动分配钱包）
- 启动/停止/重启指定或全部 Bot
- 查询集群状态（运行中、钱包信息、统计）
- 批量操作（启动全部、停止全部）
- Bot 配置更新（策略、金额、自动行为等）
- 持久化存储（SQLite）
- 事件分发（将房间/游戏事件广播给活跃的 Bot）
"""
import asyncio
import logging
import time
from datetime import datetime, timezone
from typing import Dict, List, Optional

from rps_backend.config import (
    BOT_ENABLED,
    BOT_DEFAULT_STRATEGY,
    BOT_TOKEN,
    BOT_BET_AMOUNT,
    BOT_MAX_CONCURRENT_ROOMS,
    BOT_AUTO_CREATE_ROOM,
    BOT_AUTO_JOIN_ROOM,
    BOT_WALLET_POOL_START,
    BOT_WALLET_POOL_END,
)
from rps_backend.service.bot_service import BotInstance, BotConfig
from rps_backend.service.wallet_pool_manager import wallet_pool_manager
from rps_backend.service.strategy import get_strategy_info, VALID_STRATEGIES
from rps_backend.repository import (
    create_bot_instance as db_create_bot_instance,
    get_bot_instance as db_get_bot_instance,
    list_bot_instances as db_list_bot_instances,
    update_bot_instance as db_update_bot_instance,
    delete_bot_instance as db_delete_bot_instance,
    get_bot_logs,
)

logger = logging.getLogger(__name__)


class BotManager:
    """
    Bot 集群管理器

    管理多个 BotInstance 实例，提供统一的生命周期管理、
    事件分发、配置管理和统计查询能力。
    """

    def __init__(self):
        self._instances: Dict[str, BotInstance] = {}
        self._initialized: bool = False
        self._max_instances: int = BOT_WALLET_POOL_END - BOT_WALLET_POOL_START + 1

    # ==================== 集群初始化 ====================

    async def initialize(self) -> bool:
        """
        从数据库加载已有 Bot 实例并恢复状态
        """
        if self._initialized:
            return True

        if not BOT_ENABLED:
            logger.info("Bot 功能已禁用 (BOT_ENABLED=false)")
            self._initialized = True
            return True

        try:
            existing = db_list_bot_instances()
            restored = 0
            for row in existing:
                try:
                    bot_id = row.get("bot_id", "")
                    name = row.get("name", bot_id)
                    wallet_index = row.get("wallet_index", -1)
                    wallet_address = row.get("wallet_address", "")

                    if not (BOT_WALLET_POOL_START <= wallet_index <= BOT_WALLET_POOL_END):
                        logger.warning(f"跳过 Bot {bot_id}: 钱包索引 {wallet_index} 不在池范围 [{BOT_WALLET_POOL_START}, {BOT_WALLET_POOL_END}]")
                        continue

                    strategy = row.get("strategy", BOT_DEFAULT_STRATEGY)
                    token = row.get("token", BOT_TOKEN)
                    bet_amount = row.get("bet_amount", BOT_BET_AMOUNT)
                    auto_create = row.get("auto_create_room", 1)
                    auto_join = row.get("auto_join_room", 1)
                    max_rooms = row.get("max_concurrent_rooms", BOT_MAX_CONCURRENT_ROOMS)

                    instance = BotInstance(
                        bot_id=bot_id,
                        name=name,
                        wallet_index=wallet_index,
                        wallet_address=wallet_address,
                        strategy=strategy,
                        token=token,
                        bet_amount=float(bet_amount or BOT_BET_AMOUNT),
                        auto_create_room=bool(auto_create),
                        auto_join_room=bool(auto_join),
                        max_concurrent_rooms=int(max_rooms or BOT_MAX_CONCURRENT_ROOMS),
                    )
                    self._instances[bot_id] = instance
                    restored += 1
                except Exception as e:
                    logger.warning(f"恢复 Bot 实例失败: {e}")
                    continue

            logger.info(f"BotManager 已初始化，恢复 {restored} 个实例")
            self._initialized = True
            return True
        except Exception as e:
            logger.error(f"BotManager 初始化失败: {e}")
            return False

    async def shutdown(self) -> None:
        """关闭所有 Bot 实例"""
        for bot_id, instance in list(self._instances.items()):
            try:
                await instance.stop()
            except Exception as e:
                logger.warning(f"停止 Bot {bot_id} 失败: {e}")
        self._instances.clear()
        self._initialized = False
        logger.info("BotManager 已关闭")

    # ==================== 实例管理 ====================

    async def create_instance(self, name: str, **config_kwargs) -> dict:
        """
        创建新的 Bot 实例

        Args:
            name: Bot 名称
            **config_kwargs: BotConfig 配置参数

        Returns:
            创建结果
        """
        if not self._initialized:
            await self.initialize()

        if len(self._instances) >= self._max_instances:
            return {
                "success": False,
                "message": f"已达到最大实例数 ({self._max_instances})",
            }

        idx, addr = wallet_pool_manager.allocate()
        if idx < 0 or not addr:
            return {"success": False, "message": "钱包池已满或本地链未运行"}

        bot_id = f"bot_{int(time.time())}"
        instance = BotInstance(
            bot_id=bot_id,
            name=name or bot_id,
            wallet_index=idx,
            wallet_address=addr,
            **config_kwargs,
        )

        self._instances[bot_id] = instance

        try:
            db_create_bot_instance({
                "bot_id": bot_id,
                "name": name or bot_id,
                "strategy": instance._config.strategy,
                "wallet_index": idx,
                "wallet_address": addr,
                "token": instance._config.token,
                "bet_amount": instance._config.bet_amount,
                "auto_create_room": 1 if instance._config.auto_create_room else 0,
                "auto_join_room": 1 if instance._config.auto_join_room else 0,
                "max_concurrent_rooms": instance._config.max_concurrent_rooms,
                "status": "idle",
            })
        except Exception as e:
            logger.warning(f"持久化 Bot 实例失败: {e}")

        return {
            "success": True,
            "message": "Bot 实例创建成功",
            "bot_id": bot_id,
            "wallet_address": addr,
        }

    async def delete_instance(self, bot_id: str) -> dict:
        """删除 Bot 实例"""
        instance = self._instances.get(bot_id)
        if not instance:
            return {"success": False, "message": f"Bot {bot_id} 不存在"}

        if instance._is_running:
            await instance.stop()

        wallet_index = instance.wallet_index
        wallet_pool_manager.release(wallet_index)

        self._instances.pop(bot_id)
        db_delete_bot_instance(bot_id)

        return {"success": True, "message": f"Bot {bot_id} 已删除"}

    async def start_instance(self, bot_id: str) -> dict:
        """启动指定 Bot 实例"""
        instance = self._instances.get(bot_id)
        if not instance:
            return {"success": False, "message": f"Bot {bot_id} 不存在"}

        success = await instance.start()
        if success:
            return {"success": True, "message": f"Bot {bot_id} 已启动"}
        else:
            return {"success": False, "message": f"Bot {bot_id} 启动失败"}

    async def stop_instance(self, bot_id: str) -> dict:
        """停止指定 Bot 实例"""
        instance = self._instances.get(bot_id)
        if not instance:
            return {"success": False, "message": f"Bot {bot_id} 不存在"}

        success = await instance.stop()
        return {
            "success": success,
            "message": f"Bot {bot_id} 已停止" if success else "停止失败",
        }

    async def restart_instance(self, bot_id: str) -> dict:
        """重启指定 Bot 实例"""
        instance = self._instances.get(bot_id)
        if not instance:
            return {"success": False, "message": f"Bot {bot_id} 不存在"}

        success = await instance.restart()
        return {
            "success": success,
            "message": f"Bot {bot_id} 已重启" if success else "重启失败",
        }

    async def start_all(self) -> dict:
        """启动所有 Bot 实例"""
        results = []
        for bot_id, instance in self._instances.items():
            if not instance._is_running:
                success = await instance.start()
                results.append({"bot_id": bot_id, "success": success})
        return {"success": True, "started": len(results), "results": results}

    async def stop_all(self) -> dict:
        """停止所有 Bot 实例"""
        results = []
        for bot_id, instance in self._instances.items():
            if instance._is_running:
                success = await instance.stop()
                results.append({"bot_id": bot_id, "success": success})
        return {"success": True, "stopped": len(results), "results": results}

    async def restart_all(self) -> dict:
        """重启所有 Bot 实例"""
        results = []
        for bot_id, instance in self._instances.items():
            success = await instance.restart()
            results.append({"bot_id": bot_id, "success": success})
        return {"success": True, "restarted": len(results), "results": results}

    # ==================== 配置管理 ====================

    async def update_instance_config(self, bot_id: str, **config_kwargs) -> dict:
        """更新 Bot 配置"""
        instance = self._instances.get(bot_id)
        if not instance:
            return {"success": False, "message": f"Bot {bot_id} 不存在"}

        config = instance.update_config(**config_kwargs)
        return {"success": True, "message": "配置已更新", "config": config}

    async def ensure_instance_funded(self, bot_id: str) -> dict:
        """确保 Bot 钱包充值"""
        instance = self._instances.get(bot_id)
        if not instance:
            return {"success": False, "message": f"Bot {bot_id} 不存在"}
        return await instance.ensure_wallet_funded()

    async def reset_instance_wallet(self, bot_id: str) -> dict:
        """重置 Bot 钱包"""
        instance = self._instances.get(bot_id)
        if not instance:
            return {"success": False, "message": f"Bot {bot_id} 不存在"}
        return await instance.reset_wallet()

    # ==================== 状态查询 ====================

    def get_cluster_status(self) -> dict:
        """获取集群整体状态"""
        instances_status = []
        total_wins = 0
        total_losses = 0
        total_games = 0
        running_count = 0

        for bot_id, instance in self._instances.items():
            status = instance.get_status()
            instances_status.append(status)
            if status["is_running"]:
                running_count += 1
            total_wins += status.get("total_wins", 0)
            total_losses += status.get("total_losses", 0)
            total_games += status.get("total_games_played", 0)

        return {
            "total_instances": len(self._instances),
            "running_instances": running_count,
            "max_instances": self._max_instances,
            "total_games_played": total_games,
            "total_wins": total_wins,
            "total_losses": total_losses,
            "win_rate": round(total_wins / max(total_games, 1) * 100, 2),
            "instances": instances_status,
            "initialized": self._initialized,
            "bot_enabled": BOT_ENABLED,
        }

    def get_instance_status(self, bot_id: str) -> Optional[dict]:
        """获取单个 Bot 状态"""
        instance = self._instances.get(bot_id)
        if not instance:
            return None
        status = instance.get_status()
        status["wallet_info"] = instance.get_wallet_info()
        return status

    def get_instance_logs(self, bot_id: str, limit: int = 50) -> List[dict]:
        """获取 Bot 运行日志"""
        return get_bot_logs(bot_id, limit=limit)

    def get_wallet_pool_status(self) -> dict:
        """获取钱包池状态"""
        return wallet_pool_manager.get_pool_status()

    def get_strategies(self) -> List[dict]:
        """获取所有策略信息"""
        return get_strategy_info()

    def list_instances(self) -> List[dict]:
        """列出所有实例概要"""
        result = []
        for bot_id, instance in self._instances.items():
            result.append({
                "bot_id": bot_id,
                "name": instance.name,
                "is_running": instance._is_running,
                "status": instance._status,
                "wallet_address": instance._wallet_address,
                "strategy": instance._config.strategy,
                "active_rooms": len(instance._active_rooms),
                "total_games": instance._total_games_played,
                "total_wins": instance._total_wins,
            })
        return result

    # ==================== 事件分发 ====================

    async def dispatch_room_joined(self, room_id: str, player_address: str) -> None:
        """房间有新玩家加入时通知所有活跃 Bot"""
        for instance in self._instances.values():
            if instance._is_running:
                try:
                    await instance.on_room_joined(room_id, player_address)
                except Exception:
                    pass

    async def dispatch_room_ready_changed(self, room_id: str) -> None:
        """房间准备状态变更时通知所有活跃 Bot"""
        for instance in self._instances.values():
            if instance._is_running:
                try:
                    await instance.on_room_ready_changed(room_id)
                except Exception:
                    pass

    async def dispatch_player_ready(self, room_id: str) -> None:
        """玩家准备时通知所有活跃 Bot 立即尝试加入"""
        for instance in self._instances.values():
            if instance._is_running:
                try:
                    await instance.on_player_ready(room_id)
                except Exception:
                    pass

    async def dispatch_game_started(self, room_id: str, game_id: int) -> None:
        """游戏开始时通知所有活跃 Bot"""
        for instance in self._instances.values():
            if instance._is_running:
                try:
                    await instance.on_game_started_event(room_id, game_id)
                except Exception:
                    pass

    async def dispatch_chain_game_created(self, room_id: str, chain_game_id: int) -> None:
        """链上对局创建时通知所有活跃 Bot"""
        for instance in self._instances.values():
            if instance._is_running:
                try:
                    await instance.on_chain_game_created(room_id, chain_game_id)
                except Exception:
                    pass

    async def dispatch_game_result(self, game_id: int, result: dict) -> None:
        """游戏结算时通知所有活跃 Bot"""
        for instance in self._instances.values():
            try:
                await instance.on_game_result_event(game_id, result)
            except Exception:
                pass

    async def dispatch_room_closed(self, room_id: str) -> None:
        """房间关闭时通知所有活跃 Bot"""
        for instance in self._instances.values():
            try:
                await instance.on_room_closed(room_id)
            except Exception:
                pass

    async def dispatch_seat_ai_invited(self, room_id: str) -> None:
        """玩家邀请 AI 加入空位时通知所有活跃 Bot"""
        for instance in self._instances.values():
            if instance._is_running:
                try:
                    await instance.on_seat_ai_invited(room_id)
                except Exception:
                    pass

    # ==================== 便捷方法 ====================

    def get_running_count(self) -> int:
        return sum(1 for i in self._instances.values() if i._is_running)

    def get_instance(self, bot_id: str) -> Optional[BotInstance]:
        return self._instances.get(bot_id)


# 全局单例
bot_manager = BotManager()