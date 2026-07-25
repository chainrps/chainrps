const App = (function() {
    let currentMode = 'A';
    let currentToken = 'USDC';
    let currentAmount = 100;
    let currentGameId = null;
    let selectedChoice = null;
    let currentSalt = null;
    let myCommitSubmitted = false;
    let opponentCommitSubmitted = false;
    let myRevealed = false;
    let opponentRevealed = false;
    let matchingStartTime = null;
    let matchingTimer = null;
    let gameTimerInterval = null;
    let gamePhase = 'idle';

    function init() {
        UI.init();
        History.loadFromStorage();

        initTheme();
        initEventListeners();
        initWalletListeners();
        initContractListeners();

        const savedMode = localStorage.getItem('rps_mode');
        if (savedMode && CONFIG.enableModeB) {
            currentMode = savedMode;
        }
        UI.switchMode(currentMode);

        updateHistoryAndStats();
    }

    function initTheme() {
        const savedTheme = localStorage.getItem('rps_theme') || CONFIG.defaultTheme;
        UI.setTheme(savedTheme);
    }

    function initEventListeners() {
        document.getElementById('themeToggle').addEventListener('click', () => {
            UI.toggleTheme();
        });

        document.getElementById('connectWalletBtn').addEventListener('click', connectWallet);
        document.getElementById('disconnectBtn').addEventListener('click', disconnectWallet);

        document.querySelectorAll('.mode-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                const mode = btn.dataset.mode;
                if (mode === 'B' && !CONFIG.enableModeB) return;
                currentMode = mode;
                localStorage.setItem('rps_mode', mode);
                UI.switchMode(mode);
            });
        });

        document.querySelectorAll('.token-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                currentToken = btn.dataset.token;
                UI.showTokenSelect(currentToken);
                updateBalanceDisplay();
            });
        });

        document.querySelectorAll('.amount-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                currentAmount = parseFloat(btn.dataset.amount);
                document.getElementById('amountInput').value = currentAmount;
                document.querySelectorAll('.amount-btn').forEach(b => {
                    b.classList.toggle('active', b.dataset.amount === btn.dataset.amount);
                });
            });
        });

        document.getElementById('amountInput').addEventListener('input', (e) => {
            const val = parseFloat(e.target.value);
            if (!isNaN(val) && val > 0) {
                currentAmount = val;
                document.querySelectorAll('.amount-btn').forEach(b => {
                    b.classList.toggle('active', parseFloat(b.dataset.amount) === val);
                });
            }
        });

        document.getElementById('startGameBtn').addEventListener('click', startGame);

        document.getElementById('cancelMatchBtn').addEventListener('click', cancelMatch);

        document.querySelectorAll('.choice-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                const choice = parseInt(btn.dataset.choice);
                selectChoice(choice);
            });
        });

        document.getElementById('revealBtn').addEventListener('click', revealChoice);

        document.getElementById('claimTimeoutBtn').addEventListener('click', claimTimeout);

        document.getElementById('playAgainBtn').addEventListener('click', () => {
            UI.showStage('stageHome');
            resetGameState();
        });

        document.getElementById('backHomeBtn').addEventListener('click', () => {
            UI.showStage('stageHome');
            resetGameState();
        });

        document.querySelectorAll('.panel-tab').forEach(tab => {
            tab.addEventListener('click', () => {
                UI.switchTab(tab.dataset.tab);
            });
        });

        document.querySelectorAll('.view-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                UI.switchView(btn.dataset.view);
            });
        });
    }

    function initWalletListeners() {
        Wallet.on('accountChanged', (address) => {
            if (address) {
                handleWalletConnected(address);
            } else {
                handleWalletDisconnected();
            }
        });

        Wallet.on('chainChanged', (chainId) => {
            if (chainId !== CONFIG.chainId) {
                FWUI.Toast.warning(`当前网络 ChainID: ${chainId}，请切换到 Polygon 网络`);
            }
            updateBalanceDisplay();
        });

        Wallet.on('disconnect', () => {
            handleWalletDisconnected();
        });
    }

    function initContractListeners() {
        Contract.on('CommitSubmitted', (event, args) => {
            if (currentGameId && Number(event.args.gameId) === currentGameId) {
                const player = event.args.player;
                const myAddress = Wallet.getAddress();
                
                if (player.toLowerCase() === myAddress.toLowerCase()) {
                    myCommitSubmitted = true;
                    UI.setMyStatus('已提交');
                } else {
                    opponentCommitSubmitted = true;
                    UI.setOpponentStatus('已提交');
                    UI.setOpponentChoice(true, false);
                    FWUI.Toast.info('对手已提交出拳');
                }

                if (myCommitSubmitted && opponentCommitSubmitted) {
                    gamePhase = 'reveal';
                    UI.setGameStatus('揭晓阶段');
                    UI.setChoiceButtonsEnabled(false);
                    
                    if (selectedChoice && !myRevealed) {
                        UI.showRevealButton(true);
                    }
                    
                    startGameTimer('reveal');
                }
            }
        });

        Contract.on('ChoiceRevealed', (event, args) => {
            if (currentGameId && Number(event.args.gameId) === currentGameId) {
                const player = event.args.player;
                const choice = Number(event.args.choice);
                const myAddress = Wallet.getAddress();
                
                if (player.toLowerCase() === myAddress.toLowerCase()) {
                    myRevealed = true;
                    UI.setMyStatus('已揭晓');
                    UI.setMyChoice(choice, true);
                } else {
                    opponentRevealed = true;
                    UI.setOpponentStatus('已揭晓');
                    UI.setOpponentChoice(choice, true);
                    FWUI.Toast.info('对手已揭晓');
                }
            }
        });

        Contract.on('GameSettled', (event, args) => {
            if (currentGameId && Number(event.args.gameId) === currentGameId) {
                handleGameSettled(event.args);
            }
        });

        Contract.on('TimeoutClaimed', (event, args) => {
            if (currentGameId && Number(event.args.gameId) === currentGameId) {
                const myAddress = Wallet.getAddress();
                const claimer = event.args.claimer;
                const isWin = claimer.toLowerCase() === myAddress.toLowerCase();
                
                stopGameTimer();
                showResult({
                    type: isWin ? 'win' : 'lose',
                    reason: 'timeout'
                });
            }
        });

        Contract.on('DrawHandled', (event, args) => {
            if (currentGameId && Number(event.args.gameId) === currentGameId) {
                stopGameTimer();
                showResult({ type: 'draw' });
            }
        });
    }

    async function connectWallet() {
        try {
            const wallets = Wallet.getAvailableWallets();
            if (wallets.length === 0) {
                FWUI.Toast.error('未检测到 Web3 钱包，请先安装 MetaMask');
                return;
            }

            const result = await Wallet.connect();
            handleWalletConnected(result.address);
            
            FWUI.Toast.success('钱包连接成功');
        } catch (e) {
            FWUI.Toast.error(e.message || '连接失败');
        }
    }

    function handleWalletConnected(address) {
        UI.updateWalletInfo(address, '0', currentToken);
        UI.setMyAddress(address);
        
        initContract();
        
        if (Wallet.getChainId() !== CONFIG.chainId) {
            FWUI.Toast.warning('请切换到 Polygon Amoy 测试网');
        }
        
        updateBalanceDisplay();
        
        History.syncFromChain(address).then(() => {
            updateHistoryAndStats();
        });
    }

    function handleWalletDisconnected() {
        UI.updateWalletInfo(null);
        UI.setMyAddress('');
        currentGameId = null;
        resetGameState();
        UI.showStage('stageHome');
    }

    function disconnectWallet() {
        Wallet.disconnect();
        handleWalletDisconnected();
        FWUI.Toast.info('钱包已断开连接');
    }

    function initContract() {
        const provider = Wallet.getProvider();
        const signer = Wallet.getSigner();
        
        if (provider) {
            Contract.init(CONFIG.contractAddress, provider, signer);
            Contract.setupEventListener();
        }
    }

    async function updateBalanceDisplay() {
        if (!Wallet.isConnected()) return;
        
        try {
            const tokenAddress = CONFIG.tokenAddresses[currentToken];
            const balance = await Wallet.getBalance(tokenAddress);
            UI.updateWalletInfo(Wallet.getAddress(), balance, currentToken);
        } catch (e) {
            console.error('获取余额失败:', e);
        }
    }

    async function startGame() {
        if (!Wallet.isConnected()) {
            FWUI.Toast.warning('请先连接钱包');
            connectWallet();
            return;
        }

        if (currentAmount <= 0) {
            FWUI.Toast.error('请输入有效的下注金额');
            return;
        }

        if (currentMode === 'B') {
            const matchId = document.getElementById('matchIdInput').value.trim();
            if (matchId) {
                joinPrivateMatch(matchId);
            } else {
                createPrivateMatch();
            }
        } else {
            startQuickMatch();
        }
    }

    async function startQuickMatch() {
        try {
            UI.setStartButtonText('授权中...', true);
            
            const tokenAddress = CONFIG.tokenAddresses[currentToken];
            const myAddress = Wallet.getAddress();
            
            await Contract.ensureAllowance(tokenAddress, currentAmount, myAddress);
            
            UI.setStartButtonText('寻找对手中...', true);
            UI.showStage('stageMatching');
            UI.updateMatchingTime(0);
            UI.matchingAmount.textContent = `${currentAmount} ${currentToken}`;
            
            startMatchingTimer();
            
            if (currentMode === 'A' && CONFIG.backendUrl) {
                requestMatchFromBackend();
            }
        } catch (e) {
            FWUI.Toast.error(e.message || '操作失败');
            UI.setStartButtonText('寻找对手', false);
            UI.showStage('stageHome');
        }
    }

    function requestMatchFromBackend() {
        if (!CONFIG.backendUrl) return;
        
        fetch(`${CONFIG.backendUrl}/api/match/request`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                player_address: Wallet.getAddress(),
                token: currentToken,
                bet_amount: currentAmount
            })
        }).then(r => r.json()).then(data => {
            if (data.matched) {
                handleMatchFound(data.game_id, data.opponent);
            }
        }).catch(e => {
            console.error('匹配请求失败:', e);
        });
        
        if (CONFIG.wsUrl && Wallet.getAddress()) {
            GameSocket.connect(CONFIG.wsUrl, Wallet.getAddress());
            
            GameSocket.on('matched', (data) => {
                handleMatchFound(data.game_id, data.opponent);
            });
        }
    }

    function startMatchingTimer() {
        matchingStartTime = Date.now();
        matchingTimer = setInterval(() => {
            const elapsed = Math.floor((Date.now() - matchingStartTime) / 1000);
            UI.updateMatchingTime(elapsed);
        }, 1000);
    }

    function stopMatchingTimer() {
        if (matchingTimer) {
            clearInterval(matchingTimer);
            matchingTimer = null;
        }
    }

    function cancelMatch() {
        stopMatchingTimer();
        
        if (GameSocket.isConnected()) {
            GameSocket.disconnect();
        }
        
        UI.showStage('stageHome');
        UI.setStartButtonText('寻找对手', false);
        FWUI.Toast.info('已取消匹配');
    }

    function handleMatchFound(gameId, opponent) {
        stopMatchingTimer();
        currentGameId = Number(gameId);
        
        enterGamePhase();
        UI.setOpponentAddress(opponent);
        UI.setOpponentStatus('等待出拳');
        
        FWUI.Toast.success('匹配成功！');
    }

    async function createPrivateMatch() {
        try {
            UI.setStartButtonText('创建对局中...', true);
            
            const tokenAddress = CONFIG.tokenAddresses[currentToken];
            const myAddress = Wallet.getAddress();
            
            await Contract.ensureAllowance(tokenAddress, currentAmount, myAddress);
            
            const { gameId } = await Contract.createMatch(currentAmount, tokenAddress);
            currentGameId = gameId;
            
            UI.setStartButtonText('创建成功', false);
            
            enterGamePhase();
            UI.setOpponentStatus('等待对手加入');
            
            copyToClipboard(gameId.toString());
            FWUI.Toast.success(`对局已创建，ID: ${gameId} 已复制到剪贴板`);
            
            pollGameUntilJoined();
            
        } catch (e) {
            FWUI.Toast.error(e.message || '创建失败');
            UI.setStartButtonText('创建/加入私密对局', false);
        }
    }

    async function joinPrivateMatch(matchId) {
        try {
            UI.setStartButtonText('加入对局中...', true);
            
            const gameId = parseInt(matchId);
            if (isNaN(gameId) || gameId <= 0) {
                throw new Error('无效的对局 ID');
            }
            
            const tokenAddress = CONFIG.tokenAddresses[currentToken];
            const myAddress = Wallet.getAddress();
            
            await Contract.ensureAllowance(tokenAddress, currentAmount, myAddress);
            
            await Contract.joinMatch(gameId);
            currentGameId = gameId;
            
            enterGamePhase();
            
            const game = await Contract.getGame(gameId);
            const opponent = game.player1;
            UI.setOpponentAddress(opponent);
            UI.setOpponentStatus('等待出拳');
            
            FWUI.Toast.success('加入对局成功！');
            
        } catch (e) {
            FWUI.Toast.error(e.message || '加入失败');
            UI.setStartButtonText('创建/加入私密对局', false);
        }
    }

    async function pollGameUntilJoined() {
        const interval = setInterval(async () => {
            if (!currentGameId) {
                clearInterval(interval);
                return;
            }
            
            try {
                const game = await Contract.getGame(currentGameId);
                if (game.player2 && game.player2 !== '0x0000000000000000000000000000000000000000') {
                    clearInterval(interval);
                    
                    const myAddress = Wallet.getAddress();
                    const opponent = game.player1.toLowerCase() === myAddress.toLowerCase() ? game.player2 : game.player1;
                    
                    UI.setOpponentAddress(opponent);
                    UI.setOpponentStatus('等待出拳');
                    
                    FWUI.Toast.success('对手已加入！');
                }
            } catch (e) {
                console.error('查询对局失败:', e);
            }
        }, 3000);
    }

    function enterGamePhase() {
        gamePhase = 'commit';
        UI.showStage('stageGame');
        UI.setGameId(currentGameId);
        UI.setGameStatus('提交阶段');
        UI.setMyStatus('等待出拳');
        UI.setMyChoice(null);
        UI.setOpponentChoice(null);
        UI.setChoiceButtonsEnabled(true);
        UI.showRevealButton(false);
        UI.showTimeoutButton(false);
        
        selectedChoice = null;
        currentSalt = null;
        myCommitSubmitted = false;
        opponentCommitSubmitted = false;
        myRevealed = false;
        opponentRevealed = false;
        
        startGameTimer('commit');
    }

    function startGameTimer(phase) {
        stopGameTimer();
        
        const totalTime = phase === 'commit' ? CONFIG.commitTimeout : CONFIG.revealTimeout;
        let remaining = totalTime;
        
        UI.updateGameTimer(remaining);
        
        gameTimerInterval = setInterval(() => {
            remaining--;
            
            const isWarning = remaining <= 30;
            const isDanger = remaining <= 10;
            UI.updateGameTimer(remaining, isWarning, isDanger);
            
            if (remaining <= 0) {
                stopGameTimer();
                handleTimerExpired(phase);
            }
        }, 1000);
    }

    function stopGameTimer() {
        if (gameTimerInterval) {
            clearInterval(gameTimerInterval);
            gameTimerInterval = null;
        }
    }

    function handleTimerExpired(phase) {
        const myAddress = Wallet.getAddress();
        
        if (phase === 'commit') {
            if (myCommitSubmitted && !opponentCommitSubmitted) {
                UI.showTimeoutButton(true);
                UI.setGameStatus('对手超时');
            } else if (!myCommitSubmitted) {
                UI.setGameStatus('超时未提交');
            }
        } else {
            if (myRevealed && !opponentRevealed) {
                UI.showTimeoutButton(true);
                UI.setGameStatus('对手揭晓超时');
            }
        }
    }

    async function selectChoice(choice) {
        if (gamePhase !== 'commit' || myCommitSubmitted) return;
        
        selectedChoice = choice;
        UI.setSelectedChoice(choice);
        
        try {
            currentSalt = RPSCrypto.generateSalt();
            const myAddress = Wallet.getAddress();
            const commitHash = RPSCrypto.computeCommit(choice, currentSalt, myAddress);
            
            UI.setMyStatus('提交中...');
            
            await Contract.submitCommit(currentGameId, commitHash);
            
            myCommitSubmitted = true;
            UI.setMyStatus('已提交');
            UI.setChoiceButtonsEnabled(false);
            
            RPSCrypto.storeSalt(currentGameId, currentSalt, choice);
            
            FWUI.Toast.success('出拳已提交');
            
            if (opponentCommitSubmitted) {
                gamePhase = 'reveal';
                UI.setGameStatus('揭晓阶段');
                UI.showRevealButton(true);
                startGameTimer('reveal');
            }
            
        } catch (e) {
            FWUI.Toast.error(e.message || '提交失败');
            UI.setMyStatus('提交失败，重试');
            UI.setSelectedChoice(null);
            selectedChoice = null;
            currentSalt = null;
        }
    }

    async function revealChoice() {
        if (!selectedChoice || !currentSalt || !myCommitSubmitted || myRevealed) return;
        
        try {
            UI.revealBtn.disabled = true;
            UI.revealBtn.textContent = '揭晓中...';
            
            await Contract.revealChoice(currentGameId, selectedChoice, currentSalt);
            
            myRevealed = true;
            UI.showRevealButton(false);
            UI.setMyStatus('已揭晓');
            UI.setMyChoice(selectedChoice, true);
            
            FWUI.Toast.success('揭晓成功');
            
            RPSCrypto.clearSalt(currentGameId);
            
        } catch (e) {
            FWUI.Toast.error(e.message || '揭晓失败');
            UI.revealBtn.disabled = false;
            UI.revealBtn.textContent = '揭晓出拳';
        }
    }

    async function claimTimeout() {
        try {
            UI.claimTimeoutBtn.disabled = true;
            UI.claimTimeoutBtn.textContent = '索赔中...';
            
            await Contract.claimTimeout(currentGameId);
            
            FWUI.Toast.success('超时索赔成功');
            
        } catch (e) {
            FWUI.Toast.error(e.message || '索赔失败');
            UI.claimTimeoutBtn.disabled = false;
            UI.claimTimeoutBtn.textContent = '索赔超时胜利';
        }
    }

    function handleGameSettled(args) {
        stopGameTimer();
        
        const myAddress = Wallet.getAddress();
        const winner = args.winner;
        const amount = args.amount;
        const fee = args.fee;
        const isWin = winner.toLowerCase() === myAddress.toLowerCase();
        
        let myChoice = selectedChoice;
        let opponentChoice = null;
        
        if (Contract.getContract()) {
            Contract.getGame(currentGameId).then(game => {
                const isPlayer1 = game.player1.toLowerCase() === myAddress.toLowerCase();
                myChoice = isPlayer1 ? game.choice1 : game.choice2;
                opponentChoice = isPlayer1 ? game.choice2 : game.choice1;
                
                const tokenDecimals = CONFIG.supportedTokens.find(t => t.symbol === currentToken)?.decimals || 6;
                const amountFormatted = (Number(amount) / Math.pow(10, tokenDecimals)).toFixed(2);
                const feeFormatted = (Number(fee) / Math.pow(10, tokenDecimals)).toFixed(2);
                const prizeFormatted = (Number(amount) / Math.pow(10, tokenDecimals)).toFixed(2);
                
                showResult({
                    type: isWin ? 'win' : 'lose',
                    myChoice,
                    opponentChoice,
                    amount: (currentAmount * 2).toFixed(2),
                    prize: isWin ? prizeFormatted : '0',
                    fee: feeFormatted,
                    token: currentToken
                });
                
                History.addGame({
                    gameId: currentGameId,
                    myChoice,
                    opponentChoice,
                    amount: currentAmount,
                    token: currentToken,
                    result: isWin ? 'win' : 'lose',
                    timestamp: Date.now()
                });
                
                updateHistoryAndStats();
            });
        }
    }

    function showResult(result) {
        gamePhase = 'finished';
        UI.showStage('stageResult');
        UI.showResult(result);
    }

    function resetGameState() {
        currentGameId = null;
        selectedChoice = null;
        currentSalt = null;
        myCommitSubmitted = false;
        opponentCommitSubmitted = false;
        myRevealed = false;
        opponentRevealed = false;
        gamePhase = 'idle';
        
        stopGameTimer();
        stopMatchingTimer();
        
        if (GameSocket.isConnected()) {
            GameSocket.disconnect();
        }
        
        UI.setSelectedChoice(null);
        UI.setStartButtonText(currentMode === 'B' ? '创建/加入私密对局' : '寻找对手', false);
    }

    function updateHistoryAndStats() {
        const historyList = document.getElementById('historyList');
        if (historyList) {
            History.renderHistoryList(historyList, Wallet.getAddress());
        }
        UI.updateStats(History.getStats());
    }

    function copyToClipboard(text) {
        navigator.clipboard.writeText(text).catch(() => {
            const textarea = document.createElement('textarea');
            textarea.value = text;
            document.body.appendChild(textarea);
            textarea.select();
            document.execCommand('copy');
            document.body.removeChild(textarea);
        });
    }

    document.addEventListener('DOMContentLoaded', init);

    return {
        init,
        getCurrentMode: () => currentMode,
        getCurrentGameId: () => currentGameId
    };
})();
