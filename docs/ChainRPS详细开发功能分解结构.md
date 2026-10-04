# ChainRPS 详细开发功能分解结构文档（最终定稿）

---

## 一、项目概述

### 1.1 项目名称
链上公平猜拳（On-Chain Fair RPS）

### 1.2 核心定位
基于 **Polygon 公链** 的极简去中心化双人博弈 DApp。采用 **哈希承诺密码学** 保证对局绝对保密、无法作弊、链上可验证。

项目采用两阶段极简开发策略：
- **第一阶段**：只做「能跑通完整商业闭环」的刚需功能，所有高级功能仅预留扩展位
- **第二阶段**：项目验证成功后，迭代商业化、生态化、高阶玩法功能

### 1.3 核心价值

| 价值点 | 说明 |
|--------|------|
| 公平可信 | 密码学加密出拳，双方开奖前完全互不可见，链上自动校验、不可篡改 |
| 极低门槛 | Polygon 极低 Gas 费，支持小额高频对战（单笔 Gas < $0.01） |
| 商业闭环完整 | 下注→匹配→加密出拳→开奖结算→开发者自动收手续费全程自动化 |
| 完全开源透明 | 合约、前端、部署文档全部公开，无后门、无中心化操控 |

### 1.4 阶段总纲

**【第一阶段：MVP 极速验证版】**
- 只开发刚需核心功能，打通技术流程 + 用户流程 + 盈利流程全链路
- 验证项目可行性，所有高级功能仅预留扩展字段与接口

**【第二阶段：长期扩展愿景版】**
- 项目跑通、数据正向、用户留存验证后，迭代商业化功能

---

## 二、市场痛点与解决方案

### 2.1 行业痛点
- 中心化游戏可后台改数据、控胜率、资金不安全
- 以太坊主网 Gas 过高，不适合小额休闲博弈
- 多数链游功能臃肿、上线慢、无法快速验证商业模式
- 开源项目易被抄袭，无长期壁垒
- 缺少「极简、透明、自动手续费盈利」的轻量化链上对战产品

### 2.2 解决方案
- **低成本公链**：Polygon 承载交易，兼容 USDC 稳定币下注
- **密码学公平**：Commit-Reveal 哈希承诺机制实现无信任公平对局
- **极速上线**：一期极致精简功能，2周内上线验证盈利模型
- **自动盈利**：合约硬编码手续费机制，7×24小时被动收益
- **壁垒构建**：全源码公开，以先发数据、用户池、社区信任构建不可复刻的壁垒

---

## 三、目标用户与钱包适配

### 3.1 目标用户
**核心用户群体：**
- Web3 钱包轻度用户
- 小额休闲博弈爱好者
- 追求链上公平透明的散户玩家

### 3.2 钱包适配
- MetaMask（市占 67%）
- OKX Web3
- Trust Wallet
- Coinbase Wallet

基于 WalletConnect 通用协议，兼容头部主流钱包。

### 3.3 稳定币适配
- USDC（海外用户首选）

---

## 四、商业模式与盈利机制

### 4.1 一期核心盈利模式（必实现）

**手续费抽水机制：**
- 合约内置手续费机制，对局结束后从胜者奖金中自动扣除
- 初始费率 2%，可由 Owner 调整
- 手续费自动转入开发者固定运维钱包地址，规则公开透明

**收益示例：**
- 双方各下注 10 USDC → 总资金池 20 USDC
- 扣除 0.4 USDC 平台服务费（按 2% 计算）
- 胜者实际到账约 9.5–9.6 USDC（扣除 Polygon 极低 Gas）

**平局手续费：**
- 平局零手续费，全额原路退回
- 双方各自拿回下注金额

**资金安全：**
- 所有用户筹码由智能合约托管
- 运营方无法触碰、无法挪用
- 合约开源审计，资金流向完全透明

### 4.2 二期扩展盈利（预留，一期不开发）

| 功能 | 说明 |
|------|------|
| 私人房间入场费 | 用户付费开设私密房间 |
| 锦标赛抽成 | 赛事模式手续费分成 |
| 权益 NFT | 免手续费、优先匹配、手续费分红 |
| 白标授权 | 技术外包、品牌授权 |
| Web3 广告合作 | 游戏内广告展示 |
| 邀请返利分成 | 二级推荐奖励 |

**核心裂变模式：房间承租分红体系**

