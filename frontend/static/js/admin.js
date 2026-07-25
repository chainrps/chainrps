const AdminApp = {
    adminAddress: null,
    provider: null,
    signer: null,
    currentTab: 'dashboard',

    // tab 标识符与 hash 路由的映射
    _tabHashMap: {
        'dashboard': '#/dashboard',
        'contracts': '#/contracts',
        'chainExplorer': '#/chain-explorer',
        'localChain': '#/local-chain',
        'redis': '#/redis',
        'config': '#/config',
        'chainConfig': '#/chain-config',
        'audit': '#/audit',
    },

    init() {
        this.loadTheme();
        this._initSidebar();
        this._initHashRouter();
        // 优先检查登录状态，未登录则显示登录页，已登录才初始化后台
        this._checkAuthAndInit();
    },

    // ==================== 认证与登录 ====================

    getToken() {
        return localStorage.getItem('adminToken') || '';
    },

    setToken(token) {
        localStorage.setItem('adminToken', token);
    },

    clearToken() {
        localStorage.removeItem('adminToken');
        localStorage.removeItem('adminUser');
    },

    _showLogin() {
        document.getElementById('loginOverlay').classList.remove('hidden');
        // 预填默认用户名方便开发
        if (!document.getElementById('loginUsername').value) {
            document.getElementById('loginUsername').value = 'admin';
        }
    },

    _hideLogin() {
        document.getElementById('loginOverlay').classList.add('hidden');
    },

    async _checkAuthAndInit() {
        const token = this.getToken();
        if (!token) {
            this._showLogin();
            return;
        }
        // 验证 token 是否有效
        try {
            const res = await fetch(CONFIG.backendUrl + '/api/auth/me', {
                headers: { 'Authorization': 'Bearer ' + token }
            });
            if (res.ok) {
                const data = await res.json();
                this.adminUser = data.admin;
                localStorage.setItem('adminUser', JSON.stringify(data.admin));
                this._hideLogin();
                this._initAfterAuth();
            } else {
                // token 失效
                this.clearToken();
                this._showLogin();
            }
        } catch (e) {
            // 后端不可达，仍显示登录页
            this._showLogin();
        }
    },

    async handleLogin(event) {
        event.preventDefault();
        const username = document.getElementById('loginUsername').value.trim();
        const password = document.getElementById('loginPassword').value;
        const errEl = document.getElementById('loginError');
        const btn = document.getElementById('loginSubmitBtn');
        errEl.textContent = '';
        btn.disabled = true;
        btn.textContent = '登录中...';
        try {
            const res = await fetch(CONFIG.backendUrl + '/api/auth/login', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ username, password })
            });
            const data = await res.json();
            if (res.ok && data.success && data.token) {
                this.setToken(data.token);
                this.adminUser = data.admin;
                localStorage.setItem('adminUser', JSON.stringify(data.admin));
                this._hideLogin();
                // 清空密码框
                document.getElementById('loginPassword').value = '';
                this._initAfterAuth();
            } else {
                errEl.textContent = data.detail || data.message || '登录失败';
            }
        } catch (e) {
            errEl.textContent = '网络错误：' + e.message;
        } finally {
            btn.disabled = false;
            btn.textContent = '登录';
        }
        return false;
    },

    logout() {
        this.clearToken();
        this.adminUser = null;
        this._showLogin();
    },

    _initAfterAuth() {
        this.autoConnectWallet();
        // 根据初始 hash 决定加载哪个 tab，默认 dashboard
        const startTab = this._tabFromHash() || 'dashboard';
        this.switchTab(startTab, false);
    },

    // ==================== 侧边栏交互 ====================

    _initSidebar() {
        const sidebar = document.getElementById('adminSidebar');
        const toggle = document.getElementById('sidebarToggle');
        // 恢复收缩状态
        if (localStorage.getItem('adminSidebarCollapsed') === '1') {
            sidebar.classList.add('collapsed');
        }
        toggle.addEventListener('click', () => {
            sidebar.classList.toggle('collapsed');
            localStorage.setItem('adminSidebarCollapsed', sidebar.classList.contains('collapsed') ? '1' : '0');
        });

        // 模糊查询
        const searchInput = document.getElementById('navSearch');
        searchInput.addEventListener('input', () => this._filterNav(searchInput.value));
    },

    _filterNav(keyword) {
        const kw = (keyword || '').trim().toLowerCase();
        document.querySelectorAll('.sidebar-nav .nav-item').forEach(item => {
            const label = (item.querySelector('.nav-label')?.textContent || '').toLowerCase();
            const icon = (item.querySelector('.nav-icon')?.textContent || '').toLowerCase();
            const tab = (item.dataset.tab || '').toLowerCase();
            const match = !kw || label.includes(kw) || tab.includes(kw) || icon.includes(kw);
            item.style.display = match ? '' : 'none';
        });
    },

    // ==================== Hash 路由 ====================

    _initHashRouter() {
        window.addEventListener('hashchange', () => {
            const tab = this._tabFromHash();
            if (tab && tab !== this.currentTab) {
                this.switchTab(tab, false);
            }
        });
    },

    _tabFromHash() {
        const hash = window.location.hash;
        const entry = Object.entries(this._tabHashMap).find(([_, h]) => h === hash);
        return entry ? entry[0] : null;
    },

    _updateHash(tabName) {
        const hash = this._tabHashMap[tabName];
        if (hash && window.location.hash !== hash) {
            // 使用 replaceState 避免产生多余历史记录
            history.replaceState(null, '', hash);
        }
    },

    async autoConnectWallet() {
        if (!window.ethereum) return;
        
        try {
            // 尝试获取已授权的账户列表
            const accounts = await window.ethereum.request({ method: 'eth_accounts' });
            if (accounts.length > 0) {
                this.adminAddress = accounts[0];
                this.provider = new ethers.BrowserProvider(window.ethereum);
                this.signer = await this.provider.getSigner();

                // 更新 UI 显示已连接状态
                document.getElementById('adminWallet').innerHTML = `
                    <span style="font-family: monospace; font-size: 13px; color: var(--text-secondary);">
                        ${this.adminAddress.slice(0, 8)}...${this.adminAddress.slice(-6)}
                    </span>
                `;
                document.getElementById('adminConnectInfo').style.display = 'flex';
                document.getElementById('adminAddress').textContent = this.adminAddress;

                this.loadContractInfo();
            }
        } catch (e) {
            // 用户未授权或钱包未连接，保持默认状态
            console.log('Auto-connect failed:', e.message);
        }
    },

    loadTheme() {
        const theme = localStorage.getItem('theme') || 'light';
        document.documentElement.setAttribute('data-theme', theme);
    },

    switchTab(tabName, updateHash) {
        // updateHash 默认为 true（由用户点击触发时需要更新 URL）
        if (typeof updateHash === 'undefined') updateHash = true;
        this.currentTab = tabName;
        document.querySelectorAll('.sidebar-nav .nav-item').forEach(btn => {
            btn.classList.toggle('active', btn.dataset.tab === tabName);
        });
        document.querySelectorAll('.admin-section').forEach(s => s.classList.remove('active'));
        const section = document.getElementById('tab-' + tabName);
        if (section) section.classList.add('active');

        // 更新 URL hash（支持直接访问）
        if (updateHash) this._updateHash(tabName);

        // 按需懒加载对应模块的数据
        if (tabName === 'dashboard') this.loadDashboard();
        if (tabName === 'contracts') this.loadContracts();
        if (tabName === 'config') this.loadConfig();
        if (tabName === 'audit') this.loadAuditLogs();
        if (tabName === 'localChain') this.refreshNodeStatus();
        if (tabName === 'redis') this.refreshRedisStatus();
    },

    async apiRequest(path, method = 'GET', body = null) {
        const headers = { 'Content-Type': 'application/json' };
        // 携带 JWT token 认证
        const token = this.getToken();
        if (token) {
            headers['Authorization'] = 'Bearer ' + token;
        }
        // 兼容：保留旧的钱包地址头（审计日志用）
        if (this.adminAddress) {
            headers['X-Admin-Address'] = this.adminAddress;
        }
        const res = await fetch(CONFIG.backendUrl + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
        // 401 表示未登录或 token 过期，清除并跳转登录
        if (res.status === 401) {
            this.clearToken();
            this._showLogin();
            throw new Error('未登录或登录已过期，请重新登录');
        }
        if (!res.ok) throw new Error(`API error: ${res.status}`);
        return res.json();
    },

    async loadDashboard() {
        try {
            const data = await this.apiRequest('/api/admin/dashboard');
            document.getElementById('statTotalGames').textContent = data.total_games;
            document.getElementById('statFinishedGames').textContent = data.finished_games;
            document.getElementById('statPlayers').textContent = data.active_players_approx;
            document.getElementById('statTotalFee').textContent = data.total_fee_collected.toFixed(2);
            document.getElementById('statContracts').textContent = data.total_contracts;

            const health = await this.apiRequest('/health');
            document.getElementById('redisStatus').textContent = health.redis ? '已连接' : '未连接';
            document.getElementById('redisStatus').className = 'tag ' + (health.redis ? 'tag-active' : 'tag-inactive');
        } catch (e) {
            console.error('Failed to load dashboard:', e);
        }
    },

    async loadContracts() {
        try {
            const network = document.getElementById('networkFilter').value;
            const path = network ? `/api/admin/contracts?network=${network}` : '/api/admin/contracts';
            const contracts = await this.apiRequest(path);
            
            // 保存合约列表供下拉菜单使用
            this._contractList = contracts;
            
            const tbody = document.getElementById('contractsTableBody');

            if (contracts.length === 0) {
                tbody.innerHTML = '<tr><td colspan="8" style="text-align:center; padding: 40px; color: var(--text-secondary);">暂无合约记录</td></tr>';
                return;
            }

            tbody.innerHTML = contracts.map(c => `
                <tr>
                    <td>${c.id}</td>
                    <td>${c.name}</td>
                    <td style="font-family: monospace; font-size: 12px;">${c.address.slice(0, 10)}...${c.address.slice(-8)}</td>
                    <td>${c.version}</td>
                    <td>${c.network}</td>
                    <td><span class="tag ${c.status === 'active' ? 'tag-active' : 'tag-inactive'}">${c.status}</span></td>
                    <td>${c.deployed_at ? new Date(c.deployed_at).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }) : '-'}</td>
                    <td>
                        <button class="btn btn-secondary" style="padding:4px 8px; font-size:12px;" onclick="AdminApp.viewContract(${c.id})">查看</button>
                    </td>
                </tr>
            `).join('');
        } catch (e) {
            console.error('Failed to load contracts:', e);
        }
    },

    showAddContractModal() {
        document.getElementById('contractModal').classList.add('show');
    },

    closeContractModal() {
        document.getElementById('contractModal').classList.remove('show');
    },

    async addContract() {
        const name = document.getElementById('modalContractName').value;
        const address = document.getElementById('modalContractAddress').value;
        const version = document.getElementById('modalContractVersion').value;
        const network = document.getElementById('modalContractNetwork').value;
        const abi = document.getElementById('modalContractAbi').value;
        const description = document.getElementById('modalContractDesc').value;

        if (!name || !address) {
            FWUI.Toast.warning('请填写合约名称和地址');
            return;
        }

        try {
            await this.apiRequest('/api/admin/contracts', 'POST', {
                name, address, version, network, abi, description,
                deployed_by: this.adminAddress,
                status: 'active'
            });
            this.closeContractModal();
            this.loadContracts();
            this.loadDashboard();
            FWUI.Toast.success('合约记录添加成功');
        } catch (e) {
            FWUI.Toast.error('添加失败: ' + e.message);
        }
    },

    showDeployModal() {
        if (!this.signer) {
            FWUI.Toast.warning('请先连接管理员钱包');
            return;
        }
        // 默认填充当前钱包地址
        document.getElementById('deployFeeCollector').value = this.adminAddress || '';
        document.getElementById('deployDeveloper').value = this.adminAddress || '';
        document.getElementById('deploySteps').style.display = 'none';
        document.getElementById('deployStatus').style.display = 'none';
        document.getElementById('deployButton').disabled = false;
        document.getElementById('deployButton').textContent = '开始部署';
        document.getElementById('deployModal').classList.add('show');
    },

    closeDeployModal() {
        document.getElementById('deployModal').classList.remove('show');
    },

    setDeployStep(step, completed = false) {
        for (let i = 1; i <= 4; i++) {
            const el = document.getElementById('deployStep' + i);
            if (el) {
                if (i < step) el.classList.add('completed');
                else el.classList.remove('completed');
            }
        }
        if (completed) {
            document.getElementById('deployStep' + step).classList.add('completed');
        }
    },

    truncateLongString(str, maxLength = 200) {
        if (!str || typeof str !== 'string') return str;
        if (str.length <= maxLength) return str;
        const prefixLen = Math.floor(maxLength * 0.3);
        const suffixLen = Math.floor(maxLength * 0.3);
        return str.slice(0, prefixLen) + '...[省略' + (str.length - prefixLen - suffixLen) + '个字符]...' + str.slice(-suffixLen);
    },

    showDeployStatus(message, type = 'info') {
        const el = document.getElementById('deployStatus');
        el.style.display = 'block';
        el.className = 'deploy-status ' + type;

        // 对于错误类型，截断过长的消息
        if (type === 'error') {
            message = this.truncateLongString(message, 300);
        }

        el.textContent = message;
    },

    // 将 ethers.js / RPC 错误翻译为中文提示
    translateDeployError(error) {
        const msg = (error && error.message) ? error.message : String(error);
        const lower = msg.toLowerCase();

        // 按优先级匹配常见错误模式
        const patterns = [
            { test: /user rejected|action_rejected|user denied/, zh: '您在钱包中拒绝了签名请求' },
            { test: /insufficient funds|gas required exceeds allowance/, zh: '账户余额不足，无法支付部署所需的 Gas 费用' },
            { test: /could not coalesce error.*rpc.*0x7a69|rpc.*0x7a69.*custom error/, zh: '本地链(Ganache)返回了非标准错误，可能是 Ganache 版本与 ethers.js v6 不兼容，或合约构造函数执行失败' },
            { test: /invalid chain id.*for chain with id/, zh: 'Chain ID 不匹配：MetaMask 网络配置的 Chain ID 与本地节点不一致。请点击本地链页面的"🔗 切换到本地网络"按钮自动配置' },
            { test: /could not coalesce error/, zh: '链端返回了无法解析的错误响应，请检查节点是否正常运行' },
            { test: /execution reverted/, zh: '合约执行被回退(revert)，通常是构造函数参数校验失败或前置条件不满足' },
            { test: /nonce too low/, zh: 'Nonce 过低，请重置钱包账户的 Nonce（MetaMask → 设置 → 高级 → 清除活动数据）' },
            { test: /nonce too high/, zh: 'Nonce 过高，请等待之前的交易打包后再试' },
            { test: /gas price too low|underpriced/, zh: 'Gas 价格太低，被节点拒绝' },
            { test: /intrinsic gas too low|gas limit/, zh: 'Gas Limit 太低，无法完成合约部署' },
            { test: /network changed|chain id mismatch/, zh: '网络已切换或 Chain ID 不匹配，请确认钱包连接的是正确网络' },
            { test: /already known/, zh: '相同的交易已存在，请勿重复提交' },
            { test: /replacement transaction underpriced/, zh: '替换交易的价格太低' },
            { test: /contract factory.*not defined|bytecode.*not/, zh: '未找到合约编译产物(Bytecode)，请检查后端编译是否成功' },
            { test: /timeout|timed out/, zh: '请求超时，请检查节点是否正常运行' },
            { test: /connect.*failed|econnrefused|fetch failed/, zh: '无法连接到 RPC 节点，请确认本地链(8545)已启动' },
        ];

        // 提取关键错误信息（错误码、RPC错误码等）
        const errorCodeMatch = msg.match(/0x[0-9a-fA-F]+/);
        const rpcCodeMatch = msg.match(/code:\s*(-?\d+)/);
        const errorInfo = [];
        if (errorCodeMatch) errorInfo.push(errorCodeMatch[0]);
        if (rpcCodeMatch) errorInfo.push(`code:${rpcCodeMatch[1]}`);
        
        for (const p of patterns) {
            if (p.test.test(lower)) {
                // 返回中文翻译 + 关键错误代码
                if (errorInfo.length > 0) {
                    return p.zh + ' [' + errorInfo.join(', ') + ']';
                }
                return p.zh;
            }
        }

        // 未知错误：返回简短提示 + 截断的原始信息
        return '部署失败（未知错误类型），原始信息：' + this.truncateLongString(msg, 150);
    },

    async deployContract() {
        const networkName = document.getElementById('deployNetwork').value;
        const feeCollector = document.getElementById('deployFeeCollector').value.trim();
        const developer = document.getElementById('deployDeveloper').value.trim();

        if (!feeCollector || !developer) {
            FWUI.Toast.warning('请填写手续费接收地址和官方开发者地址');
            return;
        }
        if (!/^0x[a-fA-F0-9]{40}$/.test(feeCollector) || !/^0x[a-fA-F0-9]{40}$/.test(developer)) {
            FWUI.Toast.warning('地址格式不正确');
            return;
        }
        if (!this.signer) {
            FWUI.Toast.warning('请先连接钱包');
            return;
        }

        const deployButton = document.getElementById('deployButton');
        deployButton.disabled = true;
        deployButton.textContent = '部署中...';
        document.getElementById('deploySteps').style.display = 'block';
        this.setDeployStep(1);
        
        setTimeout(() => {
            const deployModal = document.getElementById('deployModal');
            if (deployModal) {
                const modalContent = deployModal.querySelector('.modal-content');
                if (modalContent) {
                    modalContent.scrollTop = modalContent.scrollHeight;
                }
            }
        }, 100);

        try {
            this.showDeployStatus('正在获取合约编译产物 (ABI + Bytecode)...', 'info');
            const artifacts = await this.apiRequest('/api/admin/contracts/compile-artifacts');

            if (!artifacts.bytecode) {
                throw new Error('未找到合约 Bytecode，请检查后端日志');
            }

            this.setDeployStep(1, true);
            this.setDeployStep(2);

            const abi = typeof artifacts.abi === 'string' ? JSON.parse(artifacts.abi) : artifacts.abi;
            const factory = new ethers.ContractFactory(abi, artifacts.bytecode, this.signer);

            this.showDeployStatus('正在准备部署交易...', 'info');

            const gasLimit = 3000000n;
            const ethersNetwork = await this.provider.getNetwork();
            const chainId = Number(ethersNetwork.chainId);
            const deployOptions = { gasLimit };

            const isLocalNet = chainId === 31337 || chainId === 1337;

            try {
                const feeData = await this.provider.getFeeData();

                if (isLocalNet) {
                    // Ganache 不支持 EIP-1559，必须使用 legacy gasPrice
                    // 否则会出现 "RPC 0x7a69 Custom error" + maxPriorityFeePerGas 错误
                    deployOptions.gasPrice = feeData.gasPrice || ethers.parseUnits('20', 'gwei');
                } else {
                    if (feeData.maxFeePerGas && feeData.maxPriorityFeePerGas) {
                        const minPriority = ethers.parseUnits('30', 'gwei');
                        const minMaxFee = ethers.parseUnits('50', 'gwei');
                        deployOptions.maxPriorityFeePerGas = feeData.maxPriorityFeePerGas < minPriority
                            ? minPriority : feeData.maxPriorityFeePerGas;
                        deployOptions.maxFeePerGas = feeData.maxFeePerGas < minMaxFee
                            ? minMaxFee : feeData.maxFeePerGas;
                    } else {
                        const gasPrice = feeData.gasPrice || ethers.parseUnits('50', 'gwei');
                        const minGasPrice = ethers.parseUnits('30', 'gwei');
                        deployOptions.gasPrice = gasPrice < minGasPrice ? minGasPrice : gasPrice;
                    }
                }
            } catch (e) {
                console.warn('获取 gas 价格失败，回退到默认 gasPrice:', e.message);
                deployOptions.gasPrice = ethers.parseUnits(isLocalNet ? '20' : '50', 'gwei');
            }

            this.showDeployStatus('请在钱包中确认部署交易...', 'info');

            const contract = await factory.deploy(feeCollector, developer, deployOptions);

            this.setDeployStep(2, true);
            this.setDeployStep(3);
            this.showDeployStatus('交易已提交: ' + contract.deploymentTransaction().hash + '\n等待链上确认...', 'info');

            const receipt = await contract.waitForDeployment();

            this.setDeployStep(3, true);
            this.setDeployStep(4);
            const deployedAddress = await contract.getAddress();
            this.showDeployStatus(
                '✅ 部署成功!\n合约地址: ' + deployedAddress +
                '\n交易哈希: ' + contract.deploymentTransaction().hash,
                'success'
            );

            try {
                await this.apiRequest('/api/admin/contracts', 'POST', {
                    name: 'ChainRPS',
                    address: deployedAddress,
                    version: 'v1.0.0',
                    network: networkName,
                    abi: typeof artifacts.abi === 'string' ? artifacts.abi : JSON.stringify(artifacts.abi),
                    description: '通过管理面板部署',
                    deployed_by: this.adminAddress,
                    status: 'active'
                });
                if (CONFIG.setContractAddress) {
                    CONFIG.setContractAddress(deployedAddress);
                }
                this.loadContracts();
            } catch (e) {
                console.warn('自动添加合约记录失败:', e);
            }

            deployButton.textContent = '部署完成';
        } catch (e) {
            const zhError = this.translateDeployError(e);
            this.showDeployStatus('❌ 部署失败: ' + zhError, 'error');
            console.error('部署原始错误:', e);
            deployButton.disabled = false;
            deployButton.textContent = '重新部署';
        }
    },

    async viewContract(id) {
        try {
            const contract = await this.apiRequest(`/api/admin/contracts/${id}`);
            FWUI.Modal.create({
                title: '合约详情',
                content: `
                    <div style="padding: 12px 0;">
                        <div style="margin-bottom: 8px;"><strong>名称:</strong> ${contract.name}</div>
                        <div style="margin-bottom: 8px;"><strong>地址:</strong> <code style="font-size: 12px;">${contract.address}</code></div>
                        <div style="margin-bottom: 8px;"><strong>版本:</strong> ${contract.version}</div>
                        <div style="margin-bottom: 8px;"><strong>网络:</strong> ${contract.network}</div>
                    </div>
                `,
                width: '400px'
            });
        } catch (e) {
            FWUI.Toast.error('获取合约信息失败');
        }
    },

    showDeployTokenModal() {
        if (!this.signer) {
            FWUI.Toast.warning('请先连接钱包');
            return;
        }
        document.getElementById('deployTokenModal').classList.add('show');
    },

    async deployToken() {
        const name = document.getElementById('deployTokenName').value.trim();
        const symbol = document.getElementById('deployTokenSymbol').value.trim();
        const decimals = parseInt(document.getElementById('deployTokenDecimals').value);
        const supply = document.getElementById('deployTokenSupply').value.trim();

        if (!name || !symbol || !supply) {
            FWUI.Toast.warning('请填写完整信息');
            return;
        }
        if (!this.signer) {
            FWUI.Toast.warning('请先连接钱包');
            return;
        }

        const btn = document.getElementById('deployTokenButton');
        btn.disabled = true;
        btn.textContent = '部署中...';

        try {
            const artifacts = await this.apiRequest('/api/admin/contracts/mock-erc20-artifacts');
            if (!artifacts.bytecode) {
                throw new Error('未找到 MockERC20 编译产物');
            }

            const abi = typeof artifacts.abi === 'string' ? JSON.parse(artifacts.abi) : artifacts.abi;
            const factory = new ethers.ContractFactory(abi, artifacts.bytecode, this.signer);

            const supplyWei = ethers.parseUnits(supply, decimals);

            let deployOptions = {};
            try {
                const feeData = await this.provider.getFeeData();
                if (feeData.gasPrice) {
                    deployOptions.gasPrice = feeData.gasPrice;
                }
            } catch (e) {
                deployOptions.gasPrice = ethers.parseUnits('20', 'gwei');
            }
            deployOptions.gasLimit = 2000000n;

            const contract = await factory.deploy(name, symbol, decimals, supplyWei, deployOptions);
            FWUI.Toast.info('交易已提交，等待确认...');

            await contract.waitForDeployment();
            const tokenAddress = await contract.getAddress();

            const networkKey = CONFIG.getNetworkKey ? CONFIG.getNetworkKey() : 'localhost';
            if (CONFIG.networks && CONFIG.networks[networkKey]) {
                CONFIG.networks[networkKey].tokenAddresses[symbol] = tokenAddress;
                CONFIG.networks[networkKey].supportedTokens.unshift({
                    symbol: symbol,
                    name: name,
                    decimals: decimals,
                    address: tokenAddress
                });
            }

            FWUI.Toast.success(`✅ ${symbol} 部署成功! 地址: ${tokenAddress}`);
            document.getElementById('deployTokenModal').classList.remove('show');
        } catch (e) {
            console.error('部署代币失败:', e);
            FWUI.Toast.error('部署失败: ' + this.translateDeployError(e));
        } finally {
            btn.disabled = false;
            btn.textContent = '部署代币';
        }
    },

    showMintTokenModal() {
        if (!this.signer) {
            FWUI.Toast.warning('请先连接钱包');
            return;
        }
        if (this.adminAddress) {
            document.getElementById('mintToAddress').value = this.adminAddress;
        }
        document.getElementById('mintTokenModal').classList.add('show');
    },

    async mintToken() {
        const tokenAddress = document.getElementById('mintTokenAddress').value.trim();
        const toAddress = document.getElementById('mintToAddress').value.trim();
        const amount = document.getElementById('mintAmount').value.trim();

        if (!tokenAddress || !toAddress || !amount) {
            FWUI.Toast.warning('请填写完整信息');
            return;
        }
        if (!/^0x[a-fA-F0-9]{40}$/.test(tokenAddress) || !/^0x[a-fA-F0-9]{40}$/.test(toAddress)) {
            FWUI.Toast.warning('地址格式不正确');
            return;
        }
        if (!this.signer) {
            FWUI.Toast.warning('请先连接钱包');
            return;
        }

        try {
            const artifacts = await this.apiRequest('/api/admin/contracts/mock-erc20-artifacts');
            const abi = typeof artifacts.abi === 'string' ? JSON.parse(artifacts.abi) : artifacts.abi;

            const tokenContract = new ethers.Contract(tokenAddress, abi, this.signer);
            const decimals = await tokenContract.decimals();
            const amountWei = ethers.parseUnits(amount, decimals);

            const tx = await tokenContract.mint(toAddress, amountWei);
            FWUI.Toast.info('Mint 交易已提交，等待确认...');

            await tx.wait();
            FWUI.Toast.success(`✅ 成功 Mint ${amount} 个代币给 ${toAddress.slice(0, 8)}...`);
            document.getElementById('mintTokenModal').classList.remove('show');
        } catch (e) {
            console.error('Mint 失败:', e);
            FWUI.Toast.error('Mint 失败: ' + e.message);
        }
    },

    _chainExplorerContract: null,
    _chainGamesPage: 1,
    _chainGamesPerPage: 20,
    _chainGameCount: 0,
    _contractList: [],

    useActiveContract() {
        const addr = CONFIG.getContractAddress ? CONFIG.getContractAddress() : '';
        if (addr) {
            document.getElementById('explorerContractAddress').value = addr;
            this.queryContractOnChain();
        } else {
            FWUI.Toast.warning('当前未配置合约地址');
        }
    },

    async showContractDropdown() {
        const dropdown = document.getElementById('contractDropdown');
        const itemsContainer = document.getElementById('contractDropdownItems');
        
        // 检查元素是否存在
        if (!dropdown || !itemsContainer) {
            console.error('下拉菜单元素未找到');
            return;
        }
        
        // 如果合约列表为空，尝试重新加载
        if (this._contractList.length === 0) {
            try {
                const path = '/api/admin/contracts';
                const result = await this.apiRequest(path);
                if (result && Array.isArray(result)) {
                    this._contractList = result;
                }
            } catch (e) {
                console.error('加载合约列表失败:', e);
            }
        }
        
        // 渲染下拉菜单内容
        if (this._contractList.length === 0) {
            itemsContainer.innerHTML = '<div class="dropdown-item disabled">暂无合约记录</div>';
        } else {
            const html = this._contractList.map(c => {
                const addr = String(c.address || '');
                const name = String(c.name || 'Unknown');
                const network = String(c.network || '');
                const status = String(c.status || '');
                return `
                    <div class="dropdown-item" onclick="AdminApp.selectContract('${addr}', '${name}')">
                        <span style="font-weight: 500;">${name}</span>
                        <span style="font-family: monospace; font-size: 12px; color: var(--text-secondary); display: block;">
                            ${addr.slice(0, 10)}...${addr.slice(-8)}
                        </span>
                        <span style="font-size: 11px; color: var(--text-muted);">
                            ${network} | ${status}
                        </span>
                    </div>
                `;
            }).join('');
            itemsContainer.innerHTML = html;
        }
        
        // 显示下拉菜单
        dropdown.style.display = dropdown.style.display === 'block' ? 'none' : 'block';
    },

    selectContract(address, name) {
        document.getElementById('explorerContractAddress').value = address;
        document.getElementById('contractDropdown').style.display = 'none';
        FWUI.Toast.info(`已选择合约: ${name}`);
    },

    async _getExplorerContract() {
        const addr = document.getElementById('explorerContractAddress').value.trim();
        if (!addr || !/^0x[a-fA-F0-9]{40}$/.test(addr)) {
            FWUI.Toast.warning('请输入有效的合约地址');
            return null;
        }
        if (!this.provider) {
            FWUI.Toast.warning('请先连接钱包');
            return null;
        }
        try {
            const abi = await this.loadAbi();
            this._chainExplorerContract = new ethers.Contract(addr, abi, this.provider);
            return this._chainExplorerContract;
        } catch (e) {
            FWUI.Toast.error('加载合约失败: ' + e.message);
            return null;
        }
    },

    async queryContractOnChain() {
        const contract = await this._getExplorerContract();
        if (!contract) return;

        try {
            const [owner, feeCollector, officialDeveloper, gameCount, feeRate, paused] = await Promise.all([
                contract.owner().catch(() => '-'),
                contract.feeCollector().catch(() => '-'),
                contract.officialDeveloper().catch(() => '-'),
                contract.gameCount().catch(() => 0n),
                contract.feeRate().catch(() => 0n),
                contract.paused().catch(() => false),
            ]);

            document.getElementById('chainContractInfo').style.display = 'block';
            document.getElementById('chainGamesSection').style.display = 'block';

            document.getElementById('chainContractOwner').textContent = owner;
            document.getElementById('chainFeeCollector').textContent = feeCollector;
            document.getElementById('chainDeveloper').textContent = officialDeveloper;
            document.getElementById('chainGameCount').textContent = Number(gameCount).toLocaleString();
            document.getElementById('chainFeeRate').textContent = (Number(feeRate) / 100).toFixed(2) + '%';
            document.getElementById('chainPaused').textContent = paused ? '已暂停' : '运行中';
            document.getElementById('chainPaused').style.color = paused ? '#ef4444' : '#22c55e';

            this._chainGameCount = Number(gameCount);
            this._chainGamesPage = 1;
            this.loadChainGames();

            FWUI.Toast.success('合约信息加载成功');
        } catch (e) {
            console.error('查询合约失败:', e);
            FWUI.Toast.error('查询失败: ' + e.message);
        }
    },

    async loadChainGames() {
        let contract = this._chainExplorerContract;
        if (!contract) {
            contract = await this._getExplorerContract();
            if (!contract) return;
        }

        const tbody = document.getElementById('chainGamesTableBody');
        const total = this._chainGameCount;
        const perPage = this._chainGamesPerPage;
        const page = this._chainGamesPage;

        const startId = Math.max(1, total - (page - 1) * perPage);
        const endId = Math.max(0, total - page * perPage + 1);
        const count = startId - endId + 1;

        if (total === 0) {
            tbody.innerHTML = '<tr><td colspan="8" style="text-align:center; padding: 40px; color: var(--text-secondary);">暂无对局</td></tr>';
            document.getElementById('chainGamesPagination').textContent = '共 0 局';
            return;
        }

        tbody.innerHTML = '<tr><td colspan="8" style="text-align:center; padding: 40px; color: var(--text-secondary);">加载中...</td></tr>';

        const games = [];
        for (let id = startId; id >= endId; id--) {
            try {
                const g = await contract.games(id);
                games.push({ id, ...g });
            } catch (e) {
                continue;
            }
        }

        const statusMap = ['等待中', '提交阶段', '揭示阶段', '已结束', '已取消'];

        tbody.innerHTML = games.map(g => {
            const statusIdx = Number(g[4] || g.status || 0);
            const statusText = statusMap[statusIdx] || '未知';
            const tokenAddr = (g[3] || g.token || '').toString().toLowerCase();
            const tokenSymbol = tokenAddr === '0x0000000000000000000000000000000000000000' ? 'ETH' : 'ERC20';
            const decimals = tokenSymbol === 'ETH' ? 18 : 6;
            const amount = ethers.formatUnits(g[2] || g.amount || 0n, decimals);
            const winner = g[7] || g.winner || '';
            const isDraw = g[8] !== undefined ? g[8] : g.isDraw;

            return `
                <tr>
                    <td>#${g.id}</td>
                    <td style="font-size: 12px; font-family: monospace;">${(g[0] || g.player1 || '').slice(0, 10)}...</td>
                    <td style="font-size: 12px; font-family: monospace;">${(g[1] || g.player2 || '-').slice(0, 10)}...</td>
                    <td>${parseFloat(amount).toLocaleString()} ${tokenSymbol}</td>
                    <td>${tokenSymbol}</td>
                    <td>${statusText}</td>
                    <td style="font-size: 12px; font-family: monospace;">${isDraw ? '平局' : (winner ? winner.slice(0, 10) + '...' : '-')}</td>
                    <td><button class="btn btn-outline" style="padding: 2px 8px; font-size: 12px;" onclick="AdminApp.showGameDetail(${g.id})">详情</button></td>
                </tr>
            `;
        }).join('');

        document.getElementById('chainGamesPagination').textContent =
            `共 ${total} 局，当前第 ${page} 页 (ID: ${endId} ~ ${startId})`;

        document.getElementById('prevChainGamesBtn').disabled = page <= 1;
        document.getElementById('nextChainGamesBtn').disabled = startId <= 1 || total <= page * perPage;
    },

    prevChainGamesPage() {
        if (this._chainGamesPage > 1) {
            this._chainGamesPage--;
            this.loadChainGames();
        }
    },

    nextChainGamesPage() {
        const maxPage = Math.ceil(this._chainGameCount / this._chainGamesPerPage);
        if (this._chainGamesPage < maxPage) {
            this._chainGamesPage++;
            this.loadChainGames();
        }
    },

    queryGameById() {
        const id = document.getElementById('queryGameId').value.trim();
        if (!id || isNaN(id)) {
            FWUI.Toast.warning('请输入有效的游戏ID');
            return;
        }
        this.showGameDetail(parseInt(id));
    },

    async showGameDetail(gameId) {
        const contract = this._chainExplorerContract;
        if (!contract) {
            FWUI.Toast.warning('请先查询合约');
            return;
        }

        try {
            const game = await contract.games(gameId);
            const player1 = game[0] || game.player1 || '';
            const player2 = game[1] || game.player2 || '';
            const amountRaw = game[2] || game.amount || 0n;
            const tokenAddr = (game[3] || game.token || '').toString().toLowerCase();
            const status = Number(game[4] || game.status || 0);
            const commitDeadline = game[5] || game.commitDeadline || 0n;
            const revealDeadline = game[6] || game.revealDeadline || 0n;
            const winner = game[7] || game.winner || '';
            const isDraw = game[8] !== undefined ? game[8] : game.isDraw;

            const isETH = tokenAddr === '0x0000000000000000000000000000000000000000';
            const decimals = isETH ? 18 : 6;
            const tokenSymbol = isETH ? 'ETH' : 'ERC20';
            const amount = ethers.formatUnits(amountRaw, decimals);

            const statusMap = ['等待中', '提交阶段', '揭示阶段', '已结束', '已取消'];
            const statusText = statusMap[status] || '未知';

            let choice1 = '-', choice2 = '-';
            try {
                if (status >= 2) {
                    const c1 = await contract.commitments(player1, gameId);
                    const c2 = await contract.commitments(player2, gameId);
                    choice1 = c1 && c1.choice ? Number(c1.choice) : '已提交';
                    choice2 = c2 && c2.choice ? Number(c2.choice) : '已提交';
                }
            } catch (e) {}

            const detailHtml = `
                <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 12px;">
                    <div><strong>游戏ID:</strong> #${gameId}</div>
                    <div><strong>状态:</strong> ${statusText}</div>
                    <div><strong>玩家1:</strong> <code style="font-size: 12px;">${player1}</code></div>
                    <div><strong>玩家2:</strong> <code style="font-size: 12px;">${player2 || '-'}</code></div>
                    <div><strong>下注金额:</strong> ${parseFloat(amount).toLocaleString()} ${tokenSymbol}</div>
                    <div><strong>代币:</strong> ${tokenSymbol} <code style="font-size: 11px;">${tokenAddr.slice(0, 12)}...</code></div>
                    <div><strong>玩家1选择:</strong> ${choice1}</div>
                    <div><strong>玩家2选择:</strong> ${choice2}</div>
                    <div><strong>赢家:</strong> ${isDraw ? '平局' : (winner ? '<code style="font-size: 12px;">' + winner + '</code>' : '-')}</div>
                    <div><strong>是否平局:</strong> ${isDraw ? '是' : '否'}</div>
                    <div><strong>提交截止:</strong> ${commitDeadline ? new Date(Number(commitDeadline) * 1000).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false }) : '-'}</div>
                    <div><strong>揭示截止:</strong> ${revealDeadline ? new Date(Number(revealDeadline) * 1000).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false }) : '-'}</div>
                </div>
            `;

            document.getElementById('gameDetailContent').innerHTML = detailHtml;
            document.getElementById('gameDetailCard').style.display = 'block';
            document.getElementById('gameDetailCard').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
        } catch (e) {
            console.error('查询游戏详情失败:', e);
            FWUI.Toast.error('查询失败: ' + e.message);
        }
    },

    // ==================== 本地节点管理 ====================

    _localTokens: [],

    async refreshNodeStatus() {
        try {
            const status = await this.apiRequest('/api/admin/local-chain/status');
            this._renderNodeStatus(status);
            if (status.running) {
                this.refreshAccounts();
                this.refreshTokenList();
            }
        } catch (e) {
            document.getElementById('nodeStatusText').textContent = '未运行';
            document.getElementById('nodeStatusText').style.color = '#ef4444';
        }
    },

    _renderNodeStatus(status) {
        const statusEl = document.getElementById('nodeStatusText');
        if (status.running) {
            statusEl.textContent = '运行中';
            statusEl.style.color = '#22c55e';
        } else {
            statusEl.textContent = '未运行';
            statusEl.style.color = '#ef4444';
        }
        document.getElementById('nodeRpcUrl').textContent = status.rpc_url || '-';
        document.getElementById('nodeChainId').textContent = status.chain_id || '-';
        document.getElementById('nodeBlockNumber').textContent = status.block_number != null ? status.block_number.toLocaleString() : '-';
        document.getElementById('nodeGasPrice').textContent = status.gas_price != null ? status.gas_price + ' Gwei' : '-';
        document.getElementById('nodeAccountsCount').textContent = status.accounts_count != null ? status.accounts_count : '-';
        
        // 更新按钮状态
        const startBtn = document.getElementById('startNodeBtn');
        const stopBtn = document.getElementById('stopNodeBtn');
        if (startBtn) startBtn.disabled = status.running;
        if (stopBtn) stopBtn.disabled = !status.running;
    },

    async switchToLocalNetwork() {
        if (!window.ethereum) {
            FWUI.Toast.warning('未检测到 MetaMask，请先安装钱包插件');
            return;
        }

        // 读取当前配置面板的值
        const port = (document.getElementById('nodeConfigPort')?.value || '8545').trim();
        const chainId = (document.getElementById('nodeConfigChainId')?.value || '1337').trim();
        const symbol = (document.getElementById('nodeConfigSymbol')?.value || 'ETH').trim();
        const host = (document.getElementById('nodeConfigHost')?.value || '127.0.0.1').trim();

        const hexChainId = '0x' + parseInt(chainId).toString(16);
        const rpcUrl = `http://${host}:${port}`;

        try {
            FWUI.Toast.info(`正在切换到本地网络 (ChainID: ${chainId})...`);
            // 先尝试切换，如果网络不存在则添加
            try {
                await window.ethereum.request({
                    method: 'wallet_switchEthereumChain',
                    params: [{ chainId: hexChainId }],
                });
                FWUI.Toast.success('已切换到本地网络');
            } catch (switchError) {
                // 4902 = 链未添加，需要先添加
                if (switchError.code === 4902) {
                    await window.ethereum.request({
                        method: 'wallet_addEthereumChain',
                        params: [{
                            chainId: hexChainId,
                            chainName: `Localhost ${port}`,
                            nativeCurrency: { name: symbol, symbol: symbol, decimals: 18 },
                            rpcUrls: [rpcUrl],
                            blockExplorerUrls: null,
                        }],
                    });
                    FWUI.Toast.success('已添加并切换到本地网络');
                } else {
                    throw switchError;
                }
            }
            // 刷新钱包连接
            if (this.provider) {
                const network = await this.provider.getNetwork();
                this.adminChainId = Number(network.chainId);
            }
        } catch (e) {
            FWUI.Toast.error('切换网络失败: ' + (e.message || e));
        }
    },

    async startLocalNode() {
        try {
            // 读取启动配置（留空使用后端默认值）
            const getVal = (id) => {
                const el = document.getElementById(id);
                return el && el.value.trim() !== '' ? el.value.trim() : null;
            };
            const port = getVal('nodeConfigPort');
            const chainId = getVal('nodeConfigChainId');
            const accounts = getVal('nodeConfigAccounts');
            const balance = getVal('nodeConfigBalance');
            const symbol = getVal('nodeConfigSymbol');
            const host = getVal('nodeConfigHost');
            const deterministicEl = document.getElementById('nodeConfigDeterministic');
            const deterministic = deterministicEl ? deterministicEl.checked : true;

            const payload = {};
            if (host) payload.host = host;
            if (port) payload.port = parseInt(port);
            if (chainId) payload.chain_id = parseInt(chainId);
            if (accounts) payload.accounts_count = parseInt(accounts);
            if (balance) payload.default_balance = parseFloat(balance);
            if (symbol) payload.symbol = symbol;
            payload.deterministic = deterministic;

            FWUI.Toast.info('正在启动节点...');
            const result = await this.apiRequest('/api/admin/local-chain/start', 'POST', payload);
            FWUI.Toast.success(result.message || '节点启动成功');
            this.refreshNodeStatus();
        } catch (e) {
            FWUI.Toast.error('启动失败: ' + e.message);
        }
    },

    async stopLocalNode() {
        FWUI.Modal.confirm({
            title: '确认停止节点',
            content: '确定要停止本地节点吗？',
            onOk: async () => {
                try {
                    const result = await this.apiRequest('/api/admin/local-chain/stop', 'POST', {});
                    FWUI.Toast.success(result.message || '节点已停止');
                    this.refreshNodeStatus();
                } catch (e) {
                    FWUI.Toast.error('停止失败: ' + e.message);
                }
            }
        });
    },

    async refreshAccounts() {
        try {
            const data = await this.apiRequest('/api/admin/local-chain/accounts');
            const accounts = data.accounts || [];
            const tbody = document.getElementById('nodeAccountsBody');
            const fundSelect = document.getElementById('fundFromAccount');

            // 更新账户表格
            if (accounts.length === 0) {
                tbody.innerHTML = '<tr><td colspan="4" style="text-align:center; padding: 30px; color: var(--text-secondary);">无账户</td></tr>';
                fundSelect.innerHTML = '<option value="">-- 请选择账户 --</option>';
                return;
            }

            tbody.innerHTML = accounts.map(acc => `
                <tr>
                    <td>${acc.index}</td>
                    <td style="font-size: 12px; font-family: monospace;">${acc.address}</td>
                    <td>${parseFloat(acc.balance_eth).toFixed(4)} ETH</td>
                    <td>
                        <button class="btn btn-outline" style="padding: 2px 8px; font-size: 12px;" onclick="AdminApp.copyAddress('${acc.address}')">复制</button>
                    </td>
                </tr>
            `).join('');

            // 更新充值账户选择下拉框
            fundSelect.innerHTML = accounts.map(acc => `
                <option value="${acc.index}">账户 ${acc.index} (${parseFloat(acc.balance_eth).toFixed(2)} ETH)</option>
            `).join('');
        } catch (e) {
            console.warn('加载账户失败:', e);
        }
    },

    copyAddress(addr) {
        navigator.clipboard.writeText(addr).then(() => {
            FWUI.Toast.success('地址已复制');
        });
    },

    async fundAddress() {
        const fromIndex = parseInt(document.getElementById('fundFromAccount').value);
        const toAddress = document.getElementById('fundToAddress').value.trim();
        const amount = parseFloat(document.getElementById('fundAmount').value);

        if (isNaN(fromIndex)) {
            FWUI.Toast.warning('请选择来源账户');
            return;
        }
        if (!toAddress || !/^0x[a-fA-F0-9]{40}$/.test(toAddress)) {
            FWUI.Toast.warning('请输入有效的接收地址');
            return;
        }
        if (!amount || amount <= 0) {
            FWUI.Toast.warning('请输入有效的数量');
            return;
        }

        try {
            FWUI.Toast.info('正在转账...');
            const result = await this.apiRequest('/api/admin/local-chain/send-eth', 'POST', {
                to_address: toAddress,
                amount: amount,
                from_index: fromIndex,
            });
            const newBal = result.new_balance_eth ? `，当前余额: ${result.new_balance_eth} ETH` : '';
            const txHash = result.tx_hash ? ` (区块 #${result.block_number || '?'})` : '';
            FWUI.Toast.success(`成功发送 ${amount} ETH${newBal}${txHash}`);
            this.refreshAccounts();
            this.refreshNodeStatus();
        } catch (e) {
            FWUI.Toast.error('转账失败: ' + e.message);
        }
    },

    async refreshTokenList() {
        try {
            const data = await this.apiRequest('/api/admin/local-chain/tokens');
            this._localTokens = data.tokens || [];
            this._renderTokenList();
            this._renderTokenSelect();
        } catch (e) {
            console.warn('加载代币列表失败:', e);
        }
    },

    _renderTokenList() {
        const tbody = document.getElementById('nodeTokensBody');
        const tokens = this._localTokens;

        if (tokens.length === 0) {
            tbody.innerHTML = '<tr><td colspan="4" style="text-align:center; padding: 30px; color: var(--text-secondary);">暂无代币</td></tr>';
            return;
        }

        tbody.innerHTML = tokens.map(t => `
            <tr>
                <td><strong>${t.symbol}</strong> (${t.name})</td>
                <td style="font-size: 12px; font-family: monospace;">${t.address}</td>
                <td>${t.decimals}</td>
                <td>
                    <button class="btn btn-outline" style="padding: 2px 8px; font-size: 12px;" onclick="AdminApp.setMintToken('${t.symbol}')">Mint</button>
                </td>
            </tr>
        `).join('');
    },

    _renderTokenSelect() {
        const select = document.getElementById('mintTokenSelect');
        const tokens = this._localTokens;

        if (tokens.length === 0) {
            select.innerHTML = '<option value="">-- 请先部署代币 --</option>';
            return;
        }

        select.innerHTML = tokens.map(t =>
            `<option value="${t.symbol}">${t.symbol} (${t.name})</option>`
        ).join('');
    },

    setMintToken(symbol) {
        document.getElementById('mintTokenSelect').value = symbol;
    },

    showDeployLocalTokenModal() {
        document.getElementById('deployLocalTokenModal').classList.add('show');
    },

    async deployLocalToken() {
        const name = document.getElementById('deployLocalTokenName').value.trim();
        const symbol = document.getElementById('deployLocalTokenSymbol').value.trim();
        const decimals = parseInt(document.getElementById('deployLocalTokenDecimals').value);
        const supply = parseInt(document.getElementById('deployLocalTokenSupply').value);

        if (!name || !symbol) {
            FWUI.Toast.warning('请填写代币名称和符号');
            return;
        }

        const btn = document.getElementById('deployLocalTokenBtn');
        btn.disabled = true;
        btn.textContent = '部署中...';

        try {
            FWUI.Toast.info('正在部署代币...');
            const result = await this.apiRequest('/api/admin/local-chain/deploy-token', 'POST', {
                name,
                symbol,
                decimals,
                initial_supply: supply,
                from_index: 0,
            });
            FWUI.Toast.success(`${symbol} 部署成功!`);
            document.getElementById('deployLocalTokenModal').classList.remove('show');
            this.refreshTokenList();
        } catch (e) {
            FWUI.Toast.error('部署失败: ' + e.message);
        } finally {
            btn.disabled = false;
            btn.textContent = '部署';
        }
    },

    async mintLocalToken() {
        const symbol = document.getElementById('mintTokenSelect').value;
        const toAddress = document.getElementById('mintLocalToAddress').value.trim();
        const amount = parseFloat(document.getElementById('mintLocalAmount').value);

        if (!symbol) {
            FWUI.Toast.warning('请选择代币');
            return;
        }
        if (!toAddress || !/^0x[a-fA-F0-9]{40}$/.test(toAddress)) {
            FWUI.Toast.warning('请输入有效的接收地址');
            return;
        }
        if (!amount || amount <= 0) {
            FWUI.Toast.warning('请输入有效的数量');
            return;
        }

        try {
            FWUI.Toast.info('正在 Mint...');
            const result = await this.apiRequest('/api/admin/local-chain/mint-token', 'POST', {
                symbol,
                to_address: toAddress,
                amount,
                from_index: 0,
            });
            FWUI.Toast.success(result.message || `Mint 成功 ${amount} ${symbol}`);
        } catch (e) {
            FWUI.Toast.error('Mint 失败: ' + e.message);
        }
    },

    // ==================== Redis 管理 ====================

    async refreshRedisStatus() {
        try {
            const status = await this.apiRequest('/api/admin/redis/status');
            this._renderRedisStatus(status);
        } catch (e) {
            const el = document.getElementById('redisStatusText');
            if (el) {
                el.textContent = '未连接';
                el.style.color = '#ef4444';
            }
        }
    },

    _renderRedisStatus(status) {
        const statusEl = document.getElementById('redisStatusText');
        if (status.running) {
            statusEl.textContent = '运行中';
            statusEl.style.color = '#22c55e';
        } else {
            statusEl.textContent = '未连接';
            statusEl.style.color = '#ef4444';
        }

        document.getElementById('redisVersion').textContent = status.version || '-';
        const days = status.uptime_days || 0;
        const secs = status.uptime_seconds || 0;
        const hours = Math.floor(secs / 3600);
        document.getElementById('redisUptime').textContent = days > 0 ? `${days}天 ${hours}小时` : `${hours}小时`;
        document.getElementById('redisClients').textContent = status.connected_clients != null ? status.connected_clients : '-';
        document.getElementById('redisMemory').textContent = status.used_memory_human || '-';
        document.getElementById('redisTotalKeys').textContent = status.total_keys != null ? status.total_keys : '-';
        document.getElementById('redisCommands').textContent = status.total_commands_processed != null ? status.total_commands_processed.toLocaleString() : '-';
        document.getElementById('redisRole').textContent = status.role || '-';
        
        // 更新按钮状态
        const startBtn = document.getElementById('startRedisBtn');
        const stopBtn = document.getElementById('stopRedisBtn');
        if (startBtn) startBtn.disabled = status.running;
        if (stopBtn) stopBtn.disabled = !status.running;
    },

    async startRedis() {
        try {
            FWUI.Toast.info('正在启动 Redis...');
            const result = await this.apiRequest('/api/admin/redis/start', 'POST', {});
            FWUI.Toast.success(result.message || 'Redis 启动成功');
            this.refreshRedisStatus();
        } catch (e) {
            FWUI.Toast.error('启动失败: ' + e.message);
        }
    },

    async stopRedis() {
        FWUI.Modal.confirm({
            title: '确认停止 Redis',
            content: '确定要停止 Redis 吗？停止后将降级为内存模式。',
            onOk: async () => {
                try {
                    const result = await this.apiRequest('/api/admin/redis/stop', 'POST', {});
                    FWUI.Toast.success(result.message || 'Redis 已停止');
                    this.refreshRedisStatus();
                } catch (e) {
                    FWUI.Toast.error('停止失败: ' + e.message);
                }
            }
        });
    },

    async loadRedisConfig() {
        try {
            const data = await this.apiRequest('/api/admin/redis/config');
            const config = data.config || {};
            const tbody = document.getElementById('redisConfigBody');

            const friendlyNames = {
                'maxmemory': '最大内存',
                'maxmemory-policy': '内存淘汰策略',
                'timeout': '超时时间(秒)',
                'appendonly': 'AOF 持久化',
                'save': 'RDB 保存策略',
                'tcp-keepalive': 'TCP Keepalive',
                'databases': '数据库数量',
                'requirepass': '密码认证',
            };

            tbody.innerHTML = Object.entries(config).map(([k, v]) => `
                <tr>
                    <td><code>${k}</code> ${friendlyNames[k] ? '(' + friendlyNames[k] + ')' : ''}</td>
                    <td style="word-break: break-all;">${v || '<span style="color:var(--text-secondary)">空</span>'}</td>
                </tr>
            `).join('');

            document.getElementById('redisConfigSection').style.display = 'block';
            FWUI.Toast.success('配置已加载');
        } catch (e) {
            FWUI.Toast.error('获取配置失败: ' + e.message);
        }
    },

    async loadRedisKeys() {
        const pattern = document.getElementById('redisKeyPattern').value.trim() || '*';
        try {
            const data = await this.apiRequest(`/api/admin/redis/keys?pattern=${encodeURIComponent(pattern)}&limit=100`);
            const keys = data.keys || [];
            const tbody = document.getElementById('redisKeysBody');

            if (keys.length === 0) {
                tbody.innerHTML = '<tr><td colspan="5" style="text-align:center; padding: 30px; color: var(--text-secondary);">无匹配键</td></tr>';
            } else {
                tbody.innerHTML = keys.map(k => `
                    <tr>
                        <td style="font-size: 12px; font-family: monospace; word-break: break-all;">${k.key}</td>
                        <td>${k.type}</td>
                        <td>${k.ttl === -1 ? '永不过期' : k.ttl + '秒'}</td>
                        <td>${k.size}</td>
                        <td>
                            <button class="btn btn-danger" style="padding: 2px 8px; font-size: 12px;" onclick="AdminApp.deleteRedisKey('${k.key.replace(/'/g, "\\'")}')">删除</button>
                        </td>
                    </tr>
                `).join('');
            }

            document.getElementById('redisKeysSection').style.display = 'block';
            const msg = data.truncated ? `加载 ${data.count} 个键（已截断，请缩小范围）` : `共 ${data.count} 个键`;
            FWUI.Toast.info(msg);
        } catch (e) {
            FWUI.Toast.error('获取键列表失败: ' + e.message);
        }
    },

    async deleteRedisKey(key) {
        FWUI.Modal.confirm({
            title: '确认删除',
            content: `确定删除键 "${key}" 吗？`,
            onOk: async () => {
                try {
                    await this.apiRequest('/api/admin/redis/delete-key', 'POST', { key });
                    FWUI.Toast.success('已删除');
                    this.loadRedisKeys();
                    this.refreshRedisStatus();
                } catch (e) {
                    FWUI.Toast.error('删除失败: ' + e.message);
                }
            }
        });
    },

    async flushRedisDb() {
        FWUI.Modal.confirm({
            title: '⚠️ 危险操作',
            content: '确认清空当前 Redis 数据库？此操作不可恢复！',
            okType: 'danger',
            onOk: () => {
                FWUI.Modal.confirm({
                    title: '⚠️ 再次确认',
                    content: '将删除所有匹配队列、WebSocket 连接和对局缓存数据。确定继续？',
                    okType: 'danger',
                    onOk: async () => {
                        try {
                            const result = await this.apiRequest('/api/admin/redis/flush-db', 'POST', { confirm: true, db: 0 });
                            FWUI.Toast.success(result.message || '数据库已清空');
                            this.refreshRedisStatus();
                        } catch (e) {
                            FWUI.Toast.error('清空失败: ' + e.message);
                        }
                    }
                });
            }
        });
    },

    async loadConfig() {
        try {
            const category = document.getElementById('configCategory').value;
            const path = category ? `/api/admin/config?category=${category}` : '/api/admin/config';
            const configs = await this.apiRequest(path);
            const container = document.getElementById('configList');

            if (configs.length === 0) {
                container.innerHTML = '<div style="padding:40px; text-align:center; color:var(--text-secondary);">暂无配置项</div>';
                return;
            }

            container.innerHTML = configs.map(c => `
                <div class="config-item">
                    <div>
                        <div class="config-key">${c.config_key}</div>
                        <div class="config-desc">${c.description || '-'}</div>
                    </div>
                    <div class="config-value">
                        <input type="text" id="config-${c.config_key}" value="${c.config_value}" data-key="${c.config_key}">
                        <button class="btn btn-primary" style="padding:4px 12px; font-size:12px;" onclick="AdminApp.updateConfig('${c.config_key}')">保存</button>
                    </div>
                </div>
            `).join('');
        } catch (e) {
            console.error('Failed to load config:', e);
        }
    },

    async updateConfig(key) {
        const input = document.getElementById('config-' + key);
        const value = input.value;
        try {
            await this.apiRequest(`/api/admin/config/${key}`, 'PUT', { value, admin_address: this.adminAddress });
            FWUI.Toast.success('配置更新成功');
            this.loadAuditLogs();
        } catch (e) {
            FWUI.Toast.error('更新失败: ' + e.message);
        }
    },

    showBatchUpdateModal() {
        const inputModal = FWUI.Modal.create({
            title: '批量更新配置',
            content: `
                <div class="form-group" style="margin-bottom: 12px;">
                    <label style="display:block; font-size:13px; margin-bottom:6px; color:var(--text-secondary);">
                        JSON 格式配置
                    </label>
                    <textarea id="batchConfigInput" rows="4" style="
                        width: 100%;
                        padding: 10px 12px;
                        border: 1px solid var(--border-color);
                        border-radius: 8px;
                        background: var(--input-bg);
                        color: var(--text-primary);
                        font-family: monospace;
                        font-size: 13px;
                    " placeholder='{"key1":"val1","key2":"val2"}'></textarea>
                </div>
                <div style="font-size: 12px; color: var(--text-secondary);">
                    请输入 JSON 格式的批量配置，如: {"key1":"val1","key2":"val2"}
                </div>
            `,
            width: '480px',
            footer: `
                <button class="fwui-btn fwui-btn-default" style="
                    padding: 8px 20px;
                    border-radius: var(--radius-md, 10px);
                    font-size: 14px;
                    font-weight: 500;
                    cursor: pointer;
                    border: 1px solid var(--border-color, #e2e8f0);
                    background: var(--bg-card, #fff);
                    color: var(--text-primary, #0f172a);
                " onclick="document.querySelector('.fwui-modal-mask').remove();">取消</button>
                <button class="fwui-btn fwui-btn-primary" style="
                    padding: 8px 20px;
                    border-radius: var(--radius-md, 10px);
                    font-size: 14px;
                    font-weight: 500;
                    cursor: pointer;
                    border: none;
                    background: var(--primary-color, #6366f1);
                    color: #fff;
                " onclick="AdminApp.doBatchUpdate()">确认更新</button>
            `
        });
    },

    async doBatchUpdate() {
        const json = document.getElementById('batchConfigInput').value;
        if (!json) {
            FWUI.Toast.warning('请输入配置内容');
            return;
        }
        try {
            const items = JSON.parse(json);
            await this.apiRequest('/api/admin/config/batch', 'POST', { items, admin_address: this.adminAddress });
            document.querySelector('.fwui-modal-mask').remove();
            FWUI.Toast.success('批量更新成功');
            this.loadConfig();
            this.loadAuditLogs();
        } catch (e) {
            FWUI.Toast.error('JSON 格式错误: ' + e.message);
        }
    },

    async loadAuditLogs() {
        try {
            const action = document.getElementById('auditAction').value;
            const path = action ? `/api/admin/audit-logs?action=${action}` : '/api/admin/audit-logs';
            const data = await this.apiRequest(path);
            const tbody = document.getElementById('auditTableBody');

            if (data.logs.length === 0) {
                tbody.innerHTML = '<tr><td colspan="7" style="text-align:center; padding: 40px; color: var(--text-secondary);">暂无日志</td></tr>';
                return;
            }

            tbody.innerHTML = data.logs.map(log => `
                <tr>
                    <td>${log.id}</td>
                    <td style="font-family: monospace; font-size: 12px;">${log.admin_address ? log.admin_address.slice(0, 10) + '...' : '-'}</td>
                    <td>${log.action}</td>
                    <td>${log.target || '-'}</td>
                    <td style="max-width:150px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">${log.old_value || '-'}</td>
                    <td style="max-width:150px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">${log.new_value || '-'}</td>
                    <td>${log.created_at ? new Date(log.created_at).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false }) : '-'}</td>
                </tr>
            `).join('');
        } catch (e) {
            console.error('Failed to load audit logs:', e);
        }
    },

    loadChainConfig() {
        const addr = CONFIG.getContractAddress ? CONFIG.getContractAddress() : '';
        if (addr && this.isValidAddress(addr)) {
            this.loadContractInfo();
        }
    },

    isValidAddress(addr) {
        return typeof addr === 'string' && /^0x[a-fA-F0-9]{40}$/.test(addr);
    },

    async loadContractInfo() {
        if (!this.provider) return;
        const contractAddress = CONFIG.getContractAddress ? CONFIG.getContractAddress() : '';
        if (!this.isValidAddress(contractAddress)) {
            return;
        }
        try {
            const abi = await this.loadAbi();
            const contract = new ethers.Contract(contractAddress, abi, this.provider);

            // 安全调用合约方法：ABI 中不存在该方法时会同步抛出 TypeError，.catch 无法捕获
            const safeCall = async (fn, defaultVal) => {
                try {
                    if (typeof fn !== 'function') return defaultVal;
                    return await fn();
                } catch (e) {
                    return defaultVal;
                }
            };

            const [feeRate, commitTimeout, revealTimeout, website, twitter, discord, developer] = await Promise.all([
                safeCall(contract.feeRate, 0),
                safeCall(contract.commitTimeout, 0),
                safeCall(contract.revealTimeout, 0),
                safeCall(contract.officialWebsite, ''),
                safeCall(contract.officialTwitter, ''),
                safeCall(contract.officialDiscord, ''),
                safeCall(contract.officialDeveloper, '0x0000000000000000000000000000000000000000'),
            ]);

            document.getElementById('newFeeRate').placeholder = feeRate.toString() + ' (当前)';
            document.getElementById('newCommitTimeout').placeholder = commitTimeout.toString() + ' (当前)';
            document.getElementById('newRevealTimeout').placeholder = revealTimeout.toString() + ' (当前)';
            document.getElementById('officialWebsite').placeholder = website || 'https://chainrps.io';
            document.getElementById('officialTwitter').placeholder = twitter || '@ChainRPS';
            document.getElementById('officialDiscord').placeholder = discord || 'discord.gg/chainrps';
            if (developer && this.isValidAddress(developer)) {
                document.getElementById('newDeveloperAddress').placeholder = developer.slice(0, 10) + '...' + developer.slice(-6);
            }
        } catch (e) {
            console.error('Failed to load chain config:', e);
        }
    },

    async loadAbi() {
        const res = await fetch(CONFIG.backendUrl + '/api/admin/contracts');
        const contracts = await res.json();
        if (contracts.length > 0 && contracts[0].abi) {
            return JSON.parse(contracts[0].abi);
        }
        return [];
    },

    async connectAdminWallet() {
        if (!window.ethereum) {
            FWUI.Toast.warning('请安装 MetaMask 钱包');
            return;
        }
        try {
            const accounts = await window.ethereum.request({ method: 'eth_requestAccounts' });
            this.adminAddress = accounts[0];
            this.provider = new ethers.BrowserProvider(window.ethereum);
            this.signer = await this.provider.getSigner();

            document.getElementById('adminWallet').innerHTML = `
                <span style="font-family: monospace; font-size: 13px; color: var(--text-secondary);">
                    ${this.adminAddress.slice(0, 8)}...${this.adminAddress.slice(-6)}
                </span>
            `;
            document.getElementById('adminConnectInfo').style.display = 'flex';
            document.getElementById('adminAddress').textContent = this.adminAddress;

            FWUI.Toast.success('钱包连接成功');
            this.loadContractInfo();
        } catch (e) {
            FWUI.Toast.error('连接失败: ' + e.message);
        }
    },

    async disconnectAdminWallet() {
        // 真正与钱包断开：撤销 EIP-1193 权限
        if (window.ethereum && window.ethereum.request) {
            try {
                await window.ethereum.request({
                    method: 'wallet_revokePermissions',
                    params: [{ eth_accounts: {} }]
                });
            } catch (e) {
                console.warn('钱包不支持 wallet_revokePermissions，仅清理本地状态');
            }
        }

        this.adminAddress = null;
        this.provider = null;
        this.signer = null;
        document.getElementById('adminWallet').innerHTML = `
            <button class="btn btn-primary" onclick="AdminApp.connectAdminWallet()">连接管理员钱包</button>
        `;
        document.getElementById('adminConnectInfo').style.display = 'none';
    },

    async getContractWithSigner() {
        if (!this.signer) {
            FWUI.Toast.warning('请先连接钱包');
            return null;
        }
        const contractAddress = CONFIG.getContractAddress ? CONFIG.getContractAddress() : '';
        if (!this.isValidAddress(contractAddress)) {
            FWUI.Toast.warning('合约地址未配置，请先部署或添加合约');
            return null;
        }
        const abi = await this.loadAbi();
        return new ethers.Contract(contractAddress, abi, this.signer);
    },

    async setFeeRate() {
        const rate = document.getElementById('newFeeRate').value;
        if (!rate) { FWUI.Toast.warning('请输入新费率'); return; }
        try {
            const contract = await this.getContractWithSigner();
            if (!contract) return;
            const tx = await contract.setFeeRate(rate);
            await tx.wait();
            FWUI.Toast.success('手续费率设置成功！');
            this.loadDashboard();
            this.loadAuditLogs();
        } catch (e) {
            FWUI.Toast.error('设置失败: ' + e.message);
        }
    },

    async setTimeouts() {
        const commit = document.getElementById('newCommitTimeout').value;
        const reveal = document.getElementById('newRevealTimeout').value;
        if (!commit || !reveal) { FWUI.Toast.warning('请输入超时时间'); return; }
        try {
            const contract = await this.getContractWithSigner();
            if (!contract) return;
            const tx = await contract.setTimeouts(commit, reveal);
            await tx.wait();
            FWUI.Toast.success('超时时间设置成功！');
        } catch (e) {
            FWUI.Toast.error('设置失败: ' + e.message);
        }
    },

    async updateOfficialInfo() {
        const website = document.getElementById('officialWebsite').value;
        const twitter = document.getElementById('officialTwitter').value;
        const discord = document.getElementById('officialDiscord').value;
        try {
            const contract = await this.getContractWithSigner();
            if (!contract) return;
            const tx = await contract.updateOfficialInfo(website, twitter, discord);
            await tx.wait();
            FWUI.Toast.success('官方信息更新成功！');
        } catch (e) {
            FWUI.Toast.error('更新失败: ' + e.message);
        }
    },

    async setDeveloperAddress() {
        const addr = document.getElementById('newDeveloperAddress').value;
        if (!addr) { FWUI.Toast.warning('请输入新地址'); return; }
        try {
            const contract = await this.getContractWithSigner();
            if (!contract) return;
            const tx = await contract.setDeveloperAddress(addr);
            await tx.wait();
            FWUI.Toast.success('开发者地址设置成功！');
        } catch (e) {
            FWUI.Toast.error('设置失败: ' + e.message);
        }
    },

    async setTokenSupport() {
        const tokenAddr = document.getElementById('tokenAddress').value;
        const supported = document.getElementById('tokenSupported').value === 'true';
        if (!tokenAddr) { FWUI.Toast.warning('请输入代币地址'); return; }
        try {
            const contract = await this.getContractWithSigner();
            if (!contract) return;
            const tx = await contract.setTokenSupport(tokenAddr, supported);
            await tx.wait();
            FWUI.Toast.success('代币支持设置成功！');
        } catch (e) {
            FWUI.Toast.error('设置失败: ' + e.message);
        }
    },

    async pauseContract() {
        FWUI.Modal.confirm({
            title: '确认暂停合约',
            content: '确定要暂停合约吗？暂停后所有对局将无法进行。',
            okText: '确认暂停',
            okType: 'danger',
            onOk: async () => {
                try {
                    const contract = await this.getContractWithSigner();
                    if (!contract) return;
                    const tx = await contract.pause();
                    await tx.wait();
                    FWUI.Toast.success('合约已暂停');
                } catch (e) {
                    FWUI.Toast.error('暂停失败: ' + e.message);
                }
            }
        });
    },

    async unpauseContract() {
        try {
            const contract = await this.getContractWithSigner();
            if (!contract) return;
            const tx = await contract.unpause();
            await tx.wait();
            FWUI.Toast.success('合约已恢复');
        } catch (e) {
            FWUI.Toast.error('恢复失败: ' + e.message);
        }
    },

    async cancelMatch() {
        const gameId = document.getElementById('cancelGameId').value;
        if (!gameId) { FWUI.Toast.warning('请输入对局 ID'); return; }
        FWUI.Modal.confirm({
            title: '确认取消对局',
            content: '确定要取消该对局吗？双方资金将被退回。',
            okText: '确认取消',
            okType: 'danger',
            onOk: async () => {
                try {
                    const contract = await this.getContractWithSigner();
                    if (!contract) return;
                    const tx = await contract.cancelMatch(gameId);
                    await tx.wait();
                    FWUI.Toast.success('对局已取消');
                } catch (e) {
                    FWUI.Toast.error('取消失败: ' + e.message);
                }
            }
        });
    },
};

document.addEventListener('DOMContentLoaded', () => {
    AdminApp.init();
});