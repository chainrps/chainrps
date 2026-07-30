import json
import os
import sys
from pathlib import Path

from web3 import Web3

from rps_backend.config import RPC_CHAIN_ID, RPC_LOCAL_URL, RPC_LOCAL_PORT, RPC_LOCAL_NETWORK

PROJECT_ROOT = Path(__file__).resolve().parent.parent.parent


BUILD_DIR = PROJECT_ROOT / "contracts" / "build"
BUILD_FILE = BUILD_DIR / "chainrps.json"

LOCAL_PRIVATE_KEY = "0x4f3edf983ac636a65a842ce7c78d9aa706d3b113bce9c46f30d7d21715b23b1d"

# 确保合约已编译，未编译则自动编译
def ensure_compiled():
    if BUILD_FILE.exists():
        return
    print("🔨 合约未编译，正在自动编译...")
    compile_script = PROJECT_ROOT / "contracts" / "scripts" / "compile.py"
    if compile_script.exists():
        import subprocess
        result = subprocess.run([sys.executable, str(compile_script)], capture_output=True, text=True)
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
    with open(BUILD_FILE, "r", encoding="utf-8") as f:
        data = json.load(f)
    return data.get("abi"), data.get("bytecode")

# 部署合约
def deploy_contract():
    w3 = Web3(Web3.HTTPProvider(RPC_LOCAL_URL))
    
    if not w3.is_connected():
        print(f"❌ 无法连接到本地测试网: {RPC_LOCAL_URL}")
        print(f"   请先启动本地节点: ganache -h 127.0.0.1 -p {RPC_LOCAL_PORT} --chain.chainId {RPC_CHAIN_ID}")
        sys.exit(1)

    print(f"✅ 已连接到本地测试网")
    print(f"   当前区块: {w3.eth.block_number}")

    deployer = w3.eth.account.from_key(LOCAL_PRIVATE_KEY)
    deployer_addr = deployer.address
    balance = w3.eth.get_balance(deployer_addr)
    print(f"   部署者地址: {deployer_addr}")
    print(f"   余额: {w3.from_wei(balance, 'ether'):.4f} ETH")

    abi, bytecode = load_contract_artifacts()
    if not abi or not bytecode:
        print("❌ 合约编译产物无效")
        sys.exit(1)

    contract = w3.eth.contract(abi=abi, bytecode=bytecode)

    fee_collector = deployer_addr
    developer = deployer_addr
    print(f"\n📋 部署参数:")
    print(f"   手续费接收地址: {fee_collector}")
    print(f"   官方开发者地址: {developer}")

    try:
        gas_estimate = contract.constructor(fee_collector, developer).estimate_gas({"from": deployer_addr})
        print(f"   预估 Gas: {gas_estimate}")
    except Exception as e:
        print(f"⚠️  Gas 估算失败，使用默认值: {e}")
        gas_estimate = 4000000

    gas_price = w3.eth.gas_price
    print(f"   Gas Price: {w3.from_wei(gas_price, 'gwei'):.1f} gwei")

    nonce = w3.eth.get_transaction_count(deployer_addr)
    tx = contract.constructor(fee_collector, developer).build_transaction({
        "from": deployer_addr,
        "nonce": nonce,
        "gas": gas_estimate,
        "gasPrice": gas_price,
        "chainId": w3.eth.chain_id,
    })

    print("\n🚀 正在部署合约...")
    signed_tx = w3.eth.account.sign_transaction(tx, LOCAL_PRIVATE_KEY)
    tx_hash = w3.eth.send_raw_transaction(signed_tx.raw_transaction)
    print(f"   交易哈希: {tx_hash.hex()}")
    print("   等待链上确认...")

    receipt = w3.eth.wait_for_transaction_receipt(tx_hash, timeout=60)
    contract_address = receipt.contractAddress

    if receipt.status == 1:
        print(f"\n✅ 部署成功!")
        print(f"   合约地址: {contract_address}")
        print(f"   区块号: {receipt.blockNumber}")
        print(f"   Gas 消耗: {receipt.gasUsed}")
    else:
        print(f"\n❌ 部署失败，交易状态: {receipt.status}")
        sys.exit(1)

    # 部署后设置 commit/reveal 超时，与前端 config.js 对齐（commit=66s, reveal=88s）
    try:
        deployed = w3.eth.contract(address=contract_address, abi=abi)
        nonce2 = w3.eth.get_transaction_count(deployer_addr)
        set_tx = deployed.functions.setTimeouts(66, 88).build_transaction({
            "from": deployer_addr,
            "nonce": nonce2,
            "gas": 100000,
            "gasPrice": gas_price,
            "chainId": w3.eth.chain_id,
        })
        signed_set_tx = w3.eth.account.sign_transaction(set_tx, LOCAL_PRIVATE_KEY)
        set_tx_hash = w3.eth.send_raw_transaction(signed_set_tx.raw_transaction)
        set_receipt = w3.eth.wait_for_transaction_receipt(set_tx_hash, timeout=60)
        if set_receipt.status == 1:
            print("✅ 已设置超时: commitTimeout=66s, revealTimeout=88s（与前端对齐）")
        else:
            print(f"⚠️  setTimeouts 交易失败，状态: {set_receipt.status}")
    except Exception as e:
        print(f"⚠️  设置超时失败: {e}")

    config_js_path = PROJECT_ROOT / "frontend" / "static" / "js" / "config.js"
    if config_js_path.exists():
        with open(config_js_path, "r", encoding="utf-8") as f:
            content = f.read()
        content = content.replace("'0xYourContractAddress'", f"'{contract_address}'")
        with open(config_js_path, "w", encoding="utf-8") as f:
            f.write(content)
        print(f"\n✅ 已更新前端配置: {config_js_path}")

    env_path = PROJECT_ROOT / ".env"
    if env_path.exists():
        with open(env_path, "r", encoding="utf-8") as f:
            content = f.read()
        if "CONTRACT_ADDRESS=" in content:
            content = content.replace("CONTRACT_ADDRESS=", f"CONTRACT_ADDRESS={contract_address}", 1)
        else:
            content += f"\nCONTRACT_ADDRESS={contract_address}"
        with open(env_path, "w", encoding="utf-8") as f:
            f.write(content)
        print(f"✅ 已更新 .env 配置: {env_path}")

    try:
        sys.path.insert(0, str(PROJECT_ROOT))
        from rps_backend.repository import add_contract_record
        add_contract_record({
            "name": "ChainRPS",
            "address": contract_address,
            "version": "v1.0.0",
            "network": "localhost",
            "abi": json.dumps(abi),
            "description": "通过本地部署脚本部署",
            "deployed_by": deployer_addr,
            "status": "active",
        })
        print("✅ 已添加到合约管理数据库")
    except Exception as e:
        print(f"⚠️  添加到数据库失败: {e}")

    print("\n" + "=" * 60)
    print("合约部署完成！")
    print(f"  合约地址: {contract_address}")
    print("=" * 60)

    return contract_address


if __name__ == "__main__":
    print("=" * 60)
    print(f"{RPC_LOCAL_NETWORK} 本地测试网部署")
    print("=" * 60)

    ensure_compiled()
    deploy_contract()