| 方案 | 说明 | 适用人群 |
|------|------|----------|
| 周期租赁 | 月付/季付/年付，限时运营权益 | 新手推广者 |
| 永久租赁 | 一次性买断，终身经营权 | 资深社区团长 |

**承租权益：**
- 费率自主定价权（低于官方费率）
- 收益全额归属权（100% 手续费归房主）
- 独立房间品牌权（自定义名称、门槛、规则）
- 链上确权保障（权益不可篡改、不可回收）

---

## 五、技术栈总览

### 5.1 架构总览
```
用户前端网页 → 本地哈希加密（不上传原始出拳）→ 钱包签名交互
    ↓
Python 轻量匹配后端（FastAPI + Redis）
    ↓
Solidity 链上合约结算 & 抽水 → Polygon 公链
```

### 5.2 核心技术栈

| 层级 | 技术 | 说明 |
|------|------|------|
| 前端 | 原生 HTML/CSS/JS + ethers.js + WalletConnect | 无重型框架，极速上线 |
| 前端 UI | FWUI 独立组件库 | 弹窗、提示、按钮等统一组件 |
| 后端 | Python + FastAPI + Redis + SQLite | 基础匹配、房间管理、实时通知、数据缓存 |
| 合约 | Solidity 0.8.20+ | 标准 EVM 代码，兼容全部 EVM 链 |
| 密码学 | Commit-Reveal 机制 | 前端本地加密，绝对保密 |
| 网络 | Polygon 测试网 → 主网 | 测试验证后上线主网 |
| 主题 | 亮色/暗色双主题 | CSS 变量实现 |

### 5.3 项目结构

```
chainrps/
├── contracts/          # 智能合约（链上逻辑）
│   ├── src/
│   │   ├── chainrps.sol     # 主合约
│   │   └── MockERC20.sol   # 测试代币
│   ├── scripts/
│   │   └── deploy.py       # 部署脚本
│   ├── test/
│   │   └── TEST_GUIDE.md   # 测试说明
│   └── README.md
├── rps_core/           # 后端服务（链下逻辑）
│   ├── api/                # API 层
│   │   ├── routes.py           # 路由定义
│   │   └── endpoints/          # 业务端点
│   ├── service/            # 业务逻辑层
│   │   ├── game_service.py     # 游戏核心逻辑
│   │   ├── matching_service.py # 匹配服务
│   │   └── contract_service.py # 合约交互
│   ├── repository/         # 数据访问层
│   ├── models/             # Pydantic 数据模型
│   ├── config/             # 配置管理
│   ├── utils/              # 工具函数
│   ├── websocket/          # WebSocket 模块
│   └── main.py             # 服务入口
├── web/                # 前端页面（纯静态）
│   ├── static/
│   │   ├── html/           # HTML 页面
│   │   ├── css/            # 样式文件
│   │   └── js/             # JavaScript 文件
│   ├── FWUI/               # 独立 UI 组件库
│   └── routers/            # （如有需要）
├── docs/               # 文档
│   ├── CHAINRPS构架设计文档.md
│   ├── ChainRPS角色分工.md
│   └── ChainRPS详细开发功能分解结构.md（本文件）
├── .gitignore
├── pyproject.toml      # 项目配置
└── main.py             # 根目录启动入口
```

---

## 六、第一阶段：MVP 必实现功能

### 6.1 前端用户功能

| 功能 | 优先级 | 说明 |
|------|--------|------|
| 钱包连接/断开/余额读取 | P0 | 支持 USDC 余额显示，MetaMask/OKX/Trust/Coinbase |
| 下注金额输入/选择 | P0 | 自定义金额或快捷选择 |
| 快速匹配陌生对手（模式 A） | P0 | 同金额自动匹配双人对局 |
| 石头/剪刀/布选择 | P0 | 三选一操作 |
| 前端本地哈希加密 | P0 | 随机盐 + 哈希密文，公式：keccak256(choice + salt + address) |
| 双方提交后开启揭晓 | P0 | 状态同步与阶段切换 |
| 公开出拳与盐值验证 | P0 | 链上自动校验一致性 |
| 对局结果展示 | P0 | 双方出牌、胜负、手续费、到账金额 |
| 个人对局历史查询 | P1 | 列表视图/卡片视图切换，优先后端降级链上 |
| 模式 B（私密纯净模式） | P0 | 无后端纯链上对局，matchId 输入加入 |
| 亮色/暗色双主题 | P1 | CSS 变量 + 切换按钮 |
| 响应式布局 | P0 | PC 端、移动端自适应 |
| FWUI 组件库 | P0 | 弹窗、提示、按钮等统一组件 |
| 预留功能入口占位 | P2 | 私人房间、排行榜、赛事、NFT（仅占位） |

