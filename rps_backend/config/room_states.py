"""
房间状态常量模块

所有房间状态值的唯一权威来源，全项目其他模块必须从本模块 import。
禁止在业务代码中硬编码字符串 "created"、"joined" 等。

状态流转图：

    CREATED ──── join ──── JOINED ──── 双方 ready ──── COUNTDOWN
       ↑                                                     │
       │                                                     │ 倒计时结束
       │                                                     ↓
       │                                              GAME_STARTED
       │                                                     │
       │                                                     ├─ 正常结算 → FINISHED
       │                                                     │
       └──────────── reset_rematch ──────────────────────────┘
                                                             │
                                                             └─ 超时/异常 → CLOSED

关闭触发原因：
- unready_timeout  (JOINED 阶段 60s 未准备)
- empty_room       (CREATED 阶段 300s 无玩家加入)
- game_timeout     (GAME_STARTED 阶段 600s 未结束)
- lifetime         (任意阶段超过 room_max_lifetime，默认 3600s)
- creator_kick     (创建者主动解散)
- disconnect       (所有玩家离线 10s)
"""

from __future__ import annotations

# ==================== 房间状态值 ====================

CREATED = "created"
JOINED = "joined"
COUNTDOWN = "countdown"
GAME_STARTED = "game_started"
FINISHED = "finished"
CLOSED = "closed"

ROOM_STATUS = {
    "CREATED": CREATED,
    "JOINED": JOINED,
    "COUNTDOWN": COUNTDOWN,
    "GAME_STARTED": GAME_STARTED,
    "FINISHED": FINISHED,
    "CLOSED": CLOSED,
}

# ==================== 便捷分组 ====================

# 游戏尚未开始（还没冻结资金）— 可自由退出/解散
PRE_GAME_STATES = {CREATED, JOINED, COUNTDOWN}

# 游戏进行中（资金已冻结或链上对局已创建）
IN_GAME_STATES = {GAME_STARTED}

# 终态（不再接受任何状态变更）
TERMINAL_STATES = {FINISHED, CLOSED}

# 大厅可展示的状态（过滤掉已关闭的）
LOBBY_VISIBLE_STATES = {CREATED, JOINED, COUNTDOWN, GAME_STARTED}

# Bot 可以主动加入的状态（空房间）
BOT_JOINABLE_STATES = {CREATED}

# Bot 不应打扰的状态（对局已经开始或正在倒计时）
BOT_SKIP_STATES = {COUNTDOWN, GAME_STARTED, FINISHED, CLOSED}


def is_terminal(status: str) -> bool:
    """判断房间是否已进入终态"""
    return status in TERMINAL_STATES


def is_pre_game(status: str) -> bool:
    """判断是否还在游戏前阶段（无资金冻结）"""
    return status in PRE_GAME_STATES


def is_in_game(status: str) -> bool:
    """判断是否正在游戏中"""
    return status in IN_GAME_STATES