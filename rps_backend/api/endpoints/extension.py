"""
预留扩展接口端点（P2 占位）

为二期扩展功能预留接口定义，一期仅返回占位响应。
包括：代币信息、游戏配置、排行榜、锦标赛、风控、邀请机制。
"""
import re
import time
from typing import Optional
from fastapi import APIRouter, HTTPException

from rps_backend.repository import get_all_system_config, list_contracts, get_system_config_value
from rps_backend.config import RPC_URL, RPC_CHAIN_ID, CONTRACT_ADDRESS, RPC_LOCAL_PORT
from rps_backend.utils import validate_address

_ZERO_ADDRESS = "0x0000000000000000000000000000000000000000"


def _check_ext_address(address: str, field: str = "address") -> str:
    """校验扩展端点地址，返回规范化的小写地址或抛异常"""
    if not validate_address(address):
        raise HTTPException(status_code=400, detail=f"无效的 {field}（应为 0x + 40 位十六进制字符）")
    if address.lower() == _ZERO_ADDRESS.lower():
        raise HTTPException(status_code=400, detail=f"{field} 不能为零地址")
    return address.lower()

router = APIRouter(prefix="/ext", tags=["extension"])


def _validate_rpc_url(rpc_url: str, chain_id: int) -> str:
    """验证 rpc_url 是否有效，若端口被错误设置为 chain_id 则修正回环境变量默认值"""
    if not rpc_url:
        return RPC_URL
    port_match = re.search(r':(\d+)(?:/|$)', rpc_url)
    if port_match:
        port = int(port_match.group(1))
        if port == chain_id or port > 65535:
            return RPC_URL
    return rpc_url


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
    # 🆕 config.CONTRACT_ADDRESS（环境变量/最新部署）优先级最高，
    #   因为 DB contracts 表可能残留多个历史 active 合约（部署重启遗留）
    chain_id = int(config_dict.get("chain_id") or RPC_CHAIN_ID)
    network_name = config_dict.get("network_name") or _get_default_network_name(chain_id)
    raw_rpc_url = config_dict.get("rpc_url") or RPC_URL
    rpc_url = _validate_rpc_url(raw_rpc_url, chain_id)
    # 优先级：config.CONTRACT_ADDRESS（最新部署）> system_config > DB active 合约
    contract_address = CONTRACT_ADDRESS or config_dict.get("contract_address") or db_contract
    native_symbol = config_dict.get("native_symbol") or _get_default_native_symbol(chain_id)
    native_name = config_dict.get("native_name") or native_symbol
    native_decimals = int(config_dict.get("native_decimals") or 18)

    # 查询结算代币（USDC）合约地址：从 DB contracts 表查找已部署的 MockERC20/USDC 记录
    settlement_token = None
    try:
        for c in contracts:
            name = c.get("name", "")
            if name in ("USDC", "Mock USDC", "MockERC20") or "USDC" in name.upper():
                settlement_token = {
                    "symbol": "USDC",
                    "name": name,
                    "decimals": 6,
                    "address": c.get("address"),
                }
                break
    except Exception:
        pass  # 别删除，用于人工代码审核 便利

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
        "settlement_token": settlement_token,
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

    chain_id_cfg = int(config_dict.get("chain_id") or RPC_CHAIN_ID)
    raw_rpc_url = config_dict.get("rpc_url") or RPC_URL
    rpc_url = _validate_rpc_url(raw_rpc_url, chain_id_cfg)
    contract_address = CONTRACT_ADDRESS or config_dict.get("contract_address") or db_contract

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


@router.get("/wallet-nonce")
async def get_wallet_nonce(address: str):
    """
    经后端可信 RPC 查询地址的链上交易计数（nonce）。

    用途：前端预检时区分"交易堵在钱包本地队列"与"交易堵在节点内存池"。
    - latest：链上已打包 nonce
    - pending：节点内存池视角 nonce（含未打包交易）
    - backlog：pending - latest，节点侧积压笔数
    """
    result = {
        "success": False,
        "address": address,
        "latest_nonce": None,
        "pending_nonce": None,
        "backlog": None,
        "block_number": None,
        "error": None,
    }
    try:
        from web3 import Web3
        if not address or not re.fullmatch(r"0x[0-9a-fA-F]{40}", address):
            result["error"] = "地址格式无效"
            return result

        configs = get_all_system_config()
        config_dict = {c["config_key"]: c["config_value"] for c in configs}
        chain_id_cfg = int(config_dict.get("chain_id") or RPC_CHAIN_ID)
        raw_rpc_url = config_dict.get("rpc_url") or RPC_URL
        rpc_url = _validate_rpc_url(raw_rpc_url, chain_id_cfg)

        w3 = Web3(Web3.HTTPProvider(rpc_url, request_kwargs={"timeout": 5}))
        if not w3.is_connected():
            result["error"] = "无法连接到 RPC 节点"
            return result

        checksum = Web3.to_checksum_address(address)
        latest = w3.eth.get_transaction_count(checksum, "latest")
        pending = w3.eth.get_transaction_count(checksum, "pending")
        result.update({
            "success": True,
            "latest_nonce": latest,
            "pending_nonce": pending,
            "backlog": max(0, pending - latest),
            "block_number": w3.eth.block_number,
        })
    except Exception as e:
        result["error"] = f"nonce 查询异常: {str(e)}"
    return result