### 6.2 后端服务功能

| 功能 | 优先级 | 说明 |
|------|--------|------|
| Redis 玩家匹配队列 | P0 | 同金额自动匹配 |
| 对局生命周期管理 | P0 | 创建、加入、进行中、结束 |
| 超时处理机制 | P0 | 提交超时 5 分钟、揭晓超时 5 分钟（统一全额退款，由玩家触发） |
| WebSocket 实时推送 | P0 | 匹配成功、对方提交、开奖结果 |
| 对局日志存储 | P1 | SQLite 持久化 |
| 历史记录查询接口 | P1 | 优先后端，降级链上 |
| 链上事件监听同步 | P1 | 监听合约事件更新本地数据 |
| 健康检查接口 | P0 | `/health` |
| 预留扩展接口 | P2 | 锦标赛、风控、邀请机制（仅定义） |

### 6.3 智能合约功能

| 功能 | 优先级 | 说明 |
|------|--------|------|
| 创建/加入对局 | P0 | 双层锁定：平台锁定 + 真正锁定 |
| 玩家自主撤销 | P0 | `cancelMatch()`，仅平台锁定阶段可用 |
| 存储哈希承诺 | P0 | 双方密文上链存储，任一方提交后进入真正锁定 |
| 揭晓阶段校验 | P0 | 哈希不一致判负 |
| 胜负判定 | P0 | 标准石头剪刀布规则 |
| 自动结算 | P0 | 奖金分配 + 手续费自动划转 |
| 超时退款 | P0 | `claimTimeout()`，超时统一全额退款 |
| 平局处理 | P0 | `handleDraw()`，零手续费原路退回 |
| Owner 权限 | P0 | 改手续费率、暂停合约、紧急提款（不可撤销对局） |
| 防仿标识 | P0 | 硬编码开发者地址、上线时间戳、版本号 |
| 安全机制 | P0 | 重入防护、溢出检查、权限控制、`call` 转账 |
| 扩展字段预留 | P1 | 赛事、NFT、房间类型（mapping 占位） |

### 6.4 运维开源内容

| 内容 | 优先级 | 说明 |
|------|--------|------|
| 源码开源 | P0 | 合约+前端+后端基础逻辑 |
| 部署文档 | P0 | 测试网/主网完整指南 |
| 链上数据公开 | P0 | 无后台篡改权限 |

---

## 七、第二阶段：长期扩展愿景

### 7.1 核心功能扩展
- 私人付费房间（密码、好友对战）
- 多人锦标赛、赛季奖金池
- 胜率排行榜、完整战绩系统
- 权益 NFT 体系
- 邀请返利、二级分成
- 多链部署（BSC、Base、OP）
- 高级风控、防多开机制
- 移动端适配

### 7.2 后台管理功能
- 仪表盘：统计数据展示
- 配置管理：手续费、超时参数
- 权限控制：管理员登录
- 数据统计：日活/流水/胜率
- 用户分析：用户画像
- 运维工具：链上数据同步、日志监控
- 异常处理：告警通知

---

## 八、开发约定与规范

### 8.1 通用工程开发约束

| 约定 | 说明 |
|------|------|
| UI 组件统一 | 弹窗、提示、交互弹框统一使用 FWUI 组件库 |
| 响应式规范 | 页面支持 PC 端、移动端自适应布局，界面简洁易用、视觉协调 |
| 功能兼容性 | 新增迭代优先兼容已有功能，尽量规避破坏性变更 |
| 列表视图切换 | 列表组件支持「列表视图 / 卡片视图」切换；PC 默认列表模式，移动端默认卡片模式 |
| 样式一致性 | 滚动条、输入框、复选框等控件样式，与全局主题保持统一 |
| 开发优先级准则 | 安全 > 稳定 > 性能 > 新增功能 > 界面美化，优先排查安全风险 |
| 临时文件管理 | 开发调试产生的临时文件，任务完成后立即清理 |
| 测试文件规范 | 单元测试、调试脚本统一放置在项目 tests 目录 |
| CSS 拆分原则 | 全局样式文件体量过大时，页面可独立拆分 CSS，由全局样式入口统一引入管理 |
| 代码编辑规范 | 优先使用 IDE 原生工具/插件修改文件；禁止粗暴全局批量替换 |
| 注释规范 | 函数、类定义上方单独一行增加功能注释 |
| 主题兼容 | 系统支持亮色/暗色双主题 |
| 以良好交互为基础 | 遵守的以良好交互为基础，忽略当前项目不合适的 |

