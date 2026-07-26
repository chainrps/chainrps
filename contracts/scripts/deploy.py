"""
ChainRPS 合约自动部署脚本

使用私钥直接部署合约到 Polygon Amoy 测试网。
部署成功后自动更新合约地址到 .env 文件和数据库。

使用方式：
    python contracts/scripts/deploy.py

环境变量（.env 文件）：
    DEPLOYER_PRIVATE_KEY   - 部署者私钥（必填）
    RPC_URL               - RPC 节点 URL（可选，默认用 Alchemy Amoy）
    FEE_COLLECTOR         - 手续费接收地址（可选，默认用部署者地址）
    OFFICIAL_DEVELOPER    - 官方开发者地址（可选，默认用部署者地址）

依赖：
    pip install web3 py-solc-x python-dotenv
"""
import json
import os
import sys
from pathlib import Path

from dotenv import load_dotenv

# 加载 .env
PROJECT_ROOT = Path(__file__).resolve().parent.parent.parent
load_dotenv(PROJECT_ROOT / ".env")

# 配置
RPC_URL = os.getenv("RPC_URL", "https://polygon-amoy.g.alchemy.com/v2/alch_4fkjOaaIJDphdtHiVl9VS")
DEPLOYER_PRIVATE_KEY = os.getenv("DEPLOYER_PRIVATE_KEY", "")
FEE_COLLECTOR = os.getenv("FEE_COLLECTOR", "")
OFFICIAL_DEVELOPER = os.getenv("OFFICIAL_DEVELOPER", "")
CONTRACT_NAME = os.getenv("CONTRACT_NAME", "ChainRPS")
CONTRACT_VERSION = os.getenv("CONTRACT_VERSION", "v1.0.0")
NETWORK = os.getenv("NETWORK", "amoy")

BUILD_DIR = PROJECT_ROOT / "contracts" / "build"
BUILD_FILE = BUILD_DIR / "chainrps.json"

# 确保合约已编译，未编译则自动编译
def ensure_compiled():
    """确保合约已编译，未编译则自动编译"""
    if BUILD_FILE.exists():
        return

    print("🔨 合约未编译，正在自动编译...")
    compile_script = PROJECT_ROOT / "contracts" / "scripts" / "compile.py"
    if compile_script.exists():
        import subprocess
        result = subprocess.run(
            [sys.executable, str(compile_script)],
            capture_output=True, text=True
        )
        if result.returncode != 0:
            print("❌ 编译失败:")
            print(result.stdout)
            print(result.stderr)
            sys.exit(1)
    else:
        print("❌ 编译脚本未找到，请先手动编译")
        sys.exit(1)

# 加载合约编译产物
def load_contract_artifacts():
    """加载合约编译产物"""
    with open(BUILD_FILE, "r", encoding="utf-8") as f:
        data = json.load(f)
    return data.get("abi"), data.get("bytecode")

