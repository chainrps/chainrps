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
        elements.gameFundStage = document.getElementById('gameFundStage');
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
        elements.retrySection = document.getElementById('retrySection');
        elements.retryCreateBtn = document.getElementById('retryCreateBtn');
        elements.retryJoinBtn = document.getElementById('retryJoinBtn');
        elements.leaveRoomInGameBtn = document.getElementById('leaveRoomInGameBtn');
        elements.exitGameBtn = document.getElementById('exitGameBtn');
        
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
        elements.roomVsStake = document.getElementById('roomVsStake');
        elements.roomCreatorAvatar = document.getElementById('roomCreatorAvatar');
        elements.roomOpponentCard = document.getElementById('roomOpponentCard');
        elements.seatAvatarBtn = document.getElementById('seatAvatarBtn');
        elements.seatAvatarIcon = document.getElementById('seatAvatarIcon');
        elements.seatActionHint = document.getElementById('seatActionHint');
        elements.seatMenu = document.getElementById('seatMenu');
        elements.roomExitBtn = document.getElementById('roomExitBtn');
        elements.roomCountdown = document.getElementById('roomCountdown');
        elements.countdownNumber = document.getElementById('countdownNumber');
        elements.readyBtn = document.getElementById('readyBtn');
        elements.readyBtnText = document.getElementById('readyBtnText');

        // 钱包头像/余额 点击展开/收起多币种面板
        const balancesDropdown = document.getElementById('walletBalancesDropdown');
        const avatarContainer = document.querySelector('.wallet-avatar-container');
        const dropdownTrigger = avatarContainer || elements.walletBalance;
        if (dropdownTrigger && balancesDropdown) {
            dropdownTrigger.addEventListener('click', (e) => {
                e.stopPropagation();
                balancesDropdown.classList.toggle('hidden');
            });
            // 点击页面其他区域收起
            document.addEventListener('click', (e) => {
                if (!balancesDropdown.contains(e.target) && e.target !== dropdownTrigger && !dropdownTrigger.contains(e.target)) {
                    balancesDropdown.classList.add('hidden');
                }
            });
        }

        // dropdown 里的快捷入口按钮 → 打开对应 side-panel tab
        const sidePanel = document.getElementById('sidePanel');
        const panelContent = document.getElementById('panelContent');
        document.querySelectorAll('.dropdown-quick-btn').forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                const tab = btn.dataset.quick;
                // 关闭 dropdown
                if (balancesDropdown) balancesDropdown.classList.add('hidden');
                if (sidePanel) sidePanel.classList.remove('hidden');
                // 复用原 switchTab 逻辑
                switchTab(tab);
            });
        });

        // side-panel 关闭按钮
        const sidePanelClose = document.getElementById('sidePanelCloseBtn');
        if (sidePanelClose) {
            sidePanelClose.addEventListener('click', () => {
                if (sidePanel) sidePanel.classList.add('hidden');
                if (panelContent) panelContent.classList.add('hidden');
            });
        }

        // 钱包地址点击复制
        if (elements.walletAddress) {
            elements.walletAddress.addEventListener('click', () => {
                const fullAddress = (typeof Wallet !== 'undefined' && Wallet && typeof Wallet.getAddress === 'function')
                    ? Wallet.getAddress()
                    : null;
                if (!fullAddress) return;
                navigator.clipboard.writeText(fullAddress).catch(() => {
                    const textarea = document.createElement('textarea');
                    textarea.value = fullAddress;
                    document.body.appendChild(textarea);
                    textarea.select();
                    document.execCommand('copy');
                    document.body.removeChild(textarea);
                });
                // 复制反馈动画
                const el = elements.walletAddress;
                const original = el.textContent;
                el.textContent = '✓ 已复制';
                el.style.color = 'var(--success-color)';
                setTimeout(() => {
                    el.textContent = original;
                    el.style.color = '';
                }, 1200);
            });
        }
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
            elements.walletAddress.title = '点击复制 - ' + address;
            if (balance !== undefined) {
                const symbol = token || (typeof CONFIG !== 'undefined' ? CONFIG.getNativeSymbol() : 'POL');
                elements.walletBalance.textContent = `${parseFloat(balance).toFixed(4)} ${symbol}`;
            }
            const avatarEmoji = getAvatarForAddress(address);
            if (elements.walletAvatar) {
                elements.walletAvatar.textContent = avatarEmoji;
            }
            // 同步更新下拉面板中的用户身份区
            const ddAvatar = document.getElementById('dropdownUserAvatar');
            const ddAddress = document.getElementById('dropdownUserAddress');
            if (ddAvatar) ddAvatar.textContent = avatarEmoji;
            if (ddAddress) {
                ddAddress.textContent = address;
                ddAddress.title = '点击复制完整地址';
            }
        } else {
            elements.connectWalletBtn.classList.remove('hidden');
            elements.walletInfo.classList.add('hidden');
            elements.walletAddress.title = '复制';
        }
    }

    // 更新钱包多币种余额（用于点击展开详情）
    function updateWalletBalances(address, balances) {
        if (!address || !balances) return;
        const nativeSymbol = (typeof CONFIG !== 'undefined') ? CONFIG.getNativeSymbol() : 'POL';
        const nativeBalance = balances[nativeSymbol] || '0';
        const usdcBalance = balances['USDC'] || '0';

        // 主显示优先用 USDC（结算币），无 USDC 时用原生币
        if (usdcBalance !== '0') {
            elements.walletBalance.textContent = `${parseFloat(usdcBalance).toFixed(2)} USDC`;
        } else {
            elements.walletBalance.textContent = `${parseFloat(nativeBalance).toFixed(4)} ${nativeSymbol}`;
        }

        // 更新展开面板的各币种余额
        const nativeEl = document.getElementById('walletNativeBalance');
        const usdcEl = document.getElementById('walletUsdcBalance');
        if (nativeEl) nativeEl.textContent = `${parseFloat(nativeBalance).toFixed(4)} ${nativeSymbol}`;
        if (usdcEl) usdcEl.textContent = `${parseFloat(usdcBalance).toFixed(2)} USDC`;
    }

    // 更新网络信息显示（同步到 dropdown 身份卡 + 代币地址区）
    function updateNetworkInfo(chainId, networkName) {
        const networkIcons = {
            1: '🔷', 137: '🟣', 80002: '🟣', 5208888: '🔧',
            56: '🟡', 42161: '🔵', 10: '🔴', 8453: '🔵',
            43114: '🔺', 100: '🟢', 250: '🎭',
        };

        const icon = networkIcons[chainId] || '🔗';
        const name = networkName || `Chain #${chainId}`;

        // 同步更新 dropdown 身份卡里的网络显示
        const ddIcon = document.getElementById('dropdownNetworkIcon');
        const ddName = document.getElementById('dropdownNetworkName');
        const ddChainId = document.getElementById('dropdownChainId');
        if (ddIcon) ddIcon.textContent = icon;
        if (ddName) ddName.textContent = name;
        if (ddChainId) ddChainId.textContent = `Chain #${chainId}`;
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
            themeIcon.textContent = theme === 'dark' ? '🌙' : '☀️';
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
        // 同步更新 Settings 中的主题偏好，避免后续 loadFromServer 覆盖
        if (typeof Settings !== 'undefined' && Settings && typeof Settings.setPreference === 'function') {
            Settings.setPreference('theme', next);
        }
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

    // 设置资金阶段指示器（在 stageGame 的 game-header 中实时显示）
    // stage 取值：local_frozen / chain_frozen / revealing / settled / cancelled
    function setFundStage(stage) {
        if (!elements.gameFundStage) return;
        const text = FUND_STAGE_TEXT[stage] || FUND_STAGE_TEXT['local_frozen'];
        elements.gameFundStage.textContent = text;
        elements.gameFundStage.setAttribute('data-fund-stage', stage || 'local_frozen');
    }

    // 设置我的出拳
    function setMyChoice(choice, revealed = false) {
        if (!elements.myChoice) return;
        if (choice) {
            elements.myChoice.innerHTML = `<span>${RPSCrypto.getChoiceEmoji(choice)}</span>`;
            if (revealed) {
                elements.myChoice.classList.add('revealed');
                elements.myChoice.classList.remove('submitted');
            } else {
                // 已提交但未揭晓 → 金色脉冲提示
                elements.myChoice.classList.add('submitted');
                elements.myChoice.classList.remove('revealed');
            }
        } else {
            elements.myChoice.innerHTML = `<span class="choice-hidden">❓</span>`;
            elements.myChoice.classList.remove('revealed');
            elements.myChoice.classList.remove('submitted');
        }
    }

    // 设置对手出拳
    function setOpponentChoice(choice, revealed = false) {
        if (!elements.opponentChoice) return;
        if (choice && revealed) {
            elements.opponentChoice.innerHTML = `<span>${RPSCrypto.getChoiceEmoji(choice)}</span>`;
            elements.opponentChoice.classList.add('revealed');
            elements.opponentChoice.classList.remove('submitted');
        } else if (choice) {
            // 对手已提交但未揭晓 → 金色脉冲提示
            elements.opponentChoice.innerHTML = `<span>🔒</span>`;
            elements.opponentChoice.classList.add('submitted');
            elements.opponentChoice.classList.remove('revealed');
        } else {
            elements.opponentChoice.innerHTML = `<span class="choice-hidden">❓</span>`;
            elements.opponentChoice.classList.remove('revealed');
            elements.opponentChoice.classList.remove('submitted');
        }
    }

    // 设置我的状态
    function setMyStatus(text) {
        if (elements.myStatus) {
            elements.myStatus.textContent = text;
            // 🆕 出拳状态 → 红色高亮 + 脉冲
            elements.myStatus.classList.toggle('punch-here', text.includes('该你出拳'));
        }
    }

    // 设置对手状态
    function setOpponentStatus(text) {
        if (elements.opponentStatus) {
            elements.opponentStatus.textContent = text;
        }
    }

    // 设置对手地址
    function setOpponentAddress(address, isBot = false) {
        if (elements.opponentAddress) {
            const botBadge = isBot ? ' <span class="ai-badge" title="AI 机器人">🤖 AI</span>' : '';
            elements.opponentAddress.innerHTML = address ? formatAddress(address) + botBadge : '等待对手...';
        }
    }

    // 设置我的地址
    function setMyAddress(address, isBot = false) {
        if (elements.myAddress) {
            const botBadge = isBot ? ' <span class="ai-badge" title="AI 机器人">🤖 AI</span>' : '';
            elements.myAddress.innerHTML = address ? formatAddress(address) + botBadge : '我的地址';
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

    // 显示或隐藏重试/退出操作区
    // mode: 'create' 显示重试创建, 'join' 显示重试加入, null 隐藏整个区域
    function showRetrySection(mode) {
        if (!elements.retrySection) return;
        if (!mode) {
            elements.retrySection.classList.add('hidden');
            return;
        }
        elements.retrySection.classList.remove('hidden');
        if (elements.retryCreateBtn) {
            elements.retryCreateBtn.classList.toggle('hidden', mode !== 'create');
        }
        if (elements.retryJoinBtn) {
            elements.retryJoinBtn.classList.toggle('hidden', mode !== 'join');
        }
    }

    // 启用或禁用出拳按钮（含脉冲提示动画 + 🎯横幅）
    function setChoiceButtonsEnabled(enabled, opts = {}) {
        console.log('[UI] setChoiceButtonsEnabled', enabled, new Error().stack.split('\n').slice(1,4).join('\n'));
        const buttons = document.querySelectorAll('.choice-btn');
        const banner = document.getElementById('punchBanner');
        const hint = document.getElementById('punchBannerHint');
        buttons.forEach(btn => {
            btn.disabled = !enabled;
            btn.classList.toggle('ready-to-punch', enabled);
            btn.classList.remove('opponent-committed');
        });
        // 🎯 重新启用时解锁按钮
        if (enabled) {
            const buttonsWrap = document.querySelector('.choice-buttons');
            if (buttonsWrap) buttonsWrap.classList.remove('locked');
            buttons.forEach(btn => btn.classList.remove('selected'));
        }
        if (banner) {
            banner.classList.toggle('hidden', !enabled);
            if (enabled && hint) {
                // 根据对手状态定制提示语
                hint.textContent = opts.opponentCommitted
                    ? '⚡ 对手已提交！快出拳揭晓胜负！'
                    : '3 种选择：石头 ✊ 布 ✋ 剪刀 ✌️';
                // 对手已提交 → 按钮边框变催促感
                if (opts.opponentCommitted) {
                    buttons.forEach(btn => btn.classList.add('opponent-committed'));
                }
            }
        }
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
        
        // 🆕 防重复触发标记（结算动画只播一次）
        if (window._gameResultShown) {
            console.warn('[showResult] 已触发过，跳过重复调用');
            return;
        }
        window._gameResultShown = true;
        console.log('[showResult] 首次触发，播放结算动画');
        
        // 🆕 PK 动画模式
        const myFist = document.getElementById('pkMyFist');
        const oppFist = document.getElementById('pkOppFist');
        const pkLeft = document.getElementById('pkLeft');
        const pkRight = document.getElementById('pkRight');
        const resultReveal = document.getElementById('resultReveal');
        const pkProcess = document.getElementById('pkProcess');
        
        // 重置 PK 样式
        [pkLeft, pkRight].forEach(el => {
            el.classList.remove('winner', 'loser', 'draw');
        });
        if (resultReveal) resultReveal.classList.add('hidden');
        if (pkProcess) pkProcess.classList.add('hidden');
        
        // 设置双方出拳 emoji
        if (myFist && result.myChoice !== undefined) {
            myFist.textContent = RPSCrypto.getChoiceEmoji(result.myChoice);
        }
        if (oppFist && result.opponentChoice !== undefined) {
            oppFist.textContent = RPSCrypto.getChoiceEmoji(result.opponentChoice);
        }
        
        // 🆕 生成对决过程文字（如 "✊ 石头 打败 ✌️ 剪刀！"）
        if (pkProcess && result.myChoice !== undefined && result.opponentChoice !== undefined) {
            const myName = RPSCrypto.getChoiceName(result.myChoice);
            const oppName = RPSCrypto.getChoiceName(result.opponentChoice);
            const myEmoji = RPSCrypto.getChoiceEmoji(result.myChoice);
            const oppEmoji = RPSCrypto.getChoiceEmoji(result.opponentChoice);
            let processText = '';
            if (result.type === 'draw') {
                processText = `${myEmoji} ${myName} 对 ${oppEmoji} ${oppName} — 不分胜负！`;
            } else if (result.type === 'win') {
                processText = `${myEmoji} ${myName} 打败 ${oppEmoji} ${oppName}！`;
            } else {
                processText = `${oppEmoji} ${oppName} 打败 ${myEmoji} ${myName}！`;
            }
            pkProcess.textContent = processText;
        }
        
        // 🆕 触发 PK 对决结果（延迟 0.9s 后标记胜方 + 显示过程文字，1.5s 后显示结算详情）
        setTimeout(() => {
            if (result.type === 'win') {
                pkLeft?.classList.add('winner');
                pkRight?.classList.add('loser');
            } else if (result.type === 'lose') {
                pkLeft?.classList.add('loser');
                pkRight?.classList.add('winner');
            } else {
                pkLeft?.classList.add('draw');
                pkRight?.classList.add('draw');
            }
            // 🆕 显示过程文字（先 reset 动画才能重放）
            if (pkProcess) {
                pkProcess.style.animation = 'none';
                void pkProcess.offsetWidth;
                pkProcess.style.animation = '';
                pkProcess.classList.remove('hidden');
            }
        }, 900);
        
        setTimeout(() => {
            if (resultReveal) {
                resultReveal.classList.remove('hidden');
            }
        }, 1500);
        
        // 原有的结算详情填充
        elements.resultTitle.classList.remove('win', 'lose', 'draw');
        elements.resultIcon.classList.remove('win-icon', 'lose-icon', 'draw-icon');
        
        // 重触发动画
        elements.resultIcon.style.animation = 'none';
        elements.resultTitle.style.animation = 'none';
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
        const panelContent = document.getElementById('panelContent');
        const isSameActive = document.querySelector('.panel-tab.active')?.dataset.tab === tab;

        // 如果点击当前已激活的 tab，折叠面板
        if (isSameActive) {
            document.querySelectorAll('.panel-tab').forEach(t => t.classList.remove('active'));
            if (panelContent) panelContent.classList.add('hidden');
            return;
        }

        // 激活对应 tab 按钮
        document.querySelectorAll('.panel-tab').forEach(t => {
            t.classList.toggle('active', t.dataset.tab === tab);
        });

        // 显示面板容器
        if (panelContent) panelContent.classList.remove('hidden');
        
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
        // 更新切换按钮的图标：当前视图是 list 时显示 card 图标（提示点击后切换到 card），反之亦然
        const btn = document.getElementById('viewSwitchBtn');
        if (btn) {
            btn.dataset.view = view;
            const icon = btn.querySelector('.view-icon');
            if (icon) icon.textContent = view === 'list' ? '▦' : '☰';
            btn.title = view === 'list' ? '切换到卡片视图' : '切换到列表视图';
        }
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

    // 全局房间筛选状态
    let _lobbyFilter = 'all';  // all | available | in_progress
    let _allRoomsCache = [];

    // 渲染房间列表（支持分页 + 筛选）
    function renderRoomList(rooms, pagination) {
        if (!elements.roomList) return;

        // 缓存全量 + 更新 Tab 计数
        _allRoomsCache = rooms || [];
        updateLobbyTabCounts(_allRoomsCache);

        // 应用筛选
        let filtered = _allRoomsCache;
        if (_lobbyFilter === 'available') {
            filtered = _allRoomsCache.filter(r => r.status === 'created');
        } else if (_lobbyFilter === 'in_progress') {
            filtered = _allRoomsCache.filter(r => r.status === 'game_started' || r.status === 'countdown' || r.status === 'joined');
        }

        // 更新 Tab 激活态
        document.querySelectorAll('.lobby-tab').forEach(t => {
            t.classList.toggle('active', t.dataset.filter === _lobbyFilter);
        });

        // 表头显隐：只在 view-list 时显示
        const header = document.getElementById('roomListHeader');
        if (header) header.classList.toggle('show', roomListView === 'list');

        // 应用视图类
        elements.roomList.classList.toggle('view-list', roomListView === 'list');
        elements.roomList.classList.toggle('view-card', roomListView === 'card');

        // 更新统计（筛选后数量）
        const total = filtered.length;
        const available = filtered.filter(r => r.status === 'created').length;
        const started = filtered.filter(r => ['game_started','countdown','joined'].includes(r.status)).length;
        // 旧 stat 元素兼容（虽然 HTML 已换成 Tab）
        const statTotalEl = document.getElementById('statTotal');
        const statAvailableEl = document.getElementById('statAvailable');
        const statStartedEl = document.getElementById('statStarted');
        if (statTotalEl) statTotalEl.textContent = total;
        if (statAvailableEl) statAvailableEl.textContent = available;
        if (statStartedEl) statStartedEl.textContent = started;

        if (!filtered || filtered.length === 0) {
            const filterHint = _lobbyFilter !== 'all' ? `（"${_lobbyFilter === 'available' ? '可加入' : '游戏中'}"筛选下无房间）` : '';
            elements.roomList.innerHTML = `
                <div class="empty-state">
                    <span class="empty-icon">🏠</span>
                    <p>暂无可用房间 ${filterHint}</p>
                    <p class="empty-hint">点击下方按钮创建第一个房间</p>
                </div>
            `;
            // 分页器也需要更新总数
            renderRoomPagination({ ...pagination, total: _allRoomsCache.length });
            return;
        }

        // 状态文本映射
        const statusText = (status) => {
            const map = {
                'created': '等待对手',
                'joined': '准备中',
                'ready': '已准备',
                'countdown': '倒计时中',
                'game_started': '游戏中',
                'finished': '已结束'
            };
            return map[status] || status;
        };

        // 状态样式映射
        const statusClass = (status) => {
            const map = {
                'created': 'status-waiting',
                'joined': 'status-joined',
                'countdown': 'status-countdown',
                'game_started': 'status-started',
            };
            return map[status] || 'status-joined';
        };

        elements.roomList.innerHTML = filtered.map(room => {
            const isAvailable = room.status === 'created';
            const inProgress = room.status === 'game_started' || room.status === 'countdown';
            const creatorBadge = room.creator_is_bot ? '<span class="ai-badge" title="AI 机器人">🤖 AI</span>' : '';
            const player2Badge = room.player2_is_bot ? '<span class="ai-badge" title="AI 机器人">🤖 AI</span>' : '';
            return `
                <div class="room-card">
                    <div class="room-card-header">
                        <span class="room-id">#${room.room_id}</span>
                        <span class="room-status ${statusClass(room.status)}">
                            ${statusText(room.status)}
                        </span>
                    </div>
                    <div class="room-card-body">
                        <div class="room-player-info room-creator">
                            <span class="player-label">创建者</span>
                            <span class="player-value">${formatAddress(room.creator)}${creatorBadge}</span>
                        </div>
                        ${room.player2 ? `
                            <div class="room-player-info room-player2">
                                <span class="player-label">对手</span>
                                <span class="player-value">${formatAddress(room.player2)}${player2Badge}</span>
                            </div>
                        ` : `
                            <div class="room-player-info room-player2 room-empty">
                                <span class="player-value">— 等待加入 —</span>
                            </div>
                        `}
                        <div class="room-bet-info">
                            <span class="bet-token">${room.token}</span>
                            <span class="bet-amount">${room.bet_amount}</span>
                        </div>
                    </div>
                    ${isAvailable ? `
                        <button class="btn btn-outline btn-block btn-join-room" data-room-id="${room.room_id}">
                            🎯 加入房间
                        </button>
                    ` : inProgress ? `
                        <button class="btn btn-outline btn-block btn-enter-room" data-room-id="${room.room_id}">
                            ${room.status === 'game_started' ? '🎮 进入游戏' : '⏱ 进入房间'}
                        </button>
                    ` : `
                        <button class="btn btn-default btn-block" disabled>
                            不可加入
                        </button>
                    `}
                </div>
            `;
        }).join('');
    }

    // 渲染分页器
    function renderRoomPagination(pagination) {
        const pager = document.getElementById('roomPagination');
        if (!pager) return;

        const total = pagination?.total ?? 0;
        const page = pagination?.page ?? 1;
        const perPage = pagination?.perPage ?? 10;
        const totalPages = Math.max(1, Math.ceil(total / perPage));

        // 分页器始终显示（per_page 下拉是用户设置入口，不能藏）
        pager.classList.remove('hidden');

        // 房间总数 ≤ 1 时，分页按钮区清空，只保留 info + perPageSelect
        if (total <= 1) {
            const controls = document.getElementById('paginationControls');
            if (controls) controls.innerHTML = '';
            // 设置 info 文案友好
            const infoText = document.getElementById('pageInfoText');
            if (infoText) infoText.textContent = `${total} 个房间`;
            return;
        }

        // 信息文案
        const startIdx = (page - 1) * perPage + 1;
        const endIdx = Math.min(page * perPage, total);
        const infoText = document.getElementById('pageInfoText');
        if (infoText) infoText.textContent = `${startIdx}-${endIdx} / ${total}`;

        // per_page select 同步当前值
        const perSelect = document.getElementById('perPageSelect');
        if (perSelect && perSelect.value != perPage) {
            perSelect.value = String(perPage);
        }

        // 页码按钮
        const controls = document.getElementById('paginationControls');
        if (!controls) return;
        controls.innerHTML = '';

        const btnCls = 'page-btn';
        const prev = document.createElement('button');
        prev.className = `${btnCls} ${page === 1 ? 'disabled' : ''}`;
        prev.textContent = '‹';
        prev.title = '上一页';
        prev.disabled = page === 1;
        prev.addEventListener('click', () => {
            if (page > 1) { window.setRoomPage(page - 1); }
        });
        controls.appendChild(prev);

        // 页码范围（最多 5 个，带省略）
        const maxBtns = 5;
        let startP = Math.max(1, page - 2);
        let endP = Math.min(totalPages, startP + maxBtns - 1);
        if (endP - startP < maxBtns - 1) startP = Math.max(1, endP - maxBtns + 1);

        if (startP > 1) {
            const b1 = document.createElement('button');
            b1.className = btnCls; b1.textContent = '1';
            b1.addEventListener('click', () => window.setRoomPage(1));
            controls.appendChild(b1);
            if (startP > 2) { const e = document.createElement('span'); e.className = 'page-ellipsis'; e.textContent = '…'; controls.appendChild(e); }
        }

        for (let i = startP; i <= endP; i++) {
            const b = document.createElement('button');
            b.className = `${btnCls} ${i === page ? 'active' : ''}`;
            b.textContent = String(i);
            b.addEventListener('click', () => window.setRoomPage(i));
            controls.appendChild(b);
        }

        if (endP < totalPages) {
            if (endP < totalPages - 1) { const e = document.createElement('span'); e.className = 'page-ellipsis'; e.textContent = '…'; controls.appendChild(e); }
            const bn = document.createElement('button');
            bn.className = btnCls; bn.textContent = String(totalPages);
            bn.addEventListener('click', () => window.setRoomPage(totalPages));
            controls.appendChild(bn);
        }

        const next = document.createElement('button');
        next.className = `${btnCls} ${page === totalPages ? 'disabled' : ''}`;
        next.textContent = '›';
        next.title = '下一页';
        next.disabled = page === totalPages;
        next.addEventListener('click', () => {
            if (page < totalPages) { window.setRoomPage(page + 1); }
        });
        controls.appendChild(next);
    }

    // 更新大厅 Tab 计数徽章
    function updateLobbyTabCounts(rooms) {
        const all = rooms.length;
        const avail = rooms.filter(r => r.status === 'created').length;
        const started = rooms.filter(r => ['game_started','countdown','joined'].includes(r.status)).length;
        const elAll = document.getElementById('tabAllCount');
        const elAvail = document.getElementById('tabAvailableCount');
        const elStarted = document.getElementById('tabStartedCount');
        if (elAll) elAll.textContent = all;
        if (elAvail) elAvail.textContent = avail;
        if (elStarted) elStarted.textContent = started;
    }

    // 初始化大厅 Tab 点击事件（只绑一次）
    let _lobbyTabBound = false;
    function bindLobbyTabs() {
        if (_lobbyTabBound) return;
        _lobbyTabBound = true;
        document.addEventListener('click', (e) => {
            const tab = e.target.closest('.lobby-tab');
            if (!tab) return;
            e.preventDefault();
            const filter = tab.dataset.filter;
            if (!filter || filter === _lobbyFilter) return;
            _lobbyFilter = filter;
            // 重新渲染（用缓存）
            renderRoomList(_allRoomsCache, { page: 1, perPage: 10, total: _allRoomsCache.length });
        });
    }
    // DOM ready 后绑定
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', bindLobbyTabs);
    } else {
        bindLobbyTabs();
    }

    // 资金阶段 → 显示文案（中文，用户可理解的资金状态）
    const FUND_STAGE_TEXT = {
        'local_frozen': '🔒 资金：本地阶段（未上链，可随时退出）',
        'chain_frozen': '⛓️ 资金：链上已锁定（createMatch/joinMatch 后彻底锁定，只能出拳或超时强制结算）',
        'revealing':   '🔓 资金：揭晓中（出拳已提交，等待结算）',
        'settled':     '✅ 资金：已结算',
        'cancelled':   '❌ 资金：已解冻（房间关闭，本地冻结解除）',
    };

    // 设置房间信息
    function setRoomInfo(room, isCreator = false) {
        if (elements.roomIdDisplay) elements.roomIdDisplay.textContent = room.room_id;

        // 赌注精简显示在 VS 下方（金额 + 代币，详细信息后续单独设计）
        if (elements.roomVsStake) {
            elements.roomVsStake.textContent = `${room.bet_amount} ${room.token}`;
        }

        // 状态徽标保持简洁
        const statusText = {
            'created': '等待对手',
            'joined': '对手已加入',
            'ready': '双方已准备',
            'countdown': '倒计时中',
            'game_started': '游戏进行中',
            'closed': '已关闭',
            'finished': '已完成',
        };
        if (elements.roomStatusBadge) {
            elements.roomStatusBadge.textContent = statusText[room.status] || room.status;
        }

        const creatorIsBot = !!room.creator_is_bot;
        const opponentIsBot = !!room.player2_is_bot;
        const occupied = !!room.player2;

        // 创建者头像/名字
        if (elements.roomCreatorAvatar) {
            elements.roomCreatorAvatar.textContent = creatorIsBot ? '🤖' : '👤';
        }
        if (elements.roomCreatorAddress) {
            const botBadge = creatorIsBot ? ' <span class="ai-badge" title="AI 机器人">🤖 AI</span>' : '';
            elements.roomCreatorAddress.innerHTML = formatAddress(room.creator) + botBadge;
        }
        if (elements.roomCreatorStatus) {
            elements.roomCreatorStatus.textContent = isCreator
                ? '房主（自己）'
                : (creatorIsBot ? 'AI 房主' : '房主');
        }

        // 对手头像（空位 / 玩家 / AI）
        if (elements.roomOpponentCard) {
            elements.roomOpponentCard.classList.toggle('seat-empty', !occupied);
        }
        if (elements.seatAvatarIcon) {
            elements.seatAvatarIcon.textContent = occupied
                ? (opponentIsBot ? '🤖' : '👤')
                : '➕';
        }
        if (elements.roomOpponentAddress) {
            if (occupied) {
                const botBadge = opponentIsBot ? ' <span class="ai-badge" title="AI 机器人">🤖 AI</span>' : '';
                elements.roomOpponentAddress.innerHTML = formatAddress(room.player2) + botBadge;
            } else {
                elements.roomOpponentAddress.innerHTML = '等待对手...';
            }
        }
        if (elements.roomOpponentStatus) {
            elements.roomOpponentStatus.textContent = occupied
                ? (isCreator ? (opponentIsBot ? 'AI 已加入' : '已加入') : '对手（自己）')
                : '空位';
        }

        updateRoomReady(room.creator_ready, occupied ? room.player2_ready : false);
        updateSeatMenu(room, isCreator, occupied);
    }

    // 更新空位头像操作菜单（仅房主可管理空位）
    function updateSeatMenu(room, isCreator, occupied) {
        const btn = elements.seatAvatarBtn;
        const hint = elements.seatActionHint;
        const menu = elements.seatMenu;
        if (!btn || !menu) return;

        // 对局开始后不可再管理空位
        const manageable = isCreator
            && ['created', 'joined', 'countdown'].includes(room.status);
        btn.classList.toggle('clickable', manageable);

        if (hint) {
            if (!isCreator) {
                hint.textContent = '';
            } else if (occupied) {
                hint.textContent = '点击管理';
            } else {
                hint.textContent = room.seat_mode === 'ai' ? '邀请 AI 中' : '点击邀请';
            }
        }
        btn.title = !isCreator
            ? ''
            : occupied
                ? '管理对手（移出房间）'
                : '开放空位 / 邀请 AI / 邀请好友';

        const itemOpen = menu.querySelector('[data-seat-action="open"]');
        const itemAI = menu.querySelector('[data-seat-action="ai"]');
        const itemInvite = menu.querySelector('[data-seat-action="invite"]');
        const itemKick = menu.querySelector('[data-seat-action="kick"]');

        const seatMode = room.seat_mode || 'open';
        if (itemOpen) {
            itemOpen.classList.toggle('hidden', occupied);
            itemOpen.classList.toggle('active', !occupied && seatMode === 'open');
        }
        if (itemAI) {
            itemAI.classList.toggle('hidden', occupied);
            itemAI.classList.toggle('active', !occupied && seatMode === 'ai');
        }
        if (itemInvite) itemInvite.classList.toggle('hidden', occupied);
        if (itemKick) itemKick.classList.toggle('hidden', !occupied);

        // 非房主或不可管理时强制收起菜单
        if (!manageable) menu.classList.add('hidden');
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
        updateWalletBalances,
        formatAddress,
        setTheme,
        getCurrentTheme,
        toggleTheme,
        updateMatchingTime,
        updateGameTimer,
        setGameStatus,
        setFundStage,
        setMyChoice,
        setOpponentChoice,
        setMyStatus,
        setOpponentStatus,
        setOpponentAddress,
        setMyAddress,
        setGameId,
        showRevealButton,
        showTimeoutButton,
        showRetrySection,
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
        updateNetworkInfo,
        FUND_STAGE_TEXT,
    };
})();