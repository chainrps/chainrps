# Core Module

后端核心功能模块，包含游戏逻辑、数据管理、API 服务等核心实现。

## 目录结构

```
core/
├── main.py          # FastAPI 应用入口
├── config.py        # 配置管理
├── models.py        # 数据模型定义
├── database.py      # SQLite 数据库操作
├── redis_client.py  # Redis 客户端
├── game_manager.py  # 游戏逻辑管理
├── matching.py      # FIFO 匹配队列
├── websocket.py     # WebSocket 实时通信
└── api/
    └── routes.py    # API 路由定义
```

## 主要功能

- 链上公平猜拳游戏核心逻辑
- FIFO 玩家匹配队列
- 对局生命周期管理
- 超时自动判负机制
- WebSocket 实时通知推送
- 对局历史记录存储