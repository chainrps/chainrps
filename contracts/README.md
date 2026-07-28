# ChainRPS Smart Contracts

链上公平猜拳游戏智能合约模块

**当前版本：v1.1.0**（2026-07-25 更新）

---

## 目录结构

```
contracts/
├── src/              # 合约源码
│   ├── ChainRPS.sol  # 主游戏合约
│   └── MockERC20.sol # 测试用 ERC20 代币
├── scripts/          # 部署脚本
│   ├── compile.py
│   ├── deploy.py
│   └── deploy_local.py
├── abi/              # ABI 文件
│   ├── ChainRPS.json
│   └── MockERC20.json
├── test/             # 测试文档
│   └── TEST_GUIDE.md
└── README.md
```

## 技术栈

- Solidity ^0.8.20
- OpenZeppelin Contracts（Ownable、ReentrancyGuard、Pausable）
- 部署网络：Polygon Amoy 测试网 → Polygon 主网 / 本地 Ganache（chainId 5208888）

---

## v1.1.0 变更摘要

| 变更项 | 旧规则 | 新规则 |
|--------|--------|--------|
| 平局手续费 | 50% 非平局手续费 | **零手续费**，原路全额退回 |
| 出拳超时时间 | 提交 66s / 揭晓 88s | **提交 5 分钟 / 揭晓 5 分钟**（可由 Owner 调整） |
| 超时判负逻辑 | 仅一方操作时，未操作方判负 | **统一全额退款**，不判超时方负 |
| 资金锁定机制 | 创建即真锁定，仅 Owner 可取消 | **平台锁定 + 真正锁定 双层机制**，用户可自主撤销 |
| 撤销权限 | Owner 可取消任意阶段对局 | **揭晓阶段后任何人（含 Owner）都不可撤销** |
| ETH 转账方式 | `transfer`（2300 gas 限制） | `call{value:}`（兼容合约钱包） |
| 最小下注 | 无 | **0.001 单位**（`MIN_BET = 1e15`） |
| MockERC20 mint | 任何人可铸 | **仅 owner 可铸** |
| `setTimeouts` 事件 | 无 | 新增 `TimeoutChanged` 事件 |
| `handleDraw` 退款追溯 | 无单独事件 | 新增 `DrawRefunded` 事件 |
| 合约余额查询 | 无 | 新增 `getContractBalance(token)` |
| 紧急提款 | 无 | 新增 `emergencyWithdraw`（仅提取误转入资金，不动用户下注） |
| 扩展字段 | 注释占位 | **mapping 占位**：`extTournamentId` / `extRoomType` / `extNftHolder` |
| `setTokenSupport` | 可关闭 ETH | **禁止关闭 ETH 支持** |

---

## 核心合约：ChainRPS.sol

链上石头剪刀布游戏主合约，基于哈希承诺（Commit-Reveal）机制确保公平性。

### 核心特性

- 🔒 **公平可信**：哈希承诺机制，出拳前完全保密
- 💰 **资金安全**：智能合约托管，自动结算，无人为干预
- ⚡ **低 Gas**：Polygon 网络，单笔交易 Gas < $0.01
- 🛡️ **防仿标识**：硬编码开发者地址、部署时间、版本号
- ⏱️ **超时机制**：提交 5 分钟 / 揭晓 5 分钟，超时统一全额退款
- 🏆 **手续费**：胜者奖金扣除 2%（可由 Owner 调整，最高 10%）
- 🤝 **平局处理**：**零手续费**，全额原路退回
- 🔁 **双层锁定**：平台锁定阶段可自主撤销，真正锁定阶段不可撤销
- 🚨 **紧急暂停**：Owner 可暂停/恢复合约

### 双层资金锁定机制（v1.1.0 核心）

为避免资金永久锁定风险，引入双层锁定机制：

| 锁定阶段 | 触发条件 | 撤销规则 |
|----------|----------|----------|
| **平台锁定（假锁定）** | `createMatch` 后 → `Waiting` 状态<br>`joinMatch` 后 → `CommitPhase` 状态（双方都未提交 commit） | 用户可随时自主撤销退款<br>Waiting：仅 player1 可撤销<br>CommitPhase（无 commit）：任一方可撤销 |
| **真正锁定** | 任一方调用 `submitCommit` 提交承诺后<br>进入 `RevealPhase` 状态 | **任何人（含 Owner）都无权撤销或全额退款**，只能按规则揭晓结算或超时退款 |

**为什么这样设计？**
- 平台锁定阶段：双方尚未"出拳"，撤销不影响公平性，资金可自由撤回；
- 真正锁定阶段：已有玩家提交哈希承诺，撤销会破坏 Commit-Reveal 公平性，必须按规则走完流程。

