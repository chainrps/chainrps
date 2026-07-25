"""
ChainRPS 合约部署脚本
支持部署 RPSGame 主合约和 MockERC20 测试代币

使用方式:
    python deploy.py --contract RPSGame --network amoy --private-key KEY --fee-collector ADDR --developer ADDR
    python deploy.py --contract MockERC20 --network amoy --private-key KEY --name TestUSDC --symbol USDC --decimals 6 --supply 1000000000000
"""

import json
import os
import sys
import argparse
from web3 import Web3
from eth_account import Account

NETWORKS = {
    "amoy": {
        "rpc_url": "https://rpc-amoy.polygon.technology/",
        "chain_id": 80002,
        "name": "Polygon Amoy Testnet",
        "explorer": "https://www.oklink.com/amoy",
    },
    "polygon": {
        "rpc_url": "https://polygon-rpc.com",
        "chain_id": 137,
        "name": "Polygon Mainnet",
        "explorer": "https://polygonscan.com",
    },
}

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
CONTRACT_DIR = os.path.join(SCRIPT_DIR, "..", "src")
BUILD_DIR = os.path.join(SCRIPT_DIR, "..", "build")


def load_compiled_contract(contract_name: str) -> dict:
    """从 build 目录加载已编译的合约 ABI 和 Bytecode"""
    compiled_path = os.path.join(BUILD_DIR, f"{contract_name}.json")
    if not os.path.exists(compiled_path):
        raise FileNotFoundError(
            f"未找到编译输出文件: {compiled_path}\n"
            f"请先使用 Remix 或 solc 编译合约，将输出保存到 {compiled_path}\n"
            f"编译输出格式: {{\"abi\": [...], \"bytecode\": \"0x...\"}}"
        )
    with open(compiled_path, "r", encoding="utf-8") as f:
        return json.load(f)


def connect_network(network: str):
    """连接到指定网络"""
    config = NETWORKS[network]
    w3 = Web3(Web3.HTTPProvider(config["rpc_url"]))
    if not w3.is_connected():
        raise Exception(f"无法连接到 {config['name']} ({config['rpc_url']})")
    print(f"✓ 已连接到 {config['name']}")
    return w3, config


def deploy_contract(w3, account, contract_name: str, constructor_args: list, chain_id: int):
    """部署合约"""
    compiled = load_compiled_contract(contract_name)
    abi = compiled["abi"]
    bytecode = compiled["bytecode"]

    contract = w3.eth.contract(abi=abi, bytecode=bytecode)
    nonce = w3.eth.get_transaction_count(account.address)

    tx = contract.constructor(*constructor_args).build_transaction(
        {
            "from": account.address,
            "nonce": nonce,
            "gasPrice": w3.eth.gas_price,
            "chainId": chain_id,
        }
    )

    # 估算 gas
    try:
        estimated_gas = w3.eth.estimate_gas(tx)
        tx["gas"] = int(estimated_gas * 1.2)
        print(f"  估算 Gas: {estimated_gas}, 预留: {tx['gas']}")
    except Exception as e:
        print(f"  ⚠ Gas 估算失败，使用默认值: {e}")
        tx["gas"] = 5000000

    signed_tx = w3.eth.account.sign_transaction(tx, account.key)
    tx_hash = w3.eth.send_raw_transaction(signed_tx.raw_transaction)

    print(f"  交易哈希: {tx_hash.hex()}")
    print("  等待链上确认...")

    receipt = w3.eth.wait_for_transaction_receipt(tx_hash)

    if receipt.status != 1:
        raise Exception(f"合约部署失败! 交易状态: {receipt.status}")

    print(f"✓ {contract_name} 部署成功!")
    print(f"  合约地址: {receipt.contractAddress}")
    print(f"  区块高度: {receipt.blockNumber}")
    print(f"  Gas 消耗: {receipt.gasUsed}")

    return receipt.contractAddress, abi, tx_hash.hex()


def save_deployment_info(network: str, contract_name: str, address: str, abi: list,
                        tx_hash: str, deployer: str, extra: dict = None):
    """保存部署信息到文件"""
    os.makedirs(BUILD_DIR, exist_ok=True)

    info = {
        "network": network,
        "contract": contract_name,
        "address": address,
        "deployer": deployer,
        "tx_hash": tx_hash,
        "explorer_url": f"{NETWORKS[network]['explorer']}/address/{address}",
        "timestamp": __import__("time").time(),
    }
    if extra:
        info.update(extra)

    info_path = os.path.join(BUILD_DIR, f"deployment_{network}_{contract_name}.json")
    with open(info_path, "w", encoding="utf-8") as f:
        json.dump(info, f, indent=2, ensure_ascii=False)
    print(f"  部署信息已保存: {info_path}")

    # 同时保存 ABI
    abi_path = os.path.join(BUILD_DIR, f"{contract_name}_abi.json")
    with open(abi_path, "w", encoding="utf-8") as f:
        json.dump(abi, f, indent=2)
    print(f"  ABI 已保存: {abi_path}")


