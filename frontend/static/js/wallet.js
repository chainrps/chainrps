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

    const listeners = {
        accountChanged: [],
        chainChanged: [],
        disconnect: []
    };

    function on(event, callback) {
        if (listeners[event]) {
            listeners[event].push(callback);
        }
    }

    function off(event, callback) {
        if (listeners[event]) {
            listeners[event] = listeners[event].filter(cb => cb !== callback);
        }
    }

    function emit(event, ...args) {
        if (listeners[event]) {
            listeners[event].forEach(cb => cb(...args));
        }
    }

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

    async function connect(type = null) {
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
    }

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

    async function autoConnect() {
        if (!window.ethereum) {
            return null;
        }

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
        }
    }

    function setupEventListeners(providerObj) {
        if (providerObj.on) {
            accountChangedHandler = (accounts) => {
                if (accounts.length === 0) {
                    disconnect();
                } else {
                    currentAddress = accounts[0];
                    emit('accountChanged', currentAddress);
                }
            };

            chainChangedHandler = (chainId) => {
                currentChainId = parseInt(chainId, 16);
                emit('chainChanged', currentChainId);
            };

            disconnectHandler = () => {
                disconnect();
            };

            providerObj.on('accountsChanged', accountChangedHandler);
            providerObj.on('chainChanged', chainChangedHandler);
            providerObj.on('disconnect', disconnectHandler);
        }
    }

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

    function isConnected() {
        return currentAddress !== null && (isDebugMode || signer !== null);
    }

    function getAddress() {
        return currentAddress;
    }

    function getChainId() {
        return currentChainId;
    }

    function getWalletType() {
        return walletType;
    }

    function getProvider() {
        return provider;
    }

    function getSigner() {
        return signer;
    }

    function isValidAddress(addr) {
        return typeof addr === 'string' && /^0x[a-fA-F0-9]{40}$/.test(addr);
    }

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
            if (switchError.code === 4902) {
                throw new Error('钱包中未添加该网络');
            }
            throw switchError;
        }
    }

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

    function formatAddress(address, length = 6) {
        if (!address) return '';
        if (address.length <= length * 2 + 4) return address;
        return address.slice(0, length) + '...' + address.slice(-length);
    }

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
        addToken,
        formatAddress,
        getAvailableWallets,
        on,
        off
    };
})();