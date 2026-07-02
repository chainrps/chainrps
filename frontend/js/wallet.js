/**
 * 钱包连接管理
 * 支持多钱包：MetaMask, OKX Web3, Trust Wallet, Coinbase Wallet
 */

class WalletManager {
    constructor() {
        this.provider = null;
        this.signer = null;
        this.address = null;
        this.chainId = null;
        this.usdcBalance = '0';
        this.usdtBalance = '0';
        
        // Polygon Amoy 测试网配置
        this.targetChainId = 80002; // Amoy
        this.targetChainName = 'Polygon Amoy';
        this.rpcUrl = 'https://rpc-amoy.polygon.technology/';
        
        // 代币地址 (Amoy 测试网)
        this.tokenAddresses = {
            USDC: '0x41e94Eb019A70Ac5c8Fbf5e85D8C8D9B36e1f89E',
            USDT: '0x0E1b9E30d79C9a1b5d9bC3d4E3d3C2B1A9e8d7c6' // 需要替换为实际地址
        };
        
        // ERC20 ABI (最小化)
        this.erc20Abi = [
            'function balanceOf(address owner) view returns (uint256)',
            'function approve(address spender, uint256 amount) returns (bool)',
            'function allowance(address owner, address spender) view returns (uint256)',
            'function decimals() view returns (uint8)',
            'function symbol() view returns (string)'
        ];
    }

    /**
     * 检查钱包是否已安装
     */
    isWalletInstalled() {
        // MetaMask
        if (window.ethereum && window.ethereum.isMetaMask) {
            return { name: 'MetaMask', installed: true };
        }
        
        // OKX Wallet
        if (window.okxwallet) {
            return { name: 'OKX Wallet', installed: true };
        }
        
        // Trust Wallet (通过 window.ethereum)
        if (window.ethereum && window.ethereum.isTrust) {
            return { name: 'Trust Wallet', installed: true };
        }
        
        // Coinbase Wallet
        if (window.ethereum && window.ethereum.isCoinbaseWallet) {
            return { name: 'Coinbase Wallet', installed: true };
        }
        
        // 通用 Ethereum 钱包
        if (window.ethereum) {
            return { name: 'Web3 Wallet', installed: true };
        }
        
        return { name: 'None', installed: false };
    }

    /**
     * 连接钱包
     */
    async connect() {
        const walletInfo = this.isWalletInstalled();
        
        if (!walletInfo.installed) {
            throw new Error(i18n.get('wallet_not_supported'));
        }
        
        try {
            // 获取 provider
            this.provider = new ethers.BrowserProvider(window.ethereum);
            
            // 请求连接
            const accounts = await this.provider.send('eth_requestAccounts', []);
            
            if (accounts.length === 0) {
                throw new Error('No accounts found');
            }
            
            this.address = accounts[0];
            
            // 获取 signer
            this.signer = await this.provider.getSigner();
            
            // 检查网络
            const network = await this.provider.getNetwork();
            this.chainId = Number(network.chainId);
            
            // 如果不是目标网络，提示切换
            if (this.chainId !== this.targetChainId) {
                await this.switchToTargetNetwork();
            }
            
            // 获取余额
            await this.updateBalances();
            
            console.log(`Wallet connected: ${this.address}`);
            
            return {
                address: this.address,
                chainId: this.chainId,
                usdcBalance: this.usdcBalance,
                usdtBalance: this.usdtBalance
            };
            
        } catch (error) {
            console.error('Wallet connection error:', error);
            throw error;
        }
    }

    /**
     * 切换到目标网络
     */
    async switchToTargetNetwork() {
        try {
            // 尝试切换到已存在的网络
            await window.ethereum.request({
                method: 'wallet_switchEthereumChain',
                params: [{ chainId: `0x${this.targetChainId.toString(16)}` }]
            });
        } catch (switchError) {
            // 如果网络不存在，添加它
            if (switchError.code === 4902) {
                await window.ethereum.request({
                    method: 'wallet_addEthereumChain',
                    params: [{
                        chainId: `0x${this.targetChainId.toString(16)}`,
                        chainName: this.targetChainName,
                        nativeCurrency: {
                            name: 'MATIC',
                            symbol: 'MATIC',
                            decimals: 18
                        },
                        rpcUrls: [this.rpcUrl],
                        blockExplorerUrls: ['https://www.oklink.com/amoy']
                    }]
                });
            } else {
                throw switchError;
            }
        }
    }

    /**
     * 断开连接
     */
    async disconnect() {
        this.provider = null;
        this.signer = null;
        this.address = null;
        this.chainId = null;
        this.usdcBalance = '0';
        this.usdtBalance = '0';
        
        console.log('Wallet disconnected');
    }

    /**
     * 更新代币余额
     */
    async updateBalances() {
        if (!this.address || !this.provider) {
            return;
        }
        
        try {
            // USDC
            const usdcContract = new ethers.Contract(
                this.tokenAddresses.USDC,
                this.erc20Abi,
                this.provider
            );
            const usdcRaw = await usdcContract.balanceOf(this.address);
            const usdcDecimals = await usdcContract.decimals();
            this.usdcBalance = ethers.formatUnits(usdcRaw, usdcDecimals);
            
            // USDT
            const usdtContract = new ethers.Contract(
                this.tokenAddresses.USDT,
                this.erc20Abi,
                this.provider
            );
            const usdtRaw = await usdtContract.balanceOf(this.address);
            const usdtDecimals = await usdtContract.decimals();
            this.usdtBalance = ethers.formatUnits(usdtRaw, usdtDecimals);
            
        } catch (error) {
            console.error('Error updating balances:', error);
        }
    }

    /**
     * 授权代币给合约
     */
    async approveToken(tokenSymbol, spenderAddress, amount) {
        if (!this.signer) {
            throw new Error(i18n.get('connect_first'));
        }
        
        const tokenAddress = this.tokenAddresses[tokenSymbol];
        const tokenContract = new ethers.Contract(
            tokenAddress,
            this.erc20Abi,
            this.signer
        );
        
        // 获取 decimals
        const decimals = await tokenContract.decimals();
        const amountRaw = ethers.parseUnits(amount.toString(), decimals);
        
        // 检查现有授权额度
        const allowance = await tokenContract.allowance(this.address, spenderAddress);
        
        if (allowance >= amountRaw) {
            return true; // 已有足够授权
        }
        
        // 发起授权交易
        const tx = await tokenContract.approve(spenderAddress, amountRaw);
        const receipt = await tx.wait();
        
        return receipt.status === 1;
    }

    /**
     * 监听钱包事件
     */
    setupListeners(callbacks) {
        if (!window.ethereum) return;
        
        // 账户变更
        window.ethereum.on('accountsChanged', async (accounts) => {
            if (accounts.length === 0) {
                await this.disconnect();
                callbacks.onDisconnect?.();
            } else {
                this.address = accounts[0];
                await this.updateBalances();
                callbacks.onAccountChange?.(this.address);
            }
        });
        
        // 网络变更
        window.ethereum.on('chainChanged', async (chainIdHex) => {
            this.chainId = parseInt(chainIdHex, 16);
            
            if (this.chainId !== this.targetChainId) {
                callbacks.onWrongNetwork?.();
            } else {
                await this.updateBalances();
                callbacks.onNetworkChange?.(this.chainId);
            }
        });
    }

    /**
     * 格式化地址显示
     */
    formatAddress(address) {
        if (!address) return '-';
        return `${address.slice(0, 6)}...${address.slice(-4)}`;
    }
}

const walletManager = new WalletManager();