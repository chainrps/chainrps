/**
 * 合约交互管理
 * 与 RPSGame 智能合约进行交互
 */

class ContractManager {
    constructor() {
        this.contract = null;
        this.contractAddress = null; // 部署后设置
        
        // 合约 ABI
        this.contractAbi = [
            // 创建对局
            'function createGame(address token, uint256 betAmount) external returns (uint256)',
            // 加入对局
            'function joinGame(uint256 gameId) external',
            // 取消对局
            'function cancelGame(uint256 gameId) external',
            // 提交哈希承诺
            'function submitCommit(uint256 gameId, bytes32 commit) external',
            // 揭晓出拳
            'function revealChoice(uint256 gameId, uint8 choice, uint256 salt) external',
            // 平局处理
            'function handleDraw(uint256 gameId, uint8 action) external',
            // 超时判负
            'function claimTimeout(uint256 gameId) external',
            
            // 查询函数
            'function getGame(uint256 gameId) external view returns (address player1, address player2, address token, uint256 betAmount, uint8 state, uint256 createdAt, uint256 commitDeadline, uint256 revealDeadline, address winner, bool isDraw)',
            'function getPlayerGames(address player) external view returns (uint256[] memory)',
            'function getTokenConfig(string symbol) external view returns (bool enabled, address tokenAddress)',
            
            // 公共变量
            'function commitTimeout() view returns (uint256)',
            'function revealTimeout() view returns (uint256)',
            'function feeRate() view returns (uint256)',
            'function feeCollector() view returns (address)',
            'function gameCount() view returns (uint256)',
            
            // 事件
            'event GameCreated(uint256 indexed gameId, address indexed player1, address token, uint256 betAmount)',
            'event PlayerJoined(uint256 indexed gameId, address indexed player2)',
            'event CommitSubmitted(uint256 indexed gameId, address indexed player, bytes32 commit)',
            'event ChoiceRevealed(uint256 indexed gameId, address indexed player, uint8 choice, uint256 salt)',
            'event GameSettled(uint256 indexed gameId, address winner, uint256 prize, uint256 fee)',
            'event DrawSettled(uint256 indexed gameId, address player1, address player2)',
            'event GameCancelled(uint256 indexed gameId, address indexed canceller)'
        ];
        
        // 出拳枚举
        this.Choice = {
            None: 0,
            Rock: 1,
            Paper: 2,
            Scissors: 3
        };
        
        // 对局状态枚举
        this.GameState = {
            Waiting: 0,
            BothJoined: 1,
            CommitPhase: 2,
            RevealPhase: 3,
            Finished: 4,
            Cancelled: 5
        };
    }

    /**
     * 设置合约地址
     */
    setContractAddress(address) {
        this.contractAddress = address;
    }

    /**
     * 初始化合约实例
     */
    initContract(signer) {
        if (!this.contractAddress) {
            throw new Error('Contract address not set');
        }
        
        this.contract = new ethers.Contract(
            this.contractAddress,
            this.contractAbi,
            signer
        );
        
        return this.contract;
    }

    /**
     * 创建对局
     */
    async createGame(tokenAddress, betAmount) {
        if (!this.contract) {
            throw new Error('Contract not initialized');
        }
        
        // 解析金额（假设 decimals = 6，适用于 USDC/USDT）
        const amountRaw = ethers.parseUnits(betAmount.toString(), 6);
        
        const tx = await this.contract.createGame(tokenAddress, amountRaw);
        const receipt = await tx.wait();
        
        // 从事件中获取 gameId
        const event = receipt.logs.find(log => {
            try {
                const parsed = this.contract.interface.parseLog(log);
                return parsed.name === 'GameCreated';
            } catch {
                return false;
            }
        });
        
        if (event) {
            const parsed = this.contract.interface.parseLog(event);
            return {
                gameId: parsed.args[0],
                player1: parsed.args[1],
                token: parsed.args[2],
                betAmount: parsed.args[3]
            };
        }
        
        return null;
    }

    /**
     * 加入对局
     */
    async joinGame(gameId) {
        if (!this.contract) {
            throw new Error('Contract not initialized');
        }
        
        const tx = await this.contract.joinGame(gameId);
        const receipt = await tx.wait();
        
        return receipt.status === 1;
    }

    /**
     * 提交哈希承诺
     */
    async submitCommit(gameId, commitHash) {
        if (!this.contract) {
            throw new Error('Contract not initialized');
        }
        
        const tx = await this.contract.submitCommit(gameId, commitHash);
        const receipt = await tx.wait();
        
        return receipt.status === 1;
    }

