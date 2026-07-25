# chainrps 合约测试指南

## 一、测试前准备

### 1.1 获取测试网 MATIC
- 访问 https://www.alchemy.com/faucets/polygon-amoy
- 或使用官方水龙头获取测试代币

### 1.2 获取测试 USDC
- 使用 MockERC20 合约自行铸造
- 或使用 Amoy 测试网已有的 USDC 合约

### 1.3 合约编译
推荐使用 Remix IDE 编译：
1. 打开 https://remix.ethereum.org
2. 导入 OpenZeppelin 依赖（@openzeppelin/contracts）
3. 编译 chainrps.sol 和 MockERC20.sol
4. 导出 ABI 和 Bytecode 到 contracts/build/ 目录

---

## 二、合约接口速查

### 2.1 核心函数

| 函数 | 功能 | 调用方 |
|------|------|--------|
| `createMatch(amount, token)` | 创建对局（平台锁定） | 任意用户 |
| `joinMatch(gameId)` | 加入对局 | 任意用户 |
| `submitCommit(gameId, commit)` | 提交哈希承诺（真正锁定） | 对局玩家 |
| `revealChoice(gameId, choice, salt)` | 揭晓出拳 | 对局玩家 |
| `claimTimeout(gameId)` | 超时触发退款 | 对局玩家 |
| `cancelMatch(gameId)` | 玩家自主撤销（仅平台锁定阶段） | 对局玩家 |
| `handleDraw(gameId)` | 平局/超时退款领取 | 对局玩家 |
| `getGame(gameId)` | 查询对局状态 | 任意 |
| `getCommit(gameId, player)` | 查询承诺哈希 | 任意 |
| `getContractBalance(token)` | 查询合约余额 | 任意 |
| `getAntiFakeInfo()` | 获取防仿标识 | 任意 |

### 2.2 Owner 函数

| 函数 | 功能 |
|------|------|
| `setFeeRate(newRate)` | 修改手续费率（基点，最高10%） |
| `setTimeouts(commit, reveal)` | 修改超时时间 |
| `emergencyWithdraw(token, to, amount)` | 紧急提取误转入资金（不动用户下注） |
| `setDeveloperAddress(newAddr)` | 修改手续费接收地址 |
| `updateOfficialInfo(website, twitter, discord)` | 更新官方信息 |
| `setTokenSupport(token, supported)` | 添加/移除支持代币（不可关闭 ETH） |
| `pause()` | 暂停合约 |
| `unpause()` | 恢复合约 |

> ⚠️ v1.1.0 移除了 Owner 的 `cancelMatch` 权限，撤销对局仅由玩家自主调用。

### 2.3 事件列表

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
| `MatchCancelled(gameId, canceller)` | 玩家自主撤销 |
| `DeveloperAddressChanged(oldAddr, newAddr)` | 开发者地址变更 |
| `OfficialInfoUpdated(website, twitter, discord)` | 官方信息更新 |
| `TokenSupportUpdated(token, supported)` | 代币支持变更 |
| `TimeoutChanged(oldCommit, newCommit, oldReveal, newReveal)` | 超时参数变更 |
| `EmergencyWithdraw(token, amount, to)` | 紧急提款 |
| `Paused(account)` | 合约暂停 |
| `Unpaused(account)` | 合约恢复 |

---

## 三、功能测试步骤

### 3.1 部署测试

**前置条件：**
- 部署者账户有足够 MATIC
- 准备两个地址：手续费接收地址、官方开发者地址

**操作：**
```bash
cd contracts/scripts
python deploy.py --contract chainrps --network amoy \
  --private-key YOUR_PRIVATE_KEY \
  --fee-collector 0xFeeCollectorAddress \
  --developer 0xOfficialDeveloperAddress
```

**验证：**
- [ ] 合约部署成功，返回合约地址
- [ ] `VERSION` 返回 "v1.1.0"
- [ ] `officialDeveloper` 返回正确的开发者地址
- [ ] `deployTimestamp` 为部署时区块时间（不可变）
- [ ] `feeCollector` 返回正确的手续费地址
- [ ] `feeRate` 返回 200（2%）
- [ ] `commitTimeout` 返回 300（5 分钟）
- [ ] `revealTimeout` 返回 300（5 分钟）
- [ ] `MIN_BET` 返回 1e15（0.001 单位）
- [ ] `MAX_FEE_RATE` 返回 1000（10% 上限）
- [ ] `owner()` 返回部署者地址