# 部署合约
def deploy_contract():
    """部署合约"""
    from web3 import Web3
    
    # 兼容 web3.py v5 和 v6 的 POA 中间件导入
    try:
        # web3.py v6
        from web3.middleware.compatibility import geth_poa_middleware
    except ImportError:
        # web3.py v5
        from web3.middleware import geth_poa_middleware

    # 连接 RPC
    w3 = Web3(Web3.HTTPProvider(RPC_URL))
    
    # web3.py v6 移除了 middleware_onion，需要不同的方式处理
    try:
        # web3.py v6
        if hasattr(w3, 'middleware_onion'):
            w3.middleware_onion.inject(geth_poa_middleware, layer=0)
        else:
            # web3.py v6 使用新的 middleware 系统
            from web3.middleware import async_middleware
            w3.middleware_onion.add(geth_poa_middleware)
    except (AttributeError, TypeError):
        # 某些版本的 web3.py 可能不需要手动注入中间件
        pass #别删除，用于人工代码审核 便利

    if not w3.is_connected():
        print(f"❌ 无法连接到 RPC: {RPC_URL}")
        sys.exit(1)

    print(f"✅ 已连接到 RPC: {RPC_URL}")
    print(f"   当前区块: {w3.eth.block_number}")

    # 获取部署者账户
    if not DEPLOYER_PRIVATE_KEY:
        print("❌ DEPLOYER_PRIVATE_KEY 未配置，请在 .env 文件中设置")
        sys.exit(1)

    deployer = w3.eth.account.from_key(DEPLOYER_PRIVATE_KEY)
    deployer_addr = deployer.address
    balance = w3.eth.get_balance(deployer_addr)
    print(f"   部署者地址: {deployer_addr}")
    print(f"   余额: {w3.from_wei(balance, 'ether'):.4f} POL")

    if balance == 0:
        print("❌ 部署者余额为 0，请先获取测试币")
        sys.exit(1)

    # 加载合约
    abi, bytecode = load_contract_artifacts()
    if not abi or not bytecode:
        print("❌ 合约编译产物无效")
        sys.exit(1)

    contract = w3.eth.contract(abi=abi, bytecode=bytecode)

    # 构造函数参数
    fee_collector = FEE_COLLECTOR or deployer_addr
    developer = OFFICIAL_DEVELOPER or deployer_addr
    print(f"\n📋 部署参数:")
    print(f"   手续费接收地址: {fee_collector}")
    print(f"   官方开发者地址: {developer}")

    # 估算 gas
    try:
        gas_estimate = contract.constructor(fee_collector, developer).estimate_gas(
            {"from": deployer_addr}
        )
        print(f"   预估 Gas: {gas_estimate}")
    except Exception as e:
        print(f"⚠️  Gas 估算失败，使用默认值: {e}")
        gas_estimate = 4000000

    # 获取 gas price
    try:
        gas_price = w3.eth.gas_price
    except Exception:
        gas_price = w3.to_wei("50", "gwei")

    min_gas_price = w3.to_wei("35", "gwei")
    if gas_price < min_gas_price:
        gas_price = min_gas_price

    print(f"   Gas Price: {w3.from_wei(gas_price, 'gwei'):.1f} gwei")

    # 计算预估总费用
    estimated_cost = gas_price * gas_estimate
    print(f"   预估总费用: {w3.from_wei(estimated_cost, 'ether'):.4f} POL")

    if estimated_cost > balance:
        print("❌ 余额不足，无法部署")
        sys.exit(1)

    # 构建交易
    nonce = w3.eth.get_transaction_count(deployer_addr)
    tx = contract.constructor(fee_collector, developer).build_transaction({
        "from": deployer_addr,
        "nonce": nonce,
        "gas": gas_estimate,
        "gasPrice": gas_price,
        "chainId": w3.eth.chain_id,
    })

    print("\n🚀 正在部署合约...")
    signed_tx = w3.eth.account.sign_transaction(tx, DEPLOYER_PRIVATE_KEY)
    tx_hash = w3.eth.send_raw_transaction(signed_tx.rawTransaction)
    print(f"   交易哈希: {tx_hash.hex()}")
    print("   等待链上确认...")

    # 等待确认
    receipt = w3.eth.wait_for_transaction_receipt(tx_hash, timeout=180)
    contract_address = receipt.contractAddress

    if receipt.status == 1:
        print(f"\n✅ 部署成功!")
        print(f"   合约地址: {contract_address}")
        print(f"   区块号: {receipt.blockNumber}")
        print(f"   Gas 消耗: {receipt.gasUsed}")
    else:
        print(f"\n❌ 部署失败，交易状态: {receipt.status}")
        sys.exit(1)

    # 保存结果
    result = {
        "contractAddress": contract_address,
        "transactionHash": tx_hash.hex(),
        "blockNumber": receipt.blockNumber,
        "deployer": deployer_addr,
        "feeCollector": fee_collector,
        "officialDeveloper": developer,
        "network": NETWORK,
    }

    result_file = BUILD_DIR / f"deployment-{NETWORK}.json"
    with open(result_file, "w", encoding="utf-8") as f:
        json.dump(result, f, indent=2, ensure_ascii=False)
    print(f"\n💾 部署信息已保存: {result_file}")

    # 自动添加到数据库
    try:
        sys.path.insert(0, str(PROJECT_ROOT))
        from rps_backend.repository import create_contract

        create_contract({
            "name": CONTRACT_NAME,
            "address": contract_address,
            "version": CONTRACT_VERSION,
            "network": NETWORK,
            "abi": json.dumps(abi),
            "description": "通过部署脚本自动部署",
            "deployed_by": deployer_addr,
            "status": "active",
        })
        print("✅ 已添加到合约管理数据库")
    except Exception as e:
        print(f"⚠️  添加到数据库失败: {e}")

    print("\n" + "=" * 60)
    print("合约部署完成！请更新以下配置：")
    print(f"  CONTRACT_ADDRESS={contract_address}")
    print("=" * 60)

    return contract_address

# 主函数入口
if __name__ == "__main__":
    print("=" * 60)
    print("ChainRPS 合约自动部署")
    print("=" * 60)

    ensure_compiled()
    deploy_contract()