### 8.2 前端开发约定

**目录结构：**
- 前端静态资源路径：`web/static/js/`、`web/static/css/`、`web/static/html/`
- FWUI 组件库路径：`web/FWUI/`

**FWUI 组件库包含：**
- Modal 弹窗组件
- Toast 提示组件
- Button 按钮组件
- Input 输入框组件
- 其他通用交互组件

### 8.3 后端开发约定

**目录结构：**
- 后端核心目录：`rps_core/`
- 路由目录：`rps_core/api/routes.py`

### 8.4 合约开发约定

- Solidity 版本：0.8.20+
- 使用 NatSpec 格式注释
- 安全检查：重入防护、溢出检查、权限控制
- 所有影响资金的操作必须事件可追溯

---

## 九、部署指南

### 9.1 环境准备

#### 9.1.1 系统要求

| 依赖 | 版本 | 说明 |
|------|------|------|
| 操作系统 | Ubuntu 20.04+ / Windows 10+ | 推荐 Linux 用于生产环境 |
| Python | 3.11+ | 后端开发语言 |
| Node.js | 18+ | 合约编译（可选，推荐用 Remix） |
| Redis | 7+ | 匹配队列、实时状态存储 |

#### 9.1.2 快速环境搭建

**方式一：使用 uv（推荐）**

```bash
# 安装 uv 包管理器
curl -LsSf https://astral.sh/uv/install.sh | sh

# 激活虚拟环境
source .venv/bin/activate  # Linux/Mac
.venv\Scripts\activate     # Windows

# 安装项目依赖
uv pip install .
```

**方式二：使用 pip**

```bash
# 激活虚拟环境
source .venv/bin/activate  # Linux/Mac
.venv\Scripts\activate     # Windows

# 安装依赖
pip install -e .
```

**Redis 安装：**

**Ubuntu/Debian：**
```bash
sudo apt update && sudo apt install redis-server -y
sudo systemctl enable --now redis
```

**Windows：**
- 下载地址：https://github.com/tporadowski/redis/releases
- 解压后运行 `redis-server.exe`

**验证 Redis：**
```bash
redis-cli ping
# 输出: PONG
```

### 9.2 合约部署

#### 9.2.1 Polygon Amoy 测试网配置

| 参数 | 值 |
|------|------|
| RPC URL | `https://polygon-amoy-bor-rpc.publicnode.com` |
| Chain ID | `80002` |
| 区块浏览器 | `https://www.oklink.com/amoy` |
| 测试币水龙头 | https://www.alchemy.com/faucets/polygon-amoy |

#### 9.2.2 使用 Remix IDE 部署（推荐）

1. 打开 Remix IDE: https://remix.ethereum.org
2. 创建新文件 `chainrps.sol`，复制合约代码
3. 在 **Solidity Compiler** 插件中选择版本 `0.8.20+`
4. 点击 **Compile chainrps.sol**
5. 在 **Deploy & Run Transactions** 插件中：
   - **Environment**: 选择 `Injected Provider - MetaMask`
   - 确保钱包已切换到 Polygon Amoy 网络
   - **Constructor Arguments**: 输入手续费接收地址（开发者钱包）
   - 点击 **Deploy**

#### 9.2.3 部署测试代币（可选）

如果测试网缺少 USDC，部署 MockERC20：

```bash
cd contracts/scripts
python deploy.py --network amoy --private-key YOUR_PRIVATE_KEY --token-name "TestUSDC" --token-symbol "USDC"
```

#### 9.2.4 部署验证

部署成功后，记录以下信息：
- **合约地址**: chainrps 部署地址
- **交易哈希**: 可在区块浏览器验证部署

### 9.3 后端配置与启动

#### 9.3.1 配置环境变量

创建 `.env` 文件：

