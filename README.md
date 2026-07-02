# ChainRPS

链上公平猜拳 - 基于 Polygon 的去中心化石头剪刀布 DApp

## 项目简介

ChainRPS 是一个基于 Polygon 公链的极简去中心化双人博弈 DApp。采用哈希承诺密码学保证对局绝对保密、无法作弊、链上可验证。

**核心特性：**
- 公平可信：密码学加密出拳，双方开奖前完全互不可见
- 极低门槛：Polygon 极低 Gas 费，支持小额高频对战
- 商业闭环：下注→匹配→加密出拳→开奖结算→自动收手续费
- 完全开源：合约、前端、部署文档全部公开

## 项目结构

```
chainrps/
├── contracts/          # 智能合约模块
│   └── src/
│       └── RPSGame.sol     # 主合约（Solidity ^0.8.20）
│       └── MockERC20.sol   # 测试代币合约
├── backend/            # 后端服务模块（FastAPI + Redis + SQLite）
│   └── app/
│       └── main.py         # 服务入口
│       └── matching.py     # FIFO 匹配队列
│       └── websocket.py    # 实时推送
├── frontend/           # 前端页面模块
│   └ index.html            # 主页面（响应式）
│   └ js/
│       └ app.js            # 主逻辑
│       └ wallet.js         # 钱包连接（ethers.js v6）
│       └ contract.js       # 合约交互
│       └ crypto.js         # 哈希承诺加密
│       └ i18n.js           # 中英文双语
└── docs/               # 文档
    └── 2026年7月需求.md    # 需求文档
    └── DEPLOYMENT_GUIDE.md # 部署指南
```

## 技术栈

| 模块 | 技术选型 |
|------|----------|
| 智能合约 | Solidity ^0.8.20, OpenZeppelin |
| 后端服务 | Python 3.11, FastAPI, Redis, SQLite |
| 前端 | 原生 HTML/CSS/JS, ethers.js v6 |
| 网络 | Polygon Amoy 测试网 / Polygon 主网 |
| 密码学 | keccak256 哈希承诺 |

## 快速开始

### 1. 合约部署

使用 Remix IDE 或 Python 脚本部署合约到 Polygon Amoy 测试网：

```bash
# 查看 contracts/test/TEST_GUIDE.md 了解测试步骤
```

### 2. 后端启动

```bash
cd backend
pip install -r requirements.txt
python -m app.main
```

### 3. 前端访问

```bash
cd frontend
python -m http.server 3000
# 访问 http://localhost:3000
```

## 核心流程

1. **钱包连接** - 支持 MetaMask、OKX Web3、Trust Wallet、Coinbase Wallet
2. **选择下注** - 预设金额（1/5/10/50）或自由输入，支持 USDC/USDT
3. **匹配对手** - FIFO 队列自动匹配同金额玩家
4. **提交承诺** - 本地生成盐值，计算 keccak256(choice, salt, address) 上链
5. **揭晓出拳** - 公开 choice 和 salt，合约验证哈希一致性
6. **自动结算** - 合约判定胜负，扣除 2% 手续费后发放奖金

## 收费机制

- 合约自动扣除 2% 手续费（Owner 可调整，上限 10%）
- 手续费转入配置的运维钱包地址
- 示例：双方各下注 10 USDC → 胜者收到约 19.6 USDC

## 验收标准

第一阶段完成标准：
- 测试网完整跑通一局双人对战
- 前端页面可用（响应式、中英文）
- 文档齐全

详细测试步骤请查看 [contracts/test/TEST_GUIDE.md](file:///d:/git/github/chainrps/chainrps/contracts/test/TEST_GUIDE.md)

完整部署指南请查看 [docs/DEPLOYMENT_GUIDE.md](file:///d:/git/github/chainrps/chainrps/docs/DEPLOYMENT_GUIDE.md)

## 后续规划（Phase 2）

- 房间承租分红体系
- 私人房间功能
- 锦标赛模式
- 排行榜系统
- NFT 权益体系
- 多链部署（BSC、Base、OP）
- 高级风控机制

## 开源协议

MIT License

## 联系方式

- GitHub: https://github.com/chainrps