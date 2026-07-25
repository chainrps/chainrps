# ChainRPS 角色分工文档（最终定稿）

---

## 一、架构总览

### 1.1 核心定位
本项目采用 **「链上强信任确权 + 链下弱辅助体验」混合架构**，所有影响资金、胜负、公平性的核心逻辑 100% 链上固化，中心化后端仅承担体验优化。

### 1.2 双运行模式
| 模式 | 适用场景 | 数据流 |
|------|----------|--------|
| **模式 A（快速匹配）** | 陌生人对战、高频休闲 | 前端 ↔ 后端 ↔ 链上合约 |
| **模式 B（私密纯净）** | 好友切磋、隐私对局 | 前端 ↔ 钱包 ↔ 链上合约（无后端） |

### 1.3 三层技术架构
```
┌─────────────────────────────────────────────────────────────────┐
│                      客户端层 (Web/用户端)                      │
│  [用户角色] 钱包连接 / 出拳加密 / 对局交互 / FWUI 组件           │
│  [平台角色] 配置管理 / 数据统计 / 权限控制（二期）               │
├─────────────────────────────────────────────────────────────────┤
│                      链下服务层 (FastAPI)                       │
│  [后端开发] 匹配队列 / WebSocket推送 / 日志存储 / 链上事件同步   │
├─────────────────────────────────────────────────────────────────┤
│                      链上合约层 (Polygon)                       │
│  [链上开发] 对局逻辑 / 资金结算 / 手续费抽水 / 防仿标识          │
└─────────────────────────────────────────────────────────────────┘
```

---

## 二、后端开发角色（链下服务层）

**职责定位**：负责链下体验辅助功能，无资金/博弈权限，仅做匹配、通知、日志、数据缓存。

**信任边界**：无私钥、无交易权限、无资金操控、无结果篡改权限。

### 2.1 工作分解结构（WBS）

| 模块 | 子任务 | 交付物 | 优先级 |
|------|--------|--------|--------|
| **API 层** | 路由定义 | `rps_core/api/routes.py` | P0 |
| | 游戏业务端点 | `rps_core/api/endpoints/game.py` | P0 |
| | 用户相关端点 | `rps_core/api/endpoints/user.py` | P1 |
| **业务逻辑层** | 匹配服务（Redis队列） | `rps_core/service/matching_service.py` | P0 |
| | 游戏状态管理 | `rps_core/service/game_service.py` | P0 |
| | 合约交互封装（事件监听） | `rps_core/service/contract_service.py` | P0 |
| **数据层** | SQLite 数据库设计 | `rps_core/repository/` | P1 |
| | Pydantic 模型定义 | `rps_core/models/` | P0 |
| **实时通信** | WebSocket 服务 | `rps_core/websocket/` | P0 |
| | 心跳检测与重连 | `rps_core/websocket/heartbeat.py` | P1 |
| **配置与工具** | 环境配置管理 | `rps_core/config/` | P0 |
| | 通用工具函数 | `rps_core/utils/` | P1 |
| **部署与运维** | 服务启动入口 | `rps_core/main.py` | P0 |
| | 健康检查接口 | `/health` | P0 |
| | 链上事件同步 | 监听合约事件同步到 SQLite | P1 |
| **历史记录** | 历史记录查询接口 | 优先后端 SQLite，降级链上查询 | P1 |

### 2.2 核心接口约定

| API 端点 | 方法 | 功能 | 参数 | 返回 |
|----------|------|------|------|------|
| `/api/game/join` | POST | 加入匹配队列 | `amount`, `token` | `queue_id` |
| `/api/game/create` | POST | 创建私密对局（模式A用） | `amount`, `token` | `match_id` |
| `/api/game/{match_id}` | GET | 查询对局状态 | `match_id` | 对局详情 |
| `/api/game/{match_id}/join` | POST | 加入私密对局（模式A用） | `match_id` | 状态 |
| `/api/history` | GET | 查询历史记录 | `address`, `page`, `size` | 记录列表 |
| `/ws/game/{match_id}` | WS | 实时状态推送 | - | 事件流 |
| `/health` | GET | 健康检查 | - | 健康状态 |

### 2.3 后端 ↔ 合约 接口约定

