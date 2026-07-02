# ChainRPS Frontend

链上公平猜拳前端页面

## 技术栈

- 原生 HTML/CSS/JavaScript
- ethers.js v6
- WalletConnect（钱包连接）
- 响应式设计（PC + 移动端）

## 功能模块

- 多钱包连接（MetaMask、OKX Web3、Trust Wallet、Coinbase Wallet）
- USDC/USDT 余额显示
- 下注金额选择（预设 + 自由输入）
- 石头剪刀布出拳
- 哈希承诺加密（本地）
- 对局状态实时更新
- 对局历史记录
- 中英文双语

## 目录结构

```
frontend/
├── index.html           # 主页面
├── css/
│   └── style.css        # 样式
├── js/
│   ├── app.js           # 主逻辑
│   ├── wallet.js        # 钱包连接
│   ├── contract.js      # 合约交互
│   ├── crypto.js        # 哈希加密
│   └── i18n.js          # 多语言
└── assets/              # 静态资源
```