    /**
     * 揭晓出拳
     */
    async revealChoice(gameId, choice, salt) {
        if (!this.contract) {
            throw new Error('Contract not initialized');
        }
        
        const tx = await this.contract.revealChoice(gameId, choice, salt);
        const receipt = await tx.wait();
        
        // 从事件获取结果
        const events = receipt.logs.filter(log => {
            try {
                const parsed = this.contract.interface.parseLog(log);
                return parsed.name === 'ChoiceRevealed' || parsed.name === 'GameSettled' || parsed.name === 'DrawSettled';
            } catch {
                return false;
            }
        });
        
        return {
            success: receipt.status === 1,
            events: events
        };
    }

    /**
     * 处理平局（退款）
     */
    async handleDraw(gameId, action) {
        if (!this.contract) {
            throw new Error('Contract not initialized');
        }
        
        // DrawAction: Refund = 1, Rematch = 2
        const tx = await this.contract.handleDraw(gameId, action === 'refund' ? 1 : 2);
        const receipt = await tx.wait();
        
        return receipt.status === 1;
    }

    /**
     * 超时判负
     */
    async claimTimeout(gameId) {
        if (!this.contract) {
            throw new Error('Contract not initialized');
        }
        
        const tx = await this.contract.claimTimeout(gameId);
        const receipt = await tx.wait();
        
        return receipt.status === 1;
    }

    /**
     * 获取对局详情
     */
    async getGame(gameId) {
        if (!this.contract) {
            throw new Error('Contract not initialized');
        }
        
        const result = await this.contract.getGame(gameId);
        
        return {
            player1: result[0],
            player2: result[1],
            token: result[2],
            betAmount: ethers.formatUnits(result[3], 6),
            state: result[4],
            createdAt: result[5],
            commitDeadline: result[6],
            revealDeadline: result[7],
            winner: result[8],
            isDraw: result[9]
        };
    }

    /**
     * 获取玩家对局列表
     */
    async getPlayerGames(playerAddress) {
        if (!this.contract) {
            throw new Error('Contract not initialized');
        }
        
        const gameIds = await this.contract.getPlayerGames(playerAddress);
        return gameIds.map(id => Number(id));
    }

    /**
     * 获取代币配置
     */
    async getTokenConfig(symbol) {
        if (!this.contract) {
            throw new Error('Contract not initialized');
        }
        
        const result = await this.contract.getTokenConfig(symbol);
        
        return {
            enabled: result[0],
            tokenAddress: result[1]
        };
    }

    /**
     * 监听合约事件
     */
    setupEventListeners(callbacks) {
        if (!this.contract) return;
        
        // 对局创建
        this.contract.on('GameCreated', (gameId, player1, token, betAmount) => {
            callbacks.onGameCreated?.({
                gameId: Number(gameId),
                player1,
                token,
                betAmount: ethers.formatUnits(betAmount, 6)
            });
        });
        
        // 玩家加入
        this.contract.on('PlayerJoined', (gameId, player2) => {
            callbacks.onPlayerJoined?.({
                gameId: Number(gameId),
                player2
            });
        });
        
        // 提交承诺
        this.contract.on('CommitSubmitted', (gameId, player, commit) => {
            callbacks.onCommitSubmitted?.({
                gameId: Number(gameId),
                player,
                commit
            });
        });
        
        // 揭晓出拳
        this.contract.on('ChoiceRevealed', (gameId, player, choice, salt) => {
            callbacks.onChoiceRevealed?.({
                gameId: Number(gameId),
                player,
                choice: Number(choice),
                salt
            });
        });
        
        // 对局结算
        this.contract.on('GameSettled', (gameId, winner, prize, fee) => {
            callbacks.onGameSettled?.({
                gameId: Number(gameId),
                winner,
                prize: ethers.formatUnits(prize, 6),
                fee: ethers.formatUnits(fee, 6)
            });
        });
        
        // 平局
        this.contract.on('DrawSettled', (gameId, player1, player2) => {
            callbacks.onDrawSettled?.({
                gameId: Number(gameId),
                player1,
                player2
            });
        });
    }

    /**
     * 移除事件监听
     */
    removeEventListeners() {
        if (!this.contract) return;
        
        this.contract.removeAllListeners();
    }
}

const contractManager = new ContractManager();