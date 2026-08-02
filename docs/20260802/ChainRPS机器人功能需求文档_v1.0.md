# ChainRPS 机器人（Bot）功能需求文档

**版本**: v2.0（重大更新：多 Bot 集群 + 后台管理面板）
**日期**: 2026-08-02
**状态**: 需求已确认，待开发
**范围**: 仅限测试链（ChainRPS Local, Chain ID: 5208888, RPC: http://127.0.0.1:8686）
**关联文档**: ChainRPS 总需求.md / 需求文档_20260730_v0.4.md

---

## 一、需求背景与目标

### 1.1 背景

ChainRPS 是一款基于区块链的去中心化猜拳游戏 DApp，当前系统已具备完整的双人对战功能：房间创建、加入、准备、倒计时、链上提交承诺（commit）、揭晓出拳（reveal）、胜负判定与结算。

**当前痛点**：新用户首次进入测试链时，大厅中往往没有其他真实玩家在线，导致无法完整体验游戏流程，影响用户留存率和产品测试效率。

### 1.2 目标

新增一套 **机器人（Bot）陪玩系统**，仅限测试链环境使用。Bot 具备独立钱包地址，可完全模拟真实玩家的钱包交互行为，自动创建/加入房间、随机出拳、完成全流程对战，帮助新用户随时可以体验游戏。

### 1.3 核心价值

| 价值点 | 说明 |
|--------|------|
| 新用户引导 | 随时有对手陪玩，零等待体验完整游戏流程 |
| 测试效率 | 自动化测试多局游戏场景，无需人工干预 |
| 压力测试 | 多 Bot 并发验证系统承载能力 |
| 功能演示 | 产品 Demo 时可展示完整对战流程 |

---

## 二、现有功能分析

### 2.1 现有功能清单（截至 v0.4）

| 模块 | 文件 | 核心能力 | 是否可复用 |
|------|------|----------|-----------|
| 房间服务 | `rps_backend/service/room_service.py` | 创建/加入/准备/倒计时/退出房间 | ✅ 完全复用 |
| 游戏服务 | `rps_backend/service/game_service.py` | 提交承诺/揭晓出拳/结果同步 | ✅ 完全复用 |
| 匹配服务 | `rps_backend/service/matching_service.py` | 公共匹配队列/超时监控 | ✅ 部分复用 |
| 合约服务 | `rps_backend/service/contract_service.py` | 链上事件监听/结果同步 | ✅ 完全复用 |
| Relayer 服务 | `rps_backend/service/relayer_service.py` | Gasless 代提交 | ✅ 完全复用 |
| 本地链服务 | `rps_backend/service/local_chain_service.py` | Ganache 节点管理/账户管理 | ✅ 完全复用 |
| WebSocket | `rps_backend/websocket.py` | 实时消息推送 | ✅ 完全复用 |
| 数据模型 | `rps_backend/models/__init__.py` | 请求/响应模型/枚举 | ✅ 完全复用 |
| API 端点 | `rps_backend/api/endpoints/game.py` | 游戏相关 HTTP 接口 | ✅ 完全复用 |
| 前端 UI | `rps_frontend/static/js/` | 用户界面交互 | ⚠️ 需适配 |

### 2.2 现有 Mock 接口说明

当前代码中存在 **3 个调试用 Mock 接口**，但它们无法替代真实 Bot：

| 端点 | 功能 | 局限性 |
|------|------|--------|
| `POST /api/game/debug/mock-game` | 返回模拟房间数据 | 仅假数据，无真实游戏流程 |
| `GET /api/game/debug/mock-ui/{stage}` | 返回指定 UI 阶段假数据 | 纯展示，不参与游戏 |
| — | 无真实 Bot 钱包 | 无法进行链上交互 |

**结论：当前代码库不存在可复用的 Bot 功能，需从零开发。**

---

## 三、功能需求

### 3.1 功能矩阵

| # | 功能模块 | 子功能 | 优先级 | 状态 |
|---|---------|--------|--------|------|
| F-BOT-01 | Bot 钱包管理 | 钱包池（多钱包自动分配） | P0 | 待开发 |
| F-BOT-02 | Bot 钱包管理 | 自动充值（ETH + USDC） | P0 | 待开发 |
| F-BOT-03 | Bot 实例管理 | 创建 Bot 实例（指定策略/金额/钱包） | P0 | 待开发 |
| F-BOT-04 | Bot 实例管理 | 启动/停止/重启 Bot | P0 | 待开发 |
| F-BOT-05 | Bot 实例管理 | 删除 Bot（保留钱包回收至池） | P0 | 待开发 |
| F-BOT-06 | Bot 实例管理 | Bot 配置热更新（策略/金额/间隔） | P0 | 待开发 |
| F-BOT-07 | Bot 实例管理 | 多 Bot 集群管理（一键全部启停） | P1 | 待开发 |
| F-BOT-08 | Bot 房间行为 | 自动创建房间 | P0 | 待开发 |
| F-BOT-09 | Bot 房间行为 | 自动加入房间（大厅扫描） | P0 | 待开发 |
| F-BOT-10 | Bot 房间行为 | 自动准备（toggle_ready） | P0 | 待开发 |
| F-BOT-11 | Bot 游戏行为 | 5 种出拳策略（随机/激进/保守/模仿/均衡） | P0 | 待开发 |
| F-BOT-12 | Bot 游戏行为 | 自动生成 salt + 计算 commit 哈希 | P0 | 待开发 |
| F-BOT-13 | Bot 游戏行为 | 自动提交 commit（通过 Relayer） | P0 | 待开发 |
| F-BOT-14 | Bot 游戏行为 | 监听对手 commit/ reveal 事件 | P0 | 待开发 |
| F-BOT-15 | Bot 游戏行为 | 自动揭晓出拳 | P0 | 待开发 |
| F-BOT-16 | Bot 结算行为 | 等待结算结果，准备下一局 | P0 | 待开发 |
| F-BOT-17 | 后台管理面板 | Bot 实例列表（状态/策略/金额/统计） | P0 | 待开发 |
| F-BOT-18 | 后台管理面板 | 创建 Bot 对话框 | P0 | 待开发 |
| F-BOT-19 | 后台管理面板 | Bot 详情/配置面板 | P0 | 待开发 |
| F-BOT-20 | 后台管理面板 | 全局配置面板（默认值+钱包池） | P1 | 待开发 |
| F-BOT-21 | 后台管理面板 | Bot 运行日志查看器 | P1 | 待开发 |
| F-BOT-22 | 后台管理面板 | 集群统计总览（胜负/总额） | P1 | 待开发 |
| F-BOT-23 | 前端适配 | Bot 身份标识展示（大厅标签） | P1 | 待开发 |
| F-BOT-24 | 前端适配 | "与 Bot 对战"快捷入口 | P2 | 待开发 |
| F-BOT-25 | 安全 | 仅限测试链启用 | P0 | 待开发 |
| F-BOT-26 | 安全 | 操作频率限制 | P1 | 待开发 |
| F-BOT-27 | 安全 | 操作日志审计 | P1 | 待开发 |

### 3.2 Bot 行为状态机

```
                         ┌────────────────────────────────────────────────────┐
                         │                                                    │
                         ▼                                                    │
  ┌──────────┐  create room  ┌──────────────┐  join + ready  ┌──────────┐     │
  │   IDLE   │──────────────►│  ROOM_CREATED │──────────────►│  READY   │     │
  │ (空闲)   │               │  (已创建房间)  │              │ (已准备)  │     │
  └──────────┘               └──────────────┘              └─────┬────┘     │
         ▲                                                       │          │
         │                                                       │双方就绪   │
         │                                                       ▼          │
         │                                              ┌──────────────┐     │
         │                                              │  COUNTDOWN   │     │
         │                                              │  (15s 倒计时) │     │
         │                                              └──────┬───────┘     │
         │                                                     │倒计时结束  │
         │                                                     ▼            │
         │  ┌──────────────────────────────────────────────────────┐         │
         │  │                  GAME_STARTED                        │         │
         │  │                                                      │         │
         │  │  ┌──────────────┐   opponent commit   ┌────────────┐ │         │
         │  │  │ COMMIT_PHASE │──────────────────► │            │ │         │
         │  │  │ 自动commit   │                    │ 等待对手   │ │         │
         │  │  └──────────────┘                    │ commit     │ │         │
         │  │                                      └─────┬──────┘ │         │
         │  │                                            │对手提交  │         │
         │  │                                            ▼         │         │
         │  │  ┌──────────────┐   opponent reveal  ┌────────────┐ │         │
         │  │  │ REVEAL_PHASE │─────────────────► │            │ │         │
         │  │  │ 自动reveal   │                   │ 等待对手   │ │         │
         │  │  └──────────────┘                   │ reveal     │ │         │
         │  │                                      └─────┬──────┘ │         │
         │  └─────────────────────────────────────────────┼────────┘         │
         │                                                │                  │
         │                                                ▼                  │
         │                                         ┌────────────┐            │
         │                                         │   RESULT   │            │
         │                                         │  (结算)    │            │
         │                                         └──────┬─────┘            │
         │                                                │                  │
         │                                                │                  │
         └────────────────────────────────────────────────┘                  │
                     自动创建新房间 / 等待新房间（循环）
```

