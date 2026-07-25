# ChainRPS Smart Contracts

链上公平猜拳游戏智能合约模块

## 目录结构

```
contracts/
├── src/              # 合约源码
│   ├── RPSGame.sol   # 主游戏合约
│   └── MockERC20.sol # 测试用 ERC20 代币
├── scripts/          # 部署脚本
│   └── deploy.py     # Python 部署工具
├── test/             # 测试文档
│   └── TEST_GUIDE.md # 测试指南
└── build/            # 编译输出（自动生成）
    ├── RPSGame.json
    ├── MockERC20.json
    └── deployment_*.json
```

## 技术栈

- Solidity ^0.8.20
- OpenZeppelin Contracts (Ownable, ReentrancyGuard, Pausable)
- 部署网络：Polygon Amoy 测试网 → Polygon 主网

## 核心合约

### RPSGame.sol

链上石头剪刀布游戏主合约，基于哈希承诺（Commit-Reveal）机制确保公平性。

**核心特性：**
- 🔒 **公平可信**：哈希承诺机制，出拳前完全保密
- 💰 **资金安全**：智能合约托管，自动结算，无人为干预
- ⚡ **低 Gas**：Polygon 网络，单笔交易 Gas < $0.01
- 🛡️ **防仿标识**：硬编码开发者地址、部署时间、版本号
- ⏱️ **超时机制**：提交 66s / 揭晓 88s，超时自动判负
- 🏆 **手续费**：胜者奖金扣除 2%（可由 Owner 调整，最高 10%）
- 🤝 **平局处理**：全额退款，零手续费
- 🚨 **紧急暂停**：Owner 可暂停/恢复合约

**函数接口：**

| 分类 | 函数 | 说明 |
|------|------|------|
| 对局 | `createMatch(amount, token)` | 创建对局 |
| | `joinMatch(gameId)` | 加入对局 |
| | `submitCommit(gameId, commit)` | 提交哈希承诺 |
| | `revealChoice(gameId, choice, salt)` | 揭晓出拳 |
| | `claimTimeout(gameId)` | 超时索赔 |
| | `handleDraw(gameId)` | 平局退款 |
| 查询 | `getGame(gameId)` | 查询对局详情 |
| | `getCommit(gameId, player)` | 查询承诺哈希 |
| | `getPlayerGames(player)` | 获取玩家对局列表 |
| | `getAntiFakeInfo()` | 获取防仿标识 |
| Owner | `setFeeRate(newRate)` | 修改手续费率 |
| | `cancelMatch(gameId)` | 取消对局（全额退款） |
| | `setDeveloperAddress(newAddr)` | 修改手续费接收地址 |
| | `updateOfficialInfo(...)` | 更新官方信息 |
| | `setTokenSupport(token, bool)` | 添加/移除支持代币 |
| | `setTimeouts(commit, reveal)` | 修改超时时间 |
| | `pause()` / `unpause()` | 暂停/恢复合约 |

### MockERC20.sol

测试用 ERC20 代币合约，支持 mint/burn，用于本地开发和测试网调试。

## 快速开始

### 使用 Remix 部署（推荐）

1. 打开 https://remix.ethereum.org
2. 导入 `@openzeppelin/contracts` 依赖
3. 将 `RPSGame.sol` 和 `MockERC20.sol` 复制到 Remix
4. 选择 Solidity 编译器 0.8.20+
5. 编译合约
6. 切换到 Injected Provider（MetaMask）
7. 部署 RPSGame，传入参数：
   - `_feeCollector`: 手续费接收地址
   - `_officialDeveloper`: 官方开发者地址（防仿标识）

### 使用 Python 脚本部署

```bash
# 1. 先用 Remix 编译合约，将 ABI+Bytecode 保存为 contracts/build/RPSGame.json
# 格式: {"abi": [...], "bytecode": "0x..."}

# 2. 安装依赖
pip install web3 eth-account

# 3. 部署 RPSGame
cd contracts/scripts
python deploy.py \
  --contract RPSGame \
  --network amoy \
  --private-key YOUR_PRIVATE_KEY \
  --fee-collector 0xFeeCollectorAddress \
  --developer 0xOfficialDeveloperAddress

# 4. 部署 MockERC20（测试用）
python deploy.py \
  --contract MockERC20 \
  --network amoy \
  --private-key YOUR_PRIVATE_KEY \
  --name "Test USDC" \
  --symbol USDC \
  --decimals 6 \
  --supply 10000000000000
```

## 哈希计算规则

**公式：**
```solidity
keccak256(abi.encodePacked(choice, salt, playerAddress))
```

- `choice`: 出拳选择（1=石头, 2=布, 3=剪刀）
- `salt`: 前端本地生成的随机盐值（uint256）
- `playerAddress`: 玩家钱包地址
- **作用**：包含玩家地址可防止跨对局重放攻击

**前端示例（ethers.js）：**
```javascript
const choice = 1; // 石头
const salt = ethers.BigNumber.from(ethers.utils.randomBytes(32));
const commit = ethers.utils.solidityKeccak256(
  ["uint8", "uint256", "address"],
  [choice, salt, playerAddress]
);
```

## 对局生命周期

```
Waiting          →  等待玩家加入
  │
  └─ joinMatch()
     ↓
CommitPhase      →  双方提交哈希承诺（66s 超时）
  │
  └─ 双方都提交后
     ↓
RevealPhase      →  双方揭晓出拳（88s 超时）
  │
  ├─ 有胜负 → GameSettled → 胜者获金（扣手续费）
  └─ 平局   → DrawHandled → 双方全额退款
```

## 安全机制

| 机制 | 说明 |
|------|------|
| ReentrancyGuard | 所有资金相关函数防重入 |
| Pausable | 紧急情况可暂停合约 |
| Ownable | Owner 权限管理关键参数 |
| 手续费上限 | 最高 10%，防止 Owner 作恶 |
| 零地址检查 | 关键地址参数校验 |
| 事件可追溯 | 所有状态变更都有事件 |
| 溢出检查 | Solidity 0.8+ 内置 |
| CEI 模式 | 先校验、再改状态、最后转账 |

## 防仿标识

合约内嵌不可篡改的身份信息，证明是官方原版：

| 标识 | 类型 | 是否可改 |
|------|------|----------|
| 官方开发者地址 | immutable | ❌ 不可改 |
| 部署时间戳 | immutable | ❌ 不可改 |
| 合约版本号 | constant | ❌ 不可改 |
| 官方网站 | storage | ✅ Owner 可改 |
| 官方 Twitter | storage | ✅ Owner 可改 |
| 官方 Discord | storage | ✅ Owner 可改 |

验证方法：调用 `getAntiFakeInfo()` 与官方公布的信息比对。

## 部署网络

### Polygon Amoy 测试网
- RPC: `https://rpc-amoy.polygon.technology/`
- Chain ID: `80002`
- 区块浏览器: `https://www.oklink.com/amoy`
- 水龙头: `https://www.alchemy.com/faucets/polygon-amoy`

### Polygon 主网
- RPC: `https://polygon-rpc.com`
- Chain ID: `137`
- 区块浏览器: `https://polygonscan.com`

## 更多文档

详细测试用例请参考 [TEST_GUIDE.md](./test/TEST_GUIDE.md)