# 获取默认网络名称
def _get_default_network_name(chain_id: int) -> str:
    """根据 chain_id 获取默认网络名称"""
    names = {
        1: "Ethereum Mainnet",
        137: "Polygon Mainnet",
        80002: "Polygon Amoy",
        f"{RPC_CHAIN_ID}": "ChainRPS Local",
        56: "BNB Chain",
        42161: "Arbitrum One",
        10: "Optimism",
    }
    return names.get(chain_id, f"Chain #{chain_id}")


# ==================== 水龙头 ====================

@router.post("/faucet")
async def faucet(address: str, eth_amount: float = 1.0, usdc_amount: float = 100.0):
    """
    给指定地址发 ETH（gas 费）+ USDC（测试代币）。

    用途：前端预检发现用户余额不足时，自动调此端点给用户充值。
    仅适用于 ChainRPS 本地链（chain_id = RPC_CHAIN_ID）。
    """
    result = {
        "success": False,
        "address": address,
        "eth_sent": False,
        "usdc_sent": False,
        "eth_tx": None,
        "usdc_tx": None,
        "error": None,
    }
    try:
        from web3 import Web3
        # 统一地址校验（含零地址拦截）
        try:
            _check_ext_address(address)
        except HTTPException as e:
            result["error"] = e.detail
            return result

        from rps_backend.service.local_chain_service import get_local_chain_service
        chain_svc = get_local_chain_service()
        if not chain_svc.is_running():
            result["error"] = "本地链未运行"
            return result

        # 1. 发 ETH（from Ganache account 0）
        if eth_amount > 0:
            eth_res = chain_svc.send_eth(0, address, eth_amount)
            if eth_res.get("success"):
                result["eth_sent"] = True
                result["eth_tx"] = eth_res.get("tx_hash")
            else:
                result["error"] = f"ETH 发送失败: {eth_res.get('message')}"

        # 2. 发 USDC
        if usdc_amount > 0 and not result.get("error"):
            usdc_res = chain_svc.mint_tokens("USDC", address, usdc_amount, from_index=0)
            if usdc_res.get("success"):
                result["usdc_sent"] = True
                result["usdc_tx"] = usdc_res.get("tx_hash")
            else:
                # USDC 铸造失败不阻塞，ETH 已发
                if not result.get("error"):
                    result["error"] = f"USDC 铸造失败: {usdc_res.get('message')}"

        result["success"] = result["eth_sent"] or result["usdc_sent"]
        print(f"🔑 Faucet: {address}  ETH={result['eth_sent']}({eth_amount})  USDC={result['usdc_sent']}({usdc_amount})")
        return result

    except Exception as e:
        result["error"] = f"faucet 异常: {e}"
        return result