### 3.3 Bot 房间行为流程

```
时间线    事件                Bot 动作                              涉及服务
─────────────────────────────────────────────────────────────────────────────
T+0s   Bot 启动             初始化钱包、加载配置                    bot_service
T+1s   扫描大厅             检查是否有可加入的房间                  room_service.get_room_list()
T+2s   房间存在且 player2=None  join_room(room_id, bot_addr)        room_service
T+3s   加入成功             toggle_ready(room_id, bot_addr)         room_service
T+4s   准备完成             等待对手                              —
T+5s   大厅无房间           create_room(token, bet)               room_service
T+6s   创建成功             等待其他玩家加入                       —
T+7s   其他玩家加入         toggle_ready(room_id, bot_addr)         room_service
T+22s  倒计时结束           game_started 通知触发                  —
```

### 3.4 Bot 游戏行为流程

```
时间线    事件                         Bot 动作                              涉及服务
─────────────────────────────────────────────────────────────────────────────────────
T+0s   game_started 通知               生成随机 choice (1-3)                  secrets.randbelow
T+0s   —                               生成随机 salt (32 bytes)               secrets.token_hex(32)
T+0s   —                               计算 commit = keccak256(choice+salt+addr)  _verify_commit 逻辑
T+1s   —                               提交 commit_hash 到后端                game_service.submit_commit
T+1s   —                               通过 Relayer 代上链                   relayer_service
T+2s   opponent_commit 通知            等待双方提交完成                       —
T+3s   reveal_start 通知                等待对手先 reveal                      —
T+Xs   opponent_reveal 通知             自动 reveal (choice, salt)             game_service.reveal_choice
T+Xs   —                               通过 Relayer 代上链                   relayer_service
T+Ys   game_result 通知                记录结果，进入下一局循环                —
```

---

## 四、技术架构设计

### 4.1 系统架构图

```
┌───────────────────────────────────────────────────────────────────────┐
│                        ChainRPS 系统架构（含 Bot）                       │
├───────────────────────────────────────────────────────────────────────┤
│                                                                       │
│  ┌───────────────┐     WebSocket      ┌───────────────────────────┐   │
│  │   前端 UI      │◄──────────────────►│    后端 API (FastAPI)      │   │
│  │  (rps_frontend)│    HTTP / WS       │    (rps_backend/main.py)   │   │
│  └───────────────┘                    └─────────────┬─────────────┘   │
│                                                     │                  │
│                              ┌──────────────────────┼────────────┐   │
│                              │                      │            │   │
│                              ▼                      ▼            ▼   │
│                     ┌──────────────┐        ┌────────────┐  ┌─────┐  │
│                     │  BotService  │        │ RoomMgr    │  │Game │  │
│                     │  (新增模块)  │        │ (现有)     │  │Mgr  │  │
│                     └──────┬───────┘        └─────┬──────┘  └──┬──┘  │
│                            │                      │            │     │
│                            │        ┌─────────────┼────────────┘     │
│                            │        │             │                  │
│                            ▼        ▼             ▼                  │
│                     ┌────────────────────────────────────┐          │
│                     │         共享基础设施层              │          │
│                     │  ┌──────────┐ ┌──────────────┐    │          │
│                     │  │  Redis    │ │  SQLite DB  │    │          │
│                     │  └──────────┘ └──────────────┘    │          │
│                     │  ┌──────────┐ ┌──────────────┐    │          │
│                     │  │WebSocket │ │  Relayer    │    │          │
│                     │  │ Manager  │ │  Service    │    │          │
│                     │  └──────────┘ └──────────────┘    │          │
│                     └────────────────────────────────────┘          │
│                                           │                         │
│                                           ▼                         │
│  ┌─────────────────────────────────────────────────────────────┐   │
│  │                  Ganache 测试链 (127.0.0.1:8686)           │   │
│  │                  Chain ID: 5208888                          │   │
│  │                                                             │   │
│  │  Account[0]  - 合约部署者 / 管理员                          │   │
│  │  Account[1]  - Relayer 服务                                │   │
│  │  ...                                                        │   │
│  │  Account[9]  - Bot 钱包 ★ (新增，预存 ETH + USDC)          │   │
│  │                                                             │   │
│  │  合约: ChainRPS (地址: CONTRACT_ADDRESS)                    │   │
│  │  代币: USDC (Mock ERC20)                                    │   │
│  └─────────────────────────────────────────────────────────────┘   │
│                                                                       │
└───────────────────────────────────────────────────────────────────────┘
```

### 4.2 新增文件清单

| 文件路径 | 说明 | 职责 |
|---------|------|------|
| `rps_backend/service/bot_service.py` | Bot 核心服务 | BotInstance 类、行为状态机、游戏流程自动化 |
| `rps_backend/service/bot_manager.py` | Bot 集群管理器 | 多实例管理（CRUD、启停、路由分发） |
| `rps_backend/service/wallet_pool_manager.py` | 钱包池管理 | 钱包自动分配/回收/充值 |
| `rps_backend/api/endpoints/bot.py` | Bot API 路由 | 集群 CRUD、实例管理、统计、日志接口 |
| `rps_backend/models/bot.py` | Bot 数据模型 | Pydantic 请求/响应模型、SQLAlchemy 模型 |
| `rps_frontend/static/html/admin.html` | 后台管理页面 | Bot 管理标签页、实例列表、配置面板 |
| `rps_frontend/static/js/admin_bot.js` | Bot 管理前端逻辑 | API 调用、UI 渲染、日志轮询 |

### 4.3 修改文件清单

| 文件路径 | 修改内容 | 影响范围 |
|---------|---------|---------|
| `rps_backend/config/__init__.py` | 新增 Bot + 钱包池相关配置项 | 配置读取 |
| `rps_backend/main.py` | 注册 Bot 路由、启动 Bot 集群管理 | 应用启动/生命周期 |
| `rps_backend/models/__init__.py` | 新增 Bot 集群请求/响应模型 | API 校验 |
| `rps_backend/models/bot.py` | Bot SQLAlchemy 模型（实例/日志/活跃房间） | 数据库 ORM |
| `rps_backend/websocket.py` | 新增 Bot WS 消息处理（可选） | WS 消息路由 |
| `rps_frontend/static/html/admin.html` | 新增 Bot 管理标签页 | 后台 UI |
| `rps_frontend/static/js/admin_bot.js` | Bot 管理前端逻辑 | 后台交互 |

### 4.4 核心类设计

#### 4.4.1 BotManager（bot_manager.py）—— 集群管理器

