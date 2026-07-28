"""
管理员 API 端点

提供合约管理、系统配置、审计日志等管理员功能接口。
所有接口均需要 JWT 登录认证（通过路由级 dependencies 强制校验）。
"""
import asyncio
import json
import os
from functools import partial
from typing import List, Optional

from fastapi import APIRouter, HTTPException, Query, Request, Depends

from rps_backend.models import (
    AuditLogEntry,
    ContractAbiUpdate,
    ContractRecord,
    SystemConfigBatchUpdate,
    SystemConfigItem,
    SystemConfigUpdate,
)
from rps_backend.repository import (
    add_audit_log,
    add_contract_record,
    batch_set_system_config,
    get_all_system_config,
    get_contract_by_address,
    get_contract_by_id,
    get_system_config_value,
    list_audit_logs,
    list_contracts,
    set_system_config,
    update_contract_abi,
    update_contract_record,
)
from rps_backend.config import ADMIN_WHITELIST
from rps_backend.api.endpoints.auth import get_current_admin

# 路由级依赖：所有 /admin/* 接口强制要求 JWT 登录认证
router = APIRouter(
    prefix="/admin",
    tags=["admin"],
    dependencies=[Depends(get_current_admin)],
)


# 将同步阻塞的 local_chain_service 调用放到线程池执行，避免卡死事件循环
async def _run_chain_async(func, *args, **kwargs):
    """在线程池中执行同步的 LocalChainService 方法"""
    loop = asyncio.get_event_loop()
    return await loop.run_in_executor(None, partial(func, *args, **kwargs))


# 验证管理员权限
def _verify_admin(address: Optional[str], request: Request) -> str:
    """
    验证管理员权限

    优先从请求参数获取 admin_address，其次检查 X-Admin-Address 头。
    若地址在白名单中则返回该地址，否则抛出 403 错误。
    """
    admin_addr = address
    if not admin_addr:
        admin_addr = request.headers.get("X-Admin-Address")

    if not admin_addr:
        raise HTTPException(status_code=400, detail="Admin address required")

    if not ADMIN_WHITELIST:
        return admin_addr.lower()

    if admin_addr.lower() not in [a.lower() for a in ADMIN_WHITELIST]:
        raise HTTPException(status_code=403, detail="Permission denied")

    return admin_addr.lower()


# ==================== 合约管理 ====================

# 获取合约列表
@router.get("/contracts", response_model=List[ContractRecord])
async def list_admin_contracts(
    network: Optional[str] = None,
    status: Optional[str] = None,
):
    """获取合约列表"""
    contracts = list_contracts(network=network, status=status)
    return [ContractRecord(**c) for c in contracts]


# 添加合约记录
@router.post("/contracts")
async def add_contract(contract: ContractRecord, request: Request):
    """添加合约记录"""
    admin_addr = _verify_admin(contract.deployed_by, request)

    existing = get_contract_by_address(contract.address)
    if existing:
        raise HTTPException(status_code=400, detail="Contract already exists")

    contract_id = add_contract_record(contract.model_dump())
    add_audit_log(admin_addr, "add_contract", target=contract.address, new_value=contract.name)

    if contract.network == "localhost" and contract.status == "active":
        try:
            from rps_backend.service.contract_service import contract_service
            import asyncio
            loop = asyncio.get_event_loop()
            if loop.is_running():
                asyncio.create_task(contract_service.update_contract_address(contract.address))
            else:
                loop.run_until_complete(contract_service.update_contract_address(contract.address))
        except Exception as e:
            print(f"⚠️  更新合约监听地址失败: {e}")

    return {"success": True, "id": contract_id, "address": contract.address}


