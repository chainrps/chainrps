/**
 * 阶段演示中心 - 独立公开页面脚本
 * 从 admin.js 迁移而来，纯前端渲染，无需后端 API。
 * 依赖：无外部依赖（纯客户端 HTML 模板渲染）
 */

const DemoApp = {
    _sdStages: [
        {
            key: 'lobby', icon: '🏠', title: '游戏大厅', desc: '浏览房间列表，创建或加入房间',
            render: () => `
                <div class="sd-lobby">
                    <div class="sd-lobby-header">
                        <div class="sd-lobby-title">🏠 大厅</div>
                        <button class="sd-create-btn">+ 创建房间</button>
                    </div>
                    <div class="sd-room-list">
                        <div class="sd-room-card">
                            <div class="sd-room-info">
                                <div class="sd-room-id">ROOM-7F3A</div>
                                <div class="sd-room-meta">押注 50 POL · 等待中</div>
                            </div>
                            <span class="sd-room-state state-joined">可加入</span>
                        </div>
                        <div class="sd-room-card">
                            <div class="sd-room-info">
                                <div class="sd-room-id">ROOM-9B21</div>
                                <div class="sd-room-meta">押注 100 POL · 进行中</div>
                            </div>
                            <span class="sd-room-state state-started">游戏中</span>
                        </div>
                        <div class="sd-room-card new-room">
                            <div class="sd-room-info">
                                <div class="sd-room-id">ROOM-A2C9 (我的房间)</div>
                                <div class="sd-room-meta">押注 20 POL · 等待对手</div>
                            </div>
                            <span class="sd-room-state state-joined">已创建</span>
                        </div>
                    </div>
                </div>
            `,
        },
        {
            key: 'room_wait', icon: '⏳', title: '房间等待', desc: '玩家进入房间，双方准备就绪',
            render: () => `
                <div class="sd-room">
                    <div class="sd-room-header">
                        <div class="sd-room-name">ROOM-A2C9 · 押注 20 POL</div>
                        <span class="sd-room-state state-joined">等待中</span>
                    </div>
                    <div class="sd-room-players">
                        <div class="sd-player-slot me ready">
                            <div class="sd-player-avatar">我</div>
                            <div class="sd-player-name">0xa0ce...48b6f</div>
                            <div class="sd-player-status is-ready">✓ 已准备</div>
                        </div>
                        <div class="sd-vs">VS</div>
                        <div class="sd-player-slot ready">
                            <div class="sd-player-avatar">P</div>
                            <div class="sd-player-name">0xb1d4...7e2a3</div>
                            <div class="sd-player-status is-ready">✓ 已准备</div>
                        </div>
                    </div>
                </div>
            `,
        },
        {
            key: 'countdown', icon: '🔢', title: '游戏倒计时', desc: '双方已准备，3 秒后开始对局',
            render: () => `
                <div class="sd-countdown">
                    <div class="sd-countdown-num">3</div>
                    <div class="sd-countdown-label">游戏即将开始...</div>
                </div>
            `,
        },
        {
            key: 'game_commit', icon: '✊', title: '出拳阶段', desc: '选择石头/剪刀/布并提交哈希',
            render: () => `
                <div class="sd-game">
                    <div class="sd-game-arena">
                        <div style="text-align:center;">
                            <div class="sd-choice-display committed">✊</div>
                            <div class="sd-player-name" style="margin-top:6px;">我（已提交）</div>
                        </div>
                        <div class="sd-vs">VS</div>
                        <div style="text-align:center;">
                            <div class="sd-choice-display hidden-choice committed"></div>
                            <div class="sd-player-name" style="margin-top:6px;">对手（已提交）</div>
                        </div>
                    </div>
                    <div class="sd-choices-row">
                        <button class="sd-choice-btn selected">✊</button>
                        <button class="sd-choice-btn disabled">✋</button>
                        <button class="sd-choice-btn disabled">✌️</button>
                    </div>
                </div>
            `,
        },
        {
            key: 'game_reveal', icon: '🔓', title: '揭晓出拳', desc: '双方揭晓出拳，合约判定胜负',
            render: () => `
                <div class="sd-game">
                    <div class="sd-game-arena">
                        <div style="text-align:center;">
                            <div class="sd-choice-display revealed">✊</div>
                            <div class="sd-player-name" style="margin-top:6px;">我 · 石头</div>
                        </div>
                        <div class="sd-vs">VS</div>
                        <div style="text-align:center;">
                            <div class="sd-choice-display revealed">✌️</div>
                            <div class="sd-player-name" style="margin-top:6px;">对手 · 剪刀</div>
                        </div>
                    </div>
                    <div class="sd-choices-row">
                        <button class="sd-choice-btn selected">✊</button>
                        <button class="sd-choice-btn">✋</button>
                        <button class="sd-choice-btn">✌️</button>
                    </div>
                </div>
            `,
        },
        {
            key: 'result', icon: '🏆', title: '游戏结果', desc: '显示胜负、结算奖金与手续费',
            render: () => `
                <div class="sd-result">
                    <div class="sd-result-banner win">🏆 胜利！</div>
                    <div class="sd-result-settle">
                        <div class="sd-settle-item">
                            <div class="sd-settle-label">押注</div>
                            <div class="sd-settle-value">20 POL</div>
                        </div>
                        <div class="sd-settle-item">
                            <div class="sd-settle-label">奖金</div>
                            <div class="sd-settle-value positive">+40 POL</div>
                        </div>
                        <div class="sd-settle-item">
                            <div class="sd-settle-label">手续费 (2%)</div>
                            <div class="sd-settle-value negative">-0.4 POL</div>
                        </div>
                        <div class="sd-settle-item">
                            <div class="sd-settle-label">净收益</div>
                            <div class="sd-settle-value positive">+19.6 POL</div>
                        </div>
                    </div>
                </div>
            `,
        },
        {
            key: 'end', icon: '🎉', title: '游戏结束', desc: '开始下一局或退出游戏',
            render: () => `
                <div class="sd-end">
                    <div style="font-size: 48px;">🎉</div>
                    <div style="font-size: 16px; font-weight: 600; color: var(--text-primary);">本局游戏结束</div>
                    <div style="font-size: 12px; color: var(--text-secondary);">感谢参与，继续挑战或返回大厅</div>
                    <div class="sd-end-actions">
                        <button class="btn btn-primary">🔄 开始下一局</button>
                        <button class="btn btn-outline">🚪 退出游戏</button>
                    </div>
                </div>
            `,
        },
    ],

    // 演示状态
    _sdIndex: 0,
    _sdPlaying: false,
    _sdTimer: null,
    _sdSpeed: 1200,
    _currentDemoTab: 'cards',

    // 切换演示页的子 tab（阶段模拟卡片 / 流程动画演示）
    switchDemoTab(tabName) {
        this._currentDemoTab = tabName;
        document.querySelectorAll('[data-demo-tab]').forEach(btn => {
            btn.classList.toggle('active', btn.dataset.demoTab === tabName);
            if (btn.dataset.demoTab === tabName) {
                btn.style.color = 'var(--text-primary)';
                btn.style.borderBottomColor = 'var(--primary-color)';
            } else {
                btn.style.color = 'var(--text-secondary)';
                btn.style.borderBottomColor = 'transparent';
            }
        });
        const cardsPanel = document.getElementById('demoPanel-cards');
        const animPanel = document.getElementById('demoPanel-animation');
        if (cardsPanel) cardsPanel.style.display = tabName === 'cards' ? '' : 'none';
        if (animPanel) animPanel.style.display = tabName === 'animation' ? '' : 'none';

        if (tabName === 'cards') {
            this._renderDemoCards();
        } else {
            this._renderDemoAnimation();
        }

        // 更新 URL hash（独立页面路由，不与 admin 集成）
        const hash = tabName === 'cards' ? '#cards' : '#animation';
        if (window.location.hash !== hash) {
            history.replaceState(null, '', hash);
        }
    },

    // 渲染阶段模拟卡片入口
    _renderDemoCards() {
        const grid = document.getElementById('stageDemoGrid');
        if (!grid) return;

        const stages = [
            { mock: 'lobby',        icon: '🏠', title: '游戏大厅',     desc: '大厅房间列表，展示已创建的房间，支持创建/加入房间' },
            { mock: 'room_wait',    icon: '⏳', title: '房间等待',     desc: '玩家进入房间后的等待界面，显示双方准备状态' },
            { mock: 'countdown',    icon: '🔢', title: '倒计时',       desc: '双方准备就绪后的倒计时阶段，即将开始对局' },
            { mock: 'game_commit',  icon: '✊', title: '出拳提交',     desc: '游戏进行中的出拳阶段，可选择石头/剪刀/布' },
            { mock: 'game_reveal',  icon: '🔓', title: '揭晓出拳',     desc: '双方已提交，等待揭晓出拳结果' },
            { mock: 'result_win',   icon: '🏆', title: '游戏结果 - 胜利', desc: '对局结束，我方获胜，展示奖金和手续费' },
            { mock: 'result_lose',  icon: '💔', title: '游戏结果 - 失败', desc: '对局结束，我方失败' },
            { mock: 'result_draw',  icon: '🤝', title: '游戏结果 - 平局', desc: '对局结束，双方平局退回本金' },
        ];

        const baseUrl = window.location.origin + '/';

        grid.innerHTML = stages.map(s => `
            <div class="stage-demo-card" onclick="window.open('${baseUrl}?mock=${s.mock}', '_blank')">
                <div class="stage-demo-icon">${s.icon}</div>
                <div class="stage-demo-body">
                    <div class="stage-demo-title">${s.title}</div>
                    <div class="stage-demo-desc">${s.desc}</div>
                </div>
                <div class="stage-demo-arrow">↗</div>
            </div>
        `).join('');
    },

    // 渲染动画演示面板
    _renderDemoAnimation() {
        // 渲染进度条
        const bar = document.getElementById('sdProgressBar');
        if (bar) {
            bar.innerHTML = this._sdStages.map((s, i) =>
                `<div class="sd-step-pill${i < this._sdIndex ? ' done' : i === this._sdIndex ? ' active' : ''}" data-i="${i}" title="${s.title}"></div>`
            ).join('');
        }
        // 渲染快捷跳转
        const jumps = document.getElementById('sdJumps');
        if (jumps) {
            jumps.innerHTML = this._sdStages.map((s, i) =>
                `<button class="sd-jump-btn${i === this._sdIndex ? ' current' : ''}" onclick="DemoApp.sdJumpTo(${i})">${s.icon} ${s.title}</button>`
            ).join('');
        }
        this._sdRenderStage();
    },

    // 渲染阶段演示（入口，根据当前子 tab 决定渲染哪个面板）
    _renderStageDemo() {
        if (this._currentDemoTab === 'animation') {
            this._renderDemoAnimation();
        } else {
            this._renderDemoCards();
        }
    },

    // 渲染当前阶段场景
    _sdRenderStage() {
        const stage = this._sdStages[this._sdIndex];
        if (!stage) return;
        const el = document.getElementById('sdStage');
        if (el) {
            el.style.opacity = '0';
            el.style.transform = 'translateY(8px)';
            setTimeout(() => {
                el.innerHTML = stage.render();
                el.style.transition = 'opacity 0.3s ease, transform 0.3s ease';
                el.style.opacity = '1';
                el.style.transform = 'translateY(0)';
            }, 80);
        }
        document.getElementById('sdInfoIcon').textContent = stage.icon;
        document.getElementById('sdInfoTitle').textContent = stage.title;
        document.getElementById('sdInfoDesc').textContent = stage.desc;
        // 更新进度条状态
        document.querySelectorAll('.sd-step-pill').forEach((p, i) => {
            p.classList.remove('active', 'done');
            if (i < this._sdIndex) p.classList.add('done');
            else if (i === this._sdIndex) p.classList.add('active');
        });
        // 更新快捷跳转当前态
        document.querySelectorAll('.sd-jump-btn').forEach((b, i) => {
            b.classList.toggle('current', i === this._sdIndex);
        });
        // 更新播放按钮文案
        const playBtn = document.getElementById('sdPlayBtn');
        if (playBtn) playBtn.textContent = this._sdPlaying ? '⏸ 暂停' : '▶ 播放';
    },

    // 播放/暂停
    sdTogglePlay() {
        this._sdPlaying = !this._sdPlaying;
        if (this._sdPlaying) {
            this._sdScheduleNext();
        } else {
            this._sdClearTimer();
        }
        this._sdRenderStage();
    },

    // 安排下一步
    _sdScheduleNext() {
        this._sdClearTimer();
        if (!this._sdPlaying) return;
        this._sdTimer = setTimeout(() => {
            if (this._sdIndex < this._sdStages.length - 1) {
                this._sdIndex++;
                this._sdRenderStage();
                this._sdScheduleNext();
            } else {
                // 演示结束，自动停止
                this._sdPlaying = false;
                this._sdRenderStage();
            }
        }, this._sdSpeed);
    },

    _sdClearTimer() {
        if (this._sdTimer) {
            clearTimeout(this._sdTimer);
            this._sdTimer = null;
        }
    },

    // 重新开始
    sdRestart() {
        this._sdIndex = 0;
        this._sdPlaying = false;
        this._sdClearTimer();
        this._sdRenderStage();
    },

    // 上一步
    sdPrev() {
        if (this._sdIndex > 0) {
            this._sdIndex--;
            this._sdPlaying = false;
            this._sdClearTimer();
            this._sdRenderStage();
        }
    },

    // 下一步
    sdNext() {
        if (this._sdIndex < this._sdStages.length - 1) {
            this._sdIndex++;
            this._sdPlaying = false;
            this._sdClearTimer();
            this._sdRenderStage();
        }
    },

    // 跳转到指定阶段
    sdJumpTo(i) {
        if (i >= 0 && i < this._sdStages.length) {
            this._sdIndex = i;
            this._sdPlaying = false;
            this._sdClearTimer();
            this._sdRenderStage();
        }
    },

    // 切换播放速度
    sdChangeSpeed(val) {
        this._sdSpeed = parseInt(val) || 1200;
        if (this._sdPlaying) {
            this._sdScheduleNext();
        }
    },

    // 初始化：从 hash 恢复子 tab
    init() {
        const hash = window.location.hash;
        const tab = (hash === '#animation') ? 'animation' : 'cards';
        this.switchDemoTab(tab);
    },
};

document.addEventListener('DOMContentLoaded', () => {
    DemoApp.init();
});
