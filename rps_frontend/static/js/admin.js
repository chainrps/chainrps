// 管理后台应用模块
const AdminApp = {
    adminAddress: null,
    provider: null,
    signer: null,
    currentTab: 'dashboard',

    // tab 标识符与 hash 路由的映射
    _tabHashMap: {
        'dashboard': '#/dashboard',
        'contracts': '#/contracts',
        'localChain': '#/local-chain',
        'redis': '#/redis',
        'config': '#/config',
        'audit': '#/audit',
    },

    _currentConfigTab: 'backend',

    // 初始化管理后台
    init() {
        this.loadTheme();
        this._initSidebar();
        this._initHashRouter();
        this._initLocalChainDefaults();
        // 初始化忽略代码触发变更标志
        this._ignoreKeepAliveChange = false;
        // 优先检查登录状态，未登录则显示登录页，已登录才初始化后台
        this._checkAuthAndInit();
    },

    // ==================== 认证与登录 ====================

    // 获取认证令牌
    getToken() {
        return localStorage.getItem('adminToken') || '';
    },

    // 设置认证令牌
    setToken(token) {
        localStorage.setItem('adminToken', token);
    },

    // 清除认证令牌
    clearToken() {
        localStorage.removeItem('adminToken');
        localStorage.removeItem('adminUser');
    },

    // 显示登录遮罩
    _showLogin() {
        document.getElementById('loginOverlay').classList.remove('hidden');
        // 预填默认用户名方便开发
        if (!document.getElementById('loginUsername').value) {
            document.getElementById('loginUsername').value = 'admin';
        }
    },

    // 隐藏登录遮罩
    _hideLogin() {
        document.getElementById('loginOverlay').classList.add('hidden');
    },

    // 校验登录状态并初始化
    async _checkAuthAndInit() {
        const token = this.getToken();
        if (!token) {
            this._showLogin();
            return;
        }
        // 验证 token 是否有效
        try {
            const res = await fetch(CONFIG.backendUrl + '/api/auth/me', {
                headers: {'Authorization': 'Bearer ' + token}
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

    // 处理登录表单提交
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
                headers: {'Content-Type': 'application/json'},
                body: JSON.stringify({username, password})
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

    // 退出登录
    logout() {
        this.clearToken();
        this.adminUser = null;
        this._showLogin();
    },

    // ==================== 修改密码 ====================

    // 打开修改密码弹窗
    openChangePasswordModal() {
        document.getElementById('changePasswordModal').classList.add('show');
        document.getElementById('oldPassword').value = '';
        document.getElementById('newPassword').value = '';
        document.getElementById('confirmPassword').value = '';
        document.getElementById('changePwdError').textContent = '';
    },

    // 关闭修改密码弹窗
    closeChangePasswordModal() {
        document.getElementById('changePasswordModal').classList.remove('show');
    },

    // 修改密码按钮点击处理
    handleChangePasswordClick() {
        // 按钮点击触发，调用表单提交逻辑
        this.handleChangePassword({
            preventDefault: () => {
            }
        });
    },

    // 处理修改密码表单提交
    async handleChangePassword(event) {
        if (event && event.preventDefault) event.preventDefault();
        const oldPwd = document.getElementById('oldPassword').value;
        const newPwd = document.getElementById('newPassword').value;
        const confirmPwd = document.getElementById('confirmPassword').value;
        const errEl = document.getElementById('changePwdError');
        const btn = document.getElementById('changePwdBtn');
        errEl.textContent = '';

        if (!oldPwd || !newPwd || !confirmPwd) {
            errEl.textContent = '请填写所有字段';
            return false;
        }
        if (newPwd !== confirmPwd) {
            errEl.textContent = '两次输入的新密码不一致';
            return false;
        }
        if (newPwd.length < 1) {
            errEl.textContent = '新密码至少 1 位';
            return false;
        }

        btn.disabled = true;
        btn.textContent = '修改中...';
        try {
            const res = await fetch(CONFIG.backendUrl + '/api/auth/change-password', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': 'Bearer ' + this.getToken(),
                },
                body: JSON.stringify({old_password: oldPwd, new_password: newPwd})
            });
            const data = await res.json();
            if (res.ok && data.success) {
                FWUI.Toast.success('密码修改成功，请重新登录');
                this.closeChangePasswordModal();
                // 密码已改，旧 token 仍有效但建议重新登录
                setTimeout(() => this.logout(), 1500);
            } else {
                errEl.textContent = data.detail || data.message || '修改失败';
            }
        } catch (e) {
            errEl.textContent = '网络错误：' + e.message;
        } finally {
            btn.disabled = false;
            btn.textContent = '确认修改';
        }
        return false;
    },

    // 登录成功后初始化
    _initAfterAuth() {
        this.autoConnectWallet();
        // 根据初始 hash 决定加载哪个 tab，默认 dashboard
        const result = this._tabFromHash();
        if (result) {
            this.switchTab(result.tab, false, result.subTab);
        } else {
            this.switchTab('dashboard', false);
        }
    },

    // ==================== 侧边栏交互 ====================

    // 初始化侧边栏交互
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

    // 过滤侧边栏导航
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

    // 初始化 hash 路由
    _initHashRouter() {
        window.addEventListener('hashchange', () => {
            const result = this._tabFromHash();
            if (result && result.tab !== this.currentTab) {
                this.switchTab(result.tab, false, result.subTab);
            } else if (result && result.tab === 'config' && result.subTab) {
                this.switchConfigTab(result.subTab, false);
            }
        });
    },

    // 初始化本地链默认端口配置（统一从 CONFIG 读取）
    _initLocalChainDefaults() {
        const port = CONFIG.RPC_PORT;
        const host = CONFIG.RPC_HOST;
        const rpcUrl = 'http://' + host + ':' + port;

        // 设置端口输入框默认值和占位符
        const portEl = document.getElementById('nodeConfigPort');
        if (portEl) {
            portEl.value = String(port);
            portEl.placeholder = String(port);
        }

        // 设置 RPC URL 输入框占位符
        const rpcEl = document.getElementById('mainRpcUrl');
        if (rpcEl) {
            rpcEl.placeholder = rpcUrl;
        }

        // 更新网络下拉框中的 Localhost 选项文字
        document.querySelectorAll('option[value="localhost"]').forEach(el => {
            const isFilter = el.textContent.includes('全部网络') === false && el.closest('#networkFilter');
            const isContractModal = el.closest('#modalContractNetwork');
            const isDeploy = el.closest('#deployNetwork');
            if (isFilter) {
                el.textContent = 'Localhost ' + port;
            } else if (isContractModal || isDeploy) {
                el.textContent = 'ChainRPS Local (本地测试网)';
            }
        });
    },

    // 从 hash 获取 tab 标识
    _tabFromHash() {
        const hash = window.location.hash;
        // 1. 精确匹配主 tab
        const entry = Object.entries(this._tabHashMap).find(([_, h]) => h === hash);
        if (entry) return {tab: entry[0], subTab: null};
        // 2. 匹配 config 子路由: #/config, #/config/chain
        const configSubMap = {
            '#/config': 'backend',
            '#/config/chain': 'chain',
        };
        if (configSubMap[hash]) return {tab: 'config', subTab: configSubMap[hash]};
        // 2.1 兼容旧书签 #/config/node：本地链启动配置已迁移至 #/local-chain
        if (hash === '#/config/node') return {tab: 'localChain', subTab: null};
        return null;
    },

    // 更新 URL hash
    _updateHash(tabName) {
        const hash = this._tabHashMap[tabName];
        if (hash && window.location.hash !== hash) {
            // 使用 replaceState 避免产生多余历史记录
            history.replaceState(null, '', hash);
        }
    },

    // 自动连接管理员钱包
    async autoConnectWallet() {
        if (!window.ethereum) return;

        // 用户之前主动断开过，则不自动重连（与主页 Wallet 模块共用同一标记）
        if (localStorage.getItem('rps_wallet_disconnected') === '1') return;

        try {
            // 尝试获取已授权的账户列表
            const accounts = await window.ethereum.request({method: 'eth_accounts'});
            if (accounts.length > 0) {
                this.adminAddress = accounts[0];
                this.provider = new ethers.BrowserProvider(window.ethereum);
                this.signer = await this.provider.getSigner();

                // 更新 UI 显示已连接状态
                document.getElementById('adminWallet').innerHTML = `
                    <span style="font-family: monospace; font-size: 13px; color: #475569;">
                        ${this.adminAddress.slice(0, 8)}...${this.adminAddress.slice(-6)}
                    </span>
                `;
                document.getElementById('adminConnectInfo').style.display = 'flex';
                document.getElementById('adminAddress').textContent = this.adminAddress;
                document.getElementById('fundToAddress').textContent = this.adminAddress;

                // 自动填充本地链充值接收地址
                const fundToAddr = document.getElementById('fundToAddress');
                if (fundToAddr && (!fundToAddr.value || fundToAddr.value.startsWith('0x0000'))) {
                    fundToAddr.value = this.adminAddress;
                }

                this.loadContractInfo();
            }
        } catch (e) {
            // 用户未授权或钱包未连接，保持默认状态
            console.log('Auto-connect failed:', e.message);
        }
    },

    // 加载主题（与游戏 UI 共享同一个 localStorage key）
    loadTheme() {
        const theme = localStorage.getItem('rps_theme') || 'light';
        document.documentElement.setAttribute('data-theme', theme);
    },

    // 切换标签页
    switchTab(tabName, updateHash, subTab) {
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
        if (tabName === 'bot') this.botLoadAll();
        if (tabName === 'config') {
            if (subTab && (subTab === 'backend' || subTab === 'chain')) {
                this.switchConfigTab(subTab, false);
            } else {
                this.switchConfigTab('backend', false);
            }
            this.loadConfig();
        }
        if (tabName === 'audit') this.loadAuditLogs();
        if (tabName === 'localChain') {
            this._applyNodeConfigToForm();
            this._initKeepAliveToggle();
            this._initLocalChainFeatureSelector();
            this.refreshNodeStatus();
        }
        if (tabName === 'redis') this.refreshRedisStatus();
    },

    // 切换配置页的子 tab（后端配置 / 链上合约配置）
    switchConfigTab(tabName, updateHash) {
        if (typeof updateHash === 'undefined') updateHash = true;
        this._currentConfigTab = tabName;

        document.querySelectorAll('.config-tab-btn').forEach(btn => {
            btn.classList.toggle('active', btn.dataset.configTab === tabName);
            if (btn.dataset.configTab === tabName) {
                btn.style.color = 'var(--text-primary)';
                btn.style.borderBottomColor = 'var(--primary-color)';
            } else {
                btn.style.color = 'var(--text-secondary)';
                btn.style.borderBottomColor = 'transparent';
            }
        });

        const backendPanel = document.getElementById('configPanel-backend');
        const chainPanel = document.getElementById('configPanel-chain');
        if (backendPanel) backendPanel.style.display = tabName === 'backend' ? '' : 'none';
        if (chainPanel) chainPanel.style.display = tabName === 'chain' ? '' : 'none';

        if (updateHash) {
            const subHashMap = {backend: '#/config', chain: '#/config/chain'};
            const hash = subHashMap[tabName] || '#/config';
            if (window.location.hash !== hash) {
                history.replaceState(null, '', hash);
            }
        }
    },

    // 获取当前原生代币符号（统一从 CONFIG 读取，回退到 'POL'）
    _nativeSymbol() {
        return (typeof CONFIG !== 'undefined' && CONFIG.getNativeSymbol) ? CONFIG.getNativeSymbol() : 'POL';
    },

    // 发起带认证的 API 请求
    async apiRequest(path, method = 'GET', body = null) {
        const headers = {'Content-Type': 'application/json'};
        // 携带 JWT token 认证
        const token = this.getToken();
        if (token) {
            headers['Authorization'] = 'Bearer ' + token;
        }
        // 兼容：保留旧的钱包地址头（审计日志用）
        if (this.adminAddress) {
            headers['X-Admin-Address'] = this.adminAddress;
        }
        const res = await fetch(CONFIG.backendUrl + path, {
            method,
            headers,
            body: body ? JSON.stringify(body) : undefined
        });
        // 401 表示未登录或 token 过期，清除并跳转登录
        if (res.status === 401) {
            this.clearToken();
            this._showLogin();
            throw new Error('未登录或登录已过期，请重新登录');
        }
        if (!res.ok) {
            // 解析后端返回的 detail 字段，展示真实错误信息
            let detail = '';
            try {
                const errBody = await res.json();
                detail = errBody.detail || errBody.message || '';
            } catch (_) { /* 忽略解析失败 */
            }
            const err = new Error(detail || `API error: ${res.status}`);
            err.status = res.status;
            err.detail = detail;
            throw err;
        }
        return res.json();
    },

    // 加载仪表盘数据
    async loadDashboard() {
        try {
            const data = await this.apiRequest('/api/admin/dashboard');
            document.getElementById('statTotalGames').textContent = data.total_games;
            document.getElementById('statFinishedGames').textContent = data.finished_games;
            document.getElementById('statPlayers').textContent = data.active_players_approx;
            document.getElementById('statTotalFee').textContent = data.total_fee_collected.toFixed(2);
            document.getElementById('statContracts').textContent = data.total_contracts;

            // 获取系统健康状态（含合约监听、Bot 等）
            const health = await this.apiRequest('/api/admin/health');
            document.getElementById('redisStatus').textContent = health.redis ? '已连接' : '未连接';
            document.getElementById('redisStatus').className = 'tag ' + (health.redis ? 'tag-active' : 'tag-inactive');

            // 更新合约监听状态
            const contractStatusEl = document.getElementById('contractStatus');
            if (contractStatusEl) {
                if (health.contract_listening) {
                    contractStatusEl.textContent = '运行中';
                    contractStatusEl.className = 'tag tag-active';
                } else {
                    contractStatusEl.textContent = '未启动';
                    contractStatusEl.className = 'tag tag-inactive';
                }
            }

            // 更新服务状态（包含 Bot 状态）
            const serviceStatusEl = document.getElementById('serviceStatus');
            if (serviceStatusEl) {
                if (health.bot_running) {
                    serviceStatusEl.textContent = '运行中';
                    serviceStatusEl.className = 'tag tag-active';
                } else {
                    serviceStatusEl.textContent = '待机';
                    serviceStatusEl.className = 'tag tag-inactive';
                }
            }

            // 显示 Bot 配置 URL 信息
            this._botConfigInfo = {
                url: '/api/bot/config',
                status: health.bot_running ? '运行中' : '未启动',
                wallet: health.bot_wallet,
                chainMatches: health.bot_chain_matches || 0,
            };

            // 更新 Bot 状态卡片（如果存在）
            const botStatusEl = document.getElementById('botStatus');
            if (botStatusEl) {
                botStatusEl.textContent = health.bot_running ? '运行中' : '未启动';
                botStatusEl.className = 'tag ' + (health.bot_running ? 'tag-active' : 'tag-inactive');
            }

            const botWalletEl = document.getElementById('botWallet');
            if (botWalletEl) {
                botWalletEl.textContent = health.bot_wallet ? health.bot_wallet.slice(0, 10) + '...' : '-';
                botWalletEl.title = health.bot_wallet || '';
            }

            const botChainMatchesEl = document.getElementById('botChainMatches');
            if (botChainMatchesEl) {
                botChainMatchesEl.textContent = health.bot_chain_matches || 0;
            }
        } catch (e) {
            console.error('Failed to load dashboard:', e);
        }
    },

    // ==================== Bot 机器人管理 ====================

    // 加载所有 Bot 数据
    async botLoadAll() {
        await Promise.all([
            this.botRefreshStatus(),
            this.botLoadConfig(),
            this.botLoadClusterStatus(),
            this.botLoadInstances(),
            this.botLoadStrategies(),
        ]);
    },

    // 刷新 Bot 状态
    async botRefreshStatus() {
        try {
            const status = await this.apiRequest('/api/bot/status');
            const statusEl = document.getElementById('botConfigStatus');
            const walletEl = document.getElementById('botConfigWallet');
            const matchesEl = document.getElementById('botConfigChainMatches');
            const uptimeEl = document.getElementById('botConfigUptime');

            if (statusEl) {
                statusEl.textContent = status.is_running ? '运行中' : '未启动';
                statusEl.style.color = status.is_running ? 'var(--success-color, #10b981)' : 'var(--text-tertiary)';
            }
            if (walletEl && status.wallet_address) {
                walletEl.textContent = status.wallet_address.slice(0, 10) + '...' + status.wallet_address.slice(-8);
                walletEl.title = status.wallet_address;
            }
            if (matchesEl) {
                matchesEl.textContent = status.total_chain_matches || 0;
            }
            if (uptimeEl) {
                uptimeEl.textContent = status.started_at ? new Date(status.started_at).toLocaleString('zh-CN') : '-';
            }

            // 更新按钮状态
            const startBtn = document.getElementById('botStartBtn');
            const stopBtn = document.getElementById('botStopBtn');
            if (startBtn && stopBtn) {
                startBtn.disabled = status.is_running;
                stopBtn.disabled = !status.is_running;
                startBtn.style.opacity = status.is_running ? '0.5' : '1';
                stopBtn.style.opacity = status.is_running ? '1' : '0.5';
            }
        } catch (e) {
            console.error('Failed to load bot status:', e);
        }
    },

    // 启动 Bot
    async botStart() {
        try {
            FWUI.Modal.confirm({
                title: '启动 Bot',
                content: '<p>确定要启动 Bot 机器人吗？启动后 Bot 将自动匹配游戏和下注。</p>',
                okText: '启动',
                onOk: async () => {
                    try {
                        const result = await this.apiRequest('/api/bot/start', 'POST');
                        if (result.success) {
                            FWUI.Toast.success('Bot 已启动');
                            await this.botRefreshStatus();
                        } else {
                            FWUI.Toast.error(result.message || '启动失败');
                        }
                    } catch (e) {
                        FWUI.Toast.error('启动失败: ' + e.message);
                    }
                }
            });
        } catch (e) {
            console.error('Failed to start bot:', e);
        }
    },

    // 停止 Bot
    async botStop() {
        try {
            FWUI.Modal.confirm({
                title: '停止 Bot',
                content: '<p>确定要停止 Bot 机器人吗？</p>',
                okText: '停止',
                okType: 'danger',
                onOk: async () => {
                    try {
                        const result = await this.apiRequest('/api/bot/stop', 'POST');
                        if (result.success) {
                            FWUI.Toast.success('Bot 已停止');
                            await this.botRefreshStatus();
                        } else {
                            FWUI.Toast.error(result.message || '停止失败');
                        }
                    } catch (e) {
                        FWUI.Toast.error('停止失败: ' + e.message);
                    }
                }
            });
        } catch (e) {
            console.error('Failed to stop bot:', e);
        }
    },

    // 重置 Bot 钱包
    async botResetWallet() {
        try {
            FWUI.Modal.confirm({
                title: '重置 Bot 钱包',
                content: '<p>⚠️ 确定要重置 Bot 钱包吗？此操作将生成新的钱包地址，旧钱包中的资金需要手动转移。</p>',
                okText: '重置',
                okType: 'danger',
                onOk: async () => {
                    try {
                        const result = await this.apiRequest('/api/bot/reset-wallet', 'POST');
                        if (result.success) {
                            FWUI.Toast.success('钱包已重置');
                            await this.botRefreshStatus();
                        } else {
                            FWUI.Toast.error(result.message || '重置失败');
                        }
                    } catch (e) {
                        FWUI.Toast.error('重置失败: ' + e.message);
                    }
                }
            });
        } catch (e) {
            console.error('Failed to reset bot wallet:', e);
        }
    },

    // 加载 Bot 配置到表单
    async botLoadConfig() {
        try {
            const config = await this.apiRequest('/api/bot/config');
            if (!config) return;

            // 填充表单 - 使用后端返回的字段名
            const el = (id) => document.getElementById('botConfig' + id);
            if (el('MinBet')) el('MinBet').value = config.bet_amount || '';
            if (el('MaxBet')) el('MaxBet').value = config.bet_amount || ''; // 使用相同的下注金额
            if (el('MatchInterval')) el('MatchInterval').value = config.create_interval || '';
            if (el('MaxGames')) el('MaxGames').value = config.max_concurrent_rooms || '';
            if (el('GasLimit')) el('GasLimit').value = config.commit_delay || '';
            if (el('GasPrice')) el('GasPrice').value = config.reveal_delay || '';
            if (el('AutoMatch')) el('AutoMatch').checked = config.auto_create_room || false;
            if (el('AutoBet')) el('AutoBet').checked = config.auto_join_room || false;
            if (el('AutoReveal')) el('AutoReveal').checked = config.auto_chain_match || false;
            if (el('Headless')) el('Headless').checked = config.mimic_choice ? true : false;
        } catch (e) {
            console.error('Failed to load bot config:', e);
        }
    },

    // 保存 Bot 配置
    async botSaveConfig() {
        try {
            const updateData = {
                bet_amount: parseFloat(document.getElementById('botConfigMinBet')?.value) || 1.0,
                create_interval: parseInt(document.getElementById('botConfigMatchInterval')?.value) || 5,
                max_concurrent_rooms: parseInt(document.getElementById('botConfigMaxGames')?.value) || 5,
                commit_delay: parseInt(document.getElementById('botConfigGasLimit')?.value) || 6,
                reveal_delay: parseInt(document.getElementById('botConfigGasPrice')?.value) || 1,
                auto_create_room: document.getElementById('botConfigAutoMatch')?.checked || false,
                auto_join_room: document.getElementById('botConfigAutoBet')?.checked || false,
                auto_chain_match: document.getElementById('botConfigAutoReveal')?.checked || false,
                mimic_choice: document.getElementById('botConfigHeadless')?.checked ? 1 : 0,
            };

            const result = await this.apiRequest('/api/bot/config', {
                method: 'PUT',
                body: JSON.stringify(updateData)
            });

            if (result.success) {
                FWUI.Toast.success('Bot 配置已保存');
            } else {
                FWUI.Toast.error(result.message || '保存失败');
            }
        } catch (e) {
            console.error('Failed to save bot config:', e);
            FWUI.Toast.error('保存失败: ' + e.message);
        }
    },

    // 加载 Bot 集群状态
    async botLoadClusterStatus() {
        try {
            const status = await this.apiRequest('/api/bot/cluster/status');
            const container = document.getElementById('botClusterStatus');
            if (container) {
                container.innerHTML = `
                    <div style="display:flex;gap:20px;flex-wrap:wrap;">
                        <div style="text-align:center;">
                            <div style="font-size:24px;font-weight:600;color:var(--primary-color);">${status.total_instances || 0}</div>
                            <div style="color:var(--text-tertiary);font-size:12px;">总实例数</div>
                        </div>
                        <div style="text-align:center;">
                            <div style="font-size:24px;font-weight:600;color:var(--success-color, #10b981);">${status.running_instances || 0}</div>
                            <div style="color:var(--text-tertiary);font-size:12px;">运行中</div>
                        </div>
                        <div style="text-align:center;">
                            <div style="font-size:24px;font-weight:600;color:var(--warning-color, #f59e0b);">${status.total_games || 0}</div>
                            <div style="color:var(--text-tertiary);font-size:12px;">总游戏数</div>
                        </div>
                        <div style="text-align:center;">
                            <div style="font-size:24px;font-weight:600;">${status.win_rate || 0}%</div>
                            <div style="color:var(--text-tertiary);font-size:12px;">胜率</div>
                        </div>
                    </div>
                `;
            }
        } catch (e) {
            console.error('Failed to load cluster status:', e);
        }
    },

    // 加载 Bot 实例列表
    async botLoadInstances() {
        try {
            const instances = await this.apiRequest('/api/bot/cluster/instances');
            const tbody = document.getElementById('botInstancesTbody');
            if (!tbody) return;

            if (!instances || instances.length === 0) {
                tbody.innerHTML = '<tr><td colspan="5" style="text-align:center;padding:20px;color:var(--text-secondary);">暂无实例</td></tr>';
                return;
            }

            tbody.innerHTML = instances.map(inst => `
                <tr style="border-bottom:1px solid var(--border-color);">
                    <td style="padding:8px;font-family:monospace;font-size:12px;">${inst.bot_id || inst.id}</td>
                    <td style="padding:8px;">
                        <span class="tag ${inst.is_running || inst.running ? 'tag-active' : 'tag-inactive'}">${inst.is_running || inst.running ? '运行中' : '已停止'}</span>
                    </td>
                    <td style="padding:8px;font-family:monospace;font-size:11px;">${inst.wallet_address || inst.wallet ? (inst.wallet_address || inst.wallet).slice(0, 8) + '...' : '-'}</td>
                    <td style="padding:8px;">${inst.total_games || inst.games_count || 0}</td>
                    <td style="padding:8px;text-align:center;">
                        <button class="btn btn-outline" style="padding:2px 6px;font-size:11px;margin:2px;" 
                                onclick="AdminApp.botInstanceAction('${inst.bot_id || inst.id}', '${inst.is_running || inst.running ? 'stop' : 'start'}')">
                            ${inst.is_running || inst.running ? '⏹️ 停止' : '▶️ 启动'}
                        </button>
                        <button class="btn btn-outline" style="padding:2px 6px;font-size:11px;margin:2px;" 
                                onclick="AdminApp.botInstanceAction('${inst.bot_id || inst.id}', 'restart')">
                            🔄 重启
                        </button>
                        <button class="btn btn-danger" style="padding:2px 6px;font-size:11px;margin:2px;" 
                                onclick="AdminApp.botInstanceAction('${inst.bot_id || inst.id}', 'delete')">
                            🗑️ 删除
                        </button>
                    </td>
                </tr>
            `).join('');
        } catch (e) {
            console.error('Failed to load bot instances:', e);
        }
    },

    // Bot 实例操作
    async botInstanceAction(instanceId, action) {
        try {
            const actionMap = {
                start: { url: `/api/bot/cluster/instances/${instanceId}/start`, method: 'POST', msg: '启动' },
                stop: { url: `/api/bot/cluster/instances/${instanceId}/stop`, method: 'POST', msg: '停止' },
                restart: { url: `/api/bot/cluster/instances/${instanceId}/restart`, method: 'POST', msg: '重启' },
                delete: { url: `/api/bot/cluster/instances/${instanceId}`, method: 'DELETE', msg: '删除' },
            };
            const config = actionMap[action];
            if (!config) return;

            FWUI.Modal.confirm({
                title: `${config.msg}实例`,
                content: `<p>确定要${config.msg} Bot 实例 <code>${instanceId}</code> 吗？</p>`,
                okText: config.msg,
                onOk: async () => {
                    const result = await this.apiRequest(config.url, config.method);
                    if (result.success) {
                        FWUI.Toast.success(`${config.msg}成功`);
                        await this.botLoadInstances();
                        await this.botLoadClusterStatus();
                    } else {
                        FWUI.Toast.error(result.message || `${config.msg}失败`);
                    }
                }
            });
        } catch (e) {
            console.error('Failed to execute bot instance action:', e);
        }
    },

    // 创建 Bot 实例
    async botCreateInstance() {
        try {
            FWUI.Modal.create({
                title: '创建 Bot 实例',
                width: '400px',
                content: `
                    <div class="form-group" style="margin-bottom:12px;">
                        <label>策略ID</label>
                        <input type="text" id="newBotStrategyId" placeholder="输入策略ID">
                    </div>
                `,
                footer: `
                    <button class="fwui-btn fwui-btn-default" data-action="cancel">取消</button>
                    <button class="fwui-btn fwui-btn-primary" data-action="create">创建</button>
                `
            });

            setTimeout(() => {
                const cancelBtn = document.querySelector('[data-action="cancel"]');
                const createBtn = document.querySelector('[data-action="create"]');
                const modal = document.querySelector('.fwui-modal');
                
                if (cancelBtn) cancelBtn.addEventListener('click', () => modal?.remove());
                if (createBtn) {
                    createBtn.addEventListener('click', async () => {
                        const strategyId = document.getElementById('newBotStrategyId')?.value;
                        if (!strategyId) {
                            FWUI.Toast.warning('请输入策略ID');
                            return;
                        }
                        try {
                            const result = await this.apiRequest('/api/bot/cluster/instances', {
                                method: 'POST',
                                body: JSON.stringify({ strategy_id: strategyId })
                            });
                            if (result.success) {
                                FWUI.Toast.success('实例创建成功');
                                modal?.remove();
                                await this.botLoadInstances();
                                await this.botLoadClusterStatus();
                            } else {
                                FWUI.Toast.error(result.message || '创建失败');
                            }
                        } catch (e) {
                            FWUI.Toast.error('创建失败: ' + e.message);
                        }
                    });
                }
            }, 100);
        } catch (e) {
            console.error('Failed to create bot instance:', e);
        }
    },

    // 批量操作
    async botStartAll() {
        await this._botBatchAction('start-all', '启动所有实例');
    },

    async botStopAll() {
        await this._botBatchAction('stop-all', '停止所有实例');
    },

    async botRestartAll() {
        await this._botBatchAction('restart-all', '重启所有实例');
    },

    async _botBatchAction(action, label) {
        try {
            FWUI.Modal.confirm({
                title: label,
                content: `<p>确定要${label}吗？</p>`,
                okText: '确定',
                onOk: async () => {
                    const result = await this.apiRequest(`/api/bot/cluster/${action}`, 'POST');
                    if (result.success) {
                        FWUI.Toast.success(`${label}成功`);
                        await this.botLoadInstances();
                        await this.botLoadClusterStatus();
                    } else {
                        FWUI.Toast.error(result.message || `${label}失败`);
                    }
                }
            });
        } catch (e) {
            console.error('Failed to execute batch action:', e);
        }
    },

    // 加载 Bot 策略列表
    async botLoadStrategies() {
        try {
            const strategies = await this.apiRequest('/api/bot/cluster/strategies');
            const container = document.getElementById('botStrategiesList');
            if (!container) return;

            if (!strategies || strategies.length === 0) {
                container.innerHTML = '<div style="text-align:center;color:var(--text-secondary);padding:20px;">暂无策略</div>';
                return;
            }

            container.innerHTML = strategies.map(s => `
                <div style="padding:10px;border:1px solid var(--border-color);border-radius:8px;margin-bottom:8px;">
                    <div style="display:flex;justify-content:space-between;">
                        <span style="font-weight:500;">${s.name || s.id}</span>
                        <span class="tag tag-active">${s.type || 'default'}</span>
                    </div>
                    <div style="color:var(--text-tertiary);font-size:12px;margin-top:4px;">${s.description || '无描述'}</div>
                </div>
            `).join('');
        } catch (e) {
            console.error('Failed to load bot strategies:', e);
        }
    },

    // 清空 Bot 日志
    botClearLogs() {
        const container = document.getElementById('botLogsContainer');
        if (container) {
            container.innerHTML = '<div style="color:var(--text-tertiary);">暂无日志</div>';
        }
        FWUI.Toast.success('日志已清空');
    },

    // 加载合约列表
    async loadContracts() {
        try {
            const network = document.getElementById('networkFilter').value;
            const path = network ? `/api/admin/contracts?network=${network}` : '/api/admin/contracts';
            const contracts = await this.apiRequest(path);

            // 保存合约列表供下拉菜单使用
            this._contractList = contracts;

            const tbody = document.getElementById('contractsTableBody');

            if (contracts.length === 0) {
                tbody.innerHTML = '<tr><td colspan="8" style="text-align:center; padding: 40px; color: #475569;">暂无合约记录</td></tr>';
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
                    <td>${c.deployed_at ? new Date(c.deployed_at).toLocaleString('zh-CN', {
                timeZone: 'Asia/Shanghai',
                year: 'numeric',
                month: '2-digit',
                day: '2-digit',
                hour: '2-digit',
                minute: '2-digit',
                second: '2-digit',
                hour12: false
            }) : '-'}</td>
                    <td>
                        <button class="btn btn-secondary" style="padding:4px 8px; font-size:12px;" onclick="AdminApp.viewContract(${c.id})">查看</button>
                    </td>
                </tr>
            `).join('');
        } catch (e) {
            console.error('Failed to load contracts:', e);
        }
    },

    // 显示添加合约弹窗
    showAddContractModal() {
        document.getElementById('contractModal').classList.add('show');
    },

    // 关闭合约弹窗
    closeContractModal() {
        document.getElementById('contractModal').classList.remove('show');
    },

    // 添加合约记录
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

    // 显示部署合约弹窗
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

    // 关闭部署合约弹窗
    closeDeployModal() {
        document.getElementById('deployModal').classList.remove('show');
    },

    // 设置部署步骤状态
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

    // 截断过长的字符串
    truncateLongString(str, maxLength = 200) {
        if (!str || typeof str !== 'string') return str;
        if (str.length <= maxLength) return str;
        const prefixLen = Math.floor(maxLength * 0.3);
        const suffixLen = Math.floor(maxLength * 0.3);
        return str.slice(0, prefixLen) + '...[省略' + (str.length - prefixLen - suffixLen) + '个字符]...' + str.slice(-suffixLen);
    },

    // 根据 Chain ID 获取网络名称
    getNetworkNameByChainId(chainId) {
        const knownNetworks = {
            1: 'Ethereum Mainnet',
            137: 'Polygon Mainnet',
            80002: 'Polygon Amoy',
            5208888: 'ChainRPS Local',
            56: 'BNB Chain',
            42161: 'Arbitrum One',
            10: 'Optimism',
            8453: 'Base',
            43114: 'Avalanche',
            100: 'Gnosis',
            250: 'Fantom',
            42161: 'Arbitrum One',
            169: 'Pulsechain',
        };
        return knownNetworks[chainId] || `Chain #${chainId}`;
    },

    // 显示部署状态消息
    showDeployStatus(message, type = 'info') {
        const el = document.getElementById('deployStatus');
        el.style.display = 'block';
        el.className = 'deploy-status ' + type;

        // 对于错误类型，截断过长的消息（保留更多内容用于调试）
        if (type === 'error') {
            message = this.truncateLongString(message, 2500);
        }

        el.textContent = message;
    },

    // 将 ethers.js / RPC 错误翻译为中文提示，并附带完整的原始错误信息
    translateDeployError(error) {
        const msg = (error && error.message) ? error.message : String(error);
        const lower = msg.toLowerCase();

        // ===== 1. 递归提取 ethers.js v6 嵌套错误结构中的所有关键字段 =====
        // ethers v6 错误结构通常为：error.error.info.error.data / error.error.data / error.reason
        // 递归提取完整错误信息
        const extractFullErrorInfo = (err) => {
            const found = [];
            const seen = new Set();
            const walk = (node, depth) => {
                if (!node || typeof node !== 'object' || depth > 6) return;
                if (seen.has(node)) return;
                seen.add(node);
                const entry = {};
                if (node.code !== undefined) entry.code = node.code;
                if (node.message && typeof node.message === 'string') entry.message = node.message.slice(0, 300);
                if (node.data && typeof node.data === 'string') entry.data = node.data.slice(0, 200);
                if (node.method) entry.method = node.method;
                if (node.transaction && typeof node.transaction === 'object') entry.transactionHash = node.transaction.hash || '';
                if (node.reason) entry.reason = node.reason;
                if (Object.keys(entry).length > 0) found.push(entry);
                // 向下钻取所有可能的嵌套错误字段
                walk(node.error, depth + 1);
                if (node.info) walk(node.info, depth + 1);
                if (node.info && node.info.error) walk(node.info.error, depth + 1);
                walk(node.reason, depth + 1);
                walk(node.action, depth + 1);
            };
            walk(err, 0);
            return found;
        };

        // ===== 2. 尝试解码 0x 开头的 revert data 为可读字符串 =====
        // Solidity revert reason 通常为: 0x08c379a0... + ABI 编码的字符串
        // 或自定义错误的 4-byte selector + data
        // 解码 revert 数据
        const decodeRevertData = (hex) => {
            if (!hex || typeof hex !== 'string' || !hex.startsWith('0x')) return null;
            // 纯 0x 空数据
            if (hex === '0x') return '空(0x)';
            // 提取字符串片段（尝试将 hex 转 UTF-8）
            try {
                const cleanHex = hex.slice(2);
                if (cleanHex.length >= 8) {
                    // 标准 Error(string) selector: 0x08c379a0
                    if (cleanHex.startsWith('08c379a0') && cleanHex.length >= 136) {
                        // ABI 解码: 跳过 selector(4B)+offset(32B)+length(32B)，读取字符串
                        const strHex = cleanHex.slice(136); // 8+64+64 chars
                        const bytes = [];
                        for (let i = 0; i + 2 <= strHex.length; i += 2) {
                            const b = parseInt(strHex.substr(i, 2), 16);
                            if (b !== 0) bytes.push(b);
                        }
                        const decoded = new TextDecoder('utf-8').decode(new Uint8Array(bytes));
                        if (decoded) return 'revert: "' + decoded + '"';
                    }
                    // Panic(uint256) selector: 0x4e487b71
                    if (cleanHex.startsWith('4e487b71') && cleanHex.length >= 72) {
                        const codeHex = cleanHex.slice(8, 72).replace(/^0+/, '');
                        const panicCode = parseInt(codeHex || '0', 16);
                        const panicMap = {
                            0x01: 'assert(false)',
                            0x11: '算术溢出',
                            0x12: '除以零',
                            0x21: 'enum 越界',
                            0x22: '存储编码错误',
                            0x31: 'pop 空数组',
                            0x32: '数组越界',
                            0x41: '分配过多内存',
                            0x51: '未初始化内部函数',
                        };
                        return 'panic(0x' + panicCode.toString(16) + '): ' + (panicMap[panicCode] || '未知');
                    }
                }
                // 尝试直接解码为 UTF-8（可能是自定义错误数据）
                const bytes = [];
                for (let i = 0; i + 2 <= cleanHex.length; i += 2) {
                    bytes.push(parseInt(cleanHex.substr(i, 2), 16));
                }
                // 只保留可打印 ASCII 字符
                const printable = bytes.filter(b => b >= 32 && b <= 126);
                if (printable.length >= 4 && printable.length >= bytes.length * 0.5) {
                    const str = String.fromCharCode(...printable);
                    if (str.length >= 4) return '可读片段: "' + str.slice(0, 100) + '"';
                }
            } catch (e) { /* ignore */
            }
            return null;
        };

        // ===== 3. 收集所有错误详情 =====
        const allErrorInfo = extractFullErrorInfo(error);

        // 查找所有 data 字段并尝试解码
        const decodedReverts = [];
        const allDataFields = [];
        // 收集所有 data 字段
        const collectData = (node, depth) => {
            if (!node || typeof node !== 'object' || depth > 6) return;
            if (node.data && typeof node.data === 'string' && node.data.startsWith('0x')) {
                allDataFields.push(node.data);
                const decoded = decodeRevertData(node.data);
                if (decoded) decodedReverts.push(decoded);
            }
            collectData(node.error, depth + 1);
            if (node.info) collectData(node.info, depth + 1);
            if (node.info && node.info.error) collectData(node.info.error, depth + 1);
        };
        collectData(error, 0);

        // 从错误消息中提取 0x 数据
        const msgHexMatch = msg.match(/0x[0-9a-fA-F]{8,}/);
        if (msgHexMatch) {
            allDataFields.push(msgHexMatch[0]);
            const decoded = decodeRevertData(msgHexMatch[0]);
            if (decoded && !decodedReverts.includes(decoded)) decodedReverts.push(decoded);
        }

        // 提取所有 code 值
        const allCodes = [];
        allErrorInfo.forEach(e => {
            if (e.code !== undefined && !allCodes.includes(e.code)) allCodes.push(e.code);
        });
        const msgCodeMatch = msg.match(/code[=:]\s*(-?\d+)/i);
        if (msgCodeMatch) allCodes.push(Number(msgCodeMatch[1]));

        // ===== 4. 构建详细的错误详情块 =====
        const detailLines = [];
        if (allCodes.length > 0) detailLines.push('RPC错误码: ' + allCodes.join(', '));
        if (allDataFields.length > 0) detailLines.push('Revert数据: ' + [...new Set(allDataFields)].slice(0, 3).join(' | '));
        if (decodedReverts.length > 0) detailLines.push('解码结果: ' + [...new Set(decodedReverts)].join(' | '));
        // 添加最深层错误消息
        const deepMsgs = allErrorInfo.map(e => e.message).filter(Boolean);
        if (deepMsgs.length > 0) {
            const uniqueMsgs = [...new Set(deepMsgs)].slice(0, 2);
            detailLines.push('链端消息: ' + uniqueMsgs.join(' | '));
        }
        // 添加 method
        const methods = allErrorInfo.map(e => e.method).filter(Boolean);
        if (methods.length > 0) detailLines.push('RPC方法: ' + [...new Set(methods)].join(', '));

        // 构建完整错误对象 JSON（用于调试，截断到合理长度）
        // 构建完整错误对象的 JSON
        const fullJson = (() => {
            try {
                const seen = new Set();
                // 安全序列化错误对象
                const safeObj = (node, depth) => {
                    if (!node || typeof node !== 'object' || depth > 4) return null;
                    if (seen.has(node)) return '[Circular]';
                    seen.add(node);
                    const result = {};
                    ['code', 'message', 'data', 'method', 'reason', 'shortMessage'].forEach(k => {
                        if (node[k] !== undefined) {
                            result[k] = typeof node[k] === 'string' ? node[k].slice(0, 150) : node[k];
                        }
                    });
                    if (node.error) result.error = safeObj(node.error, depth + 1);
                    if (node.info) result.info = safeObj(node.info, depth + 1);
                    return result;
                };
                const obj = safeObj(error, 0);
                if (obj) return JSON.stringify(obj, null, 1).slice(0, 600);
            } catch (e) { /* ignore */
            }
            return '';
        })();

        const detailBlock = detailLines.length > 0
            ? '\n\n📋 错误详情:\n  ' + detailLines.join('\n  ')
            : '';
        const jsonBlock = fullJson
            ? '\n\n🔧 完整错误对象(JSON):\n' + fullJson
            : '';

        // ===== 5. 按优先级匹配常见错误模式 =====
        const patterns = [
            {test: /user rejected|action_rejected|user denied/, zh: '您在钱包中拒绝了签名请求'},
            {test: /insufficient funds|gas required exceeds allowance/, zh: '账户余额不足，无法支付部署所需的 Gas 费用'},
            {
                test: /eth_maxpriorityfeepergas.*does not exist|method.*eth_maxpriorityfeepergas/,
                zh: '本地链不支持 EIP-1559 方法 eth_maxPriorityFeePerGas（Ganache 旧版本常见），已自动回退到 legacy gasPrice 模式，请重试'
            },
            {
                test: /invalid chain id.*for chain with id/,
                zh: 'Chain ID 不匹配：MetaMask 网络配置的 Chain ID 与本地节点不一致。请点击本地链页面的"🔗 切换到本地网络"按钮自动配置'
            },
            {
                test: /could not coalesce error/,
                zh: '本地链(Ganache)返回了非标准错误响应（ethers.js v6 无法解析）。最常见原因：1) Gas Limit 不足导致 out-of-gas 2) MetaMask 与节点的 Chain ID 不一致 3) 合约构造函数 revert 4) Ganache 版本与 ethers.js v6 兼容性问题。建议：提高 Gas Limit、检查 Chain ID、查看下方 Revert 数据'
            },
            {
                test: /execution reverted/,
                zh: '合约执行被回退(revert)，通常是构造函数参数校验失败或前置条件不满足。请查看下方解码结果中的 revert 原因'
            },
            {test: /nonce too low/, zh: 'Nonce 过低，请重置钱包账户的 Nonce（MetaMask → 设置 → 高级 → 清除活动数据）'},
            {test: /nonce too high/, zh: 'Nonce 过高，请等待之前的交易打包后再试'},
            {test: /gas price too low|underpriced/, zh: 'Gas 价格太低，被节点拒绝'},
            {test: /intrinsic gas too low|gas limit/, zh: 'Gas Limit 太低，无法完成合约部署'},
            {
                test: /network changed/i, zh: (() => {
                    // 尝试提取 chain ID 信息
                    const match = msg.match(/network changed:\s*(\d+)\s*=>\s*(\d+)/i) || msg.match(/network changed.*?(\d+).*?(\d+)/i);
                    if (match) {
                        const fromChain = match[1];
                        const toChain = match[2];
                        const fromName = this.getNetworkNameByChainId(parseInt(fromChain));
                        const toName = this.getNetworkNameByChainId(parseInt(toChain));
                        return `⚠️ 网络切换失败\n当前钱包网络: ${fromName} (Chain ID: ${fromChain})\n期望的网络: ${toName} (Chain ID: ${toChain})\n\n请确认钱包已切换到正确网络后重试`;
                    }
                    return '网络已切换或 Chain ID 不匹配，请确认钱包连接的是正确网络';
                })()
            },
            {test: /already known/, zh: '相同的交易已存在，请勿重复提交'},
            {test: /replacement transaction underpriced/, zh: '替换交易的价格太低'},
            {
                test: /contract factory.*not defined|bytecode.*not/,
                zh: '未找到合约编译产物(Bytecode)，请检查后端编译是否成功'
            },
            {test: /timeout|timed out/, zh: '请求超时，请检查节点是否正常运行'},
            {
                test: /connect.*failed|econnrefused|fetch failed/,
                zh: '无法连接到 RPC 节点，请确认本地链(' + CONFIG.RPC_PORT + ')已启动'
            },
        ];

        for (const p of patterns) {
            if (p.test.test(lower)) {
                return p.zh + detailBlock + jsonBlock;
            }
        }

        // 未知错误：返回原始信息 + 错误详情
        let result = '部署失败（未知错误类型）\n原始信息: ' + this.truncateLongString(msg, 300);
        return result + detailBlock + jsonBlock;
    },

    // 部署合约
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

        // 超时保护：90 秒内未完成则自动释放按钮
        let deployTimeout = setTimeout(() => {
            if (deployButton.disabled) {
                deployButton.disabled = false;
                deployButton.textContent = '重新部署';
                this.showDeployStatus('⏱ 部署超时（90秒），已自动释放。请检查钱包是否卡住或重试。', 'error');
            }
        }, 90000);

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

            const gasLimit = 8000000n;
            const ethersNetwork = await this.provider.getNetwork();
            const chainId = Number(ethersNetwork.chainId);
            const deployOptions = {gasLimit};

            // 本地链判断：5208888 (ChainRPS Local) 或 31337 (Ganache/Hardhat 默认)
            const isLocalNet = chainId === 5208888 || chainId === 31337;

            // 本地链(Ganache)兼容性处理：
            // Ganache 旧版本不支持 eth_maxPriorityFeePerGas，调用 getFeeData() 会报错
            // 因此本地链直接跳过 getFeeData，使用固定 gasPrice
            if (isLocalNet) {
                // Ganache 不支持 EIP-1559，直接使用固定 legacy gasPrice
                // 不调用 getFeeData() 避免触发 eth_maxPriorityFeePerGas 错误
                deployOptions.gasPrice = ethers.parseUnits('20', 'gwei');
                this.showDeployStatus('本地链模式: 使用固定 gasPrice (20 gwei)，跳过 EIP-1559 查询...', 'info');
            } else {
                try {
                    const feeData = await this.provider.getFeeData();
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
                } catch (e) {
                    console.warn('获取 gas 价格失败，回退到默认 gasPrice:', e.message);
                    deployOptions.gasPrice = ethers.parseUnits('50', 'gwei');
                }
            }

            // 部署前检查 Chain ID 是否与 MetaMask 一致
            try {
                const mmChainId = await window.ethereum.request({method: 'eth_chainId'});
                const mmChainIdDec = parseInt(mmChainId, 16);
                if (mmChainIdDec !== chainId) {
                    throw new Error(`Chain ID 不匹配：MetaMask 网络 Chain ID 为 ${mmChainIdDec}，但 RPC 节点返回 ${chainId}。请点击本地链页面的"🔗 切换到本地网络"按钮自动配置`);
                }
            } catch (cidError) {
                if (cidError.message && cidError.message.includes('Chain ID 不匹配')) {
                    throw cidError;
                }
                // 读取失败不阻塞，继续部署
                console.warn('无法读取 MetaMask Chain ID:', cidError.message);
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
            clearTimeout(deployTimeout);
        } catch (e) {
            clearTimeout(deployTimeout);
            const zhError = this.translateDeployError(e);
            this.showDeployStatus('❌ 部署失败: ' + zhError, 'error');
            console.error('部署原始错误:', e);
            deployButton.disabled = false;
            deployButton.textContent = '重新部署';
            // 检测是否为用户主动拒绝
            const msg = (e.message || '').toLowerCase();
            if (msg.includes('user rejected') || msg.includes('user denied') || msg.includes('4001')) {
                this.setDeployStep(2, false);
                this.showDeployStatus('✋ 您在钱包中取消了签名，请重新点击"部署"并在钱包中确认。', 'warning');
            }
        }
    },

    // 查看合约详情
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

    // 显示部署代币弹窗
    showDeployTokenModal() {
        if (!this.signer) {
            FWUI.Toast.warning('请先连接钱包');
            return;
        }
        document.getElementById('deployTokenModal').classList.add('show');
    },

    // 部署代币
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

    // ==================== 本地节点管理 ====================

    _localTokens: [],

    _NODE_CONFIG_KEY: 'rps_local_chain_config',

    // 保存节点配置到本地存储
    _saveNodeConfig(config) {
        try {
            localStorage.setItem(this._NODE_CONFIG_KEY, JSON.stringify(config));
        } catch (e) {
            console.warn('保存节点配置失败:', e);
        }
    },

    // 从表单读取配置并保存到本地存储
    _saveNodeConfigFromForm() {
        const config = {};
        const chain_type = document.getElementById('nodeConfigChainType')?.value;
        const host = document.getElementById('nodeConfigHost')?.value?.trim();
        const port = document.getElementById('nodeConfigPort')?.value?.trim();
        const chain_id = document.getElementById('nodeConfigChainId')?.value?.trim();
        const accounts_count = document.getElementById('nodeConfigAccounts')?.value?.trim();
        const default_balance = document.getElementById('nodeConfigBalance')?.value?.trim();
        const symbol = document.getElementById('nodeConfigSymbol')?.value?.trim();
        const deterministic = document.getElementById('nodeConfigDeterministic')?.checked;
        const persist = document.getElementById('nodeConfigPersist')?.checked;

        if (chain_type != null) config.chain_type = chain_type;
        if (host != null) config.host = host;
        if (port != null) config.port = port;
        if (chain_id != null) config.chain_id = chain_id;
        if (accounts_count != null) config.accounts_count = accounts_count;
        if (default_balance != null) config.default_balance = default_balance;
        if (symbol != null) config.symbol = symbol;
        if (deterministic != null) config.deterministic = deterministic;
        if (persist != null) config.persist = persist;

        this._saveNodeConfig(config);
    },

    // 从本地存储加载节点配置
    _loadNodeConfig() {
        try {
            const raw = localStorage.getItem(this._NODE_CONFIG_KEY);
            if (raw) return JSON.parse(raw);
        } catch (e) {
            console.warn('加载节点配置失败:', e);
        }
        return null;
    },

    // 应用节点配置到表单
    _applyNodeConfigToForm() {
        const cfg = this._loadNodeConfig();
        if (!cfg) return;
        if (cfg.chain_type != null) {
            const el = document.getElementById('nodeConfigChainType');
            if (el) el.value = cfg.chain_type;
        }
        if (cfg.host != null) {
            const el = document.getElementById('nodeConfigHost');
            if (el) el.value = cfg.host;
        }
        if (cfg.port != null) {
            const el = document.getElementById('nodeConfigPort');
            if (el) el.value = cfg.port;
        }
        if (cfg.chain_id != null) {
            const el = document.getElementById('nodeConfigChainId');
            if (el) el.value = cfg.chain_id;
        }
        if (cfg.accounts_count != null) {
            const el = document.getElementById('nodeConfigAccounts');
            if (el) el.value = cfg.accounts_count;
        }
        if (cfg.default_balance != null) {
            const el = document.getElementById('nodeConfigBalance');
            if (el) el.value = cfg.default_balance;
        }
        if (cfg.symbol != null) {
            const el = document.getElementById('nodeConfigSymbol');
            if (el) el.value = cfg.symbol;
        }
        if (cfg.deterministic != null) {
            const el = document.getElementById('nodeConfigDeterministic');
            if (el) el.checked = !!cfg.deterministic;
        }
        if (cfg.persist != null) {
            const el = document.getElementById('nodeConfigPersist');
            if (el) el.checked = !!cfg.persist;
        }
    },

    // 刷新本地节点状态
    async refreshNodeStatus() {
        try {
            const status = await this.apiRequest('/api/admin/local-chain/status');
            this._renderNodeStatus(status);
            // 自动填充充值接收地址为当前连接钱包地址
            if (this.adminAddress) {
                const fundToAddr = document.getElementById('fundToAddress');
                if (fundToAddr && (!fundToAddr.value || fundToAddr.value.startsWith('0x0000'))) {
                    fundToAddr.value = this.adminAddress;
                }
            }
            // 仅在节点运行状态变化时刷新账户和代币列表，避免高频轮询
            if (status.running && this._lastNodeRunning !== true) {
                this.refreshAccounts();
                this.refreshTokenList();
            }
            // 加载代币信息（地址、RPC等）
            this.loadTokenInfo();
            this._lastNodeRunning = status.running;
        } catch (e) {
            document.getElementById('nodeStatusText').textContent = '未运行';
            document.getElementById('nodeStatusText').style.color = '#ef4444';
            const dotEl = document.getElementById('nodeStatusDot');
            if (dotEl) {
                dotEl.classList.remove('lc-dot-running');
                dotEl.classList.add('lc-dot-stopped');
            }
            // 失败时也更新保活开关的 sub 文字
            const sub = document.getElementById('nodeKeepAliveSub');
            const title = document.getElementById('nodeKeepAliveTitle');
            const checkbox = document.getElementById('nodeKeepAliveToggle');
            if (checkbox && checkbox.checked) {
                if (title) title.textContent = '停止节点';
                if (sub) sub.textContent = '连接中...';
            } else {
                if (title) title.textContent = '开启节点';
                if (sub) sub.textContent = '节点已停止';
            }
            this._lastNodeRunning = false;
        }
    },

    // 启动/停止本地链状态自动刷新
    _startNodeStatusAutoRefresh(enabled) {
        if (this._nodeStatusTimer) {
            clearInterval(this._nodeStatusTimer);
            this._nodeStatusTimer = null;
        }
        if (enabled) {
            this._nodeStatusTimer = setInterval(() => {
                if (this.currentTab === 'localChain') {
                    this.refreshNodeStatus();
                }
            }, 15000);
        }
    },

    // 立即更新保活开关的 UI 文字（乐观更新）
    _updateKeepAliveUI(enabled, running) {
        const title = document.getElementById('nodeKeepAliveTitle');
        const sub = document.getElementById('nodeKeepAliveSub');
        const checkbox = document.getElementById('nodeKeepAliveToggle');
        const toggle = checkbox ? checkbox.closest('.node-keepalive-toggle') : null;
        if (enabled) {
            if (title) title.textContent = '停止节点';
            if (running) {
                if (sub) sub.textContent = '运行中';
                if (toggle) {
                    toggle.classList.remove('keep-alive-error');
                    toggle.classList.add('keep-alive-active');
                }
            } else {
                if (sub) sub.textContent = '正在启动...';
                if (toggle) {
                    toggle.classList.remove('keep-alive-active');
                    toggle.classList.add('keep-alive-error');
                }
            }
        } else {
            if (title) title.textContent = '开启节点';
            if (sub) sub.textContent = running ? '运行中 · 未保活' : '节点已停止';
            if (toggle) {
                toggle.classList.remove('keep-alive-active', 'keep-alive-error');
            }
        }
    },

    // 渲染节点状态
    _renderNodeStatus(status) {
        const statusEl = document.getElementById('nodeStatusText');
        const dotEl = document.getElementById('nodeStatusDot');
        if (status.running) {
            statusEl.textContent = '运行中';
            statusEl.style.color = '#22c55e';
            if (dotEl) {
                dotEl.classList.remove('lc-dot-stopped');
                dotEl.classList.add('lc-dot-running');
            }
        } else {
            statusEl.textContent = '未运行';
            statusEl.style.color = '#ef4444';
            if (dotEl) {
                dotEl.classList.remove('lc-dot-running');
                dotEl.classList.add('lc-dot-stopped');
            }
        }

        // 链引擎显示（ganache / hardhat / unknown）
        const chainType = (status.chain_type || '').toLowerCase();
        const engineLabel = chainType === 'ganache' ? 'Ganache'
            : chainType === 'hardhat' ? 'Hardhat'
                : (status.chain_type || '未知');
        const engineEl = document.getElementById('nodeEngine');
        if (engineEl) engineEl.textContent = engineLabel;
        const engineBadge = document.getElementById('nodeEngineBadge');
        if (engineBadge) {
            engineBadge.textContent = engineLabel;
            engineBadge.classList.toggle('engine-unknown', !chainType);
        }

        document.getElementById('nodeRpcUrl').textContent = status.rpc_url || '-';
        document.getElementById('nodeChainId').textContent = status.chain_id || '-';
        document.getElementById('nodeBlockNumber').textContent = status.block_number != null ? status.block_number.toLocaleString() : '-';
        document.getElementById('nodeGasPrice').textContent = status.gas_price != null ? status.gas_price + ' Gwei' : '-';
        document.getElementById('nodeAccountsCount').textContent = status.accounts_count != null ? status.accounts_count : '-';
        document.getElementById('nodeSymbol').textContent = status.symbol || '-';
        const recNameEl = document.getElementById('nodeRecommendedChainName');
        if (recNameEl) recNameEl.textContent = status.recommended_chain_name || 'ChainRPS Local';

        // 持久化状态显示：仅 Ganache 支持，Hardhat 始终显示"不支持"
        const persistStatusEl = document.getElementById('nodePersistStatus');
        const persistDirRow = document.getElementById('nodePersistDirRow');
        const persistDirEl = document.getElementById('nodePersistDir');
        if (persistStatusEl) {
            if (status.persist_supported === false) {
                persistStatusEl.textContent = '不支持';
                persistStatusEl.style.color = 'var(--text-secondary)';
            } else if (status.persist_enabled) {
                persistStatusEl.textContent = '已启用';
                persistStatusEl.style.color = '#22c55e';
            } else {
                persistStatusEl.textContent = '已禁用';
                persistStatusEl.style.color = '#f59e0b';
            }
        }
        if (persistDirRow && persistDirEl) {
            // 仅在支持持久化且返回了数据目录时显示
            const showDir = status.persist_supported !== false && status.persist_data_dir;
            persistDirRow.style.display = showDir ? '' : 'none';
            if (showDir) persistDirEl.textContent = status.persist_data_dir;
        }

        const keepAliveCheckbox = document.getElementById('nodeKeepAliveToggle');
        const keepAliveToggle = keepAliveCheckbox ? keepAliveCheckbox.closest('.node-keepalive-toggle') : null;
        const keepAliveSub = document.getElementById('nodeKeepAliveSub');

        if (keepAliveToggle && keepAliveCheckbox) {
            const keepAlive = !!status.keep_alive;
            if (keepAliveCheckbox.checked !== keepAlive) {
                // 忽略代码修改触发的 change 事件
                this._ignoreKeepAliveChange = true;
                keepAliveCheckbox.checked = keepAlive;
                this._ignoreKeepAliveChange = false;
            }

            const keepAliveTitle = document.getElementById('nodeKeepAliveTitle');

            if (keepAliveToggle.classList) {
                keepAliveToggle.classList.remove('keep-alive-active', 'keep-alive-error');
                if (keepAlive) {
                    if (keepAliveTitle) keepAliveTitle.textContent = '停止节点';
                    if (status.running) {
                        keepAliveToggle.classList.add('keep-alive-active');
                        if (keepAliveSub) {
                            const count = status.keep_alive_restart_count || 0;
                            const chainType = status.chain_type === 'hardhat' ? 'Hardhat' : 'Ganache';
                            keepAliveSub.textContent = count > 0 ? `${chainType} · 已重启 ${count} 次` : `${chainType} · 运行中`;
                        }
                    } else {
                        keepAliveToggle.classList.add('keep-alive-error');
                        if (keepAliveSub) keepAliveSub.textContent = '正在启动...';
                    }
                } else {
                    if (keepAliveTitle) keepAliveTitle.textContent = '开启节点';
                    if (keepAliveSub) keepAliveSub.textContent = status.running ? '运行中 · 未保活' : '节点已停止';
                }
            }

            this._startNodeStatusAutoRefresh(!!status.keep_alive);
        }
    },

    // 初始化保活开关事件
    _initKeepAliveToggle() {
        const checkbox = document.getElementById('nodeKeepAliveToggle');
        if (!checkbox) return;
        if (checkbox._keepAliveBound) return;
        checkbox._keepAliveBound = true;
        checkbox.addEventListener('change', (e) => {
            if (this._ignoreKeepAliveChange) return;
            this._onKeepAliveToggle(e.target.checked);
        });
    },

    // 初始化本地链功能选择下拉框
    _initLocalChainFeatureSelector() {
        const selector = document.getElementById('localChainFeatureSelector');
        if (!selector) return;
        // 从 localStorage 恢复上次选择的功能
        let saved = 'accounts';
        try {
            saved = localStorage.getItem('rps_local_chain_feature') || 'accounts';
        } catch (e) { /* ignore */
        }
        if (selector.value !== saved) {
            selector.value = saved;
        }
        // 初始化时仅切换面板显示，不触发数据刷新（refreshNodeStatus 会按需刷新）
        this.switchLocalChainFeature(selector.value, true);
    },

    // 切换本地链功能面板显示
    switchLocalChainFeature(feature, skipRefresh) {
        const validFeatures = ['accounts', 'fund', 'fundToken', 'tokens', 'config'];

        const target = validFeatures.indexOf(feature) >= 0 ? feature : 'accounts';

        // 切换面板 active 状态
        validFeatures.forEach(f => {
            const panel = document.getElementById('feature-' + f);
            if (panel) {
                panel.classList.toggle('active', f === target);
            }
        });

        // 同步下拉框值（防止外部调用时下拉框未更新）
        const selector = document.getElementById('localChainFeatureSelector');
        if (selector && selector.value !== target) {
            selector.value = target;
        }

        // 持久化选择到 localStorage
        try {
            localStorage.setItem('rps_local_chain_feature', target);
        } catch (e) { /* ignore */
        }

        // 切换到对应面板时按需刷新数据（初始化时跳过，避免与 refreshNodeStatus 重复请求）
        if (skipRefresh) return;
        if (target === 'accounts') {
            this.refreshAccounts();
        } else if (target === 'fund' || target === 'fundToken') {
            // 充值面板：刷新账户下拉框并预填管理员地址
            this._refreshFundAccounts();
        } else if (target === 'tokens') {
            this.refreshTokenList();
        } else if (target === 'config') {
            // 本地链启动配置面板：填充表单（原 #/config/node 的逻辑迁移至此）
            this._applyNodeConfigToForm();
            this._applyRpcConfigToForm();
            this._applyEnvConfigToForm();
        }
    },

    // 刷新充值面板的来源账户下拉框（原生代币和USDC面板分别显示对应代币余额）
    _refreshFundAccounts() {
        // 账户列表为空时主动加载（用户直接切换到充值面板的场景）
        if (!this._localAccounts || this._localAccounts.length === 0) {
            this.refreshAccounts();
            return;
        }
        const nativeSym = this._nativeSymbol();

        // 原生代币充值下拉框：显示原生币余额
        const buildNativeOptions = () => this._localAccounts.map(acc => {
            const bal = parseFloat(acc.balance_eth || acc.balance || 0).toFixed(2);
            return `<option value="${acc.index}">账户 ${acc.index} (${bal} ${nativeSym})</option>`;
        }).join('');

        // USDC 充值下拉框：显示 USDC 余额
        const buildUsdcOptions = () => this._localAccounts.map(acc => {
            const bal = parseFloat(acc.balance_usdc || 0).toFixed(2);
            return `<option value="${acc.index}">账户 ${acc.index} (${bal} USDC)</option>`;
        }).join('');

        const fundSelect = document.getElementById('fundFromAccount');
        if (fundSelect) {
            const prev = fundSelect.value;
            fundSelect.innerHTML = buildNativeOptions();
            if (prev) fundSelect.value = prev;
        }
        const fundTokenSelect = document.getElementById('fundTokenFromAccount');
        if (fundTokenSelect) {
            const prev = fundTokenSelect.value;
            fundTokenSelect.innerHTML = buildUsdcOptions();
            if (prev) fundTokenSelect.value = prev;
        }

        // 预填管理员地址
        const fundToAddr = document.getElementById('fundToAddress');
        if (fundToAddr && !fundToAddr.value && this.adminAddress) {
            fundToAddr.value = this.adminAddress;
        }
        const fundTokenToAddr = document.getElementById('fundTokenToAddress');
        if (fundTokenToAddr && !fundTokenToAddr.value && this.adminAddress) {
            fundTokenToAddr.value = this.adminAddress;
        }

        // 更新原生代币符号显示
        const fundSymEl = document.getElementById('fundNativeSymbol');
        if (fundSymEl) fundSymEl.textContent = nativeSym;
        const accSymEl = document.getElementById('accountsNativeSymbol');
        if (accSymEl) accSymEl.textContent = nativeSym;
    },

    // 充值 USDC 测试代币
    async fundTokenAddress() {
        const fromIndex = parseInt(document.getElementById('fundTokenFromAccount')?.value);
        const toAddress = document.getElementById('fundTokenToAddress')?.value.trim();
        const amount = parseFloat(document.getElementById('fundTokenAmount')?.value);

        if (isNaN(fromIndex)) {
            FWUI.Toast.show('请选择来源账户', 'warning');
            return;
        }
        if (!toAddress || !/^0x[a-fA-F0-9]{40}$/.test(toAddress)) {
            FWUI.Toast.show('接收地址格式不正确', 'warning');
            return;
        }
        if (isNaN(amount) || amount <= 0) {
            FWUI.Toast.show('数量必须大于 0', 'warning');
            return;
        }

        try {
            FWUI.Toast.show('正在转账 USDC...', 'info');
            const result = await this.apiRequest('/api/admin/local-chain/send-token', 'POST', {
                from_index: fromIndex,
                to_address: toAddress,
                amount: amount,
                symbol: 'USDC',
            });
            if (result.success) {
                FWUI.Toast.success(result.message || `成功发送 ${amount} USDC`);
                this.refreshAccounts();
            } else {
                FWUI.Toast.error(result.message || 'USDC 转账失败');
            }
        } catch (e) {
            FWUI.Toast.error('USDC 转账失败: ' + e.message);
        }
    },

    // 保活开关切换处理
    async _onKeepAliveToggle(enabled) {
        // 乐观更新：点击后立即刷新 UI
        this._updateKeepAliveUI(enabled, false);
        this._startNodeStatusAutoRefresh(enabled);

        try {
            const payload = {enabled};
            const chain_type = document.getElementById('nodeConfigChainType')?.value;
            if (chain_type) payload.chain_type = chain_type;

            if (enabled) {
                const host = document.getElementById('nodeConfigHost')?.value?.trim();
                const port = document.getElementById('nodeConfigPort')?.value?.trim();
                const chain_id = document.getElementById('nodeConfigChainId')?.value?.trim();
                const accounts_count = document.getElementById('nodeConfigAccounts')?.value?.trim();
                const default_balance = document.getElementById('nodeConfigBalance')?.value?.trim();
                const symbol = document.getElementById('nodeConfigSymbol')?.value?.trim();
                const deterministic = document.getElementById('nodeConfigDeterministic')?.checked;
                const persist = document.getElementById('nodeConfigPersist')?.checked;

                if (host) payload.host = host;
                if (port) payload.port = port;
                if (chain_id) payload.chain_id = chain_id;
                if (accounts_count) payload.accounts_count = accounts_count;
                if (default_balance) payload.default_balance = default_balance;
                if (symbol) payload.symbol = symbol;
                if (deterministic != null) payload.deterministic = deterministic;
                if (persist != null) payload.persist = persist;
            }

            if (enabled) {
                FWUI.Toast.info('正在启动节点...');
            } else {
                FWUI.Toast.info('正在停止节点...');
            }

            const result = await this.apiRequest('/api/admin/local-chain/keep-alive', 'POST', payload);

            if (result.success) {
                if (enabled) {
                    FWUI.Toast.success('节点已启动，保活已开启');
                } else {
                    FWUI.Toast.success('节点保活已关闭');
                }
                this._saveNodeConfigFromForm();
                this.refreshNodeStatus();
            } else {
                FWUI.Toast.error(result.message || '操作失败');
                const checkbox = document.getElementById('nodeKeepAliveToggle');
                if (checkbox) {
                    this._ignoreKeepAliveChange = true;
                    checkbox.checked = !enabled;
                    this._ignoreKeepAliveChange = false;
                }
                this._updateKeepAliveUI(!enabled, false);
            }
        } catch (e) {
            FWUI.Toast.error('操作失败: ' + (e.message || e));
            const checkbox = document.getElementById('nodeKeepAliveToggle');
            if (checkbox) {
                this._ignoreKeepAliveChange = true;
                checkbox.checked = !enabled;
                this._ignoreKeepAliveChange = false;
            }
            this._updateKeepAliveUI(!enabled, false);
        }
    },

    // 切换到本地网络（自动优先，失败则引导手动操作）
    async switchToLocalNetwork() {
        if (!window.ethereum) {
            FWUI.Toast.warning('未检测到 MetaMask/OKX Wallet，请先安装钱包插件');
            return false;
        }

        const port = (document.getElementById('nodeConfigPort')?.value || String(CONFIG.RPC_PORT)).trim();
        const chainId = (document.getElementById('nodeConfigChainId')?.value || '5208888').trim();
        const symbol = (document.getElementById('nodeConfigSymbol')?.value || CONFIG.getNativeSymbol()).trim();
        const host = (document.getElementById('nodeConfigHost')?.value || '127.0.0.1').trim();
        const networkName = `ChainRPS Local (${port})`;

        const hexChainId = '0x' + parseInt(chainId).toString(16);
        const rpcUrl = `http://${host}:${port}`;

        const showManualGuide = (reason) => {
            const info = this._tokenInfo || {};
            const netName = info.networkName || networkName;
            FWUI.Modal.alert({
                title: '📖 手动添加网络教程',
                content: `
                    <div style="line-height:1.9;">
                        ${reason ? `<div style="background:rgba(239,68,68,0.08);color:var(--warning-color);padding:8px 10px;border-radius:6px;font-size:12px;margin-bottom:10px;">${reason}</div>` : ''}
                        <div style="background:var(--bg-secondary);padding:12px;border-radius:8px;margin-bottom:12px;">
                            <div style="font-weight:600;margin-bottom:8px;">网络参数（点击复制）</div>
                            <div style="font-size:12px;font-family:monospace;line-height:2;">
                                <div>Network Name: <span style="cursor:pointer;color:var(--primary-color);" onclick="AdminApp.copyToClipboard('${netName}')">${netName}</span></div>
                                <div>RPC URL: <span style="cursor:pointer;color:var(--primary-color);word-break:break-all;" onclick="AdminApp.copyToClipboard('${rpcUrl}')">${rpcUrl}</span></div>
                                <div>Chain ID: <span style="cursor:pointer;color:var(--primary-color);" onclick="AdminApp.copyToClipboard('${chainId}')">${chainId}</span></div>
                                <div>Symbol: <span style="cursor:pointer;color:var(--primary-color);" onclick="AdminApp.copyToClipboard('${symbol}')">${symbol}</span></div>
                                <div>Decimals: 18</div>
                            </div>
                        </div>
                        <div style="font-weight:600;margin-bottom:6px;">操作步骤（MetaMask / OKX 通用）</div>
                        <div style="margin-bottom:8px;padding:8px 10px;background:var(--bg-card);border-radius:6px;border:1px solid var(--border-color);font-size:12px;">
                            <div style="font-weight:500;">1️⃣ 打开钱包 → 点击顶部网络下拉框</div>
                            <div style="color:var(--text-secondary);margin-top:2px;">MetaMask: 左上角「Ethereum Mainnet」→「添加网络」→「添加自定义网络」</div>
                            <div style="color:var(--text-secondary);margin-top:2px;">OKX: 顶部网络图标 →「添加网络」→「自定义网络」</div>
                        </div>
                        <div style="margin-bottom:8px;padding:8px 10px;background:var(--bg-card);border-radius:6px;border:1px solid var(--border-color);font-size:12px;">
                            <div style="font-weight:500;">2️⃣ 填入上方网络参数</div>
                        </div>
                        <div style="margin-bottom:8px;padding:8px 10px;background:var(--bg-card);border-radius:6px;border:1px solid var(--border-color);font-size:12px;">
                            <div style="font-weight:500;">3️⃣ 保存并切换 → 钱包将自动显示 ${symbol} 原生代币</div>
                        </div>
                        <div style="margin-top:10px;padding:8px 10px;background:rgba(16,185,129,0.08);border-radius:6px;font-size:12px;color:var(--text-primary);">
                            💡 添加成功后，点击「一键添加 / 切换网络」按钮即可快速切换回此网络
                        </div>
                    </div>
                `,
                okText: '我知道了'
            });
        };

        try {
            FWUI.Toast.info(`正在切换到本地网络 (ChainID: ${chainId})...`);

            // 1. 先尝试直接切换（若网络已存在）
            try {
                await window.ethereum.request({
                    method: 'wallet_switchEthereumChain',
                    params: [{chainId: hexChainId}],
                });
                FWUI.Toast.success('✅ 已切换到本地网络');
                this._afterNetworkSwitch();
                return true;
            } catch (switchError) {
                if (switchError.code !== 4902) {
                    throw switchError;
                }
            }

            // 2. 网络不存在 → 尝试自动添加
            const isLocalHttp = rpcUrl.startsWith('http://') && (
                rpcUrl.includes('127.0.0.1') ||
                rpcUrl.includes('localhost') ||
                rpcUrl.includes('0.0.0.0')
            );

            if (isLocalHttp) {
                FWUI.Toast.warning('钱包不允许自动添加 HTTP 网络，请手动配置');
                showManualGuide('本地 HTTP RPC 地址出于安全原因不被钱包自动添加，请手动在钱包中添加。');
                return false;
            }

            // 非本地 HTTP，尝试自动添加网络
            try {
                await window.ethereum.request({
                    method: 'wallet_addEthereumChain',
                    params: [{
                        chainId: hexChainId,
                        chainName: networkName,
                        nativeCurrency: {name: symbol, symbol: symbol, decimals: 18},
                        rpcUrls: [rpcUrl],
                        blockExplorerUrls: null,
                    }],
                });
                FWUI.Toast.success('✅ 已添加并切换到本地网络');
                this._afterNetworkSwitch();
                return true;
            } catch (addError) {
                const addMsg = (addError.message || '').toLowerCase();
                const m = (addError.message || '').match(/chain\s+(0x[0-9a-fA-F]+)/i);
                const existingHex = m ? m[1] : null;

                // 3. 同 RPC 不同 chain ID → 自动切换到已存在的那个
                if ((addMsg.includes('same rpc endpoint') || addMsg.includes('existing network')) && existingHex) {
                    const existingDec = parseInt(existingHex, 16);
                    FWUI.Toast.info(`检测到已有同 RPC 网络 (ChainID: ${existingDec})，正在切换...`);
                    try {
                        await window.ethereum.request({
                            method: 'wallet_switchEthereumChain',
                            params: [{chainId: existingHex}],
                        });
                        const chainIdInput = document.getElementById('nodeConfigChainId');
                        if (chainIdInput) chainIdInput.value = existingDec;
                        FWUI.Toast.success(`✅ 已切换到本地网络 (ChainID: ${existingDec})`);
                        this._afterNetworkSwitch();
                        return true;
                    } catch (e2) {
                        FWUI.Toast.error('切换失败: ' + (e2.message || e2));
                        showManualGuide('钱包中存在相同 RPC 但无法自动切换，请手动操作。');
                        return false;
                    }
                }

                // 4. 其他错误 → 显示手动指引
                FWUI.Toast.warning('自动添加失败，请手动配置网络');
                showManualGuide(`自动添加网络失败：${addError.message || addError}`);
                return false;
            }
        } catch (e) {
            FWUI.Toast.error('切换网络失败: ' + (e.message || e));
            showManualGuide('发生未知错误，请按以下步骤手动添加网络。');
            return false;
        }
    },

    // 网络切换后处理
    _afterNetworkSwitch() {
        if (this.provider) {
            this.provider.getNetwork().then(network => {
                this.adminChainId = Number(network.chainId);
            }).catch(() => {
            });
        }
    },

    // 启动本地节点
    async startLocalNode() {
        try {
            // 读取启动配置（留空使用后端默认值）
            // 获取表单输入值
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
            const persistEl = document.getElementById('nodeConfigPersist');
            const persist = persistEl ? persistEl.checked : true;

            const payload = {};
            if (host) payload.host = host;
            if (port) payload.port = parseInt(port);
            if (chainId) payload.chain_id = parseInt(chainId);
            if (accounts) payload.accounts_count = parseInt(accounts);
            if (balance) payload.default_balance = parseFloat(balance);
            if (symbol) payload.symbol = symbol;
            payload.deterministic = deterministic;
            payload.persist = persist;

            FWUI.Toast.info('正在启动节点...');
            const result = await this.apiRequest('/api/admin/local-chain/start', 'POST', payload);
            FWUI.Toast.success(result.message || '节点启动成功');
            // 保存启动参数到 localStorage
            this._saveNodeConfig(payload);
            this.refreshNodeStatus();
        } catch (e) {
            FWUI.Toast.error('启动失败: ' + e.message);
        }
    },

    // 停止本地节点
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

    // 清空持久化链数据（停止节点 → 删除数据目录 → 重启）
    async resetChainData() {
        FWUI.Modal.confirm({
            title: '⚠️ 清空链数据',
            content: '此操作将：<br>1. 停止当前运行的节点<br>2. 删除持久化数据目录<br>3. 重启节点（恢复到创世状态）<br><br><b style="color:#ef4444;">所有已部署的合约和链上状态将永久丢失！</b><br>确定继续吗？',
            onOk: async () => {
                try {
                    FWUI.Toast.info('正在清空链数据...');
                    const result = await this.apiRequest('/api/admin/local-chain/reset-data', 'POST', {});
                    if (result.success) {
                        FWUI.Toast.success(result.message || '链数据已重置');
                        // 重置完成后，若保活开启，节点会自动重启；否则手动刷新状态
                        setTimeout(() => this.refreshNodeStatus(), 1500);
                    } else {
                        FWUI.Toast.error(result.message || '重置失败');
                    }
                } catch (e) {
                    FWUI.Toast.error('重置失败: ' + (e.detail || e.message));
                }
            }
        });
    },

    // 刷新账户列表（含原生币和 USDC 余额）
    async refreshAccounts() {
        try {
            const data = await this.apiRequest('/api/admin/local-chain/accounts');
            const accounts = data.accounts || [];
            const tbody = document.getElementById('nodeAccountsBody');
            const fundSelect = document.getElementById('fundFromAccount');
            const nativeSym = this._nativeSymbol();

            // 保存账户列表供其他面板（如 USDC 充值）使用
            this._localAccounts = accounts;

            // 更新账户表格
            if (accounts.length === 0) {
                tbody.innerHTML = '<tr><td colspan="5" style="text-align:center; padding: 30px; color: #475569;">无账户</td></tr>';
                if (fundSelect) fundSelect.innerHTML = '<option value="">-- 请选择账户 --</option>';
                this._refreshFundAccounts();
                return;
            }

            tbody.innerHTML = accounts.map(acc => {
                const nativeBal = parseFloat(acc.balance_eth || 0).toFixed(4);
                const usdcBal = parseFloat(acc.balance_usdc || 0).toFixed(2);
                return `
                <tr>
                    <td>${acc.index}</td>
                    <td style="font-size: 12px; font-family: monospace;">${acc.address}</td>
                    <td>${nativeBal} ${nativeSym}</td>
                    <td>${usdcBal} USDC</td>
                    <td>
                        <button class="btn btn-outline" style="padding: 2px 8px; font-size: 12px;" onclick="AdminApp.copyAddress('${acc.address}')">复制</button>
                    </td>
                </tr>
            `}).join('');

            // 同步两个充值面板的来源账户下拉框（原生代币 + USDC）
            this._refreshFundAccounts();
        } catch (e) {
            console.warn('加载账户失败:', e);
        }
    },

    // 复制地址到剪贴板
    copyAddress(addr) {
        navigator.clipboard.writeText(addr).then(() => {
            FWUI.Toast.success('地址已复制');
        });
    },

    // 重新部署 USDC 并向所有账户分发
    async redeployUsdc() {
        const confirmed = await FWUI.Modal.confirm(
            '重新部署 USDC',
            '将清除旧的 USDC 合约记录，重新部署 MockERC20 合约并向所有测试账户分发 100,000 USDC。\n\n此操作不可撤销，确定继续？'
        );
        if (!confirmed) return;

        try {
            const result = await this.apiRequest('/api/admin/local-chain/redeploy-usdc', {
                method: 'POST',
                headers: {'Content-Type': 'application/json'},
                body: JSON.stringify({per_account_amount: 100000}),
            });
            if (result.success) {
                FWUI.Toast.success(result.message || 'USDC 重新部署成功');
                await this.refreshAccounts();
            } else {
                FWUI.Toast.error(result.message || 'USDC 重新部署失败');
            }
        } catch (e) {
            FWUI.Toast.error('USDC 重新部署失败: ' + (e.message || e));
        }
    },

    // 充值地址（转账ETH）
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

        const btn = event?.target;
        const originalText = btn?.textContent;
        if (btn) {
            btn.disabled = true;
            btn.textContent = '转账中...';
        }

        try {
            FWUI.Toast.info('正在转账...');
            const result = await this.apiRequest('/api/admin/local-chain/send-eth', 'POST', {
                to_address: toAddress,
                amount: amount,
                from_index: fromIndex,
            });

            if (result.success === false) {
                FWUI.Toast.error(result.message || '转账失败');
                return;
            }

            const _sym = this._nativeSymbol();
            const newBal = result.new_balance_eth ? `，当前余额: ${result.new_balance_eth} ${_sym}` : '';
            const txHash = result.tx_hash ? ` (区块 #${result.block_number || '?'})` : '';
            FWUI.Toast.success(`成功发送 ${amount} ${_sym}${newBal}${txHash}`);
            this.refreshAccounts();
            this.refreshNodeStatus();
        } catch (e) {
            FWUI.Toast.error('转账失败: ' + e.message);
        } finally {
            if (btn) {
                btn.disabled = false;
                btn.textContent = originalText || `💰 发送 ${result.symbol}`;
            }
        }
    },

    // 刷新代币列表
    async refreshTokenList() {
        try {
            const data = await this.apiRequest('/api/admin/local-chain/tokens');
            this._localTokens = data.tokens || [];
            this._renderTokenList();
        } catch (e) {
            console.warn('加载代币列表失败:', e);
        }
    },

    // 渲染代币列表
    _renderTokenList() {
        const tbody = document.getElementById('nodeTokensBody');
        const tokens = this._localTokens;

        if (tokens.length === 0) {
            tbody.innerHTML = '<tr><td colspan="3" style="text-align:center; padding: 30px; color: #475569;">暂无代币</td></tr>';
            return;
        }

        tbody.innerHTML = tokens.map(t => `
            <tr>
                <td><strong>${t.symbol}</strong> (${t.name})</td>
                <td style="font-size: 12px; font-family: monospace;">${t.address}</td>
                <td>${t.decimals}</td>
            </tr>
        `).join('');
    },

    // 显示部署本地代币弹窗
    showDeployLocalTokenModal() {
        document.getElementById('deployLocalTokenModal').classList.add('show');
    },

    // 部署本地代币
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
            if (result.success === false) {
                FWUI.Toast.error(result.message || '部署失败');
                return;
            }
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

    // ==================== Redis 管理 ====================

    // 刷新 Redis 状态
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

    // 渲染 Redis 状态
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

    // 启动 Redis
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

    // 停止 Redis
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

    // 加载 Redis 配置
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
                    <td style="word-break: break-all;">${v || '<span style="color:#475569">空</span>'}</td>
                </tr>
            `).join('');

            document.getElementById('redisConfigSection').style.display = 'block';
            FWUI.Toast.success('配置已加载');
        } catch (e) {
            FWUI.Toast.error('获取配置失败: ' + e.message);
        }
    },

    // 加载 Redis 键列表
    async loadRedisKeys() {
        const pattern = document.getElementById('redisKeyPattern').value.trim() || '*';
        try {
            const data = await this.apiRequest(`/api/admin/redis/keys?pattern=${encodeURIComponent(pattern)}&limit=100`);
            const keys = data.keys || [];
            const tbody = document.getElementById('redisKeysBody');

            if (keys.length === 0) {
                tbody.innerHTML = '<tr><td colspan="5" style="text-align:center; padding: 30px; color: #475569;">无匹配键</td></tr>';
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

    // 删除 Redis 键
    async deleteRedisKey(key) {
        FWUI.Modal.confirm({
            title: '确认删除',
            content: `确定删除键 "${key}" 吗？`,
            onOk: async () => {
                try {
                    await this.apiRequest('/api/admin/redis/delete-key', 'POST', {key});
                    FWUI.Toast.success('已删除');
                    this.loadRedisKeys();
                    this.refreshRedisStatus();
                } catch (e) {
                    FWUI.Toast.error('删除失败: ' + e.message);
                }
            }
        });
    },

    // 清空 Redis 数据库
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
                            const result = await this.apiRequest('/api/admin/redis/flush-db', 'POST', {
                                confirm: true,
                                db: 0
                            });
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

    // 加载配置列表
    async loadConfig() {
        try {
            const category = document.getElementById('configCategory').value;
            const path = category ? `/api/admin/config?category=${category}` : '/api/admin/config';
            const configs = await this.apiRequest(path);
            const container = document.getElementById('configList');

            if (!configs || configs.length === 0) {
                container.innerHTML = '<div style="padding:40px; text-align:center; color:var(--text-secondary);">暂无配置项</div>';
                return;
            }

            // 分类标签颜色映射
            const categoryBadge = (cat) => {
                const map = {
                    'chain': '<span style="background:#dbeafe; color:#1e40af; padding:2px 8px; border-radius:4px; font-size:11px; font-weight:600;">主链</span>',
                    'game': '<span style="background:#dcfce7; color:#166534; padding:2px 8px; border-radius:4px; font-size:11px; font-weight:600;">游戏</span>',
                    'contract': '<span style="background:#fef3c7; color:#92400e; padding:2px 8px; border-radius:4px; font-size:11px; font-weight:600;">合约</span>',
                    'system': '<span style="background:#f1f5f9; color:#475569; padding:2px 8px; border-radius:4px; font-size:11px; font-weight:600;">系统</span>',
                };
                return map[cat] || `<span style="background:#f1f5f9; color:#475569; padding:2px 8px; border-radius:4px; font-size:11px;">${cat || '未分类'}</span>`;
            };

            container.innerHTML = configs.map(c => {
                const isDefault = c.default_value != null && String(c.config_value) === String(c.default_value);
                const defaultValLabel = c.default_value != null
                    ? '<span style="font-size:11px; color:var(--text-secondary);" title="默认值: ' + c.default_value + '">默认: <code style="font-size:11px;">' + (c.default_value || '(空)') + '</code></span>'
                    : '';
                return `
                <div class="config-item" style="display:flex; align-items:center; justify-content:space-between; padding:12px 16px; border-bottom:1px solid var(--border-color);">
                    <div style="flex:1; min-width:0;">
                        <div style="display:flex; align-items:center; gap:8px; margin-bottom:4px;">
                            ${categoryBadge(c.category)}
                            <span style="font-family:monospace; font-size:13px; font-weight:600; color:var(--text-primary);">${c.config_key}</span>
                            ${defaultValLabel}
                        </div>
                        <div style="font-size:12px; color:var(--text-secondary);">${c.description || '-'}</div>
                    </div>
                    <div style="display:flex; align-items:center; gap:8px; flex-shrink:0;">
                        <input type="text" id="config-${c.config_key}" value="${c.config_value || ''}" data-key="${c.config_key}" data-original="${c.config_value || ''}"
                            style="width:${c.config_key === 'contract_address' ? '320px' : '200px'}; padding:6px 10px; border:1px solid var(--border-color); border-radius:6px; background:var(--input-bg); color:var(--text-primary); font-family:monospace; font-size:13px;">
                    </div>
                </div>
            `;
            }).join('');
        } catch (e) {
            console.error('Failed to load config:', e);
            const container = document.getElementById('configList');
            if (container) {
                container.innerHTML = '<div style="padding:40px; text-align:center; color:#ef4444;">加载失败: ' + e.message + '</div>';
            }
        }
    },

    // 保存当前页面所有已修改的配置项（页面级保存）
    async saveAllConfig() {
        const inputs = document.querySelectorAll('#configList input[data-key]');
        const items = {};
        let changedCount = 0;
        inputs.forEach(input => {
            const key = input.dataset.key;
            const original = input.dataset.original || '';
            const current = input.value;
            if (current !== original) {
                items[key] = current;
                changedCount++;
            }
        });
        if (changedCount === 0) {
            FWUI.Toast.info('没有修改的配置项');
            return;
        }
        try {
            await this.apiRequest('/api/admin/config/batch', 'POST', {items, admin_address: this.adminAddress});
            FWUI.Toast.success(`保存成功，共更新 ${changedCount} 项配置`);
            this.loadConfig();
            this.loadAuditLogs();
        } catch (e) {
            FWUI.Toast.error('保存失败: ' + e.message);
        }
    },

    // 更新单项配置
    async updateConfig(key) {
        const input = document.getElementById('config-' + key);
        const value = input.value;
        try {
            await this.apiRequest(`/api/admin/config/${key}`, 'PUT', {value, admin_address: this.adminAddress});
            FWUI.Toast.success(`配置 ${key} 更新成功`);
            this.loadAuditLogs();
            // 刷新当前项的默认值状态（按钮置灰等）
            this.loadConfig();
        } catch (e) {
            FWUI.Toast.error('更新失败: ' + e.message);
        }
    },

    // 重置单项配置为默认值
    async resetSingleConfig(key) {
        FWUI.Modal.confirm({
            title: '恢复默认值',
            content: `确定要将配置项 <b>${key}</b> 恢复为默认值吗？`,
            onOk: async () => {
                try {
                    const result = await this.apiRequest(`/api/admin/config/${key}/reset`, 'POST', {admin_address: this.adminAddress});
                    if (result.unchanged) {
                        FWUI.Toast.info(`配置 ${key} 已是默认值`);
                    } else {
                        FWUI.Toast.success(`配置 ${key} 已恢复为默认值`);
                        this.loadAuditLogs();
                    }
                    this.loadConfig();
                } catch (e) {
                    FWUI.Toast.error('恢复失败: ' + e.message);
                }
            }
        });
    },

    // 使用当前钱包网络 Chain ID 填入配置
    async useCurrentChainAsMain() {
        try {
            if (!window.ethereum) {
                FWUI.Toast.error('未检测到钱包，请先连接钱包');
                return;
            }

            const chainIdHex = await window.ethereum.request({method: 'eth_chainId'});
            const chainId = parseInt(chainIdHex, 16);

            // 直接通过 API 更新 chain_id 配置项
            await this.apiRequest('/api/admin/config/chain_id', 'PUT', {
                value: String(chainId),
                admin_address: this.adminAddress
            });

            FWUI.Toast.success(`已将 chain_id 更新为当前网络: ${chainId}`);
            this.loadConfig();
            this.loadAuditLogs();
        } catch (e) {
            console.error('Failed to set current chain:', e);
            FWUI.Toast.error('获取当前网络失败: ' + e.message);
        }
    },

    // 显示批量更新配置弹窗
    async showBatchUpdateModal() {
        // 获取当前所有配置项，生成示例 JSON
        let exampleObj = {};
        let defaultsHTML = '';
        try {
            const configs = await this.apiRequest('/api/admin/config');
            if (configs && configs.length > 0) {
                // 取前5项作为示例
                const samples = configs.slice(0, 5);
                samples.forEach(c => {
                    exampleObj[c.config_key] = c.config_value || c.default_value || '';
                });
                // 生成所有默认值参考表
                defaultsHTML = configs.map(c => {
                    const val = c.default_value != null ? c.default_value : '(无)';
                    return `<tr><td style="font-family:monospace; font-size:12px; padding:3px 8px; color:#475569;">${c.config_key}</td><td style="font-family:monospace; font-size:12px; padding:3px 8px; color:#0f172a;">${val}</td></tr>`;
                }).join('');
            }
        } catch (e) {
            console.warn('获取配置示例失败:', e);
        }
        const exampleJSON = JSON.stringify(exampleObj, null, 2);

        const inputModal = FWUI.Modal.create({
            title: '批量更新配置',
            content: `
                <div class="form-group" style="margin-bottom: 12px;">
                    <label style="display:block; font-size:13px; margin-bottom:6px; color:#475569;">
                        JSON 格式配置（key 为配置项名，value 为新值）
                    </label>
                    <textarea id="batchConfigInput" rows="6" style="
                        width: 100%;
                        padding: 10px 12px;
                        border: 1px solid #e2e8f0;
                        border-radius: 8px;
                        background: #f8fafc;
                        color: #0f172a;
                        font-family: monospace;
                        font-size: 13px;
                    " placeholder='${exampleJSON.replace(/'/g, "&#39;")}'>${exampleJSON}</textarea>
                </div>
                <div style="font-size: 12px; color: #475569; margin-bottom: 8px;">
                    💡 已预填当前前5项配置作为示例，可直接修改后提交。也可点击下方"填入全部当前值"加载所有配置项。
                </div>
                <details style="margin-top: 8px;">
                    <summary style="cursor:pointer; font-size:12px; color:#6366f1; font-weight:500;">📋 查看所有配置项默认值参考</summary>
                    <div style="max-height:200px; overflow-y:auto; margin-top:8px; border:1px solid #e2e8f0; border-radius:6px;">
                        <table style="width:100%; border-collapse:collapse;">
                            <thead>
                                <tr style="background:#f1f5f9; position:sticky; top:0;">
                                    <th style="text-align:left; padding:6px 8px; font-size:11px; color:#475569;">配置项</th>
                                    <th style="text-align:left; padding:6px 8px; font-size:11px; color:#475569;">默认值</th>
                                </tr>
                            </thead>
                            <tbody>${defaultsHTML}</tbody>
                        </table>
                    </div>
                </details>
                <div style="margin-top: 8px;">
                    <button class="fwui-btn fwui-btn-default" style="padding:6px 14px; border-radius:8px; font-size:12px; cursor:pointer; border:1px solid #e2e8f0; background:#fff; color:#475569;"
                        onclick="AdminApp._fillAllConfigToBatch()">填入全部当前值</button>
                </div>
            `,
            width: '560px',
            footer: `
                    <button class="fwui-btn fwui-btn-default" style="
                        padding: 8px 20px;
                        border-radius: 10px;
                        font-size: 14px;
                        font-weight: 500;
                        cursor: pointer;
                        border: 1px solid #e2e8f0;
                        background: #fff;
                        color: #0f172a;
                    " onclick="document.querySelector('.fwui-modal-mask').remove();">取消</button>
                    <button class="fwui-btn fwui-btn-primary" style="
                        padding: 8px 20px;
                        border-radius: 10px;
                        font-size: 14px;
                        font-weight: 500;
                        cursor: pointer;
                        border: none;
                        background: #6366f1;
                        color: #fff;
                    " onclick="AdminApp.doBatchUpdate()">确认更新</button>
                `
        });
    },

    // 填入全部当前配置值到批量更新文本框
    async _fillAllConfigToBatch() {
        try {
            const configs = await this.apiRequest('/api/admin/config');
            if (!configs || configs.length === 0) {
                FWUI.Toast.warning('未获取到配置项');
                return;
            }
            const allObj = {};
            configs.forEach(c => {
                allObj[c.config_key] = c.config_value || c.default_value || '';
            });
            document.getElementById('batchConfigInput').value = JSON.stringify(allObj, null, 2);
            FWUI.Toast.info(`已填入 ${configs.length} 项配置`);
        } catch (e) {
            FWUI.Toast.error('获取配置失败: ' + e.message);
        }
    },

    // 执行批量更新配置
    async doBatchUpdate() {
        const json = document.getElementById('batchConfigInput').value;
        if (!json) {
            FWUI.Toast.warning('请输入配置内容');
            return;
        }
        try {
            const items = JSON.parse(json);
            await this.apiRequest('/api/admin/config/batch', 'POST', {items, admin_address: this.adminAddress});
            document.querySelector('.fwui-modal-mask').remove();
            FWUI.Toast.success('批量更新成功');
            this.loadConfig();
            this.loadAuditLogs();
        } catch (e) {
            FWUI.Toast.error('JSON 格式错误: ' + e.message);
        }
    },

    // 重置配置为默认值
    resetConfig() {
        FWUI.Modal.confirm({
            title: '重置为默认值',
            content: '此操作将把所有系统配置项恢复为默认值，且不可逆。确定要继续吗？',
            onOk: async () => {
                try {
                    const result = await this.apiRequest('/api/admin/config/reset', 'POST', {admin_address: this.adminAddress});
                    FWUI.Toast.success(result.message || '配置已重置');
                    this.loadConfig();
                    this.loadAuditLogs();
                } catch (e) {
                    FWUI.Toast.error('重置失败: ' + e.message);
                }
            }
        });
    },

    // 加载审计日志
    async loadAuditLogs() {
        try {
            const action = document.getElementById('auditAction').value;
            const path = action ? `/api/admin/audit-logs?action=${action}` : '/api/admin/audit-logs';
            const data = await this.apiRequest(path);
            const tbody = document.getElementById('auditTableBody');

            if (data.logs.length === 0) {
                tbody.innerHTML = '<tr><td colspan="7" style="text-align:center; padding: 40px; color: #475569;">暂无日志</td></tr>';
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
                    <td>${log.created_at ? new Date(log.created_at).toLocaleString('zh-CN', {
                timeZone: 'Asia/Shanghai',
                hour12: false
            }) : '-'}</td>
                </tr>
            `).join('');
        } catch (e) {
            console.error('Failed to load audit logs:', e);
        }
    },

    // 加载链配置
    loadChainConfig() {
        const addr = CONFIG.getContractAddress ? CONFIG.getContractAddress() : '';
        if (addr && this.isValidAddress(addr)) {
            this.loadContractInfo();
        }
    },

    // 校验地址格式
    isValidAddress(addr) {
        return typeof addr === 'string' && /^0x[a-fA-F0-9]{40}$/.test(addr);
    },

    // 加载合约信息
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
            // 安全调用合约方法
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

    // 加载合约 ABI
    async loadAbi() {
        const contracts = await this.apiRequest('/api/admin/contracts');
        if (contracts.length > 0 && contracts[0].abi) {
            return JSON.parse(contracts[0].abi);
        }
        return [];
    },

    // 连接管理员钱包
    async connectAdminWallet() {
        if (!window.ethereum) {
            FWUI.Toast.warning('请安装 MetaMask 钱包');
            return;
        }
        // 用户主动连接，清除"已主动断开"标记
        try { localStorage.removeItem('rps_wallet_disconnected'); } catch (e) {}
        try {
            const accounts = await window.ethereum.request({method: 'eth_requestAccounts'});
            this.adminAddress = accounts[0];
            this.provider = new ethers.BrowserProvider(window.ethereum);
            this.signer = await this.provider.getSigner();

            document.getElementById('adminWallet').innerHTML = `
                <span style="font-family: monospace; font-size: 13px; color: #475569;">
                    ${this.adminAddress.slice(0, 8)}...${this.adminAddress.slice(-6)}
                </span>
            `;
            document.getElementById('adminConnectInfo').style.display = 'flex';
            document.getElementById('adminAddress').textContent = this.adminAddress;
            document.getElementById('fundToAddress').textContent = this.adminAddress;

            FWUI.Toast.success('钱包连接成功');
            this.loadContractInfo();
        } catch (e) {
            FWUI.Toast.error('连接失败: ' + e.message);
        }
    },

    // 断开管理员钱包
    async disconnectAdminWallet() {
        // 设置"已主动断开"标记：刷新页面后 autoConnectWallet 检查此标记跳过自动重连
        // 必须先设置标记，确保即使钱包不支持 revoke 也能阻止重连
        try { localStorage.setItem('rps_wallet_disconnected', '1'); } catch (e) {}

        // 真正与钱包断开：撤销 EIP-1193 权限
        if (window.ethereum && window.ethereum.request) {
            try {
                await window.ethereum.request({
                    method: 'wallet_revokePermissions',
                    params: [{eth_accounts: {}}]
                });
            } catch (e) {
                console.warn('钱包不支持 wallet_revokePermissions，已设置本地断开标记');
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

    // 获取带签名器的合约实例
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

    // 设置手续费率
    async setFeeRate() {
        const rate = document.getElementById('newFeeRate').value;
        if (!rate) {
            FWUI.Toast.warning('请输入新费率');
            return;
        }
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

    // 设置超时时间
    async setTimeouts() {
        const commit = document.getElementById('newCommitTimeout').value;
        const reveal = document.getElementById('newRevealTimeout').value;
        if (!commit || !reveal) {
            FWUI.Toast.warning('请输入超时时间');
            return;
        }
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

    // 更新官方信息
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

    // 设置开发者地址
    async setDeveloperAddress() {
        const addr = document.getElementById('newDeveloperAddress').value;
        if (!addr) {
            FWUI.Toast.warning('请输入新地址');
            return;
        }
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

    // 设置代币支持
    async setTokenSupport() {
        const tokenAddr = document.getElementById('tokenAddress').value;
        const supported = document.getElementById('tokenSupported').value === 'true';
        if (!tokenAddr) {
            FWUI.Toast.warning('请输入代币地址');
            return;
        }
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

    // 暂停合约
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

    // 恢复合约
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

    // 取消对局
    async cancelMatch() {
        const gameId = document.getElementById('cancelGameId').value;
        if (!gameId) {
            FWUI.Toast.warning('请输入对局 ID');
            return;
        }
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

    // ==================== 本地链启动配置 ====================

    // 保存节点配置（暴露给 HTML 调用）
    saveNodeConfig() {
        this._saveNodeConfigFromForm();
        FWUI.Toast.success('节点配置已保存到本地存储');
    },

    // 测试 RPC 连接
    async testRpcConnection() {
        const getVal = (id) => {
            const el = document.getElementById(id);
            return el && el.value.trim() !== '' ? el.value.trim() : null;
        };
        const port = getVal('nodeConfigPort') || String(CONFIG.RPC_PORT);
        const host = getVal('nodeConfigHost') || '127.0.0.1';
        const rpcUrl = `http://${host}:${port}`;
        FWUI.Toast.info(`正在测试 RPC 节点 ${rpcUrl} ...`);
        try {
            const result = await this.apiRequest(`/api/admin/local-chain/test-rpc?url=${encodeURIComponent(rpcUrl)}`);
            if (result.ok) {
                FWUI.Toast.success(`连接成功！链 ID: ${result.chainId}, 区块高度: ${result.blockNumber}`);
            } else {
                FWUI.Toast.error(`连接失败: ${result.error || '未知错误'}`);
            }
        } catch (e) {
            FWUI.Toast.error(`测试请求失败: ${e.message}`);
        }
    },

    // 保存 RPC 配置
    async saveRpcConfig() {
        const mainRpc = document.getElementById('mainRpcUrl')?.value?.trim();
        const backupRpc = document.getElementById('backupRpcUrl')?.value?.trim();
        const contractAddr = document.getElementById('configContractAddress')?.value?.trim();

        try {
            const items = [];
            if (mainRpc) items.push({key: 'rpc_url', value: mainRpc});
            if (backupRpc) items.push({key: 'backup_rpc_url', value: backupRpc});
            if (contractAddr) items.push({key: 'contract_address', value: contractAddr});

            if (items.length === 0) {
                FWUI.Toast.warning('没有需要保存的配置');
                return;
            }

            await this.apiRequest('/api/admin/config/batch', 'POST', {
                items: items,
                admin_address: this.adminAddress
            });
            FWUI.Toast.success('RPC 配置已保存');
        } catch (e) {
            FWUI.Toast.error('保存失败: ' + e.message);
        }
    },

    // 加载 RPC 配置到表单
    _applyRpcConfigToForm() {
        this.apiRequest('/api/admin/config/rpc-config').then(data => {
            if (!data) return;
            const mainRpcEl = document.getElementById('mainRpcUrl');
            const backupRpcEl = document.getElementById('backupRpcUrl');
            const contractEl = document.getElementById('configContractAddress');
            if (mainRpcEl && data.rpc_url) mainRpcEl.value = data.rpc_url;
            if (backupRpcEl && data.backup_rpc_url) backupRpcEl.value = data.backup_rpc_url;
            if (contractEl && data.contract_address) contractEl.value = data.contract_address;
        }).catch(() => {
        });
    },

    // 保存环境配置
    async saveEnvConfig() {
        const getVal = (id) => {
            const el = document.getElementById(id);
            return el && el.value.trim() !== '' ? el.value.trim() : null;
        };
        const host = getVal('envHost');
        const port = getVal('envPort');
        const redisUrl = getVal('envRedisUrl');
        const debug = getVal('envDebug');

        try {
            const items = [];
            if (host) items.push({key: 'env_host', value: host});
            if (port) items.push({key: 'env_port', value: port});
            if (redisUrl) items.push({key: 'env_redis_url', value: redisUrl});
            if (debug != null) items.push({key: 'env_debug', value: debug});

            await this.apiRequest('/api/admin/config/batch', 'POST', {
                items: items,
                admin_address: this.adminAddress
            });
            FWUI.Toast.success('环境配置已保存（服务重启后生效）');
        } catch (e) {
            FWUI.Toast.error('保存失败: ' + e.message);
        }
    },

    // 重新加载环境配置
    async reloadEnv() {
        try {
            const result = await this.apiRequest('/api/admin/config/reload-env', 'POST', {});
            FWUI.Toast.success(result.message || '环境配置已重新加载');
            this._applyEnvConfigToForm();
        } catch (e) {
            FWUI.Toast.error('重新加载失败: ' + e.message);
        }
    },

    // 加载环境配置到表单
    _applyEnvConfigToForm() {
        this.apiRequest('/api/admin/config/env-config').then(data => {
            if (!data) return;
            const hostEl = document.getElementById('envHost');
            const portEl = document.getElementById('envPort');
            const redisEl = document.getElementById('envRedisUrl');
            const debugEl = document.getElementById('envDebug');
            if (hostEl && data.host) hostEl.value = data.host;
            if (portEl && data.port) portEl.value = data.port;
            if (redisEl && data.redis_url) redisEl.value = data.redis_url;
            if (debugEl && data.debug != null) debugEl.value = data.debug;
        }).catch(() => {
        });
    },

    // ==================== 代币信息 & 钱包引导 ====================

    // 从后端加载代币信息并填充显示
    async loadTokenInfo() {
        try {
            const data = await this.apiRequest('/api/ext/chain-config');
            if (!data) return;

            const rpcUrl = data.rpc_url || '';
            const chainId = data.chain_id || '';
            const nativeSymbol = data.native_currency?.symbol || CONFIG.getNativeSymbol();
            const nativeName = data.native_currency?.name || CONFIG.getNativeName();
            const nativeDecimals = data.native_currency?.decimals || 18;
            const usdcAddress = data.settlement_token?.address || '';
            const networkName = data.network_name || 'ChainRPS Local';

            const setText = (id, text) => {
                const el = document.getElementById(id);
                if (el) el.textContent = text || '-';
            };

            // 填充【充值原生代币】面板引导卡片
            setText('fundGuideNativeSymbol', nativeSymbol);
            setText('fundGuideSymbol', nativeSymbol);
            setText('fundGuideRpcUrl', rpcUrl);
            setText('fundGuideChainId', chainId);
            const fundSymEl = document.getElementById('fundNativeSymbol');
            if (fundSymEl) fundSymEl.textContent = nativeSymbol;

            // 填充【充值 USDC】面板引导卡片
            const fundUsdcEl = document.getElementById('fundGuideUsdcAddress');
            if (fundUsdcEl) {
                fundUsdcEl.textContent = usdcAddress || '未部署';
                fundUsdcEl.setAttribute('onclick',
                    `AdminApp.copyToClipboard('${usdcAddress}')`);
            }
            setText('fundTokenGuideRpcUrl', rpcUrl);
            setText('fundTokenGuideChainId', chainId);

            // 缓存代币信息供钱包添加使用
            this._tokenInfo = {
                nativeSymbol,
                nativeName,
                nativeDecimals,
                usdcAddress,
                chainId,
                rpcUrl,
                networkName,
            };
        } catch (e) {
            console.warn('加载代币信息失败:', e);
        }
    },

    // 复制文本到剪贴板
    copyToClipboard(text) {
        if (!text || text === '-') {
            FWUI.Toast.warning('没有可复制的内容');
            return;
        }
        try {
            navigator.clipboard.writeText(text).then(() => {
                FWUI.Toast.success('已复制到剪贴板');
            }).catch(() => {
                // 降级方案
                const ta = document.createElement('textarea');
                ta.value = text;
                ta.style.position = 'fixed';
                ta.style.opacity = '0';
                document.body.appendChild(ta);
                ta.select();
                document.execCommand('copy');
                document.body.removeChild(ta);
                FWUI.Toast.success('已复制到剪贴板');
            });
        } catch (e) {
            FWUI.Toast.error('复制失败: ' + e.message);
        }
    },

    // 查看 Bot 配置
    async viewBotConfig() {
        try {
            const config = await this.apiRequest('/api/bot/config');
            if (!config) {
                FWUI.Modal.alert({
                    title: 'Bot 配置',
                    content: '<p style="color:var(--text-tertiary);">无法获取 Bot 配置信息</p>'
                });
                return;
            }

            const formatConfig = (data) => {
                return Object.entries(data).map(([k, v]) => {
                    let displayVal = v;
                    if (typeof v === 'boolean') displayVal = v ? '✅ 是' : '❌ 否';
                    else if (v === null || v === undefined) displayVal = '-';
                    else if (typeof v === 'object') displayVal = JSON.stringify(v);
                    return `<div style="display:flex;justify-content:space-between;padding:6px 0;border-bottom:1px solid var(--border-color);">
                        <span style="color:var(--text-secondary);">${k}</span>
                        <span style="color:var(--text-primary);font-family:monospace;font-size:12px;max-width:280px;word-break:break-all;text-align:right;">${displayVal}</span>
                    </div>`;
                }).join('');
            };

            FWUI.Modal.alert({
                title: '🤖 Bot 配置信息',
                content: `
                    <div style="max-height:400px;overflow-y:auto;">
                        <div style="background:var(--bg-secondary);padding:10px;border-radius:6px;margin-bottom:10px;">
                            <div style="font-size:11px;color:var(--text-tertiary);">API URL</div>
                            <div style="font-family:monospace;font-size:13px;color:var(--primary-color);cursor:pointer;" 
                                 onclick="AdminApp.copyToClipboard('/api/bot/config')" title="点击复制">/api/bot/config</div>
                        </div>
                        <div style="font-weight:600;margin-bottom:6px;">当前配置</div>
                        ${formatConfig(config)}
                    </div>
                `,
                okText: '关闭'
            });
        } catch (e) {
            console.error('获取 Bot 配置失败:', e);
            FWUI.Toast.error('获取 Bot 配置失败');
        }
    },

    // 添加原生币到钱包（直接尝试自动切换网络，失败则显示指引）
    async addNativeTokenToWallet() {
        if (!window.ethereum) {
            FWUI.Toast.warning('未检测到钱包插件，请先安装 MetaMask 或 OKX Wallet');
            return;
        }
        await this.switchToLocalNetwork();
    },

    // 添加 USDC 代币到钱包（自动优先，失败则引导手动操作）
    async addUsdcTokenToWallet() {
        if (!window.ethereum) {
            FWUI.Toast.warning('未检测到钱包插件，请先安装 MetaMask 或 OKX Wallet');
            return;
        }
        const info = this._tokenInfo || {};
        const usdcAddress = info.usdcAddress || '';

        if (!usdcAddress) {
            FWUI.Modal.alert({
                title: 'USDC 未部署',
                content: `
                    <div style="line-height:1.8;">
                        <p>当前本地链上 USDC 合约尚未部署。</p>
                        <p>请先在 <b>🪙 测试代币管理</b> 面板中部署 USDC 代币，或点击下方按钮重新部署。</p>
                        <div style="margin-top:12px;">
                            <button class="btn btn-primary" onclick="AdminApp.redeployUsdc()" style="width:100%;">
                                💰 重新部署 USDC
                            </button>
                        </div>
                    </div>
                `
            });
            return;
        }

        const decimals = 6;
        const symbol = 'USDC';

        const showUsdcManualGuide = (reason) => {
            FWUI.Modal.alert({
                title: '📖 手动添加 USDC 教程',
                content: `
                    <div style="line-height:1.9;">
                        ${reason ? `<div style="background:rgba(239,68,68,0.08);color:var(--warning-color);padding:8px 10px;border-radius:6px;font-size:12px;margin-bottom:10px;">${reason}</div>` : ''}
                        <div style="background:var(--bg-secondary);padding:12px;border-radius:8px;margin-bottom:12px;">
                            <div style="font-weight:600;margin-bottom:8px;">USDC 代币参数（点击复制）</div>
                            <div style="font-size:12px;font-family:monospace;line-height:2;">
                                <div>Symbol: ${symbol}</div>
                                <div>Decimals: ${decimals}</div>
                                <div>合约地址: <span style="cursor:pointer;color:var(--primary-color);word-break:break-all;" onclick="AdminApp.copyToClipboard('${usdcAddress}')" title="点击复制">${usdcAddress}</span></div>
                            </div>
                        </div>
                        <div style="font-weight:600;margin-bottom:6px;">操作步骤（MetaMask / OKX 通用）</div>
                        <div style="margin-bottom:8px;padding:8px 10px;background:var(--bg-card);border-radius:6px;border:1px solid var(--border-color);font-size:12px;">
                            <div style="font-weight:500;">1️⃣ 确保钱包已切换到 ChainRPS Local 网络</div>
                        </div>
                        <div style="margin-bottom:8px;padding:8px 10px;background:var(--bg-card);border-radius:6px;border:1px solid var(--border-color);font-size:12px;">
                            <div style="font-weight:500;">2️⃣ 钱包主界面 →「资产」Tab → 底部「添加自定义代币」</div>
                        </div>
                        <div style="margin-bottom:8px;padding:8px 10px;background:var(--bg-card);border-radius:6px;border:1px solid var(--border-color);font-size:12px;">
                            <div style="font-weight:500;">3️⃣ 粘贴上方合约地址 → 自动填充 Symbol/Decimals → 确认添加</div>
                        </div>
                        <div style="margin-top:10px;display:flex;gap:8px;">
                            <button class="btn btn-primary" onclick="AdminApp.copyToClipboard('${usdcAddress}')" style="flex:1;">📋 复制 USDC 地址</button>
                            <button class="btn btn-outline" onclick="AdminApp.switchToLocalNetwork()" style="flex:1;">🔗 添加 / 切换网络</button>
                        </div>
                    </div>
                `,
                okText: '我知道了'
            });
        };

        try {
            FWUI.Toast.info('正在添加 USDC 到钱包...');

            // 1. 先确保网络已就绪
            const netOk = await this.switchToLocalNetwork();
            if (!netOk) {
                FWUI.Toast.warning('请先完成网络切换，再添加 USDC');
                return;
            }

            // 2. 自动添加 USDC 代币
            try {
                await window.ethereum.request({
                    method: 'wallet_watchAsset',
                    params: [{
                        type: 'ERC20',
                        options: {
                            address: usdcAddress,
                            symbol: symbol,
                            decimals: decimals,
                            image: 'https://cryptologos.cc/logos/usd-coin-usdc-logo.png',
                        },
                    }]
                });
                FWUI.Toast.success('✅ USDC 已添加到钱包');
            } catch (e) {
                // 用户可能取消了，或者钱包不支持自动添加
                const errMsg = e.message || String(e);
                FWUI.Toast.warning('自动添加失败，请手动操作');
                showUsdcManualGuide(`钱包未完成自动添加（${errMsg}），请按以下步骤手动添加 USDC 代币。`);
            }
        } catch (e) {
            FWUI.Toast.error('添加代币失败: ' + (e.message || e));
            showUsdcManualGuide('发生错误，请按以下步骤手动添加 USDC 代币。');
        }
    },

    // 显示手动添加网络教程
    showManualNetworkGuide() {
        const info = this._tokenInfo || {};
        const symbol = info.nativeSymbol || CONFIG.getNativeSymbol();
        const name = info.nativeName || CONFIG.getNativeName();
        const rpcUrl = info.rpcUrl || '';
        const chainId = info.chainId || '';
        const networkName = info.networkName || 'ChainRPS Local';

        const steps = [
            { title: '1️⃣ 打开钱包', desc: '打开 MetaMask / OKX Wallet，确保已解锁' },
            { title: '2️⃣ 进入网络管理', desc: '点击顶部网络下拉框 → 选择「添加网络」或「自定义网络」' },
            { title: '3️⃣ 填写网络信息', desc: `按下方信息填写（点击字段可复制）` },
            { title: '4️⃣ 保存并切换', desc: '保存后钱包会自动切换到新网络，原生代币将自动显示' },
        ];

        FWUI.Modal.alert({
            title: '📖 手动添加网络教程',
            content: `
                <div style="line-height:1.9;">
                    <div style="background:var(--bg-secondary);padding:12px;border-radius:8px;margin-bottom:12px;">
                        <div style="font-weight:600;margin-bottom:8px;">网络参数（点击复制）</div>
                        <div style="font-size:12px;font-family:monospace;line-height:2;">
                            <div>Network Name: <span style="cursor:pointer;color:var(--primary-color);" onclick="AdminApp.copyToClipboard('${networkName}')">${networkName}</span></div>
                            <div>RPC URL: <span style="cursor:pointer;color:var(--primary-color);word-break:break-all;" onclick="AdminApp.copyToClipboard('${rpcUrl}')">${rpcUrl}</span></div>
                            <div>Chain ID: <span style="cursor:pointer;color:var(--primary-color);" onclick="AdminApp.copyToClipboard('${chainId}')">${chainId}</span></div>
                            <div>Symbol: <span style="cursor:pointer;color:var(--primary-color);" onclick="AdminApp.copyToClipboard('${symbol}')">${symbol}</span></div>
                            <div>Decimals: 18</div>
                        </div>
                    </div>
                    <div style="font-weight:600;margin-bottom:6px;">操作步骤</div>
                    ${steps.map(s => `
                        <div style="margin-bottom:8px;padding:8px 10px;background:var(--bg-card);border-radius:6px;border:1px solid var(--border-color);">
                            <div style="font-weight:500;font-size:13px;">${s.title}</div>
                            <div style="font-size:12px;color:var(--text-secondary);margin-top:2px;">${s.desc}</div>
                        </div>
                    `).join('')}
                    <div style="margin-top:10px;padding:8px 10px;background:rgba(16,185,129,0.08);border-radius:6px;font-size:12px;color:var(--text-primary);">
                        💡 添加成功后，钱包会默认显示 <b>${symbol}</b> 原生代币余额；其他代币需另行添加。
                    </div>
                </div>
            `
        });
    },

    // 显示手动添加 USDC 教程
    showManualUsdcGuide() {
        const info = this._tokenInfo || {};
        const usdcAddress = info.usdcAddress || '';

        if (!usdcAddress) {
            FWUI.Modal.alert({
                title: 'USDC 未部署',
                content: `
                    <div style="line-height:1.8;">
                        <p>当前本地链上 USDC 合约尚未部署。</p>
                        <p>请先在 <b>🪙 测试代币管理</b> 面板中部署 USDC 代币。</p>
                    </div>
                `
            });
            return;
        }

        const steps = [
            { title: '1️⃣ 添加网络', desc: `先确保钱包已添加 ChainRPS Local 网络（RPC: ${info.rpcUrl || '-'}）` },
            { title: '2️⃣ 打开资产页面', desc: '钱包主界面 → 点击「资产」Tab → 拉到最底部 → 点击「添加自定义代币」' },
            { title: '3️⃣ 填入合约地址', desc: `在「代币合约地址」处粘贴下方 USDC 合约地址（符号和小数位会自动填充）` },
            { title: '4️⃣ 确认添加', desc: '点击「添加」或「导入」，钱包资产列表将出现 USDC 代币' },
        ];

        FWUI.Modal.alert({
            title: '📖 手动添加 USDC 教程',
            content: `
                <div style="line-height:1.9;">
                    <div style="background:var(--bg-secondary);padding:12px;border-radius:8px;margin-bottom:12px;">
                        <div style="font-weight:600;margin-bottom:8px;">USDC 代币参数（点击复制）</div>
                        <div style="font-size:12px;font-family:monospace;line-height:2;">
                            <div>Symbol: USDC</div>
                            <div>Decimals: 6</div>
                            <div>合约地址: <span style="cursor:pointer;color:var(--primary-color);word-break:break-all;" onclick="AdminApp.copyToClipboard('${usdcAddress}')" title="点击复制">${usdcAddress}</span></div>
                        </div>
                    </div>
                    <div style="font-weight:600;margin-bottom:6px;">操作步骤</div>
                    ${steps.map(s => `
                        <div style="margin-bottom:8px;padding:8px 10px;background:var(--bg-card);border-radius:6px;border:1px solid var(--border-color);">
                            <div style="font-weight:500;font-size:13px;">${s.title}</div>
                            <div style="font-size:12px;color:var(--text-secondary);margin-top:2px;">${s.desc}</div>
                        </div>
                    `).join('')}
                    <div style="margin-top:10px;padding:8px 10px;background:rgba(99,102,241,0.08);border-radius:6px;font-size:12px;color:var(--text-primary);">
                        💡 部分钱包（如 OKX）可能需要先点击"添加代币"并手动选择网络，请确保已切到 ChainRPS Local 网络。
                    </div>
                    <div style="margin-top:10px;display:flex;gap:8px;">
                        <button class="btn btn-primary" onclick="AdminApp.copyToClipboard('${usdcAddress}')" style="flex:1;">📋 复制 USDC 地址</button>
                        <button class="btn btn-outline" onclick="AdminApp.switchToLocalNetwork()" style="flex:1;">🔗 添加 / 切换网络</button>
                    </div>
                </div>
            `
        });
    },
};

// DOM 加载完成后初始化管理后台
document.addEventListener('DOMContentLoaded', () => {
    AdminApp.init();
});