```env
# 服务配置
HOST=0.0.0.0
PORT=8000

# Redis 配置
REDIS_URL=redis://localhost:6379/0

# 数据库配置
DATABASE_PATH=./data/rps.db

# 合约配置
CONTRACT_ADDRESS=0xYourContractAddressHere
RPC_URL=https://polygon-amoy-bor-rpc.publicnode.com

# 超时配置（秒）
COMMIT_TIMEOUT=66    # 提交哈希超时
REVEAL_TIMEOUT=88    # 揭晓超时

# WebSocket 心跳间隔（秒）
WS_HEARTBEAT_INTERVAL=30
```

#### 9.3.2 启动后端服务

**开发模式（热重载）：**

```bash
# 方式一：根目录启动（推荐）
python main.py

# 方式二：backend 目录启动
cd backend
python main.py

# 方式三：uvicorn 直接启动
uvicorn backend.main:app --host 0.0.0.0 --port 8000 --reload
```

**生产模式：**

```bash
# 使用 uvicorn 生产模式
uvicorn backend.main:app --host 0.0.0.0 --port 8000 --workers 4

# 或使用 Gunicorn（推荐）
gunicorn backend.main:app --workers 4 --worker-class uvicorn.workers.UvicornWorker --bind 0.0.0.0:8000
```

#### 9.3.3 服务验证

| 端点 | 说明 | 访问方式 |
|------|------|----------|
| `/` | 服务首页 | http://localhost:8000/ |
| `/docs` | Swagger API 文档 | http://localhost:8000/docs |
| `/redoc` | ReDoc API 文档 | http://localhost:8000/redoc |
| `/health` | 健康检查 | http://localhost:8000/health |

**健康检查响应示例：**
```json
{
    "status": "healthy",
    "redis": true,
    "timestamp": 1699900000
}
```

### 9.4 前端配置与运行

#### 9.4.1 配置后端地址

编辑 `web/static/js/config.js`：
```javascript
const CONFIG = {
    rpcUrl: 'https://polygon-amoy-bor-rpc.publicnode.com',
    chainId: 80002,
    contractAddress: '0xYourContractAddressHere',
    backendUrl: 'http://localhost:8000',
    wsUrl: 'ws://localhost:8000',
    // ... 其他配置
};
```

#### 9.4.2 本地开发

```bash
cd web/static

# 使用 Python 简单服务器
python -m http.server 3000

# 或使用 Node.js http-server
npx http-server -p 3000
```

访问: `http://localhost:3000`

#### 9.4.3 生产部署

**静态文件部署：**
- **Nginx**: 配置静态文件服务
- **Cloudflare Pages**: 自动构建部署
- **GitHub Pages**: 静态托管
- **Vercel/Netlify**: 一键部署
- **IPFS**: 去中心化部署（模式 B 推荐）

**Nginx 配置示例：**
```nginx
server {
    listen 80;
    server_name your-domain.com;
    
    location / {
        root /path/to/web/static;
        index index.html;
        try_files $uri $uri/ /index.html;
    }
    
    location /api/ {
        proxy_pass http://localhost:8000/api/;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
    }
    
    location /ws/ {
        proxy_pass http://localhost:8000/ws/;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
    }
}
```

**模式 B 纯静态部署：**
- 前端可完全独立部署，无需后端 API
- 仅需静态资源托管（CDN/IPFS/本地文件）
- 用户直接通过链上交互进行对局

---

## 十、全链路测试流程

### 10.1 测试准备

1. **准备两个钱包**（玩家 A 和玩家 B）
2. **获取测试代币**：
   - 测试 MATIC：https://www.alchemy.com/faucets/polygon-amoy
   - 测试 USDC：通过 MockERC20 合约 mint
3. **连接钱包**：确保切换到 Polygon Amoy 网络

### 10.2 模式 A 完整对局测试

#### 阶段 1：匹配对局

**玩家 A：**
1. 连接钱包 → 查看余额
2. 选择代币（POL/USDC）
3. 输入下注金额
4. 点击「寻找对手」
5. 确认代币授权交易（首次，单笔授权）
6. 等待匹配

**玩家 B：**
1. 连接钱包 → 查看余额
2. 选择相同金额
3. 点击「寻找对手」
4. 确认代币授权交易
5. 系统自动匹配
6. 确认加入对局交易

#### 阶段 2：提交哈希承诺