---

### 3.2 MockERC20 部署与配置

**部署测试代币：**
```bash
python deploy.py --contract MockERC20 --network amoy \
  --private-key YOUR_PRIVATE_KEY \
  --name "Test USDC" --symbol USDC --decimals 6 \
  --supply 10000000000000
```

**在 chainrps 中启用代币：**
- Owner 调用 `setTokenSupport(mockUsdcAddress, true)`

**给测试账户 mint 代币：**
- 调用 MockERC20 的 `mint(playerAddress, amount)`
- 每个测试账户至少 mint 100 USDC

---

### 3.3 创建对局测试

**操作流程：**
1. 玩家A 先调用 `approve(chainrpsAddress, betAmount)` 授权
2. 玩家A 调用 `createMatch(betAmount, tokenAddress)` 创建对局
3. 监听 `GameCreated` 事件

**预期结果：**
- [ ] 事件 `GameCreated` 正常触发，返回 gameId
- [ ] 代币从玩家A账户转入合约
- [ ] `getGame(gameId)` 返回：
  - `player1` = 玩家A地址
  - `amount` = 下注金额
  - `status` = Waiting (0)
- [ ] 代币合约余额增加对应金额

**异常测试：**
- [ ] 未授权时调用 createMatch 应 revert
- [ ] 下注金额为 0 应 revert
- [ ] 不支持的代币应 revert ("Token not supported")

---

### 3.4 加入对局测试

**操作流程：**
1. 玩家B 调用 `approve(chainrpsAddress, betAmount)` 授权
2. 玩家B 调用 `joinMatch(gameId)` 加入对局
3. 监听 `PlayerJoined` 事件

**预期结果：**
- [ ] 事件 `PlayerJoined` 正常触发
- [ ] `getGame(gameId)` 返回：
  - `player2` = 玩家B地址
  - `status` = CommitPhase (1)
  - `commitDeadline` = 当前时间 + 300 秒（5 分钟）
- [ ] 合约代币余额 = betAmount * 2

**异常测试：**
- [ ] 玩家A自己加入应 revert ("Cannot join own game")
- [ ] 非 Waiting 状态的对局无法加入
- [ ] 已满的对局无法加入

---

### 3.5 提交哈希承诺测试

**准备工作（前端计算）：**
```
choice = 1  // 1=石头, 2=布, 3=剪刀
salt = 随机 uint256
commit = keccak256(abi.encodePacked(choice, salt, playerAddress))
```

**操作流程：**
- 玩家A 调用 `submitCommit(gameId, commitHashA)`
- 玩家B 调用 `submitCommit(gameId, commitHashB)`

**预期结果：**
- [ ] 双方提交后，`CommitSubmitted` 事件各触发一次
- [ ] 双方都提交后，状态变为 RevealPhase (2)
- [ ] `revealDeadline` = 当前时间 + 300 秒（5 分钟）
- [ ] `getCommit(gameId, player)` 返回对应哈希
- [ ] 任一方提交后，资金进入"真正锁定"状态，`cancelMatch` 应 revert

**异常测试：**
- [ ] 非玩家调用应 revert
- [ ] 重复提交应 revert ("Already committed")
- [ ] 超时后提交应 revert ("Commit deadline passed")

---

### 3.6 揭晓出拳测试

**操作流程：**
- 玩家A 调用 `revealChoice(gameId, choiceA, saltA)`
- 玩家B 调用 `revealChoice(gameId, choiceB, saltB)`

**预期结果（正常胜负）：**
- [ ] `ChoiceRevealed` 事件各触发一次
- [ ] 双方揭晓后自动结算
- [ ] `GameSettled` 事件触发
- [ ] 获胜者收到奖金（总奖金 - 手续费）
- [ ] feeCollector 收到手续费

**胜负规则验证：**
- 石头(1) 胜 剪刀(3)
- 布(2) 胜 石头(1)
- 剪刀(3) 胜 布(2)

**异常测试：**
- [ ] 哈希不对应 revert ("Commit mismatch")
- [ ] choice 超出 1-3 范围应 revert
- [ ] 重复揭晓应 revert
- [ ] 超时后揭晓应 revert ("Reveal deadline passed")

