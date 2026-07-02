# ChainRPS Backend

链上公平猜拳后端服务

## 技术栈

- Python 3.11+
- FastAPI
- Redis（匹配队列）
- SQLite（持久化存储）
- WebSocket（实时推送）

## 功能模块

- FIFO 匹配队列
- 对局生命周期管理
- 超时自动判负
- WebSocket 实时通知
- 对局历史记录

## 目录结构

```
backend/
├── app/
│   ├── main.py          # 入口文件
│   ├── config.py        # 配置
│   ├── models.py        # 数据模型
│   ├── database.py      # SQLite 数据库
│   ├── redis_client.py  # Redis 连接
│   ├── game_manager.py  # 游戏逻辑
│   ├── matching.py      # 匹配队列
│   ├── websocket.py     # WebSocket 处理
│   └── api/
│       └── routes.py    # API 路由
├── requirements.txt
└── README.md
```