# 获取合约编译产物
@router.get("/contracts/compile-artifacts")
async def get_compile_artifacts(request: Request):
    """
    获取合约编译产物（ABI + Bytecode），供前端部署使用。

    读取顺序：
    1. contracts/build/chainrps.json（完整编译产物，含 bytecode）
    2. contracts/abi/ChainRPS.json（仅 ABI，无 bytecode）
    3. 数据库已记录的合约 ABI

    若以上均无 bytecode，则尝试自动编译合约（需 py-solc-x 和 OpenZeppelin 库）。
    """
    _verify_admin(None, request)

    import json
    import os

    project_root = os.path.dirname(
        os.path.dirname(os.path.dirname(os.path.dirname(__file__)))
    )

    abi = None
    bytecode = None

    # 1. 尝试从 build 目录读取完整编译产物
    build_dir = os.path.join(project_root, "contracts", "build")
    compiled_path = os.path.join(build_dir, "chainrps.json")

    if os.path.exists(compiled_path):
        try:
            with open(compiled_path, "r", encoding="utf-8") as f:
                compiled = json.load(f)
            abi = compiled.get("abi")
            bytecode = compiled.get("bytecode")
        except Exception:
            pass #别删除，用于人工代码审核 便利

    # 2. 回退：从 abi 目录读取 ABI 文件
    if not abi:
        abi_path = os.path.join(project_root, "contracts", "abi", "ChainRPS.json")
        if os.path.exists(abi_path):
            try:
                with open(abi_path, "r", encoding="utf-8") as f:
                    abi = json.load(f)
            except Exception:
                pass #别删除，用于人工代码审核 便利

    # 3. 回退：从数据库已记录的合约中读取 ABI
    if not abi:
        contracts = list_contracts(status="active")
        for c in contracts:
            if c.get("abi"):
                try:
                    abi = json.loads(c["abi"]) if isinstance(c["abi"], str) else c["abi"]
                except (json.JSONDecodeError, TypeError):
                    abi = c["abi"]
                break

    # 4. 若仍无 bytecode，尝试自动编译（放到线程池，避免下载/编译阻塞事件循环）
    if not bytecode:
        try:
            bytecode, abi = await _run_chain_async(_try_auto_compile, project_root) or (None, None)
        except Exception as e:
            print(f"⚠️  自动编译失败: {e}")

    if not abi and not bytecode:
        raise HTTPException(
            status_code=404,
            detail="未找到合约编译产物，且自动编译失败。请运行: python contracts/scripts/compile.py",
        )

    return {
        "abi": abi if isinstance(abi, str) else json.dumps(abi) if abi else None,
        "bytecode": bytecode,
    }


# 获取 MockERC20 编译产物
@router.get("/contracts/mock-erc20-artifacts")
async def get_mock_erc20_artifacts(request: Request):
    """
    获取 MockERC20 合约编译产物（ABI + Bytecode），用于部署测试代币。
    """
    _verify_admin(None, request)

    import json
    import os

    project_root = os.path.dirname(
        os.path.dirname(os.path.dirname(os.path.dirname(__file__)))
    )

    abi = None
    bytecode = None

    # 1. 从 abi 目录读取预编译产物（优先）
    abi_path = os.path.join(project_root, "contracts", "abi", "MockERC20.json")
    if os.path.exists(abi_path):
        try:
            with open(abi_path, "r", encoding="utf-8") as f:
                data = json.load(f)
            if isinstance(data, dict) and "abi" in data and "bytecode" in data:
                abi = data["abi"]
                bytecode = data["bytecode"]
        except Exception:
            pass #别删除，用于人工代码审核 便利

    # 2. 尝试从 build 目录读取
    if not abi:
        build_dir = os.path.join(project_root, "contracts", "build")
        compiled_path = os.path.join(build_dir, "MockERC20.json")
        if os.path.exists(compiled_path):
            try:
                with open(compiled_path, "r", encoding="utf-8") as f:
                    compiled = json.load(f)
                abi = compiled.get("abi")
                bytecode = compiled.get("bytecode")
            except Exception:
                pass #别删除，用于人工代码审核 便利

    # 3. 尝试自动编译 MockERC20（放到线程池，避免下载/编译阻塞事件循环）
    if not abi or not bytecode:
        try:
            result = await _run_chain_async(_try_auto_compile_mock_erc20, project_root)
            if result:
                bytecode, abi = result
        except Exception as e:
            print(f"⚠️  MockERC20 自动编译失败: {e}")

    if not abi or not bytecode:
        raise HTTPException(
            status_code=404,
            detail="未找到 MockERC20 编译产物，且自动编译失败。",
        )

    return {
        "abi": abi if isinstance(abi, str) else json.dumps(abi) if abi else None,
        "bytecode": bytecode,
    }