**后端仅做链上事件监听（不发起交易）**：
| 功能 | 实现方式 |
|------|----------|
| 对局状态同步 | 监听合约事件更新本地缓存 |
| 超时提醒 | 定时查询链上状态推送通知 |
| 历史数据索引 | 同步链上事件到 SQLite |

### 2.4 数据流（模式 A）

```
前端 ──POST──> /api/game/join ──> 后端加入 Redis 队列
前端 <──WebSocket── 后端推送匹配成功
前端 ──POST──> /api/game/{id}/status ──> 查询状态
前端 <──WebSocket── 后端推送对方提交/揭晓/结果
```

---

## 三、链上开发角色（智能合约层）

**职责定位**：负责所有核心可信逻辑，资金、胜负、公平性规则硬编码。

### 3.1 工作分解结构（WBS）

| 模块 | 子任务 | 交付物 | 优先级 |
|------|--------|--------|--------|
| **核心合约** | RPSGame 主合约 | `contracts/src/RPSGame.sol` | P0 |
| | MockERC20 测试代币 | `contracts/src/MockERC20.sol` | P1 |
| **对局逻辑** | 创建/加入对局 | `createMatch()`, `joinMatch()` | P0 |
| | 哈希承诺存储 | `submitCommit()` | P0 |
| | 揭晓与校验 | `revealChoice()` | P0 |
| | 胜负判定 | `determineWinner()` | P0 |
| **资金管理** | 资金锁定/释放 | 合约内置逻辑 | P0 |
| | 自动结算 | `settleGame()` | P0 |
| | 手续费抽水（可配置） | Owner 可调整费率 | P0 |
| **安全机制** | 超时判负 | `claimTimeout()` | P0 |
| | 平局处理 | `handleDraw()` | P0 |
| | 防作弊校验 | 哈希一致性检查 | P0 |
| | 重入防护 | ReentrancyGuard | P0 |
| | 溢出检查 | SafeMath / 0.8+ 内置检查 | P0 |
| **Owner 权限** | 修改手续费率 | `setFeeRate()` | P0 |
| | 取消对局 | `cancelMatch()` | P0 |
| | 修改开发者地址 | `setDeveloperAddress()` | P1 |
| | 暂停/恢复合约 | `pause()`, `unpause()` | P1 |
| **标识与扩展** | 防仿标识 | 硬编码开发者地址/时间戳/版本号 | P0 |
| | 扩展字段预留 | 赛事/NFT/房间类型 | P1 |
| **测试与部署** | 测试网验证 | Mumbai/Amoy 测试报告 | P0 |
| | 部署脚本 | `contracts/scripts/deploy.py` | P0 |
| | 开源文档 | 合约说明文档 | P1 |

### 3.2 合约接口约定

| 函数 | 可见性 | 功能 | 参数 |
|------|--------|------|------|
| `createMatch(uint256 amount, address token)` | external | 创建对局 | 下注金额、代币地址 |
| `joinMatch(uint256 gameId)` | external | 加入对局 | 对局ID |
| `submitCommit(uint256 gameId, bytes32 commit)` | external | 提交哈希承诺 | 对局ID、哈希密文 |
| `revealChoice(uint256 gameId, uint8 choice, bytes32 salt)` | external | 揭晓出拳 | 对局ID、选择、盐值 |
| `claimTimeout(uint256 gameId)` | external | 超时索赔 | 对局ID |
| `handleDraw(uint256 gameId)` | external | 平局处理 | 对局ID |
| `getGame(uint256 gameId)` | view | 查询对局状态 | 对局ID |
| `getCommit(uint256 gameId, address player)` | view | 查询承诺 | 对局ID、玩家地址 |
| `setFeeRate(uint256 newRate)` | onlyOwner | 修改手续费率 | 新费率 |
| `cancelMatch(uint256 gameId)` | onlyOwner | 取消对局 | 对局ID |
| `setDeveloperAddress(address newAddr)` | onlyOwner | 修改开发者地址 | 新地址 |
| `pause()` | onlyOwner | 暂停合约 | - |
| `unpause()` | onlyOwner | 恢复合约 | - |

> 注：函数命名以实际合约为准，以上为逻辑接口说明。

