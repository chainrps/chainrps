// 全局配置模块
const CONFIG = {
    // 后端服务器地址（动态，可由用户在设置中配置；默认 127.0.0.1）
    _serverIp: null,
    _serverPort: null,

    // 本地链 RPC 端口（统一维护点，修改此处即全局生效）
    RPC_PORT: 8686,
    RPC_HOST: '127.0.0.1',
    RPC_CHAIN_ID: 5208888,

    commitTimeout: 66,
    revealTimeout: 88,

    networks: {
        localhost: {
            get name() {
                return 'ChainRPS_Sim';
            },
            get rpcUrl() {
                return 'http://' + CONFIG.RPC_HOST + ':' + CONFIG.RPC_PORT;
            },
            get chainId() {
                return CONFIG.RPC_CHAIN_ID;
            },
            nativeCurrency: {name: 'Ether', symbol: 'ETH', decimals: 18},
            supportedTokens: [
                {symbol: 'ETH', name: 'Ether', decimals: 18, address: '0x0000000000000000000000000000000000000000'}
            ],
            tokenAddresses: {
                'ETH': '0x0000000000000000000000000000000000000000'
            }
        },
        amoy: {
            name: 'Polygon Amoy',
            rpcUrl: 'https://polygon-amoy-bor-rpc.publicnode.com',
            chainId: 80002,
            nativeCurrency: {name: 'Polygon', symbol: 'POL', decimals: 18},
            supportedTokens: [
                {symbol: 'USDC', name: 'USD Coin', decimals: 6, address: '0x0fa8781a83e46826621b3bc094ea2a0212e71b23'},
                {symbol: 'USDT', name: 'Tether', decimals: 6, address: '0x0000000000000000000000000000000000000000'}
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
            nativeCurrency: {name: 'Polygon', symbol: 'POL', decimals: 18},
            supportedTokens: [
                {symbol: 'USDC', name: 'USD Coin', decimals: 6, address: '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359'},
                {symbol: 'USDT', name: 'Tether', decimals: 6, address: '0xc2132D05D31c914a87C6611C10748AEb04B58e8F'}
            ],
            tokenAddresses: {
                'USDC': '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359',
                'USDT': '0xc2132D05D31c914a87C6611C10748AEb04B58e8F'
            }
        },
        base: {
            name: 'Base Mainnet',
            rpcUrl: 'https://mainnet.base.org/',
            chainId: 8453,
            nativeCurrency: {name: 'Ether', symbol: 'ETH', decimals: 18},
            supportedTokens: [
                {symbol: 'USDC', name: 'USD Coin', decimals: 6, address: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913'},
                {symbol: 'ETH', name: 'Ether', decimals: 18, address: '0x0000000000000000000000000000000000000000'}
            ],
            tokenAddresses: {
                'USDC': '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913',
                'ETH': '0x0000000000000000000000000000000000000000'
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
    debugBalance: 100000,      // 每个账户的默认原生代币余额

    // 根据链ID获取网络配置
    getNetwork(chainId) {
        for (const [key, network] of Object.entries(this.networks)) {
            if (network.chainId === chainId) {
                return network;
            }
        }
        return this.networks[this.defaultNetwork];
    },

    // 获取当前网络配置
    getCurrentNetwork() {
        if (window.ethereum) {
            const chainId = parseInt(window.ethereum.chainId);
            return this.getNetwork(chainId);
        }
        return this.networks[this.defaultNetwork];
    },

    // 获取当前网络的键值（用于本地存储）
    getNetworkKey() {
        const chainId = this.getChainId();
        for (const [key, network] of Object.entries(this.networks)) {
            if (network.chainId === chainId) {
                return key;
            }
        }
        return this.defaultNetwork;
    },

    // 获取当前网络的 RPC 地址
    getRpcUrl() {
        return this.getCurrentNetwork().rpcUrl;
    },

    // 获取本地链 RPC 端口
    getLocalRpcPort() {
        return this.RPC_PORT;
    },

    // 获取本地链 RPC URL
    getLocalRpcUrl() {
        return 'http://' + this.RPC_HOST + ':' + this.RPC_PORT;
    },

    // 获取本地链 Chain ID
    getLocalChainId() {
        return this.RPC_CHAIN_ID;
    },

    getChainId() {
        return this.getCurrentNetwork().chainId;
    },

    // 获取已保存的合约地址
    getContractAddress() {
        const networkKey = this.getNetworkKey();
        const stored = localStorage.getItem('rps_contract_' + networkKey);
        return stored || '';
    },

    // 设置合约地址
    setContractAddress(address) {
        const networkKey = this.getNetworkKey();
        if (address) {
            localStorage.setItem('rps_contract_' + networkKey, address);
        } else {
            localStorage.removeItem('rps_contract_' + networkKey);
        }
    },

    // 获取当前网络支持的代币地址映射
    getTokenAddresses() {
        return this.getCurrentNetwork().tokenAddresses;
    },

    // 获取当前网络支持的代币列表
    getSupportedTokens() {
        return this.getCurrentNetwork().supportedTokens;
    },

    // 获取默认代币符号
    getDefaultToken() {
        const tokens = this.getSupportedTokens();
        return tokens.length > 0 ? tokens[0].symbol : 'ETH';
    },

    // ==================== 后端服务器地址配置 ====================
    // 获取后端服务器 IP 地址
    getServerIp() {
        if (this._serverIp) return this._serverIp;
        const stored = localStorage.getItem('rps_server_ip');
        this._serverIp = stored || '127.0.0.1';
        return this._serverIp;
    },

    // 获取后端服务器端口
    getServerPort() {
        if (this._serverPort) return this._serverPort;
        const stored = localStorage.getItem('rps_server_port');
        this._serverPort = stored || '8000';
        return this._serverPort;
    },

    // 设置后端服务器地址
    setServerAddress(ip, port) {
        this._serverIp = ip || '127.0.0.1';
        this._serverPort = port || '8000';
        localStorage.setItem('rps_server_ip', this._serverIp);
        localStorage.setItem('rps_server_port', this._serverPort);
    },

    // 后端服务 HTTP 基础 URL
    get backendUrl() {
        return `http://${this.getServerIp()}:${this.getServerPort()}`;
    },

    // 后端服务 WebSocket 基础 URL
    get wsUrl() {
        return `ws://${this.getServerIp()}:${this.getServerPort()}`;
    }
};

// ==================== 一次性配置迁移：清理旧端口/旧链ID缓存 ====================
// 历史遗留：曾使用 108108 作为本地链端口，已统一改为 8686；
// 曾使用 31337 作为默认 chain_id，已统一改为 5208888。
// 旧值可能残留在 localStorage 的 rps_local_chain_config 中，导致管理页面
// 表单仍显示旧值。此处检测并修正（仅执行一次，通过版本号标记）。
(function _migrateOldRpcConfig() {
    try {
        const MIGRATION_KEY = 'rps_config_migration_v2';
        if (localStorage.getItem(MIGRATION_KEY)) return;

        const cfgRaw = localStorage.getItem('rps_local_chain_config');
        if (cfgRaw) {
            const cfg = JSON.parse(cfgRaw);
            let changed = false;
            // 修正 port 字段
            if (cfg.port && String(cfg.port).includes('108108')) {
                cfg.port = String(CONFIG.RPC_PORT);
                changed = true;
            }
            // 修正可能内嵌在 rpc_url 中的旧端口
            if (cfg.rpc_url && cfg.rpc_url.includes(':108108')) {
                cfg.rpc_url = cfg.rpc_url.replace(':108108', ':' + CONFIG.RPC_PORT);
                changed = true;
            }
            // 修正旧 chain_id（31337 → 当前 CONFIG.RPC_CHAIN_ID）
            if (cfg.chain_id && String(cfg.chain_id) === '31337') {
                cfg.chain_id = String(CONFIG.RPC_CHAIN_ID);
                changed = true;
            }
            if (changed) {
                localStorage.setItem('rps_local_chain_config', JSON.stringify(cfg));
                console.info('[迁移] 已修正本地链配置（端口/链ID）为当前默认值');
            }
        }
        localStorage.setItem(MIGRATION_KEY, 'done');
    } catch (e) {
        // 忽略迁移失败，不影响主流程
    }
})();