# 尝试自动编译 MockERC20
def _try_auto_compile_mock_erc20(project_root: str):
    """尝试自动编译 MockERC20 合约"""
    import sys

    try:
        from solcx import compile_standard, install_solc, get_installed_solc_versions, set_solc_version
    except ImportError:
        return None

    contracts_dir = os.path.join(project_root, "contracts")
    src_path = os.path.join(contracts_dir, "src", "MockERC20.sol")
    oz_base = os.path.join(contracts_dir, "lib", "openzeppelin-contracts")

    if not os.path.exists(src_path) or not os.path.exists(oz_base):
        return None

    solc_version = "0.8.20"
    installed = [str(v) for v in get_installed_solc_versions()]
    if solc_version not in installed:
        install_solc(solc_version)
    set_solc_version(solc_version)

    with open(src_path, "r", encoding="utf-8") as f:
        source_content = f.read()

    input_json = {
        "language": "Solidity",
        "sources": {"MockERC20.sol": {"content": source_content}},
        "settings": {
            "outputSelection": {"*": {"*": ["abi", "evm.bytecode.object"]}},
            "optimizer": {"enabled": True, "runs": 200},
        },
    }

    def _import_callback(import_path: str):
        if import_path.startswith("@openzeppelin/"):
            rel = import_path.replace("@openzeppelin/", "")
            full = os.path.join(oz_base, rel)
            if os.path.exists(full):
                with open(full, "r", encoding="utf-8") as f2:
                    return {"contents": f2.read()}
        return None

    compiled = compile_standard(
        input_json,
        allow_paths=[oz_base],
        import_callback=_import_callback,
    )

    if "contracts" in compiled and "MockERC20.sol" in compiled["contracts"]:
        for contract_name, contract_data in compiled["contracts"]["MockERC20.sol"].items():
            if contract_name == "MockERC20":
                abi = contract_data.get("abi")
                bytecode = contract_data.get("evm", {}).get("bytecode", {}).get("object")
                if abi and bytecode:
                    build_dir = os.path.join(project_root, "contracts", "build")
                    os.makedirs(build_dir, exist_ok=True)
                    output_path = os.path.join(build_dir, "MockERC20.json")
                    with open(output_path, "w", encoding="utf-8") as f:
                        json.dump({"abi": abi, "bytecode": bytecode}, f, indent=2)
                    return bytecode, abi
    return None


# 尝试自动编译合约
def _try_auto_compile(project_root: str):
    """
    尝试自动编译合约，返回 (bytecode, abi) 元组。

    需要：
    - py-solc-x 已安装
    - OpenZeppelin 合约库位于 contracts/lib/openzeppelin-contracts/
    - solc 0.8.20 编译器（未安装会自动下载）

    编译成功后将产物保存到 contracts/build/chainrps.json。
    """
    import sys

    # 检查 py-solc-x 是否可用
    try:
        from solcx import compile_standard, install_solc, get_installed_solc_versions, set_solc_version
    except ImportError:
        print("⚠️  py-solc-x 未安装，无法自动编译。请运行: pip install py-solc-x")
        return None

    contracts_dir = os.path.join(project_root, "contracts")
    src_path = os.path.join(contracts_dir, "src", "ChainRPS.sol")
    oz_base = os.path.join(contracts_dir, "lib", "openzeppelin-contracts")

    if not os.path.exists(src_path):
        return None

    if not os.path.exists(oz_base):
        print("⚠️  OpenZeppelin 合约库未找到，无法自动编译")
        return None

    solc_version = "0.8.20"

    # 确保 solc 已安装
    installed = [str(v) for v in get_installed_solc_versions()]
    if solc_version not in installed:
        print(f"⬇️  正在下载 solc {solc_version}...")
        install_solc(solc_version)

    set_solc_version(solc_version)

    # 读取源文件
    with open(src_path, "r", encoding="utf-8") as f:
        source_content = f.read()

    standard_input = {
        "language": "Solidity",
        "sources": {src_path: {"content": source_content}},
        "settings": {
            "viaIR": True,
            "optimizer": {"enabled": True, "runs": 200},
            "outputSelection": {"*": {"*": ["abi", "evm.bytecode.object"]}},
            "remappings": ["@openzeppelin/=" + oz_base + "/"],
        },
    }

    print("🔨 自动编译合约中...")
    compiled = compile_standard(
        standard_input,
        solc_version=solc_version,
        allow_paths=contracts_dir,
    )

    # 提取 chainrps 合约产物
    bytecode = None
    abi = None
    for source_path, contracts in compiled.get("contracts", {}).items():
        for contract_name, data in contracts.items():
            if contract_name == "chainrps":
                abi = data.get("abi", [])
                bytecode = data.get("evm", {}).get("bytecode", {}).get("object", "")
                if bytecode and not bytecode.startswith("0x"):
                    bytecode = "0x" + bytecode
                break

    if bytecode:
        # 保存编译产物
        build_dir = os.path.join(contracts_dir, "build")
        os.makedirs(build_dir, exist_ok=True)
        compiled_path = os.path.join(build_dir, "chainrps.json")
        with open(compiled_path, "w", encoding="utf-8") as f:
            json.dump({"abi": abi, "bytecode": bytecode}, f, indent=2, ensure_ascii=False)
        print(f"💾 编译产物已保存: {compiled_path}")

        # 同时更新 abi 文件
        abi_path = os.path.join(contracts_dir, "abi", "ChainRPS.json")
        os.makedirs(os.path.dirname(abi_path), exist_ok=True)
        with open(abi_path, "w", encoding="utf-8") as f:
            json.dump(abi, f, indent=2, ensure_ascii=False)

    return bytecode, abi