### 超时处理规则（v1.1.0）

| 场景 | 处理方式 |
|------|----------|
| 提交阶段超时（双方都未提交） | 全额退款给双方，不判负 |
| 提交阶段超时（仅一方提交） | **全额退款给双方**，不判超时方负 |
| 揭晓阶段超时（双方都未揭晓） | 全额退款给双方，不判负 |
| 揭晓阶段超时（仅一方揭晓） | **全额退款给双方**，不判超时方负 |
| 触发方式 | 由任一玩家调用 `claimTimeout()` 触发，等待双方调用 `handleDraw()` 领取退款 |

**设计理由**：原"仅一方操作判另一方负"的设计在实际场景中容易被恶意利用（如对手网络故障时主动判负），统一全额退款更公平、更符合休闲博弈定位。

### 平局处理规则（v1.1.0）

- 双方出拳相同 → 平局
- **零手续费**，全额原路退回
- 触发流程：双方揭晓后合约自动判定 → 玩家分别调用 `handleDraw()` 领取退款

### 函数接口

| 分类 | 函数 | 说明 |
|------|------|------|
| 对局 | `createMatch(amount, token)` | 创建对局（进入平台锁定） |
| | `joinMatch(gameId)` | 加入对局（进入提交阶段） |
| | `submitCommit(gameId, commit)` | 提交哈希承诺（任一方提交后进入真正锁定） |
| | `revealChoice(gameId, choice, salt)` | 揭晓出拳 |
| | `claimTimeout(gameId)` | 超时触发退款 |
| | `handleDraw(gameId)` | 平局/超时退款领取 |
| | `cancelMatch(gameId)` | **玩家自主撤销**（仅平台锁定阶段） |
| 查询 | `getGame(gameId)` | 查询对局详情 |
| | `getCommit(gameId, player)` | 查询承诺哈希 |
| | `getPlayerGames(player)` | 获取玩家对局列表 |
| | `getContractBalance(token)` | 查询合约余额（运维审计） |
| | `getAntiFakeInfo()` | 获取防仿标识 |
| Owner | `setFeeRate(newRate)` | 修改手续费率（最高 10%） |
| | `setDeveloperAddress(newAddr)` | 修改手续费接收地址 |
| | `updateOfficialInfo(...)` | 更新官方信息 |
| | `setTokenSupport(token, bool)` | 添加/移除支持代币（不可关闭 ETH） |
| | `setTimeouts(commit, reveal)` | 修改超时时间 |
| | `emergencyWithdraw(token, to, amount)` | 紧急提取误转入资金（不动用户下注） |
| | `pause()` / `unpause()` | 暂停/恢复合约 |

> ⚠️ **注意**：v1.1.0 移除了 Owner 的 `cancelMatch` 权限。撤销对局仅由玩家自主调用，确保资金完全由用户掌控。

### 事件列表

| 事件 | 触发时机 |
|------|----------|
| `GameCreated(gameId, creator, amount, token)` | 对局创建 |
| `PlayerJoined(gameId, player)` | 玩家加入 |
| `CommitSubmitted(gameId, player, commit)` | 提交承诺 |
| `ChoiceRevealed(gameId, player, choice)` | 揭晓出拳 |
| `GameSettled(gameId, winner, amount, fee)` | 对局结算 |
| `TimeoutClaimed(gameId, claimer, refunded)` | 超时触发退款 |
| `DrawHandled(gameId)` | 平局判定完成 |
| `DrawRefunded(gameId, player, amount)` | 平局/超时退款领取 |
| `FeeRateChanged(oldRate, newRate)` | 手续费率变更 |
| `MatchCancelled(gameId, canceller)` | 对局取消 |
| `DeveloperAddressChanged(oldAddr, newAddr)` | 开发者地址变更 |
| `OfficialInfoUpdated(website, twitter, discord)` | 官方信息更新 |
| `TokenSupportUpdated(token, supported)` | 代币支持变更 |
| `TimeoutChanged(oldCommit, newCommit, oldReveal, newReveal)` | 超时参数变更 |
| `EmergencyWithdraw(token, amount, to)` | 紧急提款 |
| `Paused(account)` / `Unpaused(account)` | 合约暂停/恢复 |

---

## 测试代币：MockERC20.sol

测试用 ERC20 代币合约，支持 mint/burn，用于本地开发和测试网调试。

**v1.1.0 安全增强：**
- `mint` 函数仅限 `owner` 调用，避免测试网被恶意增发
- `burn` 函数任意持有者可销毁自己的余额
- 新增 `transferOwnership` 转移所有权
- 新增 `Mint` / `Burn` / `OwnershipTransferred` 事件

