const Contract = (function() {
    let contract = null;
    let contractAddress = null;
    let provider = null;
    let signer = null;
    // 当前链 ID（EIP-712 签名用，init 时从 provider 获取）
    let _chainId = null;

    // 钱包交互操作的总超时（秒）：用户签名 + 链上打包都算入，超时后给出明确错误避免永久卡住
    const DEFAULT_TX_TIMEOUT = 120 * 1000;

    /**
     * 为钱包交互操作包裹超时 + 用户拒绝签名识别
     * @param {string} actionDesc 动作描述，用于错误提示，例如"授权代币"、"创建对局"、"加入对局"
     * @param {Function<Promise>} fn 要执行的异步函数
     * @param {number} [timeoutMs] 超时时间，默认 120s
     */
    async function withWalletTimeout(actionDesc, fn, timeoutMs = DEFAULT_TX_TIMEOUT) {
        let timeoutId = null;
        const timeoutPromise = new Promise((_, reject) => {
            timeoutId = setTimeout(() => {
                reject(new Error(
                    `${actionDesc}超时（${timeoutMs / 1000}s）。` +
                    `请检查钱包是否已弹出签名请求、或当前链节点是否正常响应，然后重试。`
                ));
            }, timeoutMs);
        });
        try {
            return await Promise.race([fn(), timeoutPromise]);
        } catch (e) {
            const msg = (e && e.message) ? e.message : String(e);
            const code = e && e.code != null ? e.code : null;

            if (e && e.userCancelled) throw e;

            const translated = _translateWalletError(e, actionDesc);

            if (translated.userCancelled) {
                const err = new Error(translated.message);
                err.code = 4001;
                err.userCancelled = true;
                throw err;
            }

            const err = new Error(translated.message);
            if (translated.suggestion) err.suggestion = translated.suggestion;
            if (code != null) err.code = code;
            if (e && e.data != null) err.data = e.data;
            throw err;
        } finally {
            if (timeoutId) clearTimeout(timeoutId);
        }
    }

    // 合约 ABI 定义
    const CHAinRPS_ABI = [
        'function createMatch(uint256 amount, address token) external returns (uint256)',
        'function joinMatch(uint256 gameId) external',
        'function submitCommit(uint256 gameId, bytes32 commit) external',
        'function revealChoice(uint256 gameId, uint8 choice, bytes32 salt) external',
        // 方案A：带 EIP-712 签名的代提交版本
        'function submitCommitWithSig(uint256 gameId, address player, bytes32 commit, uint256 nonce, uint8 v, bytes32 r, bytes32 s) external',
        'function revealChoiceWithSig(uint256 gameId, address player, uint8 choice, bytes32 salt, uint256 nonce, uint8 v, bytes32 r, bytes32 s) external',
        // 方案B：relayer 长期授权
        'function authorizeRelayer(address relayer, uint256 duration) external',
        'function revokeRelayer() external',
        'function getRelayerAuthorization(address player) external view returns (bool active, address relayer, uint256 deadline)',
        'function nonces(address player) external view returns (uint256)',
        'function domainSeparator() external view returns (bytes32)',
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
        'event TokenSupportUpdated(address indexed token, bool supported)',
        // 方案A/B 新增事件
        'event RelayerAuthorized(address indexed player, address indexed relayer, uint256 deadline)',
        'event RelayerRevoked(address indexed player, address indexed oldRelayer)',
        'event CommitSubmittedWithSig(uint256 indexed gameId, address indexed player, bytes32 commit, address indexed relayer)',
        'event ChoiceRevealedWithSig(uint256 indexed gameId, address indexed player, uint8 choice, address indexed relayer)'
    ];

    // ERC20 合约 ABI 定义
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

    // 验证合约地址格式
    function isValidAddress(address) {
        return typeof address === 'string' && /^0x[a-fA-F0-9]{40}$/.test(address);
    }

    // 初始化合约
    async function init(address, providerInstance, signerInstance = null) {
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
                contract = new ethers.Contract(address, CHAinRPS_ABI, signer);
            } else {
                contract = new ethers.Contract(address, CHAinRPS_ABI, provider);
            }
            // 获取当前链 ID（EIP-712 签名必需）
            if (provider) {
                const network = await provider.getNetwork();
                _chainId = Number(network.chainId);
            }
        } catch (e) {
            console.error('合约初始化失败:', e.message);
            contract = null;
        }

        return contract;
    }

    // 设置签名者
    function setSigner(signerInstance) {
        signer = signerInstance;
        if (contract && signer) {
            contract = contract.connect(signer);
        }
    }

    // 获取合约实例
    function getContract() {
        return contract;
    }

    // 获取代币合约实例
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

    // 查询代币余额
    async function getBalance(tokenAddress, account) {
        if (!isValidAddress(tokenAddress)) {
            return '0';
        }
        const tokenContract = getTokenContract(tokenAddress);
        const balance = await tokenContract.balanceOf(account);
        const decimals = await tokenContract.decimals();
        return ethers.formatUnits(balance, decimals);
    }

    // 查询代币授权额度
    async function getAllowance(tokenAddress, owner, spender) {
        const tokenContract = getTokenContract(tokenAddress);
        const allowance = await tokenContract.allowance(owner, spender);
        const decimals = await tokenContract.decimals();
        return ethers.formatUnits(allowance, decimals);
    }

    // 将技术错误翻译为用户可理解的中文提示
    function _translateWalletError(e, actionDesc) {
        const msg = (e && e.message) ? e.message : String(e);
        const code = e && e.code != null ? e.code : null;

        if (code === 4001 || /user rejected|user cancelled|用户拒绝|用户取消/i.test(msg)) {
            return {
                userCancelled: true,
                message: `您已取消「${actionDesc}」的操作`
            };
        }
        if (/could not coalesce error/.test(msg)) {
            return {
                userCancelled: false,
                message: `「${actionDesc}」失败：本地链连接异常，请确认本地链(Ganache)已启动且钱包连接的是正确网络`,
                suggestion: '请检查：1) 本地链节点是否运行 2) 钱包网络配置是否正确（Chain ID: 5208888） 3) 钱包是否有足够的测试币'
            };
        }
        if (/nonce too low/.test(msg)) {
            return {
                userCancelled: false,
                message: `「${actionDesc}」失败：钱包 Nonce 过低，请重置钱包账户的 Nonce`,
                suggestion: 'MetaMask: 设置 → 高级 → 清除活动数据；OKX: 设置 → 重置交易计数'
            };
        }
        if (/nonce too high/.test(msg)) {
            return {
                userCancelled: false,
                message: `「${actionDesc}」失败：钱包 Nonce 过高，请等待之前的交易打包完成后再试`,
                suggestion: '等待之前的交易被区块确认，或重置钱包 Nonce'
            };
        }
        if (/intrinsic gas too low|gas limit too low/.test(msg)) {
            return {
                userCancelled: false,
                message: `「${actionDesc}」失败：Gas Limit 过低`,
                suggestion: '请在钱包中提高 Gas Limit 后重试'
            };
        }
        if (/gas price too low|underpriced/.test(msg)) {
            return {
                userCancelled: false,
                message: `「${actionDesc}」失败：Gas 价格过低`,
                suggestion: '请在钱包中提高 Gas 价格后重试'
            };
        }
        if (/insufficient funds|not enough ether/.test(msg)) {
            return {
                userCancelled: false,
                message: `「${actionDesc}」失败：钱包余额不足`,
                suggestion: '请确保钱包有足够的测试币支付 Gas 费'
            };
        }
        if (/execution reverted/.test(msg)) {
            return {
                userCancelled: false,
                message: `「${actionDesc}」失败：链上执行被拒绝`,
                suggestion: '可能是合约状态不满足条件（如合约已暂停、授权额度不足等）'
            };
        }
        if (/Transaction failed/.test(msg)) {
            return {
                userCancelled: false,
                message: `「${actionDesc}」失败：交易被节点拒绝`,
                suggestion: '可能原因：1) 代币合约地址不正确 2) 合约已暂停 3) 钱包余额不足。请检查后重试'
            };
        }
        if (/network changed|chain id.*mismatch|invalid chain id/.test(msg)) {
            return {
                userCancelled: false,
                message: `「${actionDesc}」失败：网络不匹配`,
                suggestion: '请确保钱包连接的是正确的网络（Chain ID: 5208888）'
            };
        }
        if (msg.indexOf(actionDesc) === 0) {
            return { userCancelled: false, message: msg };
        }
        return { userCancelled: false, message: `${actionDesc}失败：${msg}` };
    }

    // 授权代币（含自动重试、前置检查、友好错误提示）
    async function approveToken(tokenAddress, amount) {
        if (!signer) {
            throw new Error('钱包未连接');
        }
        if (!isValidAddress(tokenAddress)) {
            throw new Error('代币地址无效');
        }

        if (typeof FWUI !== 'undefined' && FWUI && FWUI.Toast) {
            FWUI.Toast.info('请在钱包中确认「代币授权」交易（自动管理 Nonce，无需手动设置）');
        }

        const MAX_RETRIES = 2;
        let lastError = null;

        for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
            try {
                return await withWalletTimeout('代币授权', async () => {
                    const tokenContract = getTokenContract(tokenAddress);
                    const decimals = await tokenContract.decimals();
                    const amountWei = ethers.parseUnits(amount.toString(), decimals);
                    const txOptions = {};
                    if (attempt > 0) {
                        try {
                            const feeData = await provider.getFeeData();
                            if (feeData && feeData.gasPrice) {
                                txOptions.gasPrice = (feeData.gasPrice * BigInt(110)) / BigInt(100);
                            }
                        } catch (_) {}
                    }
                    const tx = await tokenContract.approve(contractAddress, amountWei, txOptions);
                    const receipt = await tx.wait();
                    return receipt || tx;
                });
            } catch (e) {
                lastError = e;
                const translated = _translateWalletError(e, '代币授权');

                if (translated.userCancelled) {
                    const err = new Error(translated.message);
                    err.userCancelled = true;
                    throw err;
                }

                if (attempt < MAX_RETRIES) {
                    console.warn(`[Approve] 第${attempt + 1}次授权失败，自动重试:`, e.message);
                    if (typeof FWUI !== 'undefined' && FWUI && FWUI.Toast) {
                        FWUI.Toast.info(`授权失败，自动重试中（${attempt + 1}/${MAX_RETRIES}）...`);
                    }
                    await new Promise(r => setTimeout(r, 800));
                    continue;
                }

                const err = new Error(translated.message);
                if (translated.suggestion) {
                    err.suggestion = translated.suggestion;
                }
                err.details = e;
                throw err;
            }
        }
        throw lastError;
    }

    // 确保代币授权额度充足（不足则发起授权）
    async function ensureAllowance(tokenAddress, amount, account) {
        if (!isValidAddress(contractAddress)) {
            throw new Error('合约未部署，请先在管理面板部署合约');
        }
        if (!tokenAddress || tokenAddress === '0x0000000000000000000000000000000000000000') {
            return null;
        }

        if (!isValidAddress(tokenAddress)) {
            throw new Error('代币合约地址无效，请检查配置');
        }

        let allowance;
        try {
            allowance = await getAllowance(tokenAddress, account, contractAddress);
        } catch (e) {
            const translated = _translateWalletError(e, '查询授权');
            throw new Error(`无法查询代币授权额度：${translated.message}`);
        }

        if (parseFloat(allowance) < parseFloat(amount)) {
            return await approveToken(tokenAddress, amount);
        }
        return null;
    }

    // 创建对局
    async function createMatch(amount, tokenAddress) {
        if (!contract || !signer) {
            throw new Error('合约未初始化或钱包未连接');
        }

        if (typeof FWUI !== 'undefined' && FWUI && FWUI.Toast) {
            FWUI.Toast.info('请在钱包中确认「创建对局」的签名请求');
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

        let tx;
        let receipt;
        let gameId = null;

        try {
            ({ tx, receipt, gameId } = await withWalletTimeout('创建对局', async () => {
                const _tx = await contract.createMatch(amountWei, tokenAddress, txOptions);
                const _receipt = await _tx.wait();
                let _gameId = null;
                // 优先从 receipt 的日志解析（最准确）
                if (_receipt && _receipt.logs) {
                    for (const log of _receipt.logs) {
                        try {
                            const parsed = contract.interface.parseLog(log);
                            if (parsed && parsed.name === 'GameCreated' && parsed.args) {
                                _gameId = Number(parsed.args.gameId);
                                break;
                            }
                        } catch (_) {}
                    }
                }
                // receipt 解析兜底：gameCount - 1（因为刚加 1）
                if (_gameId == null || Number.isNaN(_gameId)) {
                    try {
                        const cnt = await contract.gameCount();
                        _gameId = Math.max(1, Number(cnt));
                    } catch (_) {}
                }
                return { tx: _tx, receipt: _receipt, gameId: _gameId };
            }));
        } catch (e) {
            // 若用户取消，直接抛出不额外处理
            throw e;
        }

        if (!gameId || Number.isNaN(gameId)) {
            throw new Error('交易已上链，但未能从日志解析出 gameId，请重试或联系管理员');
        }

        return { tx, gameId };
    }

    // 加入对局
    async function joinMatch(gameId) {
        if (!contract || !signer) {
            throw new Error('合约未初始化或钱包未连接');
        }

        if (typeof FWUI !== 'undefined' && FWUI && FWUI.Toast) {
            FWUI.Toast.info('请在钱包中确认「加入对局」的签名请求');
        }

        return withWalletTimeout('加入对局', async () => {
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
        });
    }

    // 提交对局哈希值
    async function submitCommit(gameId, commitHash) {
        if (!contract || !signer) {
            throw new Error('合约未初始化或钱包未连接');
        }
        if (typeof FWUI !== 'undefined' && FWUI && FWUI.Toast) {
            FWUI.Toast.info('请在钱包中确认「提交出拳」的签名请求');
        }
        return withWalletTimeout('提交出拳', async () => {
            const tx = await contract.submitCommit(gameId, commitHash);
            await tx.wait();
            return tx;
        });
    }

    // 揭露选择
    async function revealChoice(gameId, choice, salt) {
        if (!contract || !signer) {
            throw new Error('合约未初始化或钱包未连接');
        }
        if (typeof FWUI !== 'undefined' && FWUI && FWUI.Toast) {
            FWUI.Toast.info('请在钱包中确认「揭晓出拳」交易（需 gas 费）');
        }
        return withWalletTimeout('揭晓出拳', async () => {
            const tx = await contract.revealChoice(gameId, choice, salt);
            await tx.wait();
            return tx;
        });
    }

    // ==================== 方案A：EIP-712 链下签名 ====================

    // 获取 EIP-712 域分隔符（与合约保持一致）
    /**
     * @notice 获取 EIP-712 域分隔符
     * @dev 必须与合约 constructor 中计算的 domainSeparator 一致
     *      前端本地构造，避免额外链上调用
     */
    function _getEip712Domain() {
        if (!contractAddress) {
            throw new Error('合约地址未配置');
        }
        return {
            name: 'ChainRPS',
            version: 'v1.2.0',
            chainId: _chainId,
            verifyingContract: contractAddress
        };
    }

    // 查询玩家当前 nonce（签名时必须包含）
    /**
     * @notice 查询玩家当前 nonce
     * @param player 玩家地址
     * @return 当前 nonce 值
     */
    async function getNonce(player) {
        if (!contract) {
            throw new Error('合约未初始化');
        }
        try {
            return Number(await contract.nonces(player));
        } catch (e) {
            // 合约可能是不支持 nonces 的旧版本，默认返回 0
            console.warn('[Contract] nonces() 调用失败，默认 nonce=0:', e.message || e);
            return 0;
        }
    }

    // 生成 commit 的 EIP-712 链下签名（方案A）
    /**
     * @notice 生成 commit 的 EIP-712 链下签名（方案A）
     * @dev 签名内容：Commit(gameId, player, commit, nonce)
     *      MetaMask 会弹出轻量签名确认（非交易，无 gas，秒级完成）
     * @param gameId 对局ID
     * @param player 玩家地址（即签名者）
     * @param commit 哈希承诺
     * @return {nonce, v, r, s, signature} 签名分量与原签名
     */
    async function signCommit(gameId, player, commit) {
        if (!signer) {
            throw new Error('钱包未连接');
        }
        const nonce = await getNonce(player);
        const domain = _getEip712Domain();
        const types = {
            Commit: [
                { name: 'gameId', type: 'uint256' },
                { name: 'player', type: 'address' },
                { name: 'commit', type: 'bytes32' },
                { name: 'nonce', type: 'uint256' }
            ]
        };
        const value = { gameId, player, commit, nonce };

        if (typeof FWUI !== 'undefined' && FWUI && FWUI.Toast) {
            FWUI.Toast.info('请在钱包中确认「提交出拳」签名（无 gas 费）');
        }
        // signTypedData 是 EIP-712 标准签名，MetaMask 不会弹出交易确认，只弹签名确认
        const signature = await withWalletTimeout('签名提交出拳', async () => {
            return await signer.signTypedData(domain, types, value);
        });

        // 拆分签名为 v,r,s（合约需要）
        const sig = ethers.Signature.from(signature);
        return {
            nonce,
            v: sig.v,
            r: sig.r,
            s: sig.s,
            signature
        };
    }

    // 生成 reveal 的 EIP-712 链下签名（方案A）
    /**
     * @notice 生成 reveal 的 EIP-712 链下签名（方案A）
     * @dev 签名内容：Reveal(gameId, player, choice, salt, nonce)
     *      一次签名后由后端代为上链，玩家无需亲自发交易
     * @param gameId 对局ID
     * @param player 玩家地址
     * @param choice 出拳 (1=石头, 2=布, 3=剪刀)
     * @param salt 盐值（bytes32 的 hex 字符串）
     * @return {nonce, v, r, s, signature}
     */
    async function signReveal(gameId, player, choice, salt) {
        if (!signer) {
            throw new Error('钱包未连接');
        }
        const nonce = await getNonce(player);
        const domain = _getEip712Domain();
        const types = {
            Reveal: [
                { name: 'gameId', type: 'uint256' },
                { name: 'player', type: 'address' },
                { name: 'choice', type: 'uint8' },
                { name: 'salt', type: 'bytes32' },
                { name: 'nonce', type: 'uint256' }
            ]
        };
        // salt 统一转成 bytes32 格式
        const saltBytes32 = ethers.zeroPadValue(ethers.getBytes(salt), 32);
        const value = { gameId, player, choice, salt: saltBytes32, nonce };

        if (typeof FWUI !== 'undefined' && FWUI && FWUI.Toast) {
            FWUI.Toast.info('请在钱包中确认「揭晓出拳」签名（无 gas 费）');
        }
        const signature = await withWalletTimeout('签名揭晓出拳', async () => {
            return await signer.signTypedData(domain, types, value);
        });

        const sig = ethers.Signature.from(signature);
        return {
            nonce,
            v: sig.v,
            r: sig.r,
            s: sig.s,
            signature
        };
    }

    // ==================== 方案B：Relayer 长期授权 ====================

    // 授权 relayer（7 天有效期）
    /**
     * @notice 授权 relayer（方案B） - 玩家签名授权后端 relayer 地址 7 天代提交权限
     * @dev 调用合约 authorizeRelayer，需上链交易（一次性）
     * @param relayerAddress 后端 relayer 地址
     * @param durationSeconds 授权时长（秒），0 表示默认 7 天
     */
    async function authorizeRelayer(relayerAddress, durationSeconds = 0) {
        if (!contract || !signer) {
            throw new Error('合约未初始化或钱包未连接');
        }
        if (typeof FWUI !== 'undefined' && FWUI && FWUI.Toast) {
            const days = durationSeconds === 0 ? 7 : Math.floor(durationSeconds / 86400);
            FWUI.Toast.info(`请在钱包中确认「授权代提交」交易（需 gas 费，有效期 ${days} 天）`);
        }
        return withWalletTimeout('授权代提交', async () => {
            const tx = await contract.authorizeRelayer(relayerAddress, durationSeconds);
            await tx.wait();
            return tx;
        });
    }

    // 撤销 relayer 授权
    /**
     * @notice 撤销 relayer 授权（方案B） - 玩家随时可撤销
     */
    async function revokeRelayer() {
        if (!contract || !signer) {
            throw new Error('合约未初始化或钱包未连接');
        }
        if (typeof FWUI !== 'undefined' && FWUI && FWUI.Toast) {
            FWUI.Toast.info('请在钱包中确认「撤销授权」交易（需 gas 费）');
        }
        return withWalletTimeout('撤销授权', async () => {
            const tx = await contract.revokeRelayer();
            await tx.wait();
            return tx;
        });
    }

    // 查询当前玩家的 relayer 授权状态
    /**
     * @notice 查询 relayer 授权状态
     * @param player 玩家地址
     * @return {active, relayer, deadline}
     */
    async function getRelayerAuthorization(player) {
        if (!contract) {
            throw new Error('合约未初始化');
        }
        const result = await contract.getRelayerAuthorization(player);
        return {
            active: result[0],
            relayer: result[1],
            deadline: Number(result[2])
        };
    }

    // 申领超时胜利
    async function claimTimeout(gameId) {
        if (!contract || !signer) {
            throw new Error('合约未初始化或钱包未连接');
        }
        if (typeof FWUI !== 'undefined' && FWUI && FWUI.Toast) {
            FWUI.Toast.info('请在钱包中确认「申领超时胜利」交易（需 gas 费）');
        }
        return withWalletTimeout('申领超时胜利', async () => {
            const tx = await contract.claimTimeout(gameId);
            await tx.wait();
            return tx;
        });
    }

    // 处理平局
    async function handleDraw(gameId) {
        if (!contract || !signer) {
            throw new Error('合约未初始化或钱包未连接');
        }
        if (typeof FWUI !== 'undefined' && FWUI && FWUI.Toast) {
            FWUI.Toast.info('请在钱包中确认「处理平局」交易（需 gas 费）');
        }
        return withWalletTimeout('处理平局', async () => {
            const tx = await contract.handleDraw(gameId);
            await tx.wait();
            return tx;
        });
    }

    // 获取对局详情
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

    // 获取玩家提交的对局哈希值
    async function getCommit(gameId, player) {
        if (!contract) {
            throw new Error('合约未初始化');
        }
        return await contract.getCommit(gameId, player);
    }

    // 获取玩家参与的对局ID列表
    async function getPlayerGames(player) {
        if (!contract) {
            throw new Error('合约未初始化');
        }
        const gameIds = await contract.getPlayerGames(player);
        return gameIds.map(id => Number(id));
    }

    // 获取防伪信息（开发者、部署时间、版本、官方渠道）
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

    // 获取对局总数
    async function getGameCount() {
        if (!contract) {
            throw new Error('合约未初始化');
        }
        return Number(await contract.gameCount());
    }

    // 获取手续费率（以百分比表示）
    async function getFeeRate() {
        if (!contract) {
            throw new Error('合约未初始化');
        }
        return Number(await contract.feeRate());
    }

    // 注册事件监听器
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

    // 设置合约事件监听器
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

    // 移除所有合约事件监听器
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

    // 获取对局状态的中文描述
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

    // 返回合约实例和相关函数
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
        // 方案A：EIP-712 链下签名
        signCommit,
        signReveal,
        getNonce,
        // 方案B：Relayer 长期授权
        authorizeRelayer,
        revokeRelayer,
        getRelayerAuthorization,
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
        ABI: CHAinRPS_ABI,
        ERC20_ABI
    };
})();