# 获取合约详情
@router.get("/contracts/{contract_id}", response_model=ContractRecord)
async def get_contract(contract_id: int):
    """获取合约详情"""
    contract = get_contract_by_id(contract_id)
    if not contract:
        raise HTTPException(status_code=404, detail="Contract not found")
    return ContractRecord(**contract)


# 更新合约 ABI
@router.put("/contracts/{contract_id}/abi")
async def update_abi(contract_id: int, body: ContractAbiUpdate, request: Request):
    """更新合约 ABI"""
    admin_addr = _verify_admin(body.admin_address, request)

    contract = get_contract_by_id(contract_id)
    if not contract:
        raise HTTPException(status_code=404, detail="Contract not found")

    update_contract_abi(contract_id, body.abi)
    add_audit_log(admin_addr, "update_abi", target=str(contract_id))

    return {"success": True}


# 验证合约源代码
@router.post("/contracts/{contract_id}/verify")
async def verify_contract(contract_id: int, request: Request):
    """验证合约源代码（占位，实际需调用区块浏览器 API）"""
    admin_addr = _verify_admin(None, request)

    contract = get_contract_by_id(contract_id)
    if not contract:
        raise HTTPException(status_code=404, detail="Contract not found")

    add_audit_log(admin_addr, "verify_contract", target=str(contract_id))

    return {
        "success": True,
        "message": "Contract verification requested",
        "contract_id": contract_id,
    }


# 更新合约记录
@router.patch("/contracts/{contract_id}")
async def update_contract(contract_id: int, body: dict, request: Request):
    """更新合约记录"""
    admin_addr = _verify_admin(body.get("admin_address"), request)

    contract = get_contract_by_id(contract_id)
    if not contract:
        raise HTTPException(status_code=404, detail="Contract not found")

    updates = {k: v for k, v in body.items() if k != "admin_address"}
    if updates:
        update_contract_record(contract_id, updates)
        add_audit_log(admin_addr, "update_contract", target=str(contract_id), new_value=str(updates))

    return {"success": True}


# ==================== 系统配置管理 ====================

# 获取系统配置列表
@router.get("/config", response_model=List[SystemConfigItem])
async def get_config_list(category: Optional[str] = None):
    """获取系统配置列表"""
    configs = get_all_system_config(category=category)
    return [SystemConfigItem(**c) for c in configs]


# 获取单个配置项
@router.get("/config/{key}")
async def get_config(key: str):
    """获取单个配置项"""
    value = get_system_config_value(key)
    if value is None:
        raise HTTPException(status_code=404, detail="Config key not found")
    return {"key": key, "value": value}


# 更新单个配置项
@router.put("/config/{key}")
async def update_config(key: str, body: SystemConfigUpdate, request: Request):
    """更新单个配置项"""
    admin_addr = _verify_admin(body.admin_address, request)

    old_value = get_system_config_value(key)
    set_system_config(key, body.value, updated_by=admin_addr)

    add_audit_log(
        admin_addr, "update_config",
        target=key, old_value=str(old_value), new_value=body.value
    )

    return {"success": True, "key": key, "value": body.value}


# 批量更新配置
@router.post("/config/batch")
async def batch_update_config(body: SystemConfigBatchUpdate, request: Request):
    """批量更新配置"""
    admin_addr = _verify_admin(body.admin_address, request)

    batch_set_system_config(body.items, updated_by=admin_addr)
    add_audit_log(admin_addr, "batch_update_config", new_value=f"{len(body.items)} items")

    return {"success": True, "updated": len(body.items)}