---

### 3.7 平局测试

**操作流程：**
- 双方选择相同出拳
- 双方都揭晓
- 各自调用 `handleDraw(gameId)` 领取退款

**预期结果：**
- [ ] `isDraw` = true
- [ ] `status` = Finished (3)
- [ ] 玩家A调用 handleDraw 后，收到退款（**全额本金，零手续费**）
- [ ] 玩家B调用 handleDraw 后，收到退款（**全额本金，零手续费**）
- [ ] `DrawHandled` 事件在判定时触发
- [ ] `DrawRefunded` 事件在每次退款时触发
- [ ] **平局零手续费**

**异常测试：**
- [ ] 非平局调用 handleDraw 应 revert ("Not a draw")
- [ ] 重复领取应无效（第二次调用不转账）

---

### 3.8 玩家自主撤销测试

#### Waiting 状态撤销
1. 玩家A 创建对局
2. 玩家A 调用 `cancelMatch(gameId)`

**预期：**
- [ ] `MatchCancelled` 事件触发
- [ ] 玩家A 收到全额退款
- [ ] 状态变为 Cancelled (4)

#### CommitPhase 状态撤销（双方都未提交）
1. 玩家A 创建对局，玩家B 加入
2. 任一方调用 `cancelMatch(gameId)`

**预期：**
- [ ] 双方都收到全额退款
- [ ] 状态变为 Cancelled (4)

#### 真正锁定阶段撤销（应失败）
1. 任一方提交 commit 后
2. 调用 `cancelMatch(gameId)` 应 revert

---

### 3.9 超时退款测试（v1.1.0）

#### 提交阶段超时（仅一方提交）
1. 玩家A 提交承诺，玩家B 不提交
2. 等待超过 5 分钟
3. 任一玩家调用 `claimTimeout(gameId)`

**预期：**
- [ ] `TimeoutClaimed` 事件触发
- [ ] **双方全额退款**，不判超时方负
- [ ] 状态变为 Finished，isDraw=true
- [ ] 双方分别调用 `handleDraw()` 领取退款

#### 揭晓阶段超时（仅一方揭晓）
1. 双方都提交承诺
2. 玩家A 揭晓，玩家B 不揭晓
3. 等待超过 5 分钟
4. 任一玩家调用 `claimTimeout(gameId)`

**预期：**
- [ ] **双方全额退款**，不判超时方负

**异常测试：**
- [ ] 未超时调用 claimTimeout 应 revert
- [ ] Waiting 状态调用 claimTimeout 应 revert

---

### 3.10 Owner 功能测试

**修改手续费率：**
- Owner 调用 `setFeeRate(300)` → 改为 3%
- 验证 `FeeRateChanged` 事件
- 验证后续对局按新费率计算
- 超过 10% (1000基点) 应 revert

**修改超时时间：**
- Owner 调用 `setTimeouts(600, 600)` → 改为 10 分钟
- 验证 `TimeoutChanged` 事件
- 验证后续对局按新超时时间计算

**紧急提款（仅提取误转入资金）：**
- 计算当前合约锁定资金总额
- Owner 调用 `emergencyWithdraw(token, to, amount)`
- 验证：仅可提取超过锁定资金的部分
- 验证：`EmergencyWithdraw` 事件
- 验证：用户对局资金不受影响

**修改开发者地址：**
- Owner 调用 `setDeveloperAddress(newAddr)`
- 验证 `DeveloperAddressChanged` 事件
- 验证后续对局手续费转入新地址

**暂停/恢复：**
- Owner 调用 `pause()`
- 验证：创建/加入对局等操作 revert
- Owner 调用 `unpause()`
- 验证：恢复正常

**更新官方信息：**
- Owner 调用 `updateOfficialInfo(website, twitter, discord)`
- 验证 `getAntiFakeInfo()` 返回更新后的值

**代币支持管理：**
- Owner 调用 `setTokenSupport(token, true)` 添加新代币
- 验证 `TokenSupportUpdated` 事件
- 验证：尝试关闭 ETH 支持（`address(0)`）应 revert

> ⚠️ **注意**：v1.1.0 移除了 Owner 的 `cancelMatch` 权限。撤销对局仅由玩家自主调用。

---

### 3.11 防仿标识验证