```
┌─────────────────────────────────────────────────────────────────┐
│                     BotManager （集群管理器）                     │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  类属性:                                                        │
│  ├── _bots: Dict[str, BotInstance]  # bot_id → BotInstance 映射 │
│  ├── _wallet_pool: WalletPoolManager # 钱包池管理器             │
│  ├── _config_store: BotConfigStore   # 全局配置存储              │
│  ├── _is_initialized: bool          # 初始化状态                │
│  └── _db: Database                  # 数据库连接                 │
│                                                                 │
│  核心方法:                                                      │
│  ├── init() -> None                 # 启动时从 DB 加载所有 Bot    │
│  ├── create_bot(request) -> BotInstance  # 创建新 Bot（含钱包分配）│
│  ├── get_bot(bot_id) -> BotInstance  # 获取单个 Bot              │
│  ├── list_bots() -> List[BotInstance]  # 获取所有 Bot 列表        │
│  ├── update_bot(bot_id, config) -> BotInstance # 热更新配置       │
│  ├── delete_bot(bot_id) -> bool      # 删除 Bot（钱包回池）      │
│  ├── start_bot(bot_id) -> bool       # 启动指定 Bot               │
│  ├── stop_bot(bot_id) -> bool        # 停止指定 Bot               │
│  ├── restart_bot(bot_id) -> bool     # 重启指定 Bot               │
│  ├── start_all() -> int              # 一键启动所有 Bot            │
│  ├── stop_all() -> int               # 一键停止所有 Bot            │
│  ├── get_cluster_stats() -> dict     # 集群统计数据                │
│  ├── get_logs(bot_id, level, limit)  # 查询 Bot 运行日志           │
│  └── get_global_config() -> dict     # 获取全局配置                │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

#### 4.4.2 BotInstance（bot_service.py）—— 单个 Bot 实例

```
┌─────────────────────────────────────────────────────────────────┐
│                     BotInstance （单个 Bot）                      │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  类属性:                                                        │
│  ├── bot_id: str                    # 唯一标识 "bot_001"         │
│  ├── name: str                      # 显示名称                   │
│  ├── strategy: str                  # 出拳策略                   │
│  ├── wallet_index: int              # Ganache 账户索引           │
│  ├── wallet_address: str            # 钱包地址                   │
│  ├── wallet_private_key: str        # 私钥（签名用）             │
│  ├── token: str                     # 代币类型                   │
│  ├── bet_amount: float              # 单次下注额                 │
│  ├── status: str                    # idle/running/paused/error  │
│  ├── config: BotConfig              # 行为配置                   │
│  ├── _active_rooms: Dict[int, dict] # 参与的房间                 │
│  ├── _active_games: Dict[int, dict] # 参与的对局                 │
│  ├── _scan_task: asyncio.Task       # 大厅扫描任务               │
│  ├── _game_tasks: Dict[int, Task]   # 对局游戏任务               │
│  └── _stats: BotStats               # 运行统计                   │
│                                                                 │
│  核心方法:                                                      │
│  ├── start() -> bool                # 启动 Bot 运行              │
│  ├── stop() -> bool                 # 停止 Bot 运行              │
│  ├── get_status() -> dict           # 查询运行状态               │
│  ├── update_config(config) -> dict  # 热更新配置                 │
│  │                                                                 │
│  │  房间行为:                                                    │
│  ├── _scan_lobby() -> None          # 扫描大厅，自动加入房间      │
│  ├── _create_room() -> dict         # 主动创建房间               │
│  ├── _join_room(room_id) -> bool    # 加入指定房间               │
│  ├── _ready_in_room(room_id) -> bool# 在房间内准备               │
│  │                                                                 │
│  │  游戏行为:                                                    │
│  ├── _on_game_started(game_id)      # 游戏开始回调               │
│  ├── _do_commit(game_id) -> None    # 执行 commit 流程            │
│  ├── _do_reveal(game_id) -> None    # 执行 reveal 流程            │
│  ├── _compute_commit(choice,salt,addr) # 计算 commit 哈希          │
│  ├── _generate_choice() -> int      # 按策略生成出拳 1/2/3       │
│  ├── _generate_salt() -> str        # 生成随机 32 字节 salt      │
│  └── _on_game_result(game_id)       # 结算结果回调，更新统计     │
│                                                                 │
│  日志与统计:                                                    │
│  ├── _log(level, message, details)  # 写入运行日志               │
│  └── _update_stats(result)         # 更新胜负统计               │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

#### 4.4.3 WalletPoolManager（wallet_pool_manager.py）—— 钱包池

```
┌─────────────────────────────────────────────────────────────────┐
│                   WalletPoolManager （钱包池）                    │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  类属性:                                                        │
│  ├── _start_index: int = 9          # 钱包池起始索引            │
│  ├── _end_index: int = 19           # 钱包池结束索引            │
│  ├── _initial_eth: float = 1000     # 初始 ETH                  │
│  ├── _initial_usdc: float = 1000000 # 初始 USDC                 │
│  └── _local_chain: LocalChainService # 本地链服务              │
│                                                                 │
│  核心方法:                                                      │
│  ├── allocate() -> (int, str)        # 分配钱包（返回索引+地址）  │
│  ├── release(index: int) -> bool    # 归还钱包至池              │
│  ├── get_status() -> dict           # 钱包池状态                 │
│  ├── ensure_funds(index) -> bool    # 确保钱包有足够余额         │
│  └── _find_available_index() -> int  # 查找下一个可用索引         │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

#### 4.4.4 BotConfig（内部配置类）

```
┌─────────────────────────────────────────────────────────────────┐
│                        BotConfig                                │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  字段:                                                          │
│  ├── strategy: str = "random"        # 出拳策略                 │
│  ├── token: str = "USDC"             # 代币类型                   │
│  ├── bet_amount: float = 10.0        # 单次下注额                 │
│  ├── auto_create_room: bool = True   # 空闲时自动创建房间          │
│  ├── auto_join_room: bool = True     # 自动加入大厅房间            │
│  ├── create_interval: int = 60      # 创建房间间隔（秒）          │
│  ├── scan_interval: int = 10        # 大厅扫描间隔（秒）          │
│  ├── commit_delay: int = 3           # commit 延迟（秒，模拟人类） │
│  ├── reveal_delay: int = 2           # reveal 延迟（秒）          │
│  ├── max_concurrent_rooms: int = 3   # 最大同时房间数              │
│  └── wallet_balance_threshold: float # 钱包余额告警阈值            │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

### 4.5 配置项设计

在 `rps_backend/config/__init__.py` 中新增以下配置项：

```text
# ==================== Bot 配置（仅限测试链） ====================
BOT_ENABLED = os.getenv("BOT_ENABLED", "true").lower() == "true"
BOT_WALLET_INDEX = int(os.getenv("BOT_WALLET_INDEX", 9))
BOT_TOKEN = os.getenv("BOT_TOKEN", "USDC")
BOT_BET_AMOUNT = float(os.getenv("BOT_BET_AMOUNT", 10.0))
BOT_AUTO_CREATE_ROOM = os.getenv("BOT_AUTO_CREATE_ROOM", "true").lower() == "true"
BOT_AUTO_JOIN_ROOM = os.getenv("BOT_AUTO_JOIN_ROOM", "true").lower() == "true"
BOT_CREATE_INTERVAL = int(os.getenv("BOT_CREATE_INTERVAL", 60))
BOT_SCAN_INTERVAL = int(os.getenv("BOT_SCAN_INTERVAL", 10))
BOT_COMMIT_DELAY = int(os.getenv("BOT_COMMIT_DELAY", 3))
BOT_REVEAL_DELAY = int(os.getenv("BOT_REVEAL_DELAY", 2))
BOT_MAX_CONCURRENT_ROOMS = int(os.getenv("BOT_MAX_CONCURRENT_ROOMS", 3))
BOT_LABEL = os.getenv("BOT_LABEL", "🤖 AI陪玩")
BOT_WALLET_BALANCE_THRESHOLD = float(
    os.getenv("BOT_WALLET_BALANCE_THRESHOLD", "1.0")
)
```

### 4.6 API 端点设计

#### 4.6.1 Bot 集群管理（多实例）

| 端点 | 方法 | 说明 | 权限 |
|------|------|------|------|
| `/api/bots` | GET | 查询所有 Bot 实例列表（含状态/配置/统计） | 管理员 |
| `/api/bots` | POST | 创建新 Bot 实例 | 管理员 |
| `/api/bots/{bot_id}` | GET | 查询单个 Bot 实例详情 | 管理员 |
| `/api/bots/{bot_id}` | PUT | 更新单个 Bot 配置（热更新） | 管理员 |
| `/api/bots/{bot_id}` | DELETE | 删除 Bot 实例（先停止再删除） | 管理员 |
| `/api/bots/{bot_id}/start` | POST | 启动指定 Bot | 管理员 |
| `/api/bots/{bot_id}/stop` | POST | 停止指定 Bot | 管理员 |
| `/api/bots/{bot_id}/restart` | POST | 重启指定 Bot | 管理员 |
| `/api/bots/{bot_id}/wallet` | GET | 查询 Bot 钱包余额 | 管理员 |
| `/api/bots/{bot_id}/rooms` | GET | 查询 Bot 参与的房间列表 | 管理员 |
| `/api/bots/{bot_id}/create-room` | POST | 手动触发 Bot 创建房间 | 管理员 |
| `/api/bots/{bot_id}/reset-wallet` | POST | 重置 Bot 钱包 | 管理员 |

