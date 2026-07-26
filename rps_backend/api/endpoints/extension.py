"""
预留扩展接口端点（P2 占位）

为二期扩展功能预留接口定义，一期仅返回占位响应。
包括：代币信息、游戏配置、排行榜、锦标赛、风控、邀请机制。
"""
import time
from fastapi import APIRouter

from rps_backend.repository import get_all_system_config, list_contracts, get_system_config_value
from rps_backend.config import RPC_URL, CHAIN_ID, CONTRACT_ADDRESS

router = APIRouter(prefix="/ext", tags=["extension"])


# ==================== 主链配置 ====================

@router.get("/chain-config")
async def get_chain_config():
    """
    获取 ChainRPS 主链配置

    返回当前游戏运行的目标链信息，包括：
    - chain_id: 链 ID
    - network_name: 网络名称
    - rpc_url: RPC 节点地址
    - contract_address: 游戏合约地址
    - native_currency: 原生代币信息
    前端连接钱包后可根据此配置自动切换网络。
    """
    configs = get_all_system_config()
    config_dict = {c["config_key"]: c["config_value"] for c in configs}

    contracts = list_contracts(status="active")
    db_contract = contracts[0]["address"] if contracts else ""

    # 优先从系统配置读取，其次从环境变量/默认配置读取
    chain_id = int(config_dict.get("chain_id") or CHAIN_ID)
    network_name = config_dict.get("network_name") or _get_default_network_name(chain_id)
    rpc_url = config_dict.get("rpc_url") or RPC_URL
    contract_address = config_dict.get("contract_address") or db_contract or CONTRACT_ADDRESS
    native_symbol = config_dict.get("native_symbol") or _get_default_native_symbol(chain_id)
    native_name = config_dict.get("native_name") or native_symbol
    native_decimals = int(config_dict.get("native_decimals") or 18)

    return {
        "success": True,
        "chain_id": chain_id,
        "network_name": network_name,
        "rpc_url": rpc_url,
        "contract_address": contract_address,
        "native_currency": {
            "name": native_name,
            "symbol": native_symbol,
            "decimals": native_decimals,
        },
        "block_explorer": config_dict.get("block_explorer", ""),
    }


# ==================== 主链状态检测 ====================

@router.get("/chain-status")
async def get_chain_status():
    """
    检测 ChainRPS 主链 RPC 节点的连通性与健康状态。

    返回：
    - success: 检测是否成功完成（不代表链正常，仅代表检测动作完成）
    - rpc_reachable: RPC 是否可达
    - rpc_url: 检测的 RPC 地址
    - chain_id: 节点返回的 chain id（RPC 不可达时为 null）
    - block_number: 最新区块号（RPC 不可达时为 null）
    - latency_ms: RPC 响应延迟（毫秒，不可达时为 null）
    - contract_address: 配置的合约地址
    - contract_code_exists: 合约地址上是否有代码（RPC 不可达或未配置时为 null）
    - error: 错误信息（RPC 不可达时返回链端的错误描述）
    - checked_at: 检测时间戳（UTC，ISO 格式）
    """
    configs = get_all_system_config()
    config_dict = {c["config_key"]: c["config_value"] for c in configs}

    contracts = list_contracts(status="active")
    db_contract = contracts[0]["address"] if contracts else ""

    chain_id_cfg = int(config_dict.get("chain_id") or CHAIN_ID)
    rpc_url = config_dict.get("rpc_url") or RPC_URL
    contract_address = config_dict.get("contract_address") or db_contract or CONTRACT_ADDRESS

    result = {
        "success": True,
        "rpc_reachable": False,
        "rpc_url": rpc_url,
        "expected_chain_id": chain_id_cfg,
        "chain_id": None,
        "block_number": None,
        "latency_ms": None,
        "contract_address": contract_address,
        "contract_code_exists": None,
        "error": None,
        "checked_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
    }

    try:
        from web3 import Web3
        w3 = Web3(Web3.HTTPProvider(rpc_url, request_kwargs={"timeout": 5}))
        t0 = time.time()
        connected = w3.is_connected()
        result["latency_ms"] = int((time.time() - t0) * 1000)

        if not connected:
            result["error"] = "无法连接到 RPC 节点"
            return result

        result["rpc_reachable"] = True
        result["chain_id"] = w3.eth.chain_id
        result["block_number"] = w3.eth.block_number

        # 校验 chain id 是否与配置一致
        if result["chain_id"] != chain_id_cfg:
            result["error"] = (
                f"Chain ID 不匹配：节点返回 {result['chain_id']}，配置期望 {chain_id_cfg}"
            )

        # 检测合约代码是否存在
        if contract_address:
            try:
                checksum_addr = Web3.to_checksum_address(contract_address)
                code = w3.eth.get_code(checksum_addr)
                result["contract_code_exists"] = code and code != b"" and code != b"0x"
            except Exception as ce:
                result["contract_code_exists"] = None
                result["error"] = (result["error"] or "") + f" | 合约地址查询失败: {ce}"

    except Exception as e:
        result["error"] = f"RPC 检测异常: {str(e)}"

    return result


# 获取默认网络名称
def _get_default_network_name(chain_id: int) -> str:
    """根据 chain_id 获取默认网络名称"""
    names = {
        1: "Ethereum Mainnet",
        137: "Polygon Mainnet",
        80002: "Polygon Amoy",
        31337: "Hardhat Network",
        1337: "Localhost 8545",
        56: "BNB Chain",
        42161: "Arbitrum One",
        10: "Optimism",
    }
    return names.get(chain_id, f"Chain #{chain_id}")


# 获取默认原生代币符号
def _get_default_native_symbol(chain_id: int) -> str:
    """根据 chain_id 获取默认原生代币符号"""
    symbols = {
        1: "ETH",
        137: "POL",
        80002: "POL",
        31337: "ETH",
        1337: "ETH",
        56: "BNB",
        42161: "ETH",
        10: "ETH",
    }
    return symbols.get(chain_id, "ETH")


# ==================== 代币信息 ====================
pass


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
        pass  # 别删除，用于人工代码审核 便利

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
pass


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
pass


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
pass


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
pass


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
pass


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
