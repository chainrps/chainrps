"""
ChainRPS 机器人（Bot）API 路由

提供 Bot 集群管理接口：
- 集群状态查询
- Bot 实例 CRUD（创建/删除/启动/停止/重启）
- 批量操作（启动全部/停止全部/重启全部）
- Bot 配置管理（热更新）
- 钱包池管理
- 运行日志查询
- 策略信息查询
- 向后兼容的单点 Bot 控制接口

所有写操作（除查询外）需要管理员权限。
"""
import asyncio
import logging
from datetime import datetime
from typing import Optional, List

from fastapi import APIRouter, HTTPException, Query, Request

from rps_backend.models import (
    BaseModel,
    BotCreateRequest,
    BotUpdateConfigRequest,
    BotActionRequest,
    BotInstanceResponse,
    BotClusterStatusResponse,
    BotWalletResponse,
    BotLogEntry,
    BotWalletPoolStatus,
    BotStrategyInfo,
    BotOperationResponse,
)
from rps_backend.service.bot_service import bot_service, BotConfig
from rps_backend.service.bot_manager import bot_manager
from rps_backend.config import BOT_ENABLED, RPC_CHAIN_ID

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/bot", tags=["bot"])


# ==================== 请求/响应模型 ====================

class BotConfigUpdateRequest(BaseModel):
    """Bot 配置更新请求"""
    auto_create_room: Optional[bool] = None
    auto_join_room: Optional[bool] = None
    bet_amount: Optional[float] = None
    create_interval: Optional[int] = None
    scan_interval: Optional[int] = None
    commit_delay: Optional[int] = None
    reveal_delay: Optional[int] = None
    max_concurrent_rooms: Optional[int] = None


# ==================== 辅助函数 ====================

def _check_bot_available() -> None:
    """检查 Bot 是否可用"""
    if RPC_CHAIN_ID != 5208888:
        raise HTTPException(
            status_code=403,
            detail="Bot 仅在测试链（Chain ID: 5208888）上可用"
        )


def _get_admin_address(admin_address: Optional[str], request: Request = None) -> Optional[str]:
    """从参数或请求头获取管理员地址"""
    if admin_address:
        return admin_address
    if request:
        return request.headers.get("X-Admin-Address")
    return None


def _require_admin(admin_address: Optional[str], request: Request = None) -> None:
    """检查管理员权限"""
    admin_addr = _get_admin_address(admin_address, request)
    from rps_backend.config import ADMIN_WHITELIST, DEBUG
    if not ADMIN_WHITELIST and DEBUG:
        return  # 开发环境跳过
    if admin_addr and admin_addr.lower() in [addr.lower() for addr in ADMIN_WHITELIST]:
        return
    if not ADMIN_WHITELIST:
        return  # 未配置白名单，跳过
    raise HTTPException(status_code=403, detail="需要管理员权限")


# ==================== API 端点 ====================

@router.post("/start")
async def start_bot(admin_address: str = Query(None, description="管理员钱包地址"), request: Request = None):
    """启动 Bot 服务（管理员）"""
    _check_bot_available()
    _require_admin(admin_address, request)

    success = await bot_service.start()
    if success:
        return {"success": True, "message": "Bot 服务已启动", "status": bot_service.get_status()}
    else:
        raise HTTPException(status_code=500, detail="Bot 启动失败")


@router.post("/stop")
async def stop_bot(admin_address: str = Query(None, description="管理员钱包地址"), request: Request = None):
    """停止 Bot 服务（管理员）"""
    _check_bot_available()
    _require_admin(admin_address, request)

    success = await bot_service.stop()
    if success:
        return {"success": True, "message": "Bot 服务已停止"}
    else:
        raise HTTPException(status_code=500, detail="Bot 停止失败")


@router.get("/status")
async def get_bot_status():
    """查询 Bot 运行状态（公开）"""
    status = bot_service.get_status()
    status["chain_id"] = RPC_CHAIN_ID
    status["chain_name"] = "ChainRPS_Local"
    return status


@router.get("/wallet")
async def get_bot_wallet(admin_address: str = Query(None, description="管理员钱包地址")):
    """查询 Bot 钱包余额（管理员）"""
    _check_bot_available()
    _require_admin(admin_address)

    # 确保钱包已初始化
    if not bot_service._wallet_available:
        await bot_service.initialize()

    wallet_info = bot_service.get_wallet_info()
    return wallet_info


@router.get("/rooms")
async def get_bot_rooms(admin_address: str = Query(None, description="管理员钱包地址")):
    """查询 Bot 当前参与的所有房间（管理员）"""
    _check_bot_available()
    _require_admin(admin_address)

    return {
        "active_rooms": list(bot_service._active_rooms.values()),
        "total_active": len(bot_service._active_rooms),
    }