#### 4.6.2 Bot 全局控制

| 端点 | 方法 | 说明 | 权限 |
|------|------|------|------|
| `/api/bots/start-all` | POST | 一键启动所有 Bot | 管理员 |
| `/api/bots/stop-all` | POST | 一键停止所有 Bot | 管理员 |
| `/api/bots/global-config` | GET | 读取全局 Bot 配置 | 管理员 |
| `/api/bots/global-config` | PUT | 更新全局配置（新 Bot 默认值） | 管理员 |
| `/api/bots/stats` | GET | Bot 集群统计（总数/活跃/总对局数等） | 管理员 |

#### 4.6.3 API 请求/响应模型

```text
# ====== Bot 实例模型 ======
class BotInstanceResponse(BaseModel):
    bot_id: str                          # Bot 唯一标识，如 "bot_001"
    name: str                            # Bot 名称，如 "陪玩Bot-1"
    is_running: bool                     # 运行状态
    created_at: datetime
    started_at: Optional[datetime]
    wallet: BotWalletInfo                # 钱包信息
    config: BotConfigResponse            # 当前配置
    stats: BotStatsResponse              # 运行统计
    active_rooms: List[RoomBrief]        # 当前参与的房间
    status: str                          # idle / running / paused / error
    error_message: Optional[str]

class BotWalletInfo(BaseModel):
    address: str
    balance_eth: float
    balance_usdc: float
    sufficient: bool
    threshold: float

class BotStatsResponse(BaseModel):
    total_rooms_created: int
    total_rooms_joined: int
    total_games_played: int
    total_wins: int
    total_losses: int
    total_draws: int
    total_bet_amount: float
    avg_commit_delay: float
    avg_reveal_delay: float

class RoomBrief(BaseModel):
    room_id: int
    status: str
    token: str
    bet_amount: float
    opponent: str
    joined_at: datetime

# ====== Bot 创建请求 ======
class BotCreateRequest(BaseModel):
    name: str = "陪玩Bot"                 # Bot 显示名称
    strategy: str = "random"              # 出拳策略: random/aggressive/conservative/mimic
    wallet_index: Optional[int] = None    # 指定钱包索引（不指定则自动分配）
    token: str = "USDC"                   # 代币类型
    bet_amount: float = 10.0              # 单次下注额
    auto_create_room: bool = True         # 空闲时自动创建房间
    auto_join_room: bool = True           # 自动加入大厅房间
    create_interval: int = 60             # 创建房间间隔（秒）
    scan_interval: int = 10              # 大厅扫描间隔（秒）
    commit_delay: int = 3                 # commit 延迟（秒）
    reveal_delay: int = 2                 # reveal 延迟（秒）
    max_concurrent_rooms: int = 3         # 最大同时房间数
    wallet_balance_threshold: float = 1.0 # 钱包余额告警阈值
    enabled: bool = True                  # 创建后是否立即启动

# ====== Bot 配置更新请求 ======
class BotConfigUpdateRequest(BaseModel):
    name: Optional[str] = None
    strategy: Optional[str] = None
    token: Optional[str] = None
    bet_amount: Optional[float] = None
    auto_create_room: Optional[bool] = None
    auto_join_room: Optional[bool] = None
    create_interval: Optional[int] = None
    scan_interval: Optional[int] = None
    commit_delay: Optional[int] = None
    reveal_delay: Optional[int] = None
    max_concurrent_rooms: Optional[int] = None
    wallet_balance_threshold: Optional[float] = None

# ====== 全局配置 ======
class BotGlobalConfigResponse(BaseModel):
    default_strategy: str = "random"
    default_token: str = "USDC"
    default_bet_amount: float = 10.0
    default_create_interval: int = 60
    default_scan_interval: int = 10
    default_commit_delay: int = 3
    default_reveal_delay: int = 2
    default_max_concurrent_rooms: int = 3
    wallet_pool_start_index: int = 9      # 钱包池起始索引
    wallet_pool_end_index: int = 19       # 钱包池结束索引（最多 11 个 Bot）

class BotGlobalConfigUpdateRequest(BaseModel):
    default_strategy: Optional[str] = None
    default_token: Optional[str] = None
    default_bet_amount: Optional[float] = None
    wallet_pool_start_index: Optional[int] = None
    wallet_pool_end_index: Optional[int] = None

# ====== 集群统计 ======
class BotClusterStatsResponse(BaseModel):
    total_bots: int
    running_bots: int
    paused_bots: int
    error_bots: int
    total_rooms_created: int
    total_games_played: int
    total_wins: int
    total_losses: int
    total_draws: int
    total_bet_amount: float
    wallets_total_eth: float
    wallets_total_usdc: float
```

#### 4.6.4 Bot 出拳策略定义

```text
策略名称      策略标识      行为描述                                       下注风格
─────────────────────────────────────────────────────────────────────────────────
随机策略      random       均匀随机选择石头/布/剪刀                         等概率
激进策略      aggressive   倾向选择石头(40%)和布(40%)，剪刀(20%)            高频、大额
保守策略      conservative 倾向选择剪刀(40%)和石头(35%)，布(25%)             低频、小额
模仿策略      mimic        固定选择某一出拳（可配置，默认石头）               固定出拳
均衡策略      balanced     动态调整，最近输了的出拳下次排除                  学习型
```

**策略实现示例：**

```text
def generate_choice(strategy: str, history: List[int] = None) -> int:
    """
    根据策略生成出拳
    :param strategy: random / aggressive / conservative / mimic / balanced
    :param history: 最近 N 次出拳记录（用于 balanced 策略）
    :return: 1=石, 2=布, 3=剪
    """
    import secrets
    
    if strategy == "random":
        return secrets.randbelow(3) + 1
    
    elif strategy == "aggressive":
        # 石头40%、布40%、剪刀20%
        r = secrets.randbelow(100)
        return 1 if r < 40 else (2 if r < 80 else 3)
    
    elif strategy == "conservative":
        # 剪刀40%、石头35%、布25%
        r = secrets.randbelow(100)
        return 3 if r < 40 else (1 if r < 75 else 2)
    
    elif strategy == "mimic":
        return 1  # 固定石头，可配置
    
    elif strategy == "balanced":
        # 排除最近输过的类型
        if history and len(history) >= 3:
            recent = history[-3:]
            candidates = [1, 2, 3]
            for h in recent:
                if h in candidates:
                    candidates.remove(h)
            if candidates:
                return candidates[secrets.randbelow(len(candidates))]
        return secrets.randbelow(3) + 1
    
    else:
        return secrets.randbelow(3) + 1
```

### 4.7 Bot 与现有服务的交互方式

#### 与 RoomService 交互

```
BotService ──调用──► room_manager.create_room()
BotService ──调用──► room_manager.join_room()
BotService ──调用──► room_manager.toggle_ready()
BotService ──调用──► room_manager.leave_room()
BotService ──读取──► room_manager.get_room_list()
BotService ◄──监听── WS: room_joined / room_ready_change / game_started
```

#### 与 GameService 交互

```
BotService ──调用──► game_manager.submit_commit()
BotService ──调用──► game_manager.reveal_choice()
BotService ◄──监听── WS: opponent_commit / opponent_reveal / reveal_start / game_result
```

#### 与 RelayerService 交互

```
BotService ──调用──► relayer_service.submit_commit_with_sig()
BotService ──调用──► relayer_service.reveal_choice_with_sig()
```

#### 与 LocalChainService 交互

```
BotService ──读取──► local_chain._accounts[9] (钱包地址)
BotService ──读取──► local_chain.get_accounts() (余额信息)
BotService ──调用──► local_chain.send_eth() (充值)
BotService ──调用──► local_chain.transfer_usdc() (充值)
```

### 4.8 核心算法

#### commit 哈希计算（与合约一致）

