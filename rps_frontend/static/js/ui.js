// UI渲染模块
const UI = (function() {
    const elements = {};

    // 初始化UI元素引用
    function init() {
        elements.themeToggle = document.getElementById('themeToggle');
        elements.connectWalletBtn = document.getElementById('connectWalletBtn');
        elements.walletInfo = document.getElementById('walletInfo');
        elements.walletBalance = document.getElementById('walletBalance');
        elements.walletAddress = document.getElementById('walletAddress');
        elements.walletAvatar = document.getElementById('walletAvatar');
        elements.walletNetwork = document.getElementById('walletNetwork');
        elements.networkIcon = document.getElementById('networkIcon');
        elements.networkName = document.getElementById('networkName');
        elements.disconnectBtn = document.getElementById('disconnectBtn');
        
        elements.modeSwitcher = document.getElementById('modeSwitcher');
        elements.modeBSection = document.getElementById('modeBSection');
        elements.modeBDesc = document.getElementById('modeBDesc');
        
        elements.stageHome = document.getElementById('stageHome');
        elements.stageMatching = document.getElementById('stageMatching');
        elements.stageGame = document.getElementById('stageGame');
        elements.stageResult = document.getElementById('stageResult');
        elements.stageLobby = document.getElementById('stageLobby');
        elements.stageRoomWait = document.getElementById('stageRoomWait');
        
        elements.amountInput = document.getElementById('amountInput');
        elements.startGameBtn = document.getElementById('startGameBtn');
        elements.startGameBtnText = document.getElementById('startGameBtnText');
        elements.startBtnHint = document.getElementById('startBtnHint');
        elements.cancelMatchBtn = document.getElementById('cancelMatchBtn');
        elements.matchIdInput = document.getElementById('matchIdInput');
        
        elements.matchingAmount = document.getElementById('matchingAmount');
        elements.matchingTime = document.getElementById('matchingTime');
        
        elements.gameStatusBadge = document.getElementById('gameStatusBadge');
        elements.gameTimer = document.getElementById('gameTimer');
        elements.gameIdDisplay = document.getElementById('gameIdDisplay');
        elements.opponentAddress = document.getElementById('opponentAddress');
        elements.opponentStatus = document.getElementById('opponentStatus');
        elements.opponentChoice = document.getElementById('opponentChoice');
        elements.myAddress = document.getElementById('myAddress');
        elements.myStatus = document.getElementById('myStatus');
        elements.myChoice = document.getElementById('myChoice');
        elements.revealSection = document.getElementById('revealSection');
        elements.revealBtn = document.getElementById('revealBtn');
        elements.timeoutSection = document.getElementById('timeoutSection');
        elements.claimTimeoutBtn = document.getElementById('claimTimeoutBtn');
        
        elements.resultIcon = document.getElementById('resultIcon');
        elements.resultTitle = document.getElementById('resultTitle');
        elements.resultDesc = document.getElementById('resultDesc');
        elements.resultMyChoice = document.getElementById('resultMyChoice');
        elements.resultOpponentChoice = document.getElementById('resultOpponentChoice');
        elements.resultAmount = document.getElementById('resultAmount');
        elements.resultPrize = document.getElementById('resultPrize');
        elements.resultFee = document.getElementById('resultFee');
        elements.playAgainBtn = document.getElementById('playAgainBtn');
        elements.backHomeBtn = document.getElementById('backHomeBtn');
        
        elements.historyList = document.getElementById('historyList');
        elements.tabHistory = document.getElementById('tabHistory');
        elements.tabStats = document.getElementById('tabStats');
        
        elements.statTotal = document.getElementById('statTotal');
        elements.statWins = document.getElementById('statWins');
        elements.statLosses = document.getElementById('statLosses');
        elements.statDraws = document.getElementById('statDraws');
        elements.winRateValue = document.getElementById('winRateValue');
        elements.winRateFill = document.getElementById('winRateFill');

        elements.createRoomBtn = document.getElementById('createRoomBtn');
        elements.roomList = document.getElementById('roomList');
        elements.roomIdDisplay = document.getElementById('roomIdDisplay');
        elements.roomStatusBadge = document.getElementById('roomStatusBadge');
        elements.roomCreatorAddress = document.getElementById('roomCreatorAddress');
        elements.roomCreatorStatus = document.getElementById('roomCreatorStatus');
        elements.roomCreatorReady = document.getElementById('roomCreatorReady');
        elements.roomOpponentAddress = document.getElementById('roomOpponentAddress');
        elements.roomOpponentStatus = document.getElementById('roomOpponentStatus');
        elements.roomOpponentReady = document.getElementById('roomOpponentReady');
        elements.roomToken = document.getElementById('roomToken');
        elements.roomBetAmount = document.getElementById('roomBetAmount');
        elements.roomCountdown = document.getElementById('roomCountdown');
        elements.countdownNumber = document.getElementById('countdownNumber');
        elements.readyBtn = document.getElementById('readyBtn');
        elements.readyBtnText = document.getElementById('readyBtnText');
        elements.leaveRoomBtn = document.getElementById('leaveRoomBtn');
    }

    // 切换显示的舞台
    function showStage(stage) {
        const stages = ['stageHome', 'stageMatching', 'stageGame', 'stageResult', 'stageLobby', 'stageRoomWait'];
        stages.forEach(s => {
            if (elements[s]) {
                elements[s].classList.toggle('hidden', s !== stage);
            }
        });
    }

    // 更新钱包信息显示
    function updateWalletInfo(address, balance, token) {
        if (address) {
            elements.connectWalletBtn.classList.add('hidden');
            elements.walletInfo.classList.remove('hidden');
            elements.walletAddress.textContent = formatAddress(address);
            if (balance !== undefined) {
                elements.walletBalance.textContent = `${parseFloat(balance).toFixed(4)} ${token || 'USDC'}`;
            }
            if (elements.walletAvatar) {
                elements.walletAvatar.textContent = getAvatarForAddress(address);
            }
        } else {
            elements.connectWalletBtn.classList.remove('hidden');
            elements.walletInfo.classList.add('hidden');
        }
    }

    // 更新网络信息显示
    function updateNetworkInfo(chainId, networkName) {
        if (!elements.walletNetwork) return;

        const networkIcons = {
            1: '🔷',
            137: '🟣',
            80002: '🟣',
            5208888: '🔧',
            56: '🟡',
            42161: '🔵',
            10: '🔴',
            8453: '🔵',
            43114: '🔺',
            100: '🟢',
            250: '🎭',
        };

        const icon = networkIcons[chainId] || '🔗';
        const name = networkName || `Chain #${chainId}`;

        if (elements.networkIcon) {
            elements.networkIcon.textContent = icon;
        }
        if (elements.networkName) {
            elements.networkName.textContent = name;
        }

        elements.walletNetwork.classList.remove('hidden');
        elements.walletNetwork.title = `网络: ${name} (Chain ID: ${chainId})`;
    }

    // 根据地址获取头像
    function getAvatarForAddress(address) {
        if (!address) return '👤';
        const avatars = ['😎', '🚀', '🦄', '🌟', '💎', '🔥', '⚡', '🎯', '🏆', '💪', '🎮', '🎲', '💫', '🎭', '🐲', '🦸'];
        const hash = address.toLowerCase().replace('0x', '');
        let sum = 0;
        for (let i = 0; i < hash.length; i++) {
            sum += hash.charCodeAt(i);
        }
        return avatars[sum % avatars.length];
    }

    // 格式化地址显示
    function formatAddress(address, len = 6) {
        if (!address) return '';
        if (address.length <= len * 2 + 2) return address;
        return address.slice(0, len) + '...' + address.slice(-len);
    }

    // 设置主题
    function setTheme(theme) {
        document.documentElement.setAttribute('data-theme', theme);
        const themeIcon = document.querySelector('.theme-icon');
        if (themeIcon) {
            themeIcon.textContent = theme === 'dark' ? '☀️' : '🌙';
        }
        localStorage.setItem('rps_theme', theme);
    }

    // 获取当前主题
    function getCurrentTheme() {
        return document.documentElement.getAttribute('data-theme') || 'light';
    }

    // 切换主题
    function toggleTheme() {
        const current = getCurrentTheme();
        const next = current === 'dark' ? 'light' : 'dark';
        setTheme(next);
        return next;
    }

    // 更新匹配耗时显示
    function updateMatchingTime(seconds) {
        if (elements.matchingTime) {
            elements.matchingTime.textContent = `${seconds}s`;
        }
    }

    // 更新游戏计时器
    function updateGameTimer(seconds, isWarning = false, isDanger = false) {
        if (!elements.gameTimer) return;
        
        const mins = Math.floor(seconds / 60);
        const secs = seconds % 60;
        elements.gameTimer.textContent = `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
        
        elements.gameTimer.classList.remove('warning', 'danger');
        if (isDanger) {
            elements.gameTimer.classList.add('danger');
        } else if (isWarning) {
            elements.gameTimer.classList.add('warning');
        }
    }

    // 设置游戏状态徽章
    function setGameStatus(text) {
        if (elements.gameStatusBadge) {
            elements.gameStatusBadge.textContent = text;
        }
    }

    // 设置我的出拳
    function setMyChoice(choice, revealed = false) {
        if (!elements.myChoice) return;
        if (choice) {
            elements.myChoice.innerHTML = `<span>${RPSCrypto.getChoiceEmoji(choice)}</span>`;
            if (revealed) {
                elements.myChoice.classList.add('revealed');
            }
        } else {
            elements.myChoice.innerHTML = `<span class="choice-hidden">❓</span>`;
            elements.myChoice.classList.remove('revealed');
        }
    }

    // 设置对手出拳
    function setOpponentChoice(choice, revealed = false) {
        if (!elements.opponentChoice) return;
        if (choice && revealed) {
            elements.opponentChoice.innerHTML = `<span>${RPSCrypto.getChoiceEmoji(choice)}</span>`;
            elements.opponentChoice.classList.add('revealed');
        } else if (choice) {
            elements.opponentChoice.innerHTML = `<span>🔒</span>`;
            elements.opponentChoice.classList.remove('revealed');
        } else {
            elements.opponentChoice.innerHTML = `<span class="choice-hidden">❓</span>`;
            elements.opponentChoice.classList.remove('revealed');
        }
    }

    // 设置我的状态
    function setMyStatus(text) {
        if (elements.myStatus) {
            elements.myStatus.textContent = text;
        }
    }

    // 设置对手状态
    function setOpponentStatus(text) {
        if (elements.opponentStatus) {
            elements.opponentStatus.textContent = text;
        }
    }

    // 设置对手地址
    function setOpponentAddress(address) {
        if (elements.opponentAddress) {
            elements.opponentAddress.textContent = address ? formatAddress(address) : '等待对手...';
        }
    }

    // 设置我的地址
    function setMyAddress(address) {
        if (elements.myAddress) {
            elements.myAddress.textContent = address ? formatAddress(address) : '我的地址';
        }
    }

    // 设置对局ID
    function setGameId(gameId) {
        if (elements.gameIdDisplay) {
            elements.gameIdDisplay.textContent = `对局 #${gameId}`;
        }
    }

    // 显示或隐藏揭示按钮
    function showRevealButton(show) {
        if (elements.revealSection) {
            elements.revealSection.classList.toggle('hidden', !show);
        }
    }

    // 显示或隐藏超时按钮
    function showTimeoutButton(show) {
        if (elements.timeoutSection) {
            elements.timeoutSection.classList.toggle('hidden', !show);
        }
    }

    // 启用或禁用出拳按钮
    function setChoiceButtonsEnabled(enabled) {
        const buttons = document.querySelectorAll('.choice-btn');
        buttons.forEach(btn => {
            btn.disabled = !enabled;
        });
    }

    // 设置选中的出拳
    function setSelectedChoice(choice) {
        const buttons = document.querySelectorAll('.choice-btn');
        buttons.forEach(btn => {
            const btnChoice = parseInt(btn.dataset.choice);
            btn.classList.toggle('selected', btnChoice === choice);
        });
    }

    // 显示对局结果
    function showResult(result) {
        if (!elements.resultTitle) return;
        
        elements.resultTitle.classList.remove('win', 'lose', 'draw');
        elements.resultIcon.classList.remove('win-icon', 'lose-icon', 'draw-icon');
        
        // 重触发动画：先移除再添加，确保每次展示都有动画
        elements.resultIcon.style.animation = 'none';
        elements.resultTitle.style.animation = 'none';
        // 强制 reflow
        void elements.resultIcon.offsetWidth;
        void elements.resultTitle.offsetWidth;
        elements.resultIcon.style.animation = '';
        elements.resultTitle.style.animation = '';

        if (result.type === 'win') {
            elements.resultIcon.textContent = '🏆';
            elements.resultTitle.textContent = '你赢了！';
            elements.resultTitle.classList.add('win');
            elements.resultIcon.classList.add('win-icon');
            elements.resultDesc.textContent = '恭喜获得胜利';
        } else if (result.type === 'lose') {
            elements.resultIcon.textContent = '😢';
            elements.resultTitle.textContent = '你输了';
            elements.resultTitle.classList.add('lose');
            elements.resultIcon.classList.add('lose-icon');
            elements.resultDesc.textContent = '再接再厉，下一把加油！';
        } else {
            elements.resultIcon.textContent = '🤝';
            elements.resultTitle.textContent = '平局';
            elements.resultTitle.classList.add('draw');
            elements.resultIcon.classList.add('draw-icon');
            elements.resultDesc.textContent = '双方出拳相同，不分胜负';
        }
        
        if (result.myChoice !== undefined) {
            elements.resultMyChoice.textContent = `${RPSCrypto.getChoiceEmoji(result.myChoice)} ${RPSCrypto.getChoiceName(result.myChoice)}`;
        }
        
        if (result.opponentChoice !== undefined) {
            elements.resultOpponentChoice.textContent = `${RPSCrypto.getChoiceEmoji(result.opponentChoice)} ${RPSCrypto.getChoiceName(result.opponentChoice)}`;
        }
        
        if (result.amount !== undefined) {
            elements.resultAmount.textContent = `${result.amount} ${result.token || 'USDC'}`;
        }
        
        if (result.prize !== undefined) {
            elements.resultPrize.textContent = result.type === 'win' ? `+${result.prize}` : result.prize;
        }
        
        if (result.fee !== undefined) {
            elements.resultFee.textContent = `-${result.fee}`;
        }
    }

    // 显示代币选中状态
    function showTokenSelect(token) {
        const buttons = document.querySelectorAll('.token-btn');
        buttons.forEach(btn => {
            btn.classList.toggle('active', btn.dataset.token === token);
        });
        
        const unit = document.querySelector('.amount-unit');
        if (unit) {
            unit.textContent = token;
        }
    }

    // 设置开始按钮文字
    function setStartButtonText(text, loading = false) {
        if (elements.startGameBtnText) {
            elements.startGameBtnText.textContent = text;
        }
        if (elements.startGameBtn) {
            elements.startGameBtn.disabled = loading;
        }
    }

    // 切换游戏模式
    function switchMode(mode) {
        const buttons = document.querySelectorAll('.mode-btn');
        buttons.forEach(btn => {
            btn.classList.toggle('active', btn.dataset.mode === mode);
        });

        // 旧界面元素已迁移至交易大厅，这里做 null 保护，避免初始化时报错
        if (mode === 'B') {
            if (elements.modeBSection) elements.modeBSection.classList.remove('hidden');
            if (elements.modeBDesc) elements.modeBDesc.classList.remove('hidden');
            if (elements.startGameBtnText) elements.startGameBtnText.textContent = '创建/加入私密对局';
            if (elements.startBtnHint) elements.startBtnHint.classList.add('hidden');
        } else {
            if (elements.modeBSection) elements.modeBSection.classList.add('hidden');
            if (elements.modeBDesc) elements.modeBDesc.classList.add('hidden');
            if (elements.startGameBtnText) elements.startGameBtnText.textContent = '🏠 进入交易大厅';
            if (elements.startBtnHint) elements.startBtnHint.classList.remove('hidden');
        }
    }

    // 切换标签页
    function switchTab(tab) {
        document.querySelectorAll('.panel-tab').forEach(t => {
            t.classList.toggle('active', t.dataset.tab === tab);
        });
        
        document.querySelectorAll('.tab-content').forEach(c => {
            c.classList.remove('active');
            c.classList.add('hidden');
        });
        
        if (tab === 'history') {
            elements.tabHistory.classList.add('active');
            elements.tabHistory.classList.remove('hidden');
        } else if (tab === 'stats') {
            elements.tabStats.classList.add('active');
            elements.tabStats.classList.remove('hidden');
        } else if (tab === 'settings') {
            const tabSettings = document.getElementById('tabSettings');
            if (tabSettings) {
                tabSettings.classList.add('active');
                tabSettings.classList.remove('hidden');
            }
            if (typeof Settings !== 'undefined') {
                Settings.renderSettingsForm();
            }
        }
    }

    // 切换历史视图
    function switchView(view) {
        document.querySelectorAll('.view-btn').forEach(btn => {
            btn.classList.toggle('active', btn.dataset.view === view);
        });
        
        if (elements.historyList) {
            elements.historyList.classList.toggle('card-view', view === 'card');
        }
    }

    // 更新统计数据
    function updateStats(stats) {
        if (elements.statTotal) elements.statTotal.textContent = stats.total || 0;
        if (elements.statWins) elements.statWins.textContent = stats.wins || 0;
        if (elements.statLosses) elements.statLosses.textContent = stats.losses || 0;
        if (elements.statDraws) elements.statDraws.textContent = stats.draws || 0;
        
        const winRate = stats.total > 0 ? (stats.wins / stats.total * 100).toFixed(1) : 0;
        if (elements.winRateValue) {
            elements.winRateValue.textContent = `${winRate}%`;
        }
        if (elements.winRateFill) {
            elements.winRateFill.style.width = `${winRate}%`;
        }
    }

    let roomListView = 'list'; // 'list' | 'card'

    // 设置房间列表视图
    function setRoomListView(view) {
        roomListView = view;
        if (elements.roomList) {
            elements.roomList.classList.toggle('view-list', view === 'list');
            elements.roomList.classList.toggle('view-card', view === 'card');
        }
        document.querySelectorAll('.view-switch-btn').forEach(btn => {
            btn.classList.toggle('active', btn.dataset.view === view);
        });
        localStorage.setItem('rps_room_view', view);
    }

    // 获取首选房间列表视图
    function getPreferredRoomListView() {
        // 手机默认卡片，PC 默认列表
        const stored = localStorage.getItem('rps_room_view');
        if (stored === 'list' || stored === 'card') return stored;
        const isMobile = window.matchMedia('(max-width: 768px)').matches;
        return isMobile ? 'card' : 'list';
    }

    // 渲染房间列表
    function renderRoomList(rooms) {
        if (!elements.roomList) return;

        // 应用视图类
        elements.roomList.classList.toggle('view-list', roomListView === 'list');
        elements.roomList.classList.toggle('view-card', roomListView === 'card');

        // 更新统计
        const total = rooms.length;
        const available = rooms.filter(r => r.status === 'created').length;
        const started = rooms.filter(r => r.status === 'game_started').length;
        const statTotalEl = document.getElementById('statTotal');
        const statAvailableEl = document.getElementById('statAvailable');
        const statStartedEl = document.getElementById('statStarted');
        if (statTotalEl) statTotalEl.textContent = total;
        if (statAvailableEl) statAvailableEl.textContent = available;
        if (statStartedEl) statStartedEl.textContent = started;

        if (!rooms || rooms.length === 0) {
            elements.roomList.innerHTML = `
                <div class="empty-state">
                    <span class="empty-icon">🏠</span>
                    <p>暂无可用房间</p>
                    <p class="empty-hint">点击下方按钮创建第一个房间</p>
                </div>
            `;
            return;
        }

        // 状态文本映射
        const statusText = (status) => {
            const map = {
                'created': '等待对手',
                'joined': '已加入',
                'ready': '已准备',
                'countdown': '倒计时',
                'game_started': '已开始',
                'finished': '已结束'
            };
            return map[status] || status;
        };

        elements.roomList.innerHTML = rooms.map(room => {
            const isAvailable = room.status === 'created';
            return `
                <div class="room-card">
                    <div class="room-card-header">
                        <span class="room-id">#${room.room_id}</span>
                        <span class="room-status ${isAvailable ? 'status-waiting' : 'status-joined'}">
                            ${statusText(room.status)}
                        </span>
                    </div>
                    <div class="room-card-body">
                        <div class="room-player-info">
                            <span class="player-label">创建者</span>
                            <span class="player-value">${formatAddress(room.creator)}</span>
                        </div>
                        ${room.player2 ? `
                            <div class="room-player-info">
                                <span class="player-label">对手</span>
                                <span class="player-value">${formatAddress(room.player2)}</span>
                            </div>
                        ` : ''}
                        <div class="room-bet-info">
                            <span class="bet-token">${room.token}</span>
                            <span class="bet-amount">${room.bet_amount}</span>
                        </div>
                    </div>
                    ${isAvailable ? `
                        <button class="btn btn-primary btn-block btn-join-room" data-room-id="${room.room_id}">
                            加入房间
                        </button>
                    ` : `
                        <button class="btn btn-default btn-block" disabled>
                            ${room.status === 'game_started' ? '游戏中' : '不可加入'}
                        </button>
                    `}
                </div>
            `;
        }).join('');
    }

    // 设置房间信息
    function setRoomInfo(room, isCreator = false) {
        if (elements.roomIdDisplay) elements.roomIdDisplay.textContent = room.room_id;
        if (elements.roomToken) elements.roomToken.textContent = room.token;
        if (elements.roomBetAmount) elements.roomBetAmount.textContent = room.bet_amount;
        
        const statusText = {
            'created': '等待对手',
            'joined': '对手已加入',
            'ready': '双方准备',
            'countdown': '倒计时中',
            'game_started': '游戏进行中',
        };
        if (elements.roomStatusBadge) {
            elements.roomStatusBadge.textContent = statusText[room.status] || room.status;
        }

        if (elements.roomCreatorAddress) {
            elements.roomCreatorAddress.textContent = formatAddress(room.creator);
        }
        if (elements.roomCreatorStatus) {
            elements.roomCreatorStatus.textContent = isCreator ? '创建者（自己）' : '创建者';
        }

        if (elements.roomOpponentAddress) {
            elements.roomOpponentAddress.textContent = room.player2 ? formatAddress(room.player2) : '等待对手...';
        }
        if (elements.roomOpponentStatus) {
            elements.roomOpponentStatus.textContent = room.player2 ? (isCreator ? '已加入' : '加入者（自己）') : '未加入';
        }

        updateRoomReady(room.creator_ready, room.player2_ready);
    }

    // 更新房间准备状态
    function updateRoomReady(creatorReady, opponentReady) {
        if (elements.roomCreatorReady) {
            const icon = creatorReady ? '🟢' : '⚪';
            const text = creatorReady ? '已准备' : '未准备';
            elements.roomCreatorReady.innerHTML = `<span class="ready-icon">${icon}</span><span>${text}</span>`;
            elements.roomCreatorReady.classList.toggle('ready', creatorReady);
        }

        if (elements.roomOpponentReady) {
            const icon = opponentReady ? '🟢' : '⚪';
            const text = opponentReady ? '已准备' : '未准备';
            elements.roomOpponentReady.innerHTML = `<span class="ready-icon">${icon}</span><span>${text}</span>`;
            elements.roomOpponentReady.classList.toggle('ready', opponentReady);
        }
    }

    // 设置准备按钮文字
    function setReadyButtonText(text) {
        if (elements.readyBtnText) {
            elements.readyBtnText.textContent = text;
        }
    }

    // 显示或隐藏倒计时
    function showCountdown(show) {
        if (elements.roomCountdown) {
            elements.roomCountdown.classList.toggle('hidden', !show);
        }
    }

    // 更新倒计时数字
    function updateCountdown(number, isDanger = false) {
        if (elements.countdownNumber) {
            elements.countdownNumber.textContent = number;
            // 最后5秒醒目提示
            if (isDanger) {
                elements.countdownNumber.classList.add('countdown-danger');
            } else {
                elements.countdownNumber.classList.remove('countdown-danger');
            }
        }
    }

    // 返回UI相关函数
    return {
        init,
        elements,
        showStage,
        updateWalletInfo,
        formatAddress,
        setTheme,
        getCurrentTheme,
        toggleTheme,
        updateMatchingTime,
        updateGameTimer,
        setGameStatus,
        setMyChoice,
        setOpponentChoice,
        setMyStatus,
        setOpponentStatus,
        setOpponentAddress,
        setMyAddress,
        setGameId,
        showRevealButton,
        showTimeoutButton,
        setChoiceButtonsEnabled,
        setSelectedChoice,
        showResult,
        showTokenSelect,
        setStartButtonText,
        switchMode,
        switchTab,
        switchView,
        updateStats,
        renderRoomList,
        setRoomListView,
        getPreferredRoomListView,
        setRoomInfo,
        updateRoomReady,
        setReadyButtonText,
        showCountdown,
        updateCountdown,
        updateNetworkInfo
    };
})();