### 3.3 合约事件监听

```text
// 监听对局创建
contract.on('GameCreated', (gameId, creator, amount, token) => { ... });

// 监听承诺提交
contract.on('CommitSubmitted', (gameId, player, commit) => { ... });

// 监听揭晓
contract.on('ChoiceRevealed', (gameId, player, choice) => { ... });

// 监听结算
contract.on('GameSettled', (gameId, winner, amount, fee) => { ... });

// 监听超时
contract.on('TimeoutClaimed', (gameId, claimer) => { ... });

// 监听平局
contract.on('DrawHandled', (gameId, ...) => { ... });

// 监听手续费率变更
contract.on('FeeRateChanged', (newRate, ...) => { ... });

// 监听对局取消
contract.on('MatchCancelled', (gameId, ...) => { ... });

// 监听合约暂停/恢复
contract.on('Paused', (...) => { ... });
contract.on('Unpaused', (...) => { ... });
```

### 3.4 核心数据结构

```solidity
struct Game {
    address player1;           // 玩家1地址
    address player2;           // 玩家2地址
    uint256 amount;            // 下注金额
    address token;             // 代币地址
    bytes32 commit1;           // 玩家1承诺
    bytes32 commit2;           // 玩家2承诺
    uint8 choice1;             // 玩家1选择(0=石头,1=剪刀,2=布)
    uint8 choice2;             // 玩家2选择
    uint256 commitDeadline;    // 提交截止时间
    uint256 revealDeadline;    // 揭晓截止时间
    GameStatus status;         // 状态(等待/提交中/揭晓中/结束)
    address winner;            // 胜者地址
    bool isDraw;               // 是否平局
}

enum GameStatus {
    Waiting,       // 等待玩家加入
    CommitPhase,   // 提交承诺阶段
    RevealPhase,   // 揭晓阶段
    Finished       // 已结束
}
```

### 3.5 哈希计算规则

**公式**：`keccak256(choice + salt + address)`

- `choice`：出拳选择（0=石头, 1=剪刀, 2=布）
- `salt`：前端本地生成的随机盐值
- `address`：玩家钱包地址
- **作用**：包含玩家地址可防止跨对局重放攻击

### 3.6 超时与平局规则

**超时判负**：
| 场景 | 处理方式 |
|------|----------|
| 提交阶段超时 | 未超时方获胜，拿回全部下注（超时方下注全给对方） |
| 揭晓阶段超时 | 未超时方获胜，拿回全部下注（超时方下注全给对方） |
| 超时方出拳方式 | 默认随机出拳，用户可设置固定出拳值 |
| 触发方式 | 由未超时方主动调用 `claimTimeout()` |

**平局处理**：
| 项目 | 说明 |
|------|------|
| 触发条件 | 双方出拳相同 |
| 资金处理 | 默认原路退回（双方各自拿回自己的下注） |
| 手续费 | 收取非平局手续费的 50% |
| 触发方式 | 由玩家调用 `handleDraw()` 触发 |

### 3.7 防仿标识

| 标识项 | 说明 | 是否可更改 |
|--------|------|------------|
| 官方开发者地址 | 部署时硬编码 | ❌ 不可更改 |
| 合约部署时间戳 | 合约部署区块时间 | ❌ 不可更改 |
| 合约版本号 | 如 v1.0.0 | ❌ 不可更改 |
| 官方域名 / 社交链接 | 网站、Twitter、Discord | ⚠️ Owner 可更新 |

---

## 四、前端开发角色（客户端层）

**职责定位**：负责用户界面与交互，支持双模式切换，实现本地密码学加密，FWUI 组件库建设。

### 4.1 前端双角色权限分离

| 角色 | 权限范围 | 功能边界 |
|------|----------|----------|
| **用户角色** | 对局交互、钱包操作、个人数据 | 连接钱包、下注、出拳、查看历史、模式切换 |
| **平台角色** | 系统配置、数据统计、权限管理 | 仅后台管理（二期），无用户资金权限 |

### 4.2 工作分解结构（WBS）

#### 4.2.1 用户角色功能（MVP 必做）