```python
def compute_commit(choice: int, salt: str, address: str) -> str:
    """
    计算承诺哈希，与合约 _revealChoice 中的 keccak256 一致：
    commit = keccak256(abi.encodePacked(choice, salt, player))
    
    - choice: uint8 (1=Rock, 2=Paper, 3=Scissors)
    - salt: bytes32 (32 字节 hex 字符串)
    - address: address (20 字节 hex 字符串)
    """
    # 归一化
    addr_clean = address[2:] if address.startswith("0x") else address
    salt_clean = salt[2:] if salt.startswith("0x") else salt
    
    # abi.encodePacked: uint8(1B) + bytes32(32B) + address(20B) = 53B
    packed = bytes([choice]) + bytes.fromhex(salt_clean) + bytes.fromhex(addr_clean)
    
    # keccak256（非 sha3_256）
    from eth_hash.auto import keccak
    return "0x" + keccak(packed).hex()
```

#### 随机出拳生成

```python
import secrets

def generate_choice() -> int:
    """生成加密安全的随机出拳"""
    return secrets.randbelow(3) + 1  # 1=石, 2=布, 3=剪

def generate_salt() -> str:
    """生成 32 字节随机 salt"""
    return "0x" + secrets.token_hex(32)
```

### 4.9 数据流向图

#### Bot 创建房间 → 玩家加入 → 游戏全流程

```
┌─────────┐
│  Bot    │  create_room(token, bet)
│ Service │──────────────────────────►┌──────────────┐
└─────────┘                           │  RoomManager │
                                      └──────┬───────┘
                                             │
                                             │ 创建房间记录
                                             │ 广播 room_created
                                             ▼
                                      ┌──────────────┐
                                      │  游戏大厅     │
                                      │  (WebSocket)  │
                                      └──────┬───────┘
                                             │
                                             │ 玩家看到房间
                                             │ 玩家 join_room
                                             ▼
                                      ┌──────────────┐
                                      │  RoomManager │◄── join_room()
                                      └──────┬───────┘
                                             │
                                             │ Bot 收到 room_joined
                                             │ Bot toggle_ready
                                             ▼
                                      ┌──────────────┐
                                      │  RoomManager │◄── toggle_ready()
                                      └──────┬───────┘
                                             │
                                             │ 双方 ready
                                             │ 15s 倒计时
                                             ▼
                                      ┌──────────────┐
                                      │  GameManager │
                                      │  创建对局记录 │
                                      └──────┬───────┘
                                             │
                                             │ WS: game_started
                                             │ Bot 开始游戏流程
                                             ▼
                                      ┌──────────────┐
                                      │  BotService  │
                                      │  1. 随机choice│
                                      │  2. 随机salt  │
                                      │  3. 计算commit│
                                      │  4. 提交commit│
                                      └──────┬───────┘
                                             │
                                             │ WS: opponent_commit
                                             │ WS: reveal_start
                                             │ 等待对手 reveal
                                             ▼
                                      ┌──────────────┐
                                      │  BotService  │
                                      │  自动 reveal │
                                      └──────┬───────┘
                                             │
                                             │ 链上结算
                                             │ WS: game_result
                                             │ Bot 进入下一房间
                                             ▼
                                      ┌──────────────┐
                                      │  BotService  │──► 回到扫描/创建
                                      └──────────────┘
```

---

### 4.10 后台管理面板设计

#### 4.10.1 管理面板页面结构

后台管理面板集成在现有管理页面（`admin.html`）中，新增「Bot 管理」标签页。

```
┌─────────────────────────────────────────────────────────────────────────────────────────────┐
│  ChainRPS 管理后台                                                        [管理员] [退出]      │
├─────────────────────────────────────────────────────────────────────────────────────────────┤
│  [合约管理] [Bot 管理★] [本地链] [系统设置]                                                    │
├─────────────────────────────────────────────────────────────────────────────────────────────┤
│                                                                                               │
│  ┌─────────────────────────────────────────────────────────────────────────────────────────┐ │
│  │  Bot 集群总览                                                                             │ │
│  │                                                                                         │ │
│  │  ┌────────────┐ ┌────────────┐ ┌────────────┐ ┌────────────┐ ┌────────────┐             │ │
│  │  │ 总 Bot 数  │ │ 运行中     │ │ 已暂停     │ │ 异常       │ │ 总资产     │             │ │
│  │  │     3     │ │     2      │ │     0      │ │     1      │ │ 1,234 USDC │             │ │
│  │  └────────────┘ └────────────┘ └────────────┘ └────────────┘ └────────────┘             │ │
│  │                                                                                         │ │
│  │  [+ 创建 Bot]  [▶ 全部启动]  [■ 全部停止]  [⚙ 全局配置]                                    │ │
│  └─────────────────────────────────────────────────────────────────────────────────────────┘ │
│                                                                                               │
│  ┌─────────────────────────────────────────────────────────────────────────────────────────┐ │
│  │  Bot 实例列表                                                                            │ │
│  │                                                                                         │ │
│  │  ┌─────────────────────────────────────────────────────────────────────────────────┐   │ │
│  │  │ #  │ 名称        │ 钱包地址         │ 策略    │ 金额  │ 状态   │ 房间 │ 胜/负│ 操作   │   │ │
│  │  ├────┼─────────────┼─────────────────┼────────┼──────┼────────┼──────┼─────┼────────┤   │ │
│  │  │ 1  │ 陪玩Bot-1   │ 0x3F...8a1B     │ 随机    │ 10.0 │ 🟢运行  │  2   │ 5/3 │ ⚙ ⏸ 🗑 │   │ │
│  │  │ 2  │ 激进Bot-2   │ 0x7A...c4D2     │ 激进    │ 50.0 │ 🟢运行  │  1   │ 8/6 │ ⚙ ⏸ 🗑 │   │ │
│  │  │ 3  │ 保守Bot-3   │ 0x9B...f7E3     │ 保守    │ 5.0  │ 🔴异常  │  0   │ 2/4 │ ⚙ ▶ 🗑 │   │ │
│  │  └────┴─────────────┴─────────────────┴────────┴──────┴────────┴──────┴─────┴────────┘   │ │
│  └─────────────────────────────────────────────────────────────────────────────────────────┘ │
│                                                                                               │
│  ┌─────────────────────────────────────────────────────────────────────────────────────────┐ │
│  │  Bot 详情 / 配置面板（点击 ⚙ 打开）                                                      │ │
│  │                                                                                         │ │
│  │  名称: [陪玩Bot-1          ]  策略: [随机 ▾]  代币: [USDC ▾]                              │ │
│  │                                                                                         │ │
│  │  钱包地址: 0x3F...8a1B     ETH余额: 998.5 POL    USDC余额: 999,950 USDC                   │ │
│  │                                                                                         │ │
│  │  ── 房间行为 ──                                                                          │ │
│  │  ☑ 空闲时自动创建房间   ☑ 自动加入大厅房间                                               │ │
│  │  创建间隔: [60    ] 秒   扫描间隔: [10   ] 秒   最大同时房间: [3  ]                      │ │
│  │                                                                                         │ │
│  │  ── 游戏行为 ──                                                                          │ │
│  │  单次下注: [10.0  ] USDC  commit 延迟: [3 ] 秒   reveal 延迟: [2 ] 秒                     │ │
│  │                                                                                         │ │
│  │  ── 统计 ──                                                                              │ │
│  │  创建房间: 23  加入房间: 15  对局数: 38  胜: 20  负: 15  平: 3                           │ │
│  │                                                                                         │ │
│  │  [保存配置]  [立即启动]  [立即停止]  [手动创建房间]  [重置钱包]                            │ │
│  └─────────────────────────────────────────────────────────────────────────────────────────┘ │
│                                                                                               │
└─────────────────────────────────────────────────────────────────────────────────────────────┘
```

#### 4.10.2 创建 Bot 对话框

