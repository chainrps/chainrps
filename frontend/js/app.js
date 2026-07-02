/**
 * ChainRPS 主应用逻辑
 * 整合钱包、合约、加密、WebSocket 等模块
 */

// ==================== 全局状态 ====================
const AppState = {
    currentGameId: null,
    currentChoice: null,
    currentSalt: null,
    currentToken: 'USDC',
    currentBetAmount: null,
    currentOpponent: null,
    isCommitPhase: false,
    isRevealPhase: false,
    hasCommitted: false,
    hasRevealed: false,
    wsConnected: false
};

// ==================== DOM 元素 ====================
const elements = {
    // Header
    langEn: document.getElementById('lang-en'),
    langZh: document.getElementById('lang-zh'),
    
    // Wallet
    connectWallet: document.getElementById('connect-wallet'),
    walletInfo: document.getElementById('wallet-info'),
    walletAddress: document.getElementById('wallet-address'),
    usdcBalance: document.getElementById('usdc-balance'),
    usdtBalance: document.getElementById('usdt-balance'),
    disconnectWallet: document.getElementById('disconnect-wallet'),
    
    // Game sections
    walletSection: document.getElementById('wallet-section'),
    gameSection: document.getElementById('game-section'),
    matchingSection: document.getElementById('matching-section'),
    playSection: document.getElementById('play-section'),
    historySection: document.getElementById('history-section'),
    futureSection: document.getElementById('future-section'),
    
    // Bet
    tokenUsdc: document.getElementById('token-usdc'),
    tokenUsdt: document.getElementById('token-usdt'),
    presetAmounts: document.querySelectorAll('.amount-btn'),
    betInput: document.getElementById('bet-input'),
    betTokenLabel: document.getElementById('bet-token-label'),
    startMatch: document.getElementById('start-match'),
    
    // Matching
    queuePos: document.getElementById('queue-pos'),
    cancelMatch: document.getElementById('cancel-match'),
    
    // Play
    currentGameId: document.getElementById('current-game-id'),
    opponentAddress: document.getElementById('opponent-address'),
    currentBet: document.getElementById('current-bet'),
    timeLeft: document.getElementById('time-left'),
    phaseCommit: document.getElementById('phase-commit'),
    phaseReveal: document.getElementById('phase-reveal'),
    phaseResult: document.getElementById('phase-result'),
    choiceButtons: document.querySelectorAll('.choice-btn'),
    committedInfo: document.getElementById('committed-info'),
    revealSection: document.getElementById('reveal-section'),
    revealBtn: document.getElementById('reveal-btn'),
    resultSection: document.getElementById('result-section'),
    resultTitle: document.getElementById('result-title'),
    yourChoice: document.getElementById('your-choice'),
    opponentChoice: document.getElementById('opponent-choice'),
    prizeAmount: document.getElementById('prize-amount'),
    prizeInfo: document.getElementById('prize-info'),
    drawActions: document.getElementById('draw-actions'),
    refundBtn: document.getElementById('refund-btn'),
    newGameBtn: document.getElementById('new-game-btn'),
    
    // Navigation
    navButtons: document.querySelectorAll('.nav-btn'),
    
    // Loading & Error
    loadingOverlay: document.getElementById('loading-overlay'),
    loadingText: document.getElementById('loading-text'),
    errorModal: document.getElementById('error-modal'),
    errorMessage: document.getElementById('error-message'),
    errorClose: document.getElementById('error-close')
};

