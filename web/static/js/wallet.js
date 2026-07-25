const Wallet = (function() {
    let provider = null;
    let signer = null;
    let currentAddress = null;
    let currentChainId = null;
    let walletType = null;

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
        if (typeof window.ethers === 'undefined') {
            throw new Error('ethers.js 未加载');
        }

        const availableWallets = getAvailableWallets();
        
        if (availableWallets.length === 0) {
            throw new Error('未检测到 Web3 钱包，请先安装 MetaMask 或其他钱包');
        }

        if (!type) {
            type = availableWallets[0].id;
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

    function setupEventListeners(providerObj) {
        if (providerObj.on) {
            providerObj.on('accountsChanged', (accounts) => {
                if (accounts.length === 0) {
                    disconnect();
                } else {
                    currentAddress = accounts[0];
                    emit('accountChanged', currentAddress);
                }
            });

            providerObj.on('chainChanged', (chainId) => {
                currentChainId = parseInt(chainId, 16);
                emit('chainChanged', currentChainId);
            });

            providerObj.on('disconnect', () => {
                disconnect();
            });
        }
    }

    function disconnect() {
        currentAddress = null;
        currentChainId = null;
        signer = null;
        provider = null;
        walletType = null;
        emit('disconnect');
    }

    function isConnected() {
        return currentAddress !== null && signer !== null;
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

    async function getBalance(tokenAddress = null) {
        if (!provider || !currentAddress) {
            return '0';
        }

        if (!tokenAddress || tokenAddress === '0x0000000000000000000000000000000000000000') {
            const balance = await provider.getBalance(currentAddress);
            return ethers.formatEther(balance);
        } else {
            const abi = [
                'function balanceOf(address account) view returns (uint256)',
                'function decimals() view returns (uint8)'
            ];
            const contract = new ethers.Contract(tokenAddress, abi, provider);
            const balance = await contract.balanceOf(currentAddress);
            const decimals = await contract.decimals();
            return ethers.formatUnits(balance, decimals);
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