@router.post("/create-room")
async def bot_create_room(admin_address: str = Query(None, description="管理员钱包地址")):
    """手动触发 Bot 创建房间（管理员）"""
    _check_bot_available()
    _require_admin(admin_address)

    if not bot_service._is_running:
        await bot_service.start()

    result = await bot_service._create_room()
    if result:
        return {"success": True, "room": result}
    else:
        raise HTTPException(status_code=500, detail="Bot 创建房间失败")


@router.get("/config")
async def get_bot_config(admin_address: str = Query(None, description="管理员钱包地址")):
    """读取 Bot 当前行为配置（管理员）"""
    _check_bot_available()
    _require_admin(admin_address)

    return bot_service._config.to_dict()


@router.put("/config")
async def update_bot_config(
    config_update: BotConfigUpdateRequest,
    admin_address: str = Query(None, description="管理员钱包地址"),
):
    """更新 Bot 行为配置（热更新，管理员）"""
    _check_bot_available()
    _require_admin(admin_address)

    update_data = config_update.model_dump(exclude_unset=True)
    updated = bot_service.update_config(**update_data)
    return {"success": True, "config": updated}


@router.post("/reset-wallet")
async def reset_bot_wallet(admin_address: str = Query(None, description="管理员钱包地址")):
    """重置 Bot 钱包（清空余额/重新分配，管理员）"""
    _check_bot_available()
    _require_admin(admin_address)

    result = await bot_service.reset_wallet()
    if result.get("success"):
        return result
    else:
        raise HTTPException(status_code=500, detail=result.get("message", "钱包重置失败"))


# ==================== 初始化端点 ====================

@router.post("/init")
async def init_bot(admin_address: str = Query(None, description="管理员钱包地址")):
    """初始化 Bot（不自动启动，仅初始化钱包，管理员）"""
    _check_bot_available()
    _require_admin(admin_address)

    if bot_service._wallet_available:
        return {"success": True, "message": "Bot 已初始化", "wallet": bot_service._wallet_address}

    success = await bot_service.initialize()
    if success:
        # 自动充值
        await bot_service.ensure_wallet_funded()
        return {"success": True, "message": "Bot 初始化完成", "wallet": bot_service._wallet_address}
    else:
        raise HTTPException(status_code=500, detail="Bot 初始化失败")


# ==================== 集群管理 API ====================

@router.get("/cluster/status", response_model=BotClusterStatusResponse)
async def get_cluster_status(admin_address: str = Query(None)):
    """查询 Bot 集群整体状态（即使不在测试链也可使用）"""
    try:
        status = bot_manager.get_cluster_status()
        return status
    except Exception as e:
        logger.warning(f"获取集群状态失败: {e}")
        # 返回默认状态
        return {
            "total_instances": 0,
            "running_instances": 0,
            "max_instances": 0,
            "total_games_played": 0,
            "total_wins": 0,
            "total_losses": 0,
            "win_rate": 0.0,
            "instances": [],
            "initialized": False,
            "bot_enabled": BOT_ENABLED,
        }


@router.get("/cluster/instances", response_model=List[BotInstanceResponse])
async def list_bot_instances(admin_address: str = Query(None)):
    """列出所有 Bot 实例概要"""
    try:
        return bot_manager.list_instances()
    except Exception as e:
        logger.warning(f"获取实例列表失败: {e}")
        return []


@router.get("/cluster/instances/{bot_id}", response_model=BotInstanceResponse)
async def get_bot_instance(bot_id: str, admin_address: str = Query(None)):
    """获取指定 Bot 实例的详细状态"""
    try:
        status = bot_manager.get_instance_status(bot_id)
        if not status:
            raise HTTPException(status_code=404, detail=f"Bot {bot_id} 不存在")
        return status
    except HTTPException:
        raise
    except Exception as e:
        logger.warning(f"获取实例详情失败: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/cluster/instances", response_model=BotOperationResponse)
async def create_bot_instance(
    request: BotCreateRequest,
    admin_address: str = Query(None),
):
    """创建新的 Bot 实例"""
    _check_bot_available()
    _require_admin(admin_address)

    result = await bot_manager.create_instance(
        name=request.name,
        strategy=request.strategy,
        token=request.token,
        bet_amount=request.bet_amount,
        auto_create_room=request.auto_create_room,
        auto_join_room=request.auto_join_room,
        max_concurrent_rooms=request.max_concurrent_rooms,
        create_interval=request.create_interval,
        scan_interval=request.scan_interval,
        commit_delay=request.commit_delay,
        reveal_delay=request.reveal_delay,
        wallet_balance_threshold=request.wallet_balance_threshold,
        auto_chain_match=request.auto_chain_match,
        mimic_choice=request.mimic_choice,
    )
    return result