// ==================== 初始化 ====================
async function init() {
    // 语言切换
    elements.langEn.addEventListener('click', () => switchLanguage('en'));
    elements.langZh.addEventListener('click', () => switchLanguage('zh'));
    
    // 钱包连接
    elements.connectWallet.addEventListener('click', connectWallet);
    elements.disconnectWallet.addEventListener('click', disconnectWallet);
    
    // 代币选择
    elements.tokenUsdc.addEventListener('click', () => selectToken('USDC'));
    elements.tokenUsdt.addEventListener('click', () => selectToken('USDT'));
    
    // 金额预设
    elements.presetAmounts.forEach(btn => {
        btn.addEventListener('click', () => selectPresetAmount(btn));
    });
    
    // 开始匹配
    elements.startMatch.addEventListener('click', startMatch);
    elements.cancelMatch.addEventListener('click', cancelMatch);
    
    // 出拳选择
    elements.choiceButtons.forEach(btn => {
        btn.addEventListener('click', () => selectChoice(btn));
    });
    
    // 揭晓
    elements.revealBtn.addEventListener('click', revealChoice);
    
    // 平局处理
    elements.refundBtn.addEventListener('click', handleDrawRefund);
    elements.newGameBtn.addEventListener('click', newGame);
    
    // 导航
    elements.navButtons.forEach(btn => {
        btn.addEventListener('click', () => switchTab(btn));
    });
    
    // 错误关闭
    elements.errorClose.addEventListener('click', hideError);
    
    // 钱包事件监听
    walletManager.setupListeners({
        onDisconnect: () => {
            showWalletSection();
            showSection(elements.walletSection);
        },
        onAccountChange: (address) => {
            elements.walletAddress.textContent = walletManager.formatAddress(address);
            updateBalanceDisplay();
        },
        onNetworkChange: (chainId) => {
            console.log('Network changed:', chainId);
        },
        onWrongNetwork: () => {
            showError(i18n.get('network_error'));
        }
    });
    
    // WebSocket 回调
    wsManager.setCallbacks({
        onConnect: () => {
            AppState.wsConnected = true;
        },
        onDisconnect: () => {
            AppState.wsConnected = false;
        },
        onMatchSuccess: (data) => {
            handleMatchSuccess(data);
        },
        onOpponentCommit: (data) => {
            handleOpponentCommit(data);
        },
        onRevealStart: (data) => {
            handleRevealStart(data);
        },
        onGameResult: (data) => {
            handleGameResult(data);
        },
        onTimeoutWarning: (data) => {
            showTimeoutWarning();
        },
        onTimeoutResult: (data) => {
            handleTimeoutResult(data);
        }
    });
    
    // 合约事件监听（如果已连接）
    contractManager.setupEventListeners({
        onGameCreated: (data) => {
            console.log('Game created:', data);
        },
        onPlayerJoined: (data) => {
            console.log('Player joined:', data);
        },
        onCommitSubmitted: (data) => {
            console.log('Commit submitted:', data);
        },
        onChoiceRevealed: (data) => {
            console.log('Choice revealed:', data);
        },
        onGameSettled: (data) => {
            console.log('Game settled:', data);
        }
    });
}

// ==================== 语言切换 ====================
function switchLanguage(lang) {
    i18n.setLanguage(lang);
    
    elements.langEn.classList.toggle('active', lang === 'en');
    elements.langZh.classList.toggle('active', lang === 'zh');
}

// ==================== 钱包操作 ====================
async function connectWallet() {
    showLoading(i18n.get('loading'));
    
    try {
        const result = await walletManager.connect();
        
        // 更新显示
        elements.walletAddress.textContent = walletManager.formatAddress(result.address);
        updateBalanceDisplay();
        
        // 初始化合约
        contractManager.initContract(walletManager.signer);
        
        // 连接 WebSocket
        wsManager.connect(result.address);
        
        // 显示游戏区域
        hideWalletSection();
        showSection(elements.gameSection);
        
        hideLoading();
        
    } catch (error) {
        hideLoading();
        showError(error.message || i18n.get('network_error'));
    }
}

async function disconnectWallet() {
    await walletManager.disconnect();
    wsManager.disconnect();
    
    showWalletSection();
    showSection(elements.walletSection);
}

function showWalletSection() {
    elements.connectWallet.classList.remove('hidden');
    elements.walletInfo.classList.add('hidden');
}

function hideWalletSection() {
    elements.connectWallet.classList.add('hidden');
    elements.walletInfo.classList.remove('hidden');
}

function updateBalanceDisplay() {
    elements.usdcBalance.textContent = parseFloat(walletManager.usdcBalance).toFixed(2);
    elements.usdtBalance.textContent = parseFloat(walletManager.usdtBalance).toFixed(2);
}

// ==================== 代币和金额选择 ====================
function selectToken(token) {
    AppState.currentToken = token;
    
    elements.tokenUsdc.classList.toggle('active', token === 'USDC');
    elements.tokenUsdt.classList.toggle('active', token === 'USDT');
    elements.betTokenLabel.textContent = token;
}

