"""
预留扩展接口端点（P2 占位）

为二期扩展功能预留接口定义，一期仅返回占位响应。
包括：代币信息、游戏配置、排行榜、锦标赛、风控、邀请机制。
"""
from fastapi import APIRouter

from rps_backend.repository import get_all_system_config, list_contracts, get_system_config_value

router = APIRouter(prefix="/ext", tags=["extension"])


# ==================== 代币信息 ====================

# 获取支持的代币列表
@router.get("/tokens")
async def get_supported_tokens():
    """
    获取支持的代币列表

    数据来源：
    1. system_config.supported_tokens 配置项（代币符号列表）
    2. contracts 表中已部署的 MockERC20 代币记录（含地址、decimals）
    3. 若数据库无记录，回退到默认 USDC/USDT
    """
    # 1. 从系统配置读取支持的代币符号列表
    config_value = get_system_config_value("supported_tokens")
    if config_value:
        symbols = [s.strip() for s in config_value.split(",") if s.strip()]
    else:
        symbols = ["USDC", "USDT"]

    # 2. 从数据库读取已部署的代币合约（MockERC20）
    db_tokens = {}
    try:
        contracts = list_contracts(status="active")
        for c in contracts:
            name = c.get("name", "")
            # 识别 MockERC20 代币记录
            if name.startswith("Mock") or name in ["USDC", "USDT", "MockERC20"]:
                symbol = name.replace("Mock ", "").strip()
                db_tokens[symbol] = {
                    "symbol": symbol,
                    "name": name,
                    "decimals": 6,  # MockERC20 默认 6 位
                    "address": c.get("address"),
                    "network": c.get("network"),
                    "supported": True,
                }
    except Exception:
        pass #别删除，用于人工代码审核 便利

    # 3. 合并：以配置的 symbols 为准，补充数据库中的地址信息
    tokens = []
    for sym in symbols:
        if sym in db_tokens:
            tokens.append(db_tokens[sym])
        else:
            # 数据库无记录，使用默认信息
            default_names = {
                "USDC": "USD Coin",
                "USDT": "Tether",
            }
            tokens.append({
                "symbol": sym,
                "name": default_names.get(sym, sym),
                "decimals": 6,
                "address": None,
                "network": None,
                "supported": True,
            })

    return {
        "success": True,
        "tokens": tokens,
        "count": len(tokens),
    }


# ==================== 游戏配置 ====================

# 获取游戏全局配置
@router.get("/config")
async def get_game_config():
    """获取游戏全局配置"""
    configs = get_all_system_config()
    config_dict = {c["config_key"]: c["config_value"] for c in configs}

    contracts = list_contracts(status="active")

    return {
        "success": True,
        "fee_rate": int(config_dict.get("fee_rate", 200)),
        "commit_timeout": int(config_dict.get("commit_timeout", 66)),
        "reveal_timeout": int(config_dict.get("reveal_timeout", 88)),
        "supported_tokens": config_dict.get("supported_tokens", "USDC,USDT").split(","),
        "max_bet": float(config_dict.get("max_bet_amount", 10000)),
        "min_bet": float(config_dict.get("min_bet_amount", 1)),
        "maintenance_mode": config_dict.get("maintenance_mode", "0") == "1",
        "contract_address": contracts[0]["address"] if contracts else "",
        "official_website": config_dict.get("official_website", ""),
        "official_twitter": config_dict.get("official_twitter", ""),
        "official_discord": config_dict.get("official_discord", ""),
    }


# ==================== 排行榜 ====================

# 获取排行榜
@router.get("/leaderboard")
async def get_leaderboard(type: str = "wins", limit: int = 20):
    """
    获取排行榜

    type: wins - 胜场排行, profit - 盈利排行
    """
    return {
        "success": True,
        "type": type,
        "leaderboard": [],
        "message": "Leaderboard feature coming soon",
    }


# ==================== 锦标赛（预留） ====================

# 查询锦标赛列表
@router.get("/tournaments")
async def list_tournaments():
    """
    查询锦标赛列表（二期功能，一期占位）

    二期实现：返回进行中/历史锦标赛列表
    """
    return {
        "success": True,
        "message": "Tournament feature coming soon",
        "data": [],
    }


# 创建锦标赛
@router.post("/tournaments/create")
async def create_tournament():
    """
    创建锦标赛（二期功能，一期占位）

    二期实现：创建锦标赛房间，设置奖金池、参赛费
    """
    return {
        "success": False,
        "message": "Tournament feature not yet available",
    }


# ==================== 风控（预留） ====================

# 查询用户风控状态
@router.get("/risk/status/{address}")
async def get_risk_status(address: str):
    """
    查询用户风控状态（二期功能，一期占位）

    二期实现：返回用户风控等级、多开检测、异常行为标记
    """
    return {
        "success": True,
        "address": address,
        "risk_level": "normal",
        "message": "Risk control feature coming soon",
    }


# ==================== 邀请机制（预留） ====================

# 发送邀请
@router.post("/invite/send")
async def send_invite():
    """
    发送邀请（二期功能，一期占位）

    二期实现：生成邀请码，记录邀请关系，支持二级返利
    """
    return {
        "success": False,
        "message": "Invite feature not yet available",
    }


# 查询邀请奖励
@router.get("/invite/rewards/{address}")
async def get_invite_rewards(address: str):
    """
    查询邀请奖励（二期功能，一期占位）

    二期实现：返回用户邀请人数、累计返利金额
    """
    return {
        "success": True,
        "address": address,
        "invite_count": 0,
        "total_rewards": 0.0,
        "message": "Invite reward feature coming soon",
    }