# 获取默认原生代币符号
def _get_default_native_symbol(chain_id: int) -> str:
    """根据 chain_id 获取默认原生代币符号"""
    symbols = {
        1: "ETH",
        137: "POL",
        80002: "POL",
        8453: "ETH",  # Base Mainnet
        f"{RPC_CHAIN_ID}": "POL",
        56: "BNB",
        42161: "ETH",
        10: "ETH",
    }
    return symbols.get(chain_id, "POL")


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
    3. 若数据库无记录，回退到默认 USDC
    """
    # 1. 从系统配置读取支持的代币符号列表
    config_value = get_system_config_value("supported_tokens")
    if config_value:
        symbols = [s.strip() for s in config_value.split(",") if s.strip()]
    else:
        symbols = ["USDC"]

    # 2. 从数据库读取已部署的代币合约（MockERC20）
    db_tokens = {}
    try:
        contracts = list_contracts(status="active")
        for c in contracts:
            name = c.get("name", "")
            # 识别 MockERC20 代币记录
            if name.startswith("Mock") or name in ["USDC", "MockERC20"]:
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
        "supported_tokens": config_dict.get("supported_tokens", "USDC,POL").split(","),
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


# ==================== 自动发币（本地测试网） ====================

# Ganache 预定义富账户 #0 — 有 990M USDC + 32K ETH，当作水龙头
_GANACHE_FAUCET_ADDRESS = "0x90F8bf6A479f320ead074411a4B0e7944Ea8c9C1"
_USDC_CONTRACT_ADDRESS = "0x28D51CA433509024B1062c8eE8683B26fe04F169"

# 每日限额配置（活动入口：用户每天点一次领取）
DAILY_DRIP_USDC = 3000          # 每次领取 3000 USDC
DAILY_DRIP_POL = 5              # 每次领取 5 POL（gas）
DRIP_COOLDOWN_SECONDS = 5       # 防误点，5 秒内不能重复领

_drip_table_initialized = False


def _ensure_drip_table():
    """确保 drip_records 表存在（首次调用自动创建）"""
    global _drip_table_initialized
    if _drip_table_initialized:
        return
    import sqlite3
    from rps_backend.repository.database import DATABASE_PATH
    conn = sqlite3.connect(DATABASE_PATH)
    try:
        conn.execute("""
            CREATE TABLE IF NOT EXISTS drip_records (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                address TEXT NOT NULL,
                usdc_amount REAL NOT NULL,
                pol_amount REAL NOT NULL,
                tx_hash TEXT,
                created_at INTEGER NOT NULL
            )
        """)
        conn.execute("""
            CREATE INDEX IF NOT EXISTS idx_drip_addr_time 
            ON drip_records(address, created_at)
        """)
        conn.commit()
    finally:
        conn.close()
    _drip_table_initialized = True


def _get_today_total(address: str) -> tuple:
    """返回 (今日已发 USDC, 今日已发 POL)"""
    import sqlite3
    from datetime import datetime, timezone, timedelta
    from rps_backend.repository.database import DATABASE_PATH

    # 本地今天的 00:00（用东八区）
    tz = timezone(timedelta(hours=8))
    start_of_day = int(datetime.now(tz).replace(
        hour=0, minute=0, second=0, microsecond=0
    ).timestamp())

    conn = sqlite3.connect(DATABASE_PATH)
    try:
        row = conn.execute(
            "SELECT COALESCE(SUM(usdc_amount), 0), COALESCE(SUM(pol_amount), 0) "
            "FROM drip_records WHERE address = ? AND created_at >= ?",
            (address.lower(), start_of_day)
        ).fetchone()
        return row[0], row[1]
    finally:
        conn.close()


def _record_drip(address: str, usdc: float, pol: float, tx_hash: str = None):
    import sqlite3, time
    from rps_backend.repository.database import DATABASE_PATH
    conn = sqlite3.connect(DATABASE_PATH)
    try:
        conn.execute(
            "INSERT INTO drip_records(address, usdc_amount, pol_amount, tx_hash, created_at) "
            "VALUES (?, ?, ?, ?, ?)",
            (address.lower(), usdc, pol, tx_hash, int(time.time()))
        )
        conn.commit()
    finally:
        conn.close()


def _last_drip_time(address: str) -> int:
    """返回上次发币时间戳（0=从未发过）"""
    import sqlite3
    from rps_backend.repository.database import DATABASE_PATH
    conn = sqlite3.connect(DATABASE_PATH)
    try:
        row = conn.execute(
            "SELECT MAX(created_at) FROM drip_records WHERE address = ?",
            (address.lower(),)
        ).fetchone()
        return row[0] or 0
    finally:
        conn.close()


@router.post("/drip")
async def drip_test_tokens(body: dict):
    """
    每日领币活动 — 用户每天主动点击领取一次。
    
    规则：
    - 同一地址每天只能领一次（东八区 00:00 重置）
    - 每次固定发放：{DAILY_DRIP_USDC} USDC + {DAILY_DRIP_POL} POL
    - 5 秒冷却防误点
    - 记录持久化到 SQLite
    """
    from web3 import Web3
    import time as _time

    _ensure_drip_table()

    address = body.get("address", "")
    try:
        address = _check_ext_address(address)
    except HTTPException as e:
        return {"success": False, "message": e.detail}

    # 1) 冷却检查（防误点）
    last_ts = _last_drip_time(address)
    now = int(_time.time())
    if last_ts and now - last_ts < DRIP_COOLDOWN_SECONDS:
        remain = DRIP_COOLDOWN_SECONDS - (now - last_ts)
        return {
            "success": True,
            "message": f"请稍等 {remain} 秒",
            "dripped": False,
            "cooldown": True,
        }

    # 2) 今日是否已领过
    today_usdc, today_pol = _get_today_total(address)
    already_claimed_today = today_usdc >= DAILY_DRIP_USDC * 0.9  # 容差 0.1U

    if already_claimed_today:
        return {
            "success": True,
            "message": "今日已领取，明天再来",
            "dripped": False,
            "already_claimed": True,
            "daily_amount": {"usdc": DAILY_DRIP_USDC, "pol": DAILY_DRIP_POL},
        }

    try:
        w3 = Web3(Web3.HTTPProvider(RPC_URL, request_kwargs={"timeout": 10}))
        if not w3.is_connected():
            return {"success": False, "message": "无法连接到本地 RPC"}

        to_addr = Web3.to_checksum_address(address)
        faucet = Web3.to_checksum_address(_GANACHE_FAUCET_ADDRESS)

        faucet_eth = w3.eth.get_balance(faucet)
        if faucet_eth < w3.to_wei(1, 'ether'):
            return {"success": False, "message": "水龙头余额不足，请联系管理员"}

        results = {}
        overall_hash = None

        # 发原生币
        try:
            eth_hash = w3.eth.send_transaction({
                "from": faucet, "to": to_addr,
                "value": w3.to_wei(DAILY_DRIP_POL, 'ether'),
                "gas": 21000, "gasPrice": w3.to_wei(20, 'gwei'),
            })
            w3.eth.wait_for_transaction_receipt(eth_hash, timeout=15)
            results["POL"] = str(DAILY_DRIP_POL)
            overall_hash = eth_hash.hex()
        except Exception as e:
            results["POL"] = f"失败: {str(e)[:80]}"

        # 发 USDC
        try:
            usdc_abi = [
                {"inputs": [{"name": "to", "type": "address"}, {"name": "amount", "type": "uint256"}],
                 "name": "transfer", "outputs": [{"name": "", "type": "bool"}],
                 "stateMutability": "nonpayable", "type": "function"},
                {"inputs": [], "name": "decimals", "outputs": [{"name": "", "type": "uint8"}],
                 "stateMutability": "view", "type": "function"},
            ]
            usdc = w3.eth.contract(address=Web3.to_checksum_address(_USDC_CONTRACT_ADDRESS), abi=usdc_abi)
            decimals = usdc.functions.decimals().call()
            amount = int(DAILY_DRIP_USDC * (10 ** decimals))
            usdc_hash = usdc.functions.transfer(to_addr, amount).transact({
                "from": faucet, "gas": 100000, "gasPrice": w3.to_wei(20, 'gwei'),
            })
            w3.eth.wait_for_transaction_receipt(usdc_hash, timeout=15)
            results["USDC"] = str(DAILY_DRIP_USDC)
            if not overall_hash:
                overall_hash = usdc_hash.hex()
        except Exception as e:
            results["USDC"] = f"失败: {str(e)[:80]}"

        all_ok = "失败" not in results.get("USDC", "") and "失败" not in results.get("POL", "")
        _record_drip(address,
                     0 if "失败" in results.get("USDC", "") else DAILY_DRIP_USDC,
                     0 if "失败" in results.get("POL", "") else DAILY_DRIP_POL,
                     overall_hash)

        return {
            "success": all_ok,
            "message": "🎉 领取成功！" if all_ok else "部分代币发放失败",
            "dripped": True,
            "results": results,
            "daily_amount": {"usdc": DAILY_DRIP_USDC, "pol": DAILY_DRIP_POL},
        }

    except Exception as e:
        return {"success": False, "message": f"领取异常: {str(e)[:100]}"}


@router.get("/drip/status")
async def drip_status(address: str):
    """查询今日是否已领取"""
    _ensure_drip_table()
    try:
        address = _check_ext_address(address)
    except HTTPException as e:
        return {"success": False, "message": e.detail}
    usdc, pol = _get_today_total(address)
    last_ts = _last_drip_time(address)
    claimed = usdc >= DAILY_DRIP_USDC * 0.9
    return {
        "success": True,
        "address": address,
        "claimed_today": claimed,
        "daily_amount": {"usdc": DAILY_DRIP_USDC, "pol": DAILY_DRIP_POL},
        "last_claim_ts": last_ts,
    }

#
# 以下端点为公开链上查询接口，无需管理员登录认证。
# 从 admin.py 的 /admin/local-chain/explorer/* 迁移而来，供独立公开页面 /explorer 使用。


def _run_explorer_async(func, *args, **kwargs):
    """在线程池中执行同步的 LocalChainService 方法，避免阻塞事件循环"""
    import asyncio
    from functools import partial
    try:
        loop = asyncio.get_running_loop()
    except RuntimeError:
        loop = asyncio.new_event_loop()
        asyncio.set_event_loop(loop)
    return loop.run_in_executor(None, partial(func, *args, **kwargs))


# 公开合约列表（供链浏览器下拉选择）
@router.get("/contracts")
async def public_list_contracts(network: Optional[str] = None, status: Optional[str] = None):
    """获取合约列表（公开接口，仅供链浏览器查询使用）"""
    contracts = list_contracts(network=network, status=status)
    return contracts


# 统一查询接口（自动识别区块号/交易哈希/地址）
@router.get("/explorer/query/{query}")
async def public_explorer_query(query: str):
    """链上查询统一接口（公开）

    自动识别查询类型：
    - 纯数字 → 按区块号查询区块
    - 0x开头 + 64位十六进制 → 按交易哈希查询交易
    - 0x开头 + 40位十六进制 → 按地址查询余额
    """
    from rps_backend.service.local_chain_service import get_local_chain_service
    service = get_local_chain_service()

    q = query.strip()
    if not q:
        return {"success": False, "message": "查询内容为空", "type": None, "data": None}

    def _do_query():
        if not service.is_running():
            return {"success": False, "message": "本地链未运行", "type": None, "data": None}

        # 交易哈希：0x + 64 hex（容错：不带 0x 前缀也支持）
        tx_hash = q if q.startswith("0x") else ("0x" + q if len(q) == 64 and all(c in "0123456789abcdefABCDEF" for c in q) else None)
        if tx_hash and len(tx_hash) == 66:
            data = service.get_transaction(tx_hash)
            if data:
                return {"success": True, "type": "transaction", "data": data}
            return {"success": False, "message": "未找到该交易", "type": "transaction", "data": None}

        # 地址：0x + 40 hex（容错：不带 0x 前缀也支持）
        addr = q if q.startswith("0x") else ("0x" + q if len(q) == 40 and all(c in "0123456789abcdefABCDEF" for c in q) else None)
        if addr and len(addr) == 42:
            data = service.get_address_info(addr)
            if data:
                return {"success": True, "type": "address", "data": data}
            return {"success": False, "message": "地址无效或查询失败", "type": "address", "data": None}

        # 区块号：纯数字
        if q.isdigit():
            block_num = int(q)
            data = service.get_block(block_num)
            if data:
                return {"success": True, "type": "block", "data": data}
            return {"success": False, "message": "未找到该区块", "type": "block", "data": None}

        return {"success": False, "message": "无法识别查询类型（支持区块号、交易哈希、钱包地址）", "type": None, "data": None}

    return await _run_explorer_async(_do_query)


# 查询最新区块信息
@router.get("/explorer/latest-block")
async def public_explorer_latest_block():
    """获取最新区块号和区块信息（公开）"""
    from rps_backend.service.local_chain_service import get_local_chain_service
    service = get_local_chain_service()

    def _do_latest():
        if not service.is_running():
            return {"success": False, "message": "本地链未运行", "block_number": None}
        block_num = service.get_latest_block_number()
        if block_num is None:
            return {"success": False, "message": "查询失败", "block_number": None}
        block = service.get_block(block_num)
        return {"success": True, "block_number": block_num, "block": block}

    return await _run_explorer_async(_do_latest)


# 查询地址的交易记录
@router.get("/explorer/address/{address}/transactions")
async def public_explorer_address_transactions(address: str, scan_blocks: int = 100, limit: int = 50):
    """查询指定地址的交易记录（公开，扫描最近 N 个区块）"""
    from rps_backend.service.local_chain_service import get_local_chain_service
    service = get_local_chain_service()

    # 限制扫描范围，避免性能问题：默认 100，最大 500
    scan_blocks = min(max(scan_blocks, 10), 500)
    limit = min(max(limit, 1), 200)

    def _do_scan():
        if not service.is_running():
            return {"success": False, "message": "本地链未运行", "transactions": []}
        data = service.get_address_transactions(address, scan_blocks, limit)
        if data is None:
            return {"success": False, "message": "查询失败", "transactions": []}
        return {"success": True, **data}

    return await _run_explorer_async(_do_scan)