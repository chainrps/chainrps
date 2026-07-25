# ChainRPS

基于 Polygon 公链的极简去中心化双人博弈 DApp —— 链上公平猜拳游戏平台。
    
    项目名称：链上猜拳平台（ChainRPS）
    中文：剪刀石头布(剪石布)
    英文：rock-paper-scissors(RPS)


  --- sta 用户自定区 AI不允许修改

   https://faucet.polygon.technology/

  1、水龙头：https://faucet.polygon.technology/  X.COM 领取成功（GITHUB失败报404,）

  2、私有RPC,https://www.alchemy.com/ 注册新建APP,如：https://polygon-amoy.g.alchemy.com/v2/alch_4fkjOaaIJDphdtHiVl9VS


  --- end 用户自定区 AI不允许修改




## 🎮 核心功能

- **公平可信**：采用 Commit-Reveal 哈希承诺机制，双方出拳前完全保密，链上自动校验，无法作弊
- **双模式运行**：
  - **模式 A（快速匹配）**：后端撮合匹配，适合陌生人随机对战
  - **模式 B（私密纯净）**：纯链上交互，无后端依赖，适合好友切磋
- **自动结算**：智能合约自动判定胜负，奖金即时到账
- **手续费机制**：合约内置 2% 手续费，自动转入开发者地址

## 🛠️ 技术栈

| 层级 | 技术 |
|------|------|
| 前端 | HTML/CSS/JS + ethers.js + WalletConnect |
| 后端 | Python + FastAPI + Redis + SQLite |
| 合约 | Solidity 0.8.20+ |
| 网络 | Polygon（测试网：Amoy） |

## 🚀 快速开始

### 环境准备

```bash
# 安装依赖
pip install -e .

# 启动 Redis
redis-server

# 启动后端服务
python main.py
```

### 访问服务

- 前端页面：http://localhost:8000
- API 文档：http://localhost:8000/docs
- 健康检查：http://localhost:8000/health

## 📁 项目结构

```
chainrps/
├── contracts/     # 智能合约
├── rps_core/      # 后端服务
├── web/           # 前端页面
└── docs/          # 项目文档
```

## 📝 文档

- [上线测试操作指南](docs/上线测试操作指南.md)
- [架构设计文档](docs/CHAINRPS构架设计文档.md)
- [功能分解结构](docs/ChainRPS详细开发功能分解结构.md)

## 📄 许可证

MIT License