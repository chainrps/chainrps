"""
ChainRPS 合约超时参数设置脚本

部署后调用合约 setTimeouts(66, 88)，使链上 commitTimeout / revealTimeout
与前端 rps_frontend/static/js/config.js 中的配置保持一致：
    - commitTimeout = 66 秒
    - revealTimeout = 88 秒

使用方式：
    python contracts/scripts/set_timeouts.py [contract_address]

环境变量（.env 文件）：
    DEPLOYER_PRIVATE_KEY   - 调用者私钥（必填，需为合约 owner）
    RPC_URL               - RPC 节点 URL（可选，默认本地测试网）

依赖：
    pip install web3 python-dotenv
"""
import json
import os
import sys
from pathlib import Path

from dotenv import load_dotenv
from web3 import Web3

# 与前端 config.js 对齐的超时参数
COMMIT_TIMEOUT = 66
REVEAL_TIMEOUT = 88

PROJECT_ROOT = Path(__file__).resolve().parent.parent.parent
load_dotenv(PROJECT_ROOT / ".env")

RPC_URL = os.getenv("RPC_URL", "http://127.0.0.1:8686")
DEPLOYER_PRIVATE_KEY = os.getenv("DEPLOYER_PRIVATE_KEY", "")
BUILD_DIR = PROJECT_ROOT / "contracts" / "build"
BUILD_FILE = BUILD_DIR / "chainrps.json"


def load_abi():
    if not BUILD_FILE.exists():
        print("❌ 合约未编译，请先运行 contracts/scripts/compile.py")
        sys.exit(1)
    with open(BUILD_FILE, "r", encoding="utf-8") as f:
        data = json.load(f)
    return data.get("abi")


def main():
    contract_address = sys.argv[1] if len(sys.argv) > 1 else os.getenv("CONTRACT_ADDRESS", "")
    if not contract_address:
        print("❌ 请提供合约地址：python contracts/scripts/set_timeouts.py 0x...")
        sys.exit(1)

    if not DEPLOYER_PRIVATE_KEY:
        print("❌ DEPLOYER_PRIVATE_KEY 未配置，请在 .env 文件中设置")
        sys.exit(1)

    w3 = Web3(Web3.HTTPProvider(RPC_URL))
    if not w3.is_connected():
        print(f"❌ 无法连接到 RPC: {RPC_URL}")
        sys.exit(1)
    print(f"✅ 已连接到 RPC: {RPC_URL}")

    deployer = w3.eth.account.from_key(DEPLOYER_PRIVATE_KEY)
    deployer_addr = deployer.address
    print(f"   调用者地址: {deployer_addr}")

    abi = load_abi()
    contract = w3.eth.contract(
        address=Web3.to_checksum_address(contract_address),
        abi=abi,
    )

    # 查询当前超时
    try:
        old_commit = contract.functions.commitTimeout().call()
        old_reveal = contract.functions.revealTimeout().call()
        print(f"   当前 commitTimeout={old_commit}s, revealTimeout={old_reveal}s")
    except Exception as e:
        print(f"⚠️  查询当前超时失败: {e}")

    print(f"\n🔄 设置超时: commitTimeout={COMMIT_TIMEOUT}s, revealTimeout={REVEAL_TIMEOUT}s ...")

    nonce = w3.eth.get_transaction_count(deployer_addr)
    gas_price = w3.eth.gas_price
    tx = contract.functions.setTimeouts(COMMIT_TIMEOUT, REVEAL_TIMEOUT).build_transaction({
        "from": deployer_addr,
        "nonce": nonce,
        "gas": 100000,
        "gasPrice": gas_price,
        "chainId": w3.eth.chain_id,
    })
    signed_tx = w3.eth.account.sign_transaction(tx, DEPLOYER_PRIVATE_KEY)
    tx_hash = w3.eth.send_raw_transaction(signed_tx.rawTransaction
                                          if hasattr(signed_tx, "rawTransaction")
                                          else signed_tx.raw_transaction)
    print(f"   交易哈希: {tx_hash.hex()}")
    receipt = w3.eth.wait_for_transaction_receipt(tx_hash, timeout=180)

    if receipt.status == 1:
        print(f"\n✅ 设置成功! commitTimeout={COMMIT_TIMEOUT}s, revealTimeout={REVEAL_TIMEOUT}s（与前端对齐）")
    else:
        print(f"\n❌ 设置失败，交易状态: {receipt.status}")
        sys.exit(1)


if __name__ == "__main__":
    print("=" * 60)
    print("ChainRPS 合约超时参数设置")
    print("=" * 60)
    main()
