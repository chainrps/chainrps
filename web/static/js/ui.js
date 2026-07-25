const UI = (function() {
    const elements = {};

    function init() {
        elements.themeToggle = document.getElementById('themeToggle');
        elements.connectWalletBtn = document.getElementById('connectWalletBtn');
        elements.walletInfo = document.getElementById('walletInfo');
        elements.walletBalance = document.getElementById('walletBalance');
        elements.walletAddress = document.getElementById('walletAddress');
        elements.disconnectBtn = document.getElementById('disconnectBtn');
        
        elements.modeSwitcher = document.getElementById('modeSwitcher');
        elements.modeBSection = document.getElementById('modeBSection');
        elements.modeBDesc = document.getElementById('modeBDesc');
        
        elements.stageHome = document.getElementById('stageHome');
        elements.stageMatching = document.getElementById('stageMatching');
        elements.stageGame = document.getElementById('stageGame');
        elements.stageResult = document.getElementById('stageResult');
        
        elements.amountInput = document.getElementById('amountInput');
        elements.startGameBtn = document.getElementById('startGameBtn');
        elements.startGameBtnText = document.getElementById('startGameBtnText');
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
    }

    function showStage(stage) {
        const stages = ['stageHome', 'stageMatching', 'stageGame', 'stageResult'];
        stages.forEach(s => {
            if (elements[s]) {
                elements[s].classList.toggle('hidden', s !== stage);
            }
        });
    }

    function updateWalletInfo(address, balance, token) {
        if (address) {
            elements.connectWalletBtn.classList.add('hidden');
            elements.walletInfo.classList.remove('hidden');
            elements.walletAddress.textContent = formatAddress(address);
            if (balance !== undefined) {
                elements.walletBalance.textContent = `${parseFloat(balance).toFixed(2)} ${token || 'USDC'}`;
            }
        } else {
            elements.connectWalletBtn.classList.remove('hidden');
            elements.walletInfo.classList.add('hidden');
        }
    }

    function formatAddress(address, len = 6) {
        if (!address) return '';
        if (address.length <= len * 2 + 2) return address;
        return address.slice(0, len) + '...' + address.slice(-len);
    }

    function setTheme(theme) {
        document.documentElement.setAttribute('data-theme', theme);
        const themeIcon = document.querySelector('.theme-icon');
        if (themeIcon) {
            themeIcon.textContent = theme === 'dark' ? '☀️' : '🌙';
        }
        localStorage.setItem('rps_theme', theme);
    }

    function getCurrentTheme() {
        return document.documentElement.getAttribute('data-theme') || 'light';
    }

    function toggleTheme() {
        const current = getCurrentTheme();
        const next = current === 'dark' ? 'light' : 'dark';
        setTheme(next);
        return next;
    }

    function updateMatchingTime(seconds) {
        if (elements.matchingTime) {
            elements.matchingTime.textContent = `${seconds}s`;
        }
    }

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

    function setGameStatus(text) {
        if (elements.gameStatusBadge) {
            elements.gameStatusBadge.textContent = text;
        }
    }

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

    function setMyStatus(text) {
        if (elements.myStatus) {
            elements.myStatus.textContent = text;
        }
    }

    function setOpponentStatus(text) {
        if (elements.opponentStatus) {
            elements.opponentStatus.textContent = text;
        }
    }

    function setOpponentAddress(address) {
        if (elements.opponentAddress) {
            elements.opponentAddress.textContent = address ? formatAddress(address) : '等待对手...';
        }
    }

    function setMyAddress(address) {
        if (elements.myAddress) {
            elements.myAddress.textContent = address ? formatAddress(address) : '我的地址';
        }
    }

    function setGameId(gameId) {
        if (elements.gameIdDisplay) {
            elements.gameIdDisplay.textContent = `对局 #${gameId}`;
        }
    }

    function showRevealButton(show) {
        if (elements.revealSection) {
            elements.revealSection.classList.toggle('hidden', !show);
        }
    }

    function showTimeoutButton(show) {
        if (elements.timeoutSection) {
            elements.timeoutSection.classList.toggle('hidden', !show);
        }
    }

    function setChoiceButtonsEnabled(enabled) {
        const buttons = document.querySelectorAll('.choice-btn');
        buttons.forEach(btn => {
            btn.disabled = !enabled;
        });
    }

    function setSelectedChoice(choice) {
        const buttons = document.querySelectorAll('.choice-btn');
        buttons.forEach(btn => {
            const btnChoice = parseInt(btn.dataset.choice);
            btn.classList.toggle('selected', btnChoice === choice);
        });
    }

    function showResult(result) {
        if (!elements.resultTitle) return;
        
        elements.resultTitle.classList.remove('win', 'lose', 'draw');
        
        if (result.type === 'win') {
            elements.resultIcon.textContent = '🏆';
            elements.resultTitle.textContent = '你赢了！';
            elements.resultTitle.classList.add('win');
            elements.resultDesc.textContent = '恭喜获得胜利';
        } else if (result.type === 'lose') {
            elements.resultIcon.textContent = '😢';
            elements.resultTitle.textContent = '你输了';
            elements.resultTitle.classList.add('lose');
            elements.resultDesc.textContent = '再接再厉，下一把加油！';
        } else {
            elements.resultIcon.textContent = '🤝';
            elements.resultTitle.textContent = '平局';
            elements.resultTitle.classList.add('draw');
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

    function setStartButtonText(text, loading = false) {
        if (elements.startGameBtnText) {
            elements.startGameBtnText.textContent = text;
        }
        if (elements.startGameBtn) {
            elements.startGameBtn.disabled = loading;
        }
    }

    function switchMode(mode) {
        const buttons = document.querySelectorAll('.mode-btn');
        buttons.forEach(btn => {
            btn.classList.toggle('active', btn.dataset.mode === mode);
        });
        
        if (mode === 'B') {
            elements.modeBSection.classList.remove('hidden');
            elements.modeBDesc.classList.remove('hidden');
            elements.startGameBtnText.textContent = '创建/加入私密对局';
        } else {
            elements.modeBSection.classList.add('hidden');
            elements.modeBDesc.classList.add('hidden');
            elements.startGameBtnText.textContent = '寻找对手';
        }
    }

    function switchTab(tab) {
        document.querySelectorAll('.panel-tab').forEach(t => {
            t.classList.toggle('active', t.dataset.tab === tab);
        });
        
        document.querySelectorAll('.tab-content').forEach(c => {
            c.classList.remove('active');
        });
        
        if (tab === 'history') {
            elements.tabHistory.classList.add('active');
        } else {
            elements.tabStats.classList.add('active');
        }
    }

    function switchView(view) {
        document.querySelectorAll('.view-btn').forEach(btn => {
            btn.classList.toggle('active', btn.dataset.view === view);
        });
        
        if (elements.historyList) {
            elements.historyList.classList.toggle('card-view', view === 'card');
        }
    }

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
        updateStats
    };
})();