function selectPresetAmount(btn) {
    const amount = btn.getAttribute('data-amount');
    
    elements.presetAmounts.forEach(b => b.classList.remove('selected'));
    btn.classList.add('selected');
    
    elements.betInput.value = amount;
    AppState.currentBetAmount = parseFloat(amount);
}

// ==================== 匹配操作 ====================
async function startMatch() {
    if (!walletManager.address) {
        showError(i18n.get('connect_first'));
        return;
    }
    
    // 获取金额
    let amount = elements.betInput.value;
    if (!amount) {
        showError(i18n.get('enter_amount'));
        return;
    }
    
    AppState.currentBetAmount = parseFloat(amount);
    
    // 检查余额
    const balance = AppState.currentToken === 'USDC' 
        ? walletManager.usdcBalance 
        : walletManager.usdtBalance;
    
    if (parseFloat(balance) < AppState.currentBetAmount) {
        showError(i18n.get('insufficient_balance'));
        return;
    }
    
    showLoading(i18n.get('loading'));
    
    try {
        // 获取代币地址
        const tokenConfig = await contractManager.getTokenConfig(AppState.currentToken);
        const tokenAddress = tokenConfig.tokenAddress;
        
        // 授权代币给合约
        showLoading(i18n.get('approve_token'));
        await walletManager.approveToken(
            AppState.currentToken,
            contractManager.contractAddress,
            AppState.currentBetAmount
        );
        
        // 调用后端 API 请求匹配
        // 这里简化为直接创建对局（实际应该通过后端匹配服务）
        const result = await contractManager.createGame(tokenAddress, AppState.currentBetAmount);
        
        if (result) {
            AppState.currentGameId = result.gameId;
            
            // 等待对手加入（实际应该通过 WebSocket 监听）
            showSection(elements.matchingSection);
            hideSection(elements.gameSection);
            
            elements.queuePos.textContent = '1';
        }
        
        hideLoading();
        
    } catch (error) {
        hideLoading();
        showError(error.message || i18n.get('network_error'));
    }
}

async function cancelMatch() {
    showSection(elements.gameSection);
    hideSection(elements.matchingSection);
    
    // 如果已创建对局，取消它
    if (AppState.currentGameId) {
        try {
            await contractManager.cancelGame(AppState.currentGameId);
        } catch (error) {
            console.error('Cancel game error:', error);
        }
    }
    
    AppState.currentGameId = null;
}

// ==================== 对局操作 ====================
function handleMatchSuccess(data) {
    hideSection(elements.matchingSection);
    showSection(elements.playSection);
    
    AppState.currentGameId = data.game_id;
    AppState.currentOpponent = data.opponent;
    AppState.isCommitPhase = true;
    AppState.hasCommitted = false;
    AppState.hasRevealed = false;
    
    // 更新显示
    elements.currentGameId.textContent = data.game_id;
    elements.opponentAddress.textContent = walletManager.formatAddress(data.opponent);
    elements.currentBet.textContent = `${data.bet_amount} ${data.token}`;
    
    // 重置阶段指示器
    elements.phaseCommit.classList.add('active');
    elements.phaseCommit.classList.remove('completed');
    elements.phaseReveal.classList.remove('active', 'completed');
    elements.phaseResult.classList.remove('active', 'completed');
    
    // 重置出拳选择
    elements.choiceButtons.forEach(btn => btn.classList.remove('selected'));
    AppState.currentChoice = null;
    AppState.currentSalt = null;
    
    // 隐藏揭晓和结果区域
    elements.committedInfo.classList.add('hidden');
    elements.revealSection.classList.add('hidden');
    elements.resultSection.classList.add('hidden');
    
    // 订阅对局更新
    wsManager.subscribeGame(data.game_id);
    
    // 开始计时
    startTimer(data.commit_deadline);
}

function selectChoice(btn) {
    if (!AppState.isCommitPhase && !AppState.isRevealPhase) {
        return;
    }
    
    const choice = btn.getAttribute('data-choice');
    
    elements.choiceButtons.forEach(b => b.classList.remove('selected'));
    btn.classList.add('selected');
    
    AppState.currentChoice = choice;
    
    // 如果在提交阶段，自动提交
    if (AppState.isCommitPhase && !AppState.hasCommitted) {
        submitCommit();
    }
}