@router.delete("/cluster/instances/{bot_id}", response_model=BotOperationResponse)
async def delete_bot_instance(bot_id: str, admin_address: str = Query(None)):
    """删除 Bot 实例"""
    _check_bot_available()
    _require_admin(admin_address)

    result = await bot_manager.delete_instance(bot_id)
    if not result.get("success"):
        raise HTTPException(status_code=404, detail=result.get("message"))
    return result


@router.post("/cluster/instances/{bot_id}/start", response_model=BotOperationResponse)
async def start_bot_instance(bot_id: str, admin_address: str = Query(None)):
    """启动指定 Bot 实例"""
    _check_bot_available()
    _require_admin(admin_address)

    result = await bot_manager.start_instance(bot_id)
    if not result.get("success"):
        raise HTTPException(status_code=500, detail=result.get("message"))
    return result


@router.post("/cluster/instances/{bot_id}/stop", response_model=BotOperationResponse)
async def stop_bot_instance(bot_id: str, admin_address: str = Query(None)):
    """停止指定 Bot 实例"""
    _check_bot_available()
    _require_admin(admin_address)

    result = await bot_manager.stop_instance(bot_id)
    return result


@router.post("/cluster/instances/{bot_id}/restart", response_model=BotOperationResponse)
async def restart_bot_instance(bot_id: str, admin_address: str = Query(None)):
    """重启指定 Bot 实例"""
    _check_bot_available()
    _require_admin(admin_address)

    result = await bot_manager.restart_instance(bot_id)
    return result


@router.put("/cluster/instances/{bot_id}/config", response_model=BotOperationResponse)
async def update_bot_instance_config(
    bot_id: str,
    config_update: BotUpdateConfigRequest,
    admin_address: str = Query(None),
):
    """更新 Bot 实例配置（热更新）"""
    _check_bot_available()
    _require_admin(admin_address)

    update_data = config_update.model_dump(exclude_unset=True)
    result = await bot_manager.update_instance_config(bot_id, **update_data)
    return result


@router.post("/cluster/start-all", response_model=BotOperationResponse)
async def start_all_bots(admin_address: str = Query(None)):
    """启动所有 Bot 实例"""
    _check_bot_available()
    _require_admin(admin_address)

    result = await bot_manager.start_all()
    return result


@router.post("/cluster/stop-all", response_model=BotOperationResponse)
async def stop_all_bots(admin_address: str = Query(None)):
    """停止所有 Bot 实例"""
    _check_bot_available()
    _require_admin(admin_address)

    result = await bot_manager.stop_all()
    return result


@router.post("/cluster/restart-all", response_model=BotOperationResponse)
async def restart_all_bots(admin_address: str = Query(None)):
    """重启所有 Bot 实例"""
    _check_bot_available()
    _require_admin(admin_address)

    result = await bot_manager.restart_all()
    return result


@router.get("/cluster/instances/{bot_id}/logs", response_model=List[BotLogEntry])
async def get_bot_instance_logs(
    bot_id: str,
    limit: int = Query(50, ge=1, le=200, description="日志条数"),
    admin_address: str = Query(None),
):
    """获取 Bot 实例运行日志"""
    _check_bot_available()
    _require_admin(admin_address)

    logs = bot_manager.get_instance_logs(bot_id, limit=limit)
    return logs


@router.get("/cluster/wallet-pool", response_model=BotWalletPoolStatus)
async def get_wallet_pool_status(admin_address: str = Query(None)):
    """查询钱包池状态"""
    _check_bot_available()
    _require_admin(admin_address)

    return bot_manager.get_wallet_pool_status()


@router.post("/cluster/instances/{bot_id}/fund", response_model=BotOperationResponse)
async def fund_bot_instance(bot_id: str, admin_address: str = Query(None)):
    """为 Bot 钱包充值"""
    _check_bot_available()
    _require_admin(admin_address)

    result = await bot_manager.ensure_instance_funded(bot_id)
    return {"success": True, "message": "钱包充值操作完成", "data": result}


@router.post("/cluster/instances/{bot_id}/reset-wallet", response_model=BotOperationResponse)
async def reset_bot_instance_wallet(bot_id: str, admin_address: str = Query(None)):
    """重置 Bot 钱包"""
    _check_bot_available()
    _require_admin(admin_address)

    result = await bot_manager.reset_instance_wallet(bot_id)
    return result


@router.get("/cluster/strategies", response_model=List[BotStrategyInfo])
async def get_bot_strategies(admin_address: str = Query(None)):
    """获取所有出拳策略信息"""
    return bot_manager.get_strategies()
