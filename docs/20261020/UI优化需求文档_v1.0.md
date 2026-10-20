# ChainRPS 前端 UI 长期优化需求文档

| 版本 | 日期 | 作者 | 说明 |
|------|------|------|------|
| v1.0 | 2026-10-20 | — | 初版整理，供审阅 |

---

## 一、文档定位

本文档不是"改 UI 好看一点"的零散意见，而是基于当前项目代码现状（原生 HTML+CSS+JS、theme.css 变量系统、FWUI 组件雏形、亮/暗双主题、响应式布局），参考 Uniswap Interface、ETHGlobal DEX 最佳实践、NEXUS DEX、Hyperscalper、BuidlGuidl RPS 等项目后，整理的**长期可落地、通用、简洁**的 UI 优化需求清单。

每一条需求都标注了改动范围、影响面、技术约束和验收标准。审阅通过后按优先级分批实施。

---

## 二、现状盘点

| 维度 | 现状 | 优点 | 问题 |
|------|------|------|------|
| 技术栈 | 原生 HTML+CSS+JS，无框架 | 零依赖、加载快、可控性强 | 组件复用靠复制粘贴，没有约束 |
| 主题系统 | theme.css 双主题 + CSS 变量 | 已有亮/暗切换，变量粒度细 | 暗色主题 primary 降成灰，与亮色差距太大；变量名缺语义层 |
| 组件库 | FWUI 下有 button/input/modal/toast | 方向对，已有雏形 | 散落各 JS 文件扩展，没有收敛约束；缺失 confirm/skeleton/card/tabs |
| 响应式 | style.css 内有断点 | 部分页面可用 | 各页面断点策略不一致，没有统一骨架 |
| 交互反馈 | Toast/Modal 已有 | — | Confirm（资金类二次确认）缺失；空状态/加载状态/错误状态不规范 |
| 动画 | 游戏流程靠 JS 拼接 CSS 类 | — | 分散，无统一命名，后续不好维护 |
| 数字展示 | 默认 sans-serif | — | 金额/倒计时频繁变化时宽度抖动 |

---

## 三、需求清单（按层级分组）

### 📦 层级 A：工程/技术债层（P0，最优先，做对了后面才能快速改）

#### A-01 FWUI 组件库收敛为 7 件套

**现状**：FWUI/ 目录下有 button.js、input.js、modal.js、toast.js，但实际使用中各页面（app.js、admin.js 等）自行扩展了样式和逻辑，没有约束。

**目标**：收敛为 7 个标准化组件，每个组件 = theme.css 变量 + FWUI/xxx.js 实现 + 使用文档注释。新页面必须复用，不得自行扩展。

| 组件 | 核心职责 | 必须支持的变体 |
|------|---------|---------------|
| Button | 主按钮，含 5 种状态机 | state="idle/loading/approved/error/success"，variant="primary/ghost/danger" |
| Input | 输入框 | type="amount"（自动右对齐+等宽数字）、type="address"（校验+自动补零）、type="text" |
| Modal | 弹窗 | variant="default"（普通）、variant="confirm"（二次确认，资金操作专用） |
| Toast | 轻提示 | type="info/success/error"，自动消失，可配置 duration |
| Card | 通用卡片 | .card-game-room（游戏房间）、.card-info（信息块） |
| Tabs | 标签切换 | 历史/统计/设置通用 |
| Skeleton | 骨架屏 | .skeleton-line / .skeleton-block / .skeleton-card，CSS 动画 |

**验收标准**：
- [ ] 7 个组件全部写入 FWUI/ 目录
- [ ] 每个组件顶部有 5 行以内的 JSDoc 使用说明
- [ ] 所有现有页面从"自行实现"迁移为"调用组件"
- [ ] 控制台无 404、无重复的事件绑定

---

#### A-02 CSS 变量增加语义化别名层

**现状**：theme.css 里定义了 `--primary-color`、`--bg-card` 等基础变量，但组件 CSS 直接引用这些基础名，未来想加第三套主题或微调某个组件颜色时，需要到处找具体变量名。

**目标**：在 theme.css 中增加一层"语义别名"，把"设计色板"和"组件语义"解耦。

**示例**：
```css
/* 基础变量（设计色板）—— 保留不变 */
--primary-color: #ff6b35;

/* 新增语义别名 —— 组件 CSS 应该引用这些 */
--btn-bg-primary:        var(--primary-color);
--btn-text-primary:      var(--text-inverse);
--card-bg:               var(--bg-card);
--card-border:           var(--border-color);
--text-heading:          var(--text-primary);
--text-body:             var(--text-secondary);
--text-label:            var(--text-tertiary);
--success-bg:            var(--success-light);
--success-text:          var(--success-color);
```