async function submitCommit() {
    if (!AppState.currentChoice) {
        showError(i18n.get('select_choice'));
        return;
    }
    
    showLoading(i18n.get('submitting'));
    
    try {
        // 生成盐值和哈希承诺
        const salt = cryptoUtils.generateSalt();
        const choiceNum = cryptoUtils.choiceToNumber(AppState.currentChoice);
        const commitHash = cryptoUtils.computeCommit(
            choiceNum,
            salt,
            walletManager.address
        );
        
        // 存储加密信息用于后续揭晓
        cryptoUtils.storeGameSecrets(AppState.currentGameId, choiceNum, salt);
        
        AppState.currentSalt = salt;
        
        // 提交到合约
        await contractManager.submitCommit(AppState.currentGameId, commitHash);
        
        AppState.hasCommitted = true;
        
        // 更新界面
        elements.committedInfo.classList.remove('hidden');
        elements.choiceButtons.forEach(btn => btn.disabled = true);
        
        hideLoading();
        
    } catch (error) {
        hideLoading();
        showError(error.message || i18n.get('network_error'));
    }
}

function handleOpponentCommit(data) {
    // 对手已提交
    const info = elements.committedInfo.querySelector('p:last-child');
    if (info) {
        info.textContent = i18n.get('opponent_commit');
    }
}

function handleRevealStart(data) {
    AppState.isCommitPhase = false;
    AppState.isRevealPhase = true;
    
    // 更新阶段指示器
    elements.phaseCommit.classList.remove('active');
    elements.phaseCommit.classList.add('completed');
    elements.phaseReveal.classList.add('active');
    
    // 显示揭晓区域
    elements.revealSection.classList.remove('hidden');
    
    // 重新启用按钮（但已选择的保持选中）
    elements.choiceButtons.forEach(btn => {
        btn.disabled = false;
        if (btn.getAttribute('data-choice') !== AppState.currentChoice) {
            btn.style.opacity = '0.5';
        }
    });
    
    // 更新计时器
    startTimer(data.reveal_deadline);
}

async function revealChoice() {
    showLoading(i18n.get('revealing'));
    
    try {
        // 获取存储的加密信息
        const secrets = cryptoUtils.getGameSecrets(AppState.currentGameId);
        
        if (!secrets) {
            showError('No secrets found');
            hideLoading();
            return;
        }
        
        // 揭晓
        const result = await contractManager.revealChoice(
            AppState.currentGameId,
            secrets.choice,
            secrets.salt
        );
        
        AppState.hasRevealed = true;
        
        // 清除存储的加密信息
        cryptoUtils.clearGameSecrets(AppState.currentGameId);
        
        hideLoading();
        
    } catch (error) {
        hideLoading();
        showError(error.message || i18n.get('network_error'));
    }
}

function handleGameResult(data) {
    AppState.isRevealPhase = false;
    
    // 更新阶段指示器
    elements.phaseReveal.classList.remove('active');
    elements.phaseReveal.classList.add('completed');
    elements.phaseResult.classList.add('active');
    
    // 显示结果
    elements.resultSection.classList.remove('hidden');
    elements.revealSection.classList.add('hidden');
    
    // 判断结果类型
    const isWin = data.winner === walletManager.address;
    const isDraw = data.is_draw || data.type?.includes('draw');
    
    if (isDraw) {
        elements.resultTitle.textContent = i18n.get('draw');
        elements.resultTitle.style.color = 'var(--warning-color)';
        elements.drawActions.classList.remove('hidden');
        elements.prizeInfo.classList.add('hidden');
    } else if (isWin) {
        elements.resultTitle.textContent = i18n.get('win');
        elements.resultTitle.style.color = 'var(--success-color)';
        elements.drawActions.classList.add('hidden');
        elements.prizeInfo.classList.remove('hidden');
        elements.prizeAmount.textContent = `${data.prize || data.prize_amount} ${AppState.currentToken}`;
    } else {
        elements.resultTitle.textContent = i18n.get('loss');
        elements.resultTitle.style.color = 'var(--danger-color)';
        elements.drawActions.classList.add('hidden');
        elements.prizeInfo.classList.add('hidden');
    }
    
    // 显示双方出拳
    elements.yourChoice.textContent = cryptoUtils.numberToChoice(AppState.currentChoice);
    elements.opponentChoice.textContent = cryptoUtils.numberToChoice(data.opponent_choice);
}