双方执行相同操作：
1. 选择出拳（石头/剪刀/布）
2. 系统本地生成随机盐值
3. 计算哈希：`keccak256(choice + salt + address)`
4. 调用 `submitCommit(gameId, commitHash)`
5. 确认交易

**安全特性**：此时双方都无法得知对方出拳！

#### 阶段 3：揭晓出拳

双方提交后进入揭晓阶段：
1. 调用 `revealChoice(gameId, choice, salt)`
2. 确认交易
3. 合约自动验证哈希一致性
4. 合约判定胜负并自动结算

#### 阶段 4：查看结果

- **获胜者**：收到奖金（扣除手续费）
- **手续费**：自动转入开发者地址
- **平局**：双方可调用 `handleDraw()` 退款（零手续费，全额退回）

### 10.3 模式 B 完整对局测试

**玩家 A（创建者）：**
1. 切换到模式 B
2. 选择代币和金额
3. 点击「创建私密对局」
4. 确认授权 + 创建对局交易
5. 复制 gameId（matchId）分享给好友

**玩家 B（加入者）：**
1. 切换到模式 B
2. 输入 gameId
3. 点击「加入对局」
4. 确认授权 + 加入对局交易

后续提交、揭晓、结算流程同模式 A。

### 10.4 超时场景测试

#### 提交阶段超时（双方都未提交）
1. 双方都不提交承诺
2. 等待 5 分钟超时
3. 任一玩家调用 `claimTimeout(gameId)` → 双方全额退款

#### 提交阶段超时（仅一方提交）
1. 玩家 A 提交承诺，玩家 B 不提交
2. 等待 5 分钟超时
3. 任一玩家调用 `claimTimeout(gameId)` → **双方全额退款**（不判超时方负）

#### 揭晓阶段超时（仅一方揭晓）
1. 双方都提交承诺
2. 玩家 A 揭晓，玩家 B 不揭晓
3. 等待 5 分钟超时
4. 任一玩家调用 `claimTimeout(gameId)` → **双方全额退款**（不判超时方负）

### 10.5 平局场景测试

1. 双方都提交承诺
2. 双方都揭晓，选择相同出拳
3. 双方分别调用 `handleDraw(gameId)`
4. 验证：双方资金原路退回，**零手续费**

### 10.6 玩家自主撤销测试

1. 玩家 A 创建对局（平台锁定阶段）
2. 玩家 A 调用 `cancelMatch(gameId)` → 全额退款
3. 玩家 B 加入后双方都未提交 commit
4. 任一方调用 `cancelMatch(gameId)` → 双方全额退款
5. 任一方提交 commit 后调用 `cancelMatch(gameId)` → 应 revert（真正锁定不可撤销）

### 10.7 测试用例矩阵

| 测试场景 | 预期结果 | 验证方式 |
|----------|----------|----------|
| 钱包连接 | 成功读取余额 | 前端显示正确金额 |
| 创建对局 | 资金进入平台锁定 | 链上查询合约余额 |
| 匹配对手 | 双方进入同一对局 | WebSocket 收到匹配通知 |
| 哈希提交 | 承诺存储到合约，资金真正锁定 | 调用 `getCommit()` 验证 |
| 揭晓验证 | 哈希不一致判负 | 合约事件日志 |
| 正常结算 | 胜者收到奖金-手续费 | 钱包余额变化 |
| 超时退款（双方都未操作） | 全额退款给双方 | 合约事件日志 |
| 超时退款（仅一方操作） | 全额退款给双方 | 合约事件日志 |
| 平局处理 | 双方可零手续费退款 | 调用 `handleDraw()` |
| 平台锁定撤销 | 全额退款 | 调用 `cancelMatch()` |
| 真正锁定撤销 | 应 revert | 调用 `cancelMatch()` 失败 |
| 模式 B 切换 | 所有后端请求被禁用 | 浏览器 Network 面板 |
| 主题切换 | 亮色/暗色正常切换 | 视觉验证 |
| 响应式布局 | PC/移动端正常显示 | 不同设备验证 |
| 历史记录查询 | 正确显示对局记录 | 列表/卡片视图切换 |

---

## 十一、监控与运维

### 11.1 日志监控

```bash
# 查看后端日志（开发模式）
python main.py 2>&1 | tee -a logs/app.log

# 生产环境推荐使用 systemd
# 创建 /etc/systemd/system/chainrps.service
```