**调用 `getAntiFakeInfo()` 应返回：**
- `developer` = 官方开发者地址（immutable，不可改）
- `deployTime` = 部署时间戳（immutable，不可改）
- `version` = "v1.1.0"（constant，不可改）
- `website` / `twitter` / `discord` = 官方社交链接（Owner 可改）

**前端验证逻辑：**
1. 连接到合约后，调用 `getAntiFakeInfo()`
2. 与内置的官方开发者地址、版本号对比
3. 不一致则显示仿盘警告

---

## 四、全流程测试用例矩阵

| # | 测试场景 | 操作步骤 | 预期结果 | 优先级 |
|---|----------|----------|----------|--------|
| 1 | 正常对局（玩家A胜） | 创建→加入→双方提交→双方揭晓 | A胜，收98%奖金，fee收2% | P0 |
| 2 | 正常对局（玩家B胜） | 同上，B出拳胜A | B胜 | P0 |
| 3 | 平局退款 | 双方出拳相同→双方handleDraw | 各退本金，**零手续费** | P0 |
| 4 | 提交阶段超时退款 | A提交，B不提交，超时后claimTimeout | **双方全额退款** | P0 |
| 5 | 揭晓阶段超时退款 | 双方提交，A揭晓B不揭晓，超时claimTimeout | **双方全额退款** | P0 |
| 6 | 哈希不一致作弊 | 揭晓时choice/salt与commit不匹配 | revert | P0 |
| 7 | Waiting 状态玩家撤销 | player1 创建后 cancelMatch | 全额退款 | P0 |
| 8 | CommitPhase 状态玩家撤销 | 双方都未提交 commit 时 cancelMatch | 双方全额退款 | P0 |
| 9 | 真正锁定阶段撤销 | 任一方提交 commit 后 cancelMatch | revert | P0 |
| 10 | 合约暂停 | pause后尝试创建对局 | revert | P1 |
| 11 | 修改手续费率 | setFeeRate后新对局 | 按新费率扣费 | P1 |
| 12 | 修改超时时间 | setTimeouts后新对局 | 按新超时计算 | P1 |
| 13 | 紧急提款（误转入资金） | emergencyWithdraw | 仅提取超过锁定部分 | P1 |
| 14 | 修改开发者地址 | setDeveloperAddress | 手续费转新地址 | P1 |
| 15 | 跨对局重放攻击 | 用对局A的commit提交到对局B | 因包含address，哈希不匹配 | P0 |
| 16 | 重入攻击 | 在收款回调中重入 | nonReentrant防护 | P0 |
| 17 | 最小下注校验 | amount < MIN_BET | revert | P1 |
| 18 | 关闭 ETH 支持 | setTokenSupport(address(0), false) | revert | P1 |

---

## 五、安全检查清单

- [ ] **重入防护**：所有资金相关函数使用 `nonReentrant` 修饰
- [ ] ** Checks-Effects-Interactions**：先改状态，后转账
- [ ] **权限控制**：Owner 函数有 `onlyOwner` 修饰
- [ ] **暂停机制**：核心业务函数有 `whenNotPaused` 修饰
- [ ] **溢出保护**：Solidity 0.8+ 内置溢出检查
- [ ] **零地址检查**：关键地址参数校验非零
- [ ] **哈希承诺安全**：包含玩家地址，防止跨对局重放
- [ ] **手续费上限**：feeRate 最高 10%，防止 Owner 作恶
- [ ] **事件可追溯**：所有状态变更都有事件
- [ ] **防仿标识**：开发者地址、部署时间、版本号不可篡改

---

## 六、部署后验证清单

部署到主网前必须完成：

- [ ] 测试网双人完整对局测试通过
- [ ] 平局退款测试通过（零手续费）
- [ ] 超时退款测试通过（双方全额退款）
- [ ] 玩家自主撤销测试通过
- [ ] Owner 所有权限测试通过
- [ ] 暂停/恢复功能测试通过
- [ ] 紧急提款功能测试通过（不动用户资金）
- [ ] 安全检查清单全部打勾
- [ ] 合约源码开源验证（Polygonscan）
- [ ] 防仿标识信息准确（VERSION = "v1.1.0"）
- [ ] 手续费接收地址为多签/冷钱包
- [ ] Owner 地址为多签/冷钱包