async function handleDrawRefund() {
    showLoading(i18n.get('loading'));
    
    try {
        await contractManager.handleDraw(AppState.currentGameId, 'refund');
        hideLoading();
        
        elements.drawActions.classList.add('hidden');
        elements.prizeInfo.classList.remove('hidden');
        elements.prizeAmount.textContent = `${AppState.currentBetAmount} ${AppState.currentToken} (Refunded)`;
        
    } catch (error) {
        hideLoading();
        showError(error.message || i18n.get('network_error'));
    }
}

function newGame() {
    // 重置状态
    AppState.currentGameId = null;
    AppState.currentChoice = null;
    AppState.currentSalt = null;
    AppState.currentOpponent = null;
    AppState.isCommitPhase = false;
    AppState.isRevealPhase = false;
    AppState.hasCommitted = false;
    AppState.hasRevealed = false;
    
    // 返回下注选择区域
    showSection(elements.gameSection);
    hideSection(elements.playSection);
    
    // 重置输入
    elements.betInput.value = '';
    elements.presetAmounts.forEach(b => b.classList.remove('selected'));
}

// ==================== 计时器 ====================
let timerInterval = null;

function startTimer(deadline) {
    if (timerInterval) {
        clearInterval(timerInterval);
    }
    
    const updateTimer = () => {
        const now = Math.floor(Date.now() / 1000);
        const remaining = deadline - now;
        
        if (remaining <= 0) {
            clearInterval(timerInterval);
            elements.timeLeft.textContent = '0s';
            elements.timeLeft.style.color = 'var(--danger-color)';
            return;
        }
        
        const minutes = Math.floor(remaining / 60);
        const seconds = remaining % 60;
        
        elements.timeLeft.textContent = `${minutes}:${seconds.toString().padStart(2, '0')}`;
        
        // 时间紧迫警告
        if (remaining <= 10) {
            elements.timeLeft.style.color = 'var(--danger-color)';
        } else if (remaining <= 30) {
            elements.timeLeft.style.color = 'var(--warning-color)';
        } else {
            elements.timeLeft.style.color = 'var(--text-color)';
        }
    };
    
    updateTimer();
    timerInterval = setInterval(updateTimer, 1000);
}

function showTimeoutWarning() {
    elements.timeLeft.style.color = 'var(--danger-color)';
}

function handleTimeoutResult(data) {
    // 处理超时结果
    handleGameResult(data);
}

// ==================== 导航 ====================
function switchTab(btn) {
    const tab = btn.getAttribute('data-tab');
    
    elements.navButtons.forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    
    // 隐藏所有区域
    hideSection(elements.gameSection);
    hideSection(elements.historySection);
    hideSection(elements.futureSection);
    
    // 显示对应区域
    switch (tab) {
        case 'play':
            if (walletManager.address) {
                showSection(elements.gameSection);
            } else {
                showSection(elements.walletSection);
            }
            break;
        case 'history':
            showSection(elements.historySection);
            loadHistory();
            break;
        case 'future':
            showSection(elements.futureSection);
            break;
    }
}

async function loadHistory() {
    // 加载对局历史
    // 实际应该从后端 API 获取
    try {
        const gameIds = await contractManager.getPlayerGames(walletManager.address);
        
        // 简化处理，显示游戏 ID 列表
        // 实际应该获取每个游戏的详情
        
    } catch (error) {
        console.error('Load history error:', error);
    }
}

// ==================== UI 工具函数 ====================
function showSection(section) {
    section.classList.remove('hidden');
}

function hideSection(section) {
    section.classList.add('hidden');
}

function showLoading(text) {
    elements.loadingOverlay.classList.remove('hidden');
    elements.loadingText.textContent = text;
}

function hideLoading() {
    elements.loadingOverlay.classList.add('hidden');
}

function showError(message) {
    elements.errorModal.classList.remove('hidden');
    elements.errorMessage.textContent = message;
}

function hideError() {
    elements.errorModal.classList.add('hidden');
}

// ==================== 启动应用 ====================
document.addEventListener('DOMContentLoaded', init);