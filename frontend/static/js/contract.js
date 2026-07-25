const Contract = (function() {
    let contract = null;
    let contractAddress = null;
    let provider = null;
    let signer = null;

    const RPS_GAME_ABI = [
        'function createMatch(uint256 amount, address token) external returns (uint256)',
        'function joinMatch(uint256 gameId) external',
        'function submitCommit(uint256 gameId, bytes32 commit) external',
        'function revealChoice(uint256 gameId, uint8 choice, bytes32 salt) external',
        'function claimTimeout(uint256 gameId) external',
        'function handleDraw(uint256 gameId) external',
        'function getGame(uint256 gameId) external view returns (address player1, address player2, uint256 amount, address token, uint8 status, uint256 commitDeadline, uint256 revealDeadline, address winner, bool isDraw)',
        'function getCommit(uint256 gameId, address player) external view returns (bytes32)',
        'function getPlayerGames(address player) external view returns (uint256[] memory)',
        'function getAntiFakeInfo() external view returns (address developer, uint256 deployTime, string memory version, string memory website, string memory twitter, string memory discord)',
        'function supportedTokens(address token) external view returns (bool)',
        'function games(uint256 gameId) external view returns (address player1, address player2, uint256 amount, address token, bytes32 commit1, bytes32 commit2, uint8 choice1, uint8 choice2, uint256 commitDeadline, uint256 revealDeadline, uint8 status, address winner, bool isDraw, bool player1Refunded, bool player2Refunded)',
        'function gameCount() external view returns (uint256)',
        'function feeRate() external view returns (uint256)',
        'function feeCollector() external view returns (address)',
        'function commitTimeout() external view returns (uint256)',
        'function revealTimeout() external view returns (uint256)',
        'function officialWebsite() external view returns (string memory)',
        'function officialTwitter() external view returns (string memory)',
        'function officialDiscord() external view returns (string memory)',
        'function officialDeveloper() external view returns (address)',
        'function paused() external view returns (bool)',
        'function owner() external view returns (address)',
        'function setFeeRate(uint256 newRate) external',
        'function setDeveloperAddress(address newAddr) external',
        'function updateOfficialInfo(string memory website, string memory twitter, string memory discord) external',
        'function setTokenSupport(address token, bool supported) external',
        'function setTimeouts(uint256 newCommitTimeout, uint256 newRevealTimeout) external',
        'function cancelMatch(uint256 gameId) external',
        'function pause() external',
        'function unpause() external',
        'event GameCreated(uint256 indexed gameId, address indexed creator, uint256 amount, address token)',
        'event PlayerJoined(uint256 indexed gameId, address indexed player)',
        'event CommitSubmitted(uint256 indexed gameId, address indexed player, bytes32 commit)',
        'event ChoiceRevealed(uint256 indexed gameId, address indexed player, uint8 choice)',
        'event GameSettled(uint256 indexed gameId, address winner, uint256 amount, uint256 fee)',
        'event TimeoutClaimed(uint256 indexed gameId, address indexed claimer)',
        'event DrawHandled(uint256 indexed gameId)',
        'event MatchCancelled(uint256 indexed gameId, address indexed canceller)',
        'event FeeRateChanged(uint256 oldRate, uint256 newRate)',
        'event DeveloperAddressChanged(address oldAddr, address newAddr)',
        'event OfficialInfoUpdated(string website, string twitter, string discord)',
        'event TokenSupportUpdated(address indexed token, bool supported)'
    ];

    const ERC20_ABI = [
        'function balanceOf(address account) external view returns (uint256)',
        'function allowance(address owner, address spender) external view returns (uint256)',
        'function approve(address spender, uint256 amount) external returns (bool)',
        'function decimals() external view returns (uint8)',
        'function symbol() external view returns (string)',
        'function name() external view returns (string)'
    ];

    const listeners = {
        GameCreated: [],
        PlayerJoined: [],
        CommitSubmitted: [],
        ChoiceRevealed: [],
        GameSettled: [],
        TimeoutClaimed: [],
        DrawHandled: [],
        MatchCancelled: []
    };

    let eventFilter = null;

    function isValidAddress(address) {
        return typeof address === 'string' && /^0x[a-fA-F0-9]{40}$/.test(address);
    }

    function init(address, providerInstance, signerInstance = null) {
        if (typeof ethers === 'undefined') {
            throw new Error('ethers.js 未加载');
        }

        // 验证合约地址格式，避免 ethers v6 触发 ENS 解析
        if (!isValidAddress(address)) {
            console.warn('合约地址无效或未配置，跳过合约初始化:', address);
            contract = null;
            contractAddress = null;
            return null;
        }

        contractAddress = address;
        provider = providerInstance;
        signer = signerInstance;

        try {
            if (signer) {
                contract = new ethers.Contract(address, RPS_GAME_ABI, signer);
            } else {
                contract = new ethers.Contract(address, RPS_GAME_ABI, provider);
            }
        } catch (e) {
            console.error('合约初始化失败:', e.message);
            contract = null;
        }

        return contract;
    }

    function setSigner(signerInstance) {
        signer = signerInstance;
        if (contract && signer) {
            contract = contract.connect(signer);
        }
    }

    function getContract() {
        return contract;
    }

    function getTokenContract(tokenAddress) {
        if (!provider) {
            throw new Error('Provider 未初始化');
        }
        if (!isValidAddress(tokenAddress)) {
            throw new Error('无效的代币地址: ' + tokenAddress);
        }
        let tokenContract = new ethers.Contract(tokenAddress, ERC20_ABI, provider);
        if (signer) {
            tokenContract = tokenContract.connect(signer);
        }
        return tokenContract;
    }

    async function getBalance(tokenAddress, account) {
        if (!isValidAddress(tokenAddress)) {
            return '0';
        }
        const tokenContract = getTokenContract(tokenAddress);
        const balance = await tokenContract.balanceOf(account);
        const decimals = await tokenContract.decimals();
        return ethers.formatUnits(balance, decimals);
    }

    async function getAllowance(tokenAddress, owner, spender) {
        const tokenContract = getTokenContract(tokenAddress);
        const allowance = await tokenContract.allowance(owner, spender);
        const decimals = await tokenContract.decimals();
        return ethers.formatUnits(allowance, decimals);
    }

    async function approveToken(tokenAddress, amount) {
        if (!signer) {
            throw new Error('钱包未连接');
        }
        const tokenContract = getTokenContract(tokenAddress);
        const decimals = await tokenContract.decimals();
        const amountWei = ethers.parseUnits(amount.toString(), decimals);
        const tx = await tokenContract.approve(contractAddress, amountWei);
        await tx.wait();
        return tx;
    }

    async function ensureAllowance(tokenAddress, amount, account) {
        if (!isValidAddress(contractAddress)) {
            throw new Error('合约未部署，请先在管理面板部署合约');
        }
        if (!tokenAddress || tokenAddress === '0x0000000000000000000000000000000000000000') {
            return null;
        }
        const allowance = await getAllowance(tokenAddress, account, contractAddress);
        if (parseFloat(allowance) < parseFloat(amount)) {
            return await approveToken(tokenAddress, amount);
        }
        return null;
    }

    async function createMatch(amount, tokenAddress) {
        if (!contract || !signer) {
            throw new Error('合约未初始化或钱包未连接');
        }
        
        let amountWei;
        let txOptions = {};
        
        if (!tokenAddress || tokenAddress === '0x0000000000000000000000000000000000000000') {
            amountWei = ethers.parseEther(amount.toString());
            txOptions.value = amountWei;
        } else {
            const tokenContract = getTokenContract(tokenAddress);
            const decimals = await tokenContract.decimals();
            amountWei = ethers.parseUnits(amount.toString(), decimals);
        }
        
        const tx = await contract.createMatch(amountWei, tokenAddress, txOptions);
        const receipt = await tx.wait();
        
        let gameId = null;
        for (const log of receipt.logs) {
            try {
                const parsed = contract.interface.parseLog(log);
                if (parsed.name === 'GameCreated') {
                    gameId = Number(parsed.args.gameId);
                    break;
                }
            } catch (e) {}
        }
        
        return { tx, gameId };
    }

    async function joinMatch(gameId) {
        if (!contract || !signer) {
            throw new Error('合约未初始化或钱包未连接');
        }
        
        const game = await contract.games(gameId);
        const tokenAddress = game.token;
        const amount = game.amount;
        
        let txOptions = {};
        if (!tokenAddress || tokenAddress === '0x0000000000000000000000000000000000000000') {
            txOptions.value = amount;
        }
        
        const tx = await contract.joinMatch(gameId, txOptions);
        await tx.wait();
        return tx;
    }

    async function submitCommit(gameId, commitHash) {
        if (!contract || !signer) {
            throw new Error('合约未初始化或钱包未连接');
        }
        const tx = await contract.submitCommit(gameId, commitHash);
        await tx.wait();
        return tx;
    }

    async function revealChoice(gameId, choice, salt) {
        if (!contract || !signer) {
            throw new Error('合约未初始化或钱包未连接');
        }
        const tx = await contract.revealChoice(gameId, choice, salt);
        await tx.wait();
        return tx;
    }

    async function claimTimeout(gameId) {
        if (!contract || !signer) {
            throw new Error('合约未初始化或钱包未连接');
        }
        const tx = await contract.claimTimeout(gameId);
        await tx.wait();
        return tx;
    }

    async function handleDraw(gameId) {
        if (!contract || !signer) {
            throw new Error('合约未初始化或钱包未连接');
        }
        const tx = await contract.handleDraw(gameId);
        await tx.wait();
        return tx;
    }

    async function getGame(gameId) {
        if (!contract) {
            throw new Error('合约未初始化');
        }
        const game = await contract.games(gameId);
        return {
            player1: game.player1,
            player2: game.player2,
            amount: game.amount,
            token: game.token,
            commit1: game.commit1,
            commit2: game.commit2,
            choice1: Number(game.choice1),
            choice2: Number(game.choice2),
            commitDeadline: Number(game.commitDeadline),
            revealDeadline: Number(game.revealDeadline),
            status: Number(game.status),
            winner: game.winner,
            isDraw: game.isDraw,
            player1Refunded: game.player1Refunded,
            player2Refunded: game.player2Refunded
        };
    }

    async function getCommit(gameId, player) {
        if (!contract) {
            throw new Error('合约未初始化');
        }
        return await contract.getCommit(gameId, player);
    }

    async function getPlayerGames(player) {
        if (!contract) {
            throw new Error('合约未初始化');
        }
        const gameIds = await contract.getPlayerGames(player);
        return gameIds.map(id => Number(id));
    }

    async function getAntiFakeInfo() {
        if (!contract) {
            throw new Error('合约未初始化');
        }
        const info = await contract.getAntiFakeInfo();
        return {
            developer: info.developer,
            deployTime: Number(info.deployTime),
            version: info.version,
            website: info.website,
            twitter: info.twitter,
            discord: info.discord
        };
    }

    async function getGameCount() {
        if (!contract) {
            throw new Error('合约未初始化');
        }
        return Number(await contract.gameCount());
    }

    async function getFeeRate() {
        if (!contract) {
            throw new Error('合约未初始化');
        }
        return Number(await contract.feeRate());
    }

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

    function setupEventListener() {
        if (!contract || !provider) return;

        const eventNames = [
            'GameCreated',
            'PlayerJoined',
            'CommitSubmitted',
            'ChoiceRevealed',
            'GameSettled',
            'TimeoutClaimed',
            'DrawHandled',
            'MatchCancelled'
        ];

        eventNames.forEach(eventName => {
            contract.on(eventName, (...args) => {
                const event = args[args.length - 1];
                if (listeners[eventName]) {
                    listeners[eventName].forEach(cb => cb(event, args));
                }
            });
        });
    }

    function removeEventListeners() {
        if (!contract) return;
        
        const eventNames = [
            'GameCreated',
            'PlayerJoined',
            'CommitSubmitted',
            'ChoiceRevealed',
            'GameSettled',
            'TimeoutClaimed',
            'DrawHandled',
            'MatchCancelled'
        ];

        eventNames.forEach(eventName => {
            try {
                contract.removeAllListeners(eventName);
            } catch (e) {}
        });
    }

    function getStatusText(status) {
        const statusMap = {
            0: '等待加入',
            1: '提交阶段',
            2: '揭晓阶段',
            3: '已结束',
            4: '已取消'
        };
        return statusMap[status] || '未知';
    }

    return {
        init,
        setSigner,
        getContract,
        getTokenContract,
        getBalance,
        getAllowance,
        approveToken,
        ensureAllowance,
        createMatch,
        joinMatch,
        submitCommit,
        revealChoice,
        claimTimeout,
        handleDraw,
        getGame,
        getCommit,
        getPlayerGames,
        getAntiFakeInfo,
        getGameCount,
        getFeeRate,
        on,
        off,
        setupEventListener,
        removeEventListeners,
        getStatusText,
        ABI: RPS_GAME_ABI,
        ERC20_ABI
    };
})();
