# ChainRPS

链上公平猜拳游戏后端服务。

## 项目架构

```
chainrps/
├── core/            # 后端核心功能模块
│   ├── main.py      # FastAPI 应用入口
│   ├── config.py    # 配置管理
│   ├── models.py    # 数据模型
│   ├── database.py  # 数据库操作
│   ├── redis_client.py  # Redis 客户端
│   ├── game_manager.py  # 游戏逻辑
│   ├── matching.py  # 匹配队列
│   ├── websocket.py # WebSocket 通信
│   ├── api/         # API 路由
│   └── README.md
├── web/             # Web 前端模块
│   ├── routers/     # Web 路由配置
│   ├── static/      # 静态资源
│   │   ├── js/      # JavaScript 文件
│   │   ├── css/     # CSS 样式
│   │   └── html/    # HTML 模板
│   └── README.md
├── docs/            # 项目文档
├── .venv/           # Python 虚拟环境
├── pyproject.toml   # 项目配置与依赖管理
└── README.md
```

## 技术栈

- Python 3.11+
- FastAPI
- Redis（匹配队列）
- SQLite（持久化存储）
- WebSocket（实时推送）

## 功能特性

- FIFO 匹配队列
- 对局生命周期管理
- 超时自动判负
- WebSocket 实时通知
- 对局历史记录

## 开发环境

```bash
# 创建虚拟环境
python -m venv .venv

# 激活虚拟环境
# Windows
.venv\Scripts\activate
# macOS/Linux
source .venv/bin/activate

# 安装依赖
pip install -e .

# 启动服务
python -m core.main
```

## 访问地址

- API: http://localhost:8000
- 文档: http://localhost:8000/docs
- WebSocket: ws://localhost:8000/ws/{player_address}