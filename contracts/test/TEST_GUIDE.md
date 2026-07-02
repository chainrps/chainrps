# RPSGame 合约测试说明

## 测试前准备

1. 获取 Polygon Amoy 测试网 MATIC
   - 访问 https://www.alchemy.com/faucets/polygon-amoy
   - 或使用官方水龙头获取测试代币

2. 获取测试 USDC
   - 使用 MockERC20 合约自行铸造
   - 或使用 Amoy 测试网已有的 USDC 合约

## 功能测试步骤

### 1. 创建对局测试

**操作流程：**
- 玩家A 调用 `createGame(tokenAddress, betAmount)` 创建对局
- 确认事件 `GameCreated` 正常触发
- 确认代币从玩家A账户转入合约

**预期结果：**
- 对局状态为 `Waiting (0)`
- `player1` 为玩家A地址
- `betAmount` 为指定金额

### 2. 加入对局测试

**操作流程：**
- 玩家B 调用 `joinGame(gameId)` 加入对局
- 确认事件 `PlayerJoined` 正常触发

**预期结果：**
- 对局状态变为 `CommitPhase (2)`
- `commitDeadline` 设置为当前时间 + 66秒

### 3. 提交哈希承诺测试

**准备工作：**
- 玩家选择出拳（1=石头, 2=布, 3=剪刀）
- 玩家生成随机盐值（uint256）
- 计算哈希承诺：`keccak256(abi.encodePacked(choice, salt, playerAddress))`

**操作流程：**
- 玩家A 调用 `submitCommit(gameId, commitHash)`
- 玩家B 调用 `submitCommit(gameId, commitHash)`
- 确认双方都已提交后，状态变为 `RevealPhase`

**预期结果：**
- 对局状态变为 `RevealPhase (3)`
- `revealDeadline` 设置为当前时间 + 88秒

### 4. 揭晓出拳测试

**操作流程：**
- 玩家A 调用 `revealChoice(gameId, choice, salt)`
- 玩家B 调用 `revealChoice(gameId, choice, salt)`
- 揭晓时需与提交哈希时使用的 choice、salt 一致

**预期结果：**
- 合约验证哈希一致性
- 双方揭晓后自动结算

### 5. 结算测试

**场景A - 正常胜负：**
- 根据石头剪刀布规则判定胜负
- 获胜者收到奖金池 98%（扣除 2% 手续费）
- 手续费自动转入 `feeCollector` 地址

**场景B - 平局：**
- 对局标记为平局 `isDraw = true`
- 玩家可调用 `handleDraw(gameId, DrawAction.Refund)` 领回本金

### 6. 超时判负测试

**提交阶段超时：**
- 等待超过 66 秒
- 已提交的一方调用 `claimTimeout(gameId)`
- 未提交的一方判负

**揭晓阶段超时：**
- 等待超过 88 秒
- 已揭晓的一方调用 `claimTimeout(gameId)`
- 未揭晓的一方判负

### 7. 取消对局测试

**操作流程：**
- 在 `Waiting` 状态下，创建者调用 `cancelGame(gameId)`
- 确认代币退还给创建者

**预期结果：**
- 对局状态变为 `Cancelled (5)`
- 创建者收到全额退款

### 8. Owner 功能测试

**更新手续费比例：**
- Owner 调用 `updateFeeRate(newRate)`
- 确认 `FeeRateUpdated` 事件触发
- 新比例上限 10%（1000 基点）

**更新手续费地址：**
- Owner 调用 `updateFeeCollector(newAddress)`
- 确认后续对局手续费转入新地址

**配置代币：**
- Owner 调用 `configureToken(symbol, address, enabled)`
- 测试新代币的创建对局功能

## 安全验证

1. **重入攻击防护**
   - `createGame` 和 `joinGame` 使用 `nonReentrant`
   - 外部转账后再更新状态

2. **哈希承诺安全**
   - 哈希包含玩家地址，防止签名重放
   - 盐值在前端本地生成，不泄露

3. **权限控制**
   - Only Owner 可修改关键参数
   - 玩家只能操作自己的对局

## 部署验证

部署后需验证以下内容：

1. 合约字节码与源码匹配
2. Owner 地址正确
3. FeeCollector 地址正确
4. 默认代币配置正确
5. 超时时间设置正确（66秒/88秒）
6. 手续费比例正确（2%）