# 重置系统配置
@router.post("/config/reset")
async def reset_config(body: dict, request: Request):
    """
    重置系统配置为默认值

    将所有系统配置项恢复为初始化时的默认值，并记录每项变更到审计日志。
    """
    admin_addr = _verify_admin(body.get("admin_address"), request)

    # 默认配置定义（与 database._init_default_config 保持一致）
    DEFAULT_CONFIG = {
        # 合约配置
        "fee_rate": ("200", "contract", "手续费率（基点，100=1%）"),
        # 游戏配置
        "commit_timeout": ("66", "game", "提交哈希超时时间（秒）"),
        "reveal_timeout": ("88", "game", "揭晓出拳超时时间（秒）"),
        "supported_tokens": ("USDC,USDT", "game", "支持的代币列表（逗号分隔）"),
        "max_bet_amount": ("10000", "game", "最大下注金额"),
        "min_bet_amount": ("1", "game", "最小下注金额"),
        # 主链配置
        "chain_id": ("5208888", "chain", "目标区块链网络 Chain ID"),
        "network_name": ("ChainRPS Local", "chain", "网络显示名称"),
        "rpc_url": ("http://127.0.0.1:8686", "chain", "RPC 节点 URL"),
        "block_explorer": ("", "chain", "区块浏览器 URL（可选）"),
        "contract_address": ("", "chain", "ChainRPS 游戏合约地址"),
        "native_symbol": ("ETH", "chain", "网络原生代币符号"),
        "native_name": ("Ether", "chain", "网络原生代币名称"),
        "native_decimals": ("18", "chain", "原生代币精度"),
        # 系统配置
        "maintenance_mode": ("0", "system", "维护模式开关（0=关闭, 1=开启）"),
        "official_website": ("https://chainrps.io", "system", "官方网站"),
        "official_twitter": ("@ChainRPS", "system", "官方 Twitter"),
        "official_discord": ("discord.gg/chainrps", "system", "官方 Discord"),
    }

    reset_count = 0
    for key, (default_value, category, desc) in DEFAULT_CONFIG.items():
        old_value = get_system_config_value(key)
        if old_value != default_value:
            set_system_config(key, default_value, updated_by=admin_addr, description=desc)
            add_audit_log(
                admin_addr, "reset_config",
                target=key, old_value=str(old_value), new_value=default_value,
            )
            reset_count += 1
        else:
            # 即使值相同也更新描述和分类，确保元数据完整
            set_system_config(key, default_value, updated_by=admin_addr, description=desc)

    if reset_count == 0:
        message = "所有配置已是默认值，无需重置"
    else:
        message = f"已重置 {reset_count} 项配置为默认值"

    return {"success": True, "message": message, "reset_count": reset_count}


# 查看配置变更历史
@router.get("/config/history")
async def config_history(
    page: int = Query(1, ge=1),
    size: int = Query(20, ge=1, le=100),
):
    """查看配置变更历史（通过审计日志实现）"""
    logs = list_audit_logs(action="update_config", page=page, size=size)
    return {
        "logs": [AuditLogEntry(**l) for l in logs],
        "page": page,
        "size": size,
    }


# ==================== 审计日志 ====================

# 获取操作审计日志
@router.get("/audit-logs")
async def get_audit_logs(
    admin_address: Optional[str] = None,
    action: Optional[str] = None,
    page: int = Query(1, ge=1),
    size: int = Query(20, ge=1, le=100),
):
    """获取操作审计日志"""
    logs = list_audit_logs(admin_address=admin_address, action=action, page=page, size=size)
    return {
        "logs": [AuditLogEntry(**l) for l in logs],
        "page": page,
        "size": size,
    }


# ==================== 仪表盘统计 ====================

# 管理员仪表盘
@router.get("/dashboard")
async def admin_dashboard():
    """管理员仪表盘概览数据"""
    from rps_backend.repository import get_connection

    conn = get_connection()
    try:
        cursor = conn.cursor()

        cursor.execute("SELECT COUNT(*) as total FROM games")
        total_games = cursor.fetchone()["total"]

        cursor.execute("SELECT COUNT(*) as total FROM games WHERE state = 'finished'")
        finished_games = cursor.fetchone()["total"]

        cursor.execute("SELECT COUNT(DISTINCT player1) + COUNT(DISTINCT player2) as approx FROM games")
        approx_players = cursor.fetchone()["approx"]

        cursor.execute("SELECT COALESCE(SUM(fee), 0) as total_fee FROM games WHERE state = 'finished'")
        total_fee = cursor.fetchone()["total_fee"]

        cursor.execute("SELECT COUNT(*) as total FROM contracts")
        total_contracts = cursor.fetchone()["total"]

        return {
            "total_games": total_games,
            "finished_games": finished_games,
            "active_players_approx": approx_players,
            "total_fee_collected": total_fee,
            "total_contracts": total_contracts,
        }
    finally:
        conn.close()


# ==================== 本地链管理 ====================

# 获取本地链状态
@router.get("/local-chain/status")
async def get_local_chain_status():
    """获取本地链状态（公开接口）"""
    from rps_backend.service.local_chain_service import get_local_chain_service
    service = get_local_chain_service()
    # get_node_status 内部会调用 is_running() 进行 HTTP 健康检测，可能阻塞数秒，
    # 放到线程池执行避免卡死事件循环
    return await _run_chain_async(service.get_node_status)


