const App = (function() {
    let currentMode = 'A';
    let currentToken = 'ETH';
    let currentAmount = 100;
    let currentGameId = null;
    let selectedChoice = null;
    let pendingChoice = null;
    let currentSalt = null;
    let myCommitSubmitted = false;
    let opponentCommitSubmitted = false;
    let myRevealed = false;
    let opponentRevealed = false;
    let matchingStartTime = null;
    let matchingTimer = null;
    let gameTimerInterval = null;
    let gamePhase = 'idle';

    async function init() {
        UI.init();
        History.loadFromStorage();
        Settings.loadFromStorage();

        initTheme();
        initEventListeners();
        initWalletListeners();
        initContractListeners();

        const savedMode = Settings.getDefaultMode();
        if (savedMode && CONFIG.enableModeB) {
            currentMode = savedMode;
        }
        UI.switchMode(currentMode);

        const savedToken = Settings.getDefaultToken();
        if (savedToken) {
            currentToken = savedToken;
            UI.showTokenSelect(currentToken);
        }

        updateHistoryAndStats();

        await autoConnectWallet();
        
        // 处理 URL 路由
        handleRoute();
        
        // 监听 URL 变化
        window.addEventListener('popstate', handleRoute);
    }

    function handleRoute() {
        const path = window.location.pathname;
        const params = new URLSearchParams(window.location.search);
        
        // 解析路由
        if (path === '/' || path === '/lobby') {
            enterLobby();
        } else if (path.startsWith('/room/')) {
            const roomId = path.replace('/room/', '');
            if (roomId) {
                // 先进入大厅，然后加入房间
                enterLobby();
                setTimeout(() => {
                    joinRoom(roomId);
                }, 500);
            } else {
                enterLobby();
            }
        } else if (path.startsWith('/game/')) {
            const gameId = path.replace('/game/', '');
            if (gameId) {
                enterLobby();
                // 可以在这里添加查看游戏结果的逻辑
            } else {
                enterLobby();
            }
        } else {
            enterLobby();
        }
    }

    function navigateTo(path) {
        window.history.pushState({}, '', path);
        handleRoute();
    }

    async function autoConnectWallet() {
        if (!window.ethereum) return;

        try {
            const result = await Wallet.autoConnect();
            if (result) {
                console.log('Auto-connected to wallet:', result.address);
            }
        } catch (e) {
            console.log('Auto-connect failed:', e.message);
        }
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

        // 旧界面元素已移除，事件监听器已迁移到交易大厅和弹窗中

        document.getElementById('cancelMatchBtn').addEventListener('click', cancelMatch);

        document.getElementById('createRoomBtn').addEventListener('click', createRoom);

        // 刷新大厅按钮
        const refreshBtn = document.getElementById('refreshRoomListBtn');
        if (refreshBtn) {
            refreshBtn.addEventListener('click', async () => {
                refreshBtn.classList.add('refreshing');
                await loadRoomList();
                setTimeout(() => refreshBtn.classList.remove('refreshing'), 600);
                FWUI.Toast.info('已刷新大厅');
            });
        }

        // 视图切换（列表/卡片）
        document.querySelectorAll('.view-switch-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                const view = btn.dataset.view;
                UI.setRoomListView(view);
                loadRoomList(); // 重新渲染
            });
        });

        // 私密模式复选框
        const privateCheckbox = document.getElementById('modePrivateCheckbox');
        if (privateCheckbox) {
            // 从 localStorage 恢复
            const savedMode = localStorage.getItem('rps_mode');
            privateCheckbox.checked = (savedMode === 'B');
            privateCheckbox.addEventListener('change', () => {
                currentMode = privateCheckbox.checked ? 'B' : 'A';
                localStorage.setItem('rps_mode', currentMode);
                UI.switchMode(currentMode);
                FWUI.Toast.info(privateCheckbox.checked ? '已切换到私密纯净模式' : '已切换到服务器交易大厅模式');
            });
        }

        document.getElementById('joinRoomBtn').addEventListener('click', showJoinRoomDialog);

        document.getElementById('readyBtn').addEventListener('click', toggleReady);

        document.getElementById('leaveRoomBtn').addEventListener('click', async () => {
            if (!currentRoomId) {
                UI.showStage('stageLobby');
                return;
            }

            const myAddress = Wallet.getAddress();
            if (!myAddress) {
                stopRoomPolling();
                currentRoomId = null;
                currentRoom = null;
                UI.showStage('stageLobby');
                return;
            }

            try {
                const res = await fetch(`${CONFIG.backendUrl}/api/game/room/leave`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        room_id: currentRoomId,
                        player_address: myAddress,
                    })
                });

                const data = await res.json();
                if (res.ok && data.success) {
                    if (data.action === 'dissolved') {
                        FWUI.Toast.info('房间已解散');
                    } else {
                        FWUI.Toast.info('已离开房间');
                    }
                } else {
                    FWUI.Toast.warning(data.detail || '退出房间失败');
                }
            } catch (e) {
                console.error('退出房间请求失败:', e);
            } finally {
                stopRoomPolling();
                currentRoomId = null;
                currentRoom = null;
                UI.showStage('stageLobby');
                loadRoomList();
            }
        });

        // 点击房间号徽章或复制按钮，复制房间号
        const copyRoomIdHandler = (e) => {
            if (!currentRoomId) {
                FWUI.Toast.warning('暂无房间号可复制');
                return;
            }
            copyToClipboard(currentRoomId);
            FWUI.Toast.success(`房间号已复制: ${currentRoomId}`);
            e.stopPropagation();
        };
        document.getElementById('copyRoomIdBtn').addEventListener('click', copyRoomIdHandler);
        document.getElementById('roomIdBadge').addEventListener('click', copyRoomIdHandler);

        document.addEventListener('click', (e) => {
            const joinBtn = e.target.closest('.btn-join-room');
            if (joinBtn) {
                const roomId = joinBtn.dataset.roomId;
                if (roomId) {
                    joinRoom(roomId);
                }
            }
        });

        // 双击房间卡片快速加入
        document.addEventListener('dblclick', (e) => {
            const card = e.target.closest('.room-card');
            if (card) {
                const joinBtn = card.querySelector('.btn-join-room');
                const roomId = joinBtn ? joinBtn.dataset.roomId : null;
                if (roomId) {
                    joinRoom(roomId);
                }
            }
        });

        document.querySelectorAll('.choice-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                const choice = parseInt(btn.dataset.choice);
                previewChoice(choice);
            });
        });

        document.getElementById('confirmChoiceBtn').addEventListener('click', () => {
            if (pendingChoice) {
                const choice = pendingChoice;
                pendingChoice = null;
                selectChoice(choice);
            }
        });

        document.getElementById('cancelChoiceBtn').addEventListener('click', () => {
            cancelChoicePreview();
        });

        document.getElementById('revealBtn').addEventListener('click', revealChoice);

        document.getElementById('claimTimeoutBtn').addEventListener('click', claimTimeout);

        document.getElementById('playAgainBtn').addEventListener('click', () => {
            UI.showStage('stageLobby');
            resetGameState();
        });

        document.getElementById('backHomeBtn').addEventListener('click', () => {
            UI.showStage('stageLobby');
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

        const saveSettingsBtn = document.getElementById('saveSettingsBtn');
        if (saveSettingsBtn) {
            saveSettingsBtn.addEventListener('click', async () => {
                const address = Wallet.getAddress();
                await Settings.saveSettings(address);
                FWUI.Toast.success('设置已保存，部分更改需刷新页面生效');
                const prefs = Settings.getPreferences();
                if (prefs.default_mode && prefs.default_mode !== currentMode) {
                    currentMode = prefs.default_mode;
                    UI.switchMode(currentMode);
                }
                if (prefs.default_token && prefs.default_token !== currentToken) {
                    currentToken = prefs.default_token;
                    UI.showTokenSelect(currentToken);
                    updateBalanceDisplay();
                }
                // 合约地址变更后重新初始化合约监听
                if (Wallet.isConnected()) {
                    initContract();
                }
            });
        }

        const settingThemeEl = document.getElementById('settingTheme');
        if (settingThemeEl) {
            settingThemeEl.addEventListener('change', (e) => {
                Settings.applyTheme(e.target.value);
            });
        }

        const verifyContractBtn = document.getElementById('verifyContractBtn');
        if (verifyContractBtn) {
            verifyContractBtn.addEventListener('click', verifyContractAddress);
        }
    }

    async function verifyContractAddress() {
        const addrEl = document.getElementById('settingContractAddress');
        const address = addrEl ? addrEl.value.trim() : '';

        if (!address) {
            FWUI.Toast.warning('请先输入合约地址');
            return;
        }

        if (!/^0x[a-fA-F0-9]{40}$/.test(address)) {
            FWUI.Toast.error('合约地址格式无效');
            return;
        }

        if (!window.ethers) {
            FWUI.Toast.error('ethers.js 未加载');
            return;
        }

        try {
            FWUI.Toast.info('正在验证合约...');
            const provider = Wallet.getProvider() || new ethers.BrowserProvider(window.ethereum);
            const tempContract = new ethers.Contract(address, Contract.ABI, provider);

            const info = await tempContract.getAntiFakeInfo();
            FWUI.Toast.success(`验证成功: ${info.version} · 开发者 ${address.slice(0, 8)}...`);
            console.log('合约验证信息:', info);
        } catch (e) {
            FWUI.Toast.error('合约验证失败：不是有效的 ChainRPS 合约');
            console.error('合约验证失败:', e);
        }
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
            const allowedChainIds = [CONFIG.getChainId(), 31337, 1337, 80002, 137];
            if (!allowedChainIds.includes(chainId)) {
                FWUI.Toast.warning(`当前网络 ChainID: ${chainId}，请切换到 Localhost 8545 或 Polygon 网络`);
            }
            currentToken = CONFIG.getDefaultToken();
            UI.showTokenSelect(currentToken);
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
                // 合约 v1.1.0：超时统一全额退款（平局处理），不判超时方负
                // TimeoutClaimed 之后会紧跟 DrawHandled 事件，由 handleDrawSettled 展示结果
                stopGameTimer();
                FWUI.Toast.info('对局超时，将退款给双方');
            }
        });

        Contract.on('DrawHandled', (event, args) => {
            if (currentGameId && Number(event.args.gameId) === currentGameId) {
                stopGameTimer();
                handleDrawSettled(event.args);
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

        currentToken = CONFIG.getDefaultToken();
        UI.showTokenSelect(currentToken);

        initContract();

        const allowedChainIds = [31337, 1337, 80002, 137];
        if (!allowedChainIds.includes(Wallet.getChainId())) {
            FWUI.Toast.warning('请切换到 Localhost 8545 或 Polygon 网络');
        }

        updateBalanceDisplay();
        
        History.syncFromChain(address).then(() => {
            updateHistoryAndStats();
        });

        Settings.loadFromServer(address).then(() => {
            Settings.renderSettingsForm();
            const prefs = Settings.getPreferences();
            if (prefs && prefs.theme) {
                Settings.applyTheme(prefs.theme);
            }
        });
    }

    function handleWalletDisconnected() {
        UI.updateWalletInfo(null);
        UI.setMyAddress('');
        currentGameId = null;
        resetGameState();
        UI.showStage('stageLobby');
    }

    async function disconnectWallet() {
        FWUI.Toast.info('正在断开钱包...');
        await Wallet.disconnect();
        handleWalletDisconnected();
        FWUI.Toast.success('钱包已断开连接');
    }

    function initContract() {
        const provider = Wallet.getProvider();
        const signer = Wallet.getSigner();
        const contractAddress = CONFIG.getContractAddress();

        if (provider && contractAddress) {
            const c = Contract.init(contractAddress, provider, signer);
            if (c) {
                Contract.setupEventListener();
            }
        }
    }

    async function updateBalanceDisplay() {
        if (!Wallet.isConnected()) return;

        try {
            const tokenAddress = CONFIG.getTokenAddresses()[currentToken];
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
            enterLobby();
        }
    }

    async function enterLobby() {
        navigateTo('/lobby');
        UI.showStage('stageLobby');
        // 应用首选视图（PC 默认列表，手机默认卡片，用户可手动切换）
        UI.setRoomListView(UI.getPreferredRoomListView());
        loadRoomList();
        startLobbyRefresh();
        connectLobbySocket();
    }

    let lobbyRefreshInterval = null;
    let lobbyWsConnected = false;

    function startLobbyRefresh() {
        stopLobbyRefresh();
        // 兜底轮询：每 30 秒拉取一次（WebSocket 是主要实时通道，轮询仅作补偿）
        lobbyRefreshInterval = setInterval(() => {
            // 离开大厅后自动停止刷新
            const lobby = document.getElementById('stageLobby');
            if (!lobby || lobby.classList.contains('hidden')) {
                stopLobbyRefresh();
                return;
            }
            loadRoomList();
        }, 30000);
    }

    function stopLobbyRefresh() {
        if (lobbyRefreshInterval) {
            clearInterval(lobbyRefreshInterval);
            lobbyRefreshInterval = null;
        }
    }

    /**
     * 连接交易大厅 WebSocket，监听房间列表变更事件
     * 收到 room_list_changed 事件后立即拉取最新房间列表
     */
    function connectLobbySocket() {
        if (lobbyWsConnected) return;
        if (!CONFIG.wsUrl || !Wallet.getAddress()) return;

        if (!GameSocket.isConnected()) {
            GameSocket.connect(CONFIG.wsUrl, Wallet.getAddress());
        }
        lobbyWsConnected = true;

        // 房间列表变更：实时刷新
        GameSocket.on('room_list_changed', (data) => {
            // 只在大厅可见时刷新，避免无意义请求
            const lobby = document.getElementById('stageLobby');
            if (!lobby || lobby.classList.contains('hidden')) return;
            loadRoomList();
        });
    }

    async function loadRoomList() {
        if (!CONFIG.backendUrl) return;

        try {
            const response = await fetch(`${CONFIG.backendUrl}/api/game/room/list`);
            const data = await response.json();
            UI.renderRoomList(data.rooms || []);
        } catch (e) {
            console.error('加载房间列表失败:', e);
            UI.renderRoomList([]);
        }
    }

    function showCreateRoomDialog() {
        return new Promise((resolve) => {
            const presetAmounts = [1, 10, 50, 100, 500];
            let selectedToken = currentToken || 'USDC';
            let selectedAmount = currentAmount || 1;

            const modal = FWUI.Modal.create({
                title: '➕ 创建房间',
                closable: true,
                maskClosable: true,
                content: () => {
                    const tokenOptions = ['ETH', 'USDC', 'USDT'];
                    return `
                        <div style="margin-bottom: 20px;">
                            <div style="font-size: 14px; font-weight: 600; color: #0f172a; margin-bottom: 10px;">选择代币</div>
                            <div style="display: flex; gap: 8px;">
                                ${tokenOptions.map(t => `
                                    <button class="dialog-token-btn" data-token="${t}" style="
                                        flex: 1;
                                        padding: 10px;
                                        border: 1px solid ${t === selectedToken ? '#6366f1' : '#e2e8f0'};
                                        border-radius: 10px;
                                        background: ${t === selectedToken ? '#6366f1' : '#fff'};
                                        color: ${t === selectedToken ? '#fff' : '#0f172a'};
                                        cursor: pointer;
                                        font-size: 14px;
                                        font-weight: 500;
                                        transition: all 0.15s ease;
                                    ">${t}</button>
                                `).join('')}
                            </div>
                        </div>
                        <div style="margin-bottom: 20px;">
                            <div style="font-size: 14px; font-weight: 600; color: #0f172a; margin-bottom: 10px;">下注金额</div>
                            <div style="display: flex; gap: 6px; flex-wrap: wrap; margin-bottom: 10px;">
                                ${presetAmounts.map(a => `
                                    <button class="dialog-amount-btn" data-amount="${a}" style="
                                        padding: 6px 14px;
                                        border: 1px solid ${a === selectedAmount ? '#6366f1' : '#e2e8f0'};
                                        border-radius: 999px;
                                        background: ${a === selectedAmount ? '#6366f1' : '#fff'};
                                        color: ${a === selectedAmount ? '#fff' : '#0f172a'};
                                        cursor: pointer;
                                        font-size: 13px;
                                        transition: all 0.15s ease;
                                    ">${a}</button>
                                `).join('')}
                            </div>
                            <input id="dialogAmountInput" type="number" value="${selectedAmount}" min="1" step="1" style="
                                width: 100%;
                                padding: 10px 12px;
                                border: 1px solid #e2e8f0;
                                border-radius: 10px;
                                font-size: 14px;
                                color: #0f172a;
                                background: #f8fafc;
                                box-sizing: border-box;
                                outline: none;
                            " />
                        </div>
                    `;
                },
                footer: `
                    <button class="fwui-btn fwui-btn-default" data-action="cancel" style="
                        padding: 8px 20px;
                        border-radius: 10px;
                        font-size: 14px;
                        font-weight: 500;
                        cursor: pointer;
                        border: 1px solid #e2e8f0;
                        background: #fff;
                        color: #0f172a;
                    ">取消</button>
                    <button class="fwui-btn fwui-btn-primary" data-action="confirm" style="
                        padding: 8px 20px;
                        border-radius: 10px;
                        font-size: 14px;
                        font-weight: 500;
                        cursor: pointer;
                        border: none;
                        background: #6366f1;
                        color: #fff;
                    ">创建房间</button>
                `
            });

            // 代币选择
            modal.element.querySelectorAll('.dialog-token-btn').forEach(btn => {
                btn.addEventListener('click', () => {
                    selectedToken = btn.dataset.token;
                    modal.element.querySelectorAll('.dialog-token-btn').forEach(b => {
                        const isActive = b.dataset.token === selectedToken;
                        b.style.borderColor = isActive ? '#6366f1' : '#e2e8f0';
                        b.style.background = isActive ? '#6366f1' : '#fff';
                        b.style.color = isActive ? '#fff' : '#0f172a';
                    });
                });
            });

            // 快捷金额
            modal.element.querySelectorAll('.dialog-amount-btn').forEach(btn => {
                btn.addEventListener('click', () => {
                    selectedAmount = parseFloat(btn.dataset.amount);
                    modal.element.querySelectorAll('.dialog-amount-btn').forEach(b => {
                        const isActive = parseFloat(b.dataset.amount) === selectedAmount;
                        b.style.borderColor = isActive ? '#6366f1' : '#e2e8f0';
                        b.style.background = isActive ? '#6366f1' : '#fff';
                        b.style.color = isActive ? '#fff' : '#0f172a';
                    });
                    const input = modal.element.querySelector('#dialogAmountInput');
                    if (input) input.value = selectedAmount;
                });
            });

            // 手动输入金额
            const amountInput = modal.element.querySelector('#dialogAmountInput');
            if (amountInput) {
                amountInput.addEventListener('input', () => {
                    selectedAmount = parseFloat(amountInput.value) || 0;
                });
            }

            // 确认/取消
            modal.element.querySelector('[data-action="confirm"]').addEventListener('click', () => {
                if (!selectedAmount || selectedAmount <= 0) {
                    FWUI.Toast.warning('请输入有效的下注金额');
                    return;
                }
                modal.close();
                resolve({ token: selectedToken, amount: selectedAmount });
            });
            modal.element.querySelector('[data-action="cancel"]').addEventListener('click', () => {
                modal.close();
                resolve(null);
            });
        });
    }

    async function createRoom() {
        if (!Wallet.isConnected()) {
            FWUI.Toast.warning('请先连接钱包');
            return;
        }

        // 弹窗让用户选择代币和金额
        const result = await showCreateRoomDialog();
        if (!result) return;

        try {
            const response = await fetch(`${CONFIG.backendUrl}/api/game/room/create`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    player_address: Wallet.getAddress(),
                    token: result.token,
                    bet_amount: result.amount
                })
            });

            const data = await response.json();
            if (data.success) {
                currentRoomId = data.room_id;
                currentRoom = {
                    room_id: data.room_id,
                    creator: Wallet.getAddress(),
                    player2: null,
                    token: result.token,
                    bet_amount: result.amount,
                    status: 'created',
                    creator_ready: false,
                    player2_ready: false,
                };
                enterRoomWait();
            } else {
                FWUI.Toast.error(data.message || '创建房间失败');
            }
        } catch (e) {
            FWUI.Toast.error(e.message || '创建房间失败');
        }
    }

    function showJoinRoomDialog() {
        let currentRooms = [];
        let selectedRoomId = null;
        let dropdownEl = null;

        const inputId = 'join-room-input-' + Date.now();

        const modal = FWUI.Modal.create({
            title: '加入房间',
            closable: false,
            maskClosable: false,
            content: () => `
                <div style="font-size: 14px; color: #475569; margin-bottom: 12px;">请输入房间 ID 或从下方列表选择:</div>
                <div style="position: relative;">
                    <input id="${inputId}" type="text" placeholder="输入房间 ID，或点击查看可用房间" style="
                        width: 100%;
                        padding: 10px 12px;
                        border: 1px solid #e2e8f0;
                        border-radius: 10px;
                        font-size: 14px;
                        color: #0f172a;
                        background: #f8fafc;
                        box-sizing: border-box;
                        outline: none;
                        transition: border-color 0.15s ease;
                        cursor: pointer;
                    " />
                </div>
            `,
            footer: `
                <button class="fwui-btn fwui-btn-default" data-action="cancel" style="
                    padding: 8px 20px;
                    border-radius: 10px;
                    font-size: 14px;
                    font-weight: 500;
                    cursor: pointer;
                    border: 1px solid #e2e8f0;
                    background: #fff;
                    color: #0f172a;
                ">取消</button>
                <button class="fwui-btn fwui-btn-primary" data-action="ok" style="
                    padding: 8px 20px;
                    border-radius: 10px;
                    font-size: 14px;
                    font-weight: 500;
                    cursor: pointer;
                    border: none;
                    background: #6366f1;
                    color: #fff;
                ">加入</button>
            `
        });

        const input = modal.element.querySelector('#' + inputId);

        // 将下拉框放到 body 上，用 fixed 定位，避免被 modal 的 overflow 裁剪
        function createDropdown() {
            if (dropdownEl) return;
            dropdownEl = document.createElement('div');
            dropdownEl.style.cssText = `
                position: fixed;
                background: #fff;
                border: 1px solid #e2e8f0;
                border-radius: 10px;
                box-shadow: 0 10px 25px -5px rgb(0 0 0 / 0.15), 0 8px 10px -6px rgb(0 0 0 / 0.1);
                z-index: 10001;
                max-height: 240px;
                overflow-y: auto;
                display: none;
            `;
            document.body.appendChild(dropdownEl);

            dropdownEl.querySelectorAll('.dropdown-room-item').forEach(item => {
                item.addEventListener('click', () => {
                    const roomId = item.dataset.roomId;
                    input.value = roomId;
                    selectedRoomId = roomId;
                    hideDropdown();
                });
            });
        }

        function positionDropdown() {
            if (!dropdownEl || !input) return;
            const rect = input.getBoundingClientRect();
            dropdownEl.style.left = rect.left + 'px';
            dropdownEl.style.top = (rect.bottom + 6) + 'px';
            dropdownEl.style.width = rect.width + 'px';
        }

        function showDropdown() {
            createDropdown();
            positionDropdown();
            dropdownEl.style.display = 'block';
            renderDropdownItems(input.value);
        }

        function hideDropdown() {
            if (dropdownEl) {
                dropdownEl.style.display = 'none';
            }
        }

        function renderDropdownItems(keyword) {
            if (!dropdownEl) return;
            const kw = (keyword || '').trim().toLowerCase();
            const filtered = currentRooms.filter(room =>
                room.status === 'created' &&
                (!kw || room.room_id.toLowerCase().includes(kw))
            );

            if (filtered.length === 0) {
                dropdownEl.innerHTML = `
                    <div style="padding: 20px; text-align: center; color: #94a3b8; font-size: 13px;">
                        ${kw ? '没有匹配的房间' : '暂无可用房间'}
                    </div>
                `;
            } else {
                dropdownEl.innerHTML = filtered.map(room => `
                    <div class="dropdown-room-item" data-room-id="${room.room_id}" style="
                        padding: 10px 14px;
                        cursor: pointer;
                        transition: background 0.15s ease;
                        display: flex;
                        justify-content: space-between;
                        align-items: center;
                    " onmouseover="this.style.background='#f1f5f9'" onmouseout="this.style.background='transparent'">
                        <span style="font-size: 14px; color: #0f172a; font-weight: 500;">#${room.room_id}</span>
                        <span style="font-size: 12px; color: #64748b;">${room.token} · ${room.bet_amount}</span>
                    </div>
                `).join('');

                dropdownEl.querySelectorAll('.dropdown-room-item').forEach(item => {
                    item.addEventListener('click', () => {
                        const roomId = item.dataset.roomId;
                        input.value = roomId;
                        selectedRoomId = roomId;
                        hideDropdown();
                    });
                });
            }
        }

        async function loadRoomsForDropdown() {
            if (!CONFIG.backendUrl) return [];
            try {
                const response = await fetch(`${CONFIG.backendUrl}/api/game/room/list`);
                const data = await response.json();
                return data.rooms || [];
            } catch (e) {
                console.error('加载房间列表失败:', e);
                return [];
            }
        }

        // modal 打开后加载房间列表，加载完自动显示下拉
        setTimeout(async () => {
            input.focus();
            const rooms = await loadRoomsForDropdown();
            currentRooms = rooms;
            if (document.activeElement === input) {
                showDropdown();
            }
        }, 150);

        // 窗口变化时重新定位
        window.addEventListener('resize', positionDropdown);
        window.addEventListener('scroll', positionDropdown, true);

        input.addEventListener('input', () => {
            if (dropdownEl && dropdownEl.style.display === 'block') {
                renderDropdownItems(input.value);
            } else {
                showDropdown();
            }
        });

        input.addEventListener('focus', () => {
            showDropdown();
        });

        input.addEventListener('click', (e) => {
            e.stopPropagation();
            showDropdown();
        });

        // 点击外部关闭
        document.addEventListener('click', handleOutsideClick);
        function handleOutsideClick(e) {
            if (!dropdownEl) return;
            if (!dropdownEl.contains(e.target) && e.target !== input) {
                hideDropdown();
            }
        }

        input.addEventListener('keydown', (e) => {
            if (e.key === 'Escape') {
                if (dropdownEl && dropdownEl.style.display === 'block') {
                    hideDropdown();
                    e.stopPropagation();
                } else {
                    modal.close();
                }
            }
        });

        const okBtn = modal.element.querySelector('[data-action="ok"]');
        const cancelBtn = modal.element.querySelector('[data-action="cancel"]');

        // 清理函数
        const originalClose = modal.close;
        modal.close = function() {
            window.removeEventListener('resize', positionDropdown);
            window.removeEventListener('scroll', positionDropdown, true);
            document.removeEventListener('click', handleOutsideClick);
            if (dropdownEl) {
                dropdownEl.remove();
                dropdownEl = null;
            }
            originalClose.call(modal);
        };

        okBtn.addEventListener('click', async () => {
            const roomId = input.value.trim();
            if (!roomId) {
                FWUI.Toast.warning('请输入有效的房间 ID');
                return;
            }

            const myAddress = Wallet.getAddress();
            if (!myAddress) {
                FWUI.Toast.warning('请先连接钱包');
                return;
            }

            okBtn.disabled = true;
            okBtn.textContent = '加入中...';

            try {
                const response = await fetch(`${CONFIG.backendUrl}/api/game/room/join`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        room_id: roomId,
                        player_address: myAddress
                    })
                });

                const data = await response.json();

                if (response.ok && data.room_id) {
                    currentRoomId = roomId;
                    currentRoom = data;
                    modal.close();
                    enterRoomWait();
                } else {
                    // 422 验证错误的 detail 是数组，需要提取字段信息
                    let errorMsg = '加入房间失败';
                    if (Array.isArray(data.detail) && data.detail.length > 0) {
                        const firstErr = data.detail[0];
                        errorMsg = `参数错误: ${firstErr.loc ? firstErr.loc.join('.') + ' ' : ''}${firstErr.msg || ''}`;
                    } else if (typeof data.detail === 'string') {
                        errorMsg = data.detail;
                    } else if (data.message) {
                        errorMsg = data.message;
                    }

                    if (errorMsg.includes('房间不存在')) {
                        FWUI.Toast.warning(errorMsg);
                    } else {
                        FWUI.Toast.error(errorMsg);
                    }
                    okBtn.disabled = false;
                    okBtn.textContent = '加入';
                    input.focus();
                }
            } catch (e) {
                FWUI.Toast.error(e.message || '加入房间失败');
                okBtn.disabled = false;
                okBtn.textContent = '加入';
                input.focus();
            }
        });

        cancelBtn.addEventListener('click', () => {
            modal.close();
        });

        setTimeout(() => {
            input.focus();
        }, 100);

        loadRoomsForDropdown().then(rooms => {
            currentRooms = rooms;
        });
    }

    async function joinRoom(roomId) {
        if (!Wallet.isConnected()) {
            FWUI.Toast.warning('请先连接钱包');
            return;
        }

        try {
            const response = await fetch(`${CONFIG.backendUrl}/api/game/room/join`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    room_id: roomId,
                    player_address: Wallet.getAddress()
                })
            });

            const data = await response.json();
            if (response.ok && data.room_id) {
                currentRoomId = roomId;
                currentRoom = data;
                enterRoomWait();
            } else {
                FWUI.Toast.error(data.detail || data.message || '加入房间失败');
                loadRoomList();
            }
        } catch (e) {
            FWUI.Toast.error(e.message || '加入房间失败');
        }
    }

    async function toggleReady() {
        if (!currentRoomId) return;

        try {
            const response = await fetch(`${CONFIG.backendUrl}/api/game/room/ready`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    room_id: currentRoomId,
                    player_address: Wallet.getAddress()
                })
            });

            const data = await response.json();
            if (response.ok && data.room_id) {
                currentRoom = data;
                updateRoomUI();
            } else {
                FWUI.Toast.error(data.detail || data.message || '操作失败');
            }
        } catch (e) {
            FWUI.Toast.error(e.message || '操作失败');
        }
    }

    function enterRoomWait() {
        if (currentRoomId) {
            navigateTo(`/room/${currentRoomId}`);
        }
        UI.showStage('stageRoomWait');
        updateRoomUI();
        startRoomPolling();
        connectRoomSocket();
    }

    function connectRoomSocket() {
        if (!CONFIG.wsUrl || !Wallet.getAddress()) return;
        if (!GameSocket.isConnected()) {
            GameSocket.connect(CONFIG.wsUrl, Wallet.getAddress());
        }
        // 房间模式 WebSocket 事件监听（事件名与后端 WSMessage.type 一致）
        GameSocket.on('room_joined', (data) => {
            if (currentRoomId === data.room_id) {
                loadRoomStatus();
            }
        });
        GameSocket.on('room_ready_change', (data) => {
            if (currentRoomId === data.room_id) {
                loadRoomStatus();
            }
        });
        GameSocket.on('countdown_tick', (data) => {
            if (currentRoomId === data.room_id) {
                loadRoomStatus();
                updateCountdownUI(data.remaining, data.is_danger);
            }
        });
        GameSocket.on('game_started', (data) => {
            if (currentRoomId === data.room_id) {
                handleRoomGameStarted(data);
            }
        });
        GameSocket.on('chain_game_created', (data) => {
            if (currentRoomId === data.room_id) {
                handleChainGameCreated(data);
            }
        });
        // 房间被创建者解散（对手已离开）
        GameSocket.on('room_dissolved', (data) => {
            if (currentRoomId === data.room_id) {
                FWUI.Toast.warning(data.message || '房间已被解散');
                stopRoomPolling();
                currentRoomId = null;
                currentRoom = null;
                UI.showStage('stageLobby');
                loadRoomList();
            }
        });
        // 对手（player2）离开房间
        GameSocket.on('player_left', (data) => {
            if (currentRoomId === data.room_id) {
                FWUI.Toast.info(data.message || '对手已离开房间');
                loadRoomStatus();
            }
        });
    }

    async function loadRoomStatus() {
        if (!currentRoomId) return;
        try {
            const response = await fetch(`${CONFIG.backendUrl}/api/game/room/${currentRoomId}`);
            const data = await response.json();
            if (response.ok) {
                currentRoom = data;
                updateRoomUI();
            }
        } catch (e) {
            console.error('加载房间状态失败:', e);
        }
    }

    function updateCountdownUI(remaining, isDanger) {
        UI.updateCountdown(remaining, isDanger);
    }

    function updateRoomUI() {
        if (!currentRoom) return;

        UI.setRoomInfo(currentRoom);

        const myAddress = Wallet.getAddress();
        const amICreator = currentRoom.creator.toLowerCase() === myAddress.toLowerCase();
        const amIReady = amICreator ? currentRoom.creator_ready : currentRoom.player2_ready;

        UI.setReadyButtonText(amIReady ? '取消准备' : '准备');

        if (currentRoom.status === 'countdown' || currentRoom.status === 'game_started') {
            UI.showCountdown(currentRoom.status === 'countdown');
        }
    }

    // ==================== 链上对局创建流程（房间模式） ====================
    // 倒计时结束后，后端创建本地对局记录并发送 game_started 事件。
    // 但链上对局尚未创建，需要：
    // 1. 创建者调用合约 createMatch() 创建链上对局，获取 chain_game_id
    // 2. 创建者上报 chain_game_id 到后端
    // 3. 后端通知 player2（chain_game_created 事件）
    // 4. player2 调用合约 joinMatch(chain_game_id) 加入链上对局
    // 5. 双方使用 chain_game_id 进入提交/揭晓阶段

    async function handleRoomGameStarted(data) {
        stopRoomPolling();
        currentRoom = currentRoom || {};
        currentRoom.token = data.token || currentRoom.token;
        currentRoom.bet_amount = data.bet_amount || currentRoom.bet_amount;

        const myAddress = Wallet.getAddress();
        const amICreator = currentRoom.creator && currentRoom.creator.toLowerCase() === myAddress.toLowerCase();

        UI.showCountdown(false);
        UI.setGameStatus('创建链上对局中...');

        if (amICreator) {
            // 创建者：调用合约 createMatch 创建链上对局
            await createChainGameForRoom(data);
        } else {
            // player2：等待创建者上报 chain_game_id
            UI.setGameStatus('等待对手创建链上对局...');
            FWUI.Toast.info('等待对手创建链上对局...');
        }
    }

    async function createChainGameForRoom(data) {
        try {
            UI.showStage('stageGame');
            UI.setGameId('创建中...');
            UI.setGameStatus('授权代币中...');
            UI.setMyStatus('创建对局');
            UI.setOpponentStatus('等待加入');

            const tokenAddress = CONFIG.getTokenAddresses()[currentRoom.token];
            const myAddress = Wallet.getAddress();

            // ERC20 需要先授权
            await Contract.ensureAllowance(tokenAddress, currentRoom.bet_amount, myAddress);

            UI.setGameStatus('创建链上对局中...');

            // 调用合约 createMatch
            const { gameId: chainGameId } = await Contract.createMatch(currentRoom.bet_amount, tokenAddress);

            if (!chainGameId) {
                throw new Error('未能获取链上对局 ID');
            }

            // 上报 chain_game_id 到后端
            await fetch(`${CONFIG.backendUrl}/api/game/room/${currentRoomId}/chain-game`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    chain_game_id: chainGameId,
                    player_address: myAddress,
                })
            });

            currentGameId = Number(chainGameId);
            UI.setGameId(currentGameId);
            UI.setGameStatus('等待对手加入');
            UI.setMyStatus('等待出拳');
            UI.setOpponentStatus('加入中...');

            FWUI.Toast.success(`链上对局已创建: #${chainGameId}`);

            // 轮询等待 player2 加入链上对局
            pollChainGameUntilJoined();
        } catch (e) {
            console.error('创建链上对局失败:', e);
            FWUI.Toast.error(e.message || '创建链上对局失败');
            UI.setGameStatus('创建失败');
            UI.showStage('stageRoomWait');
        }
    }

    async function handleChainGameCreated(data) {
        const chainGameId = Number(data.chain_game_id);
        if (!chainGameId) return;

        currentGameId = chainGameId;

        try {
            UI.showStage('stageGame');
            UI.setGameId(currentGameId);
            UI.setGameStatus('加入链上对局中...');
            UI.setMyStatus('加入中');
            UI.setOpponentStatus('已就绪');

            const tokenAddress = CONFIG.getTokenAddresses()[currentRoom.token];
            const myAddress = Wallet.getAddress();

            // ERC20 需要先授权
            await Contract.ensureAllowance(tokenAddress, currentRoom.bet_amount, myAddress);

            // 调用合约 joinMatch
            await Contract.joinMatch(currentGameId);

            enterGamePhase();
            UI.setOpponentStatus('等待出拳');
            FWUI.Toast.success('已加入链上对局！');
        } catch (e) {
            console.error('加入链上对局失败:', e);
            FWUI.Toast.error(e.message || '加入链上对局失败');
            UI.setGameStatus('加入失败');
            UI.showStage('stageRoomWait');
        }
    }

    async function pollChainGameUntilJoined() {
        const maxAttempts = 100; // 约 5 分钟
        let attempts = 0;
        const interval = setInterval(async () => {
            if (!currentGameId || attempts >= maxAttempts) {
                clearInterval(interval);
                if (attempts >= maxAttempts && currentGameId) {
                    FWUI.Toast.warning('等待对手加入超时');
                    UI.setGameStatus('等待对手加入超时');
                }
                return;
            }
            attempts++;

            try {
                const game = await Contract.getGame(currentGameId);
                // player2 已加入（非零地址）且状态为 CommitPhase
                if (game.player2 && game.player2 !== '0x0000000000000000000000000000000000000000') {
                    clearInterval(interval);

                    const myAddress = Wallet.getAddress();
                    const opponent = game.player1.toLowerCase() === myAddress.toLowerCase() ? game.player2 : game.player1;

                    UI.setOpponentAddress(opponent);
                    enterGamePhase();
                    FWUI.Toast.success('对手已加入，开始出拳！');
                }
            } catch (e) {
                console.error('查询链上对局失败:', e);
            }
        }, 3000);
    }

    let currentRoomId = null;
    let currentRoom = null;
    let roomPollingInterval = null;

    async function startRoomPolling() {
        if (roomPollingInterval) clearInterval(roomPollingInterval);

        roomPollingInterval = setInterval(async () => {
            if (!currentRoomId) {
                clearInterval(roomPollingInterval);
                return;
            }

            try {
                const response = await fetch(`${CONFIG.backendUrl}/api/game/room/${currentRoomId}`);
                const data = await response.json();
                if (response.ok) {
                    // 检查房间是否存在
                    if (data.success === false && data.message === '房间不存在或已关闭') {
                        stopRoomPolling();
                        FWUI.Toast.info('房间已关闭或不存在');
                        UI.showStage('stageLobby');
                        return;
                    }
                    currentRoom = data;
                    updateRoomUI();
                }
            } catch (e) {
                console.error('轮询房间状态失败:', e);
            }
        }, 2000);
    }

    function stopRoomPolling() {
        if (roomPollingInterval) {
            clearInterval(roomPollingInterval);
            roomPollingInterval = null;
        }
    }

    async function startQuickMatch() {
        try {
            UI.setStartButtonText('授权中...', true);
            
            const contract = Contract.getContract();
            if (!contract) {
                throw new Error('合约未部署或配置，请联系管理员');
            }
            
            const tokenAddress = CONFIG.getTokenAddresses()[currentToken];
            const myAddress = Wallet.getAddress();
            
            await Contract.ensureAllowance(tokenAddress, currentAmount, myAddress);
            
            UI.setStartButtonText('寻找对手中...', true);
            UI.showStage('stageMatching');
            UI.updateMatchingTime(0);
            if (UI.elements.matchingAmount) {
                UI.elements.matchingAmount.textContent = `${currentAmount} ${currentToken}`;
            }
            
            startMatchingTimer();
            
            if (currentMode === 'A' && CONFIG.backendUrl) {
                requestMatchFromBackend();
            }
        } catch (e) {
            FWUI.Toast.error(e.message || '操作失败');
            UI.showStage('stageLobby');
        }
    }

    function requestMatchFromBackend() {
        if (!CONFIG.backendUrl) return;

        // 防止 fetch 和 WebSocket 重复触发匹配成功
        let matchHandled = false;

        function onMatchFound(gameId, opponent) {
            if (matchHandled) return;
            matchHandled = true;
            handleMatchFound(gameId, opponent);
        }

        fetch(`${CONFIG.backendUrl}/api/game/join`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                player_address: Wallet.getAddress(),
                token: currentToken,
                bet_amount: currentAmount
            })
        }).then(async r => {
            if (!r.ok) {
                const errorData = await r.json().catch(() => null);
                const errorMsg = errorData?.detail || errorData?.message || `HTTP ${r.status}`;
                throw new Error(`匹配请求失败: ${errorMsg}`);
            }
            return r.json();
        }).then(data => {
            if (data.matched) {
                onMatchFound(data.game_id, data.opponent);
            }
        }).catch(e => {
            console.error('匹配请求失败:', e);
            FWUI.Toast.error(e.message || '匹配请求失败');
            UI.showStage('stageLobby');
        });

        if (CONFIG.wsUrl && Wallet.getAddress()) {
            GameSocket.connect(CONFIG.wsUrl, Wallet.getAddress());

            GameSocket.on('match_success', (data) => {
                onMatchFound(data.game_id, data.opponent);
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
        
        UI.showStage('stageLobby');
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
            
            const tokenAddress = CONFIG.getTokenAddresses()[currentToken];
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
            
            const tokenAddress = CONFIG.getTokenAddresses()[currentToken];
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
        const maxAttempts = 60; // 最多轮询 60 次（约 3 分钟）
        let attempts = 0;
        const interval = setInterval(async () => {
            if (!currentGameId || attempts >= maxAttempts) {
                clearInterval(interval);
                if (attempts >= maxAttempts && currentGameId) {
                    FWUI.Toast.warning('等待对手超时，请稍后在历史记录中查看');
                    UI.showStage('stageLobby');
                    currentGameId = null;
                }
                return;
            }
            attempts++;

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

        // 重置确认区
        pendingChoice = null;
        const confirmSection = document.getElementById('choiceConfirmSection');
        if (confirmSection) confirmSection.classList.add('hidden');

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

    function previewChoice(choice) {
        if (gamePhase !== 'commit' || myCommitSubmitted) return;

        pendingChoice = choice;
        UI.setSelectedChoice(choice);

        // 显示确认区
        const confirmSection = document.getElementById('choiceConfirmSection');
        const preview = document.getElementById('selectedChoicePreview');
        if (confirmSection && preview) {
            preview.textContent = RPSCrypto.getChoiceEmoji(choice);
            confirmSection.classList.remove('hidden');
        }
        // 隐藏选择按钮（避免重复点）
        document.querySelectorAll('.choice-btn').forEach(btn => {
            btn.disabled = true;
        });
    }

    function cancelChoicePreview() {
        pendingChoice = null;
        UI.setSelectedChoice(null);
        const confirmSection = document.getElementById('choiceConfirmSection');
        if (confirmSection) confirmSection.classList.add('hidden');
        document.querySelectorAll('.choice-btn').forEach(btn => {
            btn.disabled = false;
        });
    }

    async function selectChoice(choice) {
        if (gamePhase !== 'commit' || myCommitSubmitted) return;

        selectedChoice = choice;
        UI.setSelectedChoice(choice);

        // 隐藏确认区和选择按钮
        const confirmSection = document.getElementById('choiceConfirmSection');
        if (confirmSection) confirmSection.classList.add('hidden');
        
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
        // GameSettled 事件的 amount = winnerPrize（总池 - 手续费），fee = 手续费
        const winnerPrize = args.amount;
        const fee = args.fee;
        const isWin = winner && winner.toLowerCase() === myAddress.toLowerCase();

        // 实际下注金额：优先取房间信息，其次取首页选择
        const betAmount = (currentRoom && currentRoom.bet_amount) ? currentRoom.bet_amount : currentAmount;
        const tokenSymbol = (currentRoom && currentRoom.token) ? currentRoom.token : currentToken;

        const tokenDecimals = CONFIG.getSupportedTokens().find(t => t.symbol === tokenSymbol)?.decimals || 18;
        const winnerPrizeFormatted = (Number(winnerPrize) / Math.pow(10, tokenDecimals)).toFixed(4);
        const feeFormatted = (Number(fee) / Math.pow(10, tokenDecimals)).toFixed(4);
        const totalPool = (Number(winnerPrize) + Number(fee)) / Math.pow(10, tokenDecimals);

        const buildResult = (myChoice, opponentChoice) => {
            showResult({
                type: isWin ? 'win' : 'lose',
                myChoice,
                opponentChoice,
                amount: totalPool.toFixed(2),
                prize: isWin ? winnerPrizeFormatted : '0',
                fee: feeFormatted,
                token: tokenSymbol
            });

            History.addGame({
                gameId: currentGameId,
                myChoice,
                opponentChoice,
                amount: betAmount,
                token: tokenSymbol,
                result: isWin ? 'win' : 'lose',
                timestamp: Date.now()
            });

            updateHistoryAndStats();
        };

        // 优先从链上查询双方出拳
        if (Contract.getContract()) {
            Contract.getGame(currentGameId).then(game => {
                const isPlayer1 = game.player1.toLowerCase() === myAddress.toLowerCase();
                const myChoice = isPlayer1 ? game.choice1 : game.choice2;
                const opponentChoice = isPlayer1 ? game.choice2 : game.choice1;
                buildResult(myChoice, opponentChoice);
            }).catch(() => {
                buildResult(selectedChoice, null);
            });
        } else {
            buildResult(selectedChoice, null);
        }
    }

    function showResult(result) {
        gamePhase = 'finished';
        UI.showStage('stageResult');
        UI.showResult(result);
    }

    function handleDrawSettled(args) {
        const myAddress = Wallet.getAddress();

        // 平局退款金额：优先取房间信息，其次取首页选择
        const betAmount = (currentRoom && currentRoom.bet_amount) ? currentRoom.bet_amount : currentAmount;
        const tokenSymbol = (currentRoom && currentRoom.token) ? currentRoom.token : currentToken;
        const betAmountNum = Number(betAmount) || 0;

        if (Contract.getContract()) {
            Contract.getGame(currentGameId).then(game => {
                const isPlayer1 = game.player1.toLowerCase() === myAddress.toLowerCase();
                const myChoice = isPlayer1 ? game.choice1 : game.choice2;
                const opponentChoice = isPlayer1 ? game.choice2 : game.choice1;

                showResult({
                    type: 'draw',
                    myChoice,
                    opponentChoice,
                    amount: betAmountNum.toFixed(2),
                    prize: betAmountNum.toFixed(2),
                    fee: '0',
                    token: tokenSymbol
                });

                History.addGame({
                    gameId: currentGameId,
                    myChoice,
                    opponentChoice,
                    amount: betAmountNum,
                    token: tokenSymbol,
                    result: 'draw',
                    timestamp: Date.now()
                });

                updateHistoryAndStats();
            }).catch(() => {
                showResult({
                    type: 'draw',
                    myChoice: selectedChoice,
                    opponentChoice: null,
                    amount: betAmountNum.toFixed(2),
                    prize: betAmountNum.toFixed(2),
                    fee: '0',
                    token: tokenSymbol
                });
            });
        } else {
            showResult({ type: 'draw' });
        }
    }

    function resetGameState() {
        currentGameId = null;
        selectedChoice = null;
        pendingChoice = null;
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
        UI.setStartButtonText(currentMode === 'B' ? '创建/加入私密对局' : '🏠 进入交易大厅', false);
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