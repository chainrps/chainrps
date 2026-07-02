# ChainRPS 部署指南

## 项目结构

```
chainrps/
├── contracts/          # 智能合约模块
│   ├── src/
│   │   ├── RPSGame.sol     # 主合约
│   │   └── MockERC20.sol   # 测试代币合约
│   ├── scripts/
│   │   └── deploy.py       # 部署脚本
│   └── test/
│       └── TEST_GUIDE.md   # 测试说明
├── backend/            # 后端服务模块
│   ├── app/
│   │   ├── main.py         # 入口文件
│   │   ├── config.py       # 配置
│   │   ├── models.py       # 数据模型
│   │   ├── database.py     # SQLite 数据库
│   │   ├── redis_client.py # Redis 连接
│   │   ├── game_manager.py # 游戏逻辑
│   │   ├── matching.py     # 匹配队列
│   │   ├── websocket.py    # WebSocket 处理
│   │   └── api/routes.py   # API 路由
│   └── requirements.txt
├── frontend/           # 前端页面模块
│   ├── index.html          # 主页面
│   ├── css/style.css       # 样式
│   └── js/
│       ├── app.js          # 主逻辑
│       ├── wallet.js       # 钱包连接
│       ├── contract.js     # 合约交互
│       ├── crypto.js       # 哈希加密
│       ├── websocket.js    # WebSocket
│       └── i18n.js         # 多语言
└── docs/
    ├── 2026年7月需求.md    # 需求文档
    └── DEPLOYMENT_GUIDE.md # 部署指南（本文件）
```

## 一、环境准备

### 1.1 系统要求

- Ubuntu 20.04+ 或 Windows 10+
- Python 3.11+
- Node.js 18+（用于合约编译）
- Redis 7+

### 1.2 安装依赖

#### 后端依赖

```bash
cd backend
pip install -r requirements.txt
```

#### Redis 安装（Ubuntu）

```bash
sudo apt update
sudo apt install redis-server
sudo systemctl start redis
sudo systemctl enable redis
```

#### 合约编译工具

推荐使用 Remix IDE 进行编译，或安装 solcjs：

```bash
npm install -g solc
```

## 二、合约部署

### 2.1 Polygon Amoy 测试网配置

**网络信息：**
- RPC URL: `https://rpc-amoy.polygon.technology/`
- Chain ID: `80002`
- 区块浏览器: `https://www.oklink.com/amoy`

**获取测试 MATIC：**
1. 访问 https://www.alchemy.com/faucets/polygon-amoy
2. 输入钱包地址
3. 领取测试 MATIC

### 2.2 使用 Remix IDE 部署

1. 打开 Remix IDE: https://remix.ethereum.org
2. 创建新文件 `RPSGame.sol`
3. 复制合约代码到文件
4. 在 Settings 插件中选择编译器版本 `0.8.20+`
5. 编译合约
6. 在 Deploy & Run Transactions 插件中：
   - Environment: `Injected Provider - MetaMask`
   - 选择 Polygon Amoy 网络
   - Constructor 参数: 输入手续费收取地址
   - 点击 Deploy

### 2.3 部署测试代币（可选）

如果 Amoy 测试网没有可用的 USDC/USDT，可部署 MockERC20：

```bash
# 使用 Python 脚本部署
python contracts/scripts/deploy.py --network amoy --private-key YOUR_KEY --fee-collector YOUR_ADDRESS
```

### 2.4 配置代币地址

部署后，记录合约地址并更新以下配置：