# 启动本地链
@router.post("/local-chain/start")
async def start_local_chain(request: Request):
    """启动本地链（开发环境功能，无需权限）

    支持可选的自定义配置，全部参数均可省略使用默认值：
    - chain_type: 链类型，可选 "ganache" | "hardhat"，默认 ganache
    - host: 监听地址，默认 {RPC_LOCAL_HOST}
    - port: 端口，默认 {RPC_LOCAL_PORT}
    - chain_id: 链 ID，默认 {CHAIN_ID}（避免与 GoChain 冲突，防止 MetaMask 误识别）
    - accounts_count: 生成账户数，默认 {DEFAULT_ACCOUNT_COUNT}
    - default_balance: 每个账户默认余额，默认 {DEFAULT_BALANCE}
    - symbol: 原生代币符号，默认 {RPC_SYMBOL}
    - deterministic: 是否使用确定性助记词，默认 true
    """
    try:
        body = await request.json()
    except Exception:
        body = {}

    from rps_backend.service.local_chain_service import get_local_chain_service
    service = get_local_chain_service()

    # 解析可选参数，缺省时使用 start_node 的内置默认值
    kwargs = {}
    if "chain_type" in body and body["chain_type"]:
        kwargs["chain_type"] = str(body["chain_type"]).strip().lower()
    if "host" in body and body["host"]:
        kwargs["host"] = str(body["host"]).strip()
    if "port" in body and body["port"]:
        kwargs["port"] = int(body["port"])
    if "chain_id" in body and body["chain_id"]:
        kwargs["chain_id"] = int(body["chain_id"])
    if "accounts_count" in body and body["accounts_count"]:
        kwargs["accounts_count"] = int(body["accounts_count"])
    if "default_balance" in body and body["default_balance"] is not None and body["default_balance"] != "":
        kwargs["default_balance"] = float(body["default_balance"])
    if "symbol" in body and body["symbol"]:
        kwargs["symbol"] = str(body["symbol"]).strip()
    if "deterministic" in body:
        kwargs["deterministic"] = bool(body["deterministic"])

    result = await _run_chain_async(service.start_node, **kwargs)
    if not result.get("success"):
        raise HTTPException(status_code=500, detail=result.get("message", "启动失败"))
    return result


# 停止本地链
@router.post("/local-chain/stop")
async def stop_local_chain():
    """停止本地链（开发环境功能，无需权限）"""
    from rps_backend.service.local_chain_service import get_local_chain_service
    service = get_local_chain_service()
    result = await _run_chain_async(service.stop_node)
    if not result.get("success"):
        raise HTTPException(status_code=500, detail=result.get("message", "停止失败"))
    return result


# 获取保活状态
@router.get("/local-chain/keep-alive")
async def get_keep_alive_status():
    """获取本地链保活功能状态"""
    from rps_backend.service.local_chain_service import get_local_chain_service
    service = get_local_chain_service()
    return {"success": True, **service.get_keep_alive_status()}


# 设置保活开关
@router.post("/local-chain/keep-alive")
async def set_keep_alive(request: Request):
    """
    设置本地链保活功能开关。

    开启保活后，如果节点意外退出，后台巡检会自动重启。
    请求体：
    - enabled: bool 是否开启保活
    - chain_type: 链类型，可选 "ganache" | "hardhat"，默认 ganache
    - 其余参数同 start_node（host, port, chain_id 等，可选，用于首次启动或重启时使用）
    """
    try:
        body = await request.json()
    except Exception:
        body = {}

    enabled = bool(body.get("enabled", False))

    from rps_backend.service.local_chain_service import get_local_chain_service
    service = get_local_chain_service()

    kwargs = {}
    for key in ["chain_type", "host", "port", "chain_id", "accounts_count", "default_balance", "symbol", "deterministic"]:
        if key in body and body[key] is not None:
            if key == "chain_type":
                kwargs[key] = str(body[key]).strip().lower()
            elif key in ("port", "chain_id", "accounts_count"):
                kwargs[key] = int(body[key])
            elif key == "default_balance":
                kwargs[key] = float(body[key])
            elif key == "deterministic":
                kwargs[key] = bool(body[key])
            else:
                kwargs[key] = str(body[key])

    result = await _run_chain_async(service.set_keep_alive, enabled, **kwargs)
    if not result.get("success"):
        raise HTTPException(status_code=500, detail=result.get("message", "操作失败"))
    return result


# 获取本地链账户列表
@router.get("/local-chain/accounts")
async def get_local_chain_accounts():
    """获取本地链账户列表（含余额，开发环境功能）"""
    from rps_backend.service.local_chain_service import get_local_chain_service
    service = get_local_chain_service()
    # is_running() 和 get_accounts() 都会进行 RPC 调用，可能阻塞，放到线程池执行
    def _get_accounts():
        if not service.is_running():
            return []
        return service.get_accounts()
    accounts = await _run_chain_async(_get_accounts)
    return {"accounts": accounts}


