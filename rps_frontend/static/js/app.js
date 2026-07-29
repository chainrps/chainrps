// 应用主模块（立即执行函数）
const App = (function () {
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
    let autoRevealTimer = null; // 自动揭示计时器
    let resultCountdownTimer = null; // 结果界面倒计时计时器

    // 根据链ID获取网络名称
    function getNetworkNameByChainId(chainId) {
        if (CONFIG.networks) {
            for (const [key, network] of Object.entries(CONFIG.networks)) {
                if (network.chainId === chainId) {
                    return network.name;
                }
            }
        }
        // 额外的已知网络映射
        const knownNetworks = {
            1: 'Ethereum Mainnet',
            137: 'Polygon Mainnet',
            80002: 'Polygon Amoy',
            5208888: 'ChainRPS Local',
            56: 'BNB Chain',
            42161: 'Arbitrum One',
            10: 'Optimism',
            8453: 'Base',
            43114: 'Avalanche',
            100: 'Gnosis',
            250: 'Fantom',
        };
        return knownNetworks[chainId] || `Chain #${chainId}`;
    }

    // 初始化应用
    async function init() {
        UI.init();
        History.loadFromStorage();
        Settings.loadFromStorage();

        initTheme();
        initEventListeners();
        initWalletListeners();
        initContractListeners();
        initChainStatusIndicator();

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

        // 检查 MOCK 参数（调试用，优先于路由处理）
        await checkMockParams();

        // 处理 URL 路由（mock 模式下跳过）
        if (!isMockMode) {
            handleRoute();
        }

        // 监听 URL 变化
        window.addEventListener('popstate', handleRoute);

        // 首次检测主链状态
        checkChainStatus();
        // 每 60 秒自动检测一次
        setInterval(checkChainStatus, 60000);
    }

    // ==================== 主链状态检测 ====================

    let chainStatusCheckInProgress = false;
    let lastChainStatusResult = null;
    let chainStatusAutoRefreshTimer = null;

    // 初始化主链状态指示器
    function initChainStatusIndicator() {
        const indicator = document.getElementById('chainStatusIndicator');
        const panel = document.getElementById('chainStatusPanel');
        const closeBtn = document.getElementById('chainStatusPanelClose');
        const recheckBtn = document.getElementById('csRecheckBtn');
        const openAdminBtn = document.getElementById('csOpenAdminBtn');

        if (indicator) {
            indicator.addEventListener('click', () => {
                if (panel) panel.classList.toggle('hidden');
                if (panel && !panel.classList.contains('hidden')) {
                    checkChainStatus();
                }
            });
        }
        if (closeBtn) {
            closeBtn.addEventListener('click', () => {
                panel.classList.add('hidden');
            });
        }
        if (recheckBtn) {
            recheckBtn.addEventListener('click', () => {
                checkChainStatus(true);
            });
        }
        if (openAdminBtn) {
            openAdminBtn.addEventListener('click', () => {
                window.open('/admin#/local-chain', '_blank');
            });
        }
        // 点击面板外关闭
        document.addEventListener('click', (e) => {
            if (panel && panel.classList.contains('hidden')) return;
            if (!indicator || !panel) return;
            if (indicator.contains(e.target) || panel.contains(e.target)) return;
            panel.classList.add('hidden');
        });
    }

    // 检查主链状态
    async function checkChainStatus(forceRefresh = false) {
        if (chainStatusCheckInProgress) return;
        if (!CONFIG.backendUrl) return;
        chainStatusCheckInProgress = true;

        const indicator = document.getElementById('chainStatusIndicator');
        const dot = document.getElementById('chainStatusDot');
        const text = document.getElementById('chainStatusText');

        if (dot) dot.textContent = '⏳';
        if (text) text.textContent = '检测中';
        if (indicator) indicator.className = 'chain-status-indicator';

        try {
            const t0 = Date.now();
            const res = await fetch(`${CONFIG.backendUrl}/api/ext/chain-status`, {
                method: 'GET',
                headers: {'Cache-Control': 'no-cache'},
                signal: AbortSignal.timeout ? AbortSignal.timeout(8000) : undefined,
            });
            const clientLatency = Date.now() - t0;
            const data = await res.json();
            lastChainStatusResult = data;
            renderChainStatus(data, clientLatency);
        } catch (e) {
            const errMsg = e && e.message ? e.message : String(e);
            if (dot) dot.textContent = '🔴';
            if (text) text.textContent = '后端不可达';
            if (indicator) indicator.className = 'chain-status-indicator status-error';
            // 同步更新面板
            const checkStatus = document.getElementById('csCheckStatus');
            const errEl = document.getElementById('csError');
            if (checkStatus) {
                checkStatus.textContent = '检测失败';
                checkStatus.className = 'value err';
            }
            if (errEl) {
                errEl.textContent = '后端服务无法访问: ' + errMsg;
                errEl.className = 'value err';
            }
        } finally {
            chainStatusCheckInProgress = false;
        }
    }

    // 渲染主链状态到UI
    function renderChainStatus(data, clientLatency) {
        const indicator = document.getElementById('chainStatusIndicator');
        const dot = document.getElementById('chainStatusDot');
        const text = document.getElementById('chainStatusText');

        const rpcReachable = !!data.rpc_reachable;
        const hasError = !!data.error;
        const contractOk = data.contract_code_exists === true;
        const contractMissing = data.contract_code_exists === false;

        // 判定总体状态: ok / warning / error
        let status = 'ok';
        let dotChar = '🟢';
        let textStr = '正常';

        if (!rpcReachable) {
            status = 'error';
            dotChar = '🔴';
            textStr = 'RPC不可达';
        } else if (contractMissing) {
            status = 'warning';
            dotChar = '🟡';
            textStr = '合约未部署';
        } else if (hasError) {
            // RPC 可达但有错误（如 chain id 不匹配）
            status = 'warning';
            dotChar = '🟡';
            textStr = '配置异常';
        }

        if (dot) dot.textContent = dotChar;
        if (text) text.textContent = textStr;
        if (indicator) indicator.className = 'chain-status-indicator status-' + status;

        // 更新详情面板
        // 设置状态值到指定元素
        const setVal = (id, val, cls) => {
            const el = document.getElementById(id);
            if (!el) return;
            el.textContent = val == null ? '-' : String(val);
            el.className = 'value' + (cls ? ' ' + cls : '');
        };

        // 格式化时间显示
        const fmtTime = (iso) => {
            if (!iso) return '-';
            try {
                const d = new Date(iso);
                return d.toLocaleString('zh-CN', {
                    timeZone: 'Asia/Shanghai',
                    year: 'numeric', month: '2-digit', day: '2-digit',
                    hour: '2-digit', minute: '2-digit', second: '2-digit',
                    hour12: false,
                });
            } catch (e) {
                return iso;
            }
        };

        setVal('csCheckStatus', status === 'ok' ? '✓ 正常' : (status === 'warning' ? '⚠ 异常' : '✗ 故障'),
            status === 'ok' ? 'ok' : (status === 'warning' ? 'warn' : 'err'));
        setVal('csRpcUrl', data.rpc_url || '-');
        setVal('csRpcReachable', rpcReachable ? '✓ 可达' : '✗ 不可达',
            rpcReachable ? 'ok' : 'err');
        setVal('csLatency', data.latency_ms != null ? `${data.latency_ms} ms` : '-');
        setVal('csChainId', data.chain_id != null ?
                `${data.chain_id}${data.expected_chain_id && data.chain_id !== data.expected_chain_id ? ' (期望 ' + data.expected_chain_id + ')' : ''}` : '-',
            data.expected_chain_id && data.chain_id !== data.expected_chain_id ? 'warn' : 'ok');
        setVal('csBlockNumber', data.block_number != null ? Number(data.block_number).toLocaleString() : '-');
        setVal('csContractAddress', data.contract_address || '未配置');
        if (data.contract_code_exists === null || data.contract_code_exists === undefined) {
            setVal('csContractCode', '-');
        } else if (data.contract_code_exists) {
            setVal('csContractCode', '✓ 已部署', 'ok');
        } else {
            setVal('csContractCode', '✗ 未部署', 'err');
        }
        setVal('csError', data.error || '无', data.error ? 'err' : 'ok');
        setVal('csCheckedAt', fmtTime(data.checked_at));
    }

    // 检查并加载Mock调试参数
    async function checkMockParams() {
        const params = new URLSearchParams(window.location.search);
        const mockStage = params.get('mock');

        if (!mockStage) return;

        isMockMode = true;
        console.log('[MOCK] 检测到 mock 参数:', mockStage);

        try {
            const response = await fetch(`/api/game/debug/mock-ui/${mockStage}`);
            const result = await response.json();

            if (!result.success) {
                console.error('[MOCK] 获取模拟数据失败:', result.message);
                FWUI.Toast.error('MOCK 加载失败: ' + result.message);
                return;
            }

            const data = result.data;

            switch (mockStage) {
                case 'lobby':
                    // 大厅列表 MOCK
                    UI.showStage('stageLobby');
                    UI.setRoomListView(UI.getPreferredRoomListView());
                    if (data.rooms && Array.isArray(data.rooms)) {
                        UI.renderRoomList(data.rooms);
                    }
                    FWUI.Toast.success('已进入 MOCK 大厅（共 ' + (data.total || 0) + ' 个房间）');
                    break;

                case 'room_wait':
                    // 房间等待中 MOCK
                    currentRoom = data;
                    currentRoomId = data.room_id;
                    currentMode = 'R';
                    UI.showStage('stageRoomWait');
                    UI.setGameId(data.room_id);
                    UI.setMyAddress(data.creator);
                    UI.setOpponentAddress(data.player2);
                    UI.setMyStatus(data.creator_ready ? '已准备' : '未准备');
                    UI.setOpponentStatus(data.player2_ready ? '已准备' : '未准备');
                    FWUI.Toast.success('已进入 MOCK 房间等待界面');
                    break;

                case 'countdown':
                    // 倒计时中 MOCK - 使用 stageGame 显示倒计时
                    currentRoom = data;
                    currentRoomId = data.room_id;
                    currentMode = 'R';
                    UI.showStage('stageGame');
                    UI.setGameId(data.room_id);
                    UI.setGameStatus('倒计时中（MOCK模式）');
                    UI.setMyAddress(data.creator);
                    UI.setOpponentAddress(data.player2);
                    UI.setMyStatus('已准备');
                    UI.setOpponentStatus('已准备');
                    UI.setMyChoice(null);
                    UI.setOpponentChoice(null);
                    UI.setChoiceButtonsEnabled(false);
                    UI.showRevealButton(false);
                    UI.showTimeoutButton(false);
                    // 显示倒计时数字
                    const cdRemaining = 15 - Math.min(15, Math.floor(Date.now() / 1000 - (data.countdown_start || 0)));
                    UI.updateCountdown(Math.max(1, cdRemaining), cdRemaining <= 5);
                    FWUI.Toast.success('已进入 MOCK 倒计时界面');
                    break;

                case 'game_commit':
                    // 直接进入游戏出拳阶段
                    currentRoom = data;
                    currentRoomId = data.room_id;
                    currentGameId = data.game_id;
                    currentMode = 'R';

                    resetGameState();
                    currentRoom = data;
                    currentRoomId = data.room_id;
                    currentGameId = data.game_id;

                    UI.showStage('stageGame');
                    UI.setGameId(`MOCK-${data.game_id}`);
                    UI.setGameStatus('选择你的出拳（MOCK模式）');
                    UI.setMyStatus('等待出拳');
                    UI.setOpponentStatus('等待出拳');
                    UI.setMyAddress(data.creator);
                    UI.setOpponentAddress(data.opponent || data.player2);
                    UI.setMyChoice(null);
                    UI.setOpponentChoice(null);
                    UI.setChoiceButtonsEnabled(true);
                    UI.showRevealButton(false);
                    UI.showTimeoutButton(false);

                    const confirmSection = document.getElementById('choiceConfirmSection');
                    if (confirmSection) confirmSection.classList.add('hidden');

                    gamePhase = 'commit';

                    FWUI.Toast.success('已进入 MOCK 出拳阶段（点击石头剪刀布试试）');
                    break;

                case 'game_reveal':
                    // 揭晓阶段
                    resetGameState();
                    currentRoom = data;
                    currentRoomId = data.room_id;
                    currentGameId = data.game_id;
                    currentMode = 'R';
                    selectedChoice = data.my_choice || 1;
                    myCommitSubmitted = true;
                    opponentCommitSubmitted = data.opponent_committed;
                    gamePhase = 'reveal';

                    UI.showStage('stageGame');
                    UI.setGameId(`MOCK-${data.game_id}`);
                    UI.setGameStatus('揭晓阶段（MOCK模式）- 点击"揭晓出拳"按钮');
                    UI.setMyStatus('已提交');
                    UI.setOpponentStatus(data.opponent_committed ? '已提交' : '等待提交');
                    UI.setMyAddress(data.creator);
                    UI.setOpponentAddress(data.opponent || data.player2);
                    UI.setMyChoice(data.my_choice || 1, true);
                    UI.setOpponentChoice(null, false);
                    UI.setChoiceButtonsEnabled(false);
                    UI.showRevealButton(true);
                    UI.showTimeoutButton(false);

                    FWUI.Toast.success('已进入 MOCK 揭晓阶段');
                    break;

                case 'result_win':
                case 'result_lose':
                case 'result_draw':
                    // 结果展示
                    const resultType = mockStage === 'result_win' ? 'win' :
                        mockStage === 'result_lose' ? 'lose' : 'draw';

                    // 使用 stageResult 展示完整的结果界面（含动画）
                    UI.showStage('stageResult');
                    const mockResult = {
                        type: resultType,
                        myChoice: data.my_choice,
                        opponentChoice: data.opponent_choice,
                    };
                    UI.showResult(mockResult);

                    // 填充结果详情
                    const resultAmount = document.getElementById('resultAmount');
                    const resultPrize = document.getElementById('resultPrize');
                    const resultFee = document.getElementById('resultFee');
                    if (resultAmount) resultAmount.textContent = (data.bet_amount || 100) + ' ' + (data.token || 'USDC');
                    if (resultType === 'win') {
                        if (resultPrize) resultPrize.textContent = '+' + (data.prize || '98') + ' ' + (data.token || 'USDC');
                        if (resultFee) resultFee.textContent = '-' + (data.fee || '2') + ' ' + (data.token || 'USDC');
                    } else if (resultType === 'lose') {
                        if (resultPrize) resultPrize.textContent = '-' + (data.bet_amount || 100) + ' ' + (data.token || 'USDC');
                        if (resultFee) resultFee.textContent = '-';
                    } else {
                        if (resultPrize) resultPrize.textContent = '0 ' + (data.token || 'USDC');
                        if (resultFee) resultFee.textContent = '-';
                    }

                    console.log('[MOCK] 结果:', resultType, data);
                    break;

                default:
                    console.log('[MOCK] 未知阶段:', mockStage);
                    FWUI.Toast.warning('未知 MOCK 阶段: ' + mockStage);
                    break;
            }
        } catch (err) {
            console.error('[MOCK] 加载模拟数据出错:', err);
            FWUI.Toast.error('MOCK 加载出错: ' + (err.message || err));
        }
    }

    // 处理URL路由
    function handleRoute() {
        if (isMockMode) return;

        const path = window.location.pathname;

        if (path === '/' || path === '/lobby') {
            enterLobby();
        } else if (path.startsWith('/room/')) {
            // 同时支持 /room/{id} 和 /room/{id}/game
            const rest = path.substring('/room/'.length);
            const slashIdx = rest.indexOf('/');
            const roomId = slashIdx >= 0 ? rest.substring(0, slashIdx) : rest;
            const subPath = slashIdx >= 0 ? rest.substring(slashIdx + 1) : '';

            if (!roomId) {
                enterLobby();
                return;
            }

            if (subPath === 'game') {
                // /room/{id}/game：游戏进行中路由恢复
                handleGameRoute(roomId);
            } else {
                // /room/{id}：房间等待
                currentRoomId = roomId;
                roomGameStartedHandled = false;
                enterRoomWait();
            }
        } else if (path === '/game' || path.startsWith('/game/')) {
            // 兼容旧路由 /game
            if (!currentGameId) {
                enterLobby();
            }
        } else {
            enterLobby();
        }
    }

    // 处理 /room/{id}/game 路由：从后端恢复房间与游戏状态
    // 关键：刷新页面后能根据房间状态自动恢复到正确阶段，避免用户被踢回大厅；
    // 同时传递已有的 chain_game_id，避免重复签名 createMatch/joinMatch
    async function handleGameRoute(roomId) {
        // 已在游戏中且房间匹配：直接显示游戏界面
        if (currentGameId && currentRoomId === roomId) {
            UI.showStage('stageGame');
            return;
        }

        // 需要钱包已连接才能恢复（否则无法判断角色、无法签名）
        if (!Wallet.isConnected()) {
            FWUI.Toast.warning('请先连接钱包以恢复游戏');
            navigateTo('/');
            return;
        }

        try {
            const resp = await fetch(`${CONFIG.backendUrl}/api/game/room/${roomId}`);
            const room = resp.ok ? await resp.json() : null;
            if (!room || !room.room_id) {
                FWUI.Toast.error('房间不存在或已关闭');
                navigateTo('/');
                return;
            }

            // 校验当前钱包是该房间的玩家
            const myAddr = (Wallet.getAddress() || '').toLowerCase();
            const amICreator = room.creator && room.creator.toLowerCase() === myAddr;
            const amIPlayer2 = room.player2 && room.player2.toLowerCase() === myAddr;
            if (!amICreator && !amIPlayer2) {
                FWUI.Toast.warning('你不是该房间的玩家');
                navigateTo('/');
                return;
            }

            currentRoomId = roomId;
            currentRoom = room;

            if (room.status === 'game_started') {
                // 用 room 数据构造 game_started 事件，传递已有 chain_game_id 避免重复签名
                roomGameStartedHandled = false;
                handleRoomGameStarted({
                    room_id: roomId,
                    game_id: room.game_id,
                    is_creator: amICreator,
                    opponent: amICreator ? room.player2 : room.creator,
                    token: room.token,
                    bet_amount: room.bet_amount,
                    commit_deadline: null,
                    chain_game_id: room.chain_game_id, // 关键：已有则跳过 createMatch 签名
                });
            } else if (room.status === 'countdown') {
                // 倒计时中，回到房间等待界面
                enterRoomWait();
            } else {
                // CREATED / JOINED / FINISHED / CLOSED 等：回房间等待
                enterRoomWait();
            }
        } catch (e) {
            FWUI.Toast.error('恢复游戏状态失败: ' + (e.message || e));
            navigateTo('/');
        }
    }

    // 导航到指定路径
    function navigateTo(path) {
        window.history.pushState({}, '', path);
        handleRoute();
    }

    // 自动连接钱包
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

    // 初始化主题
    function initTheme() {
        const savedTheme = localStorage.getItem('rps_theme') || CONFIG.defaultTheme;
        UI.setTheme(savedTheme);
    }

    // 初始化事件监听器
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

            // 与 updateRoomUI 的禁用规则保持一致：仅资金已上链时禁用
            if (currentRoom) {
                const fundStage = currentRoom.fund_stage || 'local_frozen';
                const fundsOnChain = fundStage === 'chain_frozen' || fundStage === 'revealing';
                if (fundsOnChain) {
                    FWUI.Toast.warning('对局进行中（资金已上链），无法退出房间');
                    return;
                }
            }

            try {
                const res = await fetch(`${CONFIG.backendUrl}/api/game/room/leave`, {
                    method: 'POST',
                    headers: {'Content-Type': 'application/json'},
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
                    stopRoomPolling();
                    disconnectP2PChannel();
                    currentRoomId = null;
                    currentRoom = null;
                    UI.showStage('stageLobby');
                    loadRoomList();
                } else {
                    FWUI.Toast.warning(data.message || data.detail || '退出房间失败');
                }
            } catch (e) {
                console.error('退出房间请求失败:', e);
                FWUI.Toast.error('退出房间失败: ' + (e.message || e));
            }
        });

        // 点击房间号徽章或复制按钮，复制房间号
        // 复制房间号处理器
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
            const enterBtn = e.target.closest('.btn-enter-room');
            if (enterBtn) {
                const roomId = enterBtn.dataset.roomId;
                if (roomId) {
                    currentRoomId = roomId;
                    roomGameStartedHandled = false;
                    navigateTo(`/room/${roomId}`);
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

        // 重试创建链上对局（创建者 createMatch 失败/取消后）
        document.getElementById('retryCreateBtn').addEventListener('click', async () => {
            UI.showRetrySection(null);
            UI.setGameStatus('创建链上对局中...');
            try {
                await createChainGameForRoom({
                    room_id: currentRoomId,
                    game_id: currentRoom ? currentRoom.game_id : null,
                    is_creator: true,
                    opponent: currentRoom ? currentRoom.player2 : null,
                    token: currentRoom ? currentRoom.token : null,
                    bet_amount: currentRoom ? currentRoom.bet_amount : null,
                    commit_deadline: null,
                });
            } catch (e) {
                console.error('[Room] 重试创建链上对局失败:', e);
            }
        });

        // 重试加入链上对局（player2 joinMatch 失败/取消后）
        document.getElementById('retryJoinBtn').addEventListener('click', async () => {
            if (!currentGameId) {
                FWUI.Toast.warning('链上对局 ID 丢失，请刷新页面重试');
                return;
            }
            UI.showRetrySection(null);
            try {
                await handleChainGameCreated({
                    room_id: currentRoomId,
                    chain_game_id: currentGameId,
                });
            } catch (e) {
                console.error('[Room] 重试加入链上对局失败:', e);
            }
        });

        // 游戏界面头部的退出房间按钮（✕）
        document.getElementById('exitGameBtn').addEventListener('click', async () => {
            const myAddress = Wallet.getAddress();
            if (!myAddress || !currentRoomId) {
                UI.showStage('stageLobby');
                return;
            }
            // 资金已上链时不允许退出
            if (currentRoom) {
                const fundStage = currentRoom.fund_stage || 'local_frozen';
                const fundsOnChain = fundStage === 'chain_frozen' || fundStage === 'revealing';
                if (fundsOnChain) {
                    FWUI.Toast.warning('对局进行中（资金已上链），无法退出房间');
                    return;
                }
            }
            // 确认退出
            FWUI.Modal.confirm({
                title: '退出房间',
                content: '确定要退出当前房间吗？退出后将返回游戏大厅。',
                okText: '确认退出',
                cancelText: '取消',
                onOk: async () => {
                    try {
                        const res = await fetch(`${CONFIG.backendUrl}/api/game/room/leave`, {
                            method: 'POST',
                            headers: {'Content-Type': 'application/json'},
                            body: JSON.stringify({
                                room_id: currentRoomId,
                                player_address: myAddress,
                            }),
                        });
                        const data = await res.json();
                        if (res.ok && data.success) {
                            FWUI.Toast.info(data.message || '已退出房间');
                            stopRoomPolling();
                            disconnectP2PChannel();
                            stopAllFallbackPolling();
                            stopAutoReveal();
                            currentRoomId = null;
                            currentRoom = null;
                            currentGameId = null;
                            UI.showStage('stageLobby');
                            loadRoomList();
                        } else {
                            FWUI.Toast.warning(data.message || data.detail || '退出房间失败');
                        }
                    } catch (e) {
                        console.error('退出房间请求失败:', e);
                        FWUI.Toast.error('退出房间失败: ' + (e.message || e));
                    }
                },
            });
        });

        // 游戏界面中的退出房间按钮（创建/加入链上对局失败时可用）
        document.getElementById('leaveRoomInGameBtn').addEventListener('click', () => {
            const myAddress = Wallet.getAddress();
            if (!myAddress || !currentRoomId) {
                FWUI.Toast.warning('无法退出：缺少钱包或房间信息');
                return;
            }

            FWUI.Modal.confirm({
                title: '退出房间',
                content: '确定要退出当前房间吗？链上对局尚未创建成功，退出不会影响链上资金。',
                okText: '确认退出',
                cancelText: '取消',
                onOk: async () => {
                    try {
                        const res = await fetch(`${CONFIG.backendUrl}/api/game/room/leave`, {
                            method: 'POST',
                            headers: {'Content-Type': 'application/json'},
                            body: JSON.stringify({
                                room_id: currentRoomId,
                                player_address: myAddress,
                            })
                        });
                        const data = await res.json();
                        if (res.ok && data.success) {
                            FWUI.Toast.info(data.message || '已退出房间');
                            stopRoomPolling();
                            disconnectP2PChannel();
                            UI.showRetrySection(null);
                            currentRoomId = null;
                            currentRoom = null;
                            currentGameId = null;
                            UI.showStage('stageLobby');
                            loadRoomList();
                        } else {
                            FWUI.Toast.warning(data.message || data.detail || '退出房间失败');
                        }
                    } catch (e) {
                        console.error('退出房间请求失败:', e);
                        FWUI.Toast.error('退出房间失败: ' + (e.message || e));
                    }
                }
            });
        });

        document.getElementById('playAgainBtn').addEventListener('click', async () => {
            stopResultCountdown();
            // 房间模式下：重置房间开启下一局（再来一局）
            const myAddress = Wallet.getAddress();
            if (currentRoomId && currentRoom && myAddress) {
                try {
                    const res = await fetch(`${CONFIG.backendUrl}/api/game/room/reset-rematch`, {
                        method: 'POST',
                        headers: {'Content-Type': 'application/json'},
                        body: JSON.stringify({
                            room_id: currentRoomId,
                            player_address: myAddress,
                        }),
                    });
                    const data = await res.json();
                    if (res.ok && data.success) {
                        FWUI.Toast.success(data.message || '已重置房间，可重新准备');
                        resetGameState();
                        // 保留房间上下文，回到房间等待界面
                        gamePhase = 'idle';
                        roomGameStartedHandled = false;
                        currentGameId = null;
                        if (data.room) {
                            currentRoom = data.room;
                        }
                        disconnectP2PChannel();
                        stopAllFallbackPolling();
                        UI.showStage('stageRoomWait');
                        updateRoomUI();
                        startRoomPolling();
                        return;
                    }
                    FWUI.Toast.warning(data.message || data.detail || '再来一局失败');
                } catch (e) {
                    console.error('再来一局请求失败:', e);
                    FWUI.Toast.error('再来一局失败: ' + (e.message || e));
                }
                // 兜底：返回大厅
            }
            UI.showStage('stageLobby');
            resetGameState();
            loadRoomList();
        });

        document.getElementById('backHomeBtn').addEventListener('click', async () => {
            stopResultCountdown();
            // 房间模式下：退出房间后返回大厅
            const myAddress = Wallet.getAddress();
            if (currentRoomId && myAddress) {
                try {
                    await fetch(`${CONFIG.backendUrl}/api/game/room/leave`, {
                        method: 'POST',
                        headers: {'Content-Type': 'application/json'},
                        body: JSON.stringify({
                            room_id: currentRoomId,
                            player_address: myAddress,
                        }),
                    });
                } catch (e) {
                    console.error('离开房间请求失败:', e);
                }
            }
            stopRoomPolling();
            disconnectP2PChannel();
            currentRoomId = null;
            currentRoom = null;
            UI.showStage('stageLobby');
            resetGameState();
            loadRoomList();
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

        initNetworkDropdown();
    }

    let networkDropdownInitialized = false;

    function initNetworkDropdown() {
        if (networkDropdownInitialized) return;
        networkDropdownInitialized = true;

        const avatarContainer = document.querySelector('.wallet-avatar-container');
        const avatar = document.getElementById('walletAvatar');
        const networkDisplay = document.getElementById('walletNetwork');
        const dropdown = document.getElementById('networkDropdown');

        const toggleDropdown = (e) => {
            e.stopPropagation();
            if (!Wallet.isConnected()) {
                FWUI.Toast.warning('请先连接钱包');
                return;
            }
            populateNetworkDropdown();
            dropdown.classList.toggle('hidden');
        };

        if (avatarContainer) avatarContainer.addEventListener('click', toggleDropdown);
        else if (avatar) avatar.addEventListener('click', toggleDropdown);
        if (networkDisplay) networkDisplay.addEventListener('click', toggleDropdown);

        document.addEventListener('click', (e) => {
            if (!dropdown || dropdown.classList.contains('hidden')) return;
            if (dropdown.contains(e.target)) return;
            if (avatarContainer && avatarContainer.contains(e.target)) return;
            if (avatar && avatar.contains(e.target)) return;
            if (networkDisplay && networkDisplay.contains(e.target)) return;
            dropdown.classList.add('hidden');
        });
    }

    function populateNetworkDropdown() {
        const container = document.getElementById('networkDropdownItems');
        if (!container) return;

        const currentChainId = Wallet.getChainId();
        const networks = CONFIG.networks || {};
        const entries = Object.entries(networks);

        const icons = {
            5208888: '🔧',
            137: '🟣',
            80002: '🟣',
            8453: '🔵',
        };

        container.innerHTML = '';
        entries.forEach(([key, net]) => {
            const chainId = net.chainId;
            const isActive = chainId === currentChainId;
            const icon = icons[chainId] || '🔗';
            const item = document.createElement('div');
            item.className = 'dropdown-item' + (isActive ? ' active' : '');
            item.dataset.chainId = chainId;
            item.innerHTML = `
                <span class="network-icon">${icon}</span>
                <span class="network-name">${net.name}</span>
                <span class="network-chain-id">${chainId}</span>
            `;
            item.addEventListener('click', async () => {
                await switchToNetwork(key, chainId);
            });
            container.appendChild(item);
        });
    }

    async function switchToNetwork(networkKey, chainId) {
        const networks = CONFIG.networks || {};
        const net = networks[networkKey];
        if (!net) return;

        const dropdown = document.getElementById('networkDropdown');
        if (dropdown) dropdown.classList.add('hidden');

        const isLocalHttp = net.rpcUrl && net.rpcUrl.startsWith('http://') && (
            net.rpcUrl.includes('127.0.0.1') ||
            net.rpcUrl.includes('localhost') ||
            net.rpcUrl.includes('0.0.0.0')
        );

        if (isLocalHttp) {
            FWUI.Modal.confirm({
                title: '切换到本地测试链',
                content: `
                    <div style="line-height:1.8;">
                        <p>正在切换到 <b>${net.name}</b>（HTTP RPC 本地测试链）。</p>
                        <p>钱包出于安全考虑不允许通过 <code>wallet_addEthereumChain</code> 添加 HTTP 网络。</p>
                        <p>请手动在钱包中添加以下网络配置：</p>
                        <div style="background:#f5f5f5;padding:12px;border-radius:6px;font-family:monospace;font-size:13px;margin:12px 0;">
                            <div><b>Network Name:</b> ${net.name}</div>
                            <div><b>New RPC URL:</b> ${net.rpcUrl}</div>
                            <div><b>Chain ID:</b> ${chainId}</div>
                            <div><b>Currency Symbol:</b> ${net.nativeCurrency.symbol}</div>
                            <div><b>Decimals:</b> ${net.nativeCurrency.decimals}</div>
                        </div>
                        <p style="color:#888;font-size:12px;">操作路径：钱包 -> 网络 -> 添加自定义网络 -> 填入以上信息</p>
                    </div>
                `,
                okText: '我知道了',
                cancelText: '关闭',
                onOk: () => {
                    FWUI.Toast.success('请在钱包中添加网络后刷新页面');
                }
            });
            return;
        }

        try {
            FWUI.Toast.info(`正在切换到 ${net.name}...`);
            const switched = await Wallet.switchOrAddChain({
                chainId: chainId,
                chainName: net.name,
                rpcUrls: [net.rpcUrl],
                nativeCurrency: net.nativeCurrency,
            });

            if (switched) {
                FWUI.Toast.success(`已切换到 ${net.name}`);
            } else {
                FWUI.Toast.warning(`请在钱包中手动添加 ${net.name} 网络后重试`);
            }
        } catch (e) {
            FWUI.Toast.error(`切换网络失败: ${e.message}`);
        }
    }

    // 验证合约地址
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

    let isHandlingWalletConnection = false;
    let isManualConnect = false;

    // 初始化钱包事件监听器
    function initWalletListeners() {
        Wallet.on('accountChanged', (address) => {
            if (address) {
                const manual = isManualConnect;
                isManualConnect = false;
                handleWalletConnected(address, !manual).catch(e => console.error('handleWalletConnected error:', e));
            } else {
                handleWalletDisconnected();
            }
        });

        Wallet.on('chainChanged', async (chainId) => {
            const networkName = getNetworkNameByChainId(chainId);
            UI.updateNetworkInfo(chainId, networkName);

            isSwitchingChain = false;

            currentToken = CONFIG.getDefaultToken();
            UI.showTokenSelect(currentToken);

            if (isHandlingWalletConnection) {
                chainChangedDuringInit = true;
                return;
            }

            if (Wallet.getAddress()) {
                // 使用更长的延迟等待网络完全切换，并添加重试机制
                const initWithRetry = async (retries = 3) => {
                    for (let i = 0; i < retries; i++) {
                        try {
                            await new Promise(resolve => setTimeout(resolve, 500 + i * 300));
                            initContract();
                            updateBalanceDisplay();
                            return;
                        } catch (e) {
                            console.warn(`chainChanged 后初始化失败 (${i + 1}/${retries}):`, e.message);
                            if (i >= retries - 1) {
                                console.error('chainChanged 后初始化最终失败:', e);
                                FWUI.Toast.warning('网络切换完成，但初始化失败，请刷新页面');
                            }
                        }
                    }
                };
                initWithRetry();
            }
        });

        Wallet.on('disconnect', () => {
            handleWalletDisconnected();
        });
    }

    // 初始化合约事件监听器
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
                    // 双方都已提交 → 进入揭晓阶段
                    const revealingText = UI.FUND_STAGE_TEXT ? UI.FUND_STAGE_TEXT['revealing'] : '🔓 揭晓中，等待结算';
                    UI.setGameStatus('揭晓阶段 · 即将自动揭晓 · ' + revealingText);
                    UI.setChoiceButtonsEnabled(false);

                    if (selectedChoice && !myRevealed) {
                        UI.showRevealButton(true);
                    }

                    startGameTimer('reveal');
                    startAutoReveal(5);
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

    // 连接钱包
    async function connectWallet() {
        try {
            const wallets = Wallet.getAvailableWallets();
            if (wallets.length === 0) {
                FWUI.Toast.error('未检测到 Web3 钱包，请先安装 MetaMask');
                return;
            }

            isManualConnect = true;
            await Wallet.connect();
        } catch (e) {
            isManualConnect = false;
            FWUI.Toast.error(e.message || '连接失败');
        }
    }

    let isSwitchingChain = false;
    let lastChainSwitchTime = 0;
    const CHAIN_SWITCH_COOLDOWN = 5000;
    let chainChangedDuringInit = false;

    // 处理钱包连接成功
    async function handleWalletConnected(address, silentMode = true) {
        if (isHandlingWalletConnection) {
            return;
        }
        isHandlingWalletConnection = true;
        chainChangedDuringInit = false;
        try {
            UI.updateWalletInfo(address, '0', currentToken);
            UI.setMyAddress(address);

            let chainId = Wallet.getChainId();
            let networkName = getNetworkNameByChainId(chainId);
            UI.updateNetworkInfo(chainId, networkName);

            currentToken = CONFIG.getDefaultToken();
            UI.showTokenSelect(currentToken);

            let needsChainSwitch = false;
            try {
                const mainChainConfig = await fetchMainChainConfig();
                if (mainChainConfig && mainChainConfig.chain_id) {
                    const mainChainId = mainChainConfig.chain_id;
                    const now = Date.now();
                    if (chainId !== mainChainId && now - lastChainSwitchTime > CHAIN_SWITCH_COOLDOWN) {
                        lastChainSwitchTime = now;
                        needsChainSwitch = true;
                        if (!silentMode) {
                            FWUI.Toast.info(`正在切换到 ChainRPS 主链: ${mainChainConfig.network_name}...`);
                        }
                        try {
                            isSwitchingChain = true;
                            const switched = await Wallet.switchOrAddChain({
                                chainId: mainChainId,
                                chainName: mainChainConfig.network_name,
                                rpcUrls: [mainChainConfig.rpc_url],
                                nativeCurrency: mainChainConfig.native_currency,
                                blockExplorerUrls: mainChainConfig.block_explorer ? [mainChainConfig.block_explorer] : undefined,
                            });
                            if (switched === false) {
                                if (!silentMode) {
                                    FWUI.Toast.warning(`请先在钱包中手动添加 ${mainChainConfig.network_name} 网络（配置已弹出显示），添加后刷新页面`);
                                }
                                isSwitchingChain = false;
                            } else if (switched && !silentMode) {
                                FWUI.Toast.success(`已切换到 ChainRPS 主链: ${mainChainConfig.network_name}`);
                            }
                        } catch (switchError) {
                            console.error('切换主链失败:', switchError);
                            isSwitchingChain = false;
                            if (!silentMode) {
                                const errMsg = switchError.message || switchError.toString();
                                if (errMsg.indexOf('User rejected') !== -1 || errMsg.indexOf('用户拒绝') !== -1) {
                                    FWUI.Toast.warning(`您已拒绝切换网络，请手动切换到 ${mainChainConfig.network_name}`);
                                } else {
                                    FWUI.Toast.error(`切换网络失败，请手动切换到 ${mainChainConfig.network_name}`);
                                }
                            }
                        }
                    }

                    if (mainChainConfig.contract_address) {
                        CONFIG.setContractAddress(mainChainConfig.contract_address);
                    }
                }
            } catch (e) {
                console.warn('获取主链配置失败，使用本地配置:', e);
            }

            if (needsChainSwitch && isSwitchingChain) {
                // 网络正在切换中，后续操作（initContract、updateBalance 等）交给 chainChanged 事件处理
                return;
            }

            initContract();

            updateBalanceDisplay();

            History.syncFromChain(address).then(() => {
                updateHistoryAndStats();
            });

            Settings.loadFromServer(address).then(() => {
                Settings.renderSettingsForm();
                const prefs = Settings.getPreferences();
                // 主题统一以 localStorage.rps_theme 为准（顶部按钮和设置面板共用同一来源）
                // 服务端返回的 prefs.theme 只用于回填设置面板的显示值，不强制覆盖当前主题
                const localTheme = localStorage.getItem('rps_theme');
                if (localTheme) {
                    Settings.setPreference('theme', localTheme);
                } else if (prefs && prefs.theme) {
                    Settings.applyTheme(prefs.theme);
                }
            });

            checkAndRestorePlayerRoom(address);
        } finally {
            isHandlingWalletConnection = false;
        }
    }

    let cachedMainChainConfig = null;

    // 获取主链配置
    async function fetchMainChainConfig(forceRefresh = false) {
        if (cachedMainChainConfig && !forceRefresh) {
            return cachedMainChainConfig;
        }
        try {
            const response = await fetch(`${CONFIG.backendUrl}/api/ext/chain-config`);
            if (response.ok) {
                const data = await response.json();
                if (data.success) {
                    cachedMainChainConfig = data;
                    return data;
                }
            }
        } catch (e) {
            console.warn('获取主链配置失败:', e);
        }
        return null;
    }

    // 检查并恢复玩家未完成房间
    async function checkAndRestorePlayerRoom(playerAddress) {
        if (!playerAddress || !CONFIG.backendUrl) return;

        try {
            const response = await fetch(`${CONFIG.backendUrl}/api/game/room/player/${playerAddress}`);
            const data = await response.json();

            if (data.success && data.room) {
                const room = data.room;
                currentRoomId = room.room_id;
                currentRoom = room;
                navigateTo(`/room/${currentRoomId}`);
                FWUI.Toast.info('检测到未完成的房间，已自动进入');
            }
        } catch (e) {
            console.log('检查玩家房间失败:', e.message);
        }
    }

    // 处理钱包断开连接
    function handleWalletDisconnected() {
        UI.updateWalletInfo(null);
        UI.setMyAddress('');
        currentGameId = null;
        resetGameState();
        UI.showStage('stageLobby');
    }

    // 断开钱包连接
    async function disconnectWallet() {
        FWUI.Toast.info('正在断开钱包...');
        await Wallet.disconnect();
        handleWalletDisconnected();
        FWUI.Toast.success('钱包已断开，刷新页面不会自动重连');
    }

    // 初始化合约实例
    function initContract() {
        const provider = Wallet.getProvider();
        const signer = Wallet.getSigner();
        const contractAddress = CONFIG.getContractAddress();

        Contract.removeEventListeners();

        if (provider && contractAddress) {
            const c = Contract.init(contractAddress, provider, signer);
            if (c) {
                try {
                    Contract.setupEventListener();
                } catch (e) {
                    console.warn('设置合约事件监听器失败:', e.message);
                }
            }
        }
    }

    // 更新钱包余额显示
    async function updateBalanceDisplay() {
        if (!Wallet.isConnected()) return;

        try {
            const tokenAddress = CONFIG.getTokenAddresses()[currentToken];
            const balance = await Wallet.getBalance(tokenAddress);
            UI.updateWalletInfo(Wallet.getAddress(), balance, currentToken);
        } catch (e) {
            console.warn('获取余额失败:', e.message);
        }
    }

    // 开始游戏
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
            navigateTo('/lobby');
        }
    }

    // 进入交易大厅
    async function enterLobby() {
        if (isMockMode) return;
        UI.showStage('stageLobby');
        UI.setRoomListView(UI.getPreferredRoomListView());
        loadRoomList();
        connectLobbySocket();
        startLobbyRefresh();
    }

    let isMockMode = false;
    let lobbyRefreshInterval = null;
    let lobbySlowRefreshInterval = null; // WS 已连接时的低频兜底刷新
    let lobbyWsConnected = false;
    let roomWsConnected = false;
    let gameWsConnected = false;
    let roomListLoading = false;
    let roomListTimeout = null;

    // P2P 通道状态（房间内私密通信，WS 降级兜底）
    let p2pConnected = false;
    let p2pListenersBound = false;

    // 开始大厅定时刷新（双通道兜底）
    // - 高频（5s）：WS 未连接时每 5s 强制拉一次（降级模式）
    // - 低频（10s）：即使 WS 已连接，每 10s 也拉一次作为兜底（防止事件漏发导致大厅不更新）
    function startLobbyRefresh() {
        stopLobbyRefresh();
        // 高频降级轮询
        lobbyRefreshInterval = setInterval(() => {
            const lobby = document.getElementById('stageLobby');
            if (!lobby || lobby.classList.contains('hidden')) {
                stopLobbyRefresh();
                return;
            }
            // WS 未连接时高频轮询
            if (!lobbyWsConnected) {
                loadRoomList();
            }
        }, 5000);
        // 低频兜底轮询（WS 已连接时也每 10s 拉一次）
        lobbySlowRefreshInterval = setInterval(() => {
            const lobby = document.getElementById('stageLobby');
            if (!lobby || lobby.classList.contains('hidden')) {
                stopLobbyRefresh();
                return;
            }
            loadRoomList();
        }, 10000);
    }

    // 停止大厅定时刷新
    function stopLobbyRefresh() {
        if (lobbyRefreshInterval) {
            clearInterval(lobbyRefreshInterval);
            lobbyRefreshInterval = null;
        }
        if (lobbySlowRefreshInterval) {
            clearInterval(lobbySlowRefreshInterval);
            lobbySlowRefreshInterval = null;
        }
    }

    /**
     * 连接交易大厅 WebSocket，监听房间列表变更事件
     * 收到 room_list_changed 事件后立即拉取最新房间列表
     * 未连接钱包时使用匿名地址连接，确保大厅实时更新
     */
    function connectLobbySocket() {
        if (!CONFIG.wsUrl) return;

        // 未连接钱包时生成随机匿名地址，避免多用户连接冲突
        let address = Wallet.getAddress();
        if (!address) {
            // 生成随机匿名地址（仅用于 WS 连接标识，不涉及链上操作）
            const randomHex = Math.floor(Math.random() * 1e16).toString(16).padStart(14, '0');
            address = '0xanon' + randomHex;
        }

        if (!GameSocket.isConnected()) {
            // 监听 WS 关闭事件，重置连接状态以便恢复轮询
            GameSocket.on('close', () => {
                if (lobbyWsConnected) {
                    console.log('[Lobby] WebSocket 断开，恢复轮询模式');
                    lobbyWsConnected = false;
                }
            });

            // 连接 WebSocket，等待连接成功后再注册事件并刷新列表
            GameSocket.once('open', () => {
                registerLobbyListeners();
                // WebSocket 连接成功后立即刷新一次，确保获取最新状态
                const lobby = document.getElementById('stageLobby');
                if (lobby && !lobby.classList.contains('hidden')) {
                    loadRoomList();
                }
            });
            GameSocket.connect(CONFIG.wsUrl, address);
        } else {
            // 已连接，直接注册事件
            registerLobbyListeners();
        }
    }

    // 注册大厅事件监听器
    function registerLobbyListeners() {
        if (!lobbyWsConnected) {
            lobbyWsConnected = true;

            // 房间列表变更：实时刷新
            GameSocket.on('room_list_changed', (data) => {
                console.log('[Lobby] 收到房间列表变更:', data);
                // 只在大厅可见时刷新，避免无意义请求
                const lobby = document.getElementById('stageLobby');
                if (!lobby || lobby.classList.contains('hidden')) return;
                loadRoomList();
            });
        }
    }

    // 加载房间列表
    function loadRoomList() {
        if (!CONFIG.backendUrl) return;

        if (roomListLoading) {
            if (roomListTimeout) clearTimeout(roomListTimeout);
            roomListTimeout = setTimeout(loadRoomList, 100);
            return;
        }

        roomListLoading = true;

        fetch(`${CONFIG.backendUrl}/api/game/room/list`)
            .then(response => response.json())
            .then(data => {
                UI.renderRoomList(data.rooms || []);
            })
            .catch(e => {
                console.error('加载房间列表失败:', e);
                UI.renderRoomList([]);
            })
            .finally(() => {
                roomListLoading = false;
            });
    }

    // 显示创建房间对话框
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
                resolve({token: selectedToken, amount: selectedAmount});
            });
            modal.element.querySelector('[data-action="cancel"]').addEventListener('click', () => {
                modal.close();
                resolve(null);
            });
        });
    }

    // 创建房间
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
                headers: {'Content-Type': 'application/json'},
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
                navigateTo(`/room/${currentRoomId}`);
            } else {
                const errorMsg = data.message || data.detail || '创建房间失败';
                if (data.existing_room_id) {
                    FWUI.Modal.confirm({
                        title: '已在其他房间',
                        content: `你当前已在房间 #${data.existing_room_id} 中，同一时间只能加入一个房间。是否跳转到该房间？`,
                        onOk: () => {
                            loadRoomAndEnter(data.existing_room_id);
                        },
                        okText: '前往房间',
                        cancelText: '取消',
                    });
                } else {
                    FWUI.Toast.error(errorMsg);
                }
            }
        } catch (e) {
            FWUI.Toast.error(e.message || '创建房间失败');
        }
    }

    // 显示加入房间对话框
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
        // 创建下拉框
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

        // 定位下拉框
        function positionDropdown() {
            if (!dropdownEl || !input) return;
            const rect = input.getBoundingClientRect();
            dropdownEl.style.left = rect.left + 'px';
            dropdownEl.style.top = (rect.bottom + 6) + 'px';
            dropdownEl.style.width = rect.width + 'px';
        }

        // 显示下拉框
        function showDropdown() {
            createDropdown();
            positionDropdown();
            dropdownEl.style.display = 'block';
            renderDropdownItems(input.value);
        }

        // 隐藏下拉框
        function hideDropdown() {
            if (dropdownEl) {
                dropdownEl.style.display = 'none';
            }
        }

        // 渲染下拉框房间项
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

        // 加载房间列表用于下拉框
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

        // 处理下拉框外部点击
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
        // 重写modal关闭方法进行清理
        modal.close = function () {
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
                    headers: {'Content-Type': 'application/json'},
                    body: JSON.stringify({
                        room_id: roomId,
                        player_address: myAddress
                    })
                });

                const data = await response.json();

                if (data.success && data.room_id) {
                    currentRoomId = roomId;
                    currentRoom = data.room;
                    modal.close();
                    navigateTo(`/room/${currentRoomId}`);
                } else {
                    if (data.existing_room_id) {
                        modal.close();
                        FWUI.Modal.confirm({
                            title: '已在其他房间',
                            content: `你当前已在房间 #${data.existing_room_id} 中，同一时间只能加入一个房间。是否跳转到该房间？`,
                            onOk: () => {
                                loadRoomAndEnter(data.existing_room_id);
                            },
                            okText: '前往房间',
                            cancelText: '取消',
                        });
                        return;
                    }
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
    }

    // 加入房间
    async function joinRoom(roomId) {
        if (!Wallet.isConnected()) {
            FWUI.Toast.warning('请先连接钱包');
            return;
        }

        try {
            const response = await fetch(`${CONFIG.backendUrl}/api/game/room/join`, {
                method: 'POST',
                headers: {'Content-Type': 'application/json'},
                body: JSON.stringify({
                    room_id: roomId,
                    player_address: Wallet.getAddress()
                })
            });

            const data = await response.json();
            if (data.success && data.room_id) {
                currentRoomId = roomId;
                currentRoom = data.room;
                navigateTo(`/room/${currentRoomId}`);
            } else {
                const errorMsg = data.message || data.detail || '加入房间失败';
                if (data.existing_room_id) {
                    FWUI.Modal.confirm({
                        title: '已在其他房间',
                        content: `你当前已在房间 #${data.existing_room_id} 中，同一时间只能加入一个房间。是否跳转到该房间？`,
                        onOk: () => {
                            loadRoomAndEnter(data.existing_room_id);
                        },
                        okText: '前往房间',
                        cancelText: '取消',
                    });
                } else {
                    FWUI.Toast.error(errorMsg);
                }
                loadRoomList();
            }
        } catch (e) {
            FWUI.Toast.error(e.message || '加入房间失败');
        }
    }

    // 加载房间并进入
    async function loadRoomAndEnter(roomId) {
        if (!roomId) return;
        try {
            const response = await fetch(`${CONFIG.backendUrl}/api/game/room/${roomId}`);
            const data = await response.json();
            if (data.room_id) {
                currentRoomId = roomId;
                currentRoom = data;
                navigateTo(`/room/${currentRoomId}`);
            } else {
                FWUI.Toast.error(data.message || '房间不存在');
            }
        } catch (e) {
            FWUI.Toast.error(e.message || '获取房间信息失败');
        }
    }

    // 切换准备状态
    async function toggleReady() {
        if (!currentRoomId) return;

        try {
            const response = await fetch(`${CONFIG.backendUrl}/api/game/room/ready`, {
                method: 'POST',
                headers: {'Content-Type': 'application/json'},
                body: JSON.stringify({
                    room_id: currentRoomId,
                    player_address: Wallet.getAddress()
                })
            });

            const data = await response.json();
            if (response.ok && data.room_id) {
                currentRoom = data;
                updateRoomUI();
                // 通过 P2P 即时通知对端（P2P 未就绪时由后端 WS 推送兜底）
                const amICreator = data.creator && data.creator.toLowerCase() === Wallet.getAddress().toLowerCase();
                const myReady = amICreator ? data.creator_ready : data.player2_ready;
                sendPeerNotify('room_ready_change', {
                    room_id: currentRoomId,
                    player: Wallet.getAddress(),
                    ready: myReady,
                });
            } else {
                FWUI.Toast.error(data.detail || data.message || '操作失败');
            }
        } catch (e) {
            FWUI.Toast.error(e.message || '操作失败');
        }
    }

    // 进入房间等待界面
    async function enterRoomWait() {
        UI.showStage('stageRoomWait');
        // 初始加载一次房间状态
        await loadRoomStatus();
        updateRoomUI();
        connectRoomSocket();
        connectP2PChannel();
        startRoomPolling();
    }

    // 连接房间WebSocket并注册事件
    function connectRoomSocket() {
        if (!CONFIG.wsUrl || !Wallet.getAddress()) return;
        if (!GameSocket.isConnected()) {
            // 监听 WS 关闭事件，重置连接状态以便恢复轮询
            GameSocket.on('close', () => {
                if (roomWsConnected) {
                    console.log('[Room] WebSocket 断开，恢复轮询模式');
                    roomWsConnected = false;
                }
            });
            // 连接 WebSocket，等待连接成功后再注册事件并刷新状态
            GameSocket.once('open', () => {
                registerRoomListeners();
                // 订阅当前房间（后端可批量通知房间内双方）
                if (currentRoomId) {
                    GameSocket.subscribeRoom(currentRoomId);
                    loadRoomStatus();
                }
            });
            GameSocket.connect(CONFIG.wsUrl, Wallet.getAddress());
        } else {
            // 已连接，直接注册事件
            registerRoomListeners();
            // 已连接时也确保订阅当前房间
            if (currentRoomId) {
                GameSocket.subscribeRoom(currentRoomId);
            }
        }
    }

    // ============ P2P 通道管理（房间内私密通信，WS 降级兜底） ============
    // 连接 P2P 通道：进入房间时调用，通过 WebRTC 数据通道与对端直连
    function connectP2PChannel() {
        if (!CONFIG.wsUrl || !Wallet.getAddress() || !currentRoomId) return;
        try {
            // 注册 P2P 消息监听（仅注册一次）
            if (!p2pListenersBound) {
                p2pListenersBound = true;
                // P2P 数据通道就绪
                P2PChannel.on('open', () => {
                    p2pConnected = true;
                    console.log('[P2P] 数据通道就绪，房间内消息优先走 P2P');
                });
                // P2P 断开：降级到 WS
                P2PChannel.on('close', () => {
                    if (p2pConnected) {
                        p2pConnected = false;
                        console.log('[P2P] 数据通道断开，降级到 WS 通信');
                    }
                });
                // P2P 重连失败：永久降级到 WS
                P2PChannel.on('reconnect_failed', () => {
                    p2pConnected = false;
                    console.warn('[P2P] 重连失败，持续使用 WS 通道');
                });
                // 对端离开
                P2PChannel.on('peer_left', () => {
                    console.log('[P2P] 对端离开');
                });
                // P2P 收到消息：注入到 GameSocket 事件流，复用所有 WS 事件监听器
                P2PChannel.on('message', (data) => {
                    if (data && data.type) {
                        GameSocket.inject(data.type, data.data || {});
                    }
                });
            }
            // 连接 P2P 通道
            P2PChannel.connect(CONFIG.wsUrl, Wallet.getAddress(), currentRoomId);
            console.log(`[P2P] 连接房间 ${currentRoomId} 的 P2P 通道`);
        } catch (e) {
            console.warn('[P2P] 连接失败，使用 WS 降级:', e.message);
        }
    }

    // 断开 P2P 通道：退出房间/房间关闭时调用
    function disconnectP2PChannel() {
        if (p2pConnected || P2PChannel.isSignalingReady()) {
            P2PChannel.disconnect();
            p2pConnected = false;
        }
    }

    // 通过 P2P 通知对端（P2P 未就绪时静默降级到 WS，由后端推送）
    function sendPeerNotify(type, data) {
        if (!type) return false;
        const payload = { type, data: data || {}, timestamp: Date.now() };
        if (p2pConnected) {
            return P2PChannel.send(payload);
        }
        return false;
    }

    // 注册房间事件监听器
    function registerRoomListeners() {
        if (roomWsConnected) return;
        roomWsConnected = true;
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
        // 倒计时开始事件（包含精确结束时间戳，用于双方同步）
        GameSocket.on('countdown_start', (data) => {
            if (currentRoomId === data.room_id) {
                hasWsCountdown = true;
                startSyncedCountdown(data.end_time, data.server_time, data.total);
            }
        });
        GameSocket.on('countdown_tick', (data) => {
            if (currentRoomId === data.room_id) {
                hasWsCountdown = true;
                // 如果有 end_time，用 end_time 重新同步（校准）
                if (data.end_time) {
                    startSyncedCountdown(data.end_time, data.server_time, data.total);
                } else {
                    currentCountdown = data.remaining;
                    updateCountdownUI(data.remaining, data.is_danger);
                }
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
                disconnectP2PChannel();
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
        // 结算后重置房间（再来一局，对方申请时被动收到）
        GameSocket.on('room_reset_for_rematch', (data) => {
            if (currentRoomId === data.room_id) {
                FWUI.Toast.info(data.message || '房间已重置，可重新准备下一局');
                resetGameState();
                gamePhase = 'idle';
                roomGameStartedHandled = false;
                currentGameId = null;
                stopAutoReveal();
                disconnectP2PChannel();
                stopAllFallbackPolling();
                if (data.room) {
                    currentRoom = data.room;
                }
                // 如果当前在 stageResult 或 stageGame，都跳回房间等待界面
                UI.showStage('stageRoomWait');
                updateRoomUI();
                startRoomPolling();
            }
        });
        // 被踢出房间（未准备超时）
        GameSocket.on('kicked_for_unready', (data) => {
            if (currentRoomId === data.room_id) {
                FWUI.Toast.warning(data.message || '因未准备已被移出房间');
                stopRoomPolling();
                disconnectP2PChannel();
                currentRoomId = null;
                currentRoom = null;
                UI.showStage('stageLobby');
                loadRoomList();
            }
        });
        // 房间被关闭（超时、异常等）
        GameSocket.on('room_closed', (data) => {
            if (currentRoomId === data.room_id) {
                FWUI.Toast.warning(data.message || '房间已关闭');
                stopRoomPolling();
                disconnectP2PChannel();
                stopAllCountdowns();
                hasWsCountdown = false;
                currentRoomId = null;
                currentRoom = null;
                currentGameId = null;
                UI.showStage('stageLobby');
                loadRoomList();
            }
        });

        // ============ 倒计时取消事件（双方准备阶段任一方取消准备） ============
        GameSocket.on('countdown_cancelled', (data) => {
            if (currentRoomId === data.room_id) {
                hasWsCountdown = false;
                stopAllCountdowns();
                FWUI.Toast.warning(data.message || '倒计时已取消');
                // 重新加载房间状态（会自动切回 stageRoomWait 并更新准备按钮）
                loadRoomStatus();
            }
        });

        // ============ 链上对局阶段事件 ============
        // 创建者上报 chain_game_id 成功（创建者本人收到）
        GameSocket.on('chain_game_reported', (data) => {
            if (currentRoomId === data.room_id && !currentGameId) {
                currentGameId = Number(data.chain_game_id);
                UI.setGameId(currentGameId);
                UI.setGameStatus('等待对手加入');
                UI.setMyStatus('等待出拳');
                UI.setOpponentStatus('加入中...');
                FWUI.Toast.info(data.message || '链上对局已创建，等待对手加入');
                // 启动兜底轮询：若 chain_game_player_joined 事件丢失，仍能感知对手加入
                pollChainGameUntilJoined();
            }
        });

        // player2 已加入链上对局（创建者收到，立即进入出拳阶段）
        GameSocket.on('chain_game_player_joined', (data) => {
            // 仅创建者关心此事件
            if (currentGameId && Number(data.chain_game_id) === currentGameId) {
                UI.setOpponentStatus('等待出拳');
                const chainFrozenText = UI.FUND_STAGE_TEXT ? UI.FUND_STAGE_TEXT['chain_frozen'] : '⛓️ 资金已链上锁定';
                const gsEl = document.getElementById('gameStatus');
                const curStatus = gsEl ? gsEl.textContent : '';
                if (!curStatus.includes('资金已链上锁定') && !curStatus.includes('链上冻结')) {
                    UI.setGameStatus((curStatus || '提交阶段') + ' · ' + chainFrozenText);
                }
                FWUI.Toast.success(data.message || '对手已加入链上对局，开始出拳！');
                enterGamePhase();
            }
        });

        // 对手已提交哈希（双方收到，提示等待揭晓）
        GameSocket.on('opponent_commit', (data) => {
            if (currentGameId && Number(data.game_id) === currentGameId) {
                opponentCommitSubmitted = true;
                UI.setOpponentStatus('已提交');
                if (myCommitSubmitted) {
                    // 双方都已提交，等待揭晓
                    FWUI.Toast.info('双方都已提交，准备揭晓');
                } else {
                    FWUI.Toast.info('对手已提交出拳，请尽快提交');
                }
            }
        });

        // 进入揭晓阶段（双方都已提交）
        GameSocket.on('reveal_start', (data) => {
            if (currentGameId && Number(data.game_id) === currentGameId) {
                gamePhase = 'reveal';
                UI.setGameStatus('揭晓阶段 · 即将自动揭晓');
                UI.setMyStatus('待揭晓');
                if (myCommitSubmitted) {
                    UI.showRevealButton(true);
                }
                startGameTimer('reveal');
                // 5秒倒计时自动揭示
                startAutoReveal(5);
                FWUI.Toast.info(data.message || '进入揭晓阶段，5秒后自动揭晓');
            }
        });

        // 对手已揭晓出拳（双方收到，包含对方出拳内容）
        GameSocket.on('opponent_reveal', (data) => {
            if (currentGameId && Number(data.game_id) === currentGameId) {
                opponentRevealed = true;
                const opponentChoice = data.choice;
                UI.setOpponentChoice(opponentChoice);
                UI.setOpponentStatus('已揭晓');
                if (myRevealed) {
                    // 双方都已揭晓，等待链上结算
                    UI.setGameStatus('双方已揭晓，等待链上结算');
                    FWUI.Toast.info('双方都已揭晓，等待链上结算');
                } else {
                    FWUI.Toast.info('对手已揭晓，请尽快揭晓');
                }
            }
        });

        // 双方都已揭晓完成（等待链上结算）
        GameSocket.on('reveal_complete', (data) => {
            if (currentGameId && Number(data.game_id) === currentGameId) {
                UI.setOpponentChoice(data.choice2 || data.choice1);
                UI.setGameStatus('双方已揭晓，等待链上结算');
                FWUI.Toast.info(data.message || '双方都已揭晓，等待链上结算');
            }
        });

        // 对局被取消（Owner 取消或异常）
        GameSocket.on('match_cancelled', (data) => {
            if (currentGameId && Number(data.game_id) === currentGameId) {
                FWUI.Toast.warning(data.message || '对局已被取消');
                stopGameTimer();
                stopAllFallbackPolling();
                disconnectP2PChannel();
                UI.setGameStatus('对局已取消');
                // 返回大厅
                setTimeout(() => {
                    currentGameId = null;
                    currentRoomId = null;
                    currentRoom = null;
                    UI.showStage('stageLobby');
                    loadRoomList();
                }, 1500);
            }
        });

        // 对局结果（双方收到，链上结算完成）
        GameSocket.on('game_result', (data) => {
            if (currentGameId && Number(data.game_id) === currentGameId) {
                stopGameTimer();
                stopGamePhaseFallbackPolling();
                const myAddress = Wallet.getAddress();
                let resultText = '平局';
                if (data.is_draw) {
                    resultText = '平局';
                } else if (data.winner && data.winner.toLowerCase() === myAddress.toLowerCase()) {
                    resultText = '胜利';
                } else {
                    resultText = '失败';
                }
                UI.setGameStatus(`对局已结算 · ${resultText}`);
                FWUI.Toast.success(`对局结束：${resultText}`);
            }
        });

        // ============ WS 重连失败事件 ============
        GameSocket.on('reconnect_failed', () => {
            FWUI.Toast.error('实时连接已断开且重连失败，将使用轮询模式');
        });
    }

    // 加载房间状态
    function loadRoomStatus() {
        if (!currentRoomId) return;

        if (roomStatusLoading) {
            if (roomStatusTimeout) clearTimeout(roomStatusTimeout);
            roomStatusTimeout = setTimeout(loadRoomStatus, 100);
            return;
        }

        roomStatusLoading = true;

        fetch(`${CONFIG.backendUrl}/api/game/room/${currentRoomId}`)
            .then(response => {
                const ok = response.ok;
                return response.json().then(data => ({ok, data}));
            })
            .then(({ok, data}) => {
                if (ok && data.room_id) {
                    currentRoom = data;
                    updateRoomUI();
                    updateExitGameBtnState();
                } else {
                    // 房间不存在或已关闭 → 回到大厅
                    const msg = (data && data.message) || '房间已解散';
                    console.warn('[Room] 房间不可用:', msg);
                    stopRoomPolling();
                    disconnectP2PChannel();
                    FWUI.Toast.warning(msg);
                    currentRoomId = null;
                    currentRoom = null;
                    currentGameId = null;
                    UI.showStage('stageLobby');
                    navigateTo('/');
                    loadRoomList();
                }
            })
            .catch(e => {
                console.error('加载房间状态失败:', e);
            })
            .finally(() => {
                roomStatusLoading = false;
            });
    }

    // 更新倒计时UI
    function updateCountdownUI(remaining, isDanger) {
        UI.updateCountdown(remaining, isDanger);
    }

    let countdownInterval = null;
    let currentCountdown = 15;
    let hasWsCountdown = false;
    let countdownEndTime = null;
    let countdownRafId = null;

    // 更新房间界面
    function updateRoomUI() {
        if (!currentRoom) return;

        const myAddress = Wallet.getAddress();
        const amICreator = currentRoom.creator.toLowerCase() === myAddress.toLowerCase();

        UI.setRoomInfo(currentRoom, amICreator);

        highlightMyPlayerCard(amICreator);

        const amIReady = amICreator ? currentRoom.creator_ready : currentRoom.player2_ready;

        // 准备按钮：仅游戏已开始（资金已上链）时禁用
        const fundStage = currentRoom.fund_stage || 'local_frozen';
        const fundsOnChain = fundStage === 'chain_frozen' || fundStage === 'revealing';
        const readyBtn = document.getElementById('readyBtn');
        if (readyBtn) {
            readyBtn.disabled = fundsOnChain;
        }
        UI.setReadyButtonText(amIReady ? '取消准备' : '准备');

        // 退出按钮规则：仅资金已上链（chain_frozen/revealing）时禁用
        // 其余所有阶段（CREATED/JOINED/COUNTDOWN/FINISHED/settled/local_frozen）均可退出
        const cannotLeave = fundsOnChain;
        const leaveBtn = document.getElementById('leaveRoomBtn');
        if (leaveBtn) {
            leaveBtn.disabled = cannotLeave;
            leaveBtn.style.opacity = cannotLeave ? '0.5' : '1';
            leaveBtn.style.cursor = cannotLeave ? 'not-allowed' : 'pointer';
            leaveBtn.title = cannotLeave
                ? '对局进行中（资金已上链），无法退出'
                : '退出当前房间，返回游戏大厅';
        }

        if (currentRoom.status === 'countdown') {
            UI.showCountdown(true);
            // 如果有 countdown_start 字段，使用它来计算倒计时（更准确）
            if (currentRoom.countdown_start && !hasWsCountdown) {
                const countdownTotal = 15;
                const endTime = currentRoom.countdown_start + countdownTotal;
                startSyncedCountdown(endTime, currentRoom.countdown_start, countdownTotal);
                hasWsCountdown = true;
            } else if (!hasWsCountdown) {
                startLocalCountdown();
            }
        } else if (currentRoom.status === 'game_started') {
            UI.showCountdown(false);
            stopAllCountdowns();
            hasWsCountdown = false;

            // 关键修复：如果房间已进入 game_started 状态但前端还停留在房间等待界面
            // （常见于 WebSocket game_started 事件丢失、刷新页面、轮询恢复场景），
            // 主动用 currentRoom 数据构造事件并触发 handleRoomGameStarted，
            // 否则双方都会卡在"游戏即将开始"界面无法进入游戏。
            const stageGame = document.getElementById('stageGame');
            const stillInRoomWait = stageGame && stageGame.classList.contains('hidden');
            if (stillInRoomWait && !roomGameStartedHandled && currentRoom.game_id) {
                roomGameStartedHandled = true;
                const myAddr = Wallet.getAddress();
                const amICreator = currentRoom.creator.toLowerCase() === (myAddr || '').toLowerCase();
                handleRoomGameStarted({
                    room_id: currentRoom.room_id,
                    game_id: currentRoom.game_id,
                    is_creator: amICreator,
                    opponent: amICreator ? currentRoom.player2 : currentRoom.creator,
                    token: currentRoom.token,
                    bet_amount: currentRoom.bet_amount,
                    commit_deadline: null,
                });
            }
        } else {
            UI.showCountdown(false);
            stopAllCountdowns();
            hasWsCountdown = false;
        }
    }

    // 更新游戏界面退出按钮状态（根据 fund_stage 判断是否可退出）
    function updateExitGameBtnState() {
        const btn = document.getElementById('exitGameBtn');
        if (!btn) return;
        const fundStage = (currentRoom && currentRoom.fund_stage) || 'local_frozen';
        const fundsOnChain = fundStage === 'chain_frozen' || fundStage === 'revealing';
        btn.disabled = fundsOnChain;
        btn.title = fundsOnChain
            ? '对局进行中（资金已上链），无法退出'
            : '退出当前房间';
    }

    // 高亮自己的玩家卡片
    function highlightMyPlayerCard(isCreator) {
        const creatorCard = document.querySelector('.room-player-creator');
        const opponentCard = document.querySelector('.room-player-opponent');

        if (creatorCard) {
            creatorCard.classList.toggle('is-myself', isCreator);
        }
        if (opponentCard) {
            opponentCard.classList.toggle('is-myself', !isCreator);
        }
    }

    // 开始服务器同步倒计时
    function startSyncedCountdown(endTime, serverTime, total) {
        stopAllCountdowns();

        // 计算本地时间与服务器时间的偏差
        const localNow = Date.now() / 1000;
        const timeOffset = localNow - serverTime;

        // 本地计算的结束时间（考虑时间偏差）
        countdownEndTime = endTime - timeOffset;

        // 倒计时tick回调
        function tick() {
            const now = Date.now() / 1000;
            let remaining = Math.max(0, countdownEndTime - now);
            const isDanger = remaining <= 5;

            // 显示整数秒
            const displaySeconds = Math.ceil(remaining);
            currentCountdown = displaySeconds;
            UI.updateCountdown(displaySeconds, isDanger);

            if (remaining > 0) {
                countdownRafId = requestAnimationFrame(tick);
            } else {
                countdownRafId = null;
            }
        }

        tick();
    }

    // 开始本地倒计时
    function startLocalCountdown() {
        if (countdownInterval) return;

        if (!currentCountdown || currentCountdown > 15) {
            currentCountdown = 15;
        }
        UI.updateCountdown(currentCountdown, currentCountdown <= 5);

        countdownInterval = setInterval(() => {
            currentCountdown--;
            if (currentCountdown <= 0) {
                stopLocalCountdown();
                return;
            }
            UI.updateCountdown(currentCountdown, currentCountdown <= 5);
        }, 1000);
    }

    // 停止本地倒计时
    function stopLocalCountdown() {
        if (countdownInterval) {
            clearInterval(countdownInterval);
            countdownInterval = null;
        }
    }

    // 停止所有倒计时
    function stopAllCountdowns() {
        stopLocalCountdown();
        if (countdownRafId) {
            cancelAnimationFrame(countdownRafId);
            countdownRafId = null;
        }
        countdownEndTime = null;
    }

    // ==================== 链上对局创建流程（房间模式） ====================
    // 倒计时结束后，后端创建本地对局记录并发送 game_started 事件。
    // 但链上对局尚未创建，需要：
    // 1. 创建者调用合约 createMatch() 创建链上对局，获取 chain_game_id
    // 2. 创建者上报 chain_game_id 到后端
    // 3. 后端通知 player2（chain_game_created 事件）
    // 4. player2 调用合约 joinMatch(chain_game_id) 加入链上对局
    // 5. 双方使用 chain_game_id 进入提交/揭晓阶段

    // 处理房间游戏开始事件
    // data.chain_game_id 可选：若已有（如刷新页面恢复），创建者会跳过 createMatch 签名
    async function handleRoomGameStarted(data) {
        console.log('[Room] 游戏开始:', data);
        // 标记已处理，防止轮询重复触发
        roomGameStartedHandled = true;
        stopRoomPolling();
        stopAllCountdowns();
        hasWsCountdown = false;

        // 确保 currentRoom 有数据
        if (!currentRoom) {
            currentRoom = {};
        }
        currentRoom.token = data.token || currentRoom.token;
        currentRoom.bet_amount = data.bet_amount || currentRoom.bet_amount;
        if (data.is_creator) {
            currentRoom.creator = Wallet.getAddress();
            currentRoom.player2 = data.opponent;
        } else {
            currentRoom.creator = data.opponent;
            currentRoom.player2 = Wallet.getAddress();
        }
        currentRoom.status = 'game_started';
        currentRoom.game_id = data.game_id;
        // 进入游戏阶段时资金尚未上链（local_frozen）
        if (!currentRoom.fund_stage) currentRoom.fund_stage = 'local_frozen';
        updateExitGameBtnState();
        // 保存已有的 chain_game_id（用于幂等性判断，避免刷新后重复签名）
        if (data.chain_game_id) {
            currentRoom.chain_game_id = data.chain_game_id;
        }

        // 使用后端传来的 is_creator 字段，比自己比较更可靠
        const amICreator = !!data.is_creator;
        // 是否已有链上对局 ID（刷新恢复 / 上报过 / 事件携带）
        const existingChainGameId = data.chain_game_id ? Number(data.chain_game_id) : null;

        // 设置游戏状态
        resetGameState();
        // 注意：currentGameId 在此时不设置为 chainGameId，让 createChainGameForRoom/handleChainGameCreated
        // 内部根据幂等性逻辑决定是否设置（避免 player2 在未 join 之前就以为自己在游戏中）
        if (existingChainGameId && !amICreator) {
            // player2 刷新恢复：已有 chain_game_id，直接用（joinMatch 会做链上已 join 检查）
            currentGameId = existingChainGameId;
        } else if (amICreator && existingChainGameId) {
            // 创建者刷新恢复：已有 chain_game_id，直接用（createChainGameForRoom 会跳过签名）
            currentGameId = existingChainGameId;
        } else {
            currentGameId = data.game_id;
        }

        // 切换界面
        UI.showCountdown(false);
        UI.setGameId(existingChainGameId || data.game_id || '准备中...');
        UI.showStage('stageGame');

        // 显示出拳按钮（禁用状态），让用户知道这是游戏界面
        UI.setMyChoice(null);
        UI.setOpponentChoice(null);
        UI.setChoiceButtonsEnabled(false);
        UI.showRevealButton(false);
        UI.showTimeoutButton(false);
        UI.showRetrySection(null);
        const confirmSection = document.getElementById('choiceConfirmSection');
        if (confirmSection) confirmSection.classList.add('hidden');

        // 更新 URL：使用带房间号的路由，刷新页面可恢复
        if (currentRoomId) {
            window.history.pushState({}, '', `/room/${currentRoomId}/game`);
        } else {
            window.history.pushState({}, '', '/game');
        }

        if (amICreator) {
            UI.setMyStatus('创建对局');
            UI.setOpponentStatus('等待加入');
            UI.setOpponentAddress(data.opponent);

            // 幂等性：如果已有 chain_game_id（例如刷新页面恢复），跳过 createMatch 签名
            // 直接进入"等待对手加入"阶段，避免重复签名
            if (existingChainGameId) {
                currentGameId = existingChainGameId;
                UI.setGameId(existingChainGameId);
                UI.setGameStatus('等待对手加入');
                UI.setMyStatus('等待出拳');
                UI.setOpponentStatus('加入中...');
                FWUI.Toast.info(`已恢复链上对局 #${existingChainGameId}，等待对手加入`);
                pollChainGameUntilJoined();
            } else {
                UI.setGameStatus('创建链上对局中...');

                // 创建者兜底轮询：如仍未拿到 chain_game_id（可能之前上报成功但前端异常），
                // 则拉取 room 信息拿 chain_game_id，若有则直接进入等待对手加入阶段
                const creatorRecoverTimer = setInterval(async () => {
                    if (currentGameId) { clearInterval(creatorRecoverTimer); return; }
                    if (!currentRoomId) { clearInterval(creatorRecoverTimer); return; }
                    try {
                        const resp = await fetch(`${CONFIG.backendUrl}/api/game/room/${currentRoomId}`);
                        const d = resp.ok ? await resp.json() : null;
                        if (d && d.chain_game_id) {
                            clearInterval(creatorRecoverTimer);
                            const chainGameId = Number(d.chain_game_id);
                            currentGameId = chainGameId;
                            UI.setGameId(chainGameId);
                            UI.setGameStatus('等待对手加入');
                            UI.setMyStatus('等待出拳');
                            UI.setOpponentStatus('加入中...');
                            FWUI.Toast.success(`已恢复链上对局 #${chainGameId}，等待对手加入`);
                            pollChainGameUntilJoined();
                        }
                    } catch (_) {}
                }, 3000);

                // 创建者：调用合约 createMatch 创建链上对局
                createChainGameForRoom(data).catch(err => {
                    console.error('[Room] 创建链上对局失败:', err);
                    // 兜底轮询已在上面启动，用户可手动重试或等待恢复
                });
            }
        } else {
            // player2：等待创建者上报 chain_game_id
            UI.setMyStatus('等待中');
            UI.setOpponentStatus('创建对局中');
            UI.setOpponentAddress(data.opponent);

            // 幂等性：如果已有 chain_game_id（例如刷新页面恢复），直接进入加入流程
            // handleChainGameCreated 内部会先检查链上是否已 join，避免重复签名
            if (existingChainGameId) {
                FWUI.Toast.info('检测到对手已创建链上对局，准备加入...');
                handleChainGameCreated({
                    room_id: currentRoomId,
                    chain_game_id: existingChainGameId,
                });
            } else {
                UI.setGameStatus('等待对手创建链上对局...');
                FWUI.Toast.info('等待对手创建链上对局...');

                // player2 兜底轮询：若 chain_game_created 事件丢失，定期去 room 信息拉取 chain_game_id
                const player2RecoverTimer = setInterval(async () => {
                    if (currentGameId) { clearInterval(player2RecoverTimer); return; }
                    if (!currentRoomId) { clearInterval(player2RecoverTimer); return; }
                    try {
                        const resp = await fetch(`${CONFIG.backendUrl}/api/game/room/${currentRoomId}`);
                        const d = resp.ok ? await resp.json() : null;
                        if (d && d.chain_game_id) {
                            clearInterval(player2RecoverTimer);
                            FWUI.Toast.info('检测到对手已创建链上对局，准备加入...');
                            handleChainGameCreated({
                                room_id: currentRoomId,
                                chain_game_id: d.chain_game_id,
                            });
                        }
                    } catch (_) {}
                }, 3000);
            }
        }
    }

    // 为房间创建链上对局
    // 幂等性：若 data.chain_game_id 已存在（例如刷新页面恢复），跳过 createMatch 签名
    async function createChainGameForRoom(data) {
        try {
            UI.showStage('stageGame');
            UI.setMyStatus('创建对局');
            UI.setOpponentStatus('等待加入');

            // 幂等性检查：已有 chain_game_id 时直接进入等待对手加入阶段，不再签名
            if (data && data.chain_game_id) {
                const existingId = Number(data.chain_game_id);
                currentGameId = existingId;
                UI.setGameId(existingId);
                UI.setGameStatus('等待对手加入');
                UI.setMyStatus('等待出拳');
                UI.setOpponentStatus('加入中...');
                FWUI.Toast.info(`已恢复链上对局 #${existingId}，等待对手加入`);
                pollChainGameUntilJoined();
                return;
            }

            UI.setGameId('创建中...');

            const tokenAddress = CONFIG.getTokenAddresses()[currentRoom.token];
            const myAddress = Wallet.getAddress();
            const isNativeETH = !tokenAddress || tokenAddress === '0x0000000000000000000000000000000000000000';

            if (!isNativeETH) {
                UI.setGameStatus('授权代币中...');
                // ERC20 需要先授权（ETH 原生代币跳过）
                await Contract.ensureAllowance(tokenAddress, currentRoom.bet_amount, myAddress);
            }

            UI.setGameStatus('创建链上对局中...');

            // 调用合约 createMatch
            const {gameId: chainGameId} = await Contract.createMatch(currentRoom.bet_amount, tokenAddress);

            if (!chainGameId) {
                throw new Error('未能获取链上对局 ID');
            }

            // 上报 chain_game_id 到后端（必须验证后端成功，否则对手无法被通知）
            const reportRes = await fetch(`${CONFIG.backendUrl}/api/game/room/${currentRoomId}/chain-game`, {
                method: 'POST',
                headers: {'Content-Type': 'application/json'},
                body: JSON.stringify({
                    chain_game_id: chainGameId,
                    player_address: myAddress,
                })
            });
            const reportData = reportRes.ok ? await reportRes.json().catch(() => ({})) : {};
            if (!reportRes.ok || !reportData.success) {
                const msg = reportData.detail || reportData.message || 'HTTP ' + reportRes.status;
                throw new Error('链上对局已创建，但上报给后端失败：' + msg + '（对手可能无法自动加入，请联系对方手动刷新页面）');
            }

            currentGameId = Number(chainGameId);
            UI.setGameId(currentGameId);
            // 资金已在 createMatch 中上链冻结
            if (currentRoom) currentRoom.fund_stage = 'chain_frozen';
            updateExitGameBtnState();
            const chainFrozenText = UI.FUND_STAGE_TEXT ? UI.FUND_STAGE_TEXT['chain_frozen'] : '⛓️ 资金已链上锁定';
            UI.setGameStatus('等待对手加入 · ' + chainFrozenText);
            UI.setMyStatus('等待出拳');
            UI.setOpponentStatus('加入中...');

            FWUI.Toast.success(`链上对局已创建: #${chainGameId}（资金已上链锁定）`);

            // 通过 P2P 即时通知对端链上对局已创建（P2P 未就绪时由后端 WS 推送兜底）
            sendPeerNotify('chain_game_created', {
                room_id: currentRoomId,
                chain_game_id: currentGameId,
                creator: myAddress,
            });

            // 轮询等待 player2 加入链上对局
            pollChainGameUntilJoined();
        } catch (e) {
            console.error('创建链上对局失败:', e);
            const msg = e && e.message ? e.message : String(e);
            // 用户主动取消：不展示"失败"字样
            if (e && e.userCancelled) {
                FWUI.Toast.info(msg || '您已取消创建对局');
                UI.setGameStatus('创建已取消，点击"重试创建对局"可继续');
            } else {
                FWUI.Toast.error(msg || '创建链上对局失败');
                UI.setGameStatus('创建失败，可点击下方按钮重试');
            }
            // 不要切回 stageRoomWait：房间已处于 GAME_STARTED 状态无法离开，切回反而让用户困惑
            // 保留在 stageGame 中显示当前状态与重试能力
            UI.showStage('stageGame');
            UI.setGameId('创建中...');
            UI.setMyStatus('创建对局');
            UI.setOpponentStatus('等待加入');
            // 显示重试创建对局 + 退出房间按钮
            UI.showRetrySection('create');
        }
    }

    // 处理链上对局已创建事件
    // 幂等性：先调用 Contract.getGame 检查链上 player2 是否已是自己，若是则跳过 joinMatch 签名
    async function handleChainGameCreated(data) {
        const chainGameId = Number(data.chain_game_id);
        if (!chainGameId) return;

        currentGameId = chainGameId;

        try {
            UI.showStage('stageGame');
            UI.setGameId(currentGameId);
            UI.setMyStatus('加入中');
            UI.setOpponentStatus('已就绪');

            const myAddress = Wallet.getAddress();
            const ZERO_ADDR = '0x0000000000000000000000000000000000000000';

            // 幂等性检查：先查链上对局状态，若自己已是 player2 则直接进入出拳阶段，不再签名
            // 这是"一个房间只需签名一次"的关键：刷新页面后若已 join 过，直接恢复出拳界面
            try {
                UI.setGameStatus('检查链上对局状态...');
                const game = await Contract.getGame(currentGameId);
                if (game && game.player2 && game.player2.toLowerCase() === myAddress.toLowerCase()) {
                    // 已经 join 过，直接进入出拳阶段
                    enterGamePhase();
                    UI.setOpponentStatus('等待出拳');
                    FWUI.Toast.success('已恢复加入状态，开始出拳！');
                    return;
                }
                // 若对局已结束（status >= 3），也直接进入出拳阶段让 enterGamePhase 处理后续
                if (game && Number(game.status) >= 3) {
                    enterGamePhase();
                    UI.setOpponentStatus('对局已结束');
                    FWUI.Toast.info('该对局已结束');
                    return;
                }
            } catch (checkErr) {
                // 链上查询失败时降级为继续尝试 joinMatch（不阻断流程）
                console.warn('[Room] 检查链上 join 状态失败，继续尝试 joinMatch:', checkErr && checkErr.message);
            }

            const tokenAddress = CONFIG.getTokenAddresses()[currentRoom.token];
            const isNativeETH = !tokenAddress || tokenAddress === '0x0000000000000000000000000000000000000000';

            if (!isNativeETH) {
                UI.setGameStatus('授权代币中...');
                // ERC20 需要先授权（ETH 原生代币跳过）
                await Contract.ensureAllowance(tokenAddress, currentRoom.bet_amount, myAddress);
            }

            UI.setGameStatus('加入链上对局中...');

            // 调用合约 joinMatch
            await Contract.joinMatch(currentGameId);

            enterGamePhase();
            // 资金已在 joinMatch 中上链冻结
            if (currentRoom) currentRoom.fund_stage = 'chain_frozen';
            updateExitGameBtnState();
            const chainFrozenText = UI.FUND_STAGE_TEXT ? UI.FUND_STAGE_TEXT['chain_frozen'] : '⛓️ 资金已链上锁定';
            const curStatus = document.getElementById('gameStatus') ? document.getElementById('gameStatus').textContent : '';
            if (!curStatus.includes('资金已链上锁定') && !curStatus.includes('链上冻结')) {
                UI.setGameStatus((curStatus || '提交阶段') + ' · ' + chainFrozenText);
            }
            UI.setOpponentStatus('等待出拳');
            FWUI.Toast.success('已加入链上对局！（资金已上链锁定）');

            // 通过 P2P 即时通知创建者已加入链上对局（P2P 未就绪时由后端 WS 推送兜底）
            sendPeerNotify('chain_game_player_joined', {
                chain_game_id: currentGameId,
                player: myAddress,
                message: '对手已加入链上对局',
            });
        } catch (e) {
            console.error('加入链上对局失败:', e);
            const msg = e && e.message ? e.message : String(e);
            if (e && e.userCancelled) {
                FWUI.Toast.info(msg || '您已取消加入对局');
                UI.setGameStatus('加入已取消，点击"重试加入对局"可继续');
            } else {
                FWUI.Toast.error(msg || '加入链上对局失败');
                UI.setGameStatus('加入失败，可点击下方按钮重试');
            }
            // 保留在 stageGame：避免切回 stageRoomWait 让用户误以为已经退出对局
            UI.showStage('stageGame');
            UI.setGameId(currentGameId);
            UI.setMyStatus('加入中');
            UI.setOpponentStatus('已就绪');
            // 显示重试加入对局 + 退出房间按钮
            UI.showRetrySection('join');
        }
    }

    // 轮询等待链上对局对手加入
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
                    // 创建者视角：对手 joinMatch 成功后，双方资金都在链上冻结
                    const chainFrozenText = UI.FUND_STAGE_TEXT ? UI.FUND_STAGE_TEXT['chain_frozen'] : '⛓️ 资金已链上锁定';
                    const gsEl = document.getElementById('gameStatus');
                    const curStatus = gsEl ? gsEl.textContent : '';
                    if (!curStatus.includes('资金已链上锁定') && !curStatus.includes('链上冻结')) {
                        UI.setGameStatus((curStatus || '提交阶段') + ' · ' + chainFrozenText);
                    }
                    FWUI.Toast.success('对手已加入，开始出拳！（资金已链上锁定）');
                }
            } catch (e) {
                console.error('查询链上对局失败:', e);
            }
        }, 3000);
    }

    let currentRoomId = null;
    let currentRoom = null;
    let roomPollingInterval = null;
    let roomStatusLoading = false;
    let roomStatusTimeout = null;
    // 防止轮询恢复 game_started 状态时重复触发 handleRoomGameStarted
    let roomGameStartedHandled = false;
    // 游戏阶段兜底轮询定时器（用于 WS 事件丢失时检测对手提交/揭晓状态）
    let gameFallbackTimer = null;

    // 开始房间状态轮询（智能降级：WS 已连接时低频兜底，WS 断连时高频降级）
    function startRoomPolling() {
        if (roomPollingInterval) clearInterval(roomPollingInterval);

        const tick = () => {
            if (!currentRoomId) {
                clearInterval(roomPollingInterval);
                return;
            }
            // 智能降级策略：
            // - WS 已连接：低频兜底（10 秒一次），防止 WS 事件丢失
            // - WS 未连接：高频降级（3 秒一次），保证基本实时性
            if (!roomWsConnected) {
                loadRoomStatus();
            }
        };

        // 固定 3 秒间隔触发，但内部只在 WS 断连时实际拉取
        // WS 已连接时通过独立的兜底轮询（10 秒）补充检测
        roomPollingInterval = setInterval(tick, 3000);

        // WS 已连接时的低频兜底轮询（10 秒一次，防止 WS 事件丢失）
        if (!gameFallbackTimer) {
            gameFallbackTimer = setInterval(() => {
                if (!currentRoomId) return;
                // WS 已连接时仍兜底拉取一次房间状态（WS 事件可能丢失）
                if (roomWsConnected) {
                    loadRoomStatus();
                }
            }, 10000);
        }
    }

    // 停止房间状态轮询
    function stopRoomPolling() {
        if (roomPollingInterval) {
            clearInterval(roomPollingInterval);
            roomPollingInterval = null;
        }
        // 停止房间阶段兜底轮询
        if (gameFallbackTimer) {
            clearInterval(gameFallbackTimer);
            gameFallbackTimer = null;
        }
        // 重置 game_started 处理标志，下次进入新房间时可再次触发
        roomGameStartedHandled = false;
    }

    // 停止所有兜底轮询（房间销毁/退出时调用）
    function stopAllFallbackPolling() {
        if (gameFallbackTimer) {
            clearInterval(gameFallbackTimer);
            gameFallbackTimer = null;
        }
        stopGamePhaseFallbackPolling();
    }

    // 游戏阶段兜底轮询定时器（检测链上对局状态：commit/reveal）
    let gamePhaseFallbackTimer = null;
    let lastOpponentCommitState = false;
    let lastOpponentRevealState = false;

    // 启动游戏阶段兜底轮询（WS 事件丢失时通过链上查询恢复）
    function startGamePhaseFallbackPolling() {
        stopGamePhaseFallbackPolling();
        lastOpponentCommitState = opponentCommitSubmitted;
        lastOpponentRevealState = opponentRevealed;

        gamePhaseFallbackTimer = setInterval(async () => {
            if (!currentGameId) {
                stopGamePhaseFallbackPolling();
                return;
            }
            try {
                const game = await Contract.getGame(currentGameId);
                if (!game) return;

                const myAddress = Wallet.getAddress();
                const isPlayer1 = game.player1 && game.player1.toLowerCase() === myAddress.toLowerCase();
                const opponentAddr = isPlayer1 ? game.player2 : game.player1;

                // 检测对手是否已提交哈希（链上 commit 字段非零）
                // 注意：合约的 commit1/commit2 是 bytes32，需要通过 getCommit 查询
                if (!opponentCommitSubmitted && currentGameId) {
                    try {
                        const opponentCommit = await Contract.getCommit(currentGameId, opponentAddr);
                        if (opponentCommit && opponentCommit !== '0x0000000000000000000000000000000000000000000000000000000000000000') {
                            // 链上检测到对手已提交，但 WS 事件未到达，手动触发
                            console.log('[Fallback] 链上检测到对手已提交，补触发 opponent_commit');
                            opponentCommitSubmitted = true;
                            UI.setOpponentStatus('已提交');
                            if (myCommitSubmitted) {
                                gamePhase = 'reveal';
                                UI.setGameStatus('揭晓阶段 · 即将自动揭晓');
                                UI.setMyStatus('待揭晓');
                                if (myCommitSubmitted) UI.showRevealButton(true);
                                startGameTimer('reveal');
                                startAutoReveal(5);
                                FWUI.Toast.info('双方都已提交，进入揭晓阶段（5秒后自动揭晓）');
                            }
                        }
                    } catch (_) {}
                }
            } catch (e) {
                console.warn('[Fallback] 游戏阶段兜底轮询失败:', e.message);
            }
        }, 5000);
    }

    // 停止游戏阶段兜底轮询
    function stopGamePhaseFallbackPolling() {
        if (gamePhaseFallbackTimer) {
            clearInterval(gamePhaseFallbackTimer);
            gamePhaseFallbackTimer = null;
        }
    }

    // 开始快速匹配
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

    // 从后端请求匹配
    function requestMatchFromBackend() {
        if (!CONFIG.backendUrl) return;

        // 防止 fetch 和 WebSocket 重复触发匹配成功
        let matchHandled = false;

        // 匹配成功处理回调
        function onMatchFound(gameId, opponent) {
            if (matchHandled) return;
            matchHandled = true;
            handleMatchFound(gameId, opponent);
        }

        fetch(`${CONFIG.backendUrl}/api/game/join`, {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
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

    // 开始匹配计时器
    function startMatchingTimer() {
        matchingStartTime = Date.now();
        matchingTimer = setInterval(() => {
            const elapsed = Math.floor((Date.now() - matchingStartTime) / 1000);
            UI.updateMatchingTime(elapsed);
        }, 1000);
    }

    // 停止匹配计时器
    function stopMatchingTimer() {
        if (matchingTimer) {
            clearInterval(matchingTimer);
            matchingTimer = null;
        }
    }

    // 取消匹配
    function cancelMatch() {
        stopMatchingTimer();

        if (GameSocket.isConnected()) {
            GameSocket.disconnect();
        }

        UI.showStage('stageLobby');
        FWUI.Toast.info('已取消匹配');
    }

    // 处理匹配成功
    function handleMatchFound(gameId, opponent) {
        stopMatchingTimer();
        currentGameId = Number(gameId);

        enterGamePhase();
        UI.setOpponentAddress(opponent);
        UI.setOpponentStatus('等待出拳');

        FWUI.Toast.success('匹配成功！');
    }

    // 创建私密对局
    async function createPrivateMatch() {
        try {
            UI.setStartButtonText('创建对局中...', true);

            const tokenAddress = CONFIG.getTokenAddresses()[currentToken];
            const myAddress = Wallet.getAddress();

            await Contract.ensureAllowance(tokenAddress, currentAmount, myAddress);

            const {gameId} = await Contract.createMatch(currentAmount, tokenAddress);
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

    // 加入私密对局
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

    // 轮询等待私密对局对手加入
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

    // 进入游戏出拳阶段
    function enterGamePhase() {
        gamePhase = 'commit';
        UI.showStage('stageGame');
        UI.setGameId(currentGameId);
        // 进入提交阶段时双方已完成 createMatch/joinMatch，资金已在链上冻结
        const chainFrozenText = UI.FUND_STAGE_TEXT ? UI.FUND_STAGE_TEXT['chain_frozen'] : '⛓️ 资金已链上锁定';
        UI.setGameStatus('提交阶段 · ' + chainFrozenText);
        UI.setMyStatus('等待出拳');
        UI.setMyChoice(null);
        UI.setOpponentChoice(null);
        UI.setChoiceButtonsEnabled(true);
        UI.showRevealButton(false);
        UI.showTimeoutButton(false);
        UI.showRetrySection(null);
        pendingChoice = null;
        const confirmSection = document.getElementById('choiceConfirmSection');
        if (confirmSection) confirmSection.classList.add('hidden');

        selectedChoice = null;
        currentSalt = null;
        myCommitSubmitted = false;
        opponentCommitSubmitted = false;
        myRevealed = false;
        opponentRevealed = false;

        // 订阅对局（后端可批量通知对局双方）
        if (currentGameId && GameSocket.isConnected()) {
            GameSocket.subscribeGame(currentGameId);
        }

        // 启动游戏阶段兜底轮询（WS 事件丢失时通过链上查询恢复）
        startGamePhaseFallbackPolling();

        startGameTimer('commit');
    }

    // 开始游戏阶段计时器
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

    // 停止游戏计时器
    function stopGameTimer() {
        if (gameTimerInterval) {
            clearInterval(gameTimerInterval);
            gameTimerInterval = null;
        }
    }

    // 处理计时器超时
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

    // 预览出拳选择
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

    // 取消出拳预览
    function cancelChoicePreview() {
        pendingChoice = null;
        UI.setSelectedChoice(null);
        const confirmSection = document.getElementById('choiceConfirmSection');
        if (confirmSection) confirmSection.classList.add('hidden');
        document.querySelectorAll('.choice-btn').forEach(btn => {
            btn.disabled = false;
        });
    }

    // 确认并提交出拳（方案A：EIP-712 链下签名 + 后端 relayer 代提交）
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

            UI.setMyStatus('签名中...');

            // 方案A：玩家做 EIP-712 链下签名（无 gas 费，秒级完成）
            const sigResult = await Contract.signCommit(currentGameId, myAddress, commitHash);

            UI.setMyStatus('代提交中...');

            // 将签名发给后端，由 relayer 调用合约 submitCommitWithSig 代为上链
            const res = await fetch(`${CONFIG.backendUrl}/api/game/submit-commit-sig`, {
                method: 'POST',
                headers: {'Content-Type': 'application/json'},
                body: JSON.stringify({
                    game_id: currentGameId,
                    player_address: myAddress,
                    commit_hash: commitHash,
                    nonce: sigResult.nonce,
                    v: sigResult.v,
                    r: sigResult.r,
                    s: sigResult.s,
                })
            });
            const data = await res.json();
            if (!res.ok || !data.success) {
                throw new Error(data.message || '代提交失败');
            }

            myCommitSubmitted = true;
            UI.setMyStatus('已提交');
            UI.setChoiceButtonsEnabled(false);

            RPSCrypto.storeSalt(currentGameId, currentSalt, choice);

            FWUI.Toast.success('出拳已提交（签名代提交）');

            // 通过 P2P 即时通知对端已提交（P2P 不带出拳数据，仅通知状态）
            sendPeerNotify('opponent_commit', {
                game_id: currentGameId,
                player: myAddress,
            });

            if (opponentCommitSubmitted) {
                gamePhase = 'reveal';
                // 双方都已提交 → 进入揭晓阶段，资金状态进入 revealing
                const revealingText = UI.FUND_STAGE_TEXT ? UI.FUND_STAGE_TEXT['revealing'] : '🔓 揭晓中，等待结算';
                UI.setGameStatus('揭晓阶段 · 即将自动揭晓 · ' + revealingText);
                UI.showRevealButton(true);
                startGameTimer('reveal');
                startAutoReveal(5);
            }

        } catch (e) {
            FWUI.Toast.error(e.message || '提交失败');
            UI.setMyStatus('提交失败，重试');
            UI.setSelectedChoice(null);
            selectedChoice = null;
            currentSalt = null;
        }
    }

    // 揭晓出拳（方案A：EIP-712 链下签名 + 后端 relayer 代提交上链）
    async function revealChoice() {
        if (!selectedChoice || !currentSalt || !myCommitSubmitted || myRevealed) return;

        const revealBtn = UI.elements.revealBtn;
        try {
            stopAutoReveal();
            if (revealBtn) {
                revealBtn.disabled = true;
                revealBtn.textContent = '签名中...';
            }

            const myAddress = Wallet.getAddress();

            // 方案A：玩家对 reveal 数据做 EIP-712 链下签名（无 gas 费）
            const sigResult = await Contract.signReveal(
                currentGameId, myAddress, selectedChoice, currentSalt
            );

            if (revealBtn) {
                revealBtn.textContent = '代提交中...';
            }

            // 将签名发给后端，由 relayer 调用合约 revealChoiceWithSig 一次性上链完成揭晓
            // （用户要求：reveal 阶段必须上链，此步把签名数据一次性上链）
            const res = await fetch(`${CONFIG.backendUrl}/api/game/reveal-choice-sig`, {
                method: 'POST',
                headers: {'Content-Type': 'application/json'},
                body: JSON.stringify({
                    game_id: currentGameId,
                    player_address: myAddress,
                    choice: selectedChoice,
                    salt: currentSalt,
                    nonce: sigResult.nonce,
                    v: sigResult.v,
                    r: sigResult.r,
                    s: sigResult.s,
                })
            });
            const data = await res.json();
            if (!res.ok || !data.success) {
                throw new Error(data.message || '代提交揭晓失败');
            }

            myRevealed = true;
            UI.showRevealButton(false);
            UI.setMyStatus('已揭晓');
            UI.setMyChoice(selectedChoice, true);

            FWUI.Toast.success('揭晓成功（签名代提交）');

            RPSCrypto.clearSalt(currentGameId);

            // 通过 P2P 即时通知对端已揭晓（P2P 不带出拳数据，出拳内容由链上事件同步）
            sendPeerNotify('opponent_reveal', {
                game_id: currentGameId,
                player: myAddress,
            });

        } catch (e) {
            FWUI.Toast.error(e.message || '揭晓失败');
            if (revealBtn) {
                revealBtn.disabled = false;
                revealBtn.textContent = '揭晓出拳';
            }
        }
    }

    // 启动自动揭示倒计时（seconds 秒后自动调用 revealChoice）
    function startAutoReveal(seconds = 5) {
        stopAutoReveal();
        let remaining = seconds;
        const btn = UI.elements.revealBtn;

        const tick = () => {
            // 已揭示，或不再需要揭示（状态变更），直接停止
            if (myRevealed || !currentGameId || gamePhase !== 'reveal') {
                stopAutoReveal();
                return;
            }
            if (btn) {
                if (remaining <= 0) {
                    stopAutoReveal();
                    // 优先使用本地保存的盐+出拳（用户可能未点击选择但之前已经提交过 commit，因为 submitChoice 时已存盐）
                    const stored = RPSCrypto.getSalt(currentGameId);
                    if (!selectedChoice && stored && stored.choice) {
                        selectedChoice = stored.choice;
                    }
                    if (!currentSalt && stored && stored.salt) {
                        currentSalt = stored.salt;
                    }
                    if (selectedChoice && currentSalt && myCommitSubmitted && !myRevealed) {
                        btn.disabled = true;
                        btn.textContent = '自动揭晓中...';
                        revealChoice();
                    } else {
                        btn.disabled = false;
                        btn.textContent = '揭晓出拳';
                    }
                    return;
                }
                btn.textContent = `自动揭晓（${remaining}s）`;
            }
            remaining--;
        };

        tick();
        autoRevealTimer = setInterval(tick, 1000);
    }

    // 停止自动揭示
    function stopAutoReveal() {
        if (autoRevealTimer) {
            clearInterval(autoRevealTimer);
            autoRevealTimer = null;
        }
    }

    // 超时索赔
    async function claimTimeout() {
        const claimBtn = UI.elements.claimTimeoutBtn;
        try {
            if (claimBtn) {
                claimBtn.disabled = true;
                claimBtn.textContent = '索赔中...';
            }

            await Contract.claimTimeout(currentGameId);

            FWUI.Toast.success('超时索赔成功');

        } catch (e) {
            FWUI.Toast.error(e.message || '索赔失败');
            if (claimBtn) {
                claimBtn.disabled = false;
                claimBtn.textContent = '索赔超时胜利';
            }
        }
    }

    // 处理对局结算
    function handleGameSettled(args) {
        stopGameTimer();
        stopAutoReveal();
        // 结算后更新房间 fund_stage（本地同步）
        if (currentRoom) currentRoom.fund_stage = 'settled';
        updateExitGameBtnState();

        // 资金结算完成，显示为已结算
        const settledText = UI.FUND_STAGE_TEXT ? UI.FUND_STAGE_TEXT['settled'] : '✅ 资金已结算';
        UI.setGameStatus('对局结束 · ' + settledText);

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

        // 构建对局结果并展示
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

    // 显示对局结果（默认持续显示30秒，之后自动返回）
    function showResult(result) {
        gamePhase = 'finished';
        UI.showStage('stageResult');
        UI.showResult(result);
        startResultCountdown(30);
    }

    // 启动结果界面倒计时（seconds 秒后自动返回房间/大厅）
    function startResultCountdown(seconds = 30) {
        stopResultCountdown();
        const el = document.getElementById('resultCountdown');
        let remaining = seconds;
        const updateText = () => {
            if (el) {
                el.textContent = `${remaining} 秒后自动返回房间...`;
            }
        };
        updateText();
        resultCountdownTimer = setInterval(() => {
            remaining--;
            if (remaining <= 0) {
                stopResultCountdown();
                // 自动返回：房间还在则回房间等待，否则回大厅
                if (currentRoomId && currentRoom) {
                    UI.showStage('stageRoomWait');
                    updateRoomUI();
                    startRoomPolling();
                } else {
                    UI.showStage('stageLobby');
                    loadRoomList();
                }
                return;
            }
            updateText();
        }, 1000);
    }

    // 停止结果界面倒计时
    function stopResultCountdown() {
        if (resultCountdownTimer) {
            clearInterval(resultCountdownTimer);
            resultCountdownTimer = null;
        }
        const el = document.getElementById('resultCountdown');
        if (el) el.textContent = '';
    }

    // 处理平局结算
    function handleDrawSettled(args) {
        stopGameTimer();
        stopAutoReveal();
        // 结算后更新房间 fund_stage（本地同步）
        if (currentRoom) currentRoom.fund_stage = 'settled';
        updateExitGameBtnState();

        // 平局结算完成，资金已退款
        const settledText = UI.FUND_STAGE_TEXT ? UI.FUND_STAGE_TEXT['settled'] : '✅ 资金已结算（平局退款）';
        UI.setGameStatus('平局结束 · ' + settledText);

        const myAddress = Wallet.getAddress();

        // 平局退款金额：优先取房间信息，其次取首页选择
        const betAmount = (currentRoom && currentRoom.bet_amount) ? currentRoom.bet_amount : currentAmount;
        const tokenSymbol = (currentRoom && currentRoom.token) ? currentRoom.token : currentToken;
        const betAmountNum = Number(betAmount) || 0;

        // 自动领取平局退款（合约要求双方各自调用 handleDraw 领取）
        if (currentGameId && Contract.getContract()) {
            FWUI.Toast.info('平局，正在自动领取退款...');
            Contract.handleDraw(currentGameId).then(() => {
                FWUI.Toast.success('平局退款已领取');
            }).catch(e => {
                console.warn('自动领取平局退款失败（可稍后手动领取）:', e.message);
                FWUI.Toast.warning('平局退款领取失败，可稍后手动领取');
            });
        }

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
            showResult({type: 'draw'});
        }
    }

    // 重置游戏状态
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
        stopAutoReveal();
        stopResultCountdown();
        stopMatchingTimer();

        if (GameSocket.isConnected()) {
            GameSocket.disconnect();
        }

        UI.setSelectedChoice(null);
        UI.setStartButtonText(currentMode === 'B' ? '创建/加入私密对局' : '🏠 进入交易大厅', false);
    }

    // 更新历史记录和统计
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
        // 获取当前模式
        getCurrentMode: () => currentMode,
        // 获取当前对局ID
        getCurrentGameId: () => currentGameId
    };
})();