```
┌─────────────────────────────────────────┐
│  创建 Bot 实例                         ✕ │
├─────────────────────────────────────────┤
│                                         │
│  Bot 名称: [陪玩Bot-1              ]    │
│                                         │
│  出拳策略: [随机策略 ▾]                  │
│           选项: 随机/激进/保守/模仿/均衡 │
│                                         │
│  代币类型: [USDC ▾]                      │
│                                         │
│  单次下注: [10.0    ] USDC              │
│                                         │
│  钱包配置:                              │
│    ○ 自动分配（从钱包池）                │
│    ● 指定索引: [9     ]                 │
│                                         │
│  行为开关:                              │
│    ☑ 空闲时自动创建房间                 │
│    ☑ 自动加入大厅房间                   │
│                                         │
│  间隔设置:                              │
│    创建间隔: [60  ] 秒                  │
│    扫描间隔: [10  ] 秒                  │
│    commit延迟: [3 ] 秒                 │
│    reveal延迟: [2 ] 秒                 │
│    最大同时房间: [3  ]                  │
│                                         │
│  ☐ 创建后立即启动                       │
│                                         │
│              [取消]  [创建]              │
└─────────────────────────────────────────┘
```

#### 4.10.3 全局配置面板

```
┌─────────────────────────────────────────────────────────┐
│  全局 Bot 配置                                         ✕ │
├─────────────────────────────────────────────────────────┤
│                                                         │
│  ── 默认值（新 Bot 创建时使用） ──                      │
│                                                         │
│  默认策略: [随机策略 ▾]   默认代币: [USDC ▾]             │
│  默认下注额: [10.0  ] USDC                              │
│                                                         │
│  创建间隔: [60  ] 秒   扫描间隔: [10  ] 秒             │
│  commit延迟: [3 ] 秒   reveal延迟: [2 ] 秒             │
│  最大同时房间: [3  ]                                    │
│                                                         │
│  ── 钱包池 ──                                          │
│                                                         │
│  钱包池范围: [ 9 ] ~ [ 19 ]                             │
│  （最多支持 11 个 Bot 同时运行）                        │
│                                                         │
│  ⚠ 修改钱包池范围后需要重启 Bot 服务                    │
│                                                         │
│                   [取消]  [保存]                        │
└─────────────────────────────────────────────────────────┘
```

#### 4.10.4 Bot 详情 - 运行日志

```
┌─────────────────────────────────────────────────────────┐
│  Bot 陪玩Bot-1  - 运行日志                              │
├─────────────────────────────────────────────────────────┤
│                                                         │
│  [全部] [INFO] [WARN] [ERROR]  [清除]  [导出]          │
│                                                         │
│  ┌───────────────────────────────────────────────────┐ │
│  │ 2026-08-02 14:30:01 [INFO]  Bot 启动完成         │ │
│  │ 2026-08-02 14:30:02 [INFO]  钱包余额: 998.5 POL  │ │
│  │ 2026-08-02 14:30:05 [INFO]  扫描大厅: 0 个房间   │ │
│  │ 2026-08-02 14:30:06 [INFO]  创建房间 #128 (10 USDC)│ │
│  │ 2026-08-02 14:30:20 [INFO]  玩家 0x7A 加入房间    │ │
│  │ 2026-08-02 14:30:21 [INFO]  Bot 已准备            │ │
│  │ 2026-08-02 14:30:36 [INFO]  游戏开始 #456         │ │
│  │ 2026-08-02 14:30:39 [INFO]  commit 提交完成 (石头)│ │
│  │ 2026-08-02 14:30:42 [INFO]  对手 commit 完成     │ │
│  │ 2026-08-02 14:30:45 [INFO]  reveal 阶段开始      │ │
│  │ 2026-08-02 14:30:47 [INFO]  reveal 完成 (石头)   │ │
│  │ 2026-08-02 14:30:49 [INFO]  游戏结果: 平局       │ │
│  │ 2026-08-02 14:30:50 [INFO]  回到扫描状态         │ │
│  │ 2026-08-02 14:31:00 [INFO]  扫描大厅: 1 个房间   │ │
│  │ 2026-08-02 14:31:01 [WARN]  加入房间失败: 房间已满│ │
│  │ 2026-08-02 14:31:02 [INFO]  创建房间 #129        │ │
│  └───────────────────────────────────────────────────┘ │
│                                                         │
│  自动刷新: [☑]  刷新间隔: [3] 秒                      │
│                                                         │
└─────────────────────────────────────────────────────────┘
```

### 4.11 数据模型设计

#### 4.11.1 Bot 实例数据库模型（新增）

```sql
-- Bot 实例表
CREATE TABLE bot_instances (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    bot_id        TEXT UNIQUE NOT NULL,          -- "bot_001"
    name          TEXT NOT NULL,                 -- "陪玩Bot-1"
    strategy      TEXT NOT NULL DEFAULT 'random',-- random/aggressive/conservative/mimic/balanced
    wallet_index  INTEGER NOT NULL,              -- Ganache 账户索引
    wallet_address TEXT NOT NULL,                -- 钱包地址
    token         TEXT NOT NULL DEFAULT 'USDC',  -- 代币类型
    bet_amount    REAL NOT NULL DEFAULT 10.0,    -- 单次下注额
    status        TEXT NOT NULL DEFAULT 'idle',  -- idle/running/paused/error
    error_message TEXT,
    
    -- 行为配置
    auto_create_room     BOOLEAN DEFAULT 1,
    auto_join_room       BOOLEAN DEFAULT 1,
    create_interval      INTEGER DEFAULT 60,
    scan_interval        INTEGER DEFAULT 10,
    commit_delay         INTEGER DEFAULT 3,
    reveal_delay         INTEGER DEFAULT 2,
    max_concurrent_rooms INTEGER DEFAULT 3,
    wallet_balance_threshold REAL DEFAULT 1.0,
    
    -- 运行统计
    total_rooms_created INTEGER DEFAULT 0,
    total_rooms_joined  INTEGER DEFAULT 0,
    total_games_played INTEGER DEFAULT 0,
    total_wins    INTEGER DEFAULT 0,
    total_losses  INTEGER DEFAULT 0,
    total_draws   INTEGER DEFAULT 0,
    total_bet_amount REAL DEFAULT 0.0,
    avg_commit_delay REAL DEFAULT 0.0,
    avg_reveal_delay REAL DEFAULT 0.0,
    
    -- 时间戳
    created_at    TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    started_at    TIMESTAMP,
    updated_at    TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Bot 运行日志表
CREATE TABLE bot_logs (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    bot_id     TEXT NOT NULL,
    level      TEXT NOT NULL,           -- INFO/WARN/ERROR
    message    TEXT NOT NULL,
    details    TEXT,                    -- JSON 详情
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (bot_id) REFERENCES bot_instances(bot_id)
);

-- Bot 当前活跃房间表
CREATE TABLE bot_active_rooms (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    bot_id     TEXT NOT NULL,
    room_id    INTEGER NOT NULL,
    game_id    INTEGER,
    status     TEXT NOT NULL,           -- waiting/commit/reveal/settled
    opponent   TEXT,
    bet_amount REAL,
    joined_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (bot_id) REFERENCES bot_instances(bot_id)
);

-- 索引
CREATE INDEX idx_bot_logs_bot_id ON bot_logs(bot_id);
CREATE INDEX idx_bot_logs_level ON bot_logs(level);
CREATE INDEX idx_bot_active_rooms_bot ON bot_active_rooms(bot_id);
CREATE INDEX idx_bot_active_rooms_status ON bot_active_rooms(status);
```

#### 4.11.2 数据模型 ER 关系

```
┌──────────────────┐       1:N       ┌──────────────────┐
│  bot_instances   │───────────────►│    bot_logs      │
│                  │                │                  │
│  bot_id (PK)     │                │  bot_id (FK)     │
│  name            │                │  level           │
│  strategy        │                │  message         │
│  wallet_address  │                │  details (JSON)  │
│  status          │                └──────────────────┘
│  ...             │
└──────────────────┘       1:N       ┌──────────────────┐
                   ───────────────►│ bot_active_rooms │
                                    │                  │
                                    │  bot_id (FK)     │
                                    │  room_id         │
                                    │  game_id         │
                                    │  status          │
                                    └──────────────────┘
```

### 4.12 钱包池管理

#### 4.12.1 钱包池分配策略