---

## 快速开始

### 使用 Remix 部署（推荐）

1. 打开 https://remix.ethereum.org
2. 导入 `@openzeppelin/contracts` 依赖
3. 将 `ChainRPS.sol` 和 `MockERC20.sol` 复制到 Remix
4. 选择 Solidity 编译器 0.8.20+
5. 编译合约
6. 切换到 Injected Provider（MetaMask）
7. 部署 RPSGame，传入参数：
   - `_feeCollector`: 手续费接收地址
   - `_officialDeveloper`: 官方开发者地址（防仿标识）

### 使用 Python 脚本部署

```bash
# 1. 先用 Remix 编译合约，将 ABI+Bytecode 保存为 contracts/abi/ChainRPS.json
# 格式: {"abi": [...], "bytecode": "0x..."}

# 2. 安装依赖
pip install web3 eth-account

# 3. 部署 RPSGame
cd contracts/scripts
python deploy.py \
  --contract chainrps \
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
- `salt`: 前端本地生成的随机盐值（bytes32）
- `playerAddress`: 玩家钱包地址
- **作用**：包含玩家地址可防止跨对局重放攻击

**前端示例（ethers.js v6）：**
```javascript
import { ethers } from "ethers";

const choice = 1; // 石头
const salt = ethers.randomBytes(32);
const commit = ethers.solidityPackedKeccak256(
  ["uint8", "bytes32", "address"],
  [choice, salt, playerAddress]
);
```

## 对局生命周期

```
Waiting          →  等待玩家加入（平台锁定，player1 可 cancelMatch）
  │
  └─ joinMatch()
     ↓
CommitPhase      →  提交哈希承诺阶段（5 分钟超时）
  │                 （双方都未提交 commit 前可 cancelMatch）
  │
  ├─ 任一方 submitCommit() → 资金进入"真正锁定"，不可再 cancel
  │
  └─ 双方都提交后
     ↓
RevealPhase      →  揭晓出拳阶段（5 分钟超时，不可撤销）
  │
  ├─ 双方都揭晓 → _settleGame()
  │   ├─ 有胜负 → GameSettled → 胜者获金（扣 2% 手续费）
  │   └─ 平局   → DrawHandled → 双方调用 handleDraw() 零手续费退款
  │
  └─ 超时未完成 → claimTimeout() → 全额退款（双方调用 handleDraw 领取）
```

## 安全机制

| 机制 | 说明 |
|------|------|
| ReentrancyGuard | 所有资金相关函数防重入 |
| Pausable | 紧急情况可暂停合约 |
| Ownable | Owner 权限管理关键参数 |
| 手续费上限 | 最高 10%（`MAX_FEE_RATE`），防止 Owner 作恶 |
| 最小下注 | 0.001 单位（`MIN_BET`），防止低金额滥用 gas |
| 零地址检查 | 关键地址参数校验 |
| 事件可追溯 | 所有状态变更都有事件 |
| 溢出检查 | Solidity 0.8+ 内置 |
| CEI 模式 | 先校验、再改状态、最后转账 |
| `call` 转账 | 兼容多签/合约钱包，无 2300 gas 限制 |
| 双层锁定 | 平台锁定可撤销，真正锁定不可撤销 |
| 紧急提款保护 | 仅可提取误转入资金，自动计算并保护用户对局锁定资金 |
| ETH 支持锁定 | `setTokenSupport` 禁止关闭 ETH 支持 |

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

## 扩展字段预留（二期）

v1.1.0 已定义占位 mapping，便于二期平滑升级：

| 字段 | 用途 | 当前状态 |
|------|------|----------|
| `extTournamentId` | 赛事模式关联 | 仅占位，不参与逻辑 |
| `extRoomType` | 房间类型扩展 | 仅占位，不参与逻辑 |
| `extNftHolder` | NFT 权益持有 | 仅占位，不参与逻辑 |

二期可通过新合约或代理合约扩展，不影响 v1.1.0 主流程。

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

### 本地 Ganache 测试网
- RPC: `http://127.0.0.1:8686`
- Chain ID: `5208888`
- 启动参数：`ganache --wallet.deterministic --chain.chainId 5208888`

## 更多文档

- 详细测试用例请参考 [TEST_GUIDE.md](./test/TEST_GUIDE.md)
- 项目架构设计请参考 `/docs/CHAINRPS构架设计文档.md`
- 完整需求请参考 `/docs/总需求.md`

---

**文档版本**: v1.1.0
**最后更新**: 2026-07-25
**适用版本**: ChainRPS MVP Phase 1（v1.1.0 规则修订版）