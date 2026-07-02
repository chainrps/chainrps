# 部署脚本
# 使用 Python + web3.py 进行合约部署

import json
import os
from web3 import Web3
from eth_account import Account

# 网络配置
NETWORKS = {
    "amoy": {
        "rpc_url": "https://rpc-amoy.polygon.technology/",
        "chain_id": 80002,
        "name": "Polygon Amoy Testnet"
    },
    "polygon": {
        "rpc_url": "https://polygon-rpc.com",
        "chain_id": 137,
        "name": "Polygon Mainnet"
    }
}

def deploy_contract(private_key: str, network: str, fee_collector: str):
    """
    部署 RPSGame 合约
    
    Args:
        private_key: 部署者私钥
        network: 网络名称 (amoy / polygon)
        fee_collector: 手续费收取地址
    """
    
    # 连接网络
    config = NETWORKS[network]
    w3 = Web3(Web3.HTTPProvider(config["rpc_url"]))
    
    if not w3.is_connected():
        raise Exception(f"无法连接到 {config['name']}")
    
    # 加载合约
    contract_path = os.path.join(os.path.dirname(__file__), "../src/RPSGame.sol")
    # 注意：需要先编译合约生成 ABI 和 Bytecode
    # 这里使用 Remix 或 solc 编译后的输出
    
    # 示例：从编译输出文件加载
    compiled_path = os.path.join(os.path.dirname(__file__), "../build/RPSGame.json")
    with open(compiled_path, "r") as f:
        compiled = json.load(f)
    
    abi = compiled["abi"]
    bytecode = compiled["bytecode"]
    
    # 创建账户
    account = Account.from_key(private_key)
    print(f"部署账户: {account.address}")
    
    # 检查余额
    balance = w3.eth.get_balance(account.address)
    print(f"账户余额: {w3.from_wei(balance, 'ether')} MATIC")
    
    # 构建合约
    contract = w3.eth.contract(abi=abi, bytecode=bytecode)
    
    # 构建交易
    constructor_args = [fee_collector]
    tx = contract.constructor(*constructor_args).build_transaction({
        "from": account.address,
        "gas": 3000000,
        "gasPrice": w3.eth.gas_price,
        "nonce": w3.eth.get_transaction_count(account.address),
        "chainId": config["chain_id"]
    })
    
    # 签名并发送
    signed_tx = w3.eth.account.sign_transaction(tx, private_key)
    tx_hash = w3.eth.send_raw_transaction(signed_tx.raw_transaction)
    
    print(f"交易哈希: {tx_hash.hex()}")
    
    # 等待确认
    receipt = w3.eth.wait_for_transaction_receipt(tx_hash)
    
    if receipt.status == 1:
        print(f"合约部署成功!")
        print(f"合约地址: {receipt.contractAddress}")
        
        # 保存部署信息
        deployment_info = {
            "network": network,
            "chain_id": config["chain_id"],
            "contract_address": receipt.contractAddress,
            "deployer": account.address,
            "tx_hash": tx_hash.hex(),
            "fee_collector": fee_collector,
            "timestamp": int(w3.eth.get_block(receipt.blockNumber).timestamp)
        }
        
        with open(f"../build/deployment_{network}.json", "w") as f:
            json.dump(deployment_info, f, indent=2)
        
        return receipt.contractAddress
    else:
        raise Exception("合约部署失败")

if __name__ == "__main__":
    import argparse
    
    parser = argparse.ArgumentParser(description="部署 RPSGame 合约")
    parser.add_argument("--network", default="amoy", help="网络名称")
    parser.add_argument("--private-key", required=True, help="部署者私钥")
    parser.add_argument("--fee-collector", required=True, help="手续费收取地址")
    
    args = parser.parse_args()
    
    deploy_contract(args.private_key, args.network, args.fee_collector)