// 钱包管理模块
const Wallet = (function() {
    // 主动断开标记的 localStorage key
    // 作用：解决 wallet_revokePermissions 在 OKX/MetaMask 等钱包中不被支持或行为不一致
    // 导致刷新页面后 eth_accounts 仍返回账户、autoConnect 自动重连的问题
    const DISCONNECT_FLAG_KEY = 'rps_wallet_disconnected';

    let provider = null;
    let signer = null;
    let currentAddress = null;
    let currentChainId = null;
    let walletType = null;
    let isDebugMode = false;
    let isWalletConnect = false;
    // WalletConnect provider 引用（断开时需要 cleanup）
    let wcProvider = null;
    // 保存原始 EIP-1193 provider 引用，用于断开时撤销权限
    let rawProvider = null;
    // 保存事件处理函数引用，用于断开时移除监听
    let accountChangedHandler = null;
    let chainChangedHandler = null;
    let disconnectHandler = null;
    // 网络切换相关状态
    let isChainChanging = false;
    let pendingChainChange = null;
    const CHAIN_CHANGE_DELAY = 500;

    const listeners = {
        accountChanged: [],
        chainChanged: [],
        disconnect: []
    };

    // 添加事件监听器
    function on(event, callback) {
        if (listeners[event]) {
            listeners[event].push(callback);
        }
    }

    // 移除事件监听器
    function off(event, callback) {
        if (listeners[event]) {
            listeners[event] = listeners[event].filter(cb => cb !== callback);
        }
    }

    // 触发事件
    function emit(event, ...args) {
        if (listeners[event]) {
            listeners[event].forEach(cb => cb(...args));
        }
    }

    // 判断是否移动端（Deep Link 仅在移动端有意义）
    function isMobileDevice() {
        return /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent);
    }

    // Deep Link URL 映射
    const DEEP_LINK_MAP = {
        deeplink_metamask: 'https://metamask.app.link/dapp/',
        deeplink_okx: 'https://www.okx.com/web3/dapp/',
        // deeplink_tokenpocket: 'https://www.tokenpocket.pro/en/dapp?url=',  // 已注释
        // deeplink_trust: 'https://link.trustwallet.com/open_url?coin_id=60&url=',  // 已注释
        // deeplink_coinbase: 'https://coinbase.com/wallet/deeplink/connect?url='  // 已注释
    };

    // 获取可用钱包列表（按优先级排序：Injected → Deep Link → WalletConnect → Debug）
    // 仅保留4种：OKX、MetaMask、WalletConnect（扫码）、Debug（调试）
    function getAvailableWallets() {
        const wallets = [];
        const isMobile = isMobileDevice();
        const hasInject = typeof window.ethereum !== 'undefined' || window.okxwallet;

        // ===== 第1层：浏览器注入的钱包（最高优先级） — 仅保留 MetaMask 和 OKX =====
        if (typeof window.ethereum !== 'undefined') {
            if (window.ethereum.isMetaMask) {
                wallets.push({ id: 'metamask', name: '小狐狸钱包', icon: '🦊' });
            } else if (window.ethereum.isOkxWallet) {
                wallets.push({ id: 'okx', name: 'OKX钱包', icon: '🔷' });
            } else {
                // 其他注入钱包暂时归为 injected，保留但不单独识别
                wallets.push({ id: 'injected', name: '浏览器钱包', icon: '💼' });
            }
        }
        if (window.okxwallet && !wallets.find(w => w.id === 'okx')) {
            wallets.push({ id: 'okx', name: 'OKX钱包', icon: '🔷' });
        }
        // Trust Wallet — 已注释
        // if (window.trustwallet && !wallets.find(w => w.id === 'trust')) {
        //     wallets.push({ id: 'trust', name: 'Trust Wallet', icon: '💙' });
        // }
        // Coinbase Wallet — 已注释
        // if (window.coinbaseWallet) {
        //     wallets.push({ id: 'coinbase', name: 'Coinbase Wallet', icon: '🔵' });
        // }

        // ===== 第2层：Deep Link — 跳转手机钱包 App（仅移动端，且无注入钱包时） — 仅保留 MetaMask 和 OKX =====
        if (isMobile && !hasInject && typeof CONFIG !== 'undefined' && CONFIG.enableDeepLink) {
            wallets.push({ id: 'deeplink_metamask', name: '小狐狸App', icon: '🦊' });
            wallets.push({ id: 'deeplink_okx', name: 'OKX App', icon: '🔷' });
            // TokenPocket — 已注释
            // wallets.push({ id: 'deeplink_tokenpocket', name: 'TokenPocket', icon: '🟡' });
            // Trust Wallet — 已注释
            // wallets.push({ id: 'deeplink_trust', name: 'Trust Wallet App', icon: '💙' });
        }

        // ===== 第3层：WalletConnect 扫码（二维码钱包） — 通用，桌面 + 无注入的移动端 =====
        if (typeof CONFIG !== 'undefined' && CONFIG.enableWalletConnect) {
            wallets.push({ id: 'walletconnect', name: '扫码连接', icon: '📱' });
        }

        // ===== 第4层：Debug Mock（调试钱包/调色钱包） — 本地开发 fallback =====
        if (typeof CONFIG !== 'undefined' && CONFIG.enableDebugMode) {
            wallets.push({ id: 'debug', name: '调试钱包', icon: '🐛' });
        }

        return wallets;
    }

    // 根据钱包类型获取对应的Provider对象
    function getProviderByType(type) {
        if (type === 'walletconnect') {
            return wcProvider || rawProvider;
        }
        switch (type) {
            case 'metamask':
            case 'injected':
                return window.ethereum;
            case 'okx':
                return window.okxwallet || window.ethereum;
            // Trust Wallet — 已注释
            // case 'trust':
            //     return window.trustwallet || window.ethereum;
            // Coinbase Wallet — 已注释
            // case 'coinbase':
            //     return window.coinbaseWallet || window.ethereum;
            default:
                return window.ethereum;
        }
    }

    let isConnecting = false;

    // ==================== 钱包选择器 Modal ====================
    // 当有多个钱包可选时（特别是移动端无注入钱包时），弹出选择器
    function showWalletPicker(wallets) {
        return new Promise((resolve, reject) => {
            const overlay = document.createElement('div');
            overlay.style.cssText = 'position:fixed;top:0;left:0;width:100%;height:100%;background:rgba(0,0,0,0.6);z-index:99999;display:flex;align-items:center;justify-content:center;';

            const picker = document.createElement('div');
            picker.style.cssText = 'background:#fff;border-radius:12px;padding:20px;min-width:280px;max-width:420px;width:90%;box-shadow:0 20px 60px rgba(0,0,0,0.3);';

            let html = '<div style="font-size:18px;font-weight:600;margin-bottom:16px;text-align:center;">选择钱包</div>';

            wallets.forEach(w => {
                const isNew = w.id.startsWith('deeplink_');
                const isQR = w.id === 'walletconnect';
                const tag = isNew ? '<span style="font-size:10px;background:#e0f2fe;color:#0369a1;padding:2px 6px;border-radius:4px;margin-left:6px;">新</span>' :
                            isQR ? '<span style="font-size:10px;background:#fef3c7;color:#b45309;padding:2px 6px;border-radius:4px;margin-left:6px;">扫码</span>' : '';
                html += `<button data-wid="${w.id}" style="display:flex;align-items:center;width:100%;padding:12px 16px;margin-bottom:8px;border:1px solid #e5e7eb;border-radius:8px;background:#f9fafb;cursor:pointer;font-size:14px;text-align:left;transition:all 0.15s;">
                    <span style="font-size:20px;margin-right:10px;">${w.icon}</span>
                    <span style="flex:1;">${w.name}</span>${tag}
                </button>`;
            });

            const closeBtn = '<button data-close style="width:100%;padding:10px;border:none;background:transparent;cursor:pointer;color:#6b7280;font-size:13px;">取消</button>';
            picker.innerHTML = html + closeBtn;

            overlay.appendChild(picker);
            document.body.appendChild(overlay);

            const cleanup = () => {
                if (overlay.parentNode) overlay.parentNode.removeChild(overlay);
            };

            picker.addEventListener('click', (e) => {
                const btn = e.target.closest('button');
                if (!btn) return;
                if (btn.dataset.wid) {
                    const wid = btn.dataset.wid;
                    cleanup();
                    resolve(wid);
                } else if (btn.dataset.close) {
                    cleanup();
                    reject(new Error('用户取消'));
                }
            });

            overlay.addEventListener('click', (e) => {
                if (e.target === overlay) {
                    cleanup();
                    reject(new Error('用户取消'));
                }
            });
        });
    }

    // ==================== Deep Link 连接 ====================
    async function connectDeepLink(walletId) {
        const base = DEEP_LINK_MAP[walletId];
        if (!base) throw new Error('不支持的 Deep Link 钱包');

        const dappUrl = window.location.origin + window.location.pathname;
        const targetUrl = base + encodeURIComponent(dappUrl);

        const walletNames = {
            deeplink_metamask: '小狐狸',
            deeplink_okx: 'OKX',
            // deeplink_tokenpocket: 'TokenPocket',  // 已注释
            // deeplink_trust: 'Trust Wallet'  // 已注释
        };
        const name = walletNames[walletId] || '钱包';

        if (typeof FWUI !== 'undefined' && FWUI.Modal) {
            FWUI.Modal.confirm({
                title: `打开 ${name} App`,
                content: `<div style="line-height:2;">
                    <p>即将打开 <b>${name}</b> App。</p>
                    <p>在 App 中授权连接后，会自动打开 dApp。</p>
                    <p style="color:#888;font-size:12px;">如果没有自动打开，请确认已安装 ${name} App。</p>
                </div>`,
                okText: '打开',
                cancelText: '取消',
                onOk: () => {
                    window.location.href = targetUrl;
                }
            });
        } else {
            // 直接跳转
            window.location.href = targetUrl;
        }
        return null;
    }

    // ==================== WalletConnect V2 连接 ====================
    // 动态懒加载 SDK（避免首屏加载 ~200KB）
    // 注意：UMD 包的全局名是 "@walletconnect/ethereum-provider"（带斜杠），不是 WalletConnectEthereumProvider
    function loadWalletConnectSDK() {
        // 尝试多个可能的全局名（UMD 模式导出）
        const GLOBAL_KEYS = [
            '@walletconnect/ethereum-provider',   // v2.x UMD 实际导出名
            'WalletConnectEthereumProvider',        // 旧版本/其他打包方式
            'WalletConnect'                         // 备选
        ];

        // 先检查是否已加载过
        for (const key of GLOBAL_KEYS) {
            if (window[key]) {
                const mod = window[key];
                const resolved = mod.__esModule && mod.default ? mod.default : mod;
                // 可能导出是空对象（UMD factory 执行失败），检查是否有用
                if (typeof resolved.init === 'function' || typeof resolved === 'function') {
                    return Promise.resolve(resolved);
                }
            }
        }
        if (window.__wcLoadingPromise) {
            return window.__wcLoadingPromise;
        }

        // 使用 jsdelivr CDN（比 unpkg 更稳定，且支持 .min.js）
        const CDN_PATHS = [
            'https://cdn.jsdelivr.net/npm/@walletconnect/ethereum-provider@2.13.0/dist/index.umd.js',
            'https://unpkg.com/@walletconnect/ethereum-provider@2.13.0/dist/index.umd.js'
        ];

        window.__wcLoadingPromise = new Promise((resolve, reject) => {
            let scriptLoaded = false;
            let currentIndex = 0;
            let timeoutId = null;

            const tryResolve = () => {
                for (const key of GLOBAL_KEYS) {
                    if (window[key]) {
                        const mod = window[key];
                        const resolved = mod.__esModule && mod.default ? mod.default : mod;
                        if (typeof resolved.init === 'function' || typeof resolved === 'function') {
                            if (timeoutId) clearTimeout(timeoutId);
                            resolve(resolved);
                            return true;
                        }
                    }
                }
                return false;
            };

            const loadScript = (index) => {
                if (index >= CDN_PATHS.length) {
                    if (timeoutId) clearTimeout(timeoutId);
                    reject(new Error('WalletConnect SDK 加载失败：所有 CDN 路径都无法正常导出模块'));
                    return;
                }
                const script = document.createElement('script');
                script.src = CDN_PATHS[index];
                script.async = true;

                script.onload = () => {
                    // 给 UMD factory 一点时间执行（某些环境 script.onload 早于 factory 完成）
                    setTimeout(() => {
                        if (tryResolve()) return;
                        // 导出为空对象 → 尝试下一个 CDN
                        console.warn(`WalletConnect SDK from ${CDN_PATHS[index]} 导出为空，尝试下一个...`);
                        loadScript(index + 1);
                    }, 100);
                };

                script.onerror = () => {
                    console.warn(`WalletConnect SDK CDN ${CDN_PATHS[index]} 加载失败`);
                    loadScript(index + 1);
                };

                document.head.appendChild(script);
            };

            // 总超时 20s
            timeoutId = setTimeout(() => {
                reject(new Error('WalletConnect SDK 加载超时（20 秒），请检查网络'));
            }, 20000);

            loadScript(currentIndex);
        });

        return window.__wcLoadingPromise;
    }

    async function connectWalletConnect() {
        if (typeof FWUI !== 'undefined' && FWUI.Toast) {
            FWUI.Toast.info('正在加载 WalletConnect...');
        }

        let WCEP;
        try {
            WCEP = await loadWalletConnectSDK();
        } catch (e) {
            if (typeof FWUI !== 'undefined' && FWUI.Toast) FWUI.Toast.error(e.message);
            throw e;
        }

        const projectId = (typeof CONFIG !== 'undefined' && CONFIG.walletConnectProjectId) || '046737702b5a6cf128b6411e93d87d8b';
        const chainId = (typeof CONFIG !== 'undefined' && CONFIG.getChainId && CONFIG.getChainId()) || 5208888;
        const network = (typeof CONFIG !== 'undefined' && CONFIG.getNetwork && CONFIG.getNetwork(chainId)) || null;
        const rpcUrl = network ? network.rpcUrl : 'http://127.0.0.1:8686';

        // 创建 WalletConnect provider
        // showQrModal: WalletConnect 自带二维码弹窗，用户扫码授权
        const provider = await WCEP.init({
            projectId: projectId,
            chains: [chainId],
            rpcMap: { [chainId]: rpcUrl },
            showQrModal: true,
            metadata: {
                name: 'ChainRPS',
                description: '链上公平猜拳（石头剪刀布）',
                url: window.location.origin,
                icons: [window.location.origin + '/img/ChainRPS.png']
            }
        });

        // 等待用户扫码并授权（阻塞直到成功）
        await provider.enable();

        // WalletConnect provider 完全兼容 EIP-1193 接口
        // 直接复用现有 connect() 后半段逻辑
        wcProvider = provider;
        rawProvider = provider;
        isWalletConnect = true;

        const accounts = await provider.request({ method: 'eth_accounts' });
        if (!accounts || accounts.length === 0) {
            throw new Error('WalletConnect 连接失败：未获取到账户');
        }

        currentAddress = accounts[0];
        walletType = 'walletconnect';

        if (typeof window.ethers === 'undefined') {
            throw new Error('ethers.js 未加载');
        }

        provider = new ethers.BrowserProvider(provider);
        signer = await provider.getSigner();

        const net = await provider.getNetwork();
        currentChainId = Number(net.chainId);

        setupEventListeners(rawProvider);

        emit('accountChanged', currentAddress);
        emit('chainChanged', currentChainId);

        if (typeof FWUI !== 'undefined' && FWUI.Toast) {
            FWUI.Toast.success('WalletConnect 连接成功！');
        }

        return { address: currentAddress, chainId: currentChainId, walletType: 'walletconnect' };
    }

    // 连接钱包
    // opts.forcePicker: true 时强制弹出钱包选择器（跳过单钱包自动选择）
    async function connect(type = null, opts = {}) {
        if (isConnecting) {
            return { address: currentAddress, chainId: currentChainId, walletType: walletType };
        }
        isConnecting = true;

        // 用户主动连接，清除"已主动断开"标记
        try { localStorage.removeItem(DISCONNECT_FLAG_KEY); } catch (e) {}

        try {
            const availableWallets = getAvailableWallets();

            if (availableWallets.length === 0) {
                throw new Error('未检测到 Web3 钱包，请先安装 MetaMask 或其他钱包');
            }

            // ===== 决定连接哪个钱包 =====
            let resolvedType = type;

            if (!resolvedType) {
                const injectWallets = availableWallets.filter(w => !w.id.startsWith('deeplink_') && w.id !== 'walletconnect' && w.id !== 'debug');
                // forcePicker 为 true → 始终弹出选择器（桌面端主动选择入口）
                // 只有 1 个注入钱包 且非强制选择 且桌面端 → 直接用（最常见的桌面 MetaMask 场景）
                if (!opts.forcePicker && injectWallets.length === 1 && !isMobileDevice()) {
                    resolvedType = injectWallets[0].id;
                }
                // 只有 debug 一个 → 直接用
                else if (!opts.forcePicker && availableWallets.length === 1 && availableWallets[0].id === 'debug') {
                    resolvedType = 'debug';
                }
                // 其他情况（强制选择、多钱包、移动端）→ 弹出选择器
                else {
                    try {
                        resolvedType = await showWalletPicker(availableWallets);
                    } catch (pickerErr) {
                        throw pickerErr; // 用户取消
                    }
                }
            }

            // ===== 分派到对应连接逻辑 =====
            if (resolvedType === 'debug' && typeof CONFIG !== 'undefined' && CONFIG.enableDebugMode) {
                return connectDebugWallet();
            }

            if (resolvedType === 'walletconnect') {
                return await connectWalletConnect();
            }

            if (resolvedType.startsWith('deeplink_')) {
                return await connectDeepLink(resolvedType);
            }

            // === 以下为注入钱包（MetaMask/OKX/Trust 等）原有逻辑，不变 ===
            if (typeof window.ethers === 'undefined') {
                throw new Error('ethers.js 未加载');
            }

            const providerObj = getProviderByType(resolvedType);
            if (!providerObj) {
                throw new Error('指定的钱包未安装');
            }

            try {
                const accounts = await providerObj.request({ method: 'eth_requestAccounts' });
                if (accounts.length === 0) {
                    throw new Error('用户拒绝连接');
                }

                currentAddress = accounts[0];
                walletType = resolvedType;
                rawProvider = providerObj;

                provider = new ethers.BrowserProvider(providerObj);
                signer = await provider.getSigner();

                const network = await provider.getNetwork();
                currentChainId = Number(network.chainId);

                setupEventListeners(providerObj);

                emit('accountChanged', currentAddress);
                emit('chainChanged', currentChainId);

                return { address: currentAddress, chainId: currentChainId, walletType: walletType };
            } catch (error) {
                if (error.code === 4001) {
                    throw new Error('用户拒绝连接钱包');
                }
                throw error;
            }
        } finally {
            isConnecting = false;
        }
    }

    // 连接调试钱包（仅用于预览模式）
    function connectDebugWallet() {
        isDebugMode = true;
        currentAddress = CONFIG.debugWalletAddress;
        walletType = 'debug';
        currentChainId = CONFIG.getChainId ? CONFIG.getChainId() : 5208888;

        emit('accountChanged', currentAddress);
        emit('chainChanged', currentChainId);

        FWUI.Toast.info('已连接调试钱包（仅用于预览）');
        
        return {
            address: currentAddress,
            chainId: currentChainId,
            walletType: walletType
        };
    }

    // 自动连接钱包（无需用户手动点击）
    async function autoConnect() {
        if (!window.ethereum) {
            return null;
        }
        // 用户之前主动断开过，则不自动重连（需用户再次手动点击连接）
        // 这是解决 wallet_revokePermissions 不被 OKX/MetaMask 等钱包支持的关键
        if (localStorage.getItem(DISCONNECT_FLAG_KEY) === '1') {
            return null;
        }
        if (isConnected()) {
            return {
                address: currentAddress,
                chainId: currentChainId,
                walletType: walletType
            };
        }
        if (isConnecting) {
            return null;
        }
        isConnecting = true;

        try {
            // 第一步：静默查询已有账户（用户之前授权过的情况）
            let accounts = await window.ethereum.request({ method: 'eth_accounts' });

            // 第二步：静默查询为空 → 主动尝试请求授权一次（仅限首次自动连接）
            if (!accounts || accounts.length === 0) {
                // 使用 sessionStorage 确保每个标签页会话只主动请求一次
                // 避免用户多次导航到大厅时反复弹窗打扰
                const tried = sessionStorage.getItem('rps_auto_connect_tried');
                if (!tried) {
                    sessionStorage.setItem('rps_auto_connect_tried', '1');
                    try {
                        accounts = await window.ethereum.request({ method: 'eth_requestAccounts' });
                    } catch (reqErr) {
                        // 用户拒绝（4001）或钱包/浏览器拦截非 user gesture 请求 → 静默放弃
                        if (reqErr && (reqErr.code === 4001 || reqErr.code === -32002)) {
                            console.log('[Wallet] 自动连接被用户拒绝或钱包拦截:', reqErr.message);
                        } else {
                            console.log('[Wallet] 自动连接请求异常:', reqErr && reqErr.message);
                        }
                        return null;
                    }
                } else {
                    return null;
                }
            }

            if (!accounts || accounts.length === 0) {
                return null;
            }

            const address = accounts[0];
            
            const providerObj = window.ethereum;
            provider = new ethers.BrowserProvider(providerObj);
            signer = await provider.getSigner();
            const network = await provider.getNetwork();

            currentAddress = address;
            currentChainId = Number(network.chainId);
            walletType = 'auto';
            rawProvider = providerObj;

            setupEventListeners(providerObj);

            emit('accountChanged', currentAddress);
            emit('chainChanged', currentChainId);

            return {
                address: currentAddress,
                chainId: currentChainId,
                walletType: walletType
            };
        } catch (e) {
            console.log('Auto-connect failed:', e.message);
            return null;
        } finally {
            isConnecting = false;
        }
    }

    // 设置钱包事件监听器（账户变更、链变更、断开连接）
    function setupEventListeners(providerObj) {
        if (providerObj.on) {
            // 账户变更事件处理器
            accountChangedHandler = (accounts) => {
                if (accounts.length === 0) {
                    disconnect();
                } else {
                    currentAddress = accounts[0];
                    emit('accountChanged', currentAddress);
                }
            };

            // 链变更事件处理器（带防重入和延迟处理）
            chainChangedHandler = async (chainId) => {
                const newChainId = parseInt(chainId, 16);
                const oldChainId = currentChainId;
                
                // 如果正在切换中，保存最新的 chainId 待处理
                if (isChainChanging) {
                    pendingChainChange = newChainId;
                    return;
                }
                
                isChainChanging = true;
                currentChainId = newChainId;
                
                try {
                    // 延迟一小段时间让钱包完成内部切换
                    await new Promise(resolve => setTimeout(resolve, CHAIN_CHANGE_DELAY));
                    
                    // 销毁旧 provider
                    if (provider && typeof provider.destroy === 'function') {
                        try {
                            provider.destroy();
                        } catch (e) {
                            console.warn('销毁旧 provider 失败:', e.message);
                        }
                    }
                    provider = null;
                    signer = null;
                    
                    // 重新创建 provider 和 signer
                    if (rawProvider) {
                        let retryCount = 0;
                        const maxRetries = 3;
                        
                        while (retryCount < maxRetries) {
                            try {
                                provider = new ethers.BrowserProvider(rawProvider);
                                signer = await provider.getSigner();
                                
                                // 验证新 provider 能正常连接
                                const network = await provider.getNetwork();
                                const verifiedChainId = Number(network.chainId);
                                
                                if (verifiedChainId === newChainId) {
                                    break; // 成功
                                } else {
                                    console.warn(`Provider 链ID不匹配: 期望 ${newChainId}, 实际 ${verifiedChainId}, 重试 ${retryCount + 1}/${maxRetries}`);
                                }
                            } catch (e) {
                                retryCount++;
                                console.warn(`chainChanged 后重新创建 provider 失败 (${retryCount}/${maxRetries}):`, e.message);
                                if (retryCount >= maxRetries) {
                                    throw e;
                                }
                                await new Promise(resolve => setTimeout(resolve, 200 * retryCount));
                            }
                        }
                    }
                    
                    emit('chainChanged', currentChainId);
                    
                    // 如果有待处理的 chain change，处理它
                    if (pendingChainChange !== null) {
                        const nextChainId = pendingChainChange;
                        pendingChainChange = null;
                        isChainChanging = false;
                        chainChangedHandler(nextChainId); // 递归处理
                    }
                } catch (e) {
                    console.error('chainChanged 处理失败:', e);
                    emit('chainChanged', currentChainId);
                } finally {
                    if (pendingChainChange === null) {
                        isChainChanging = false;
                    }
                }
            };

            // 断开连接事件处理器
            disconnectHandler = () => {
                disconnect();
            };

            providerObj.on('accountsChanged', accountChangedHandler);
            providerObj.on('chainChanged', chainChangedHandler);
            providerObj.on('disconnect', disconnectHandler);
        }
    }

    // 移除钱包事件监听器
    function removeEventListeners(providerObj) {
        if (providerObj && providerObj.removeListener) {
            if (accountChangedHandler) providerObj.removeListener('accountsChanged', accountChangedHandler);
            if (chainChangedHandler) providerObj.removeListener('chainChanged', chainChangedHandler);
            if (disconnectHandler) providerObj.removeListener('disconnect', disconnectHandler);
        }
        accountChangedHandler = null;
        chainChangedHandler = null;
        disconnectHandler = null;
    }

    // 断开钱包连接
    async function disconnect() {
        const wasConnected = currentAddress !== null;
        const providerObj = rawProvider;
        const wasWalletConnect = isWalletConnect;

        currentAddress = null;
        currentChainId = null;
        signer = null;
        provider = null;
        walletType = null;
        isDebugMode = false;
        isWalletConnect = false;

        // 移除事件监听器
        removeEventListeners(providerObj);

        // 设置"已主动断开"标记：刷新页面后 autoConnect 检查此标记跳过自动重连
        try { localStorage.setItem(DISCONNECT_FLAG_KEY, '1'); } catch (e) {}

        // 真正与钱包断开
        if (wasConnected && providerObj && providerObj.request) {
            // WalletConnect 有自己的断开方法
            if (wasWalletConnect && wcProvider) {
                try {
                    await wcProvider.disconnect();
                } catch (e) {
                    console.warn('WalletConnect 断开异常：', e.message);
                }
                wcProvider = null;
            } else {
                // 传统 EIP-1193：撤销权限
                try {
                    await providerObj.request({
                        method: 'wallet_revokePermissions',
                        params: [{ eth_accounts: {} }]
                    });
                } catch (e) {
                    console.warn('钱包不支持 wallet_revokePermissions，已设置本地断开标记');
                }
            }
        }

        rawProvider = null;
        emit('disconnect');
    }

    // 检查钱包是否已连接
    function isConnected() {
        return currentAddress !== null && (isDebugMode || signer !== null);
    }

    // 获取当前钱包地址
    function getAddress() {
        return currentAddress;
    }

    // 获取当前链ID
    function getChainId() {
        return currentChainId;
    }

    // 获取当前钱包类型
    function getWalletType() {
        return walletType;
    }

    // 获取 Provider 实例
    function getProvider() {
        return provider;
    }

    // 获取 Signer 实例
    function getSigner() {
        return signer;
    }

    // 验证地址格式是否合法
    function isValidAddress(addr) {
        return typeof addr === 'string' && /^0x[a-fA-F0-9]{40}$/.test(addr);
    }

    // 获取钱包余额（支持原生币和代币）
    async function getBalance(tokenAddress = null) {
        if (!currentAddress) {
            return '0';
        }

        if (isDebugMode && typeof CONFIG !== 'undefined') {
            return CONFIG.debugBalance.toString();
        }

        if (!provider) {
            return '0';
        }

        if (!tokenAddress || tokenAddress === '0x0000000000000000000000000000000000000000') {
            const balance = await provider.getBalance(currentAddress);
            return ethers.formatEther(balance);
        } else if (!isValidAddress(tokenAddress)) {
            return '0';
        } else {
            try {
                const abi = [
                    'function balanceOf(address account) view returns (uint256)',
                    'function decimals() view returns (uint8)'
                ];
                const contract = new ethers.Contract(tokenAddress, abi, provider);
                const balance = await contract.balanceOf(currentAddress);
                const decimals = await contract.decimals();
                return ethers.formatUnits(balance, decimals);
            } catch (e) {
                console.warn('获取代币余额失败:', tokenAddress, e.message);
                return '0';
            }
        }
    }

    // 切换钱包网络
    async function switchChain(chainId) {
        const providerObj = getProviderByType(walletType);
        if (!providerObj) {
            throw new Error('钱包未连接');
        }

        const hexChainId = '0x' + chainId.toString(16);

        try {
            await providerObj.request({
                method: 'wallet_switchEthereumChain',
                params: [{ chainId: hexChainId }]
            });
            return true;
        } catch (switchError) {
            console.warn('switchChain 失败:', switchError);
            const code = switchError.code;
            const message = switchError.message || '';
            // 不同钱包可能返回不同的错误码和错误信息
            // 4902: MetaMask 未添加该链
            // -32603: 某些钱包内部错误（也可能表示未添加）
            // 错误信息中包含 "未添加" 或 "not added" 或 "not find" 等关键词也视为未添加
            const isNotAdded = (
                code === 4902 ||
                code === -32603 ||
                message.indexOf('未添加') !== -1 ||
                message.indexOf('not added') !== -1 ||
                message.indexOf('not find') !== -1 ||
                message.indexOf('not_find') !== -1 ||
                message.indexOf('Unrecognized chain') !== -1 ||
                message.indexOf('unrecognized chain') !== -1
            );
            if (isNotAdded) {
                const err = new Error('钱包中未添加该网络');
                err.code = 4902;
                err.originalError = switchError;
                throw err;
            }
            throw switchError;
        }
    }

    // 添加区块链网络到钱包
    async function addChain(chainConfig) {
        const providerObj = getProviderByType(walletType);
        if (!providerObj) {
            throw new Error('钱包未连接');
        }

        const hexChainId = '0x' + chainConfig.chainId.toString(16);
        const rpcUrl = (chainConfig.rpcUrls && chainConfig.rpcUrls[0]) || '';
        const isLocalHttp = rpcUrl.startsWith('http://') && (
            rpcUrl.includes('127.0.0.1') ||
            rpcUrl.includes('localhost') ||
            rpcUrl.includes('0.0.0.0')
        );

        const params = {
            chainId: hexChainId,
            chainName: chainConfig.chainName || `Chain #${chainConfig.chainId}`,
            rpcUrls: chainConfig.rpcUrls || [],
            nativeCurrency: chainConfig.nativeCurrency || {
                name: CONFIG.getNativeName ? CONFIG.getNativeName() : 'Native',
                symbol: CONFIG.getNativeSymbol(),
                decimals: 18
            },
        };

        if (chainConfig.blockExplorerUrls && chainConfig.blockExplorerUrls.length > 0) {
            params.blockExplorerUrls = chainConfig.blockExplorerUrls;
        }

        if (isLocalHttp) {
            console.log('本地链 HTTP RPC  detected, 跳过 wallet_addEthereumChain，提示用户手动添加');
            const displayParams = {
                chainId: chainConfig.chainId,
                chainIdHex: hexChainId,
                chainName: params.chainName,
                rpcUrl: rpcUrl,
                nativeCurrency: params.nativeCurrency,
                blockExplorerUrls: params.blockExplorerUrls || [],
            };
            if (typeof FWUI !== 'undefined' && FWUI && FWUI.Modal) {
                FWUI.Modal.confirm({
                    title: '添加本地测试网络',
                    content: `
                        <div style="line-height:1.8;">
                            <p>您正在使用本地测试链（HTTP RPC），钱包出于安全考虑不允许通过 <code>wallet_addEthereumChain</code> 添加 HTTP 网络。</p>
                            <p>请手动在钱包中添加以下网络配置：</p>
                            <div style="background:#f5f5f5;padding:12px;border-radius:6px;font-family:monospace;font-size:13px;margin:12px 0;">
                                <div><b>Network Name:</b> ${displayParams.chainName}</div>
                                <div><b>New RPC URL:</b> ${displayParams.rpcUrl}</div>
                                <div><b>Chain ID:</b> ${displayParams.chainId} (${displayParams.chainIdHex})</div>
                                <div><b>Currency Symbol:</b> ${displayParams.nativeCurrency.symbol}</div>
                                <div><b>Decimals:</b> ${displayParams.nativeCurrency.decimals}</div>
                            </div>
                            <p style="color:#888;font-size:12px;">操作路径：钱包 -> 网络 -> 添加自定义网络 -> 填入以上信息</p>
                        </div>
                    `,
                    okText: '我知道了',
                    cancelText: '关闭',
                    onOk: () => {
                        FWUI.Toast.success('请在钱包中手动添加网络后刷新页面');
                    }
                });
            } else {
                alert(
                    '请手动在钱包中添加以下本地测试网络：\n\n' +
                    `Network Name: ${displayParams.chainName}\n` +
                    `RPC URL: ${displayParams.rpcUrl}\n` +
                    `Chain ID: ${displayParams.chainId} (${displayParams.chainIdHex})\n` +
                    `Symbol: ${displayParams.nativeCurrency.symbol}\n` +
                    `Decimals: ${displayParams.nativeCurrency.decimals}\n\n` +
                    '操作：钱包 -> 网络 -> 添加自定义网络'
                );
            }
            throw new Error('本地链 HTTP RPC 需手动添加到钱包，已显示指引');
        }

        console.log('调用 wallet_addEthereumChain, params:', params);

        try {
            const result = await providerObj.request({
                method: 'wallet_addEthereumChain',
                params: [params]
            });
            console.log('wallet_addEthereumChain 返回:', result);
            return true;
        } catch (addError) {
            console.error('wallet_addEthereumChain 失败:', addError);
            throw addError;
        }
    }

    // 切换或添加网络（自动处理网络未添加的情况）
    async function switchOrAddChain(chainConfig) {
        console.log('switchOrAddChain 开始, 目标 chainId:', chainConfig.chainId);
        try {
            await switchChain(chainConfig.chainId);
            console.log('switchOrAddChain: 直接切换成功');
            return true;
        } catch (error) {
            console.log('switchOrAddChain: 切换失败，尝试添加网络, 错误:', error.message);
            if (error.message === '钱包中未添加该网络') {
                try {
                    await addChain(chainConfig);
                    console.log('switchOrAddChain: 添加网络成功，等待切换...');
                    // 添加成功后，某些钱包会自动切换，某些需要手动再切换一次
                    // 我们尝试再切换一次，如果用户已经确认添加，应该能成功
                    try {
                        await switchChain(chainConfig.chainId);
                        console.log('switchOrAddChain: 添加后切换成功');
                        return true;
                    } catch (e2) {
                        // 如果用户刚添加但还没确认切换，可能需要等待
                        // 这里我们返回 true，因为添加已经成功了，切换会由钱包事件触发
                        console.log('switchOrAddChain: 添加网络已提交，等待钱包切换事件');
                        return true;
                    }
                } catch (addError) {
                    const addMsg = (addError.message || '').toLowerCase();
                    console.error('switchOrAddChain: 添加网络失败:', addMsg);

                    if (addMsg.indexOf('手动添加') !== -1 || addMsg.indexOf('manual') !== -1) {
                        try {
                            await switchChain(chainConfig.chainId);
                            console.log('switchOrAddChain: 手动添加后切换成功');
                            return true;
                        } catch (e2) {
                            console.log('switchOrAddChain: 尚未添加网络，等待用户手动添加');
                            return false;
                        }
                    }

                    // 特殊处理：同 RPC 不同 chain ID
                    // MetaMask 等钱包在添加已存在的 RPC 节点但 chainId 不同时会报错
                    // 错误信息类似 "same rpc endpoint" 或 "existing network" 或 "already exists"
                    // 从错误信息中提取已存在的 chain ID 并切换
                    // 从错误信息中提取已存在的链 ID
                    const extractExistingChain = (msg) => {
                        const m = (msg || '').match(/chain\s+(0x[0-9a-fA-F]+)/i);
                        if (m) return m[1];
                        // 也尝试匹配十进制数字
                        const m2 = (msg || '').match(/chain id\s*[:=]?\s*(\d+)/i);
                        if (m2) return '0x' + parseInt(m2[1]).toString(16);
                        return null;
                    };

                    const isSameRpc = (
                        addMsg.includes('same rpc endpoint') ||
                        addMsg.includes('existing network') ||
                        addMsg.includes('already exists') ||
                        addMsg.includes('已存在') ||
                        addMsg.includes('already have')
                    );

                    const existingHex = extractExistingChain(addError.message || addError.toString());

                    if (isSameRpc && existingHex) {
                        const existingDec = parseInt(existingHex, 16);
                        console.log(`switchOrAddChain: 检测到已有同 RPC 网络 (ChainID: ${existingDec})，正在切换...`);
                        try {
                            await switchChain(existingDec);
                            console.log('switchOrAddChain: 切换到已存在网络成功');
                            // 更新 chainConfig.chainId 为实际存在的那个
                            chainConfig.chainId = existingDec;
                            return true;
                        } catch (e2) {
                            console.error('switchOrAddChain: 切换到已存在网络失败:', e2);
                            throw new Error('切换网络失败: ' + (e2.message || e2));
                        }
                    }

                    throw new Error('添加网络失败: ' + (addError.message || addError));
                }
            }
            console.error('switchOrAddChain: 切换失败且不是未添加网络的错误:', error);
            throw error;
        }
    }

    // 添加代币到钱包（用于在钱包中显示自定义代币）
    async function addToken(tokenAddress, symbol, decimals, image = null) {
        const providerObj = getProviderByType(walletType);
        if (!providerObj) {
            throw new Error('钱包未连接');
        }

        try {
            await providerObj.request({
                method: 'wallet_watchAsset',
                params: {
                    type: 'ERC20',
                    options: {
                        address: tokenAddress,
                        symbol: symbol,
                        decimals: decimals,
                        image: image
                    }
                }
            });
            return true;
        } catch (error) {
            return false;
        }
    }

    // 格式化地址显示（缩略中间字符）
    function formatAddress(address, length = 6) {
        if (!address) return '';
        if (address.length <= length * 2 + 4) return address;
        return address.slice(0, length) + '...' + address.slice(-length);
    }

    // 返回钱包实例
    return {
        connect,
        disconnect,
        autoConnect,
        isConnected,
        getAddress,
        getChainId,
        getWalletType,
        getProvider,
        getSigner,
        getBalance,
        switchChain,
        addChain,
        switchOrAddChain,
        addToken,
        formatAddress,
        getAvailableWallets,
        on,
        off
    };
})();