# 从本地链转账 ETH
@router.post("/local-chain/send-eth")
async def send_eth_from_local_chain(request: Request):
    """从本地链账户转账 ETH 到指定地址（开发环境功能）"""
    body = await request.json()
    from_index = body.get("from_index", 0)
    to_address = body.get("to_address")
    amount = body.get("amount", 1.0)

    if not to_address:
        return {"success": False, "message": "接收地址必填"}

    from rps_backend.service.local_chain_service import get_local_chain_service
    service = get_local_chain_service()

    # 将 is_running 检查与 send_eth 一并放到线程池，避免阻塞事件循环
    def _do_send():
        if not service.is_running():
            return {"success": False, "message": "本地链未运行，请先开启节点"}
        return service.send_eth(from_index, to_address, float(amount))

    result = await _run_chain_async(_do_send)
    if not result.get("success"):
        return {"success": False, "message": result.get("message", "转账失败")}
    return result


# 获取本地链代币列表
@router.get("/local-chain/tokens")
async def get_local_chain_tokens():
    """获取本地链已部署的测试代币列表（开发环境功能）"""
    from rps_backend.service.local_chain_service import get_local_chain_service
    service = get_local_chain_service()
    # is_running() 会进行 HTTP 健康检测，可能阻塞，放到线程池执行
    def _get_tokens():
        if not service.is_running():
            return []
        return service.get_tokens()
    tokens = await _run_chain_async(_get_tokens)
    return {"tokens": tokens}


# 部署测试代币
@router.post("/local-chain/deploy-token")
async def deploy_local_token(request: Request):
    """在本地链部署测试代币 (MockERC20，开发环境功能)"""
    body = await request.json()
    name = body.get("name", "Mock USDC")
    symbol = body.get("symbol", "USDC")
    decimals = int(body.get("decimals", 6))
    initial_supply = int(body.get("initial_supply", 1_000_000))
    from_index = int(body.get("from_index", 0))

    from rps_backend.service.local_chain_service import get_local_chain_service
    service = get_local_chain_service()

    # 部署合约涉及多次 RPC 调用和等待交易确认，必须放到线程池
    def _do_deploy():
        if not service.is_running():
            return {"success": False, "message": "本地链未运行，请先开启节点"}
        return service.deploy_mock_erc20(
            from_index=from_index,
            name=name,
            symbol=symbol,
            decimals=decimals,
            initial_supply=initial_supply,
        )

    result = await _run_chain_async(_do_deploy)
    if not result.get("success"):
        return {"success": False, "message": result.get("message", "部署失败")}
    return result


# Mint 测试代币
@router.post("/local-chain/mint-token")
async def mint_local_token(request: Request):
    """在本地链 Mint 测试代币（开发环境功能）"""
    body = await request.json()
    token_symbol = body.get("symbol")
    to_address = body.get("to_address")
    amount = body.get("amount", 10000)
    from_index = int(body.get("from_index", 0))

    if not token_symbol or not to_address:
        return {"success": False, "message": "代币符号和接收地址必填"}

    from rps_backend.service.local_chain_service import get_local_chain_service
    service = get_local_chain_service()

    # Mint 涉及多次 RPC 调用和等待交易确认，必须放到线程池
    def _do_mint():
        if not service.is_running():
            return {"success": False, "message": "本地链未运行，请先开启节点"}
        return service.mint_tokens(token_symbol, to_address, float(amount), from_index)

    result = await _run_chain_async(_do_mint)
    if not result.get("success"):
        return {"success": False, "message": result.get("message", "Mint 失败")}
    return result


# ==================== 本地链浏览器 ====================