**systemd 配置示例：**
```ini
[Unit]
Description=ChainRPS Backend Service
After=network.target redis.service

[Service]
User=www-data
WorkingDirectory=/path/to/chainrps
Environment="PATH=/path/to/.venv/bin"
ExecStart=/path/to/.venv/bin/uvicorn rps_core.main:app --host 0.0.0.0 --port 8000 --workers 4
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
```

### 11.2 性能指标

| 指标 | 监控方式 | 告警阈值 |
|------|----------|----------|
| API 响应时间 | Prometheus + Grafana | > 2s |
| Redis 连接数 | redis-cli info | > 100 |
| 服务器 CPU | top/htop | > 80% |
| 服务器内存 | free -h | > 80% |

### 11.3 备份策略

```bash
# 数据库备份
sqlite3 data/rps.db ".backup 'backup/rps_backup_$(date +%Y%m%d).db'"

# Redis 备份
redis-cli SAVE
cp /var/lib/redis/dump.rdb backup/redis_backup_$(date +%Y%m%d).rdb
```

---

## 十二、常见问题排查

### Q1: 合约部署失败？

**排查步骤：**
1. 检查钱包是否有足够 MATIC 支付 Gas
2. 确认编译器版本 >= 0.8.20
3. 检查 Constructor 参数格式是否正确
4. 查看交易失败原因：https://www.oklink.com/amoy

### Q2: 代币授权失败？

**排查步骤：**
1. 确认代币余额充足
2. 检查授权金额是否足够
3. 确认授权给正确的合约地址
4. 确认是单笔授权，金额等于下注金额

### Q3: Redis 连接失败？

**排查步骤：**
```bash
# 检查 Redis 服务状态
redis-cli ping  # 应返回 PONG

# 检查端口是否开放
telnet localhost 6379

# 检查防火墙
sudo ufw status  # 确保 6379 端口开放
```

### Q4: WebSocket 连接失败？

**排查步骤：**
1. 确认后端服务正常运行
2. 检查 WebSocket URL 是否正确
3. 检查防火墙是否阻止 8000 端口
4. 浏览器控制台查看错误信息

### Q5: 前端无法连接钱包？

**排查步骤：**
1. 确认安装 MetaMask/OKX Wallet 等 Web3 钱包
2. 切换到 Polygon Amoy 网络
3. 检查浏览器是否支持 Web3
4. 刷新页面重新加载

### Q6: 对局结算异常？

**排查步骤：**
1. 查看合约事件日志
2. 检查 Gas 是否充足
3. 确认双方都已正确提交并揭晓
4. 查看后端日志定位问题

### Q7: 模式 B 下还有后端请求？

**排查步骤：**
1. 检查前端配置，确认模式 B 禁用了所有业务 API
2. 浏览器 Network 面板查看请求来源
3. 确认静态资源加载（HTML/JS/CSS）不算业务请求
4. 检查是否有遗漏的接口调用

---

## 十三、安全最佳实践

### 13.1 合约安全

| 措施 | 说明 |
|------|------|
| 代码审计 | 部署主网前进行专业安全审计 |
| 权限控制 | 限制 Owner 权限，关键操作多签 |
| 测试网验证 | 主网部署前在测试网充分测试 |
| 重入防护 | 使用 ReentrancyGuard |
| 溢出检查 | 0.8+ 内置溢出检查 |
| 暂停机制 | 紧急情况下可暂停合约 |

### 13.2 运营安全

| 措施 | 说明 |
|------|------|
| 私钥管理 | 使用硬件钱包或密钥托管服务 |
| 环境变量 | 敏感配置不硬编码，使用 .env |
| 访问控制 | 限制服务器 SSH 访问 |
| 日志审计 | 定期审查操作日志 |
| HTTPS/WSS | 生产环境强制加密传输 |

### 13.3 数据安全

| 措施 | 说明 |
|------|------|
| 数据加密 | 敏感数据传输使用 HTTPS/WSS |
| 定期备份 | 数据库和 Redis 定期备份 |
| 访问日志 | 记录关键操作日志 |

---

## 十四、升级与迁移

### 14.1 合约升级

```bash
# 1. 部署新版本合约
# 2. 迁移用户数据（如需要）
# 3. 更新前端和后端配置
# 4. 通知用户切换到新合约
```

> 一期不做代理升级，确保规则不可篡改。如需升级，部署新合约并引导用户迁移。

### 14.2 数据迁移

