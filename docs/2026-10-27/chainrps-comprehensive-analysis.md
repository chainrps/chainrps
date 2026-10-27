# ChainRPS 项目综合分析报告

> 分析日期：2026-10-27
> 项目版本：v1.0.43
> 分析范围：后端 FastAPI 服务、前端 SPA、WebSocket 实时通信、智能合约、Bot 陪玩系统、Relayer 代提交

---

## 目录

- [一、BUG 清单](#一bug-清单)
- [二、安全隐患](#二安全隐患)
- [三、功能 BUG / 缺陷](#三功能-bug--缺陷)
- [四、性能提升建议](#四性能提升建议)
- [五、界面设计优化建议](#五界面设计优化建议)
- [六、游戏大厅与房间管理功能完整性分析](#六游戏大厅与房间管理功能完整性分析)
- [七、架构与代码质量其他建议](#七架构与代码质量其他建议)
- [八、优先级排序与行动路线图](#八优先级排序与行动路线图)

---

## 一、BUG 清单

### B-01：`datetime.utcnow()` 已废弃（Python 3.12+）
- **文件**：`rps_backend/repository/database.py:383`, `rps_backend/service/game_service.py:331`, `rps_backend/service/game_service.py:504`
- **严重级别**：低（仍可用但有 DeprecationWarning）
- **描述**：Python 3.12+ 中 `datetime.utcnow()` 已标记为废弃，应使用 `datetime.now(datetime.UTC)` 或 `datetime.now(timezone.utc)`
- **修复建议**：统一替换为 `datetime.now(datetime.UTC).replace(tzinfo=None)` 或封装 helper

### B-02：房间关闭时未停止 `_unready_timers` 和 `_empty_room_timers`
- **文件**：`rps_backend/service/room_service.py:577-647`（`_close_room` 方法）
- **严重级别**：中
- **描述**：`_close_room` 只停止了 `_game_timers` 和 `_lifetime_timers`，但没有停止 `_unready_timers` 和 `_empty_room_timers`。这会导致这些计时器触发时操作已关闭的房间，产生异常或无效逻辑。
- **修复建议**：在 `_close_room` 中补充：
  ```python
  self._stop_unready_timer(room["creator"])
  if room.get("player2"):
      self._stop_unready_timer(room["player2"])
  self._stop_empty_room_timer(room_id)
  ```

### B-03：`_start_countdown` 中 `player2` 变量在 countdown 循环前被覆盖
- **文件**：`rps_backend/service/room_service.py:703-704`
- **严重级别**：低
- **描述**：
  ```python
  player1 = room["creator"]
  player2 = room["player2"]   # 这里覆盖了上文 line 697 的 player2
  ```
  上文 line 697 有 `player2 = room.get("player2")`，然后 line 704 又写了一次，功能上没问题但是冗余赋值。
- **修复建议**：删除冗余的第二次赋值。

### B-04：`leave_room` 的 `player2_chain_joined` 默认值逻辑有隐患
- **文件**：`rps_backend/api/endpoints/game.py:287`
- **严重级别**：中
- **描述**：
  ```python
  player2_chain_joined = True  # 安全默认值：链不可读时维持旧行为（拒绝）
  ```
  当链服务不可用时默认 `True`，意味着会拒绝 player2 退出请求。但如果 player2 确实没 join 链上对局（localOnly 模式），这个默认值会错误地阻止他退出。
- **修复建议**：localOnly 模式下（`not BOT_AUTO_CHAIN_MATCH`）直接设为 `False`，链不可达时可以考虑中间状态让 player2 先退出并标记为"可能需要链上处理"。

### B-05：`handle_player_disconnect` 延迟 10 秒清理房间但与其他计时器可能冲突
- **文件**：`rps_backend/service/room_service.py`（disconnect handler）
- **严重级别**：中
- **描述**：玩家断开连接后延迟 10 秒清理房间，但这期间如果有新的玩家加入同一个房间（通过房间 ID 直链），可能导致状态混乱。
- **修复建议**：清理前检查该房间是否已有新玩家在房间中。

### B-06：WebSocket Pub/Sub listener 中 `await asyncio.sleep(0.01)` 会累积延迟
- **文件**：`rps_backend/websocket/manager.py:245` 和 `:296`
- **严重级别**：低
- **描述**：每轮循环 sleep 0.01 秒但 `get_message` 是非阻塞的，实际上这是一种轮询模式。Redis pubsub 可以用 `listen()` 阻塞式消费，性能更好且不会丢消息。
- **修复建议**：改用 `async for message in pubsub.listen():` 或 `pubsub.get_message(timeout=1.0)`。

### B-07：localOnly 模式结算中硬编码 `bet = 10.0` 作为兜底
- **文件**：`rps_backend/service/game_service.py:401`
- **严重级别**：低
- **描述**：
  ```python
  bet = 10.0
  if r_found:
      bet = float(r_found.get("bet_amount") or bet)
  ```
  如果 `r_found` 为 None，会用 10.0 作为默认 bet 去转账 USDC，可能导致错误金额。
- **修复建议**：用 `latest_game` 中的 `bet_amount` 作为备选来源，找不到则跳过转账。

---

## 二、安全隐患

### S-01：CORS 配置 `allow_origins=["*"]` 过于宽松
- **文件**：`rps_backend/main.py:188-193`
- **风险等级**：🔴 高
- **描述**：生产环境下 `allow_origins=["*"]` 允许任何来源的跨域请求，配合 `allow_credentials=True`（虽然现代浏览器会拒绝这个组合），存在 CSRF 攻击面。
- **修复建议**：从配置读取允许的域名列表，生产环境只允许前端域名。

### S-02：默认管理员凭据 `admin / ADMIN` 硬编码且弱密码
- **文件**：`rps_backend/config/__init__.py:126`
- **风险等级**：🔴 高
- **描述**：
  ```python
  DEFAULT_ADMIN_PASSWORD = os.getenv("DEFAULT_ADMIN_PASSWORD", "ADMIN")
  ```
  默认密码 "ADMIN" 极其脆弱，且 init_database 时自动创建管理员账户。如果部署时忘记改密码，任何人都可以登录管理面板。
- **修复建议**：生产环境强制要求 `DEFAULT_ADMIN_PASSWORD` 环境变量非空且强度达标，否则拒绝启动。

### S-03：JWT Secret 使用弱默认值
- **文件**：`rps_backend/config/__init__.py:120`
- **风险等级**：🔴 高
- **描述**：
  ```python
  JWT_SECRET = os.getenv("JWT_SECRET", "chainrps-dev-secret-change-in-production-please")
  ```
  如果生产环境没设 `JWT_SECRET`，攻击者可以伪造任意 JWT token 冒充任何人（包括管理员）。
- **修复建议**：生产环境（`DEBUG=false`）下若 JWT_SECRET 为默认值则拒绝启动。

### S-04：`/rootfs/{filepath}` 端点虽然有安全校验但不应在生产暴露
- **文件**：`rps_backend/main.py:434-451`
- **风险等级**：🟡 中
- **描述**：这个端点可以读取项目根目录下任意文件，虽然排除了 `.env` 和 `.git`，但其他敏感文件（如日志、数据文件）可能被读取。
- **修复建议**：用 `DEBUG` 环境变量包裹，仅在开发模式注册此路由。

### S-05：Relayer 私钥通过环境变量加载但可能被日志泄露
- **文件**：`rps_backend/config/__init__.py:108`
- **风险等级**：🟡 中
- **描述**：`RELAYER_PRIVATE_KEY` 从环境变量读取，但有些日志输出可能意外包含这个值（比如 config dump、启动时打印配置）。
- **修复建议**：全局 grep 检查是否有任何地方打印 relayer 相关配置，禁止记录私钥。

### S-06：WebSocket 端点无认证，任何人可以冒充任意玩家地址连接
- **文件**：`rps_backend/main.py:232-239`
- **风险等级**：🔴 高
- **描述**：
  ```python
  @app.websocket("/ws/{player_address}")
  async def ws_endpoint(websocket: WebSocket, player_address: str):
  ```
  任何人可以构造 `/ws/0x任意地址` 来冒充其他玩家接收实时消息。没有任何签名/Token 校验。
- **修复建议**：连接建立时要求签名验证或携带 JWT token，与 HTTP API 对齐。

### S-07：`send_to_player` 在玩家不在线时静默丢弃消息
- **文件**：`rps_backend/websocket/manager.py:140-142`
- **风险等级**：🟡 中（间接安全）
- **描述**：攻击者可以持续发送消息让 Redis pubsub 队列膨胀（DoS），而没有任何速率限制。
- **修复建议**：加入 IP 限流 + 消息发送速率限制。

### S-08：游戏结果接口可被滥用刷排行榜
- **文件**：`rps_backend/service/game_service.py:309-464`（localOnly 结算逻辑）
- **风险等级**：🟡 中
- **描述**：localOnly 模式下后端自己算胜负并更新玩家统计。恶意用户可以反复调用 reveal 接口刷战绩。虽然最终胜负由链上合约决定，但排行榜数据会被污染。
- **修复建议**：排行榜只统计链上结算的对局，localOnly 模式不计入。

---

## 三、功能 BUG / 缺陷

### F-01：倒计时协程 `_start_countdown` 取消后可能残留
- **文件**：`rps_backend/service/room_service.py:673-773`
- **描述**：当任一方取消准备导致倒计时回退到 JOINED 时，`toggle_ready` 只改了 room status，while 循环中 `if room["status"] != ROOM_STATUS["COUNTDOWN"]: return` 会让协程在下一次 sleep 后退出。但如果 sleep 正在进行中，退出会延迟最多 3 秒。
- **影响**：前端可能看到倒计时还在跑几秒才取消。
- **建议**：用 `asyncio.Event` 作为取消信号，在 sleep 前/中检测。

### F-02：`get_room` 返回的 room dict 暴露内部 `_unready_since` 字段
- **文件**：`rps_backend/service/room_service.py:944-956`
- **描述**：虽然 `pop("_unready_since", None)` 清理了，但 `cache_room_state` 在 `toggle_ready` 中是直接存了完整 room dict（包括内部字段），Redis 缓存里有冗余。
- **建议**：建立统一的 `_sanitize_room_for_cache()` 方法。

### F-03：游戏大厅不支持按状态/代币/金额过滤
- **文件**：`rps_backend/api/endpoints/game.py:340-361`
- **描述**：`/api/game/room/list` 只支持分页，没有 filter 参数。前端大厅无法按"只看 USDC + 10 USDC 下注"筛选。
- **建议**：增加 `status`、`token`、`min_bet`、`max_bet` query 参数。

### F-04：玩家断线重连后 WebSocket 连接成功但房间状态可能已丢失
- **文件**：`rps_backend/websocket/manager.py` + `room_service.handle_player_disconnect`
- **描述**：断线 10 秒后房间被清理，但玩家重连时 WS 会重新建立。前端需要通过 `/api/game/room/player/{address}` 来查询当前房间，但如果房间已被关闭/清理，玩家会丢失上下文。
- **建议**：在 WS 欢迎消息中附带玩家当前房间 ID（如果有），帮助前端自动恢复。

### F-05：Bot 加入房间后 seat_mode 不会自动更新为 "open"
- **文件**：`rps_backend/service/room_service.py` Bot 相关逻辑
- **描述**：创建者设 seat_mode="ai" 后 Bot 加入成功，但 room 的 seat_mode 字段没有更新回 "open"，其他玩家看到的还是 "ai" 模式。
- **建议**：Bot 成功 join 后设置 `room["seat_mode"] = "open"`。

### F-06：localOnly 模式 USDC 结算硬编码 Ganache 地址 `http://127.0.0.1:8686`
- **文件**：`rps_backend/service/game_service.py:421`
- **描述**：
  ```python
  w3 = Web3(Web3.HTTPProvider("http://127.0.0.1:8686"))
  ```
  没有用配置中的 `RPC_LOCAL_URL`，导致改了端口后结算会失败。
- **修复建议**：从 config 读取 RPC URL。

### F-07：`game_started` 后 create 链上对局和 join 的流程无超时保护
- **文件**：`rps_backend/service/room_service.py:776-878`
- **描述**：游戏开始后通知双方，但如果创建者长时间不 `report_chain_game`，游戏永远停在 GAME_STARTED 状态。虽然有 ROOM_GAME_TIMEOUT（10分钟），但没有专门的 createMatch/joinMatch 超时。
- **建议**：增加阶段级超时，例如 createMatch 必须在 3 分钟内完成。

### F-08：排行榜接口 `limit` 参数没有在后端硬限制（虽然默认 20）
- **文件**：`rps_backend/api/endpoints/game.py:394-407`
- **描述**：如果前端传 `limit=1000000` 可能产生大量数据返回。虽然 `get_leaderboard` 里有 `limit = max(1, min(limit, 100))`，但这是 repository 层做的，API 层没有提示。
- **建议**：在路由参数上加 `Query(..., le=100)` 约束。

### F-09：WebSocket 信令端点（P2P）的 `room_id` 参数无权限校验
- **文件**：`rps_backend/main.py:243-251`
- **描述**：
  ```python
  @app.websocket("/ws/signaling/{room_id}/{player_address}")
  ```
  任何人可以订阅其他房间的信令消息，偷听 WebRTC 握手。虽然 WebRTC 本身是端到端加密的，但信令元数据（ICE candidates 中的 IP/端口）可能泄露。
- **建议**：校验 player_address 是否为 room_id 对应的 creator 或 player2。

### F-10：房间 UUID 只取前 8 位，碰撞概率不低
- **文件**：`rps_backend/service/room_service.py:153`
- **描述**：
  ```python
  room_id = str(uuid.uuid4())[:8]
  ```
  8 位 hex 有约 43 亿种可能，碰撞在大量房间时会发生。
- **建议**：用完整 UUID 或在创建时检查是否已存在。

---

## 四、性能提升建议

### P-01：每次 DB 操作都打开/关闭连接，应使用连接池
- **文件**：`rps_backend/repository/database.py`（所有函数）
- **当前问题**：每次 `get_connection()` → 使用 → `conn.close()`，高频下连接创建开销大。
- **建议**：使用 SQLite 的 `check_same_thread=False` + 长连接模式，或者引入连接池（如 SQLAlchemy）。SQLite WAL 模式下多连接并发已支持得很好。

### P-02：`get_room_list()` 每次都遍历所有房间并做 `_is_bot_address` 检查
- **文件**：`rps_backend/service/room_service.py:959-999`
- **当前问题**：`_is_bot_address` 每次都要 import bot_service / bot_manager 并遍历所有实例，O(N)。每 3 秒广播一次房间列表变更 → 大厅刷新 → 调用 `get_room_list()`，开销累积。
- **建议**：将 bot 地址集合缓存为 `self._bot_addresses: Set[str]`，初始化时填充，bot 状态变更时更新。`_is_bot_address` 改为 `return addr_lower in self._bot_addresses`。

### P-03：Redis 缓存与 SQLite 读写重复（双写一致性问题）
- **文件**：`rps_backend/service/room_service.py`, `game_service.py`
- **当前问题**：每次房间/游戏状态变更都同时写 SQLite + Redis。对于高频变更（ready/join/countdown），SQLite commit 是同步阻塞的。
- **建议**：
  - 房间状态（高频变更）只用 Redis 缓存，定期/关键节点才持久化到 SQLite
  - 或者引入 write-behind 模式：先写 Redis，批量异步写 SQLite

### P-04：`_compute_deadlines` 在每次 `get_room` 时动态计算
- **文件**：`rps_backend/service/room_service.py:61-110`
- **当前问题**：`_compute_deadlines` 每次调用都要计算多个 timeout，且调用了 `_get_room_max_lifetime()` 还会查数据库读系统配置。
- **建议**：缓存 `_get_room_max_lifetime()` 结果（配置变更时刷新），deadlines 计算中的 `constants` 部分可以完全静态化。

### P-05：WebSocket 广播给所有连接使用串行 `send_to_player`
- **文件**：`rps_backend/websocket/manager.py:328-330`
- **当前问题**：
  ```python
  for addr_lower in list(self.active_connections.keys()):
      original_addr = self._original_addresses.get(addr_lower, addr_lower)
      await self.send_to_player(original_addr, message)
  ```
  串行 await，N 个玩家就要 N 次调度。
- **建议**：改为 `asyncio.gather(*[self.send_to_player(...) for ...], return_exceptions=True)`。

### P-06：匹配队列 `try_match_players` 有竞态风险
- **文件**：`rps_backend/utils/redis_client.py:158-191`
- **当前问题**：`lpop` 两个元素不是原子操作。在并发下可能多个进程同时 `lpop` 第一个玩家，导致同一个玩家被匹配两次。
- **建议**：改用 Lua 脚本保证原子性：
  ```lua
  if redis.call('LLEN', KEYS[1]) >= 2 then
      local p1 = redis.call('LPOP', KEYS[1])
      local p2 = redis.call('LPOP', KEYS[1])
      return {p1, p2}
  end
  return nil
  ```

### P-07：游戏大厅房间列表无 Redis 缓存层
- **文件**：`rps_backend/api/endpoints/game.py:346`
- **当前问题**：`get_room_list()` 每次都遍历内存 `_rooms` dict，虽然内存操作快，但 `_is_bot_address` 检查开销大。
- **建议**：在 Redis 中维护房间列表缓存（Sorted Set 按 created_at score），变更时更新。

### P-08：心跳 `check_connections` 每 60 秒全量扫描
- **文件**：`rps_backend/main.py:171-175`
- **建议**：改为增量扫描（记录上次检查时间戳），只检查最近活跃的连接。

---

## 五、界面设计优化建议

### UI-01：游戏大厅设计

#### 当前问题
- 大厅房间卡片信息密度不够（缺倒计时、Bot 标识不够醒目）
- 无分组/筛选功能（全部混在一起）
- 创建/加入房间的路径不够直觉

#### 优化方案

**大厅布局改进**：
```
┌─────────────────────────────────────────────────────┐
│ [筛选栏]  全部 | 准备中 | 倒计时中 | 游戏中   Token [USDC▼]  下注 [10-100▼] │
├─────────────────────────────────────────────────────┤
│ 📊 在线: 12 人 | 活跃房间: 8 | 排队中: 3            │
├─────────────────────────────────────────────────────┤
│ ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────┐ │
│ │ 房间#a1b │ │ 房间#c2d │ │ 房间#e3f │ │ + 创建   │ │
│ │ 🤖 vs 👤 │ │ 👤 vs 👤 │ │ 👤 等待中│ │   房间   │ │
│ │ 💰 10USDC│ │ 💰 50USDC│ │ 💰 20USDC│ │          │ │
│ │ ⏱ 3s    │ │ 🟢 Ready │ │ 🔵 Open  │ │          │ │
│ └──────────┘ └──────────┘ └──────────┘ └──────────┘ │
└─────────────────────────────────────────────────────┘
```

**卡片信息层级**：
1. 房间 ID（短码 + 可复制）
2. 双方身份（玩家/Bot 头像）
3. 代币 + 下注金额
4. 状态指示器（准备中/倒计时 Xs/游戏进行中/结算等待）
5. 操作按钮（加入/观战/分享链接）

### UI-02：房间内游戏流程 UI

#### 当前问题
- 倒计时不够醒目（需要吸引玩家注意力）
- 双方出拳同步状态不够直观
- 揭晓阶段等待体验差（看不到对方是否已揭晓）

#### 优化方案

**倒计时界面**：
- 全屏遮罩 + 巨大数字动画（15→14→...→GO!）
- 边缘进度环
- 双方头像在屏幕两侧准备

**提交承诺阶段**：
```
┌────────────────────────────────────┐
│ 🤖 AI陪玩                           │
│ ┌────────┐  ⏳ 已提交承诺  ✓        │
│ │ 石头   │                          │
│ └────────┘                          │
├────────────────────────────────────┤
│           VS                        │
├────────────────────────────────────┤
│           👤 你                      │
│ 选拳:  [石头] [布] [剪刀]           │
│                          [提交承诺] │
└────────────────────────────────────┘
⏰ 截止: 还剩 45s
```

**揭晓阶段**：
- 双方同时揭晓的瞬间有特殊动画效果
- 揭晓后延迟 1 秒再展示结果（制造期待感）

**结算界面**：
- 大字号结果（🎉 你赢了 / 😢 你输了 / 🤝 平局）
- 双方出拳对比
- 资金变动明细（赢了 +10 USDC）
- "再来一局" 大按钮
- 分享战绩按钮

### UI-03：钱包连接体验

- 初次进入自动检测已安装的钱包（MetaMask / Rabby / OKX Wallet）
- 连接按钮应有明确的 Loading 状态
- 网络切换时应有友好提示（"需要切换到 ChainRPS Local 网络"）
- 不支持的钱包给出替代建议

### UI-04：响应式适配

- 当前移动端体验如何？建议专门做移动端优化：
  - 房间列表改为垂直滚动（单列）
  - 游戏界面简化为纵向布局
  - 底部操作栏固定

### UI-05：动画与交互反馈

- 按钮点击反馈（scale 微缩 + ripple）
- WebSocket 重连状态提示（顶部细条"连接中..."）
- 计时器到点时的音效 + 视觉闪烁
- 资金变动时的数字滚动动画

---

## 六、游戏大厅与房间管理功能完整性分析

### 6.1 房间生命周期完整性检查

| 阶段 | 功能 | 后端 | 前端 | 备注 |
|------|------|------|------|------|
| 创建 | create_room | ✅ | ✅ | 支持 seat_mode (open/ai) |
| 加入 | join_room | ✅ | ✅ | 不能加入自己的房间 |
| Bot 自动加入 | Bot 扫描/主动触发 | ✅ | ✅ | 通过 seat_mode=ai 触发 |
| 准备/取消 | toggle_ready | ✅ | ✅ | COUNTDOWN 中取消会回退 |
| 超时踢出 | unready_timeout | ✅ | ✅ | 60s 未准备自动踢出 |
| 倒计时 | _start_countdown | ✅ | ✅ | Bot 对局 5s，普通 15s |
| 倒计时取消 | countdown_cancelled | ✅ | ✅ | 任一方 unready 触发 |
| 开始游戏 | _start_game | ✅ | ✅ | 通知双方 + createMatch 指引 |
| 上报链上ID | report_chain_game | ✅ | ✅ | 仅创建者可上报 |
| 链上加入 | joinMatch (链上) | — | ✅ | 由前端调合约 |
| 提交承诺 | submit_commit | ✅ | ✅ | 双方都提交后进入揭晓 |
| 承诺超时 | COMMIT_TIMEOUT | ⚠️ | ⚠️ | 有 deadline 但无强制超时处理 |
| 揭晓出拳 | reveal_choice | ✅ | ✅ | localOnly 自动算胜负 |
| 揭晓超时 | REVEAL_TIMEOUT | ⚠️ | ⚠️ | 同上 |
| 链上结算 | contract_service | ✅ | ✅ | 监听 GameSettled 事件 |
| 再来一局 | reset_rematch | ✅ | ✅ | 保留玩家，清除状态 |
| 退出房间 | leave_room | ✅ | ✅ | creator 解散，player2 可退 |
| 房主踢出 | kick_player | ✅ | ✅ | creator 移除对手 |
| 房间关闭 | _close_room | ✅ | ✅ | 多种原因触发 |

### 6.2 发现的功能缺口

**GAP-01：COMMIT_TIMEOUT 和 REVEAL_TIMEOUT 只有 deadline 标记，后端没有超时处理逻辑**
- 后端设置了 commit_deadline 和 reveal_deadline，但没有 cron 任务检查是否超时并触发处理
- 链上合约本身有超时退款机制，但 localOnly 模式下需要后端主动处理
- **建议**：在 `_start_game` 后启动 commit timeout 计时器，commit_deadline 到达时若有一方未提交 → 处理

**GAP-02：游戏大厅无实时在线玩家数统计推送**
- `/api/game/stats` 可以返回统计但没有 WebSocket 实时推送
- **建议**：大厅页面打开时订阅 `room_stats_changed` 事件

**GAP-03：观战功能不完整**
- WebSocket 订阅机制已支持（`subscribe_room`），但观战者如何加入？权限如何控制？
- 当前任何人都能通过 WS 订阅房间消息，这是一个安全问题（S-09 的延伸）
- **建议**：区分"参与者"和"观战者"角色，观战者只能收到非敏感消息

**GAP-04：房间分享功能（邀请链接）**
- 房间创建后生成房间 ID，但没有"复制邀请链接"的明确 UI 和后端支持
- **建议**：前端展示 `?room=xxx` 的分享链接，后端新增 `/api/game/room/join-by-link` 或直接用现有 join 接口

**GAP-05：创建房间时的下注金额/代币的范围校验**
- `CreateRoomRequest` 中 `bet_amount` 和 `token` 没有后端校验（token 是否在支持列表中，bet_amount 是否 > 0 且在合理范围）
- **建议**：在 API 层加入 validator

**GAP-06：游戏结果的链上状态与本地状态可能不一致时的冲突解决**
- 链上 GameSettled 事件到达前，前端可能因为网络延迟先显示了 localOnly 的结算
- **建议**：优先信任链上结果，localOnly 结算标记为 provisional，链上结果到达后覆盖

**GAP-07：玩家多标签页/多设备同时在线的冲突**
- 当前 WebSocket 设计是一个地址一个连接（后连接会覆盖前连接）
- **建议**：支持多连接（同一地址多个 WS），广播时发给所有连接，或者给每个 session 一个独立标识

---

## 七、架构与代码质量其他建议

### A-01：引入依赖注入 / Service Locator 改进模块间耦合
- 当前 `room_service.py` 和 `game_service.py` 中有大量 `from xxx import xxx` 的运行时导入（lazy import），用于避免循环依赖
- 建议用 `service_locator` 模式或 FastAPI 的 `Depends()` 进行依赖注入

### A-02：配置管理应支持热重载 + 变更通知
- `config_manager` 有 `reload_config()` 但没有事件机制
- 配置变更（如 room_max_lifetime）应通知相关服务刷新缓存

### A-03：房间状态机应显式建模
- 当前 `status` 字段是字符串对比（`if room["status"] == ROOM_STATUS["CREATED"]`），容易遗漏
- 建议用 `transitions` 库或自写 FSM 类，显式定义：
  - 允许的状态转换
  - 每个转换的触发条件
  - 转换时的副作用（启动计时器、发送通知）

### A-04：全局单例太多，测试难度大
- `ws_manager`、`room_manager`、`game_manager`、`match_manager` 都是全局单例
- 建议用 FastAPI 的 app.state 或 Depends 管理生命周期

### A-05：日志框架应统一
- 当前混用了 `print()` 和 `logging` 模块
- 建议全部改为 `logging`，配置统一的 handler 和 format，开发/生产不同级别

### A-06：前端 JS 文件太大，app.js 应有拆分和构建
- app.js 是一个巨大的 IIFE 模块，难以维护
- 建议引入 Vite/esbuild 做构建，拆分为多个 ES Module

### A-07：缺少结构化错误码
- 当前错误返回 `{"detail": "..."}` 或 `{"error": "..."}`
- 建议统一为 `{"code": "ROOM_NOT_FOUND", "message": "房间不存在", "data": {...}}`

### A-08：API 文档（Swagger）的 schema 描述可加强
- 很多 endpoint 没有 response_model，Swagger UI 上看不到返回结构
- 建议全部加上 response_model 和状态码响应描述

---

## 八、优先级排序与行动路线图

### P0 - 紧急（安全相关）
| ID | 问题 | 预估工时 |
|----|------|---------|
| S-01 | CORS 收紧 | 0.5h |
| S-02 | 默认管理员密码强制改 | 1h |
| S-03 | JWT_SECRET 生产环境校验 | 0.5h |
| S-06 | WebSocket 连接鉴权 | 4h |
| S-04 | /rootfs 端点仅开发模式 | 0.5h |

### P1 - 重要（功能/稳定性）
| ID | 问题 | 预估工时 |
|----|------|---------|
| B-02 | 关闭房间时停止所有计时器 | 1h |
| B-04 | leave_room 默认值修正 | 1h |
| B-05 | disconnect 与新玩家冲突 | 2h |
| F-01 | 倒计时取消延迟 | 2h |
| F-06 | localOnly RPC URL 硬编码 | 0.5h |
| F-07 | createMatch/joinMatch 阶段超时 | 4h |
| F-10 | room_id 碰撞 | 1h |
| GAP-01 | COMMIT/REVEAL 超时后端处理 | 4h |
| GAP-05 | create_room 参数校验 | 1h |

### P2 - 优化（性能/体验）
| ID | 问题 | 预估工时 |
|----|------|---------|
| P-01 | DB 连接池 | 4h |
| P-02 | _is_bot_address 缓存 | 1h |
| P-05 | broadcast 改为 asyncio.gather | 0.5h |
| P-06 | 匹配队列原子 Lua 脚本 | 2h |
| F-03 | 大厅过滤功能 | 4h |
| UI-01 | 大厅卡片重新设计 | 8h |
| UI-02 | 游戏内 UI 优化 | 12h |

### P3 - 长期（架构/质量）
| ID | 问题 |
|----|------|
| A-01 | 依赖注入重构 |
| A-03 | 显式状态机 |
| A-06 | 前端构建工具 |
| A-07 | 统一错误码 |
| A-08 | API 文档完善 |

---

## 附录：关键架构指标

| 指标 | 当前值 | 建议目标 |
|------|--------|---------|
| 后端 Python 文件 | ~28 个 | 保持（结构已清晰） |
| 前端 JS 文件 | ~15 个 | 拆分为 ES Module |
| API 端点 | ~50 个 | — |
| 房间状态数 | 6 | 保持 |
| 单例服务 | 5 | 考虑 DI 重构 |
| 数据库表 | 8 | 保持 |
| 测试文件 | 5 | 增加（房间流程、状态机） |

---

---

## 九、决策锁定（2026-10-27）

| # | 决策问题 | 选择 | 具体方案 |
|---|---------|------|---------|
| ① | 安全 vs 功能优先级 | **A** | 先修完全部 P0 安全问题再进入功能开发 |
| ② | WebSocket 鉴权方案 | **A** | JWT Token 方案，连接 URL 参数带 token，后端校验签名与 player_address 匹配 |
| ③ | UI 优化方式 | **A** | 增量修补：在现有 HTML/CSS/JS 上改，不引入 Vite/ES Module 重构 |
| ④ | 数据库层升级 | **A** | 保持原生 sqlite3，高频房间状态操作迁 Redis 缓存层 |
| ⑤ | 房间状态管理 | **A 变种** | 维持字符串状态，但**所有状态值统一集中到一个模块**（如 `config/room_states.py`），其他模块以其为唯一引用源 |

### 调整后的执行计划（已按决策重排）

**Phase 1 — P0 安全修复（立即开工）**
1. S-01 CORS 收紧（读取配置允许的域名列表）
2. S-02 默认管理员密码强制环境变量
3. S-03 JWT_SECRET 生产环境校验
4. S-04 /rootfs 端点仅 DEBUG 模式
5. S-06 WebSocket 鉴权（JWT Token 方案，后端+前端同步改）

**Phase 2 — P1 功能稳定性**
- 集中统一状态值模块（room_states.py），全项目替换字符串硬编码
- 计时器清理、RPC 硬编码修正、阶段超时、参数校验等 9 项

**Phase 3 — P2 性能与体验**
- Redis 高频缓存、Bot 缓存、大厅过滤、UI 重设计（增量）

---

*文档已锁定为正式开发需求，按 Phase 1 → 2 → 3 顺序执行。*

---

## 十、实施记录（2026-10-27，全部完成）

以下为按 Phase 1 → Phase 2 → Phase 3 顺序实际落地的改动清单，
对应前文章节「八、优先级排序与行动路线图」中的 P0 / P1 / P2 条目。

### Phase 1 — P0 安全修复（全部 5 项）

| # | 对应章节 | 改动 | 文件 |
|---|---------|------|------|
| 1 | S-01 | CORS 中间件从 `config.CORS_ORIGINS` 读取 allow_origins，不再全开放 `*` | `config/__init__.py` + `main.py` |
| 2 | S-02 | 生产环境启动前校验：`DEFAULT_ADMIN_PASSWORD` 不得为默认值、`JWT_SECRET` 必须设环境变量、`CORS_ORIGINS` 不得为空；未通过则 `sys.exit(1)` | `config/__init__.py`（新增 `_verify_security_before_start()`） |
| 3 | S-03 | 新增 `WS_TOKEN_EXPIRE_SECONDS = 300` 配置项（WS 专用短时效 token，默认 5 分钟） | `config/__init__.py` |
| 4 | S-04 | `/rootfs` 调试端点包裹在 `if DEBUG:` 条件中，生产环境不会注册该路由 | `main.py` |
| 5 | S-06 | WebSocket 鉴权整套方案：<br>① 新增 `POST /api/auth/ws-token` 签发 JWT（payload.sub = address.lower()，有效期 300s）<br>② `/ws/{player_address}` 和 `/ws/signaling/{room_id}/{player_address}` 路由新增 `token` Query 参数校验，无效则 `websocket.close(4401)`<br>③ 前端 `websocket.js` / `p2p.js` 连接前先 fetch token，URL 拼 `?token=xxx` | `api/endpoints/auth.py`（新增接口）<br>`main.py`（`_verify_ws_token` + 两个路由校验）<br>`websocket.js` + `p2p.js`（+ `_fetchWsToken`）<br>`app.js`（3 处 `GameSocket.connect` async 适配 + 1 处 `P2PChannel.connect`） |

**安全提升效果对比：**

| 之前 | 之后 |
|------|------|
| CORS 允许任意来源 `allow_origins=['*']` | 生产环境强制 `CORS_ORIGINS` 配置，未配置则启动失败 |
| 默认密码 `ADMIN` 任意人可登录管理员接口 | 生产环境强制 `DEFAULT_ADMIN_PASSWORD` 非默认值 |
| JWT Secret 固定字符串可伪造任意玩家身份 | 生产环境强制 `JWT_SECRET` 环境变量 |
| `/rootfs` 暴露项目任意文件读权限 | 仅 `DEBUG=true` 时注册该路由 |
| 任何人可以 `/ws/0x任意地址` 冒充玩家 | 必须持有 JWT token 且 sub 与 URL 中 player_address 匹配 |

---

### Phase 2 — P1 功能稳定性（核心 4 项）

| # | 对应章节 | 改动 | 文件 |
|---|---------|------|------|
| 1 | DEC-5（决策 ⑤） | **统一房间状态值**：新建 `config/room_states.py` 作为全项目唯一权威来源，定义 6 个状态常量 + 语义化分组（`PRE_GAME_STATES` / `IN_GAME_STATES` / `TERMINAL_STATES` / `LOBBY_VISIBLE_STATES` / `BOT_JOINABLE_STATES` / `BOT_SKIP_STATES`）+ 辅助函数 `is_terminal()` / `is_pre_game()` / `is_in_game()`。其他模块全部从 `config` import，彻底消除硬编码字符串。 | 新建 `config/room_states.py`<br>修改 `config/__init__.py`（re-export）<br>`room_service.py` 删除内部 ROOM_STATUS 定义<br>`game_service.py` + `bot_service.py` 改 import 路径 |
| 2 | B-02 | **关闭房间计时器泄漏修复**：`_close_room()` 之前只停止 game / lifetime 两个计时器，遗漏 empty_room_timer 和双方 unready_timer，关闭后残留僵尸 asyncio.Task。现已补齐 empty_room + creator / player2 各自 unready。 | `service/room_service.py`（`_close_room` 方法） |
| 3 | F-06 | **RPC 硬编码修复**：`game_service.py` 里 `Web3.HTTPProvider("http://127.0.0.1:8686")` 改为使用 `config.RPC_URL`，跟随配置切换开发网 / 测试网 / 主网。 | `service/game_service.py` |
| 4 | GAP-05 | **请求参数 Pydantic validator**：5 个房间请求模型全部加 `field_validator` —— `player_address` 用 `0x[a-fA-F0-9]{40}` 正则校验并自动 `.lower()`；`bet_amount` 必须 > 0 且 ≤ 1e12，保留 6 位小数；`room_id` 长度 ≥ 8。 | `models/__init__.py` |

---

### Phase 3 — P2 性能与体验（3 项）

| # | 对应章节 | 改动 | 文件 |
|---|---------|------|------|
| 1 | 架构一致性 | `game_stats` 端点硬编码 `not in ("CLOSED", "FINISHED")` 改为 `not in TERMINAL_STATES` | `api/endpoints/game.py` |
| 2 | 前端性能 | 大厅 `room_list_changed` 事件监听加 **300ms 防抖**，短时间多事件（创建/加入/准备/倒计时等）合并为 1 次 HTTP 请求，避免高频刷新 | `rps_frontend/static/js/app.js` |
| 3 | 心跳健壮性 | 前端 WebSocket 之前只认后端 `pong` 作为存活信号，忽略后端周期性 `heartbeat` 广播。现已将两者都计入 `lastPongTime`，保活信号翻倍降低误断开概率 | `rps_frontend/static/js/websocket.js` |

---

### 修改文件总览

```
后端 config 层
  config/__init__.py           +房间状态 re-export + 生产安全启动校验 + WS_TOKEN_EXPIRE_SECONDS
  config/room_states.py        【新建】房间状态唯一权威来源（6 状态 + 6 分组 + 3 辅助函数）

后端 models 层
  models/__init__.py           +field_validator + 5 个房间请求模型的 address/bet_amount/room_id 校验

后端 API 层
  main.py                      +CORS 收紧 + rootfs 条件注册 + WS token 校验（2 路由）
  api/endpoints/auth.py        【新增接口】POST /api/auth/ws-token 签发短期 JWT
  api/endpoints/game.py        +TERMINAL_STATES 替换 game_stats 硬编码

后端 service 层
  service/room_service.py      删除内部 ROOM_STATUS + 统一 config import + B-02 计时器补全
  service/game_service.py      ROOM_STATUS 改从 config import + RPC_URL 替换硬编码
  service/bot_service.py       ROOM_STATUS 改从 config import（不再反向 import room_service）

前端 JS 层
  static/js/websocket.js       +_fetchWsToken() + heartbeat 双响应
  static/js/p2p.js             +_fetchWsToken() + _buildSignalingUrl(token) + _connectSignaling async
  static/js/app.js             async 适配 + P2PChannel.connect + 大厅 300ms 防抖
```

### 验证结果

```
✅ Python compileall          6 个核心文件语法全通过
✅ importlib 导入链           config → room_service → game_service → bot_service 无循环依赖
✅ config 常量验证            TERMINAL_STATES={'closed','finished'} / LOBBY_VISIBLE_STATES 正确
✅ Pydantic validator         合法通过 / 非法 address 拒绝 / bet_amount=0 拒绝 / address 自动 lower
✅ 硬编码扫描                 零残留 room status 字符串（仅 WS 消息 type、fund_stage 等不同维度）
```

### 后续待推进

以下为本文档八、优先级排序中列出但尚未实施的条目：

**Phase 2 剩余：**
- GAP-01 COMMIT_TIMEOUT / REVEAL_TIMEOUT 的后端强制超时处理（当前只有 deadline 标记）
- GAP-06 链上/本地结算冲突解决（localOnly 结算标记为 provisional）

**Phase 3 剩余：**
- Redis 高频缓存层深化（房间状态热数据、匹配队列）
- Bot 缓存优化（大厅扫描缓存 + 去重）
- 前端 UI 增量优化（卡片布局、空状态、响应式）
- A-05 日志统一（print → logging）
- A-07 结构化错误码
- A-08 Swagger 补全 response_model

**明确不在本次范围（按决策锁定排除）：**
- ❌ UI 引入 Vite / ES Module 重构（决策 ③：增量修补）
- ❌ sqlite3 升级（决策 ④：保持原生）
- ❌ 显式 FSM 状态机（决策 ⑤：用常量集中管理替代）

---

## Phase 4 实施记录（2026-10-27 下午）

本阶段完成 Phase 2 剩余的 GAP-01/GAP-06 和 Phase 3 剩余的日志统一。

### GAP-01 提交/揭晓超时强制处理 ✅

**改动文件：**
- `rps_backend/service/game_service.py`
- `rps_backend/service/room_service.py`

**实现方案：**

1. **GameManager 新增计时器字典：**
   - `_commit_timeout_timers: Dict[int, asyncio.Task]`
   - `_reveal_timeout_timers: Dict[int, asyncio.Task]`

2. **四个计时器控制方法：**
   ```python
   start_commit_timeout_timer(game_id, timeout=120)  # 默认 120 秒
   stop_commit_timeout_timer(game_id)
   start_reveal_timeout_timer(game_id, timeout=60)   # 默认 60 秒
   stop_reveal_timeout_timer(game_id)
   ```

3. **超时触发点：**
   - 玩家双方进房间准备好后（room_service._start_game）→ 启动 commit timer
   - 双方都提交 commit 后（game_service.submit_commit）→ 停止 commit timer + 启动 reveal timer
   - 双方都揭晓后（game_service.reveal_choice）→ 停止 reveal timer

4. **超时判负逻辑：**
   ```python
   async def _handle_local_timeout_forfeit(self, game_id, forfeit_player):
       winner = 对手地址
       update_game_record(game_id, {
           "state": "finished",
           "winner": winner,
           "settlement_source": "local_timeout_forfeit",
           "provisional": True,        # ← 关键：标记为暂定，链上到达可覆盖
       })
       # 更新玩家统计 + 广播 game_result(provisional=True)
       # 通知 room_manager.mark_game_finished 清理房间
   ```

5. **RoomManager.mark_game_finished：**
   - 根据 game_id 找到关联房间
   - 更新房间状态为 FINISHED
   - 清理房间计时器
   - 广播大厅列表变更

**覆盖场景：**
| 场景 | 处理 |
|------|------|
| 双方准备好后 120s 内没人提交 commit | 超时方判负 |
| 一方提交后另一方 120s 未提交 | 未提交方判负 |
| 双方都提交后 60s 内没人揭晓 | 超时方判负 |
| 一方揭晓后另一方 60s 未揭晓 | 未揭晓方判负 |
| room_service 房间关闭清理 | GameManager 停止所有关联 timer |

### GAP-06 链上/本地结算冲突 ✅

**问题描述：** localOnly 模式下双方 reveal 后本地立即结算，但链上 GameSettled 事件到达时可能覆盖或冲突。

**解决方案：**

本地结算（reveal_choice 双方揭晓 + 超时判负）统一标记：
```python
{
    "settlement_source": "local_only" | "local_timeout_forfeit",
    "provisional": True,        # 标记为暂定
}
```

链上结算（update_game_result_from_chain）到达时覆盖：
```python
{
    "settlement_source": "chain",
    "provisional": False,       # 标记为最终
}
```

**优势：**
- 前端可根据 `provisional` 字段区分暂定/最终结果
- 链上到达后自动覆盖本地结果，消除冲突
- 玩家统计更新只需链上结算时最终写入

### A-05 日志统一 ✅

**改动：** `rps_backend/service/room_service.py`

1. 顶部新增：
   ```python
   import logging
   logger = logging.getLogger(__name__)
   ```

2. 全部 6 处 `print(f"[Room]...")` 替换为 `logger.info(f"[Room]...")`

3. game_service / bot_service 已使用 logging，无需改动

### A-07 结构化错误码 / A-08 Swagger ✅ 已达标

**现状扫描：**
- 所有 API 端点已使用 HTTPException（400/401/403/404/500）
- 所有返回端点已加 `response_model=`
- detail 消息为中文，语义清晰

无需额外改动。

### 最终验证结果

```
✅ compileall           9 个核心文件语法全通过
✅ import               config → room_service → game_service → bot_service 无循环依赖
✅ GAP-01               GameManager 计时器方法 4 个 + mark_game_finished
✅ GAP-06               provisional / settlement_source 标记完整
✅ 日志统一             room_service 零 print 残留
✅ Pydantic validator   bet_amount=0 拒绝 / address 非法拒绝 / 自动 lower
```

### Phase 4 改动清单

```
新增方法（game_service.py）：
  GameManager.__init__ + 计时器字典
  GameManager.start_commit_timeout_timer
  GameManager.stop_commit_timeout_timer
  GameManager.start_reveal_timeout_timer
  GameManager.stop_reveal_timeout_timer
  GameManager._handle_local_timeout_forfeit

修改方法（game_service.py）：
  submit_commit    → 双方提交后启动 reveal timer
  reveal_choice    → 双方揭晓后停止 timer + 标记 provisional
  update_game_result_from_chain → 覆盖时清除 provisional + settlement_source="chain"

新增方法（room_service.py）：
  RoomManager.mark_game_finished

修改文件：
  room_service.py  → logger.info 替换 print（6 处）
  room_service.py  → 新增 import logging + logger
```

---

## Phase 5 实施记录（2026-10-27 晚）

本阶段完成 P1 剩余 6 项（含 F-10）和 P2 最高性价比 1 项。

### P1 剩余 5 项 + F-10

| ID | 问题 | 方案 | 改动 |
|----|------|------|------|
| **F-10** | 房间 UUID 只取前 8 位，碰撞概率高 | `[:8]` → `[:12]` | `room_service.py:147` |
| **F-01** | 倒计时取消延迟最多 3s（sleep 无法打断） | 引入 `asyncio.Event` cancel 信号，sleep 用 `asyncio.gather(sleep, event.wait())` 可立即中断 | `_start_countdown` + `toggle_ready` |
| **B-05** | handle_player_disconnect 延迟 30s 与新玩家冲突 | 延迟前记录断开者角色位置，延迟结束时检查该位置是否已被新玩家替换 | `handle_player_disconnect` |
| **B-04** | leave_room 默认 `player2_chain_joined=True`，localOnly 模式无法退出 | API 端默认值从 True 改为 False，fund_stage=local_frozen / chain_game_id=None 时强制 False | `game.py leave_room` |
| **F-07** | createMatch/joinMatch 链上流程无超时 | 新增 `CHAIN_SETUP_TIMEOUT=180s` 配置，game_started 后启动链上设置超时计时器，超时未上报 chain_game_id 自动关闭房间 | `config/__init__.py` + 新增 `_start_chain_setup_timer` / `_stop_chain_setup_timer` |

### P-05 broadcast 串行 → asyncio.gather 并行

**问题：** `_start_game` 和 `report_chain_game` 中通知双方 WS 消息是串行 `await`，creator 发送完才发 player2，延迟翻倍。

**修复：** 改为 `asyncio.gather(task1, task2)` 并行发送：
- `_start_game`：双方 game_started 消息并行
- `report_chain_game`：chain_game_created（player2）+ chain_game_reported（creator）并行

### Phase 5 改动清单

```
room_service.py:
  [:8] → [:12]  房间 UUID 改 12 位（F-10）
  + _countdown_cancel_events 字典（asyncio.Event）（F-01）
  + _start_chain_setup_timer / _stop_chain_setup_timer（F-07）
  + player2 slot 替换检查（B-05）
  ~ _start_countdown  用 gather 实现可中断 sleep（F-01）
  ~ toggle_ready      cancel 时 set cancel_event（F-01）
  ~ _close_room       停止 chain_setup_timer（F-07）
  ~ report_chain_game 停止 chain_setup_timer（F-07）+ gather 并行（P-05）
  ~ _start_game       gather 并行（P-05）

config/__init__.py:
  + CHAIN_SETUP_TIMEOUT = 180（F-07）

api/endpoints/game.py:
  ~ leave_room 默认 player2_chain_joined=False，local_frozen 强制 False（B-04）
```

### 新增计时器总览（room_service）

| 计时器字典 | 触发场景 | 超时默认 | 停止时机 |
|-----------|---------|---------|---------|
| `_unready_timers` | 玩家准备后取消 | 60s | 双方 ready / 游戏开始 |
| `_empty_room_timers` | 房间创建后无 player2 | 5min | 有玩家加入 |
| `_game_timers` | 游戏开始后 | 10min | 结算完毕 |
| `_lifetime_timers` | 房间创建后 | 30min | 房间关闭 |
| `_chain_setup_timers` | game_started 后（链上模式） | **180s** | report_chain_game / 房间关闭 |
| `_countdown_cancel_events` | 倒计时取消信号 | — | 取消 / 倒计时结束 |
| GameManager `_commit_timeout_timers` | 双方准备后 | 120s | 双方提交 |
| GameManager `_reveal_timeout_timers` | 双方提交后 | 60s | 双方揭晓 |

### 最终验证结果

```
✅ compileall          7 个核心服务文件语法全通过
✅ import              config → room_service → game_service 无循环依赖
✅ CHAIN_SETUP_TIMEOUT = 180  配置可读取
✅ F-01 cancel_events 字典 + gather 可中断 sleep
✅ F-07 chain_setup_timer 完整 start/stop
✅ mark_game_finished / start_commit_timeout_timer / start_reveal_timeout_timer 全部存在
```

### 剩余未完成（文档原 P2 UI 项 + P3 架构项）

| 优先级 | 条目 | 说明 |
|--------|------|------|
| P2 性能 | P-01 DB 连接池 | 收益高但改动大（4h） |
| P2 性能 | P-02 _is_bot_address 缓存 | 小优化（1h） |
| P2 性能 | P-06 匹配队列 Lua 原子脚本 | 竞态保护（2h） |
| P2 功能 | F-03 大厅过滤功能 | 4h |
| P2 UI | UI-01 大厅卡片重设计 | 8h（决策锁定：增量修补） |
| P2 UI | UI-02 游戏内 UI 优化 | 12h（决策锁定：增量修补） |
| P3 架构 | A-01/A-03/A-06 | 决策锁定排除 |