**验收标准**：
- [ ] theme.css 在亮色/暗色主题中各增加一套语义别名（约 20-30 个）
- [ ] style.css 和各页面 CSS 逐步从基础变量迁移为语义别名
- [ ] 未来若要换主色（如蓝色主题），只需改 `--primary-color` 一处即可

---

#### A-03 通用小交互统一使用 data-* 属性

**现状**：复制地址、切换主题、展开 dropdown 等小功能，JS 用 `document.querySelector('#xxx')` 写死选择器。

**目标**：所有"一次绑定、多次使用"的小交互统一声明为 `data-*` 属性，JS 只写一次事件委托。

**约定清单**：
| 属性 | 触发行为 | 示例 |
|------|---------|------|
| `data-copy` | 点击复制元素内容 | `<span data-copy>0x1234...abcd</span>` |
| `data-toggle-theme` | 点击切换亮/暗主题 | `<button data-toggle-theme>🌙</button>` |
| `data-dropdown` | 点击切换 dropdown 显隐 | `<div data-dropdown="wallet">...</div>` |
| `data-confirm` | 点击弹出确认 Modal | `<button data-confirm="确定下注 10 USDC？">下注</button>` |
| `data-number` | 自动等宽数字格式化 | `<span data-number>1234.56</span>` |

**验收标准**：
- [ ] 新增一个 `FWUI/interactions.js` 统一处理所有 `data-*` 事件
- [ ] 所有现有小交互迁移为 data-* 形式
- [ ] 新页面添加复制/主题切换等功能时，只需加属性，不写 JS

---

### 🎨 层级 B：交互模式层（P1，用户感知最强）

#### B-01 主按钮状态机统一

**现状**：按钮状态靠 JS 动态改 class，没有统一规范，每个按钮自己维护自己的状态。

**目标**：所有主按钮（Connect Wallet / Approve / Join Room / Play / Submit）统一走 5 态状态机：

| state | 视觉 | 行为 | 适用场景 |
|-------|------|------|---------|
| idle | 主色背景，可点击 | 正常触发 onClick | 默认状态 |
| loading | 禁用态 + 内嵌 Spinner | 自动禁用 onClick，Spinner 不阻塞事件 | 网络请求中、链上交易 pending |
| approved | 次要色背景（如灰） | 可点击，但视觉提示"已执行完毕" | Approval 完成后，等待 Swap |
| error | 红底 + 错误文字 | 点击时触发 `onError` 回调 | 余额不足、网络错误、Gas 过低 |
| success | 绿底 + ✓ 图标 | 1.5s 后自动切回 idle 或 approved | 交易成功 |

**验收标准**：
- [ ] theme.css 定义 5 种 state 的 CSS
- [ ] FWUI/button.js 封装 `setState()` 方法
- [ ] 至少覆盖 4 个场景：Connect / Approve / JoinRoom / Play

---

#### B-02 列表页面三态规范（空/加载/错误）

**现状**：房间列表、历史记录、排行榜在"没有数据"时直接空白或显示 `-`。

**目标**：所有列表型页面必须实现三态：

| 状态 | 视觉 | 触发条件 |
|------|------|---------|
| Empty（空） | 大 emoji + 引导语 + 操作按钮（如"去创建房间"） | 数据长度 = 0 |
| Loading（加载） | Shimmer 骨架屏（灰块 + 渐变闪烁动画） | 数据请求中 |
| Error（错误） | 红/黄提示 + 错误码 + 重试按钮 | 请求失败、超时 |

**验收标准**：
- [ ] FWUI/skeleton.js 提供骨架屏生成器
- [ ] FWUI/ 提供 `showEmptyState()` / `showLoadingState()` / `showErrorState()` 三个函数
- [ ] 至少覆盖 3 个列表：房间大厅、历史对局、Bot 列表

---

#### B-03 等宽数字 + 右对齐

**现状**：金额、赔率、倒计时、Gas 价格用默认 sans-serif，数字变化时宽度抖动。

**目标**：所有频繁变化的数字统一使用等宽字体 + 右对齐 + tabular-nums。

**验收标准**：
- [ ] theme.css 新增 `.number-mono` class
- [ ] 引入 JetBrains Mono（或使用系统 Consolas/Menlo 作为 fallback）
- [ ] 以下场景全部应用：余额、下注金额、赔率、倒计时、Gas、手续费

