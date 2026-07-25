const CONFIG = {
    // 后端服务器地址（动态，可由用户在设置中配置；默认 127.0.0.1）
    _serverIp: null,
    _serverPort: null,

    commitTimeout: 66,
    revealTimeout: 88,

    networks: {
        localhost: {
            name: 'Localhost 8545',
            rpcUrl: 'http://127.0.0.1:8545',
            chainId: 1337,
            nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
            supportedTokens: [
                { symbol: 'ETH', name: 'Ether', decimals: 18, address: '0x0000000000000000000000000000000000000000' }
            ],
            tokenAddresses: {
                'ETH': '0x0000000000000000000000000000000000000000'
            }
        },
        amoy: {
            name: 'Polygon Amoy',
            rpcUrl: 'https://rpc-amoy.polygon.technology/',
            chainId: 80002,
            nativeCurrency: { name: 'Polygon', symbol: 'POL', decimals: 18 },
            supportedTokens: [
                { symbol: 'USDC', name: 'USD Coin', decimals: 6, address: '0x0fa8781a83e46826621b3bc094ea2a0212e71b23' },
                { symbol: 'USDT', name: 'Tether', decimals: 6, address: '0x0000000000000000000000000000000000000000' }
            ],
            tokenAddresses: {
                'USDC': '0x0fa8781a83e46826621b3bc094ea2a0212e71b23',
                'USDT': '0x0000000000000000000000000000000000000000'
            }
        },
        polygon: {
            name: 'Polygon Mainnet',
            rpcUrl: 'https://polygon-rpc.com/',
            chainId: 137,
            nativeCurrency: { name: 'Polygon', symbol: 'POL', decimals: 18 },
            supportedTokens: [
                { symbol: 'USDC', name: 'USD Coin', decimals: 6, address: '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359' },
                { symbol: 'USDT', name: 'Tether', decimals: 6, address: '0xc2132D05D31c914a87C6611C10748AEb04B58e8F' }
            ],
            tokenAddresses: {
                'USDC': '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359',
                'USDT': '0xc2132D05D31c914a87C6611C10748AEb04B58e8F'
            }
        }
    },
    
    defaultNetwork: 'localhost',

    enableModeB: true,
    defaultMode: 'A',

    defaultTheme: 'light',

    quickAmounts: [10, 50, 100, 500],

    officialDeveloper: '0x0000000000000000000000000000000000000000',

    enableDebugMode: true,
    debugWalletAddress: '0x1234567890abcdef1234567890abcdef12345678',
    debugBalance: 1000,

    getNetwork(chainId) {
        for (const [key, network] of Object.entries(this.networks)) {
            if (network.chainId === chainId) {
                return network;
            }
        }
        return this.networks[this.defaultNetwork];
    },

    getCurrentNetwork() {
        if (window.ethereum) {
            const chainId = parseInt(window.ethereum.chainId);
            return this.getNetwork(chainId);
        }
        return this.networks[this.defaultNetwork];
    },

    getNetworkKey() {
        const chainId = this.getChainId();
        for (const [key, network] of Object.entries(this.networks)) {
            if (network.chainId === chainId) {
                return key;
            }
        }
        return this.defaultNetwork;
    },

    getRpcUrl() {
        return this.getCurrentNetwork().rpcUrl;
    },

    getChainId() {
        return this.getCurrentNetwork().chainId;
    },

    getContractAddress() {
        const networkKey = this.getNetworkKey();
        const stored = localStorage.getItem('rps_contract_' + networkKey);
        return stored || '';
    },

    setContractAddress(address) {
        const networkKey = this.getNetworkKey();
        if (address) {
            localStorage.setItem('rps_contract_' + networkKey, address);
        } else {
            localStorage.removeItem('rps_contract_' + networkKey);
        }
    },

    getTokenAddresses() {
        return this.getCurrentNetwork().tokenAddresses;
    },

    getSupportedTokens() {
        return this.getCurrentNetwork().supportedTokens;
    },

    getDefaultToken() {
        const tokens = this.getSupportedTokens();
        return tokens.length > 0 ? tokens[0].symbol : 'ETH';
    },

    // ==================== 后端服务器地址配置 ====================

    getServerIp() {
        if (this._serverIp) return this._serverIp;
        const stored = localStorage.getItem('rps_server_ip');
        this._serverIp = stored || '127.0.0.1';
        return this._serverIp;
    },

    getServerPort() {
        if (this._serverPort) return this._serverPort;
        const stored = localStorage.getItem('rps_server_port');
        this._serverPort = stored || '8000';
        return this._serverPort;
    },

    setServerAddress(ip, port) {
        this._serverIp = ip || '127.0.0.1';
        this._serverPort = port || '8000';
        localStorage.setItem('rps_server_ip', this._serverIp);
        localStorage.setItem('rps_server_port', this._serverPort);
    },

    get backendUrl() {
        return `http://${this.getServerIp()}:${this.getServerPort()}`;
    },

    get wsUrl() {
        return `ws://${this.getServerIp()}:${this.getServerPort()}`;
    }
};