# 统一查询接口（自动识别区块号/交易哈希/地址）
@router.get("/local-chain/explorer/query/{query}")
async def explorer_query(query: str):
    """本地链浏览器统一查询接口

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

    # 所有 RPC 调用都放到线程池，避免阻塞事件循环
    def _do_query():
        if not service.is_running():
            return {"success": False, "message": "本地链未运行", "type": None, "data": None}

        # 交易哈希：0x + 64 hex
        if q.startswith("0x") and len(q) == 66:
            data = service.get_transaction(q)
            if data:
                return {"success": True, "type": "transaction", "data": data}
            return {"success": False, "message": "未找到该交易", "type": "transaction", "data": None}

        # 地址：0x + 40 hex
        if q.startswith("0x") and len(q) == 42:
            data = service.get_address_info(q)
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

    return await _run_chain_async(_do_query)


# 查询最新区块信息
@router.get("/local-chain/explorer/latest-block")
async def explorer_latest_block():
    """获取本地链最新区块号和区块信息"""
    from rps_backend.service.local_chain_service import get_local_chain_service
    service = get_local_chain_service()

    # RPC 调用放到线程池执行
    def _do_latest():
        if not service.is_running():
            return {"success": False, "message": "本地链未运行", "block_number": None}
        block_num = service.get_latest_block_number()
        if block_num is None:
            return {"success": False, "message": "查询失败", "block_number": None}
        block = service.get_block(block_num)
        return {"success": True, "block_number": block_num, "block": block}

    return await _run_chain_async(_do_latest)


# 查询地址的交易记录
@router.get("/local-chain/explorer/address/{address}/transactions")
async def explorer_address_transactions(address: str, scan_blocks: int = 100, limit: int = 50):
    """查询本地链上指定地址的交易记录（扫描最近 N 个区块）"""
    from rps_backend.service.local_chain_service import get_local_chain_service
    service = get_local_chain_service()

    # 限制扫描范围，避免性能问题：默认 100，最大 500
    scan_blocks = min(max(scan_blocks, 10), 500)
    limit = min(max(limit, 1), 200)

    # 扫描区块是耗时的 RPC 操作，必须放到线程池执行
    def _do_scan():
        if not service.is_running():
            return {"success": False, "message": "本地链未运行", "transactions": []}
        data = service.get_address_transactions(address, scan_blocks, limit)
        if data is None:
            return {"success": False, "message": "查询失败", "transactions": []}
        return {"success": True, **data}

    return await _run_chain_async(_do_scan)


# ==================== Redis 管理 ====================

# 获取 Redis 状态
@router.get("/redis/status")
async def get_redis_status(request: Request):
    """获取 Redis 节点状态"""
    _verify_admin(None, request)
    from rps_backend.service.redis_admin_service import get_redis_admin_service
    service = get_redis_admin_service()
    # get_status 内部会调用 redis ping()，可能阻塞，放到线程池
    return await _run_chain_async(service.get_status)


# 启动 Redis
@router.post("/redis/start")
async def start_redis(request: Request):
    """启动 Redis 服务"""
    _verify_admin(None, request)
    from rps_backend.service.redis_admin_service import get_redis_admin_service
    service = get_redis_admin_service()
    # start_node 内部有 subprocess + time.sleep 循环，必须放到线程池
    result = await _run_chain_async(service.start_node)
    if not result.get("success"):
        raise HTTPException(status_code=500, detail=result.get("message", "启动失败"))
    return result


# 停止 Redis
@router.post("/redis/stop")
async def stop_redis(request: Request):
    """停止 Redis 服务"""
    _verify_admin(None, request)
    from rps_backend.service.redis_admin_service import get_redis_admin_service
    service = get_redis_admin_service()
    # stop_node 内部有 subprocess + time.sleep，必须放到线程池
    result = await _run_chain_async(service.stop_node)
    if not result.get("success"):
        raise HTTPException(status_code=500, detail=result.get("message", "停止失败"))
    return result


# 获取 Redis 配置
@router.get("/redis/config")
async def get_redis_config(request: Request):
    """获取 Redis 配置"""
    _verify_admin(None, request)
    from rps_backend.service.redis_admin_service import get_redis_admin_service
    service = get_redis_admin_service()
    result = await _run_chain_async(service.get_config)
    if not result.get("success"):
        raise HTTPException(status_code=500, detail=result.get("message", "获取配置失败"))
    return result


# 获取 Redis 键列表
@router.get("/redis/keys")
async def get_redis_keys(
    request: Request,
    pattern: str = "*",
    db: int = 0,
    limit: int = 100,
):
    """获取 Redis 键列表"""
    _verify_admin(None, request)
    from rps_backend.service.redis_admin_service import get_redis_admin_service
    service = get_redis_admin_service()
    # Redis KEYS 命令在大库上会阻塞，放到线程池
    result = await _run_chain_async(service.get_keys, pattern=pattern, db=db, limit=limit)
    if not result.get("success"):
        raise HTTPException(status_code=500, detail=result.get("message", "获取键列表失败"))
    return result


# 清空 Redis 数据库
@router.post("/redis/flush-db")
async def flush_redis_db(request: Request):
    """清空 Redis 数据库"""
    _verify_admin(None, request)
    body = await request.json()
    db = int(body.get("db", 0))

    if not body.get("confirm"):
        raise HTTPException(status_code=400, detail="请确认清空操作")

    from rps_backend.service.redis_admin_service import get_redis_admin_service
    service = get_redis_admin_service()
    result = await _run_chain_async(service.flush_db, db=db)
    if not result.get("success"):
        raise HTTPException(status_code=500, detail=result.get("message", "清空失败"))
    return result


# 删除 Redis 指定键
@router.post("/redis/delete-key")
async def delete_redis_key(request: Request):
    """删除 Redis 指定键"""
    _verify_admin(None, request)
    body = await request.json()
    key = body.get("key")
    if not key:
        raise HTTPException(status_code=400, detail="键名必填")

    from rps_backend.service.redis_admin_service import get_redis_admin_service
    service = get_redis_admin_service()
    result = await _run_chain_async(service.delete_key, key)
    if not result.get("success"):
        raise HTTPException(status_code=500, detail=result.get("message", "删除失败"))
    return result