// 钱包管理模块
const Wallet = (function() {
    // 主动断开标记的 localStorage key
    // 作用：解决 wallet_revokePermissions 在 OKX/MetaMask 等钱包中不被支持或行为不一致
    // 导致刷新页面后 eth_accounts 仍返回账户、autoConnect 自动重连的问题
    const DISCONNECT_FLAG_KEY = 'rps_wallet_disconnected';
    const LAST_WALLET_TYPE_KEY = 'rps_last_wallet_type';

    let provider = null;
    let signer = null;
    let currentAddress = null;
    let currentChainId = null;
    let walletType = null;
    let isDebugMode = false;
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

    // 获取可用钱包列表
    // 关键：OKX + MetaMask 同时装时，后装的那个覆盖 window.ethereum，
    // 先装的被挪到 window.ethereum.providers 数组里
    // ⚠️ OKX 会伪装成 MetaMask（同时设置 isOkxWallet + isMetaMask）
    //    所以判断顺序必须是：先 isOkxWallet，再 isMetaMask！
    function getAvailableWallets() {
        const wallets = [];
        const seen = new Set();

        // 先诊断所有 provider — F12 console 能看到真实标志
        console.groupCollapsed('[Wallet] 扫描所有 provider');
        if (typeof window.ethereum !== 'undefined') {
            const all = window.ethereum.providers || [window.ethereum];
            all.forEach((p, i) => {
                console.info(`  provider[${i}]: isMetaMask=${p.isMetaMask}, isOkxWallet=${p.isOkxWallet}, isTrust=${p.isTrust}, isCoinbase=${p.isCoinbaseWallet}, _events=${Object.keys(p._events||{}).length}`);
            });
        }
        if (window.okxwallet) console.info('  window.okxwallet: isOkxWallet=', window.okxwallet.isOkxWallet);
        if (window.trustwallet) console.info('  window.trustwallet: isTrust=', window.trustwallet.isTrust);
        console.groupEnd();

        // 1️⃣ 遍历 window.ethereum.providers —— 先查 isOkxWallet（OKX 会同时设 isMetaMask，必须先判断）
        if (typeof window.ethereum !== 'undefined') {
            const providers = window.ethereum.providers || [window.ethereum];
            for (const p of providers) {
                let id, name, icon;
                // ⚠️ 顺序！isOkxWallet 必须在 isMetaMask 前面！
                if (p.isOkxWallet) {
                    id = 'okx'; name = 'OKX Wallet'; icon = '🔷';
                } else if (p.isCoinbaseWallet || p.isCoinbaseExtension) {
                    id = 'coinbase'; name = 'Coinbase Wallet'; icon = '🔵';
                } else if (p.isTrust) {
                    id = 'trust'; name = 'Trust Wallet'; icon = '💙';
                } else if (p.isMetaMask) {
                    id = 'metamask'; name = 'MetaMask'; icon = '🦊';
                } else {
                    continue;
                }
                if (!seen.has(id)) {
                    seen.add(id);
                    wallets.push({ id, name, icon, provider: p });
                }
            }
        }

        // 2️⃣ 顶层独立注入
        if (window.okxwallet && !seen.has('okx')) {
            seen.add('okx');
            wallets.push({ id: 'okx', name: 'OKX Wallet', icon: '🔷', provider: window.okxwallet });
        }
        if (window.trustwallet && !seen.has('trust')) {
            seen.add('trust');
            wallets.push({ id: 'trust', name: 'Trust Wallet', icon: '💙', provider: window.trustwallet });
        }
        if (window.coinbaseWallet && !seen.has('coinbase')) {
            seen.add('coinbase');
            wallets.push({ id: 'coinbase', name: 'Coinbase Wallet', icon: '🔵', provider: window.coinbaseWallet });
        }

        // 3️⃣ 兜底：window.ethereum 顶层（当 providers 数组不存在时）
        if (typeof window.ethereum !== 'undefined' && (!window.ethereum.providers || window.ethereum.providers.length === 0)) {
            if (window.ethereum.isOkxWallet && !seen.has('okx')) {
                wallets.push({ id: 'okx', name: 'OKX Wallet', icon: '🔷', provider: window.ethereum });
            } else if (window.ethereum.isMetaMask && !seen.has('metamask')) {
                wallets.push({ id: 'metamask', name: 'MetaMask', icon: '🦊', provider: window.ethereum });
            } else if (!seen.has('injected')) {
                wallets.push({ id: 'injected', name: 'Injected Wallet', icon: '💼', provider: window.ethereum });
            }
        }

        // Debug Wallet（默认关，只在 enableDebugMode=true 时出现）
        if (typeof CONFIG !== 'undefined' && CONFIG.enableDebugMode) {
            wallets.push({ id: 'debug', name: 'Debug Wallet', icon: '🐛' });
        }

        console.info('[Wallet] 检测到钱包:', wallets.map(w => w.id + '(' + w.name + ')').join(', '));
        return wallets;
    }

    // 根据钱包类型获取对应的Provider对象
    // 关键：从 window.ethereum.providers 数组里找，而不是顶层（OKX/MetaMask 共存时顶层是后装的那个）
    function getProviderByType(type) {
        // 从 getAvailableWallets() 里直接取已匹配好的 provider（包含 providers 数组遍历）
        const available = getAvailableWallets();
        const match = available.find(w => w.id === type);
        if (match && match.provider) return match.provider;

        // 兜底：顶层注入
        if (type === 'okx') return window.okxwallet || window.ethereum;
        if (type === 'trust') return window.trustwallet || window.ethereum;
        if (type === 'coinbase') return window.coinbaseWallet || window.ethereum;
        return window.ethereum;
    }

    // wallet_requestPermissions 返回格式兼容：
    // MetaMask: { "0x...": { parentCapabilities: ... } }  或 [{ parentCapability: 'eth_accounts', ... }]
    // OKX: 可能直接返回账户数组
    function extractAccountsFromPermissions(perms) {
        // 格式 A：直接是数组（OKX 某些版本）
        if (Array.isArray(perms) && perms.length > 0 && typeof perms[0] === 'string' && perms[0].startsWith('0x')) {
            return perms;
        }
        // 格式 B：权限对象里找 eth_accounts
        if (perms && typeof perms === 'object') {
            // 某些钱包把账户藏在 eth_accounts.accounts 里
            if (perms.eth_accounts && Array.isArray(perms.eth_accounts.accounts)) {
                return perms.eth_accounts.accounts;
            }
            // 格式 C：wallet_getPermissions 风格的数组
            if (Array.isArray(perms)) {
                const ethAcc = perms.find(p => p?.parentCapability === 'eth_accounts');
                if (ethAcc?.caveats && Array.isArray(ethAcc.caveats)) {
                    for (const c of ethAcc.caveats) {
                        if (Array.isArray(c.value) && c.value.length > 0 && c.value[0].startsWith('0x')) {
                            return c.value;
                        }
                    }
                }
            }
        }
        // 实在解析不出来，返回空数组让调用方回退
        return [];
    }

    let isConnecting = false;

    // 连接钱包
    async function connect(type = null) {
        // 强制每次都是全新连接 — 清理旧状态让 eth_requestAccounts 重新弹窗
        // （之前的 provider/signer/rawProvider 全部丢弃，确保钱包重新选账号）
        if (signer || rawProvider) {
            // 先彻底断开旧连接
            await disconnect(true);  // silent=true 不弹提示
        }
        currentAddress = null;
        currentChainId = null;
        walletType = null;
        provider = null;
        signer = null;
        rawProvider = null;
        isConnecting = false;

        emit('accountChanged', null);

        // 用户主动连接，清除"已主动断开"标记
        try { localStorage.removeItem(DISCONNECT_FLAG_KEY); } catch (e) {}

        isConnecting = true;  // 标记连接中，finally 里重置

        try {
        const availableWallets = getAvailableWallets();
        
        // 分离真实钱包和调试钱包
        const realWallets = availableWallets.filter(w => w.id !== 'debug');
        const hasRealEthereum = typeof window.ethereum !== 'undefined' || window.okxwallet || window.trustwallet || window.coinbaseWallet;
        
        // 没有真实钱包注入时：如果有真实钱包在 availableWallets 列表里就用它
        // 如果只有 debug 选项 → 报错，禁止静默回退到模拟钱包
        if (!hasRealEthereum && realWallets.length === 0) {
            const fileHint = window.location.protocol === 'file:'
                ? '（检测到你用的是 file:// 协议！浏览器安全策略会阻止钱包扩展注入，请改用本地 HTTP 服务器：在 rps_frontend/static/ 目录运行 python -m http.server 8080，然后浏览器打开 http://localhost:8080/html/index.html）'
                : '（请检查浏览器扩展是否已启用、网络是否在受支持列表内）';
            throw new Error('未检测到 Web3 钱包扩展' + fileHint);
        }

        if (!type) {
            // 优先选真实钱包，永不自动选 debug
            if (realWallets.length > 0) {
                type = realWallets[0].id;
            } else {
                type = availableWallets[0].id;  // 只有 debug 时才到这里（已被上方 guard 拦截）
            }
        }

        if (type === 'debug' && typeof CONFIG !== 'undefined' && CONFIG.enableDebugMode) {
            return connectDebugWallet();
        }

        if (typeof window.ethers === 'undefined') {
            throw new Error('ethers.js 未加载');
        }

        const providerObj = getProviderByType(type);
        
        if (!providerObj) {
            throw new Error('指定的钱包未安装');
        }

        // 关键！连真实钱包前必须把 debug 模式关掉
        // 否则 getBalance 会返回 CONFIG.debugBalance（10）而不是链上真实余额
        isDebugMode = false;
        if (provider && rawProvider) {
            try { removeEventListeners(rawProvider); } catch (e) {}
        }

        try {
            // 关键：彻底断开钱包连接，确保下次 eth_requestAccounts 一定会弹窗
            // OKX 的 revokePermissions 只清兼容层，内部状态没动
            // OKX 专属 provider.disconnect() 能彻底断开连接
            
            try {
                // 方法 1：OKX/MetaMask 都支持的 revokePermissions
                await providerObj.request({
                    method: 'wallet_revokePermissions',
                    params: [{ eth_accounts: {} }]
                });
                console.info('[Wallet] revokePermissions OK');
            } catch (e) {
                console.info('[Wallet] revokePermissions 跳过:', (e.message || '').substring(0, 80));
            }

            // 方法 2：OKX 专属 disconnect() — 更彻底
            try {
                if (typeof providerObj.disconnect === 'function') {
                    providerObj.disconnect();
                    console.info('[Wallet] provider.disconnect() OK');
                }
            } catch (e) {
                console.info('[Wallet] provider.disconnect() 跳过');
            }

            // 方法 3：OKX 有些版本需要重置 accounts 属性
            try {
                providerObj._accounts = null;
                providerObj._connectInfo = null;
            } catch (e) {}

            // 给钱包时间彻底清理
            await new Promise(r => setTimeout(r, 500));

            // 第二步：请求账号
            const accounts = await providerObj.request({ method: 'eth_requestAccounts' });

            if (!accounts || accounts.length === 0) {
                throw new Error('钱包未返回任何账户，请在钱包设置中授权连接');
            }

            currentAddress = accounts[0];
            walletType = type;
            rawProvider = providerObj;

            provider = new ethers.BrowserProvider(providerObj);
            signer = await provider.getSigner();
            
            const network = await provider.getNetwork();
            currentChainId = Number(network.chainId);

            setupEventListeners(providerObj);

            emit('accountChanged', currentAddress);
            emit('chainChanged', currentChainId);

            // ✅ 记住用户选的钱包类型 — 刷新后自动重连用
            try { localStorage.setItem(LAST_WALLET_TYPE_KEY, type); } catch (e) {}

            return {
                address: currentAddress,
                chainId: currentChainId,
                walletType: walletType
            };
        } catch (error) {
            console.error('[Wallet] connect 失败:', error.code || '', error.message);
            throw error;  // 直接向上抛，上层会显示准确消息
        }
        } finally {
            isConnecting = false;
        }
    }

    // 连接调试钱包（真正可用：连接本地 Ganache RPC + 用私钥构造 ethers.Signer）
    // 这样 Debug 钱包可以真正签发送交易，不是只有一个假地址
    async function connectDebugWallet() {
        isDebugMode = true;
        walletType = 'debug';

        try {
            // 1. 先读 config 里的本地链 RPC
            const rpcHost = CONFIG.RPC_HOST || '127.0.0.1';
            const rpcPort = CONFIG.RPC_PORT || 8686;
            const chainId = CONFIG.RPC_CHAIN_ID || (CONFIG.getLocalChainId ? CONFIG.getLocalChainId() : 5208888);  // 固定游戏链！
            const rpcUrl = `http://${rpcHost}:${rpcPort}`;

            // 2. 如果浏览器在手机上（非 localhost），把 127.0.0.1 改成主机局域网 IP
            //    这样手机浏览器也能连到你电脑上的 Ganache
            let effectiveRpcUrl = rpcUrl;
            if (rpcHost === '127.0.0.1' || rpcHost === 'localhost') {
                // 手机浏览器的 localStorage 可以覆盖这个值
                const stored = localStorage.getItem('rps_debug_rpc_url');
                if (stored) {
                    effectiveRpcUrl = stored;
                }
            }

            // 3. 构造 ethers JsonRpcProvider（直连 Ganache）
            provider = new ethers.JsonRpcProvider(effectiveRpcUrl);

            // 4. 用第一个 Ganache 账户的私钥构造 signer
            //    Ganache 默认前 10 个账户都预分配了 100 ETH
            //    这里用 config 里配置的 debugWalletPrivateKey，如果没有就走 Ganache 第一个默认私钥
            let privateKey = CONFIG.debugWalletPrivateKey;
            if (!privateKey) {
                // Ganache 启动时 generate available accounts 的第一个私钥（hardhat 默认值，我们的 ganache 也用这个）
                // 优先从 ganache_accounts.json 里找（后端启动时会生成到本地）
                try {
                    const resp = await fetch('/rootfs/data/ganache_accounts.json');
                    if (resp.ok) {
                        const accounts = await resp.json();
                        if (accounts && accounts.length > 0) {
                            privateKey = accounts[0].privateKey || accounts[0].private_key;
                        }
                    }
                } catch {}
                // 还找不到就用 hardhat/ganache 默认第一个
                if (!privateKey) {
                    privateKey = '0x4c0883a69102937d6231471b5dbb6204fe5129617082792ae468d01a3f362318';
                }
            }

            const wallet = new ethers.Wallet(privateKey, provider);
            signer = wallet;
            currentAddress = await wallet.getAddress();
            currentChainId = Number(chainId);
            rawProvider = null;  // 不是 EIP-1193 provider

            // 检查 RPC 是否真的可达
            try {
                const blockNum = await provider.getBlockNumber();
                emit('accountChanged', currentAddress);
                emit('chainChanged', currentChainId);
                FWUI.Toast.success(`✅ 调试钱包已连接 · ${effectiveRpcUrl} · block #${blockNum}`);
            } catch (rpcErr) {
                FWUI.Toast.warning(`⚠️ 调试钱包：RPC 不可达 (${effectiveRpcUrl})，可能需要先启动本地链`);
                emit('accountChanged', currentAddress);
                emit('chainChanged', currentChainId);
            }

            return { address: currentAddress, chainId: currentChainId, walletType };

        } catch (e) {
            console.error('connectDebugWallet error:', e);
            // 降级：连不上 RPC 也给个地址显示（但发交易会失败）
            currentAddress = CONFIG.debugWalletAddress || '0x0000000000000000000000000000000000000001';
            currentChainId = CONFIG.getChainId ? CONFIG.getChainId() : 5208888;
            emit('accountChanged', currentAddress);
            emit('chainChanged', currentChainId);
            FWUI.Toast.error('❌ 调试钱包连接失败: ' + e.message);
            return { address: currentAddress, chainId: currentChainId, walletType };
        }
    }

    // 自动连接钱包（无需用户手动点击）
    async function autoConnect() {
        // 用户之前主动断开过，则不自动重连（尊重用户选择）
        if (localStorage.getItem(DISCONNECT_FLAG_KEY) === '1') {
            return null;
        }
        if (isConnected()) {
            return { address: currentAddress, chainId: currentChainId, walletType: walletType };
        }
        if (isConnecting) {
            return null;
        }

        isConnecting = true;

        try {
            // 优先用用户上次选的钱包类型
            const lastType = localStorage.getItem(LAST_WALLET_TYPE_KEY);
            const availableWallets = getAvailableWallets();
            let providerObj = null;
            let type = null;

            if (lastType) {
                // 用户之前选过 OKX/MetaMask/Trust → 找到对应的 provider
                const saved = availableWallets.find(w => w.id === lastType);
                if (saved && saved.provider) {
                    providerObj = saved.provider;
                    type = lastType;
                }
            }

            // 没记住或者钱包被卸了 → 用第一个可用的真实钱包
            if (!providerObj) {
                const firstReal = availableWallets.find(w => w.id !== 'debug' && w.provider);
                if (firstReal) {
                    providerObj = firstReal.provider;
                    type = firstReal.id;
                }
            }

            if (!providerObj) {
                return null;  // 连钱包扩展都没装
            }

            // 查已授权的账户（eth_accounts 不弹窗，直接返回已授权的）
            let accounts = [];
            try { accounts = await providerObj.request({ method: 'eth_accounts' }); } catch (_) {}
            if (!accounts || accounts.length === 0) {
                return null;  // 没授权过 → 不自动弹窗，让用户手动点
            }

            currentAddress = accounts[0];
            walletType = type || 'auto';
            rawProvider = providerObj;

            provider = new ethers.BrowserProvider(providerObj);
            signer = await provider.getSigner();
            const network = await provider.getNetwork();
            currentChainId = Number(network.chainId);

            setupEventListeners(providerObj);

            emit('accountChanged', currentAddress);
            emit('chainChanged', currentChainId);

            console.log('[Wallet] Auto-connected:', currentAddress, 'via', type);
            return { address: currentAddress, chainId: currentChainId, walletType: walletType };
        } catch (e) {
            console.log('[Wallet] Auto-connect failed:', e.message);
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
    async function disconnect(silent = false) {
        // 先清除本地状态
        const wasConnected = currentAddress !== null;
        const providerObj = rawProvider;

        currentAddress = null;
        currentChainId = null;
        signer = null;
        provider = null;
        walletType = null;
        isDebugMode = false;

        // 移除事件监听器
        removeEventListeners(providerObj);

        if (!silent) {
            // 设置"已主动断开"标记：刷新页面后 autoConnect 检查此标记跳过自动重连
            try { localStorage.setItem(DISCONNECT_FLAG_KEY, '1'); } catch (e) {}

            // 真正与钱包断开：撤销 EIP-1193 权限
            if (wasConnected && providerObj && providerObj.request) {
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
        if (!silent) emit('disconnect');
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
            console.warn('[Wallet.getBalance] 无 currentAddress');
            return '0';
        }

        if (isDebugMode && typeof CONFIG !== 'undefined') {
            console.warn('[Wallet.getBalance] isDebugMode=true！返回 debugBalance:', CONFIG.debugBalance);
            return CONFIG.debugBalance.toString();
        }

        if (!provider) {
            console.warn('[Wallet.getBalance] 无 provider');
            return '0';
        }

        if (!tokenAddress || tokenAddress === '0x0000000000000000000000000000000000000000') {
            const balance = await provider.getBalance(currentAddress);
            const formatted = ethers.formatEther(balance);
            console.info('[Wallet.getBalance] 原生币(POL)余额:', formatted, 'address=', currentAddress.slice(0,8)+'...', 'chainId=', await provider.getNetwork().then(n=>n.chainId));
            return formatted;
        } else if (!isValidAddress(tokenAddress)) {
            console.warn('[Wallet.getBalance] 无效代币地址:', tokenAddress);
            return '0';
        } else {
            try {
                const abi = [
                    'function balanceOf(address account) view returns (uint256)',
                    'function decimals() view returns (uint8)'
                ];
                const contract = new ethers.Contract(tokenAddress, abi, provider);
                const [balance, decimals, network] = await Promise.all([
                    contract.balanceOf(currentAddress),
                    contract.decimals().catch(() => 6),
                    provider.getNetwork()
                ]);
                const formatted = ethers.formatUnits(balance, decimals);
                console.info('[Wallet.getBalance] 代币余额: addr=', tokenAddress.slice(0,10)+'...', 'bal=', formatted, 'dec=', decimals, 'chainId=', network.chainId);
                return formatted;
            } catch (e) {
                console.warn('获取代币余额失败:', tokenAddress, e.message, e);
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