def deploy_rps_game(w3, account, network: str, fee_collector: str, developer: str):
    """部署 RPSGame 主合约"""
    print(f"\n=== 部署 RPSGame 合约 ===")
    print(f"  手续费接收地址: {fee_collector}")
    print(f"  官方开发者地址: {developer}")

    constructor_args = [
        Web3.to_checksum_address(fee_collector),
        Web3.to_checksum_address(developer),
    ]

    address, abi, tx_hash = deploy_contract(
        w3, account, "RPSGame", constructor_args, NETWORKS[network]["chain_id"]
    )

    save_deployment_info(
        network,
        "RPSGame",
        address,
        abi,
        tx_hash,
        account.address,
        {
            "fee_collector": fee_collector,
            "official_developer": developer,
            "version": "v1.0.0",
        },
    )

    return address


def deploy_mock_erc20(w3, account, network: str, name: str, symbol: str,
                      decimals: int, initial_supply: int):
    """部署 MockERC20 测试代币"""
    print(f"\n=== 部署 MockERC20 合约 ===")
    print(f"  代币名称: {name}")
    print(f"  代币符号: {symbol}")
    print(f"  小数位数: {decimals}")
    print(f"  初始供应量: {initial_supply} ({initial_supply / (10 ** decimals):,.2f} {symbol})")

    constructor_args = [name, symbol, decimals, initial_supply]

    address, abi, tx_hash = deploy_contract(
        w3, account, "MockERC20", constructor_args, NETWORKS[network]["chain_id"]
    )

    save_deployment_info(
        network,
        "MockERC20",
        address,
        abi,
        tx_hash,
        account.address,
        {
            "name": name,
            "symbol": symbol,
            "decimals": decimals,
            "initial_supply": initial_supply,
        },
    )

    return address


def main():
    parser = argparse.ArgumentParser(description="ChainRPS 合约部署工具")
    parser.add_argument(
        "--contract",
        required=True,
        choices=["RPSGame", "MockERC20"],
        help="要部署的合约类型",
    )
    parser.add_argument(
        "--network",
        default="amoy",
        choices=list(NETWORKS.keys()),
        help="部署网络 (默认: amoy)",
    )
    parser.add_argument("--private-key", required=True, help="部署者私钥")

    # RPSGame 参数
    parser.add_argument("--fee-collector", help="手续费接收地址 (RPSGame)")
    parser.add_argument("--developer", help="官方开发者地址 (RPSGame)")

    # MockERC20 参数
    parser.add_argument("--name", default="TestUSDC", help="代币名称 (MockERC20)")
    parser.add_argument("--symbol", default="USDC", help="代币符号 (MockERC20)")
    parser.add_argument("--decimals", type=int, default=6, help="小数位数 (MockERC20)")
    parser.add_argument(
        "--supply",
        type=int,
        default=10_000_000_000000,  # 1000万 USDC (6位小数)
        help="初始供应量 (最小单位，MockERC20)",
    )

    args = parser.parse_args()

    # 校验参数
    if args.contract == "RPSGame":
        if not args.fee_collector or not args.developer:
            parser.error("部署 RPSGame 需要 --fee-collector 和 --developer 参数")

    try:
        w3, config = connect_network(args.network)
        account = Account.from_key(args.private_key)
        print(f"部署账户: {account.address}")

        balance = w3.eth.get_balance(account.address)
        print(f"账户余额: {w3.from_wei(balance, 'ether'):.4f} MATIC")

        if balance == 0:
            print("⚠  账户余额为 0，请先获取测试币!")
            sys.exit(1)

        if args.contract == "RPSGame":
            deploy_rps_game(w3, account, args.network, args.fee_collector, args.developer)
        elif args.contract == "MockERC20":
            deploy_mock_erc20(
                w3, account, args.network,
                args.name, args.symbol, args.decimals, args.supply
            )

        print("\n✓ 部署完成!")

    except Exception as e:
        print(f"\n✗ 部署失败: {e}")
        import traceback
        traceback.print_exc()
        sys.exit(1)


if __name__ == "__main__":
    main()