```
Ganache 账户索引分配方案:
┌─────────────────────────────────────────────────────────────────┐
│  索引 0  - 合约部署者 / 管理员（固定）                          │
│  索引 1  - Relayer 服务（固定）                                 │
│  索引 2  - 预留                                                 │
│  索引 3  - 预留                                                 │
│  索引 4  - 预留                                                 │
│  索引 5  - 预留                                                 │
│  索引 6  - 预留                                                 │
│  索引 7  - 预留                                                 │
│  索引 8  - 预留                                                 │
│  ─────────────────────────── 钱包池 ──────────────────────────  │
│  索引 9  - Bot #1  (自动分配)                                   │
│  索引 10 - Bot #2  (自动分配)                                   │
│  索引 11 - Bot #3  (自动分配)                                   │
│  ...                                                            │
│  索引 19 - Bot #11 (自动分配，上限)                             │
└─────────────────────────────────────────────────────────────────┘
```

#### 4.12.2 钱包自动分配流程

```
创建 Bot 时:
  1. 读取 bot_instances 中所有已分配的 wallet_index
  2. 从 wallet_pool_start_index (默认 9) 开始查找第一个未被占用的索引
  3. 检查该索引的 Ganache 账户是否存在
  4. 若不存在，调用 local_chain 创建/导入该账户
  5. 自动充值 ETH + USDC（初始额度可配置）
  6. 分配给新 Bot

删除 Bot 时:
  1. 停止 Bot 运行
  2. 清除 bot_instances 记录
  3. 保留钱包（不删除，方便其他 Bot 复用）
  4. 钱包余额归还给钱包池
```

#### 4.12.3 钱包池配置项（补充到 4.5）

```text
# ============ Bot 钱包池配置 ============
BOT_WALLET_POOL_START = int(os.getenv("BOT_WALLET_POOL_START", 9))
BOT_WALLET_POOL_END = int(os.getenv("BOT_WALLET_POOL_END", 19))
BOT_WALLET_INITIAL_ETH = float(os.getenv("BOT_WALLET_INITIAL_ETH", 1000.0))
BOT_WALLET_INITIAL_USDC = float(os.getenv("BOT_WALLET_INITIAL_USDC", 1000000.0))
```

---

## 五、开发计划

### 5.1 阶段划分

| 阶段 | 名称 | 预计工时 | 交付物 |
|------|------|---------|--------|
| Phase 1 | 数据模型与钱包池 | 1-2 天 | 数据库表、钱包池管理 |
| Phase 2 | Bot 核心服务（多实例） | 2-3 天 | `bot_service.py`、Bot 实例管理 |
| Phase 3 | Bot API 集群接口 | 1-2 天 | `bot.py` 路由、CRUD 接口 |
| Phase 4 | 后台管理面板 | 2-3 天 | 管理 UI、Bot 列表、配置面板 |
| Phase 5 | 集成与测试 | 2-3 天 | 全流程测试、多 Bot 并发测试 |

### 5.2 Phase 1：数据模型与钱包池（详细任务拆解）

| # | 任务 | 工时 | 产出 | 依赖 |
|---|------|------|------|------|
| 1.1 | 新增 Bot 配置项到 `config/__init__.py` | 0.5h | 配置常量（含钱包池配置） | 无 |
| 1.2 | 创建 `bot_instances` / `bot_logs` / `bot_active_rooms` 数据库表 | 1h | 数据库迁移脚本 | 无 |
| 1.3 | 实现 BotInstance 数据访问层（DAO） | 2h | CRUD 操作、状态更新、统计更新 | 1.2 |
| 1.4 | 实现钱包池管理器（分配/回收/自动充值） | 3h | `wallet_pool_manager.py` | 1.1, 1.3 |
| 1.5 | 实现 commit 哈希计算算法 | 2h | `compute_commit()` | 无 |
| 1.6 | 实现 5 种出拳策略（random/aggressive/conservative/mimic/balanced） | 2h | `generate_choice()` 策略分发 | 无 |

### 5.3 Phase 2：Bot 核心服务（多实例）（详细任务拆解）

| # | 任务 | 工时 | 产出 | 依赖 |
|---|------|------|------|------|
| 2.1 | 实现 BotInstance 类（单个 Bot 的完整行为） | 4h | BotInstance 类 | Phase 1 |
| 2.2 | 实现 Bot 行为状态机（IDLE→ROOM_CREATED→READY→COUNTDOWN→GAME_STARTED→RESULT） | 2h | 状态机驱动 | 2.1 |
| 2.3 | 实现房间行为（创建/加入/准备/大厅扫描） | 3h | `_create/join/ready/_scan_lobby()` | 2.1 |
| 2.4 | 实现游戏行为（commit/reveal/结算回调） | 4h | `_do_commit/_do_reveal/_on_game_result()` | 2.1, 2.2 |
| 2.5 | 实现 BotManager（多实例管理：启动/停止/路由） | 3h | BotManager 类 | 2.1 |
| 2.6 | 实现 Bot 日志记录与统计更新 | 2h | 日志写入、统计累加 | 2.1 |
| 2.7 | 编写 `bot_service.py` 完整代码 | — | 完整文件 | 上述全部 |

### 5.4 Phase 3：Bot API 集群接口（详细任务拆解）

| # | 任务 | 工时 | 产出 | 依赖 |
|---|------|------|------|------|
| 3.1 | 新增 Bot 请求/响应模型到 `models/__init__.py` | 2h | Pydantic 模型（集群/实例/配置/统计） | 无 |
| 3.2 | 创建 `bot.py` 路由文件（集群管理 13 个端点） | 3h | 集群 CRUD API | 3.1, Phase 2 |
| 3.3 | 实现全局配置 API（读取/更新/钱包池管理） | 1h | 全局配置端点 | 3.1 |
| 3.4 | 实现集群统计与日志查询 API | 1h | 统计/日志端点 | 3.1, Phase 2 |
| 3.5 | 在 `main.py` 中注册 Bot 路由与启动生命周期 | 1h | 路由挂载、启动钩子 | 3.2 |

### 5.5 Phase 4：后台管理面板（详细任务拆解）

| # | 任务 | 工时 | 产出 | 依赖 |
|---|------|------|------|------|
| 4.1 | 管理面板页面框架（Tab 导航 + 集群总览卡片） | 3h | admin.html 基础布局 | Phase 3 |
| 4.2 | Bot 实例列表页（表格 + 状态标签 + 操作按钮） | 3h | Bot 列表 UI | 4.1 |
| 4.3 | 创建 Bot 对话框（表单校验 + 策略选择） | 2h | 创建对话框 | 4.2 |
| 4.4 | Bot 详情/配置面板（热更新配置） | 3h | 配置面板 | 4.2 |
| 4.5 | 全局配置面板（默认值 + 钱包池设置） | 2h | 全局配置 UI | 4.1 |
| 4.6 | Bot 运行日志查看器（实时刷新 + 级别过滤） | 2h | 日志面板 | 4.4 |

### 5.6 Phase 5：集成与测试（详细任务拆解）

| # | 任务 | 工时 | 产出 | 依赖 |
|---|------|------|------|------|
| 5.1 | 单 Bot 全流程测试（创建/加入/commit/reveal/结算） | 2h | 测试报告 | Phase 1-3 |
| 5.2 | 多 Bot 并发测试（3-5 个 Bot 同时运行） | 2h | 测试报告 | 5.1 |
| 5.3 | Bot 与真实玩家对战测试 | 2h | 测试报告 | 5.1 |
| 5.4 | 异常场景测试（超时/网络异常/余额不足） | 2h | 测试报告 | 5.1 |
| 5.5 | 钱包池分配测试（创建/删除 Bot 时的钱包回收） | 1h | 测试报告 | 5.1 |
| 5.6 | 管理面板集成测试（CRUD/热更新/日志） | 2h | 测试报告 | Phase 4 |
| 5.7 | API 接口全量测试 | 1h | 测试报告 | Phase 3 |

### 5.7 前端适配（可选，Phase 5 后）

| # | 任务 | 工时 | 产出 | 依赖 |
|---|------|------|------|------|
| 6.1 | 大厅房间卡片添加 Bot 标签 | 2h | UI 更新 | Phase 5 |
| 6.2 | "与 Bot 对战"快捷入口按钮 | 4h | UI + 交互 | 6.1 |
| 6.3 | Bot 状态轮询与提示 | 2h | UI 更新 | Phase 3 |
| 6.4 | 帮助/引导页面（使用说明） | 2h | 前端页面 | 6.2 |

---

## 六、安全约束

### 6.1 环境隔离