---

### 🎭 层级 C：视觉/动画层（P2，体验增强）

#### C-01 暗色主题重做

**现状**：暗色主题 primary=#6b7280（灰）、accent=#4b5563（灰），和亮色活力橙紫差太大，不是一套独立风格，而是"降饱和版的亮色"。

**目标**：暗色主题定位为"专业/竞技/沉浸"风格，使用霓虹发光色：

| 变量 | 亮色（保留） | 暗色（重做） |
|------|-------------|-------------|
| --primary-color | #ff6b35 活力橙 | #22d3ee 霓虹青 |
| --accent-color | #7c3aed 紫 | #a78bfa 淡紫 |
| --bg-primary | #fff8f0 暖白 | #0f1117 深黑 |
| 背景纹理 | 无 | 微网格（1px 线，2% opacity） |
| 卡片效果 | 暖阴影 | border + hover 发光 |

**验收标准**：
- [ ] 暗色主题变量全部按新值写入 theme.css
- [ ] 不影响亮色主题的任何样式
- [ ] 游戏卡片 hover 时边框发光可见

---

#### C-02 游戏竞态动画规范

**现状**：Play → Reveal 流程动画散落在各 JS 文件中，靠拼接 `animate.css` 类。

**目标**：统一命名、全部纯 CSS 实现、关键帧中只改 transform/opacity（性能好）：

| 阶段 | 动画 | 实现 |
|------|------|------|
| 倒计时 | 数字放大 + 抖动 | `.anim-countdown { animation: countdown 1s ease-in-out; }` |
| 选择中 | 3 个猜拳图标呼吸循环 | `.anim-breathing { animation: breathing 2s infinite; }` |
| Reveal | 结果卡片 3D 翻转 | `.anim-flip { transform-style: preserve-3d; animation: flip 0.8s; }` |
| 结算 | 赢家绿发光 + 输家轻微下沉 | `.anim-win { box-shadow: 0 0 20px var(--success-color); }` |

**验收标准**：
- [ ] style.css 末尾新增 `.anim-*` 动画类集合
- [ ] 游戏流程只引用动画类名，不自己写 keyframe
- [ ] 所有动画 duration ≤ 1s，不阻塞交互

---

#### C-03 Header 用户信息三级置顶模式

**现状**：钱包连接后信息塞在 header-right 一行，小屏挤爆。

**目标**：Header 固定高度 48px，三级信息单行不换行：

```
[Logo]  [Chain Status Dot+Text]  [Wallet Avatar] [Balance] [Network Tag] [Theme Toggle]
                                       ↑              ↑           ↑
                                   ellipsis     点击弹出    点击弹出
                                               Dropdown   Network List
```

**验收标准**：
- [ ] Header 高度固定 48px
- [ ] Balance 超长时 text-overflow: ellipsis
- [ ] Mobile (< 768px) 时 Header 压缩为 Logo + Avatar + Burger Menu
- [ ] 用户信息永远可见，游戏区域不会遮挡 Header

---

### 🏗️ 层级 D：布局/工程层（P2，影响面大，按需推进）

#### D-01 统一骨架布局：三栏 → 两栏 → 单列

**现状**：各页面布局自己写，响应式策略不一致。

**目标**：一套骨架覆盖所有页面：

```
Desktop (≥1200px)  →  Sidebar + Main + Context Panel（三栏）
Tablet  (768-1200) →  Sidebar(折叠) + Main（两栏）
Mobile  (<768px)   →  Bottom Nav + Main（单列 + 底部导航）
```

**验收标准**：
- [ ] style.css 新增 `.layout-grid` 骨架类 + `@media` 断点
- [ ] Sidebar / Main / Context Panel 的宽度、间距、padding 全部用 CSS 变量
- [ ] 后续新增页面（stats、leaderboard）直接套用骨架

---

#### D-02 版本化 CSS 资源（已有，保持）

**现状**：`<link rel="stylesheet" href="theme.css?v=20261004j">` 带版本号，很好。

**建议**：每次发版把 `v=` 参数改成 commit short hash（如 `v=a1b2c3d`）或版本号（如 `v=1.0.33`），避免浏览器缓存旧 CSS。

**验收标准**：
- [ ] 每次 PR 合并前，自动更新 HTML 中 CSS/JS 的 `v=` 参数
- [ ] 可由一个简单的 Python 脚本自动完成（可选）

---

## 四、优先级与依赖关系

