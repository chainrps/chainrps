// 应用主模块（立即执行函数）
const App = (function () {
    let currentMode = 'A';
    let currentToken = CONFIG.getDefaultToken();
    let currentAmount = 100;
    let currentGameId = null;
    // 链上对局 ID 是否已确认（区别于本地 game_id，防止兜底轮询自毁）
    let chainGameIdResolved = false;
    // 我自己是否已实际 join 链上对局（资金已锁）
    let myChainJoined = false;
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
    let isLocalOnlyGame = false;  // 🆕 auto_chain_match=False 时为 true，commit/reveal 走后端 API 不走链上
    let autoRevealTimer = null; // 自动揭示计时器
    function isPurePrivateMode() { return currentMode === 'B'; }
    let resultCountdownTimer = null; // 结果界面倒计时计时器

    // 🆕 统一设置游戏阶段 —— 同时更新变量 + body.dataset（CSS 依赖 dataset 隐藏/显示 game-board）
    function setGamePhase(phase) {
        gamePhase = phase;
        document.body.dataset.gamePhase = phase;
    }

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

        // 自动连接钱包（用 localStorage 记住的钱包类型，刷新自动重连）
        autoConnectWallet();

        // 处理 URL 路由
        handleRoute();

        // file:// 协议警告：钱包扩展不注入 window.ethereum
        if (window.location.protocol === 'file:') {
            FWUI.Toast.warn('检测到 file:// 协议，钱包扩展可能无法注入。建议用本地 HTTP 服务器：cd rps_frontend/static && python -m http.server 8080');
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

    // 处理URL路由
    function handleRoute() {
        let path = window.location.pathname;
        const isFileProtocol = window.location.protocol === 'file:';

        // file:// 协议下 pathname 是 /D:/Git/.../index.html 或 /home/.../index.html
        // 没有标准路由结构，一律视为 lobby
        if (isFileProtocol || /^\/[A-Za-z]:\//.test(path)) {
            enterLobby();
            return;
        }

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
            } else if (subPath === 'result') {
                // /room/{id}/result：结算画面路由恢复
                handleResultRoute(roomId);
            } else {
                // /room/{id}：房间等待 — 异步检查房间是否存在
                currentRoomId = roomId;
                roomGameStartedHandled = false;
                enterRoomWait();
                // 异步验证房间存在性（后台静默检查，失败不打断）
                validateRoomExists(roomId);
            }
        } else if (path === '/game' || path.startsWith('/game/')) {
            // 兼容旧路由 /game
            if (!currentGameId) {
                enterLobby();
            }
        } else {
            // 🆕 未知路径 → 404 Modal 而不是静默跳回首页
            FWUI.Modal.alert({
                title: '🤔 页面不存在',
                content: `<p>路径 <code style="background:#1a1a2e;padding:2px 6px;border-radius:4px;">${path}</code> 不存在哦～</p><p style="margin-top:8px;">已返回游戏大厅。</p>`,
                onClose: () => navigateTo('/'),
            });
            enterLobby();
        }
    }

    // 🆕 异步检查房间是否存在 — 存在就正常显示；不存在/已关闭就 Modal 引导
    async function validateRoomExists(roomId) {
        try {
            const r = await fetch(`${CONFIG.backendUrl}/api/game/room/${roomId}`, {
                method: 'GET', cache: 'no-store', timeout: 5
            });
            // 404 或 200 + success:false 都视为不可用（双重保险）
            let isGone = r.status === 404;
            if (!isGone && r.ok) {
                try {
                    const data = await r.json();
                    isGone = data && data.success === false;
                } catch (_) { /* 响应体非 JSON，忽略 */ }
            }
            if (isGone) {
                FWUI.Modal.alert({
                    title: '🚪 房间不存在',
                    content: `<p>房间 <b>${roomId}</b> 不存在或已被关闭。</p><p style="margin-top:8px;">已返回游戏大厅。</p>`,
                    onClose: () => navigateTo('/'),
                });
                enterLobby();
                currentRoomId = null;
            }
        } catch (_) {
            // 后端暂时不可达 → 不打断用户，保持当前显示（可能是 loading 状态）
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
            // 保险：HTTP 200 但 success: false（如房间已解散）也要跳转
            if (!room || !room.room_id || room.success === false) {
                const msg = room && room.message ? room.message : '房间不存在或已关闭';
                console.warn('[Route] 房间不可用:', roomId, msg);
                _showRoomGoneModal('not_found', msg);
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
                    local_only: !!room.local_only,  // auto_chain_match=False 时跳过所有链上
                    creator_is_bot: !!room.creator_is_bot,
                    player2_is_bot: !!room.player2_is_bot,
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

    // 处理 /room/{id}/result 路由：直接显示结算画面
    async function handleResultRoute(roomId) {
        // 重入保护：已在 stageResult 且 room 匹配，直接 return（防止 navigateTo 循环触发）
        const stageResult = document.getElementById('stageResult');
        const alreadyHere = stageResult && !stageResult.classList.contains('hidden')
            && currentRoomId === roomId;
        if (alreadyHere) return;

        // 场景 1：刷新页面恢复结算画面 → 需要 fetch 校验
        // 场景 2：navigateTo 自动触发（结算刚发生）→ currentRoomId 已对，直接 show
        if (currentRoomId === roomId && currentRoom) {
            UI.showStage('stageResult');
            return;
        }
        if (!Wallet.isConnected()) {
            FWUI.Toast.warning('请先连接钱包');
            navigateTo('/');
            return;
        }
        try {
            const resp = await fetch(`${CONFIG.backendUrl}/api/game/room/${roomId}`);
            const room = resp.ok ? await resp.json() : null;
            if (!room || !room.room_id || room.success === false) {
                navigateTo('/');
                return;
            }
            const myAddr = (Wallet.getAddress() || '').toLowerCase();
            const amICreator = room.creator && room.creator.toLowerCase() === myAddr;
            const amIPlayer2 = room.player2 && room.player2.toLowerCase() === myAddr;
            if (!amICreator && !amIPlayer2) {
                navigateTo('/');
                return;
            }
            currentRoomId = roomId;
            currentRoom = room;
            UI.showStage('stageResult');
        } catch (e) {
            FWUI.Toast.error('恢复结算画面失败: ' + (e.message || e));
            navigateTo('/');
        }
    }

    // 导航到指定路径（只更新 URL，交给 handleRoute 分发；自带重入保护防止死循环）
    let _navigating = false;
    function navigateTo(path, opts = {}) {
        if (_navigating) return;
        _navigating = true;
        try {
            if (opts.replace) {
                window.history.replaceState({}, '', path);
            } else {
                window.history.pushState({}, '', path);
            }
            handleRoute();
        } finally {
            _navigating = false;
        }
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

        document.getElementById('connectWalletBtn').addEventListener('click', toggleWalletPicker);
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

        // ===== 每日领测试币按钮（钱包面板里） =====
        const dripBtn = document.getElementById('walletDripBtn');
        if (dripBtn) {
            dripBtn.addEventListener('click', async () => {
                // === 状态检查 + 引导 ===
                const address = Wallet.getAddress();

                // 1) 连钱包引导
                if (!address) {
                    const wallets = Wallet.getAvailableWallets();
                    if (wallets.length === 0) {
                        // 完全没装钱包扩展 → Modal 教安装
                        FWUI.Modal.alert({
                            title: '💰 先装个钱包吧',
                            content: `
                                <div style="line-height:1.8;padding:12px 0;">
                                    <p>没检测到 Web3 钱包插件，领测试币需要钱包地址。</p>
                                    <p>推荐 2 款主流钱包（浏览器扩展）：</p>
                                    <div style="margin:12px 0 4px;display:flex;gap:10px;flex-wrap:wrap;">
                                        <a href="https://chromewebstore.google.com/detail/okx-wallet/mcohilncbfahbmgdjkbpemcciiolgcge" 
                                           target="_blank" style="background:#ff6b35;color:#fff;padding:8px 14px;border-radius:8px;text-decoration:none;font-size:13px;">
                                            🔷 装 OKX Wallet
                                        </a>
                                        <a href="https://chromewebstore.google.com/detail/metamask/nkbihfbeogaeaoehlefnkodbefgpgknn" 
                                           target="_blank" style="background:#F6851B;color:#fff;padding:8px 14px;border-radius:8px;text-decoration:none;font-size:13px;">
                                            🦊 装 MetaMask
                                        </a>
                                    </div>
                                    <p style="color:#888;font-size:12px;">装完后刷新 ChainRPS 页面，点右上角「连接钱包」→ 领测试币。</p>
                                </div>
                            `
                        });
                        return;
                    }
                    // 装了但没连接
                    FWUI.Modal.confirm({
                        title: '🔗 请先连接钱包',
                        content: `
                            <div style="line-height:1.8;padding:8px 0;">
                                <p>检测到 ${wallets.map(w => w.name).join('、')}，但还没连接到 ChainRPS。</p>
                                <p>点右上角「连接钱包」→ 选一个钱包 → 选账号 → 回来点领币就行。</p>
                            </div>
                        `,
                        confirmText: '好的，去连接',
                        onConfirm: () => document.getElementById('walletConnectBtn')?.click(),
                    });
                    return;
                }

                // 2) 链检查（领币需要 Ganache 链）
                const currentChainId = Number(Wallet.getChainId());
                const expectedChainId = Number(CONFIG.RPC_CHAIN_ID);  // ← 直接用常量！之前 CONFIG.chainId 是 undefined
                if (currentChainId && currentChainId !== expectedChainId) {
                    FWUI.Modal.confirm({
                        title: '⛓️ 请切到测试链',
                        content: `
                            <div style="line-height:1.8;padding:8px 0;">
                                <p>当前钱包在 <b>Chain ID ${currentChainId}</b>，不是 ChainRPS 本地测试链。</p>
                                <p>测试币只能在测试链上用哦～</p>
                                <div style="background:#1a1a2e;padding:10px 12px;border-radius:8px;font-size:12px;margin:8px 0;line-height:1.6;">
                                    RPC: <code>http://127.0.0.1:8686</code><br>
                                    Chain ID: <code>5208888</code><br>
                                    名称: ChainRPS Local
                                </div>
                            </div>
                        `,
                        confirmText: '切过去',
                        onConfirm: async () => {
                            try { await Wallet.switchChain(CONFIG.RPC_CHAIN_ID); } catch (_) { /* 可能手动切 */ }
                        },
                    });
                    return;
                }

                // === 开始领币 ===
                dripBtn.disabled = true;
                const badge = dripBtn.querySelector('.wdrip-badge');
                const label = dripBtn.querySelector('.wdrip-text');
                const icon = dripBtn.querySelector('.wdrip-icon');
                const prevBadge = badge?.textContent || '';
                const prevText = label?.textContent || '';
                badge && (badge.textContent = '领取中...');
                label && (label.textContent = '领币中');

                try {
                    const res = await fetch(`${CONFIG.backendUrl}/api/ext/drip`, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ address })
                    });
                    const data = await res.json();

                    if (data.dripped) {
                        FWUI.Toast.success(`🎉 ${data.message || '领取成功！'}`);
                        if (data.results) {
                            const parts = [];
                            if (data.results.USDC && !String(data.results.USDC).includes('失败'))
                                parts.push(`${data.results.USDC} USDC`);
                            if (data.results.POL && !String(data.results.POL).includes('失败'))
                                parts.push(`${data.results.POL} POL`);
                            if (parts.length) FWUI.Toast.info(`已到账: ${parts.join(' + ')}`);
                        }
                        // === 关键修复：立即刷新 + 3 次重试 ===
                        // 之前只靠 setTimeout 2s 一次性刷新，经常因为钱包 provider 还没同步
                        // 到最新区块导致读到旧余额，看起来"没领成功"
                        updateBalanceDisplay();                        // 立即刷 1 次
                        let retry = 0;
                        const retryTimer = setInterval(() => {
                            retry++;
                            updateBalanceDisplay();
                            if (retry >= 3) clearInterval(retryTimer); // 共约 1+1+2 秒后停止
                        }, 1000);
                        setTimeout(() => updateBalanceDisplay(), 4000); // 兜底再刷一次
                        _markDripClaimed(dripBtn);
                    } else if (data.already_claimed) {
                        FWUI.Toast.info('📌 今天你已经领过了，明天再来～');
                        _markDripClaimed(dripBtn);
                    } else if (data.cooldown) {
                        FWUI.Toast.info(data.message || '请稍等');
                        badge && (badge.textContent = prevBadge);
                        label && (label.textContent = prevText);
                        dripBtn.disabled = false;
                    } else {
                        FWUI.Modal.alert({
                            title: '领币失败',
                            content: `<p style="color:#ff9a56;">${data.message || '未知错误'}</p>`
                        });
                        badge && (badge.textContent = prevBadge);
                        label && (label.textContent = prevText);
                        dripBtn.disabled = false;
                    }
                } catch (e) {
                    FWUI.Modal.alert({
                        title: '网络异常',
                        content: `<p>请求失败：${e.message}</p><p style="color:#888;font-size:12px;">确认后端在运行：http://127.0.0.1:8000/health</p>`
                    });
                    badge && (badge.textContent = prevBadge);
                    label && (label.textContent = prevText);
                    dripBtn.disabled = false;
                }
            });

            // 统一标记按钮为"已领取"状态
            function _markDripClaimed(btn) {
                btn.classList.add('claimed');
                btn.disabled = true;
                const t = btn.querySelector('.wdrip-text');
                const b = btn.querySelector('.wdrip-badge');
                const i = btn.querySelector('.wdrip-icon');
                if (t) t.textContent = '✓ 今日已领';
                if (b) b.textContent = '明天再来';
                if (i) i.textContent = '✅';
            }
        }

        // 连接钱包后查询领币状态 → 更新按钮外观
        async function refreshDripButtonState() {
            const dripBtnEl = document.getElementById('walletDripBtn');
            const badgeEl = document.getElementById('walletDripBadge');
            if (!dripBtnEl) return;
            const address = Wallet.getAddress();
            if (!address) {
                dripBtnEl.classList.remove('claimed');
                dripBtnEl.disabled = false;
                dripBtnEl.querySelector('.wdrip-text').textContent = '领测试币';
                dripBtnEl.querySelector('.wdrip-icon').textContent = '💸';
                if (badgeEl) badgeEl.textContent = '先连钱包';
                return;
            }
            try {
                const r = await fetch(`${CONFIG.backendUrl}/api/ext/drip/status?address=${address}`, {
                    method: 'GET', cache: 'no-store'
                });
                const data = await r.json();
                if (data.success && data.claimed_today) {
                    dripBtnEl.classList.add('claimed');
                    dripBtnEl.disabled = true;
                    dripBtnEl.querySelector('.wdrip-text').textContent = '✓ 今日已领';
                    dripBtnEl.querySelector('.wdrip-icon').textContent = '✅';
                    if (badgeEl) badgeEl.textContent = '明天再来';
                } else {
                    dripBtnEl.classList.remove('claimed');
                    dripBtnEl.disabled = false;
                    dripBtnEl.querySelector('.wdrip-text').textContent = '领测试币';
                    dripBtnEl.querySelector('.wdrip-icon').textContent = '💸';
                    if (badgeEl) badgeEl.textContent = '每日一次 · 3000 USDC';
                }
            } catch (_) { /* 忽略查询失败 */ }
        }

        // 视图切换（列表/卡片）— 单个按钮，点击切换
        const viewSwitchBtn = document.getElementById('viewSwitchBtn');
        if (viewSwitchBtn) {
            viewSwitchBtn.addEventListener('click', () => {
                const current = viewSwitchBtn.dataset.view || 'list';
                const next = current === 'list' ? 'card' : 'list';
                UI.setRoomListView(next);
            });
        }

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

        document.getElementById('readyBtn').addEventListener('click', onRoomPrimaryAction);

        // 空位头像操作菜单（开放空位 / 邀请 AI / 邀请好友 / 移出对手）
        initSeatMenu();

        // 右上角关闭图标 = 离开房间
        document.getElementById('roomExitBtn').addEventListener('click', leaveRoom);

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

        // 游戏界面头部的退出房间按钮（✕）— 分层退款安全退出
        document.getElementById('exitGameBtn').addEventListener('click', async () => {
            const myAddress = Wallet.getAddress();
            if (!myAddress || !currentRoomId) {
                navigateTo('/');
                UI.showStage('stageLobby');
                return;
            }

            // === 分层退出策略 ===
            // 1. 本地阶段 → 安全退出（无资金上链）
            // 2. player2 自己还没 join（仅创建者资金上链）→ 走 leave 接口安全离开
            //    （后端会读链复核；不能自己调 cancelMatch——Waiting 阶段仅 player1 可撤销）
            // 3. 我自己资金已上链 → 查链上状态决定退款路径
            const fundStage = currentRoom?.fund_stage || 'local_frozen';

            if (fundStage === 'local_frozen' || !myChainJoined) {
                safeExitRoom(currentRoomId, myAddress);
                return;
            }

            // chain_frozen / revealing → 需要检查链上状态决定退款路径
            try {
                const game = await Contract.getGame(currentGameId);
                if (!game) {
                    FWUI.Modal.confirm({
                        title: '退出房间',
                        content: '无法读取链上对局状态，仍要退出吗？（如果资金已上链，将无法自动退回）',
                        okText: '强制退出',
                        cancelText: '取消',
                        onOk: () => safeExitRoom(currentRoomId, myAddress),
                    });
                    return;
                }

                const STATUS_WAITING = 0;
                const STATUS_COMMIT   = 1;
                const STATUS_REVEAL   = 2;
                const STATUS_FINISHED = 3;
                const STATUS_CANCELLED = 4;

                const now = Math.floor(Date.now() / 1000);

                if (game.status === STATUS_WAITING) {
                    // Waiting 阶段（仅 player1 资金上链，等待对手 join）→ 创建者可 cancelMatch 退款
                    FWUI.Modal.confirm({
                        title: '取消对局并退出',
                        content: '对局还在等待对手加入，取消后双方资金将自动退回钱包。确定取消吗？',
                        okText: '调用 cancelMatch 取消',
                        cancelText: '继续等待',
                        onOk: async () => {
                            try {
                                FWUI.Toast.info('正在取消链上对局...');
                                const contract = Contract.getContract();
                                const tx = await contract.cancelMatch(currentGameId);
                                await tx.wait();
                                FWUI.Toast.success('✓ 链上对局已取消，资金已退回');
                                // 🔥 资金已退回钱包 → 刷新余额
                                updateBalanceDisplay();
                                await safeExitRoom(currentRoomId, myAddress);
                            } catch (txErr) {
                                FWUI.Modal.alert({
                                    title: '无法取消',
                                    content: '取消失败：' + (txErr.message || '未知错误'),
                                    okText: '我知道了',
                                });
                            }
                        },
                    });
                    return;
                }

                if (game.status === STATUS_COMMIT) {
                    // v1.4.0：CommitPhase 资金已彻底锁定，无法取消，只能走 commit→reveal→结算 或 超时强制结算
                    const commitDeadline = Number(game.commitDeadline);
                    const commitLeft = commitDeadline - now;
                    if (commitLeft > 0) {
                        const mins = Math.floor(commitLeft / 60);
                        const secs = commitLeft % 60;
                        FWUI.Modal.alert({
                            title: '对局进行中',
                            content: `资金已在链上彻底锁定，无法取消或退出。<br>请在 ${mins}分${secs}秒 内提交出拳，或等待超时后由系统强制随机出拳结算。`,
                            okText: '我知道了',
                        });
                        return;
                    }
                    // Commit 超时 → claimTimeout（合约内部自动随机出拳+正常结算，GameSettled 事件会自动触发结果显示）
                    FWUI.Modal.confirm({
                        title: '超时强制结算',
                        content: '双方提交时间已过，可以触发超时结算。系统将对未操作方自动随机出拳，然后正常结算（赢方拿走奖金池 - 手续费）。',
                        okText: '申请超时结算',
                        cancelText: '取消',
                        onOk: async () => {
                            try {
                                FWUI.Toast.info('正在申请超时强制结算...');
                                const contract = Contract.getContract();
                                await (await contract.claimTimeout(currentGameId)).wait();
                                FWUI.Toast.success('✓ 超时结算已触发，结果将自动显示');
                            } catch (txErr) {
                                FWUI.Toast.error('超时结算失败：' + (txErr.message || '未知错误'));
                            }
                        },
                    });
                    return;
                }

                if (game.status === STATUS_REVEAL) {
                    // Reveal 阶段 → 资金仍锁定，revealDeadline 超时后可 claimTimeout 强制结算
                    const revealDeadline = Number(game.revealDeadline);
                    const revealLeft = revealDeadline - now;
                    if (revealLeft > 0) {
                        const mins = Math.floor(revealLeft / 60);
                        const secs = revealLeft % 60;
                        FWUI.Modal.alert({
                            title: '对手正在揭晓中',
                            content: `资金已在链上锁定，无法取消或退出。<br>请等待对手揭晓（剩余 ${mins}分${secs}秒），或超时后由系统强制随机出拳结算。`,
                            okText: '等待揭晓',
                        });
                        return;
                    }
                    // Reveal 超时 → claimTimeout（合约内部自动随机出拳+正常结算）
                    FWUI.Modal.confirm({
                        title: '超时强制结算',
                        content: '揭晓时间已过，可以触发超时结算。系统将对未揭晓方自动随机出拳，然后正常结算。',
                        okText: '申请超时结算',
                        cancelText: '取消',
                        onOk: async () => {
                            try {
                                FWUI.Toast.info('正在申请超时强制结算...');
                                const contract = Contract.getContract();
                                await (await contract.claimTimeout(currentGameId)).wait();
                                FWUI.Toast.success('✓ 超时结算已触发，结果将自动显示');
                            } catch (txErr) {
                                FWUI.Toast.error('超时结算失败：' + (txErr.message || '未知错误'));
                            }
                        },
                    });
                    return;
                }

                if (game.status === STATUS_FINISHED || game.status === STATUS_CANCELLED) {
                    // 链上已结束 → 直接允许退出
                    safeExitRoom(currentRoomId, myAddress);
                    return;
                }

                // 不应到达这里（已在 Wait/Commit/Reveal/Finished/Cancelled 全部 return）

            } catch (e) {
                console.error('[Exit] 读取链上状态失败:', e);
                FWUI.Modal.confirm({
                    title: '⚠️ 链上状态不可读',
                    content: `无法连接区块链节点来检查对局状态（链可能已断开）。<br><br>` +
                             `资金安全提示：<br>` +
                             `• 如果资金<b>尚未上链</b>（本地冻结），强制退出不会有任何损失。<br>` +
                             `• 如果资金<b>已在链上锁定</b>，强制退出只能清本地 UI 状态，资金不受影响——<br>` +
                             `　重连链后可以再回来处理（Waiting 阶段可取消 / 超时可强制结算）。<br><br>` +
                             `要<b>强制退出并清本地状态</b>返回大厅吗？`,
                    okText: '强制退出',
                    cancelText: '再等等',
                    onOk: () => _forceCleanLocalState(),
                });
            }
        });

        // 清理本地游戏状态（不调后端 room/leave，不碰链上资金，纯前端兜底）
        function _forceCleanLocalState() {
            stopRoomPolling();
            disconnectP2PChannel();
            stopAllFallbackPolling();
            stopAutoReveal();
            currentRoomId = null;
            currentRoom = null;
            currentGameId = null;
            chainGameIdResolved = false;
            myChainJoined = false;
            try { GameSocket && GameSocket.disconnect && GameSocket.disconnect(); } catch (_) {}
            navigateTo('/');
            UI.showStage('stageLobby');
            loadRoomList();
        }

        // 共享：房间不存在/已解散 Modal（带返回大厅按钮）
        // reason: 'not_found' | 'dissolved' | 'closed' | 'kicked' 等
        function _showRoomGoneModal(reason, details) {
            const titleMap = {
                'not_found': '房间不存在',
                'dissolved': '房间已解散',
                'closed': '房间已关闭',
                'kicked': '被移出房间',
            };
            const title = titleMap[reason] || '房间不可用';
            const detailHtml = details
                ? `<div style="color:#64748b;font-size:13px;margin-top:6px;">${details}</div>`
                : '';
            FWUI.Modal.alert({
                title: title,
                content: `<div style="font-size:14px;line-height:1.7;">该房间已不存在或无法访问。${detailHtml}</div>`,
                okText: '返回游戏大厅',
                onOk: () => {
                    _forceCleanLocalState();
                    navigateTo('/');
                },
            });
        }

        // 🆕 暴露到 window，让外层（handleGameRoute / loadRoomStatus 等）也能访问
        window._showRoomGoneModal = _showRoomGoneModal;
        window._forceCleanLocalState = _forceCleanLocalState;

        // === 安全退出房间（local_frozen 或链上已处理完毕后调用） ===
        async function safeExitRoom(roomId, myAddress) {
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
                                room_id: roomId,
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
                            chainGameIdResolved = false;
                            myChainJoined = false;
                            navigateTo('/');
                            loadRoomList();
                        } else {
                            // 后端拒绝（如资金已上链不允许退出）→ 给强制清理选项
                            const msg = data.message || data.detail || '退出房间失败';
                            FWUI.Modal.confirm({
                                title: '无法安全退出',
                                content: `后端拒绝退出：<br><b>${msg}</b><br><br>` +
                                         `通常意味着链上资金已锁定，需等待对局自然结算或触发超时强制结算。<br>` +
                                         `若链不可用，可以<b>强制清理本地 UI 状态</b>返回大厅——资金安全不受影响。`,
                                okText: '强制清理本地状态',
                                cancelText: '知道了',
                                onOk: () => _forceCleanLocalState(),
                            });
                        }
                    } catch (e) {
                        console.error('退出房间请求失败:', e);
                        // Failed to fetch → 后端/网络不可达
                        FWUI.Modal.confirm({
                            title: '网络请求失败',
                            content: `无法连接后端服务（${e.message || ''}）。<br><br>` +
                                     `可以<b>强制清理本地 UI 状态</b>返回大厅——资金安全取决于链上状态，不受影响。`,
                            okText: '强制清理本地状态',
                            cancelText: '再试一次',
                            onOk: () => _forceCleanLocalState(),
                        });
                    }
                },
            });
        }

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
                            navigateTo('/');
                            UI.showStage('stageLobby');
                            loadRoomList();
                        } else {
                            const msg = data.message || data.detail || '退出房间失败';
                            FWUI.Modal.confirm({
                                title: '无法安全退出',
                                content: `后端拒绝退出：<br><b>${msg}</b><br><br>` +
                                         `可以<b>强制清理本地 UI 状态</b>返回大厅。`,
                                okText: '强制清理本地状态',
                                cancelText: '知道了',
                                onOk: () => _forceCleanLocalState(),
                            });
                        }
                    } catch (e) {
                        console.error('退出房间请求失败:', e);
                        FWUI.Modal.confirm({
                            title: '网络请求失败',
                            content: `无法连接后端服务（${e.message || ''}）。<br><br>` +
                                     `可以<b>强制清理本地 UI 状态</b>返回大厅。`,
                            okText: '强制清理本地状态',
                            cancelText: '再试一次',
                            onOk: () => _forceCleanLocalState(),
                        });
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
                        // ⚠️ 关键：同步 URL，否则 /room/{id}/result 还在 history 里
                        navigateTo(`/room/${currentRoomId}`, { replace: true });
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
                navigateTo('/');
            }
            UI.showStage('stageLobby');
            resetGameState();
            loadRoomList();
        });

        document.getElementById('backHomeBtn').addEventListener('click', async () => {
            stopResultCountdown();
            // 房间模式下：退出房间后返回大厅
            const myAddress = Wallet.getAddress();
            let backendLeaveOk = false;
            if (currentRoomId && myAddress) {
                try {
                    const res = await fetch(`${CONFIG.backendUrl}/api/game/room/leave`, {
                        method: 'POST',
                        headers: {'Content-Type': 'application/json'},
                        body: JSON.stringify({
                            room_id: currentRoomId,
                            player_address: myAddress,
                        }),
                    });
                    const data = await res.json().catch(() => ({}));
                    backendLeaveOk = res.ok && data.success;
                    if (!backendLeaveOk) {
                        // 后端拒绝（可能 room 状态还没同步到 FINISHED）
                        console.warn('[backHomeBtn] 后端 leave 未成功:', data.message || data.detail || res.status);
                    }
                } catch (e) {
                    console.warn('[backHomeBtn] 后端 leave 网络异常:', e.message);
                    // 网络异常时仍继续（最终一致性：后端结算路径会清 player_rooms）
                }
            }
            stopRoomPolling();
            disconnectP2PChannel();
            currentRoomId = null;
            currentRoom = null;
            navigateTo('/');
            UI.showStage('stageLobby');
            resetGameState();
            loadRoomList();
            if (!backendLeaveOk) {
                // 防御性提示：如果后端 leave 失败，可能导致短暂无法创建新房间
                FWUI.Toast.info('已退出房间；如提示"已在其他房间"请稍等几秒后重试');
            }
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

        // F1-06：初始化签名模式（A/B）相关事件监听
        if (typeof Settings !== 'undefined' && Settings && typeof Settings.initSignatureModeEvents === 'function') {
            Settings.initSignatureModeEvents();
        }

        initNetworkDropdown();
    }

    let networkDropdownInitialized = false;

    function initNetworkDropdown() {
        if (networkDropdownInitialized) return;
        networkDropdownInitialized = true;

        // 绑定到 walletBalancesDropdown 内部的网络切换行（不再绑定头像）
        const toggle = document.getElementById('dropdownNetworkToggle');
        const list = document.getElementById('dropdownNetworkList');

        if (toggle && list) {
            toggle.addEventListener('click', (e) => {
                e.stopPropagation();
                if (!Wallet.isConnected()) {
                    FWUI.Toast.warning('请先连接钱包');
                    return;
                }
                populateNetworkDropdown();
                const isHidden = list.classList.contains('hidden');
                list.classList.toggle('hidden');
                toggle.classList.toggle('active', isHidden);
            });

            // 点击 dropdown 外部时自动收起 inline 列表
            document.addEventListener('click', (e) => {
                if (list.classList.contains('hidden')) return;
                if (list.contains(e.target) || toggle.contains(e.target)) return;
                list.classList.add('hidden');
                toggle.classList.remove('active');
            });
        }
    }

    function populateNetworkDropdown() {
        // 渲染到 walletBalancesDropdown 内部的 dropdownNetworkItems
        const container = document.getElementById('dropdownNetworkItems');
        if (!container) return;

        const currentChainId = Wallet.getChainId();
        const networks = CONFIG.networks || {};
        const entries = Object.entries(networks);

        const icons = {
            5208888: '🔧', 137: '🟣', 80002: '🟣',
            8453: '🔵', 42161: '🔵', 56: '🟡',
        };

        container.innerHTML = '';
        entries.forEach(([key, net]) => {
            const chainId = net.chainId;
            const isActive = chainId === currentChainId;
            const icon = icons[chainId] || '🔗';
            const item = document.createElement('div');
            item.className = 'dropdown-network-item' + (isActive ? ' current' : '');
            item.dataset.chainId = chainId;
            item.innerHTML = `
                <span class="dn-icon">${icon}</span>
                <span class="dn-name">${net.name}</span>
                <span class="dn-chainid">#${chainId}</span>
                ${isActive ? '<span class="dn-check">✓</span>' : ''}
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

        // 收起 inline 网络列表
        const list = document.getElementById('dropdownNetworkList');
        const toggle = document.getElementById('dropdownNetworkToggle');
        if (list) list.classList.add('hidden');
        if (toggle) toggle.classList.remove('active');

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
                    setGamePhase('reveal');
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
                // 合约 v1.4.0：超时后自动随机出拳并正常结算（赢方+手续费）
                // TimeoutClaimed 之后会 emit ChoiceRevealed（随机出拳）和 GameSettled（正常结算）
                stopGameTimer();
                FWUI.Toast.info('对局超时，系统将自动随机出拳并结算...');
            }
        });

        Contract.on('DrawHandled', (event, args) => {
            if (currentGameId && Number(event.args.gameId) === currentGameId) {
                stopGameTimer();
                handleDrawSettled(event.args);
            }
        });
    }

    // ==================== 钱包选择下拉面板 ====================

    function toggleWalletPicker() {
        const dd = document.getElementById('walletPickerDropdown');
        if (!dd) return;
        const isHidden = dd.classList.contains('hidden');
        if (isHidden) {
            renderWalletPicker();
            dd.classList.remove('hidden');
            // 点击外部关闭
            setTimeout(() => {
                document.addEventListener('click', closeWalletPickerOnOutside);
            }, 0);
        } else {
            dd.classList.add('hidden');
        }
    }

    function closeWalletPickerOnOutside(e) {
        const picker = document.getElementById('walletConnectPicker');
        if (picker && !picker.contains(e.target)) {
            document.getElementById('walletPickerDropdown')?.classList.add('hidden');
            document.removeEventListener('click', closeWalletPickerOnOutside);
        }
    }

    function renderWalletPicker() {
        const listEl = document.getElementById('walletPickerList');
        const emptyEl = document.getElementById('walletPickerEmpty');
        if (!listEl) return;

        const wallets = Wallet.getAvailableWallets().filter(w => w.id !== 'debug');

        if (wallets.length === 0) {
            listEl.innerHTML = '';
            emptyEl.style.display = 'block';
            return;
        }
        emptyEl.style.display = 'none';

        listEl.innerHTML = wallets.map(w => `
            <div class="wp-item" data-type="${w.id}" style="padding:10px 12px;border-radius:8px;cursor:pointer;display:flex;align-items:center;gap:12px;transition:background 0.12s;" onmouseover="this.style.background='rgba(var(--primary-rgb,59,130,246),0.08)'" onmouseout="this.style.background=''">
                <span style="font-size:20px;">${w.icon}</span>
                <div style="flex:1;min-width:0;">
                    <div style="font-weight:500;font-size:14px;">${w.name}</div>
                    <div style="font-size:11px;color:#888;">${walletTypeDesc(w.id)}</div>
                </div>
                <span style="color:var(--primary-color, #3b82f6);font-size:12px;">连接 →</span>
            </div>
        `).join('');

        listEl.querySelectorAll('.wp-item').forEach(el => {
            el.addEventListener('click', (e) => {
                e.stopPropagation();
                document.getElementById('walletPickerDropdown')?.classList.add('hidden');
                document.removeEventListener('click', closeWalletPickerOnOutside);
                connectWallet(el.dataset.type);
            });
        });
    }

    function walletTypeDesc(id) {
        const map = {
            metamask: '浏览器扩展 · 最流行',
            okx: 'OKX Wallet · 官方插件',
            trust: 'Trust Wallet',
            coinbase: 'Coinbase Wallet',
            injected: '检测到的钱包扩展'
        };
        return map[id] || '浏览器钱包扩展';
    }

    // 连接指定类型的钱包
    async function connectWallet(walletType) {
        try {
            isManualConnect = true;
            await Wallet.connect(walletType);
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
            let mainChainId = null;
            let mainChainConfig = null;
            try {
                mainChainConfig = await fetchMainChainConfig();
                if (mainChainConfig && mainChainConfig.chain_id) {
                    mainChainId = mainChainConfig.chain_id;

                    if (chainId !== mainChainId) {
                        needsChainSwitch = true;
                    }

                    if (mainChainConfig.contract_address) {
                        CONFIG.setContractAddress(mainChainConfig.contract_address);
                    }
                    if (mainChainConfig.settlement_token && mainChainConfig.settlement_token.address) {
                        CONFIG.setSettlementTokenAddress(mainChainConfig.settlement_token.address);
                        currentToken = CONFIG.getDefaultToken();
                        UI.showTokenSelect(currentToken);
                    }
                    updateDropdownTokenInfo();
                }
            } catch (e) {
                console.warn('获取主链配置失败:', e);
            }

            Wallet._needsChainSwitch = needsChainSwitch;
            Wallet._targetChainId = mainChainId;

            // === 核心：链不对时弹窗让用户确认切换 ===
            if (needsChainSwitch && !isSwitchingChain) {
                const currentNet = getNetworkNameByChainId(chainId);
                const targetNet = mainChainConfig?.network_name || 'ChainRPS Local';
                const doSwitch = await new Promise(resolve => {
                    FWUI.Modal.confirm({
                        title: '⚠️ 需要切换网络',
                        content: `
                            <div style="line-height:1.9;font-size:14px;">
                                <p>你当前钱包在 <b style="color:#e74c3c;">${currentNet}</b>。</p>
                                <p>ChainRPS 运行在 <b style="color:#27ae60;">${targetNet}</b>（本地 Ganache 测试网）。</p>
                                <p style="color:#888;font-size:12px;margin-top:8px;">点击"切换"会让你的钱包弹出切换请求，确认后余额会显示测试网的测试币。</p>
                            </div>
                        `,
                        okText: '切换网络',
                        cancelText: '保持当前',
                        onOk: () => resolve(true),
                        onCancel: () => resolve(false)
                    });
                });

                if (doSwitch) {
                    try {
                        isSwitchingChain = true;
                        const switched = await Wallet.switchOrAddChain({
                            chainId: mainChainId,
                            chainName: targetNet,
                            rpcUrls: [mainChainConfig?.rpc_url || CONFIG.getLocalRpcUrl()],
                            nativeCurrency: mainChainConfig?.native_currency || { name: 'Polygon', symbol: 'POL', decimals: 18 },
                        });
                        isSwitchingChain = false;
                        if (switched) {
                            FWUI.Toast.success('✅ 已切换，正在刷新...');
                            // 等 chainChanged 事件自动重新跑 handleWalletConnected — 直接 return
                            return;
                        } else {
                            FWUI.Toast.warning('请在钱包中确认切换，或在钱包设置里手动添加网络');
                        }
                    } catch (e) {
                        isSwitchingChain = false;
                        FWUI.Toast.error('切换失败: ' + (e.message || e).substring(0, 100));
                    }
                } else {
                    FWUI.Toast.info('你可以稍后在创建房间时再切换');
                }
            }

            initContract();
            updateBalanceDisplay();
            refreshDripButtonState();  // 同步领币按钮状态
            try {
                const usdcBal = parseFloat(await Wallet.getBalance(CONFIG.getSettlementTokenAddress()));
                const ethBal = parseFloat(await Wallet.getBalance('0x0000000000000000000000000000000000000000'));
                if (usdcBal < 100 || ethBal < 0.1) {
                    FWUI.Toast.info('💡 测试币不足？点大厅顶部 "💸 领测试币" 每天领 3000 USDC');
                }
            } catch (e) {
                console.warn('余额检查失败:', e);
            }

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
                // 二次验证：房间状态是否真的有效（排除已关闭/已取消的脏记录）
                try {
                    const detailResp = await fetch(`${CONFIG.backendUrl}/api/game/room/${room.room_id}`);
                    const detailData = await detailResp.json();
                    if (!detailData.success || detailData.status === 'closed' || detailData.fund_stage === 'cancelled') {
                        console.log('[Restore] 房间已失效，跳过自动进入:', room.room_id);
                        return;
                    }
                } catch (e) {
                    console.warn('[Restore] 验证房间失败:', e.message);
                    // 验证接口失败时保守进入（避免误踢有效玩家）
                }

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
        navigateTo('/');
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

    // 更新钱包余额显示（同时获取原生币和结算币余额）
    async function updateBalanceDisplay() {
        if (!Wallet.isConnected()) return;

        try {
            // 获取当前选中代币的余额（用于主显示）
            const tokenAddress = CONFIG.getTokenAddresses()[currentToken];
            console.info('[updateBalanceDisplay] currentToken=', currentToken, 'tokenAddress=', tokenAddress, 'CONFIG._settlementTokenAddress=', CONFIG._settlementTokenAddress, 'CONFIG.getCurrentNetwork()=', CONFIG.getCurrentNetwork()?.name);
            const balance = await Wallet.getBalance(tokenAddress);
            UI.updateWalletInfo(Wallet.getAddress(), balance, currentToken);

            // 同时获取所有代币余额（用于点击展开详情）
            const balances = {};
            const nativeSymbol = CONFIG.getNativeSymbol();
            const nativeAddr = CONFIG.getTokenAddresses()[nativeSymbol];
            const usdcAddr = CONFIG.getSettlementTokenAddress();

            // 原生币余额
            try {
                balances[nativeSymbol] = await Wallet.getBalance(nativeAddr);
            } catch (e) {
                balances[nativeSymbol] = '0';
            }

            // USDC 余额
            if (usdcAddr) {
                try {
                    balances['USDC'] = await Wallet.getBalance(usdcAddr);
                } catch (e) {
                    balances['USDC'] = '0';
                }
            }

            UI.updateWalletBalances(Wallet.getAddress(), balances);
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
        UI.showStage('stageLobby');
        UI.setRoomListView(UI.getPreferredRoomListView());
        loadRoomList();
        connectLobbySocket();
        startLobbyRefresh();
    }

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
    async function connectLobbySocket() {
        if (!CONFIG.wsUrl || isPurePrivateMode()) return;

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
            await GameSocket.connect(CONFIG.wsUrl, address);
        } else {
            // 已连接，直接注册事件
            registerLobbyListeners();
        }
    }

    // 注册大厅事件监听器
    let _pendingRoomRefreshTimer = null;
    function registerLobbyListeners() {
        if (!lobbyWsConnected) {
            lobbyWsConnected = true;

            // 房间列表变更：300ms 防抖合并，避免短时间多事件触发多次 HTTP 请求
            GameSocket.on('room_list_changed', (data) => {
                const lobby = document.getElementById('stageLobby');
                if (!lobby || lobby.classList.contains('hidden')) return;
                if (_pendingRoomRefreshTimer) clearTimeout(_pendingRoomRefreshTimer);
                _pendingRoomRefreshTimer = setTimeout(() => {
                    _pendingRoomRefreshTimer = null;
                    loadRoomList();
                }, 300);
            });
        }
    }

    // 房间分页状态
    let roomPage = 1;
    let roomPerPage = parseInt(localStorage.getItem('rps_room_per_page') || '10', 10);

    // 挂到 window 供 UI.renderRoomPagination 回调
    window.setRoomPage = function(p) {
        roomPage = Math.max(1, p);
        loadRoomList();
    };
    window.setRoomPerPage = function(n) {
        roomPerPage = Math.max(1, Math.min(100, n));
        localStorage.setItem('rps_room_per_page', String(roomPerPage));
        roomPage = 1;  // 重置到第一页
        loadRoomList();
    };

    // perPage 下拉事件绑定（DOM ready 后执行一次）
    document.addEventListener('DOMContentLoaded', () => {
        const sel = document.getElementById('perPageSelect');
        if (sel) {
            sel.value = String(roomPerPage);
            sel.addEventListener('change', (e) => {
                window.setRoomPerPage(parseInt(e.target.value, 10));
            });
        }
    });

    // 加载房间列表
    function loadRoomList() {
        if (!CONFIG.backendUrl) return;

        if (roomListLoading) {
            if (roomListTimeout) clearTimeout(roomListTimeout);
            roomListTimeout = setTimeout(loadRoomList, 100);
            return;
        }

        roomListLoading = true;

        // 用后端分页
        const params = new URLSearchParams({
            page: roomPage,
            per_page: roomPerPage,
        });

        fetch(`${CONFIG.backendUrl}/api/game/room/list?${params}`)
            .then(response => response.json())
            .then(data => {
                UI.renderRoomList(data.rooms || [], {
                    page: roomPage,
                    perPage: roomPerPage,
                    total: data.total || 0,
                });
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

            // 获取代币地址信息
            const tokenAddresses = CONFIG.getTokenAddresses();
            const getTokenAddressInfo = (symbol) => {
                const addr = tokenAddresses[symbol] || '';
                const decimals = symbol === CONFIG.getNativeSymbol() ? 18 : 6;
                const isNative = CONFIG.isNativeToken(addr);
                return { address: addr, decimals, isNative };
            };

            const modal = FWUI.Modal.create({
                title: '➕ 创建房间',
                closable: true,
                maskClosable: true,
                content: () => {
                    const tokenOptions = CONFIG.getGameTokenOptions();
                    const initialInfo = getTokenAddressInfo(selectedToken);
                    return `
                        <div style="margin-bottom: 16px;">
                            <div style="font-size: 14px; font-weight: 600; color: var(--text-heading); margin-bottom: 10px;">选择代币</div>
                            <div style="display: flex; gap: 8px;">
                                ${tokenOptions.map(t => `
                                    <button class="dialog-token-btn" data-token="${t}" style="
                                        flex: 1;
                                        padding: 10px;
                                        border: 1px solid ${t === selectedToken ? 'var(--primary-color)' : 'var(--card-border)'};
                                        border-radius: 10px;
                                        background: ${t === selectedToken ? 'var(--primary-color)' : 'var(--card-bg)'};
                                        color: ${t === selectedToken ? 'var(--text-inverse)' : 'var(--text-heading)'};
                                        cursor: pointer;
                                        font-size: 14px;
                                        font-weight: 500;
                                        transition: all var(--transition-fast);
                                    ">${t}</button>
                                `).join('')}
                            </div>
                        </div>
                        <div id="dialogTokenInfo" style="
                            margin-bottom: 16px;
                            padding: 10px 12px;
                            background: var(--bg-secondary);
                            border: 1px solid var(--card-border);
                            border-radius: 10px;
                            font-size: 12px;
                            line-height: 1.8;
                        ">
                            <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 4px;">
                                <span style="font-weight: 600; color: var(--text-heading);">代币信息</span>
                                <button id="dialogAddToWallet" style="
                                    padding: 3px 10px;
                                    font-size: 11px;
                                    background: var(--primary-color);
                                    color: var(--text-inverse);
                                    border: none;
                                    border-radius: 6px;
                                    cursor: pointer;
                                ">+ 添加到钱包</button>
                            </div>
                            <div>符号: <b>${selectedToken}</b></div>
                            <div>合约地址: <code id="dialogTokenAddress" style="font-size: 11px; color: var(--primary-color); cursor: pointer;" title="点击复制">${initialInfo.isNative ? '原生币 (零地址)' : initialInfo.address}</code></div>
                            <div>Decimals: ${initialInfo.decimals}</div>
                        </div>
                        <div style="margin-bottom: 12px;">
                            <div style="display:flex; align-items:center; justify-content:space-between; margin-bottom:10px;">
                                <span style="font-size:14px; font-weight:600; color:var(--text-heading);">下注金额</span>
                                <span style="font-size:11px; color:var(--text-label);">可用余额: <b id="dialogBalanceText" class="number-mono">--</b> ${selectedToken}</span>
                            </div>
                            <div style="position:relative;">
                                <input id="dialogAmountInput" type="number" value="${selectedAmount}" min="1" step="any" placeholder="输入金额" style="
                                    width:100%; padding:12px 90px 12px 14px;
                                    border:1px solid var(--card-border);
                                    border-radius:var(--radius-md);
                                    font-size:15px; font-weight:600;
                                    color:var(--text-heading);
                                    background:var(--bg-secondary);
                                    box-sizing:border-box; outline:none;
                                    font-family:JetBrains Mono, Consolas, monospace;
                                    transition:all var(--transition-fast);
                                " data-input-focus-outline="3px solid rgba(var(--primary-rgb),0.15)" data-input-focus-border="var(--primary-color)" />
                                <!-- MAX 按钮（绝对定位到 input 内部右侧） -->
                                <button id="dialogMaxBtn" type="button" style="
                                    position:absolute; right:8px; top:50%; transform:translateY(-50%);
                                    padding:4px 10px; font-size:11px; font-weight:700;
                                    background:rgba(var(--primary-rgb),0.1); color:var(--primary-color);
                                    border:none; border-radius:6px; cursor:pointer;
                                    transition:all var(--transition-fast);
                                ">MAX</button>
                            </div>
                            <!-- 百分比快速下注按钮（E-04） -->
                            <div id="dialogPctBar" style="display:flex; gap:4px; margin-top:8px;">
                                <button class="dialog-pct-btn" data-pct="25" type="button">25%</button>
                                <button class="dialog-pct-btn" data-pct="50" type="button">50%</button>
                                <button class="dialog-pct-btn" data-pct="75" type="button">75%</button>
                                <button class="dialog-pct-btn" data-pct="100" type="button">100%</button>
                                <button class="dialog-pct-btn" data-pct="custom" type="button" style="margin-left:auto;">自定义</button>
                            </div>
                            <!-- 四角信息：法币等值 + 赔率影响（E-01） -->
                            <div id="dialogAmountInfo" style="
                                margin-top:8px; padding:8px 12px;
                                background:var(--bg-secondary); border-radius:8px;
                                font-size:12px; color:var(--text-body);
                                border:1px solid var(--card-border);
                                display:none;
                            ">
                                <div style="display:flex; justify-content:space-between;">
                                    <span>≈ 法币等值</span>
                                    <span id="dialogFiatEstimate" class="number-mono" style="color:var(--text-label);">--</span>
                                </div>
                                <div style="display:flex; justify-content:space-between; margin-top:4px;">
                                    <span>预期赔率</span>
                                    <span id="dialogOddsEstimate" class="number-mono" style="color:var(--primary-color); font-weight:600;">2.00x</span>
                                </div>
                            </div>
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
                        border: 1px solid var(--card-border);
                        background: var(--card-bg);
                        color: var(--text-heading);
                    ">取消</button>
                    <button class="fwui-btn fwui-btn-primary" data-action="confirm" style="
                        padding: 8px 20px;
                        border-radius: 10px;
                        font-size: 14px;
                        font-weight: 500;
                        cursor: pointer;
                        border: none;
                        background: var(--primary-color);
                        color: var(--text-inverse);
                    ">创建房间</button>
                `
            });

            // 更新代币信息显示
            const updateTokenInfo = () => {
                const info = getTokenAddressInfo(selectedToken);
                const addrEl = modal.element.querySelector('#dialogTokenAddress');
                if (addrEl) {
                    addrEl.textContent = info.isNative ? '原生币 (零地址)' : info.address;
                    addrEl.onclick = () => {
                        if (!info.isNative) {
                            navigator.clipboard.writeText(info.address).then(() => {
                                FWUI.Toast.success('已复制合约地址');
                            }).catch(() => {
                                FWUI.Toast.info('地址: ' + info.address);
                            });
                        }
                    };
                }
            };

            // 添加到钱包按钮
            const addToWalletBtn = modal.element.querySelector('#dialogAddToWallet');
            if (addToWalletBtn) {
                addToWalletBtn.addEventListener('click', async () => {
                    if (!window.ethereum) {
                        FWUI.Toast.warning('未检测到钱包插件');
                        return;
                    }
                    const info = getTokenAddressInfo(selectedToken);
                    if (info.isNative) {
                        // 原生币：只需切换网络
                        FWUI.Modal.confirm({
                            title: '添加原生币到钱包',
                            content: `<p><b>${selectedToken}</b> 是链的原生代币，只需添加/切换网络即可自动显示。</p>
                                <p style="margin-top:8px;color:#64748b;font-size:12px;">Network: ${CONFIG.getCurrentNetwork().name} | RPC: ${CONFIG.getRpcUrl()}</p>`,
                            okText: '切换网络',
                            onOk: async () => {
                                try {
                                    const chainId = CONFIG.RPC_CHAIN_ID;  // 固定游戏链！不是 getChainId() 动态值
                                    const hexChainId = '0x' + chainId.toString(16);
                                    await window.ethereum.request({
                                        method: 'wallet_switchEthereumChain',
                                        params: [{chainId: hexChainId}],
                                    });
                                    FWUI.Toast.success('已切换网络');
                                } catch (e) {
                                    FWUI.Toast.warning('请在钱包中手动添加网络');
                                }
                            }
                        });
                    } else {
                        // ERC20 代币：使用 wallet_watchAsset
                        try {
                            await window.ethereum.request({
                                method: 'wallet_watchAsset',
                                params: [{
                                    type: 'ERC20',
                                    options: {
                                        address: info.address,
                                        symbol: selectedToken,
                                        decimals: info.decimals,
                                    },
                                }]
                            });
                            FWUI.Toast.success(`${selectedToken} 已添加到钱包`);
                        } catch (e) {
                            FWUI.Modal.alert({
                                title: '手动添加代币',
                                content: `<p>请在钱包中手动添加：</p>
                                    <div style="background:#f8fafc;padding:10px;border-radius:6px;font-family:monospace;font-size:12px;margin-top:8px;">
                                        <div>Symbol: ${selectedToken}</div>
                                        <div>Address: ${info.address}</div>
                                        <div>Decimals: ${info.decimals}</div>
                                    </div>
                                    <p style="margin-top:8px;color:#64748b;font-size:11px;">路径：钱包 → 资产 → 添加自定义代币</p>`
                            });
                        }
                    }
                });
            }

            // 代币选择
            modal.element.querySelectorAll('.dialog-token-btn').forEach(btn => {
                btn.addEventListener('click', () => {
                    selectedToken = btn.dataset.token;
                    modal.element.querySelectorAll('.dialog-token-btn').forEach(b => {
                        const isActive = b.dataset.token === selectedToken;
                        b.style.borderColor = isActive ? 'var(--primary-color)' : 'var(--card-border)';
                        b.style.background = isActive ? 'var(--primary-color)' : 'var(--card-bg)';
                        b.style.color = isActive ? 'var(--text-inverse)' : 'var(--text-heading)';
                    });
                    updateTokenInfo();
                });
            });

            // ============ 初始余额加载 ============
            let walletBalance = 0;
            const balanceText = modal.element.querySelector('#dialogBalanceText');
            const amountInfoEl = modal.element.querySelector('#dialogAmountInfo');
            const fiatEl = modal.element.querySelector('#dialogFiatEstimate');
            const oddsEl = modal.element.querySelector('#dialogOddsEstimate');

            async function refreshBalance() {
                if (!Wallet.isConnected()) {
                    if (balanceText) balanceText.textContent = '未连接';
                    return 0;
                }
                try {
                    const info = getTokenAddressInfo(selectedToken);
                    const bal = await Wallet.getBalance(info.isNative ? null : info.address);
                    walletBalance = parseFloat(bal) || 0;
                    if (balanceText) balanceText.textContent = walletBalance.toFixed(2);
                    return walletBalance;
                } catch {
                    if (balanceText) balanceText.textContent = '--';
                    return 0;
                }
            }
            refreshBalance();

            // ============ 动态更新法币等值 + 赔率（E-01） ============
            function updateAmountInfo() {
                const amt = parseFloat(selectedAmount) || 0;
                if (amt > 0) {
                    if (amountInfoEl) amountInfoEl.style.display = 'block';
                    // 法币等值：简化版 — 1 USDC ≈ $1，其他走 CONFIG 或固定估算
                    let fiat;
                    if (selectedToken === 'USDC') fiat = `$${amt.toFixed(2)}`;
                    else if (selectedToken === 'ETH') fiat = `$${(amt * 3000).toFixed(0)}`;
                    else fiat = `${amt} ${selectedToken}`;
                    if (fiatEl) fiatEl.textContent = fiat;
                    // 赔率：简化 — 双方下注 1:1 所以 2.0x，未来可以更精确
                    if (oddsEl) oddsEl.textContent = '2.00x';
                } else {
                    if (amountInfoEl) amountInfoEl.style.display = 'none';
                }
            }

            // ============ MAX + 百分比按钮（E-04） ============
            const maxBtn = modal.element.querySelector('#dialogMaxBtn');
            if (maxBtn) {
                maxBtn.addEventListener('click', async () => {
                    await refreshBalance();
                    const max = Math.max(0, walletBalance - 0.01); // 留 0.01 gas 余量
                    selectedAmount = parseFloat(max.toFixed(4));
                    if (amountInput) { amountInput.value = selectedAmount; amountInput.focus(); }
                    updateAmountInfo();
                });
            }
            modal.element.querySelectorAll('.dialog-pct-btn').forEach((btn) => {
                btn.style.cssText = `
                    padding:3px 10px; font-size:11px; font-weight:600;
                    border:1px solid var(--card-border); background:none;
                    color:var(--text-label); border-radius:6px; cursor:pointer;
                    transition:all var(--transition-fast);
                `;
                btn.addEventListener('mouseenter', () => {
                    btn.style.borderColor = 'var(--primary-color)';
                    btn.style.color = 'var(--primary-color)';
                });
                btn.addEventListener('mouseleave', () => {
                    btn.style.borderColor = 'var(--card-border)';
                    btn.style.color = 'var(--text-label)';
                });
                btn.addEventListener('click', async () => {
                    const pct = btn.dataset.pct;
                    if (pct === 'custom') {
                        amountInput && amountInput.focus();
                        return;
                    }
                    await refreshBalance();
                    const amt = parseFloat((walletBalance * parseInt(pct) / 100).toFixed(4));
                    selectedAmount = amt;
                    if (amountInput) amountInput.value = amt;
                    updateAmountInfo();
                });
            });

            // ============ 手动输入金额 ============
            const amountInput = modal.element.querySelector('#dialogAmountInput');
            if (amountInput) {
                amountInput.addEventListener('input', () => {
                    selectedAmount = parseFloat(amountInput.value) || 0;
                    updateAmountInfo();
                });
                // 聚焦 outline（用 data 属性，不用写死）
                amountInput.addEventListener('focus', () => {
                    amountInput.style.outline = amountInput.dataset.inputFocusOutline;
                    amountInput.style.borderColor = amountInput.dataset.inputFocusBorder;
                });
                amountInput.addEventListener('blur', () => {
                    amountInput.style.outline = 'none';
                    amountInput.style.borderColor = '';
                });
            }

            // ============ 确认/取消（E-02 余额检测 + 错误内嵌按钮） ============
            const confirmBtn = modal.element.querySelector('[data-action="confirm"]');
            confirmBtn.addEventListener('click', async () => {
                if (!selectedAmount || selectedAmount <= 0) {
                    FWUI.Toast.warning('请输入有效的下注金额');
                    return;
                }
                // 余额检测
                if (walletBalance === 0) await refreshBalance();
                if (selectedAmount > walletBalance) {
                    const need = selectedAmount - walletBalance;
                    FWUI.Toast.error(`⚠️ 余额不足 · 还需 ${need.toFixed(2)} ${selectedToken}`);
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

    // 统一检查：钱包是否在游戏链上（不在则弹窗提示切换）
    // 返回 true = 可以继续操作；false = 用户取消 / 正在切换中
    async function ensureOnGameChain(actionName = '执行此操作') {
        if (!Wallet.isConnected()) return true;  // 未连接让其他逻辑处理

        const currentChainId = Wallet.getChainId();
        const targetChainId = CONFIG.RPC_CHAIN_ID;  // ← 固定游戏链 5208888！之前 CONFIG.getChainId() 会返回钱包当前链 ❌
        if (currentChainId === targetChainId) return true;  // 已经在游戏链

        const currentNet = getNetworkNameByChainId(currentChainId);
        const targetNet = CONFIG.networks?.localhost?.name || 'ChainRPS Local';

        return await new Promise((resolve) => {
            FWUI.Modal.confirm({
                title: '需要切换网络',
                content: `
                    <div style="line-height:1.8;font-size:14px;">
                        <p>你当前在 <b>${currentNet}</b> (Chain ID: ${currentChainId})。</p>
                        <p>ChainRPS 游戏运行在 <b>${targetNet}</b> (Chain ID: ${targetChainId})。</p>
                        <p style="color:#888;margin-top:6px;font-size:12px;">点击"切换网络"会让钱包弹出切换确认框，确认后即可继续。</p>
                    </div>
                `,
                okText: '切换网络',
                cancelText: '暂不切换',
                onOk: async () => {
                    try {
                        const mainChainConfig = await fetchMainChainConfig();
                        const switched = await Wallet.switchOrAddChain({
                            chainId: mainChainConfig?.chain_id || targetChainId,
                            chainName: mainChainConfig?.network_name || targetNet,
                            rpcUrls: [mainChainConfig?.rpc_url || CONFIG.getLocalRpcUrl()],
                            nativeCurrency: mainChainConfig?.native_currency || { name: 'Polygon', symbol: 'POL', decimals: 18 },
                        });
                        if (switched) {
                            FWUI.Toast.success('✅ 已切换到游戏网络，请再次点击操作');
                        } else {
                            FWUI.Toast.warning('请在钱包中确认切换');
                        }
                        resolve(false);  // 让用户重新点击
                    } catch (e) {
                        FWUI.Toast.error('切换失败: ' + (e.message || e));
                        resolve(false);
                    }
                },
                onCancel: () => resolve(false)
            });
        });
    }

    // 创建房间
    async function createRoom() {
        if (!Wallet.isConnected()) {
            FWUI.Toast.warning('请先连接钱包');
            return;
        }

        // 检查链（用户可能在主网/Polygon）
        if (!(await ensureOnGameChain('创建房间'))) return;

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
                        // 房间不存在 → Modal 提示 + 返回大厅
                        _showRoomGoneModal('not_found', errorMsg);
                        // 同时重置加入框
                        okBtn.disabled = false;
                        okBtn.textContent = '加入';
                        input.focus();
                    } else {
                        FWUI.Toast.error(errorMsg);
                        okBtn.disabled = false;
                        okBtn.textContent = '加入';
                        input.focus();
                    }
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

        // 检查链（用户可能在主网/Polygon）
        if (!(await ensureOnGameChain('加入房间'))) return;

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
                _showRoomGoneModal('not_found', data.message || '房间不存在');
            }
        } catch (e) {
            FWUI.Toast.error(e.message || '获取房间信息失败');
        }
    }

    // ==================== 空位管理（集成在对手头像框中） ====================

    let seatMenuBound = false;

    function initSeatMenu() {
        if (seatMenuBound) return;
        seatMenuBound = true;

        const seatBtn = document.getElementById('seatAvatarBtn');
        const menu = document.getElementById('seatMenu');
        if (!seatBtn || !menu) return;

        seatBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            // 仅房主可打开菜单
            if (!currentRoom || !Wallet.getAddress()) return;
            const amICreator = currentRoom.creator
                && currentRoom.creator.toLowerCase() === Wallet.getAddress().toLowerCase();
            if (!amICreator) return;
            if (currentRoom.status === 'game_started') return;
            menu.classList.toggle('hidden');
        });

        menu.addEventListener('click', (e) => {
            const item = e.target.closest('[data-seat-action]');
            if (!item || item.classList.contains('hidden')) return;
            e.stopPropagation();
            handleSeatAction(item.dataset.seatAction);
        });

        // 点击页面其他区域收起菜单
        document.addEventListener('click', (e) => {
            if (menu.classList.contains('hidden')) return;
            if (menu.contains(e.target) || seatBtn.contains(e.target)) return;
            menu.classList.add('hidden');
        });
    }

    function closeSeatMenu() {
        const menu = document.getElementById('seatMenu');
        if (menu) menu.classList.add('hidden');
    }

    async function handleSeatAction(action) {
        if (action === 'open') {
            closeSeatMenu();
            await setSeatMode('open');
        } else if (action === 'ai') {
            closeSeatMenu();
            await setSeatMode('ai');
        } else if (action === 'invite') {
            closeSeatMenu();
            copyInviteLink();
        } else if (action === 'kick') {
            closeSeatMenu();
            confirmKickOpponent();
        }
    }

    // 复制邀请链接（朋友打开即可进入房间）
    function copyInviteLink() {
        if (!currentRoomId) return;
        const url = `${window.location.origin}/room/${currentRoomId}`;
        const done = () => FWUI.Toast.success('邀请链接已复制，发给朋友即可加入房间');
        if (navigator.clipboard && navigator.clipboard.writeText) {
            navigator.clipboard.writeText(url).then(done).catch(() => fallbackCopy(url, done));
        } else {
            fallbackCopy(url, done);
        }
    }

    function fallbackCopy(text, onDone) {
        try {
            const ta = document.createElement('textarea');
            ta.value = text;
            ta.style.position = 'fixed';
            ta.style.opacity = '0';
            document.body.appendChild(ta);
            ta.select();
            document.execCommand('copy');
            document.body.removeChild(ta);
            onDone && onDone();
        } catch (e) {
            FWUI.Toast.error('复制失败，请手动复制房间链接');
        }
    }

    // 房主确认移出对手
    function confirmKickOpponent() {
        if (!currentRoom || !currentRoom.player2) return;
        const isBot = !!currentRoom.player2_is_bot;
        FWUI.Modal.confirm({
            title: '移出对手？',
            content: isBot
                ? '确定将 AI 移出房间吗？空位将重新开放。'
                : `确定将 ${UI.formatAddress(currentRoom.player2)} 移出房间吗？空位将重新开放。`,
            okText: '移出',
            cancelText: '取消',
            onOk: () => kickOpponent(),
        });
    }

    async function kickOpponent() {
        if (!currentRoomId) return;
        const myAddress = Wallet.getAddress();
        if (!myAddress) {
            FWUI.Toast.warning('请先连接钱包');
            return;
        }
        try {
            const res = await fetch(`${CONFIG.backendUrl}/api/game/room/kick`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    room_id: currentRoomId,
                    creator_address: myAddress,
                }),
            });
            const data = await res.json();
            if (res.ok && data.success) {
                FWUI.Toast.success(data.message || '已将对手移出房间');
                await loadRoomStatus();
                loadRoomList();
            } else {
                FWUI.Toast.error(data.message || data.detail || '移出失败');
            }
        } catch (e) {
            console.error('移出对手失败:', e);
            FWUI.Toast.error('网络错误，请重试');
        }
    }

    // 设置房间空位模式（open 开放空位 / ai 邀请 AI）
    async function setSeatMode(mode) {
        if (!currentRoomId) return;
        const myAddress = Wallet.getAddress();
        if (!myAddress) {
            FWUI.Toast.warning('请先连接钱包');
            return;
        }

        try {
            const response = await fetch(`${CONFIG.backendUrl}/api/game/room/seat-mode`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    room_id: currentRoomId,
                    creator_address: myAddress,
                    seat_mode: mode,
                }),
            });

            const data = await response.json();

            if (response.ok && data.success) {
                FWUI.Toast.success(mode === 'ai' ? '已邀请 AI，等待加入...' : '空位已对玩家开放');
                // 立即刷新房间状态（AI 加入由后端 WS/轮询同步）
                loadRoomStatus();
            } else {
                FWUI.Toast.error(data.message || '设置失败');
            }
        } catch (err) {
            console.error('设置空位模式失败:', err);
            FWUI.Toast.error('网络错误，请重试');
        }
    }

    // 离开房间（右上角关闭图标入口）
    async function leaveRoom() {
        if (!currentRoomId) {
            navigateTo('/');
            UI.showStage('stageLobby');
            return;
        }

        const myAddress = Wallet.getAddress();
        if (!myAddress) {
            stopRoomPolling();
            currentRoomId = null;
            currentRoom = null;
            navigateTo('/');
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
                closeSeatMenu();
                currentRoomId = null;
                currentRoom = null;
                navigateTo('/');
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

    // 房主"开始游戏"按钮：未准备→先准备；已准备等待对方→催促；双方就绪后后端自动倒计时
    let lastNudgeTs = 0;

    function onRoomPrimaryAction() {
        if (!currentRoom) return;
        const myAddress = Wallet.getAddress();
        if (!myAddress) return;

        const amICreator = currentRoom.creator
            && currentRoom.creator.toLowerCase() === myAddress.toLowerCase();

        // 加入者：准备 / 取消准备
        if (!amICreator) {
            toggleReady();
            return;
        }

        // 房主：开始游戏
        const status = currentRoom.status;
        if (status === 'countdown' || status === 'game_started') return;
        if (!currentRoom.player2) {
            FWUI.Toast.info('等待对手加入后才能开始游戏');
            return;
        }
        if (!currentRoom.creator_ready) {
            // 房主先准备；若对方也已准备，后端会立即开始倒计时
            toggleReady();
            return;
        }
        if (!currentRoom.player2_ready) {
            // 房主已准备，催促对方尽快准备
            const now = Date.now();
            if (now - lastNudgeTs < 5000) {
                FWUI.Toast.info('已提醒过对方，请稍候');
                return;
            }
            lastNudgeTs = now;
            const sent = sendPeerNotify('nudge_ready', { room_id: currentRoomId });
            FWUI.Toast.info(sent ? '已提醒对方尽快准备' : '正在等待对方连接...');
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

                // 🆕 提前批准代币授权（ready 后立刻后台执行，不等 Bot createMatch）
                // 这样 Bot createMatch 时玩家已 approve 好，只需要 joinMatch 一次签名
                // 如果玩家还没解决钱包残留队列，approve 会弹 Modal 指引，不阻塞 UI
                if (myReady) {
                    _preApproveAfterReady();
                }
            } else {
                FWUI.Toast.error(data.detail || data.message || '操作失败');
            }
        } catch (e) {
            FWUI.Toast.error(e.message || '操作失败');
        }
    }

    // 🆕 ready 后后台提前 approve（不阻塞 UI，让 Bot createMatch 时玩家已 approve）
    let _preApprovePromise = null; // 防止重复调用
    async function _preApproveAfterReady() {
        if (_preApprovePromise) return _preApprovePromise;
        if (!currentRoom || !Wallet.isConnected()) return;

        const tokenAddress = CONFIG.getTokenAddresses()[currentRoom.token];
        const isNativeETH = !tokenAddress || tokenAddress === '0x0000000000000000000000000000000000000000';
        if (isNativeETH) return; // ETH 原生代币不需要 approve

        const betAmount = Number(currentRoom.bet_amount || 0);
        const myAddress = Wallet.getAddress();

        _preApprovePromise = (async () => {
            try {
                console.log('[Pre-Approve] ready 后后台提前授权，token=', currentRoom.token, 'amount=', betAmount);
                await Contract.ensureAllowance(tokenAddress, betAmount, myAddress, approveOpts());
                console.log('[Pre-Approve] 提前授权完成 ✅');
                FWUI.Toast.success('✅ 代币已授权，后续对局无需再次确认');
            } catch (e) {
                // approve 失败（比如钱包残留队列）不阻塞游戏
                // 后续 Bot createMatch 时 handleChainGameCreated 会再触发 approve
                console.warn('[Pre-Approve] 提前授权失败（后续 joinMatch 时会再尝试）:', e.message);
                if (!(e && e._modalShown)) {
                    FWUI.Toast.info('代币授权待处理，后续加入时会提示您');
                }
            } finally {
                // 等 2 秒后重置，允许下次 ready 再调用（但有缓存，不会真的重复 approve）
                setTimeout(() => { _preApprovePromise = null; }, 2000);
            }
        })();
        return _preApprovePromise;
    }

    // 进入房间等待界面
    async function enterRoomWait() {
        UI.showStage('stageRoomWait');
        // 初始加载一次房间状态
        await loadRoomStatus();
        updateRoomUI();
        connectRoomSocket();
        // === 关键修复：推迟 P2P WebRTC 连接 ===
        // 原代码立即调用 connectP2PChannel()，WebRTC 握手（ICE/信令）可能阻塞主线程几毫秒，
        // 让用户感觉"进入房间慢"。改为 requestIdleCallback / setTimeout 让 UI 先绘制完成。
        // 房间内通信有 WS 兜底，P2P 慢一点不影响功能。
        const scheduleIdle = window.requestIdleCallback
            ? (cb) => window.requestIdleCallback(cb)
            : (cb) => setTimeout(cb, 300);
        scheduleIdle(() => connectP2PChannel());
        startRoomPolling();
    }

    // 连接房间WebSocket并注册事件
    async function connectRoomSocket() {
        if (!CONFIG.wsUrl || !Wallet.getAddress() || isPurePrivateMode()) return;
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
            await GameSocket.connect(CONFIG.wsUrl, Wallet.getAddress());
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
            P2PChannel.connect(CONFIG.wsUrl, Wallet.getAddress(), currentRoomId).catch(e => {
                console.warn('[P2P] 连接失败:', e.message);
            });
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
                console.log('[Room] countdown_start:', `total=${data.total}s`, `end_time=${data.end_time}`, `bot=${currentRoom?.creator_is_bot}/${currentRoom?.player2_is_bot}`);
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
                // 强制回到大厅（而不是只切 stage），确保 URL 同步
                navigateTo('/');
            }
        });
        // 房间关闭（后端主动关闭）
        GameSocket.on('room_closed', (data) => {
            if (currentRoomId === data.room_id) {
                FWUI.Toast.warning(data.message || '房间已关闭');
                stopRoomPolling();
                disconnectP2PChannel();
                currentRoomId = null;
                currentRoom = null;
                navigateTo('/');
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
                // ⚠️ 关键：同步 URL
                navigateTo(`/room/${currentRoomId}`, { replace: true });
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
        // 被房主移出房间
        GameSocket.on('player_kicked', (data) => {
            if (currentRoomId === data.room_id) {
                FWUI.Toast.warning(data.message || '你已被房主移出房间');
                stopRoomPolling();
                disconnectP2PChannel();
                currentRoomId = null;
                currentRoom = null;
                currentGameId = null;
                navigateTo('/');
                loadRoomList();
            }
        });
        // 房主催促尽快准备（P2P 直连消息，经 GameSocket.inject 进入事件流）
        GameSocket.on('nudge_ready', (data) => {
            if (!currentRoomId || data.room_id !== currentRoomId) return;
            FWUI.Toast.warning('房主提醒：请尽快准备');
            const btn = document.getElementById('readyBtn');
            if (btn && !btn.disabled) {
                btn.classList.remove('nudge-pulse');
                void btn.offsetWidth; // 重启动画
                btn.classList.add('nudge-pulse');
                setTimeout(() => btn.classList.remove('nudge-pulse'), 2000);
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
                UI.setMyStatus('🎯 该你出拳了');
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
                    // 双方都已提交 → 进入揭晓阶段（本地也直接推进，不依赖后端 reveal_start 广播）
                    setGamePhase('reveal');
                    if (currentRoom) currentRoom.fund_stage = 'revealing';
                    UI.setFundStage('revealing');
                    UI.setGameStatus('揭晓阶段 · 即将自动揭晓');
                    UI.showRevealButton(true);
                    startGameTimer('reveal');
                    startAutoReveal(5);
                    FWUI.Toast.success('双方都已提交，准备揭晓');
                } else {
                    FWUI.Toast.info('对手已提交出拳，请尽快提交');
                }
            }
        });

        // 进入揭晓阶段（双方都已提交）
        GameSocket.on('reveal_start', (data) => {
            if (currentGameId && Number(data.game_id) === currentGameId) {
                setGamePhase('reveal');
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
                UI.setOpponentChoice(opponentChoice, true);  // 🔥 修复：传 true 显示 emoji
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
                UI.setOpponentChoice(data.choice2 || data.choice1, true);  // 🔥 修复：传 true 显示 emoji
                UI.setGameStatus('双方已揭晓，等待链上结算');
                FWUI.Toast.info(data.message || '双方都已揭晓，等待链上结算');
            }
        });

        // 对局被取消（Owner 取消或异常）
        // 注意：data.game_id 是后端本地对局 ID，data.chain_game_id 才是链上 ID（= currentGameId）
        GameSocket.on('match_cancelled', (data) => {
            const chainId = data.chain_game_id != null ? Number(data.chain_game_id) : null;
            const hitCurrentGame = currentGameId != null && chainId === currentGameId;
            const hitCurrentRoom = currentRoomId && data.room_id === currentRoomId;
            if (hitCurrentGame || hitCurrentRoom) {
                FWUI.Toast.warning(data.message || '对局已被取消');
                stopGameTimer();
                stopAllFallbackPolling();
                disconnectP2PChannel();
                try { UI.setGameStatus('对局已取消'); } catch (e) {}
                // 返回大厅
                setTimeout(() => {
                    currentGameId = null;
                    currentRoomId = null;
                    currentRoom = null;
                    chainGameIdResolved = false;
                    myChainJoined = false;
                    UI.showStage('stageLobby');
                    loadRoomList();
                }, 1500);
            }
        });

        // 对局结果（双方收到，链上结算完成 或 localOnly 后端本地结算）
        GameSocket.on('game_result', (data) => {
            if (currentGameId && Number(data.game_id) === currentGameId) {
                stopGameTimer();
                stopAutoReveal();
                stopGamePhaseFallbackPolling();
                stopLocalOnlyButtonGuard();
                clearInterval(_localOnlyGuardTimer);
                _localOnlyGuardTimer = null;

                const myAddress = Wallet.getAddress();
                let resultType = 'draw';
                let resultText = '平局';
                if (data.is_draw) {
                    resultType = 'draw';
                    resultText = '平局';
                } else if (data.winner && data.winner.toLowerCase() === myAddress.toLowerCase()) {
                    resultType = 'win';
                    resultText = '胜利';
                } else {
                    resultType = 'lose';
                    resultText = '失败';
                }

                UI.setGameStatus(`对局已结算 · ${resultText}`);
                FWUI.Toast.success(`对局结束：${resultText}`);

                // 🆕 切到结算界面 + PK 动画
                showResult({
                    type: resultType,
                    myChoice: data.my_choice ?? selectedChoice,
                    opponentChoice: data.opponent_choice,
                });

                // 游戏结束，清理 localOnly 状态
                document.body.dataset.localOnly = '';
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

                    // ⚠️ 关键：已结算的房间直接跳 result
                    // 场景：大厅点了已结算房间的加入按钮（后端列表过滤了但用户可能通过历史 URL 进来）
                    // 场景：join_room 成功返回但房间其实已 finished（竞态条件）
                    const status = (data.status || '').toUpperCase();
                    if (status === 'FINISHED' || status === 'COMPLETED' || status === 'SETTLED') {
                        console.info(`[Room] 房间 ${currentRoomId} 已结算 (status=${status}) → 跳转 result`);
                        stopRoomPolling();
                        stopAllCountdowns();
                        navigateTo(`/room/${currentRoomId}/result`);
                        return;
                    }

                    updateRoomUI();
                    updateExitGameBtnState();
                    // 启动/刷新房间生命周期倒计时（deadlines 从后端下发）
                    if (data.deadlines) {
                        startLifecycleCountdown();
                    } else {
                        stopLifecycleCountdown();
                    }
                } else {
                    // 房间不存在或已关闭 → Modal 提示后回大厅
                    const msg = (data && data.message) || '房间已解散';
                    console.warn('[Room] 房间不可用:', msg);
                    const reason = msg.includes('解散') ? 'dissolved'
                                  : msg.includes('关闭') ? 'closed'
                                  : 'not_found';
                    _showRoomGoneModal(reason, msg);
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
        const addrLower = (myAddress || '').toLowerCase();
        // === 关键修复：钱包未连接时，myAddress 为空不能算"creator" ===
        // 之前 (currentRoom.creator || '').toLowerCase() === (myAddress || '').toLowerCase()
        // 两边都是 '' → 误判为 amICreator=true，导致 player2 看到"房主（自己）"标签
        const amICreator = !!addrLower
            && (currentRoom.creator || '').toLowerCase() === addrLower;

        UI.setRoomInfo(currentRoom, amICreator);

        highlightMyPlayerCard(amICreator);

        const amIReady = amICreator ? currentRoom.creator_ready : currentRoom.player2_ready;

        // 仅游戏已开始（资金已上链）时禁用操作
        const fundStage = currentRoom.fund_stage || 'local_frozen';
        const fundsOnChain = fundStage === 'chain_frozen' || fundStage === 'revealing';
        const status = currentRoom.status;
        const readyBtn = document.getElementById('readyBtn');

        if (amICreator) {
            // 房主：按钮双重职责
            // - 房主未 ready：可点（点击即 ready 自己，若对手也 ready 则后端自动倒计时）
            // - 房主已 ready + 对手未 ready：禁用（有人没准备完不能开始）
            // - 双方都 ready：可点（开始游戏）
            // - 无对手 / 游戏进行中：禁用
            const bothReady = currentRoom.creator_ready && currentRoom.player2_ready;
            const inProgress = fundsOnChain || status === 'countdown' || status === 'game_started';
            const creatorWaitingForOpponent = currentRoom.creator_ready && !currentRoom.player2_ready;

            if (readyBtn) {
                readyBtn.disabled = !currentRoom.player2 || inProgress || creatorWaitingForOpponent;
                readyBtn.classList.remove('btn-start-waiting');
            }
            if (fundsOnChain || status === 'game_started') {
                UI.setReadyButtonText('游戏进行中…');
            } else if (status === 'countdown') {
                UI.setReadyButtonText('开始中…');
            } else if (!currentRoom.player2) {
                UI.setReadyButtonText('等待对手加入');
            } else if (!currentRoom.creator_ready) {
                UI.setReadyButtonText('准备');
            } else if (creatorWaitingForOpponent) {
                UI.setReadyButtonText('等待对方准备');
            } else {
                UI.setReadyButtonText('开始游戏');
            }
        } else {
            // 加入者：准备 / 取消准备
            if (readyBtn) {
                readyBtn.disabled = fundsOnChain;
                readyBtn.classList.remove('btn-start-waiting');
            }
            UI.setReadyButtonText(amIReady ? '取消准备' : '准备');
        }

        // 右上角关闭图标规则（角色感知）：
        // - 创建者：资金已上链（createMatch 后）即不可直接退出
        // - player2：只有自己实际 join 链上对局后（资金已锁）才不可退出；
        //   仅创建者上链、我还没 join 时允许安全离开
        const cannotLeave = amICreator ? fundsOnChain : (fundsOnChain && myChainJoined);
        const exitBtn = document.getElementById('roomExitBtn');
        if (exitBtn) {
            exitBtn.disabled = cannotLeave;
            exitBtn.title = cannotLeave
                ? '对局进行中（资金已上链），无法退出'
                : '离开房间，返回游戏大厅';
        }

        if (currentRoom.status === 'countdown') {
            UI.showCountdown(true);
            // 如果有 countdown_start 字段，使用它来计算倒计时（更准确）
            if (currentRoom.countdown_start && !hasWsCountdown) {
                const hasBot = currentRoom.creator_is_bot || currentRoom.player2_is_bot;
                const countdownTotal = hasBot ? 5 : 15;
                console.log('[Room] fallback countdown:', `start=${currentRoom.countdown_start}`, `bot=${hasBot}`, `total=${countdownTotal}s`, `creator_is_bot=${currentRoom.creator_is_bot}`, `player2_is_bot=${currentRoom.player2_is_bot}`);
                const endTime = currentRoom.countdown_start + countdownTotal;
                startSyncedCountdown(endTime, currentRoom.countdown_start, countdownTotal);
                hasWsCountdown = true;
            } else if (!hasWsCountdown) {
                console.warn('[Room] fallback: no countdown_start in room data, using local countdown');
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
                const addrL = (myAddr || '').toLowerCase();
                const amICreator = !!addrL && currentRoom.creator.toLowerCase() === addrL;
                handleRoomGameStarted({
                    room_id: currentRoom.room_id,
                    game_id: currentRoom.game_id,
                    is_creator: amICreator,
                    opponent: amICreator ? currentRoom.player2 : currentRoom.creator,
                    token: currentRoom.token,
                    bet_amount: currentRoom.bet_amount,
                    commit_deadline: null,
                    local_only: !!currentRoom.local_only,
                    creator_is_bot: !!currentRoom.creator_is_bot,
                    player2_is_bot: !!currentRoom.player2_is_bot,
                });
            }
        } else {
            UI.showCountdown(false);
            stopAllCountdowns();
            hasWsCountdown = false;
        }
    }

    // 更新游戏界面退出按钮状态（角色感知：player2 未 join 前仍可退出）
    function updateExitGameBtnState() {
        const btn = document.getElementById('exitGameBtn');
        if (!btn) return;
        const fundStage = (currentRoom && currentRoom.fund_stage) || 'local_frozen';
        const fundsOnChain = fundStage === 'chain_frozen' || fundStage === 'revealing';
        const myAddress = Wallet.getAddress() || '';
        const amICreator = currentRoom
            && currentRoom.creator
            && currentRoom.creator.toLowerCase() === myAddress.toLowerCase();
        // player2 自己还没 join（资金未锁）→ 允许离开；创建者资金已上链 → 不可直接退出
        const cannotLeave = amICreator ? fundsOnChain : (fundsOnChain && myChainJoined);
        btn.disabled = cannotLeave;
        btn.title = cannotLeave
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

    // 🔥 localOnly 模式按钮守护：持续监视任何试图在 commit 前禁用按钮的行为并立即覆盖
    let _localOnlyGuardTimer = null;
    function _startLocalOnlyButtonGuard() {
        if (_localOnlyGuardTimer) clearInterval(_localOnlyGuardTimer);
        _localOnlyGuardTimer = setInterval(() => {
            if (!document.body.dataset.localOnly || document.body.dataset.localOnly !== 'true') {
                clearInterval(_localOnlyGuardTimer);
                _localOnlyGuardTimer = null;
                return;
            }
            if (myCommitSubmitted) {
                clearInterval(_localOnlyGuardTimer);
                _localOnlyGuardTimer = null;
                return;
            }
            const buttons = document.querySelectorAll('.choice-btn');
            buttons.forEach(btn => {
                if (btn.disabled) {
                    btn.disabled = false;
                    btn.classList.add('ready-to-punch');
                }
            });
        }, 300);
    }

    function stopLocalOnlyButtonGuard() {
        if (_localOnlyGuardTimer) {
            clearInterval(_localOnlyGuardTimer);
            _localOnlyGuardTimer = null;
        }
    }

    // 🔥 localOnly 模式状态恢复：主动从后端拉取游戏状态，补偿 WS 时序竞态
    //    场景：Bot 已 commit 但玩家 WS 刚连上（刷新页面）→ 玩家不知道对手已提交
    async function _restoreGameStateFromBackend() {
        if (!currentGameId) return;
        const targetGameId = currentGameId;  // 防止中途切换游戏导致恢复 stale 数据
        try {
            const res = await fetch(`${CONFIG.backendUrl}/api/game/${targetGameId}`);
            if (!res.ok) return;
            const g = await res.json();
            if (g.game_id !== targetGameId) return;  // 🆕 游戏已切换，丢弃

            const myAddr = (Wallet.getAddress() || '').toLowerCase();
            const isPlayer1 = (g.player1 || '').toLowerCase() === myAddr;
            const myCommitField = isPlayer1 ? 'commit1' : 'commit2';
            const oppCommitField = isPlayer1 ? 'commit2' : 'commit1';

            // 恢复 commit 状态（Bot 可能已经 commit 了，WS 广播错过了）
            if (g[myCommitField]) {
                myCommitSubmitted = true;
                UI.setMyStatus('已提交');
                UI.setChoiceButtonsEnabled(false);
                stopLocalOnlyButtonGuard();
                clearInterval(_localOnlyGuardTimer);
                _localOnlyGuardTimer = null;
            }
            if (g[oppCommitField]) {
                opponentCommitSubmitted = true;
                UI.setOpponentStatus('已提交');
            }

            // 恢复 reveal 状态
            const myChoiceField = isPlayer1 ? 'choice1' : 'choice2';
            const oppChoiceField = isPlayer1 ? 'choice2' : 'choice1';
            if (g[myChoiceField]) {
                myRevealed = true;
                selectedChoice = g[myChoiceField];
                UI.setMyChoice(selectedChoice, true);
                UI.setMyStatus('已揭晓');
            }
            if (g[oppChoiceField]) {
                opponentRevealed = true;
                UI.setOpponentChoice(g[oppChoiceField], true);  // 🔥 修复：传 true 显示 emoji
                UI.setOpponentStatus('已揭晓');
            }

            // 根据 state 推进阶段
            if (g.state === 'reveal') {
                setGamePhase('reveal');
                if (currentRoom) currentRoom.fund_stage = 'revealing';
                UI.setFundStage('revealing');
                UI.showRevealButton(true);

                // 如果双方都 commit 了但我还没 reveal，等对手 reveal
                if (!myCommitSubmitted || !opponentCommitSubmitted) {
                    // 还在 commit 阶段等双方提交，继续守护
                } else {
                    UI.setGameStatus('揭晓阶段 · 即将自动揭晓');
                    startGameTimer('reveal');
                    startAutoReveal(5);
                }
            }

            // 🔥 修复：finished 时不管有没 winner（平局 winner=null）都要 showResult
            if (g.state === 'finished') {
                setGamePhase('finished');
                const myChoice = g[myChoiceField] ?? selectedChoice;
                const oppChoice = g[oppChoiceField];
                if (g.is_draw) {
                    showResult({ type: 'draw', myChoice, opponentChoice: oppChoice });
                } else if (g.winner) {
                    showResult({
                        type: g.winner.toLowerCase() === myAddr ? 'win' : 'lose',
                        myChoice, opponentChoice: oppChoice,
                    });
                } else {
                    // 理论上不会到这里，但兜底
                    showResult({ type: 'draw', myChoice, opponentChoice: oppChoice });
                }
            }

            console.log('[LocalOnly Restore] state=%s myCommit=%s oppCommit=%s myChoice=%s oppChoice=%s',
                g.state, !!g[myCommitField], !!g[oppCommitField], g[myChoiceField], g[oppChoiceField]);
        } catch (e) {
            console.warn('[LocalOnly Restore] 恢复失败:', e.message);
        }
    }

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
        // 保留 / 更新 bot 标识（WS 事件可能带，也可能 loadRoomStatus 时已有）
        if (data.creator_is_bot !== undefined) currentRoom.creator_is_bot = data.creator_is_bot;
        if (data.player2_is_bot !== undefined) currentRoom.player2_is_bot = data.player2_is_bot;
        console.log('[Room] game_started bot flags:', `creator_is_bot=${currentRoom.creator_is_bot}`, `player2_is_bot=${currentRoom.player2_is_bot}`);
        // 进入游戏阶段时资金尚未上链（local_frozen）
        if (!currentRoom.fund_stage) currentRoom.fund_stage = 'local_frozen';
        UI.setFundStage(currentRoom.fund_stage);
        updateExitGameBtnState();
        // 保存已有的 chain_game_id（用于幂等性判断，避免刷新后重复签名）
        if (data.chain_game_id) {
            currentRoom.chain_game_id = data.chain_game_id;
        }

        // 使用后端传来的 is_creator 字段，比自己比较更可靠
        const amICreator = !!data.is_creator;
        const localOnly = !!data.local_only;  // auto_chain_match=False → 跳过所有链上流程
        console.log('[Room] game_started: amICreator=' + amICreator + ', localOnly=' + localOnly + ', gameId=' + data.game_id + ', chainGameId=' + data.chain_game_id);
        // 是否已有链上对局 ID（刷新恢复 / 上报过 / 事件携带）
        const existingChainGameId = data.chain_game_id ? Number(data.chain_game_id) : null;
        // 关键：链上 ID 是否已确认（不能用 currentGameId 判断——它还会被赋成本地 game_id）
        // 注意：标志在 resetGameState() 之后设置（reset 会清零）

        // 设置游戏状态
        resetGameState();
        // 🔥 显式管理 isLocalOnlyGame：先清 false（链上模式默认），localOnly 时再设 true
        // （从 resetGameState 移出，避免中途 loadRoomStatus 再次触发 handleRoomGameStarted 时被误清）
        isLocalOnlyGame = false;
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
        chainGameIdResolved = !!existingChainGameId;

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
            UI.setOpponentAddress(data.opponent, !!currentRoom.player2_is_bot);

            // 🟢 localOnly 模式：跳过所有链上流程，直接进入出拳
            if (localOnly) {
                isLocalOnlyGame = true;
                setGamePhase('commit');  // 🆕 关键！selectChoice 第一行就检查 gamePhase !== 'commit'
                currentGameId = data.game_id;
                chainGameIdResolved = true;
                document.body.dataset.localOnly = 'true';
                UI.setGameStatus('🎯 本地对局模式，请出拳');
                UI.setMyStatus('🎯 该你出拳了');
                UI.setOpponentStatus('等待对手出拳...');
                UI.setChoiceButtonsEnabled(true);
                UI.showStage('stageGame');  // 确保显示游戏界面
                _startLocalOnlyButtonGuard();
                startGamePhaseFallbackPolling();  // 🔥 localOnly 也启动兜底轮询！
                startGameTimer('commit');
                FWUI.Toast.info('本地对局模式：无需链上签名，直接开始出拳');
                _restoreGameStateFromBackend();  // 🆕 主动拉后端状态（Bot 可能已经 commit 了）
                return;
            }

            // 幂等性：如果已有 chain_game_id（例如刷新页面恢复），跳过 createMatch 签名
            // 直接进入"等待对手加入"阶段，避免重复签名
            if (existingChainGameId) {
                currentGameId = existingChainGameId;
                UI.setGameId(existingChainGameId);
                UI.setGameStatus('等待对手加入');
                UI.setMyStatus('🎯 该你出拳了');
                UI.setOpponentStatus('加入中...');
                FWUI.Toast.info(`已恢复链上对局 #${existingChainGameId}，等待对手加入`);
                pollChainGameUntilJoined();
            } else {
                UI.setGameStatus('创建链上对局中...');

                // 创建者兜底轮询：如仍未拿到 chain_game_id（可能之前上报成功但前端异常），
                // 则拉取 room 信息拿 chain_game_id，若有则直接进入等待对手加入阶段
                const creatorRecoverTimer = setInterval(async () => {
                    if (chainGameIdResolved) { clearInterval(creatorRecoverTimer); return; }
                    if (!currentRoomId) { clearInterval(creatorRecoverTimer); return; }
                    try {
                        const resp = await fetch(`${CONFIG.backendUrl}/api/game/room/${currentRoomId}`);
                        const d = resp.ok ? await resp.json() : null;
                        if (d && d.chain_game_id) {
                            clearInterval(creatorRecoverTimer);
                            chainGameIdResolved = true;
                            const chainGameId = Number(d.chain_game_id);
                            currentGameId = chainGameId;
                            UI.setGameId(chainGameId);
                            UI.setGameStatus('等待对手加入');
                            UI.setMyStatus('🎯 该你出拳了');
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
            UI.setOpponentAddress(data.opponent, !!currentRoom.creator_is_bot);

            // 🟢 localOnly 模式：跳过等待链上，直接进入出拳
            if (localOnly) {
                isLocalOnlyGame = true;
                setGamePhase('commit');  // 🆕 关键！selectChoice 第一行就检查 gamePhase !== 'commit'
                currentGameId = data.game_id;
                chainGameIdResolved = true;
                document.body.dataset.localOnly = 'true';
                UI.setGameStatus('🎯 本地对局模式，请出拳');
                UI.setMyStatus('🎯 该你出拳了');
                UI.setOpponentStatus('等待对手出拳...');
                UI.setChoiceButtonsEnabled(true);
                UI.showStage('stageGame');  // 确保显示游戏界面
                _startLocalOnlyButtonGuard();
                startGamePhaseFallbackPolling();  // 🔥 localOnly 也启动兜底轮询！
                startGameTimer('commit');
                FWUI.Toast.info('本地对局模式：无需链上签名，直接开始出拳');
                _restoreGameStateFromBackend();  // 🆕 主动拉后端状态（Bot 可能已经 commit 了）
                return;
            }

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
                    if (chainGameIdResolved) { clearInterval(player2RecoverTimer); return; }
                    if (!currentRoomId) { clearInterval(player2RecoverTimer); return; }
                    try {
                        const resp = await fetch(`${CONFIG.backendUrl}/api/game/room/${currentRoomId}`);
                        const d = resp.ok ? await resp.json() : null;
                        if (d && d.chain_game_id) {
                            clearInterval(player2RecoverTimer);
                            chainGameIdResolved = true;
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
                UI.setMyStatus('🎯 该你出拳了');
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
                await Contract.ensureAllowance(tokenAddress, currentRoom.bet_amount, myAddress, approveOpts());
            }

            UI.setGameStatus('创建链上对局中...');

            // 调用合约 createMatch
            const {gameId: chainGameId} = await Contract.createMatch(currentRoom.bet_amount, tokenAddress);
            // 🔥 资金已上链冻结 → 立即刷新余额（钱包可用余额应减少）
            updateBalanceDisplay();

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
            chainGameIdResolved = true;
            UI.setGameId(currentGameId);
            // 资金已在 createMatch 中上链冻结
            if (currentRoom) currentRoom.fund_stage = 'chain_frozen';
            UI.setFundStage('chain_frozen');
            updateExitGameBtnState();
            const chainFrozenText = UI.FUND_STAGE_TEXT ? UI.FUND_STAGE_TEXT['chain_frozen'] : '⛓️ 资金已链上锁定';
            UI.setGameStatus('等待对手加入 · ' + chainFrozenText);
            UI.setMyStatus('🎯 该你出拳了');
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
            const suggestion = e && e.suggestion ? e.suggestion : null;
            // 下层已弹过 Modal 指引（如钱包残留队列），跳过重复 Toast
            if (e && e._modalShown) {
                UI.setGameStatus('代币授权失败，请按弹窗指引处理后重试');
                UI.showStage('stageGame');
                UI.setGameId('创建中...');
                UI.setMyStatus('创建对局');
                UI.setOpponentStatus('等待加入');
                UI.showRetrySection('create');
                return;
            }
            if (e && e.userCancelled) {
                FWUI.Toast.info(msg || '您已取消创建对局');
                UI.setGameStatus('创建已取消，点击"重试创建对局"可继续');
            } else {
                FWUI.Toast.error(msg || '创建链上对局失败');
                const statusText = suggestion
                    ? `创建失败：${msg}。💡 ${suggestion}`
                    : `创建失败，可点击下方按钮重试`;
                UI.setGameStatus(statusText);
            }
            UI.showStage('stageGame');
            UI.setGameId('创建中...');
            UI.setMyStatus('创建对局');
            UI.setOpponentStatus('等待加入');
            UI.showRetrySection('create');
        }
    }

    // 处理链上对局已创建事件
    // 用户"自动授权"偏好：开启时首次进行无限额授权，之后所有对局无需再确认 approve
    function approveOpts() {
        try {
            const on = typeof Settings !== 'undefined'
                && Settings && typeof Settings.isAutoApprove === 'function'
                && Settings.isAutoApprove();
            return { unlimited: on !== false };
        } catch (e) {
            return { unlimited: true };
        }
    }

    // 加入链上对局的在途互斥：
    // chain_game_created 的 WS 推送、恢复轮询、P2P 注入、重试按钮可能同时触发，
    // 必须共用同一个 Promise，否则会并发发起多笔相同 Nonce 的 approve/join，导致授权失败
    let _chainJoinPromise = null;
    function handleChainGameCreated(data) {
        if (_chainJoinPromise) return _chainJoinPromise;
        _chainJoinPromise = _doHandleChainGameCreated(data)
            .finally(() => { _chainJoinPromise = null; });
        return _chainJoinPromise;
    }

    // 幂等性：先调用 Contract.getGame 检查链上 player2 是否已是自己，若是则跳过 joinMatch 签名
    async function _doHandleChainGameCreated(data) {
        const chainGameId = Number(data.chain_game_id);
        if (!chainGameId) return;

        currentGameId = chainGameId;
        chainGameIdResolved = true;

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
                    myChainJoined = true;
                    enterGamePhase();
                    UI.setOpponentStatus('等待出拳');
                    FWUI.Toast.success('已恢复加入状态，开始出拳！');
                    return;
                }
                // 链上对局状态：0 Waiting / 1 CommitPhase / 2 RevealPhase / 3 Settled / 4 Cancelled
                const chainStatus = game ? Number(game.status) : null;
                if (chainStatus === 4) {
                    // 对局已被创建者撤销（等待加入超时/房主取消），joinMatch 必然 revert，
                    // 不能再让用户反复重试，直接引导退出并回大厅
                    await handleChainMatchCancelled(currentGameId);
                    return;
                }
                // 若对局已结算（status=3），直接进入出拳阶段让 enterGamePhase 处理后续
                if (chainStatus === 3) {
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
                await Contract.ensureAllowance(tokenAddress, currentRoom.bet_amount, myAddress, approveOpts());
            }

            UI.setGameStatus('加入链上对局中...');

            // 调用合约 joinMatch
            await Contract.joinMatch(currentGameId);
            myChainJoined = true;
            // 🔥 资金已上链冻结 → 立即刷新余额
            updateBalanceDisplay();

            enterGamePhase();
            // 资金已在 joinMatch 中上链冻结
            if (currentRoom) currentRoom.fund_stage = 'chain_frozen';
            UI.setFundStage('chain_frozen');
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
            const suggestion = e && e.suggestion ? e.suggestion : null;
            // 下层已弹过 Modal 指引（如钱包残留队列），跳过重复 Toast
            if (e && e._modalShown) {
                UI.setGameStatus('代币授权失败，请按弹窗指引处理后重试');
                UI.showStage('stageGame');
                UI.setGameId(currentGameId);
                UI.setMyStatus('加入中');
                UI.setOpponentStatus('已就绪');
                UI.showRetrySection('join');
                return;
            }
            if (e && e.userCancelled) {
                FWUI.Toast.info(msg || '您已取消加入对局');
                UI.setGameStatus('加入已取消，点击"重试加入对局"可继续');
            } else {
                FWUI.Toast.error(msg || '加入链上对局失败');
                const statusText = suggestion
                    ? `加入失败：${msg}。💡 ${suggestion}`
                    : `加入失败，可点击下方按钮重试`;
                UI.setGameStatus(statusText);
            }
            UI.showStage('stageGame');
            UI.setGameId(currentGameId);
            UI.setMyStatus('加入中');
            UI.setOpponentStatus('已就绪');
            UI.showRetrySection('join');
        }
    }

    // 链上对局已被取消（房主/AI 在等待加入超时后 cancelMatch）：
    // joinMatch 会永久 revert，必须引导玩家安全退出房间回大厅，而不是困在"重试加入"
    async function handleChainMatchCancelled(chainGameId) {
        console.warn('[Room] 链上对局已被取消，退出房间:', chainGameId);
        FWUI.Toast.warning('链上对局已被取消（等待加入超时或房主撤销），正在退出房间');
        try { UI.setMyStatus('已取消'); } catch (e) {}
        try { UI.setOpponentStatus('对局已取消'); } catch (e) {}
        try { UI.setGameStatus('对局已取消，正在返回大厅…'); } catch (e) {}

        const rid = currentRoomId;
        const addr = Wallet.getAddress();
        if (rid && addr) {
            try {
                // player2 从未 join，链上无其资金；后端会读链复核后放行并重置房间
                await fetch(`${CONFIG.backendUrl}/api/game/room/leave`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ room_id: rid, player_address: addr }),
                });
            } catch (e) {
                console.warn('[Room] 退出已取消房间请求失败:', e && e.message);
            }
        }

        stopRoomPolling();
        stopAllFallbackPolling();
        disconnectP2PChannel();
        currentGameId = null;
        currentRoomId = null;
        currentRoom = null;
        chainGameIdResolved = false;
        myChainJoined = false;
        UI.showStage('stageLobby');
        loadRoomList();
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
        // 同时停止生命周期倒计时
        stopLifecycleCountdown();
    }

    // ==================== 房间生命周期倒计时管理器 ====================
    // 每秒 tick：根据 currentRoom.deadlines 更新 UI 显示
    // 支持所有阶段的倒计时，自动切换显示内容
    let lifecycleCountdownTimer = null;
    let lifecycleLastPhase = null;  // 上次显示的阶段（避免重复弹警告）

    function startLifecycleCountdown() {
        stopLifecycleCountdown();
        lifecycleLastPhase = null;

        const tick = () => {
            if (!currentRoom || !currentRoom.deadlines) {
                _renderLifecycleTimer(null);
                return;
            }
            const dl = currentRoom.deadlines;
            const status = currentRoom.status;
            const now = Math.floor(Date.now() / 1000);

            // 根据房间当前阶段选择显示哪个倒计时
            let display = null;
            let phase = null;
            let secondary = null;

            if (status === 'created' && dl.empty_room) {
                // CREATED：空房间倒计时（5分钟内没人加入自动关闭）
                display = dl.empty_room - now;
                phase = 'empty_room';
                secondary = dl.lifetime ? { label: '房间生命周期', remaining: dl.lifetime - now } : null;
            } else if (status === 'joined' && dl.unready_player) {
                // JOINED：未准备倒计时（谁没准备谁 60 秒被踢）
                display = dl.unready_player - now;
                phase = 'unready';
                secondary = dl.lifetime ? { label: '房间生命周期', remaining: dl.lifetime - now } : null;
            } else if (status === 'countdown' && dl.countdown) {
                // COUNTDOWN：游戏开始倒计时（15秒）
                display = dl.countdown - now;
                phase = 'game_countdown';
            } else if (status === 'game_started' && dl.game_timeout) {
                // GAME_STARTED：游戏超时倒计时（10分钟）
                display = dl.game_timeout - now;
                phase = 'game_timeout';
            }

            // 生命周期兜底（所有阶段都显示，作为底部提醒）
            const lifetimeRemain = dl.lifetime ? dl.lifetime - now : null;

            _renderLifecycleTimer({ primary: display, phase, secondary, lifetime: lifetimeRemain });

            // 超时临近警告（首次进入 danger 区间时弹 Modal）
            _checkPhaseWarnings(phase, display);
        };

        lifecycleCountdownTimer = setInterval(tick, 1000);
        tick(); // 立刻 tick 一次
    }

    function stopLifecycleCountdown() {
        if (lifecycleCountdownTimer) {
            clearInterval(lifecycleCountdownTimer);
            lifecycleCountdownTimer = null;
        }
        lifecycleLastPhase = null;
        _renderLifecycleTimer(null); // 清空
    }

    function _checkPhaseWarnings(phase, remaining) {
        if (!phase || remaining == null) return;
        // 只在"首次进入警告/危险区间"时弹一次
        // 用 lifecycleLastPhase 记录上一次状态
        const bucket = remaining > 30 ? 'safe' : remaining > 10 ? 'warn' : 'danger';
        const key = phase + ':' + bucket;
        if (lifecycleLastPhase === key) return;
        lifecycleLastPhase = key;

        if (remaining <= 10 && remaining > 0) {
            // 即将超时（最后 10 秒），Toast 提醒
            const hintMap = {
                'empty_room': `⏰ 房间 ${remaining} 秒后将因无人加入自动关闭`,
                'unready': `⏰ ${remaining} 秒内未准备将被自动移出房间`,
                'game_timeout': `⏰ 对局 ${remaining} 秒后超时自动关闭`,
            };
            const hint = hintMap[phase];
            if (hint) {
                try { FWUI && FWUI.Toast && FWUI.Toast.warning && FWUI.Toast.warning(hint, { duration: 3000 }); } catch (_) {}
            }
        }
    }

    function _renderLifecycleTimer(info) {
        // 同时更新两个位置：stageRoomWait 的小计时器 + stageGame 的大计时器
        const stageRoomTimer = document.getElementById('roomLifecycleTimer');
        const stageGameTimer = document.getElementById('gameTimer');
        const gameVs = document.getElementById('gameVs');

        if (!info || info.primary == null || info.primary <= 0) {
            // 隐藏
            if (stageRoomTimer) { stageRoomTimer.textContent = ''; stageRoomTimer.className = 'room-lifecycle-timer'; stageRoomTimer.style.display = 'none'; }
            if (stageGameTimer) { stageGameTimer.textContent = '--:--'; stageGameTimer.className = 'game-timer'; }
            if (gameVs) { gameVs.textContent = 'VS'; gameVs.classList.remove('vs-countdown'); }
            return;
        }

        const secs = Math.max(0, Math.floor(info.primary));
        const mmss = _fmtMMSS(secs);
        const hhmmss = _fmtHHMMSS(secs);

        // 阶段文案
        const phaseLabels = {
            'empty_room': '⏳ 无人加入，自动关闭',
            'unready': '⏳ 未准备，将被移出',
            'game_countdown': '🎮 即将开始',
            'game_timeout': '⏰ 对局超时',
        };
        const label = phaseLabels[info.phase] || '';

        // 警告/危险状态
        const isWarn = secs <= 30 && secs > 10;
        const isDanger = secs <= 10;

        // --- stageRoomWait 小计时器 ---
        if (stageRoomTimer) {
            stageRoomTimer.style.display = '';
            const timeStr = info.phase === 'empty_room' || info.phase === 'game_timeout'
                ? hhmmss  // 长阶段用 hh:mm:ss
                : mmss;   // 短阶段用 mm:ss
            stageRoomTimer.textContent = `${label} ${timeStr}`;
            stageRoomTimer.className = 'room-lifecycle-timer' + (isDanger ? ' danger' : isWarn ? ' warning' : '');
        }

        // --- stageGame 大计时器 ---
        if (stageGameTimer) {
            const timeStr = info.phase === 'game_timeout' || info.phase === 'game_countdown'
                ? mmss
                : hhmmss;
            stageGameTimer.textContent = timeStr;
            stageGameTimer.className = 'game-timer' + (isDanger ? ' danger' : isWarn ? ' warning' : '');
            // 如果有阶段名，用 Tooltip
            stageGameTimer.title = label;
        }

        // 🔥 VS 位置：倒计时阶段显示大号倒计时数字，其他阶段恢复 VS
        if (gameVs) {
            if (info.phase === 'game_countdown') {
                gameVs.textContent = secs > 0 ? secs : 'GO!';
                gameVs.classList.add('vs-countdown');
            } else {
                gameVs.textContent = 'VS';
                gameVs.classList.remove('vs-countdown');
            }
        }
    }

    function _fmtMMSS(totalSec) {
        const m = Math.floor(totalSec / 60);
        const s = totalSec % 60;
        return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
    }
    function _fmtHHMMSS(totalSec) {
        const h = Math.floor(totalSec / 3600);
        const m = Math.floor((totalSec % 3600) / 60);
        const s = totalSec % 60;
        return h > 0
            ? `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
            : `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
    }

    // 游戏阶段兜底轮询定时器（检测链上对局状态：commit/reveal）
    let gamePhaseFallbackTimer = null;
    let lastOpponentCommitState = false;
    let lastOpponentRevealState = false;

    // 启动游戏阶段兜底轮询（WS 事件丢失时通过链上/后端查询恢复）
    function startGamePhaseFallbackPolling() {
        stopGamePhaseFallbackPolling();
        lastOpponentCommitState = opponentCommitSubmitted;
        lastOpponentRevealState = opponentRevealed;
        console.log('[Fallback] 启动兜底轮询，localOnly=' + isLocalOnlyGame + ', gameId=' + currentGameId);

        gamePhaseFallbackTimer = setInterval(async () => {
            if (!currentGameId) {
                stopGamePhaseFallbackPolling();
                return;
            }
            try {
                let myCommit = false, oppCommit = false, myChg = null, oppChg = null, gameState = null;
                let g = null;  // 🔥 提到块外！ES6 块作用域，if (isLocalOnlyGame) 里 const g 出块不可见！

                // 🔥 关键诊断：打印当前走哪个分支
                const branch = isLocalOnlyGame ? 'LOCAL_ONLY_BACKEND_API' : 'CHAIN_CONTRACT';
                console.log('[Fallback] poll start:', { branch, isLocalOnlyGame, currentGameId });

                // 🔥 localOnly 模式：查后端 API
                if (isLocalOnlyGame) {
                    const res = await fetch(`${CONFIG.backendUrl}/api/game/${currentGameId}`);
                    if (!res.ok) { console.warn('[Fallback] res not ok:', res.status); return; }
                    g = await res.json();  // 🔥 赋值给外层 let g
                    const gid = g.game_id;
                    const cgid = currentGameId;
                    const match = gid == cgid;  // 用 == 做宽松比较，避免 int vs string
                    console.log('[Fallback] poll game:', { gid, cgid, match, state: g.state });
                    if (!match) { console.warn('[Fallback] game_id mismatch, skip'); return; }

                    const myAddr = (Wallet.getAddress() || '').toLowerCase();
                    const isP1 = (g.player1 || '').toLowerCase() === myAddr;
                    myCommit = !!(g[isP1 ? 'commit1' : 'commit2']);
                    oppCommit = !!(g[isP1 ? 'commit2' : 'commit1']);
                    myChg = g[isP1 ? 'choice1' : 'choice2'] || null;
                    oppChg = g[isP1 ? 'choice2' : 'choice1'] || null;
                    gameState = g.state;
                } else {
                    // 链上模式：查合约
                    const game = await Contract.getGame(currentGameId);
                    if (!game) return;
                    const myAddress = Wallet.getAddress();
                    const isPlayer1 = game.player1 && game.player1.toLowerCase() === myAddress.toLowerCase();
                    const opponentAddr = isPlayer1 ? game.player2 : game.player1;

                    myCommit = true;  // 我自己的状态由 selectChoice 维护
                    try {
                        const opponentCommit = await Contract.getCommit(currentGameId, opponentAddr);
                        oppCommit = opponentCommit && opponentCommit !== '0x0000000000000000000000000000000000000000000000000000000000000000';
                    } catch (_) {}
                }

                // 检测对手 commit（localOnly 模式核心兜底）
                if (!opponentCommitSubmitted && oppCommit) {
                    console.log('[Fallback] 检测到对手已提交（localOnly=' + isLocalOnlyGame + '），补触发 opponent_commit');
                    opponentCommitSubmitted = true;
                    UI.setOpponentStatus('已提交 🔒');
                    UI.setOpponentChoice(true, false);

                    if (myCommitSubmitted || myCommit) {
                        setGamePhase('reveal');
                        if (currentRoom) currentRoom.fund_stage = 'revealing';
                        UI.setFundStage('revealing');
                        UI.setGameStatus('揭晓阶段 · 即将自动揭晓');
                        UI.showRevealButton(true);
                        startGameTimer('reveal');
                        startAutoReveal(5);
                        FWUI.Toast.info('双方都已提交，进入揭晓阶段（5秒后自动揭晓）');
                    }
                }

                // 检测 reveal 状态
                if (gameState === 'reveal' || oppChg) {
                    if (!opponentRevealed && oppChg) {
                        opponentRevealed = true;
                        UI.setOpponentChoice(oppChg, true);
                        UI.setOpponentStatus('已揭晓');
                    }
                }

                // 检测游戏已结算（🔥 localOnly 模式下自己处理，不依赖 WS）
                if (gameState === 'finished') {
                    console.log('[Fallback] gameState=finished! 准备结算:', { myChg, oppChg, winner: g.winner, is_draw: g.is_draw });
                    if (!myRevealed && myChg) {
                        myRevealed = true;
                        UI.setMyChoice(myChg, true);
                        UI.setMyStatus('已揭晓');
                    }
                    if (!opponentRevealed && oppChg) {
                        opponentRevealed = true;
                        UI.setOpponentChoice(oppChg, true);
                        UI.setOpponentStatus('已揭晓');
                    }
                    // 🔥 关键！localOnly 模式自己算胜负并结算
                    if (isLocalOnlyGame) {
                        stopGameTimer();
                        stopAutoReveal();
                        // 用后端返回的 winner/is_draw 字段
                        const winnerAddr = (g.winner || '').toLowerCase();
                        const myAddr = (Wallet.getAddress() || '').toLowerCase();
                        const isDraw = !!g.is_draw;
                        let resultType;
                        if (isDraw) {
                            resultType = 'draw';
                        } else if (winnerAddr && winnerAddr === myAddr) {
                            resultType = 'win';
                        } else {
                            resultType = 'lose';
                        }
                        console.log('[Fallback] 准备调用 showResult:', { resultType, myChg, oppChg, winnerAddr, myAddr, isDraw });
                        setGamePhase('finished');
                        // 🆕 计算结算金额（后端返回 bet_amount 和 token）
                        const betAmount = Number(g.bet_amount || 0);
                        const token = g.token || 'USDC';
                        let showAmount = '', showPrize = '', showFee = '';
                        if (isDraw) {
                            showPrize = '0.00';
                        } else if (resultType === 'win') {
                            showPrize = `+${betAmount.toFixed(2)}`;
                        } else {
                            showPrize = `-${betAmount.toFixed(2)}`;
                        }
                        try {
                            showResult({
                                type: resultType,
                                myChoice: myChg,
                                opponentChoice: oppChg,
                                amount: betAmount.toFixed(2),
                                token: token,
                                prize: showPrize,
                                fee: '0.00',
                            });
                            console.log('[Fallback] showResult 调用成功');
                        } catch (showErr) {
                            console.error('[Fallback] showResult 抛出异常:', showErr);
                        }
                        stopGamePhaseFallbackPolling();  // 🔥 结算后停掉兜底轮询，避免重复触发
                        // 刷新余额（localOnly 模式从后端余额接口读）
                        if (isLocalOnlyGame) {
                            const myAddr = (Wallet.getAddress() || '').toLowerCase();
                            fetch(`/api/game/balance/${myAddr}`)
                                .then(r => r.json())
                                .then(b => {
                                    if (b.success) {
                                        // 更新右上角主余额
                                        UI.updateWalletInfo(myAddr, b.balance, 'USDC');
                                        // 更新展开详情面板
                                        UI.updateWalletBalances(myAddr, {
                                            'USDC': String(b.balance),
                                            nativeSymbol: String(b.native_balance || 1000),
                                        });
                                        console.log('[Fallback] 余额已刷新:', b.balance, 'USDC');
                                    }
                                })
                                .catch(e => console.warn('[Fallback] 刷新余额失败:', e));
                        }
                    }
                }
            } catch (e) {
                console.warn('[Fallback] 游戏阶段兜底轮询失败:', e.message);
            }
        }, 3000);  // localOnly 模式 3 秒轮询一次（之前链上是 5 秒）
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

            await Contract.ensureAllowance(tokenAddress, currentAmount, myAddress, approveOpts());

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
            const msg = e.message || '操作失败';
            const suggestion = e.suggestion || null;
            FWUI.Toast.error(msg);
            if (suggestion) {
                FWUI.Toast.info('💡 ' + suggestion);
            }
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

        if (CONFIG.wsUrl && Wallet.getAddress() && !isPurePrivateMode()) {
            GameSocket.connect(CONFIG.wsUrl, Wallet.getAddress()).catch(() => {});

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

            await Contract.ensureAllowance(tokenAddress, currentAmount, myAddress, approveOpts());

            const {gameId} = await Contract.createMatch(currentAmount, tokenAddress);
            currentGameId = gameId;
            // 🔥 资金已上链冻结 → 立即刷新余额
            updateBalanceDisplay();

            UI.setStartButtonText('创建成功', false);

            enterGamePhase();
            UI.setOpponentStatus('等待对手加入');

            copyToClipboard(gameId.toString());
            FWUI.Toast.success(`对局已创建，ID: ${gameId} 已复制到剪贴板`);

            pollGameUntilJoined();

        } catch (e) {
            const msg = e.message || '创建失败';
            const suggestion = e.suggestion || null;
            FWUI.Toast.error(msg);
            if (suggestion) {
                FWUI.Toast.info('💡 ' + suggestion);
            }
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

            await Contract.ensureAllowance(tokenAddress, currentAmount, myAddress, approveOpts());

            await Contract.joinMatch(gameId);
            currentGameId = gameId;
            // 🔥 资金已上链冻结 → 立即刷新余额
            updateBalanceDisplay();

            enterGamePhase();

            const game = await Contract.getGame(gameId);
            const opponent = game.player1;
            UI.setOpponentAddress(opponent);
            UI.setOpponentStatus('等待出拳');

            FWUI.Toast.success('加入对局成功！');

        } catch (e) {
            const msg = e.message || '加入失败';
            const suggestion = e.suggestion || null;
            FWUI.Toast.error(msg);
            if (suggestion) {
                FWUI.Toast.info('💡 ' + suggestion);
            }
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
        setGamePhase('commit');
        UI.showStage('stageGame');
        UI.setGameId(currentGameId);
        // 进入提交阶段时双方已完成 createMatch/joinMatch，资金已在链上冻结
        const chainFrozenText = UI.FUND_STAGE_TEXT ? UI.FUND_STAGE_TEXT['chain_frozen'] : '⛓️ 资金已链上锁定';
        UI.setGameStatus('提交阶段 · ' + chainFrozenText);
        // 关键修复：双方状态标签同时更新，不要遗漏 opponent
        UI.setMyStatus('🎯 该你出拳了');
        UI.setOpponentStatus('等待出拳');
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

        // 🆕 关键修复：停止房间生命周期倒计时器
        // 生命周期计时器显示的是房间整体超时（game_timeout=600s），会覆盖游戏阶段计时器
        // 游戏阶段计时器（commit=66s / reveal=88s）才是真正影响玩家操作的倒计时
        stopLifecycleCountdown();

        // 订阅对局（后端可批量通知对局双方）
        if (currentGameId && GameSocket.isConnected() && !isPurePrivateMode()) {
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

        // 🎯 锁定未选中按钮 —— 让选中的按钮成为焦点
        const buttonsWrap = document.querySelector('.choice-buttons');
        if (buttonsWrap) buttonsWrap.classList.add('locked');

        // 显示确认区
        const confirmSection = document.getElementById('choiceConfirmSection');
        const preview = document.getElementById('choiceConfirmPreview');
        if (confirmSection) {
            if (preview) {
                const emoji = RPSCrypto.getChoiceEmoji(choice);
                const name = RPSCrypto.getChoiceName(choice);
                preview.textContent = `${emoji} ${name}`;
            }
            confirmSection.classList.remove('hidden');
        }
    }

    // 取消出拳预览
    function cancelChoicePreview() {
        pendingChoice = null;
        UI.setSelectedChoice(null);
        // 🎯 解锁按钮
        const buttonsWrap = document.querySelector('.choice-buttons');
        if (buttonsWrap) buttonsWrap.classList.remove('locked');
        const confirmSection = document.getElementById('choiceConfirmSection');
        if (confirmSection) confirmSection.classList.add('hidden');
    }

    // 确认并提交出拳（方案A：EIP-712 链下签名 + 后端 relayer 代提交；失败回退方案B：直接上链）
    async function selectChoice(choice) {
        if (gamePhase !== 'commit' || myCommitSubmitted) return;

        selectedChoice = choice;
        UI.setSelectedChoice(choice);

        // 隐藏确认区和选择按钮
        const confirmSection = document.getElementById('choiceConfirmSection');
        if (confirmSection) confirmSection.classList.add('hidden');

        // 🟢 localOnly 模式：不走任何链上流程，直接 POST 到后端 API
        try {
            currentSalt = RPSCrypto.generateSalt();
            const myAddress = Wallet.getAddress();
            const commitHash = RPSCrypto.computeCommit(choice, currentSalt, myAddress);

            if (isLocalOnlyGame) {
                UI.setMyStatus('提交中...');
                const res = await fetch(`${CONFIG.backendUrl}/api/game/commit`, {
                    method: 'POST',
                    headers: {'Content-Type': 'application/json'},
                    body: JSON.stringify({
                        game_id: currentGameId,
                        player_address: myAddress,
                        commit_hash: commitHash,
                    }),
                });
                const data = await res.json();
                if (!res.ok || !data.success) {
                    throw new Error(data.detail || data.message || '提交失败');
                }

                myCommitSubmitted = true;
                UI.setMyStatus('已提交');
                UI.setChoiceButtonsEnabled(false);
                RPSCrypto.storeSalt(currentGameId, currentSalt, choice);
                FWUI.Toast.success('出拳已提交');

                // 后端 game_manager 会广播 opponent_commit / reveal_start
                // 如果后端已通知，前端状态可能已更新；否则等 WS 事件
                if (opponentCommitSubmitted) {
                    setGamePhase('reveal');
                    if (currentRoom) currentRoom.fund_stage = 'revealing';
                    UI.setFundStage('revealing');
                    UI.setGameStatus('揭晓阶段 · 即将自动揭晓');
                    UI.showRevealButton(true);
                    startGameTimer('reveal');
                    startAutoReveal(5);
                }
                return;
            }

            let committed = false;

            if (!isPurePrivateMode()) {
                UI.setMyStatus('签名中...');
                try {
                    const sigResult = await Contract.signCommit(currentGameId, myAddress, commitHash);

                    UI.setMyStatus('代提交中...');

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
                    if (res.ok && data.success) {
                        committed = true;
                    } else {
                        console.warn('[Commit] 方案A代提交失败，回退到直接上链:', data.message);
                    }
                } catch (sigErr) {
                    console.warn('[Commit] 方案A签名失败，回退到直接上链:', sigErr.message || sigErr);
                }
            } else {
                console.log('[Commit] 纯私密模式：跳过 relayer，直接上链');
            }

            // 方案B回退：直接上链 submitCommit（需要 gas 费）
            if (!committed) {
                UI.setMyStatus('直接上链提交中...');
                FWUI.Toast.info(isPurePrivateMode() ? '私密模式：直接上链提交（需要 gas 费）' : '签名代提交不可用，将直接上链提交（需要 gas 费）');
                await Contract.submitCommit(currentGameId, commitHash);
            }

            myCommitSubmitted = true;
            UI.setMyStatus('已提交');
            UI.setChoiceButtonsEnabled(false);

            RPSCrypto.storeSalt(currentGameId, currentSalt, choice);

            FWUI.Toast.success('出拳已提交');

            // 通过 P2P 即时通知对端已提交（P2P 不带出拳数据，仅通知状态）
            sendPeerNotify('opponent_commit', {
                game_id: currentGameId,
                player: myAddress,
            });

            if (opponentCommitSubmitted) {
                setGamePhase('reveal');
                // 双方都已提交 → 进入揭晓阶段，资金状态进入 revealing
                if (currentRoom) currentRoom.fund_stage = 'revealing';
                UI.setFundStage('revealing');
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

    // 揭晓出拳（localOnly 走后端 API；链上模式走方案A/B）
    async function revealChoice() {
        console.log('[Reveal] revealChoice called:', {
            selectedChoice, currentSalt, myCommitSubmitted, myRevealed,
            gamePhase, isLocalOnlyGame, currentGameId
        });
        if (!selectedChoice || !currentSalt || !myCommitSubmitted || myRevealed) {
            console.warn('[Reveal] revealChoice EARLY RETURN — missing:', {
                noChoice: !selectedChoice, noSalt: !currentSalt,
                notCommitted: !myCommitSubmitted, alreadyRevealed: myRevealed
            });
            return;
        }

        const revealBtn = UI.elements.revealBtn;
        try {
            stopAutoReveal();
            if (revealBtn) {
                revealBtn.disabled = true;
                revealBtn.textContent = '揭晓中...';
            }

            const myAddress = Wallet.getAddress();

            // 🟢 localOnly 模式：不走任何链上流程，直接 POST 到后端 API
            if (isLocalOnlyGame) {
                // 数字 choice (1/2/3) → 后端 Choice 枚举字符串 (rock/paper/scissors)
                const choiceName = {1: 'rock', 2: 'paper', 3: 'scissors'}[selectedChoice] || String(selectedChoice);
                console.log('[Reveal] localOnly calling /api/game/reveal:', { game_id: currentGameId, choice: choiceName });
                const res = await fetch(`${CONFIG.backendUrl}/api/game/reveal`, {
                    method: 'POST',
                    headers: {'Content-Type': 'application/json'},
                    body: JSON.stringify({
                        game_id: currentGameId,
                        player_address: myAddress,
                        choice: choiceName,  // 🆕 必须是字符串枚举值
                        salt: currentSalt,
                    }),
                });
                const data = await res.json();
                if (!res.ok || !data.success) {
                    console.error('[Reveal] reveal API failed:', data);
                    throw new Error(data.detail || data.message || '揭晓失败');
                }
                console.log('[Reveal] reveal API success:', data);

                myRevealed = true;
                UI.showRevealButton(false);
                UI.setMyStatus('已揭晓');
                UI.setMyChoice(selectedChoice, true);
                RPSCrypto.clearSalt(currentGameId);
                FWUI.Toast.success('揭晓成功');

                // 后端会处理双方都 reveal 后的胜负判定 + 广播 game_result
                // 等待 opponent_reveal / game_result 事件
                return;
            }

            let revealed = false;

            if (!isPurePrivateMode()) {
                try {
                    const sigResult = await Contract.signReveal(
                        currentGameId, myAddress, selectedChoice, currentSalt
                    );

                    if (revealBtn) {
                        revealBtn.textContent = '代提交中...';
                    }

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
                    if (res.ok && data.success) {
                        revealed = true;
                    } else {
                        console.warn('[Reveal] 方案A代提交失败，回退到直接上链:', data.message);
                    }
                } catch (sigErr) {
                    console.warn('[Reveal] 方案A签名失败，回退到直接上链:', sigErr.message || sigErr);
                }
            } else {
                console.log('[Reveal] 纯私密模式：跳过 relayer，直接上链');
            }

            // 方案B回退：直接上链 revealChoice（需要 gas 费）
            if (!revealed) {
                if (revealBtn) {
                    revealBtn.textContent = '直接上链揭晓中...';
                }
                FWUI.Toast.info(isPurePrivateMode() ? '私密模式：直接上链揭晓（需要 gas 费）' : '签名代提交不可用，将直接上链揭晓（需要 gas 费）');
                await Contract.revealChoice(currentGameId, selectedChoice, currentSalt);
            }

            myRevealed = true;
            UI.showRevealButton(false);
            UI.setMyStatus('已揭晓');
            UI.setMyChoice(selectedChoice, true);

            FWUI.Toast.success('揭晓成功');

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

    // 🆕 显示自动揭晓标签（隐藏按钮）
    function showAutoRevealLabel(seconds) {
        const btn = UI.elements.revealBtn;
        const label = document.getElementById('revealHintTag');
        if (btn) btn.classList.add('hidden');
        if (label) {
            label.classList.remove('hidden');
            const textEl = document.getElementById('revealHintText');
            if (textEl && seconds != null) textEl.textContent = `自动揭晓（${seconds}s）`;
            else if (textEl) textEl.textContent = '自动揭晓中…';
        }
    }

    // 🆕 显示手动揭晓按钮（隐藏标签）
    function showManualRevealBtn() {
        const btn = UI.elements.revealBtn;
        const label = document.getElementById('revealHintTag');
        if (btn) {
            btn.classList.remove('hidden');
            btn.disabled = false;
            btn.textContent = '立即揭晓';
        }
        if (label) label.classList.add('hidden');
    }

    // 启动自动揭示倒计时（seconds 秒后自动调用 revealChoice）
    function startAutoReveal(seconds = 5) {
        stopAutoReveal();
        let remaining = seconds;

        // 🆕 显示标签而非按钮
        showAutoRevealLabel(remaining);

        const tick = () => {
            // 已揭示，或不再需要揭示（状态变更），直接停止
            if (myRevealed || !currentGameId || gamePhase !== 'reveal') {
                stopAutoReveal();
                return;
            }
            if (remaining <= 0) {
                stopAutoReveal();
                // 优先使用本地保存的盐+出拳
                const stored = RPSCrypto.getSalt(currentGameId);
                if (!selectedChoice && stored && stored.choice) {
                    selectedChoice = stored.choice;
                }
                if (!currentSalt && stored && stored.salt) {
                    currentSalt = stored.salt;
                }
                if (selectedChoice && currentSalt && myCommitSubmitted && !myRevealed) {
                    showAutoRevealLabel();  // 显示 "自动揭晓中"
                    revealChoice();
                }
                return;
            }
            // 更新标签倒计时
            const label = document.getElementById('revealHintTag');
            if (label) {
                const textEl = document.getElementById('revealHintText');
                if (textEl) textEl.textContent = `自动揭晓（${remaining}s）`;
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
        // 🆕 隐藏自动揭晓标签
        const label = document.getElementById('revealHintTag');
        if (label) label.classList.add('hidden');
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
        // 🔥 结算完成 → 钱包余额发生了真实变化（赢方进账/输方扣减），立即刷新显示
        updateBalanceDisplay();
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
        // 🔥 关键：结算时必须停掉所有轮询，防止 polling 把 UI 打回 game/room 阶段
        stopRoomPolling();
        stopAllFallbackPolling();
        stopLifecycleCountdown();
        setGamePhase('finished');
        UI.showStage('stageResult');
        UI.showResult(result);
        startResultCountdown(30);
        // 更新 URL 为结算子路径（便于刷新恢复 / 排查 BUG）
        if (currentRoomId) {
            navigateTo(`/room/${currentRoomId}/result`);
        }
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
        UI.setFundStage('settled');
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
        chainGameIdResolved = false;
        myChainJoined = false;
        selectedChoice = null;
        pendingChoice = null;
        currentSalt = null;
        myCommitSubmitted = false;
        opponentCommitSubmitted = false;
        myRevealed = false;
        opponentRevealed = false;
        // 🆕 清结算防重复标记（下一局可以重新播动画）
        window._gameResultShown = false;
        setGamePhase('idle');
        // 🔥 isLocalOnlyGame 不在 resetGameState 里清！
        // 因为 handleRoomGameStarted 里先调 resetGameState 再根据 local_only 字段设 true，
        // 如果中途 loadRoomStatus 再次触发 handleRoomGameStarted，resetGameState 会把它清掉 →
        // fallback polling 会误以为是链上模式走 Contract.getGame() 永远拿不到后端 state！
        document.body.dataset.gamePhase = '';

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

    // 复制代币地址
    function copyTokenAddress(el, isNative) {
        if (isNative) {
            FWUI.Toast.info('原生币无需合约地址');
            return;
        }
        const text = el.textContent.trim();
        if (!text || text === '-') {
            FWUI.Toast.warning('暂无代币地址');
            return;
        }
        copyToClipboard(text);
        FWUI.Toast.success('已复制到剪贴板');
    }

    // 添加原生币到钱包（只需切换网络）
    async function addNativeToWallet() {
        if (!window.ethereum) {
            FWUI.Toast.warning('未检测到钱包插件');
            return;
        }
        const chainId = CONFIG.getChainId();
        const rpcUrl = CONFIG.getRpcUrl();
        const symbol = CONFIG.getNativeSymbol();
        const hexChainId = '0x' + chainId.toString(16);

        try {
            await window.ethereum.request({
                method: 'wallet_switchEthereumChain',
                params: [{chainId: hexChainId}],
            });
            FWUI.Toast.success(`已切换到 ${symbol} 网络`);
        } catch (e) {
            if (e.code === 4902) {
                FWUI.Modal.confirm({
                    title: '添加网络到钱包',
                    content: `<p>钱包需要手动添加网络：</p>
                        <div style="background:var(--bg-secondary);padding:10px;border-radius:6px;font-family:monospace;font-size:12px;margin:8px 0;">
                            <div>RPC: ${rpcUrl}</div>
                            <div>Chain ID: ${chainId} (${hexChainId})</div>
                            <div>Symbol: ${symbol}</div>
                        </div>
                        <p style="color:var(--text-tertiary);font-size:11px;">路径：钱包 → 网络 → 添加自定义网络</p>`,
                    okText: '复制RPC',
                    onOk: () => copyToClipboard(rpcUrl)
                });
            } else {
                FWUI.Toast.error('切换网络失败: ' + e.message);
            }
        }
    }

    // 添加 USDC 代币到钱包
    async function addUsdcToWallet() {
        if (!window.ethereum) {
            FWUI.Toast.warning('未检测到钱包插件');
            return;
        }
        const usdcAddr = CONFIG.getSettlementTokenAddress();
        if (!usdcAddr) {
            FWUI.Toast.warning('USDC 合约未部署');
            return;
        }

        try {
            await window.ethereum.request({
                method: 'wallet_watchAsset',
                params: [{
                    type: 'ERC20',
                    options: {
                        address: usdcAddr,
                        symbol: 'USDC',
                        decimals: 6,
                    },
                }]
            });
            FWUI.Toast.success('USDC 已添加到钱包');
        } catch (e) {
            FWUI.Modal.confirm({
                title: '手动添加 USDC',
                content: `<p>请在钱包中手动添加 USDC：</p>
                    <div style="background:var(--bg-secondary);padding:10px;border-radius:6px;font-family:monospace;font-size:12px;margin:8px 0;">
                        <div>Symbol: USDC</div>
                        <div>Address: <span style="cursor:pointer;color:var(--primary-color);" onclick="App.copyTokenAddress(this)">${usdcAddr}</span></div>
                        <div>Decimals: 6</div>
                    </div>
                    <p style="color:var(--text-tertiary);font-size:11px;">路径：钱包 → 资产 → 添加自定义代币</p>`,
                okText: '复制地址',
                onOk: () => copyToClipboard(usdcAddr)
            });
        }
    }

    // 更新下拉面板中的代币信息
    function updateDropdownTokenInfo() {
        const nativeSym = CONFIG.getNativeSymbol();
        const rpcUrlEl = document.getElementById('dropdownRpcUrl');
        const chainIdEl = document.getElementById('dropdownChainId');
        const nativeAddrEl = document.getElementById('dropdownNativeAddr');
        const usdcAddrEl = document.getElementById('dropdownUsdcAddr');
        const nativeLabel = document.getElementById('walletNativeSymbolLabel');

        if (rpcUrlEl) rpcUrlEl.textContent = CONFIG.getRpcUrl();
        if (chainIdEl) chainIdEl.textContent = CONFIG.getChainId();
        if (nativeAddrEl) nativeAddrEl.textContent = '0x0000...0000';
        if (nativeLabel) nativeLabel.textContent = nativeSym;

        const usdcAddr = CONFIG.getSettlementTokenAddress();
        if (usdcAddrEl) {
            usdcAddrEl.textContent = usdcAddr ? usdcAddr : '未部署';
        }
    }

    document.addEventListener('DOMContentLoaded', init);

    return {
        init,
        // 获取当前模式
        getCurrentMode: () => currentMode,
        // 获取当前对局ID
        getCurrentGameId: () => currentGameId,
        // 代币管理
        copyTokenAddress,
        addNativeToWallet,
        addUsdcToWallet,
        updateDropdownTokenInfo
    };
})();