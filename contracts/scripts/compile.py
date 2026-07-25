"""
ChainRPS 合约自动编译脚本

使用 py-solc-x 编译 RPSGame.sol 合约，生成 ABI 和 Bytecode。
编译产物保存到 contracts/build/chainrps.json，供后端 API 和前端部署使用。

使用方式：
    python contracts/scripts/compile.py

依赖：
    pip install py-solc-x

首次运行会自动下载 solc 0.8.20 编译器。
OpenZeppelin 合约需位于 contracts/lib/openzeppelin-contracts/ 目录。
"""
import json
import os
import sys
from pathlib import Path

# 项目根目录（compile.py 位于 contracts/scripts/）
PROJECT_ROOT = Path(__file__).resolve().parent.parent.parent
CONTRACTS_DIR = PROJECT_ROOT / "contracts"
SRC_DIR = CONTRACTS_DIR / "src"
BUILD_DIR = CONTRACTS_DIR / "build"
LIB_DIR = CONTRACTS_DIR / "lib"

# 需要编译的合约文件
TARGET_CONTRACTS = ["RPSGame.sol", "MockERC20.sol"]

# Solidity 编译器版本
SOLC_VERSION = "0.8.20"


def ensure_solc():
    """确保 solc 编译器已安装，未安装则自动下载"""
    try:
        from solcx import install_solc, get_installed_solc_versions
    except ImportError:
        print("❌ py-solc-x 未安装，请运行: pip install py-solc-x")
        sys.exit(1)

    installed = [str(v) for v in get_installed_solc_versions()]
    if SOLC_VERSION not in installed:
        print(f"⬇️  正在下载 solc {SOLC_VERSION}...")
        install_solc(SOLC_VERSION)
        print(f"✅ solc {SOLC_VERSION} 下载完成")
    else:
        print(f"✅ solc {SOLC_VERSION} 已安装")


def compile_contracts():
    """编译所有目标合约，返回 {contract_name: {abi, bytecode}} 字典"""
    from solcx import compile_standard, set_solc_version

    set_solc_version(SOLC_VERSION)

    # OpenZeppelin 库的基路径（允许 @openzeppelin/... 导入）
    # remapping: @openzeppelin/ -> contracts/lib/openzeppelin-contracts/
    # 这样 import "@openzeppelin/contracts/xxx.sol" 会映射到
    # contracts/lib/openzeppelin-contracts/contracts/xxx.sol
    oz_base = LIB_DIR / "openzeppelin-contracts"
    if not oz_base.exists():
        print(f"❌ OpenZeppelin 合约库未找到: {oz_base}")
        print("   请运行: git clone --depth 1 --branch v5.0.2 "
              "https://github.com/OpenZeppelin/openzeppelin-contracts.git "
              "contracts/lib/openzeppelin-contracts")
        sys.exit(1)

    print(f"🔨 正在编译合约: {', '.join(TARGET_CONTRACTS)}")

    # 读取所有源文件内容
    sources = {}
    for fname in TARGET_CONTRACTS:
        src_path = SRC_DIR / fname
        if not src_path.exists():
            print(f"❌ 合约源文件不存在: {src_path}")
            sys.exit(1)
        sources[str(src_path)] = {"content": src_path.read_text(encoding="utf-8")}

    # 构造 Solidity 标准 JSON input
    # 使用 viaIR + optimizer 解决 "Stack too deep" 问题（Game struct 字段较多）
    standard_input = {
        "language": "Solidity",
        "sources": sources,
        "settings": {
            "viaIR": True,
            "optimizer": {
                "enabled": True,
                "runs": 200
            },
            "outputSelection": {
                "*": {
                    "*": ["abi", "evm.bytecode.object"]
                }
            },
            "remappings": [
                "@openzeppelin/=" + str(oz_base) + "/"
            ]
        }
    }

    try:
        compiled = compile_standard(
            standard_input,
            solc_version=SOLC_VERSION,
            allow_paths=str(CONTRACTS_DIR),
        )
    except Exception as e:
        print(f"❌ 编译失败: {e}")
        sys.exit(1)

    # 检查编译错误
    errors = compiled.get("errors", [])
    has_error = False
    for err in errors:
        severity = err.get("severity", "")
        msg = err.get("formattedMessage", err.get("message", ""))
        print(f"  [{severity}] {msg}")
        if severity == "error":
            has_error = True

    if has_error:
        print("❌ 编译过程中存在错误")
        sys.exit(1)

    # 整理编译结果
    # compile_standard 返回格式：{"contracts": {"src/RPSGame.sol": {"chainrps": {"abi": [...], "evm": {"bytecode": {"object": "0x..."}}}}}}
    results = {}
    for source_path, contracts in compiled.get("contracts", {}).items():
        for contract_name, data in contracts.items():
            abi = data.get("abi", [])
            bytecode = data.get("evm", {}).get("bytecode", {}).get("object", "")
            # 确保 bytecode 带 0x 前缀（ethers.js ContractFactory 需要）
            if bytecode and not bytecode.startswith("0x"):
                bytecode = "0x" + bytecode
            results[contract_name] = {
                "abi": abi,
                "bytecode": bytecode if bytecode else None,
            }
            print(f"  ✅ {contract_name}: ABI={len(abi)} 项, "
                  f"Bytecode={'有' if bytecode else '无'}")

    return results


def save_build_artifacts(artifacts):
    """将编译产物保存到 contracts/build/ 目录"""
    BUILD_DIR.mkdir(parents=True, exist_ok=True)

    # 保存主合约（ChainRPS / chainrps）到 chainrps.json
    main_contract = artifacts.get("chainrps")
    if not main_contract:
        # 回退：取第一个合约
        main_contract = next(iter(artifacts.values()))

    main_path = BUILD_DIR / "chainrps.json"
    with open(main_path, "w", encoding="utf-8") as f:
        json.dump(main_contract, f, indent=2, ensure_ascii=False)
    print(f"💾 主合约产物已保存: {main_path}")

    # 保存所有合约到 all_contracts.json
    all_path = BUILD_DIR / "all_contracts.json"
    with open(all_path, "w", encoding="utf-8") as f:
        json.dump(artifacts, f, indent=2, ensure_ascii=False)
    print(f"💾 全部合约产物已保存: {all_path}")

    # 同时更新 abi/ChainRPS.json（保持同步）
    abi_dir = CONTRACTS_DIR / "abi"
    abi_dir.mkdir(parents=True, exist_ok=True)
    abi_path = abi_dir / "ChainRPS.json"
    with open(abi_path, "w", encoding="utf-8") as f:
        json.dump(main_contract["abi"], f, indent=2, ensure_ascii=False)
    print(f"💾 ABI 文件已更新: {abi_path}")


def main():
    print("=" * 60)
    print("ChainRPS 合约自动编译")
    print("=" * 60)

    # 步骤 1: 确保 solc 已安装
    ensure_solc()

    # 步骤 2: 编译合约
    artifacts = compile_contracts()
    if not artifacts:
        print("❌ 未生成任何编译产物")
        sys.exit(1)

    # 步骤 3: 保存编译产物
    save_build_artifacts(artifacts)

    print("=" * 60)
    print("✅ 编译完成！")
    print(f"   编译产物目录: {BUILD_DIR}")
    print("   现在可以在管理面板使用「部署新合约」功能")
    print("=" * 60)


if __name__ == "__main__":
    main()