```bash
# 导出旧数据
sqlite3 old.db ".dump" > backup.sql

# 导入新数据库
sqlite3 new.db < backup.sql
```

### 14.3 零停机部署

```bash
# 使用蓝绿部署
1. 部署新版本到备用服务器
2. 测试通过后切换流量
3. 监控运行状态
4. 确认无误后下线旧版本
```

---

## 十五、开发上线时间规划

### 15.1 第一阶段（1–2周极速上线）

| 阶段 | 时间 | 任务 |
|------|------|------|
| 合约开发 | 2天 | 带手续费、防仿标识、Owner权限、扩展字段的 RPS 合约 |
| 测试网验证 | 3天 | 双人对局全流程测试 |
| 前端开发 | 3天 | 极简页面、多钱包适配、双模式、FWUI、双主题 |
| 后端开发 | 3天 | 匹配、超时、消息通知、事件同步 |
| FWUI 组件库 | 2天 | 基础组件开发 |
| 联调测试 | 2天 | 全链路联调验证 |
| 安全审计 | 1天 | 合约安全校验 |
| 主网部署 | 1天 | 部署 + 开源 + 文档 |

### 15.2 第二阶段：长期迭代
根据一期用户数据、流水数据、留存数据，分批迭代扩展功能。

---

## 十六、风险与应对

| 风险类型 | 风险描述 | 应对措施 |
|----------|----------|----------|
| 技术风险 | 代码漏洞、安全隐患 | 一期功能极简，代码量小；测试网完整验证后上主网 |
| 运营风险 | 仿盘竞争 | 链上先发数据构建官方壁垒，双模式产品形态 |
| 成本风险 | Gas 费用高 | Polygon 极低 Gas，用户零负担 |
| 合规风险 | 监管不确定性 | 无法币、无募资、无资金池、纯链上娱乐 |

---

## 十七、财务收益预测

### 17.1 一期收益（仅基础手续费）

| 日均对局 | 月收益（美元） |
|----------|---------------|
| 1,000 | 300–600 |
| 5,000 | 1,500–3,000 |
| 20,000 | 6,000–12,000 |

### 17.2 二期收益放大
扩展功能上线后，整体收益可放大 **5–10 倍**。

---

## 十八、项目核心优势

| 优势 | 说明 |
|------|------|
| 极速落地 | 只做闭环刚需，两周内上线验证 |
| 绝对公平 | 密码学背书、链上可验、无作弊空间 |
| 用户友好 | Polygon 极低手续费，无门槛 |
| 盈利稳定 | 合约自动抽水，被动收益 |
| 扩展性强 | 高阶功能提前预留接口 |
| 信任度高 | 全源码开源，去中心化 |
| 壁垒坚固 | 代码可复制，先发数据不可复制 |
| 双模式架构 | 兼顾大众体验与极客信任需求 |

---

## 十九、一期落地执行步骤

1. 开发固化手续费机制、防仿标识、Owner 权限、扩展预留字段的 RPS 智能合约
2. Mumbai/Amoy 测试网完成双人完整对局全流程测试
3. 开发极简多钱包适配前端页面（双模式 + FWUI + 双主题）
4. 搭建 Python 匹配、超时、消息通知后端服务
5. 建设 FWUI 独立组件库
6. 全链路联调，确认资金、加密、结算、手续费无误
7. 合约安全校验与基础审计
8. Polygon (主网)部署，开源全套源码与部署文档
9. 对外开放内测，验证真实用户流程与盈利闭环

---

## 附录 A：Polygon (主网)配置

```env
RPC_URL=https://polygon-rpc.com/
CHAIN_ID=137
CONTRACT_ADDRESS=0xMainnetContractAddress
```

## 附录 B：常用命令

```bash
# 查看 Redis 匹配队列
redis-cli LRANGE rps:match:queue 0 -1

# 查看对局状态
redis-cli GET rps:game:{gameId}

# 清理过期对局
redis-cli KEYS "rps:game:*" | xargs redis-cli DEL
```

## 附录 C：端口说明

| 端口 | 服务 | 用途 |
|------|------|------|
| 8000 | FastAPI | API 和 WebSocket |
| 6379 | Redis | 匹配队列 |
| 3000 | 前端 | 开发服务器 |

---

**文档版本**: v1.0  
**最后更新**: 2026年7月  
**适用版本**: ChainRPS MVP Phase 1