| 约束 | 实现方式 |
|------|---------|
| 仅限测试链 | `BOT_ENABLED` 仅当 `RPC_CHAIN_ID == 5208888` 且 `DEBUG=true` 时允许 |
| 生产链禁用 | 主链（Polygon）环境自动检测并禁用 Bot 功能 |
| 钱包隔离 | Bot 使用独立 Ganache 账户（索引 9），不与管理员/Relayer 账户混用 |

### 6.2 资金安全

| 约束 | 实现方式 |
|------|---------|
| 余额限制 | Bot 钱包设置最低余额告警阈值，低于阈值时自动停止 |
| 下注限制 | `BOT_BET_AMOUNT` 可配置，防止异常高注 |
| 频率限制 | 创建房间间隔、操作间隔可配置，防止刷量 |
| 审计日志 | 所有 Bot 操作记录到日志（时间、动作、参数、结果） |

### 6.3 操作安全

| 约束 | 实现方式 |
|------|---------|
| 管理员权限 | Bot 启动/停止/配置变更仅管理员可操作 |
| 速率限制 | API 端点添加速率限制（如每分钟最多 10 次操作） |
| 配置校验 | 配置更新时校验取值范围，防止非法配置 |

---

## 七、与现有系统的集成要点

### 7.1 WebSocket 事件监听

Bot 需要监听以下 WebSocket 事件以驱动行为：

| 事件类型 | 触发时机 | Bot 响应行为 |
|---------|---------|-------------|
| `room_created` | 大厅出现新房间 | 扫描并尝试加入 |
| `room_joined` | 玩家加入 Bot 创建的房间 | 自动准备 |
| `room_ready_change` | 准备状态变化 | 等待对方 ready |
| `countdown_start` | 倒计时开始 | 等待倒计时结束 |
| `game_started` | 游戏正式开始 | 启动 commit 流程 |
| `opponent_commit` | 对手提交 commit | 等待双方提交完成 |
| `reveal_start` | 进入揭晓阶段 | 等待对手 reveal |
| `opponent_reveal` | 对手揭晓 | 启动 reveal 流程 |
| `game_result` | 游戏结算 | 记录结果、进入下一局 |
| `room_closed` | 房间关闭 | 清理状态、重新扫描 |

### 7.2 Relayer 集成

Bot 复用现有 Relayer 服务进行 Gasless 上链：

- **方案 A（EIP-712 签名）**：Bot 使用自身私钥对 commit/reveal 数据签名，Relayer 代为上链
- **方案 B（长期授权）**：Bot 预先授权 Relayer，后续操作无需签名
- **优先级**：Bot 默认使用方案 B（体验更佳），回退到方案 A

### 7.3 合约事件同步

Bot 行为依赖 `contract_service` 的链上事件监听：

- `GameCreated` → 通知房间/游戏服务
- `CommitSubmitted` → 更新提交状态
- `RevealSubmitted` → 更新揭晓状态
- `GameSettled` / `DrawHandled` → 结算通知
- `TimeoutClaimed` → 超时处理

---

## 八、测试场景清单

### 8.1 核心流程测试

| # | 测试场景 | 预期结果 |
|---|---------|---------|
| T-01 | Bot 启动后自动创建房间 | 大厅出现 Bot 创建的房间 |
| T-02 | 玩家加入 Bot 房间 | Bot 自动准备，双方进入倒计时 |
| T-03 | 倒计时结束开始游戏 | 双方进入 commit 阶段 |
| T-04 | Bot 自动提交 commit | 后端记录 commit，通知玩家 |
| T-05 | 玩家提交 commit | 双方进入 reveal 阶段 |
| T-06 | 玩家先 reveal | Bot 随后自动 reveal |
| T-07 | 链上结算完成 | 双方收到 game_result |
| T-08 | Bot 进入下一房间 | 循环创建/加入房间 |

### 8.2 异常场景测试

| # | 测试场景 | 预期结果 |
|---|---------|---------|
| T-09 | 玩家超时未 commit | Bot 等待超时，不做判负 |
| T-10 | 玩家超时未 reveal | Bot 等待超时，不做判负 |
| T-11 | 玩家取消准备 | Bot 取消准备，回到等待状态 |
| T-12 | 玩家退出房间 | Bot 退出房间，重新扫描大厅 |
| T-13 | 房间超时关闭 | Bot 清理状态，重新扫描 |
| T-14 | Bot 钱包余额不足 | 自动充值或告警 |
| T-15 | 网络异常 | Bot 重连或告警 |
| T-16 | 同时多 Bot 运行 | 各自独立，不冲突 |

### 8.3 边界条件测试

| # | 测试场景 | 预期结果 |
|---|---------|---------|
| T-17 | 大厅已满（无空房间） | Bot 主动创建新房间 |
| T-18 | 大厅已有 3 个 Bot 房间 | Bot 不再创建新房间 |
| T-19 | 玩家同时加入多个房间 | 正常处理，不冲突 |
| T-20 | Bot 创建房间后立即被加入 | 正确处理倒计时 |

---

## 九、后续扩展方向

| 优先级 | 方向 | 说明 |
|--------|------|------|
| P2 | 更多出拳策略 | 心理策略（固定开局+随机变化）/ 记牌策略（记录对手出拳规律） |
| P2 | 难度分级 | 简单（随机）/ 中等（有策略）/ 困难（记牌）—— 已集成到策略系统 |
| P2 | 排行榜联动 | Bot 参与排行榜，增加测试趣味性 |
| P2 | 定时任务 | 预设 Bot 在特定时间段自动上线/下线 |
| P3 | AI Bot | 接入 LLM 生成更拟人化的行为（延迟波动、道歉消息、情绪表达） |
| P3 | 自动化测试框架 | 基于 Bot 搭建 CI/CD 自动化测试流水线 |
| P3 | 压力测试工具 | 多 Bot 并发模拟大量用户（50+），验证系统承载 |
| P3 | 跨链支持 | Bot 支持多条测试链同时运行（需扩展钱包池） |

---

## 附录 A：关键技术参数

| 参数 | 值 | 说明 |
|------|-----|------|
| 目标链 | Ganache Local | 仅限测试链 |
| Chain ID | 5208888 | 与现有配置一致 |
| RPC URL | http://127.0.0.1:8686 | 与现有配置一致 |
| 钱包池范围 | 9 ~ 19 | 最多支持 11 个 Bot 同时运行 |
| Bot 钱包初始 ETH | 1000 POL | 每个 Bot 初始额度 |
| Bot 钱包初始 USDC | 1000000 USDC | 每个 Bot 初始额度 |
| 默认下注额 | 10 USDC | 可调，每 Bot 独立配置 |
| 最大并发房间/ Bot | 3 | 防止资源浪费 |
| commit 延迟 | 3 秒 | 模拟人类反应时间 |
| reveal 延迟 | 2 秒 | 模拟人类反应时间 |
| 支持策略数 | 5 种 | random/aggressive/conservative/mimic/balanced |

## 附录 B：涉及文件路径索引

| 文件 | 类型 | 操作 |
|------|------|------|
| `rps_backend/service/bot_service.py` | 新增 | BotInstance 类（单个 Bot 行为） |
| `rps_backend/service/bot_manager.py` | 新增 | BotManager 类（多实例集群管理） |
| `rps_backend/service/wallet_pool_manager.py` | 新增 | 钱包池管理器 |
| `rps_backend/api/endpoints/bot.py` | 新增 | Bot 集群 API 路由（18 个端点） |
| `rps_backend/models/bot.py` | 新增 | Bot SQLAlchemy 数据模型 |
| `rps_backend/config/__init__.py` | 修改 | 新增 Bot + 钱包池配置项 |
| `rps_backend/main.py` | 修改 | 注册路由 + Bot 集群初始化 |
| `rps_backend/models/__init__.py` | 修改 | 新增请求/响应 Pydantic 模型 |
| `rps_frontend/static/html/admin.html` | 修改 | 新增 Bot 管理标签页 |
| `rps_frontend/static/js/admin_bot.js` | 新增 | Bot 管理前端逻辑 |
| `rps_frontend/static/js/ui.js` | 修改（可选） | 大厅 Bot 标识展示 |
| `rps_frontend/static/js/app.js` | 修改（可选） | "与 Bot 对战"快捷入口 |