1. 更新合约地址（前端）:
   - 编辑 [frontend/js/contract.js](file:///d:/git/github/chainrps/chainrps/frontend/js/contract.js)
   - 设置 `contractManager.contractAddress`

2. 更新代币地址（前端）:
   - 编辑 [frontend/js/wallet.js](file:///d:/git/github/chainrps/chainrps/frontend/js/wallet.js)
   - 更新 `tokenAddresses.USDC` 和 `tokenAddresses.USDT`

3. 更新代币地址（合约）:
   - 部署合约后，调用 `configureToken()` 函数配置真实代币地址

## 三、后端部署

### 3.1 配置环境变量

创建 `backend/.env` 文件：

```env
# 服务配置
HOST=0.0.0.0
PORT=8000

# Redis
REDIS_URL=redis://localhost:6379/0

# 数据库
DATABASE_PATH=./data/rps.db

# 合约
CONTRACT_ADDRESS=0x... # 部署后的合约地址
RPC_URL=https://rpc-amoy.polygon.technology/

# 钱包（用于自动超时判负，可选）
OPERATOR_PRIVATE_KEY= # 可选，不配置则由用户触发超时
```

### 3.2 启动后端服务

```bash
cd backend

# 创建数据目录
mkdir -p data

# 启动服务
python -m app.main
```

或使用 uvicorn：

```bash
uvicorn app.main:app --host 0.0.0.0 --port 8000
```

### 3.3 验证服务

访问以下地址验证服务状态：

- API 文档: `http://localhost:8000/docs`
- 健康检查: `http://localhost:8000/health`

## 四、前端部署

### 4.1 本地开发

直接打开 `frontend/index.html` 文件，或使用简单 HTTP 服务器：

```bash
cd frontend
python -m http.server 3000
```

访问: `http://localhost:3000`

### 4.2 配置后端地址

编辑 [frontend/js/websocket.js](file:///d:/git/github/chainrps/chainrps/frontend/js/websocket.js)：

```javascript
wsManager.setServerUrl('ws://localhost:8000/api/ws/');
```

### 4.3 生产部署

将 `frontend/` 目录部署到任意静态文件服务器：

- Nginx
- Apache
- Cloudflare Pages
- GitHub Pages

## 五、全链路测试

### 5.1 测试准备

1. 准备两个钱包地址（玩家 A 和玩家 B）
2. 确保两个钱包都有足够的测试 MATIC 和测试 USDC/USDT
3. 授权代币给合约

### 5.2 测试步骤

#### 步骤 1: 钱包连接

- 玩家 A: 连接钱包，查看余额
- 玩家 B: 连接钱包，查看余额

#### 步骤 2: 创建对局

- 玩家 A:
  1. 选择代币（USDC 或 USDT）
  2. 输入下注金额（如 10）
  3. 点击 "Find Opponent"
  4. 确认代币授权交易
  5. 确认创建对局交易
  6. 记录 Game ID

#### 步骤 3: 加入对局

- 玩家 B:
  1. 通过后端 API 或合约查询等待中的对局
  2. 调用 `joinGame(gameId)`
  3. 确认代币授权交易
  4. 确认加入对局交易

#### 步骤 4: 提交哈希承诺

双方都需要：

1. 选择出拳（石头、布或剪刀）
2. 系统自动生成随机盐值
3. 计算哈希承诺: `keccak256(choice, salt, address)`
4. 调用 `submitCommit(gameId, commitHash)`
5. 确认交易

**注意：** 在揭晓前，双方都不知道对方的出拳！

#### 步骤 5: 揭晓出拳

双方都已提交后：

1. 调用 `revealChoice(gameId, choice, salt)`
2. 确认交易
3. 合约自动验证哈希一致性
4. 合约自动判定胜负并结算

#### 步骤 6: 查看结果

- 获胜者收到奖金（扣除 2% 手续费）
- 手续费自动转入配置的地址
- 平局时双方可选择退款

### 5.3 超时测试

#### 提交阶段超时

- 玩家 A 提交承诺
- 玩家 B 不提交
- 等待 66 秒后
- 玩家 A 调用 `claimTimeout(gameId)`
- 玩家 A 获胜

#### 揭晓阶段超时

- 双方都提交承诺
- 玩家 A 揭晓
- 玩家 B 不揭晓
- 等待 88 秒后
- 玩家 A 调用 `claimTimeout(gameId)`
- 玩家 A 获胜

### 5.4 平局测试

- 双方选择相同的出拳
- 对局标记为平局
- 双方调用 `handleDraw(gameId, 1)` 退款

## 六、验收标准

第一阶段完成的验收标准：

1. **测试网完整跑通一局双人对战**
   - 两个钱包连接成功
   - 创建对局成功
   - 加入对局成功
   - 双方提交承诺成功
   - 双方揭晓成功
   - 结算结果正确

2. **前端页面可用**
   - 钱包连接功能正常
   - 余额显示正确
   - 下注流程顺畅
   - 出拳操作直观
   - 结果展示清晰
   - 移动端适配正常

3. **文档齐全**
   - 部署指南完整
   - 测试说明清晰
   - API 文档可用

## 七、常见问题

### Q1: 合约部署失败？

检查：
- 是否有足够的 MATIC 支付 Gas
- 编译器版本是否正确（^0.8.20）
- Constructor 参数是否正确

### Q2: 代币授权失败？

检查：
- 代币余额是否充足
- 是否已授权给正确的合约地址
- Gas 是否充足

### Q3: Redis 连接失败？

检查：
- Redis 服务是否启动：`redis-cli ping`
- 连接 URL 是否正确
- 端口是否被占用

### Q4: WebSocket 连接失败？

检查：
- 后端服务是否运行
- WebSocket URL 是否正确
- 是否使用正确的钱包地址

### Q5: 前端无法连接钱包？

检查：
- 是否安装 MetaMask 或其他 Web3 钱包
- 是否切换到 Polygon Amoy 网络
- 浏览器是否支持 Web3

## 八、安全注意事项

1. **私钥安全**
   - 不要在代码中硬编码私钥
   - 使用环境变量存储敏感信息
   - 生产环境使用硬件钱包

2. **合约安全**
   - 部署前进行代码审查
   - 测试网充分测试后再上主网
   - 设置合理的 Owner 权限

3. **运营安全**
   - 定期检查手续费收入
   - 监控异常对局
   - 建立应急响应流程

## 九、后续优化

Phase 2 功能规划：

1. 房间承租分红体系
2. 私人房间功能
3. 锦标赛模式
4. 排行榜系统
5. NFT 权益体系
6. 多链部署（BSC、Base、OP）
7. 高级风控机制
8. 移动端原生 App