| 模块 | 子任务 | 交付物 | 优先级 |
|------|--------|--------|--------|
| **钱包集成** | 多钱包连接 | `web/static/js/wallet.js` | P0 |
| | 余额读取 | Ethers.js 调用 | P0 |
| | 交易签名 | 合约交互封装 | P0 |
| **对局交互** | 模式切换（A/B） | `web/static/js/app.js` | P0 |
| | 下注金额选择 | UI 组件 | P0 |
| | 出拳选择 | 石头/剪刀/布 | P0 |
| **密码学加密** | 随机盐生成 | `web/static/js/crypto.js` | P0 |
| | 哈希计算 | keccak256(choice + salt + address) | P0 |
| | 承诺提交 | 链上交互 | P0 |
| **状态展示** | 对局状态面板 | `web/static/html/index.html` | P0 |
| | 结果展示 | 胜负/手续费/到账 | P0 |
| | 历史记录 | 列表视图/卡片视图切换 | P1 |
| **模式 B 支持** | 后端请求拦截 | JS 禁用逻辑 | P0 |
| | matchId 输入 | 私密对局加入 | P0 |
| | 社交分享 | matchId 复制 | P1 |
| **FWUI 组件库** | 弹窗组件 | `web/FWUI/` | P0 |
| | 提示/Toast 组件 | `web/FWUI/` | P0 |
| | 按钮/输入框组件 | `web/FWUI/` | P1 |
| **主题系统** | 亮色/暗色双主题 | CSS 变量 + 切换 | P1 |
| **响应式布局** | PC 端 / 移动端自适应 | 全局样式 | P0 |

#### 4.2.2 平台角色功能（二期扩展，预留）

| 模块 | 子任务 | 交付物 | 状态 |
|------|--------|--------|------|
| **后台管理** | 仪表盘 | 统计数据展示 | 预留 |
| | 配置管理 | 手续费、超时参数 | 预留 |
| | 权限控制 | 管理员登录 | 预留 |
| **数据统计** | 对局统计 | 日活/流水/胜率 | 预留 |
| | 用户分析 | 用户画像 | 预留 |
| **运维工具** | 链上数据同步 | 日志监控 | 预留 |
| | 异常处理 | 告警通知 | 预留 |

### 4.3 前端文件结构

```
web/
├── static/
│   ├── html/
│   │   └── index.html          # 主页面
│   ├── css/
│   │   ├── style.css           # 主样式文件
│   │   └── theme.css           # 主题样式（亮色/暗色）
│   └── js/
│       ├── app.js              # 主逻辑（模式切换、状态管理）
│       ├── wallet.js           # 钱包连接（MetaMask/OKX/Trust/Coinbase）
│       ├── contract.js         # 合约交互封装
│       ├── crypto.js           # 本地加密（Commit-Reveal）
│       ├── websocket.js        # WebSocket 实时通信
│       ├── config.js           # 配置常量（RPC/合约地址/后端地址）
│       ├── ui.js               # UI 组件渲染
│       └── history.js          # 历史记录管理
├── FWUI/                       # 独立 UI 组件库
│   ├── modal.js                # 弹窗组件
│   ├── toast.js                # 提示组件
│   ├── button.js               # 按钮组件
│   ├── input.js                # 输入框组件
│   └── README.md               # 组件库文档
└── routers/                    # （如有需要）
```

### 4.4 前端配置约定

```javascript
// web/static/js/config.js
const CONFIG = {
    // 链配置
    rpcUrl: 'https://rpc-amoy.polygon.technology/',
    chainId: 80002,
    contractAddress: '0xYourContractAddress',
    
    // 后端配置（模式 A 使用，模式 B 自动禁用）
    backendUrl: 'http://localhost:8000',
    wsUrl: 'ws://localhost:8000',
    
    // 超时配置（与合约一致）
    commitTimeout: 66,    // 秒
    revealTimeout: 88,    // 秒
    
    // 支持代币
    supportedTokens: ['USDC', 'USDT'],
    
    // 模式开关
    enableModeB: true,    // 是否启用私密模式
    
    // 默认模式
    defaultMode: 'A',     // A = 快速匹配, B = 私密纯净
    
    // 主题
    defaultTheme: 'light' // light / dark
};
```