```
P0（必须先做，无依赖）
 ├─ A-01 FWUI 收敛 7 件套
 ├─ A-02 CSS 语义化别名
 └─ A-03 data-* 统一交互

P1（依赖 P0 完成组件/变量基础）
 ├─ B-01 主按钮状态机
 ├─ B-02 列表三态规范
 └─ B-03 等宽数字

P2（依赖 P0/P1 交互模式稳定后）
 ├─ C-01 暗色主题重做
 ├─ C-02 游戏竞态动画
 ├─ C-03 Header 三级置顶
 ├─ D-01 统一骨架布局
 └─ D-02 版本化资源（保持即可）
```

---

## 五、DEX 最佳实践增量项（来源：ethereum.org DEX Design Best Practice，2025-10-21 更新）

> 确定性高、稳定、风险较小、可立即落地的通用 Web3 交互模式。

| 编号 | 建议 | 改动点 | 风险 | 依据 |
|------|------|--------|------|------|
| **E-01** | **下注表单四角信息补齐**：余额、Max 按钮、法币等值、赔率影响 | 创建/加入房间弹窗：金额输入框下方显示 Max 按钮 + 法币等值，右侧显示赔率变化 | 极低 | 文档"需包含的关键信息" |
| **E-02** | **主按钮兼作错误解释器**：余额不足→按钮直接显示"余额不足·需充值 50 USDC"；网络不对→"切换到本地链" | `app.js` 中 ConnectWallet / CreateRoom / JoinRoom 调用链，FWUI.Button.error(textOverride) 已就绪 | 低 | 文档"按钮作为上下文帮助" |
| **E-03** | **多步交易步进器**：approve→deposit→join 显示 "交易 1/2 授权中 ✓ → 交易 2/2 存款中 ⏳" | Toast 或 Modal footer 内的步进 DOM | 低 | 文档"不要独立 Approval 按钮" |
| **E-04** | **百分比快速下注按钮**：25% / 50% / 75% / MAX 一排 | 金额输入框右侧追加一排小按钮，点击自动按余额比例填数 | 极低 | 文档"加速器"概念 |
| **E-05** | **交易预览模态框**：approve 前弹出预览（房间ID/对手/下注/赔率/Gas） | FWUI.Modal 包一层预览模板 | 中 | 文档"预览屏幕迫使用户确认" |
| **E-06** | **详情信息手风琴折叠**：房间详情（完整地址/押金分解/时间限制）默认折叠 | HTML+CSS：加 `.accordion-header` 和过渡动画 | 极低 | 文档"专业信息手风琴藏" |
| **E-07** | **代币选择器放右侧**：如果支持多代币下注，徽章在右、数字在左 | CSS 方向调整 | 极低 | 文档"趋势对齐" |

**本轮确定要做的：E-01 / E-02 / E-03 / E-04**（最确定、改动集中、不影响合约层）。
暂不做：E-05 / E-06 / E-07（需要更多视觉确认）。

---

## 六、参考项目来源

| 项目 | 地址 | 学习点 |
|------|------|--------|
| ETHGlobal DEX 设计最佳实践 | https://ethereum.org/developers/docs/design-and-ux/dex-design-best-practice | Web3 Button 多态、三级信息架构、Jakob's Law |
| Uniswap Interface | https://github.com/Uniswap/interface | Token Selector、Approval 状态机、响应式模式 |
| Hyperscalper | https://jestersimpps.github.io/building-hyperscalper-client-side-trading-terminal/ | 纯客户端、实时行情动画、无后端架构 |
| NEXUS DEX | 纯 HTML+CSS+原生 JS 实现 | 明暗双模式、微网格底纹、零依赖 |
| Crypto Vault Dashboard | https://template0.com/item/crypto-vault | 零依赖模板、钱包连接完整流程 |
| BuidlGuidl RPS | https://v3.buidlguidl.com/build/TOSOkM0kFGQ94qEKOOZC | 同类游戏的 GameState 状态机、猜拳按钮布局 |

---

## 六、审阅检查点

请审阅时重点确认：

- [ ] 层级划分（A 工程 / B 交互 / C 视觉 / D 布局）是否合理
- [ ] P0 三项是否真的是必须先做的（有没有漏或排错优先级）
- [ ] 每项需求的验收标准是否可量化、可检查
- [ ] 亮色主题是否需要同步调整还是只改暗色（C-01）
- [ ] Header 48px 固定高度是否 OK（C-03）
- [ ] 骨架布局三栏/两栏/单列是否符合未来页面规划（D-01）

---

*审阅通过后，按 P0 → P1 → P2 顺序分批实施，每批完成后做一次视觉走查。*
