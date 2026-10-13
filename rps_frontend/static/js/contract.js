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

    // 进行中的授权交易（按代币+额度去重）：
    // 避免 WS 事件、恢复轮询、P2P 注入重复触发并发授权（相同 Nonce 互相顶掉，导致授权一直失败）
    const _approveInFlight = new Map();

    // 授权前预检（全部走钱包自己的 RPC），把"授权一直失败"的常见隐性原因提前暴露为可操作提示
    // 返回值：{ account, forceNonce, walletBacklog, nodeBacklog, nodeHealthy }
    // - 当钱包侧有 pending 积压但后端节点干净时，返回 forceNonce=节点 latest nonce 让调用方显式覆盖
    //   （绕过钱包本地残留队列，这是本地链重启后高发场景）
    // - 仅当节点也有积压或后端不可达时，才抛出硬拦截错误
    async function _preflightApprove(tokenAddress) {
        if (!provider || !signer) throw new Error('钱包未连接');
        const account = await signer.getAddress();

        // 0) 余额预检查：ETH 不够 gas → 自动调后端 faucet（ChainRPS 本地链专属）
        try {
            const balWei = await provider.getBalance(account);
            const balEth = parseFloat(ethers.formatEther(balWei));
            const MIN_GAS_ETH = 0.01; // approve 大约需要 ~0.0005 ETH，留够余量
            if (balEth < MIN_GAS_ETH) {
                console.warn(`[Preflight] 用户 ETH 余额 ${balEth} < ${MIN_GAS_ETH}，自动请求 faucet 充值`);
                try {
                    const base = (typeof CONFIG !== 'undefined' && CONFIG && CONFIG.backendUrl) ? CONFIG.backendUrl : '';
                    const qs = encodeURIComponent(account);
                    const ctrl = new AbortController();
                    const to = setTimeout(() => ctrl.abort(), 8000);
                    const resp = await fetch(`${base}/api/ext/faucet?address=${qs}&eth_amount=1.0&usdc_amount=50`, {
                        method: 'POST', signal: ctrl.signal
                    });
                    clearTimeout(to);
                    const data = await resp.json();
                    if (data && data.success) {
                        try { FWUI && FWUI.Toast && FWUI.Toast.success && FWUI.Toast.success(`⛽ 自动充值成功！ETH=${data.eth_sent ? '1.0' : '0'}  USDC=${data.usdc_sent ? '50' : '0'}`); } catch (_) {}
                        await new Promise(r => setTimeout(r, 1500)); // 等链上打包
                    } else {
                        console.warn('[Preflight] faucet 返回失败:', data && data.error);
                    }
                } catch (fe) {
                    console.warn('[Preflight] faucet 调用异常（不阻塞）:', fe && fe.message);
                }
            }
        } catch (be) {
            console.warn('[Preflight] 余额检查失败（不阻塞）:', be && be.message);
        }

        // 1) 钱包当前网络上代币合约必须存在（钱包 RPC 配错 / 本地链已重置时这里直接暴露）
        let code = '0x';
        try {
            code = await provider.getCode(tokenAddress);
        } catch (e) {
            const err = new Error('无法连接钱包当前网络的 RPC 节点，授权无法进行');
            err.suggestion = '请检查钱包当前网络的 RPC 是否可用（ChainRPS Local: http://127.0.0.1:8686，Chain ID 5208888），必要时切换网络后重试';
            throw err;
        }
        if (!code || code === '0x') {
            const err = new Error('钱包当前网络上找不到代币合约，授权无法进行');
            err.suggestion = '请确认钱包连接的是 ChainRPS Local（Chain ID 5208888，RPC 127.0.0.1:8686），而不是其它测试链；切换网络后重试';
            throw err;
        }

        // 2) 卡住的 pending 交易会让新授权一直排队发不出去（本地链重启/重置后高发）
        try {
            const [latestNonce, pendingNonce] = await Promise.all([
                provider.getTransactionCount(account, 'latest'),
                provider.getTransactionCount(account, 'pending'),
            ]);
            const walletBacklog = pendingNonce - latestNonce;
            if (walletBacklog > 0) {
                // 钱包会把本地待发队列并入 pending 计数。
                // 决策原则：
                //  A) 后端可信节点可达且 backlog=0 → 用节点 latest nonce 强制覆盖，继续（钱包本地残留，零风险）
                //  B) 后端可达但节点 backlog>0      → 真·链上积压/出块异常，硬拦截并引导重启本地链
                //  C) 后端不可达/超时              → 不永久卡死：回退用钱包 RPC 的 latest（链上已挖出的真实 nonce）
                //     乐观继续；若节点内存池确有冲突，approve 会立即返回 nonce 错误，再走手动清理引导
                let forceNonce = null;
                let nodeBacklog = null;
                let nodeHealthy = false;
                try {
                    const qs = encodeURIComponent(account);
                    const base = (typeof CONFIG !== 'undefined' && CONFIG && CONFIG.backendUrl) ? CONFIG.backendUrl : '';
                    const ctrl = new AbortController();
                    const to = setTimeout(() => ctrl.abort(), 4000);
                    let data = null;
                    try {
                        const resp = await fetch(`${base}/api/ext/wallet-nonce?address=${qs}`, { signal: ctrl.signal });
                        data = await resp.json();
                    } finally {
                        clearTimeout(to);
                    }
                    if (data && data.success) {
                        nodeHealthy = true;
                        nodeBacklog = Number(data.backlog) || 0;
                        if (nodeBacklog === 0) {
                            forceNonce = Number(data.latest_nonce) || 0;
                            console.warn(`[Approve] 钱包本地积压 ${walletBacklog} 笔，节点 backlog=0，用节点 nonce ${forceNonce} 发送`);
                            try { FWUI && FWUI.Toast && FWUI.Toast.warning && FWUI.Toast.warning(`钱包本地有 ${walletBacklog} 笔残留交易记录，将使用链上正确的 Nonce（${forceNonce}）发送授权`); } catch (_) {}
                            return { account, forceNonce, walletBacklog, nodeBacklog, nodeHealthy };
                        }
                    }
                } catch (ce) {
                    console.warn('[Approve] 可信节点 nonce 交叉验证失败，回退钱包 latest nonce:', ce && ce.message);
                }

                // B) 后端明确报告节点内存池积压 → 链本身异常，硬拦截
                if (nodeHealthy && nodeBacklog > 0) {
                    const err = new Error(`钱包中有 ${walletBacklog} 笔卡住的未确认交易（Nonce ${latestNonce} 未推进），新的授权交易无法发出`);
                    err.suggestion = `节点内存池也有 ${nodeBacklog} 笔未打包交易，说明本地链出块异常，建议在管理后台重启本地链；`
                        + '随后在钱包中重置 Nonce（MetaMask 设置 → 高级 → 清除活动和 nonce 数据；OKX 钱包 清除缓存/重置账户），再重试';
                    throw err;
                }

                // C) 后端不可达：用钱包自己的 latest nonce（链上已挖出计数，不含本地队列）乐观继续
                forceNonce = latestNonce;
                console.warn(`[Approve] 后端交叉验证不可用，回退使用钱包 latest nonce ${forceNonce} 乐观继续`);
                try { FWUI && FWUI.Toast && FWUI.Toast.warning && FWUI.Toast.warning(`钱包本地有 ${walletBacklog} 笔残留记录，将直接使用链上 Nonce（${forceNonce}）发送；若钱包报错请重置账户活动数据`); } catch (_) {}
                return { account, forceNonce, walletBacklog, nodeBacklog, nodeHealthy };
            }
        } catch (e2) {
            if (e2 && e2.suggestion) throw e2;
            // 非致命：nonce 查询失败仅记录，不阻断主流程
            console.warn('[Approve] nonce 预检失败，忽略:', e2 && e2.message);
        }
        return { account, forceNonce: null, walletBacklog: 0, nodeBacklog: 0, nodeHealthy: false };
    }

    // ========== 钱包残留队列修复指引 ==========

    // 核心思路：不走自转账（OKX 会认成"未知交易类型"拦截），
    // 直接用 approve(MaxUint256) + forceNonce 一步到位：
    //   1. approve 是标准 ERC20 交易，所有钱包 100% 识别
    //   2. forceNonce 强制使用链上最新 nonce，绕过钱包本地残留队列
    //   3. approve 成功 → 链上 nonce 推进 → 钱包同步刷新 → 71 笔残留自动作废
    //   4. 用户只签这一次，之后 7 天内所有操作零钱包弹窗

    // 弹出 Modal：告知用户残留队列情况 + 让用户选择
    // 返回值：'proceed' | 'manual'
    function _askBacklogFix(backlog, forceNonce, tokenSymbol) {
        return new Promise((resolve) => {
            const modal = (typeof FWUI !== 'undefined' && FWUI && FWUI.Modal) ? FWUI.Modal.create({
                title: '📦 检测到钱包有残留交易',
                closable: false,
                maskClosable: false,
                content: `
                    <div style="line-height:1.7;font-size:14px;">
                        <p>您的钱包里有 <b style="color:#ef4444;">${backlog}</b> 笔卡住的未确认交易记录。</p>
                        <p style="color:#64748b;font-size:13px;margin-top:4px;">
                            当前链上最新 Nonce 是 <code style="background:#f1f5f9;padding:1px 6px;border-radius:4px;">${forceNonce}</code>。
                        </p>

                        <div style="background:#ecfdf5;border:1px solid #a7f3d0;border-radius:8px;padding:12px;margin:12px 0;font-size:13px;color:#065f46;">
                            <b>🚀 一键授权（推荐）</b><br>
                            确认一次标准代币授权 → ${backlog} 笔残留自动失效 → 后续零弹窗 ✨
                        </div>

                        <details style="margin-top:8px;">
                            <summary style="cursor:pointer;color:#6366f1;font-size:12px;font-weight:500;user-select:none;">
                                📖 点击查看详细处理步骤（如果一键授权不行）
                            </summary>
                            <div style="background:#f1f5f9;border-radius:8px;padding:12px;margin-top:8px;font-size:12px;color:#475569;line-height:1.8;">
                                <b>为什么会这样？</b><br>
                                本地链重启后 Nonce 从 0 开始，但钱包还记着旧队列（认为 Nonce 应该更高）。<br><br>

                                <b>方式 1：OKX 钱包清除缓存（推荐）</b><br>
                                1. 打开 OKX 钱包插件 → <b>⚙️ 设置</b><br>
                                2. 找到 <b>"清除缓存" / "重置账户"</b><br>
                                3. 完全关闭游戏标签页 → 重新打开（Ctrl+F5）<br><br>

                                <b>方式 2：切换网络强制同步</b><br>
                                1. OKX 钱包 → 网络设置 → 切到 Polygon<br>
                                2. 等 3 秒 → 切回 ChainRPS Local（ID: 5208888）<br><br>

                                <b>方式 3：MetaMask 用户</b><br>
                                设置 → 高级 → <b>清除活动和 nonce 数据</b><br><br>

                                <b>提示</b>：钱包弹 "Nonce 高于建议值" → <b>那正是残留队列的表现</b>，点"确认"即可继续。
                            </div>
                        </details>
                    </div>
                `,
                footer: `
                    <button class="fwui-btn fwui-btn-default" data-action="manual" style="
                        padding:8px 16px;border-radius:10px;font-size:13px;font-weight:500;cursor:pointer;
                        border:1px solid #e2e8f0;background:#fff;color:#475569;transition:all 0.15s ease;
                    ">📖 我手动清钱包</button>
                    <button class="fwui-btn fwui-btn-primary" data-action="proceed" style="
                        padding:8px 20px;border-radius:10px;font-size:13px;font-weight:600;cursor:pointer;
                        border:none;background:#6366f1;color:#fff;transition:all 0.15s ease;
                    ">🚀 一键授权（推荐）</button>
                `,
            }) : null;

            if (!modal) {
                resolve('proceed');
                return;
            }

            const handlers = {
                proceed: () => { modal.close(); resolve('proceed'); },
                manual: () => { modal.close(); resolve('manual'); },
            };
            Object.entries(handlers).forEach(([action, fn]) => {
                const btn = modal.element.querySelector(`[data-action="${action}"]`);
                if (btn) btn.addEventListener('click', fn);
            });
        });
    }

    // 授权代币（含前置预检、并发去重、自动重试、友好错误提示）
    // opts.unlimited=true：授权 MaxUint256 无限额，一次签名后后续对局无需再确认授权
    async function approveToken(tokenAddress, amount, opts = {}) {
        if (!signer) {
            throw new Error('钱包未连接');
        }
        if (!isValidAddress(tokenAddress)) {
            throw new Error('代币地址无效');
        }

        const unlimited = !!opts.unlimited;
        const actionDesc = unlimited ? '代币长期授权' : '代币授权';
        const inflightKey = tokenAddress.toLowerCase() + '#' + (unlimited ? 'max' : String(amount));
        if (_approveInFlight.has(inflightKey)) {
            console.log('[Approve] 相同授权交易已在进行中，复用该请求');
            return _approveInFlight.get(inflightKey);
        }

        const task = (async () => {
            try {
                const preflight = await _preflightApprove(tokenAddress);
                let forceNonce = preflight && preflight.forceNonce != null ? preflight.forceNonce : null;
                const walletBacklog = (preflight && preflight.walletBacklog) || 0;
                const nodeBacklog = (preflight && preflight.nodeBacklog) || 0;

                // 检测到钱包残留队列 + forceNonce 可用 → 弹出 Modal 让用户确认
                // approve(MaxUint256) + forceNonce 本身就能同时解决授权 + 刷新钱包状态两个问题
                if (walletBacklog > 0 && forceNonce != null && nodeBacklog === 0) {
                    // 查一下代币 symbol 给 Modal 显示用
                    let tokenSymbol = '';
                    try {
                        const tc = getTokenContract(tokenAddress);
                        tokenSymbol = await tc.symbol();
                    } catch (e) {}
                    const choice = await _askBacklogFix(walletBacklog, forceNonce, tokenSymbol);
                    console.log(`[Approve] backlog=${walletBacklog} 选择: ${choice}`);

                    if (choice === 'manual') {
                        // 用户选择手动处理
                        const err = new Error('钱包有 ' + walletBacklog + ' 笔残留交易，请先手动清除');
                        err.suggestion = '清除方法：MetaMask → 设置 → 高级 → 清除活动和 nonce 数据；'
                            + 'OKX 钱包 → 设置 → 清除缓存 / 重置账户。'
                            + '清除后完全关闭游戏标签页，重新打开（Ctrl+F5），再创建/加入房间。';
                        throw err;
                    }
                    // choice === 'proceed' → 直接走 forceNonce 的 approve（后面会处理）
                }

                if (typeof FWUI !== 'undefined' && FWUI && FWUI.Toast) {
                    FWUI.Toast.info(unlimited
                        ? '请在钱包中确认「代币授权」（无限额授权，后续对局无需再次确认）'
                        : '请在钱包中确认「代币授权」交易（自动管理 Nonce，无需手动设置）');
                }

                // forceNonce 模式下，钱包内部残留队列不会因 dApp 重试而清除
                // 超时缩短为 30s（钱包卡了的话 120s 也是白等），不重试
                const forceNonceMode = forceNonce != null;
                const txTimeout = forceNonceMode ? 30 * 1000 : undefined;
                const MAX_RETRIES = forceNonceMode ? 0 : 2;

                for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
                    try {
                        return await withWalletTimeout(actionDesc, async () => {
                            const tokenContract = getTokenContract(tokenAddress);
                            const decimals = await tokenContract.decimals();
                            const approveAmount = unlimited
                                ? ethers.MaxUint256
                                : ethers.parseUnits(amount.toString(), decimals);
                            const txOptions = {};
                            if (forceNonce != null) {
                                // 绕过钱包本地残留队列，显式指定链上正确 nonce
                                txOptions.nonce = forceNonce;
                                console.log(`[Approve] forceNonce=${forceNonce}，token=${tokenAddress.slice(0,8)}... to=${contractAddress.slice(0,8)}...`);
                            }
                            if (attempt > 0) {
                                try {
                                    const feeData = await provider.getFeeData();
                                    if (feeData && feeData.gasPrice) {
                                        txOptions.gasPrice = (feeData.gasPrice * BigInt(110)) / BigInt(100);
                                    }
                                } catch (_) {}
                            }
                            const t0 = Date.now();
                            console.log(`[Approve] attempt=${attempt+1} amount=${unlimited ? 'MaxUint256' : amount} overrides=${JSON.stringify(Object.fromEntries(Object.entries(txOptions).map(([k,v])=>[k, typeof v==='bigint' ? v.toString() : v])))}`);
                            const tx = await tokenContract.approve(contractAddress, approveAmount, txOptions);
                            console.log(`[Approve] eth_sendTransaction ok hash=${tx.hash} elapsed=${Date.now()-t0}ms`);
                            const receipt = await tx.wait();
                            console.log(`[Approve] tx.wait ok status=${receipt.status} block=${receipt.blockNumber} elapsed=${Date.now()-t0}ms`);
                            return receipt || tx;
                        }, txTimeout);
                    } catch (e) {
                        // forceNonce 模式下任何失败都指向钱包内部队列——dApp 已用正确 nonce 尝试
                        // 可能的底层错误：could not coalesce error（钱包扩展挂起拒绝）、
                        // -32000/-32603、nonce too high 等
                        if (forceNonceMode && attempt === MAX_RETRIES) {
                            const raw = (e && e.message) ? e.message : String(e);
                            const timedOut = /超时/.test(raw) || (e && e.code === 'TIMEOUT');
                            const walletBlocked = /could not coalesce|execution reverted|nonce too high|account nonce/i.test(raw);
                            const backlog = (preflight && preflight.walletBacklog) || 0;
                            console.error('[Approve] forceNonce=' + forceNonce + ' backlog=' + backlog + ' 最终失败 raw=', raw, 'err=', e);

                            // 直接弹 Modal 让用户选择（而不是 throw Error 让上层卡住）
                            if (typeof FWUI !== 'undefined' && FWUI && FWUI.Modal) {
                                const reasonDetail = timedOut
                                    ? `<b>原因：</b>钱包 30 秒内没有响应签名请求。`
                                    : walletBlocked
                                        ? `<b>原因：</b>钱包内部有 ${backlog} 笔残留交易队列，拒绝发送新交易。`
                                        : `<b>原因：</b>${raw}`;
                                const modal = FWUI.Modal.alert({
                                    title: timedOut ? '⏰ 钱包未响应' : '🔒 钱包被残留队列阻塞',
                                    closable: false,
                                    content: `
                                        <div style="line-height:1.7;font-size:14px;">
                                            <p>代币授权（approve）未成功，<b>无法继续</b>。</p>
                                            <p style="color:#64748b;font-size:13px;">${reasonDetail}</p>
                                            ${!timedOut ? `
                                            <details style="margin-top:12px;">
                                                <summary style="cursor:pointer;color:#6366f1;font-size:12px;font-weight:500;user-select:none;">
                                                    📖 点击查看详细处理步骤
                                                </summary>
                                                <div style="background:#f1f5f9;border-radius:8px;padding:12px;margin-top:8px;font-size:12px;color:#475569;line-height:1.8;">
                                                    <b>方式 1：OKX 钱包清除缓存（推荐）</b><br>
                                                    1. OKX 钱包插件 → <b>⚙️ 设置</b><br>
                                                    2. 找到 <b>"清除缓存" / "重置账户"</b><br>
                                                    3. 完全关闭游戏标签页 → 重新打开（Ctrl+F5）<br><br>
                                                    <b>方式 2：切换网络强制同步</b><br>
                                                    1. OKX → 网络设置 → 切到 Polygon<br>
                                                    2. 等 3 秒 → 切回 ChainRPS Local（ID: 5208888）<br><br>
                                                    <b>MetaMask 用户</b><br>
                                                    设置 → 高级 → <b>清除活动和 nonce 数据</b><br><br>
                                                    <b>通用</b>：清除后完全关闭游戏标签页，重新打开（Ctrl+F5），再次创建/加入房间。
                                                </div>
                                            </details>
                                            ` : `
                                            <p style="color:#94a3b8;font-size:12px;margin-top:8px;">
                                                钱包弹窗确认请求超时。请在钱包插件中检查是否有待确认的交易请求。
                                            </p>
                                            `}
                                            <p style="color:#94a3b8;font-size:12px;margin-top:10px;">
                                                已使用链上正确 Nonce（${forceNonce}）尝试发送，链本身正常。
                                            </p>
                                        </div>
                                    `,
                                    okText: '我去处理',
                                });
                            }
                            const err = new Error(timedOut
                                ? `「${actionDesc}」超时，钱包未响应。`
                                : `「${actionDesc}」失败：钱包内部残留队列阻塞（${backlog} 笔）。`);
                            err.suggestion = '清除钱包活动数据后重试。';
                            err._modalShown = true; // 已弹 Modal 指引，上层不要重复弹 Toast
                            throw err;
                        }

                        const translated = _translateWalletError(e, actionDesc);

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
                throw new Error(actionDesc + '失败');
            } finally {
                _approveInFlight.delete(inflightKey);
            }
        })();

        _approveInFlight.set(inflightKey, task);
        return task;
    }

    // 无限授权 localStorage 缓存 key 前缀
    const UNLIMITED_APPROVE_CACHE_KEY = 'rps_unlimited_approve_v1';
    // 缓存有效期（毫秒）：7 天（接近无限授权的实际有效期）
    const CACHE_TTL_MS = 7 * 24 * 3600 * 1000;

    // 读取缓存：key = tokenAddress_spenderAddress_account_chainId
    function _readUnlimitedCache(tokenAddress, spenderAddress, account, chainId) {
        try {
            const raw = localStorage.getItem(UNLIMITED_APPROVE_CACHE_KEY);
            if (!raw) return null;
            const all = JSON.parse(raw);
            const key = tokenAddress.toLowerCase() + '_' + spenderAddress.toLowerCase() + '_' + account.toLowerCase() + '_' + String(chainId);
            const entry = all[key];
            if (!entry) return null;
            if (Date.now() - entry.timestamp > CACHE_TTL_MS) {
                delete all[key];
                localStorage.setItem(UNLIMITED_APPROVE_CACHE_KEY, JSON.stringify(all));
                return null;
            }
            return entry;
        } catch (e) { return null; }
    }

    // 写入缓存
    function _writeUnlimitedCache(tokenAddress, spenderAddress, account, chainId, extra = {}) {
        try {
            const raw = localStorage.getItem(UNLIMITED_APPROVE_CACHE_KEY);
            const all = raw ? JSON.parse(raw) : {};
            const key = tokenAddress.toLowerCase() + '_' + spenderAddress.toLowerCase() + '_' + account.toLowerCase() + '_' + String(chainId);
            all[key] = { timestamp: Date.now(), ...extra };
            localStorage.setItem(UNLIMITED_APPROVE_CACHE_KEY, JSON.stringify(all));
        } catch (e) {}
    }

    // 确保代币授权额度充足（不足则发起授权）
    // opts.unlimited=true 时一次性无限额授权（用户设置中的"自动授权"）
    // 无限授权成功后写入 localStorage 缓存，后续直接跳过链上查询和授权
    async function ensureAllowance(tokenAddress, amount, account, opts = {}) {
        if (!isValidAddress(contractAddress)) {
            throw new Error('合约未部署，请先在管理面板部署合约');
        }
        if (!tokenAddress || tokenAddress === '0x0000000000000000000000000000000000000000') {
            return null;
        }

        if (!isValidAddress(tokenAddress)) {
            throw new Error('代币合约地址无效，请检查配置');
        }

        const unlimited = !!opts.unlimited;

        // 无限授权模式：先查 localStorage 缓存，命中则完全跳过（零钱包交互）
        if (unlimited && _chainId) {
            const cached = _readUnlimitedCache(tokenAddress, contractAddress, account, _chainId);
            if (cached) {
                console.log(`[ensureAllowance] 命中无限授权缓存，跳过。token=${tokenAddress.slice(0,8)}... account=${account.slice(0,8)}...`);
                return null;
            }
        }

        let allowance;
        try {
            allowance = await getAllowance(tokenAddress, account, contractAddress);
        } catch (e) {
            // 链上查询失败时，若开启无限授权缓存：不阻塞，继续尝试
            console.warn('[ensureAllowance] allowance 查询失败，继续尝试 approve:', e.message);
            allowance = '0';
        }

        // 无限授权模式且链上额度已足够（>= 2^255 即半最大 uint256 视为无限）：写入缓存跳过后续
        if (unlimited) {
            try {
                const allowanceBigInt = BigInt(ethers.parseUnits(allowance || '0', 0));
                const halfMax = BigInt('5789604461865809771178549250434395392641878213953745219130256131827927536896'); // 2^255
                if (allowanceBigInt >= halfMax) {
                    _writeUnlimitedCache(tokenAddress, contractAddress, account, _chainId || 0, { from: 'chain' });
                    console.log(`[ensureAllowance] 链上额度已 >= 2^255，写入缓存跳过后续。`);
                    return null;
                }
            } catch (e) {
                // allowance parse 失败没关系，继续走 approve 流程
            }
        }

        if (parseFloat(allowance) < parseFloat(amount)) {
            const result = await approveToken(tokenAddress, amount, opts);
            // approve 成功：无限模式写缓存
            if (unlimited && result) {
                _writeUnlimitedCache(tokenAddress, contractAddress, account, _chainId || 0, { from: 'approve' });
                console.log(`[ensureAllowance] approve 成功，写入无限授权缓存。`);
            }
            return result;
        }

        // 额度足够（但不是无限授权模式）：不写缓存，依赖下次链上查询
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