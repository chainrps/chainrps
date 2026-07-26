// 钱包管理模块
const Wallet = (function() {
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
    function getAvailableWallets() {
        const wallets = [];
        
        if (typeof window.ethereum !== 'undefined') {
            if (window.ethereum.isMetaMask) {
                wallets.push({ id: 'metamask', name: 'MetaMask', icon: '🦊' });
            } else if (window.ethereum.isOkxWallet) {
                wallets.push({ id: 'okx', name: 'OKX Wallet', icon: '🔷' });
            } else if (window.ethereum.isTrust) {
                wallets.push({ id: 'trust', name: 'Trust Wallet', icon: '💙' });
            } else {
                wallets.push({ id: 'injected', name: 'Injected Wallet', icon: '💼' });
            }
        }

        if (window.okxwallet) {
            if (!wallets.find(w => w.id === 'okx')) {
                wallets.push({ id: 'okx', name: 'OKX Wallet', icon: '🔷' });
            }
        }

        if (window.trustwallet) {
            if (!wallets.find(w => w.id === 'trust')) {
                wallets.push({ id: 'trust', name: 'Trust Wallet', icon: '💙' });
            }
        }

        if (window.coinbaseWallet) {
            wallets.push({ id: 'coinbase', name: 'Coinbase Wallet', icon: '🔵' });
        }

        if (typeof CONFIG !== 'undefined' && CONFIG.enableDebugMode) {
            wallets.push({ id: 'debug', name: 'Debug Wallet', icon: '🐛' });
        }

        return wallets;
    }

    // 根据钱包类型获取对应的Provider对象
    function getProviderByType(type) {
        switch (type) {
            case 'metamask':
            case 'injected':
                return window.ethereum;
            case 'okx':
                return window.okxwallet || window.ethereum;
            case 'trust':
                return window.trustwallet || window.ethereum;
            case 'coinbase':
                return window.coinbaseWallet || window.ethereum;
            default:
                return window.ethereum;
        }
    }

    let isConnecting = false;

    // 连接钱包
    async function connect(type = null) {
        if (isConnecting) {
            return {
                address: currentAddress,
                chainId: currentChainId,
                walletType: walletType
            };
        }
        isConnecting = true;

        try {
        const availableWallets = getAvailableWallets();
        
        if (availableWallets.length === 0) {
            throw new Error('未检测到 Web3 钱包，请先安装 MetaMask 或其他钱包');
        }

        if (!type) {
            type = availableWallets[0].id;
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

        try {
            const accounts = await providerObj.request({ method: 'eth_requestAccounts' });
            
            if (accounts.length === 0) {
                throw new Error('用户拒绝连接');
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

            return {
                address: currentAddress,
                chainId: currentChainId,
                walletType: walletType
            };
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
        currentChainId = CONFIG.getChainId ? CONFIG.getChainId() : 31337;

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
            const accounts = await window.ethereum.request({ method: 'eth_accounts' });
            if (accounts.length === 0) {
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

        // 真正与钱包断开：撤销 EIP-1193 权限（MetaMask 等支持 wallet_revokePermissions）
        if (wasConnected && providerObj && providerObj.request) {
            try {
                await providerObj.request({
                    method: 'wallet_revokePermissions',
                    params: [{ eth_accounts: {} }]
                });
            } catch (e) {
                // 部分钱包不支持 wallet_revokePermissions，回退到清理 permissions
                try {
                    await providerObj.request({
                        method: 'wallet_requestPermissions',
                        params: [{ eth_accounts: {} }]
                    }).then(() => {
                        // 重新请求时用户会看到连接弹窗，相当于断开
                    });
                } catch (e2) {
                    // 完全不支持，仅本地清理
                    console.warn('钱包不支持主动断开，仅清理本地状态');
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

        const params = {
            chainId: hexChainId,
            chainName: chainConfig.chainName || `Chain #${chainConfig.chainId}`,
            rpcUrls: chainConfig.rpcUrls || [],
            nativeCurrency: chainConfig.nativeCurrency || {
                name: 'Ether',
                symbol: 'ETH',
                decimals: 18
            },
        };

        if (chainConfig.blockExplorerUrls && chainConfig.blockExplorerUrls.length > 0) {
            params.blockExplorerUrls = chainConfig.blockExplorerUrls;
        }

        console.log('调用 wallet_addEthereumChain, params:', params);

        try {
            const result = await providerObj.request({
                method: 'wallet_addEthereumChain',
                params: [params]
            });
            console.log('wallet_addEthereumChain 返回:', result);
            // 某些钱包在添加成功后会自动切换，返回 null
            // 某些钱包需要用户手动确认后切换
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