### 4.5 前端 ↔ 合约 接口约定

**核心交互流程**：
```
1. 前端调用 createMatch() / joinMatch() ──> 链上锁定资金
2. 前端本地计算哈希 ──> 调用 submitCommit() ──> 链上存储承诺
3. 双方提交后 ──> 前端调用 revealChoice() ──> 链上校验+结算
4. 前端监听合约事件 ──> 获取结果
```

**代币授权流程**：
```
1. 检查授权额度
2. 如不足，调用 approve(contractAddress, amount) 单笔授权
3. 授权成功后，创建/加入对局
```

---

## 五、跨角色接口与约定

### 5.1 前端 ↔ 后端 接口约定

**模式 A 数据流**：
```
前端 ──POST──> /api/game/join ──> 后端加入 Redis 队列
前端 <──WebSocket── 后端推送匹配成功
前端 ──GET──> /api/game/{id} ──> 查询状态
前端 <──WebSocket── 后端推送对方提交/揭晓/结果
```

**接口规范**：
| 接口 | 路径 | 方法 | 认证 |
|------|------|------|------|
| 加入匹配 | `/api/game/join` | POST | 无需 |
| 创建私密局 | `/api/game/create` | POST | 无需 |
| 查询对局 | `/api/game/{id}` | GET | 无需 |
| 加入私密局 | `/api/game/{id}/join` | POST | 无需 |
| 历史记录 | `/api/history` | GET | 钱包签名 |
| WebSocket | `/ws/game/{id}` | WS | 无需 |
| 健康检查 | `/health` | GET | 无需 |

### 5.2 前端 ↔ 合约 接口约定

见本章节 4.5 节。

### 5.3 后端 ↔ 合约 接口约定

见本章节 2.3 节。

---

## 六、开发流程与协作规范

### 6.1 开发顺序建议

```
链上开发（1-2天）──> 测试网部署 ──> 前端/后端并行开发（3-4天） ──> 联调测试（2天）
```

### 6.2 接口契约先行

1. **链上开发**：先定义合约接口 ABI，输出 `RPSGame.json`
2. **后端开发**：根据 ABI 封装合约事件监听服务
3. **前端开发**：根据 ABI 和后端 API 文档进行开发

### 6.3 版本控制规范

| 分支 | 用途 |
|------|------|
| `main` | 生产代码 |
| `develop` | 开发集成 |
| `feature/contract-*` | 合约功能 |
| `feature/backend-*` | 后端功能 |
| `feature/frontend-*` | 前端功能 |
| `feature/fwui-*` | FWUI 组件库 |

### 6.4 代码规范

| 层级 | 规范 |
|------|------|
| 合约 | Solidity 0.8.20+，NatSpec 注释，安全检查 |
| 后端 | Python 3.11+，类型注解，docstring |
| 前端 | ES6+，模块化，注释清晰 |
| FWUI | 组件独立、可复用、文档完善 |

---

## 七、安全与信任边界

### 7.1 权限矩阵

| 操作 | 链上合约 | 后端服务 | 前端 |
|------|----------|----------|------|
| 资金转移 | ✅ | ❌ | ❌（仅签名） |
| 胜负判定 | ✅ | ❌ | ❌ |
| 匹配撮合 | ❌ | ✅ | ❌ |
| 消息推送 | ❌ | ✅ | ❌ |
| 哈希加密 | ❌ | ❌ | ✅（本地） |
| 交易签名 | ❌ | ❌ | ✅（钱包） |
| 修改手续费率 | ✅（Owner） | ❌ | ❌ |
| 取消对局 | ✅（Owner） | ❌ | ❌ |

### 7.2 安全最佳实践

| 层级 | 措施 |
|------|------|
| 合约 | 代码审计、测试网验证、权限控制、重入防护、溢出检查、暂停机制 |
| 后端 | 环境变量管理、无敏感数据存储、HTTPS/WSS、速率限制、输入校验 |
| 前端 | 开源审计、模式 B 请求拦截、无静默数据上传、输入校验 |

---

**文档版本**: v1.0  
**最后更新**: 2026年7月  
**适用版本**: ChainRPS MVP Phase 1（角色分工最终版）
