/**
 * 链上查询浏览器 - 独立公开页面脚本
 * 从 admin.js 迁移而来，无需管理员登录认证。
 * 依赖：config.js, ethers.umd.min.js, FWUI/toast.js
 */

const ExplorerApp = {
    _chainExplorerContract: null,
    _chainGamesPage: 1,
    _chainGamesPerPage: 20,
    _chainGameCount: 0,
    _contractList: [],
    _currentChainExplorerFeature: 'general',
    _txViewMode: null,
    _provider: null,
    _erc20Abi: [
        'function name() view returns (string)',
        'function symbol() view returns (string)',
        'function decimals() view returns (uint8)',
        'function balanceOf(address) view returns (uint256)',
        'function totalSupply() view returns (uint256)',
    ],

    // 公开版 API 请求（不带 JWT 认证）
    async apiRequest(path, method = 'GET', body = null) {
        const headers = {'Content-Type': 'application/json'};
        const res = await fetch(CONFIG.backendUrl + path, {
            method,
            headers,
            body: body ? JSON.stringify(body) : undefined
        });
        if (!res.ok) {
            let detail = '';
            try {
                const errBody = await res.json();
                detail = errBody.detail || errBody.message || '';
            } catch (_) {}
            const err = new Error(detail || `API error: ${res.status}`);
            err.status = res.status;
            throw err;
        }
        return res.json();
    },

    // 加载合约 ABI（从公开端点获取）
    async loadAbi() {
        // 从后端获取当前激活合约的 ABI
        try {
            const contracts = await this.apiRequest('/api/ext/contracts');
            const active = contracts.find(c => c.status === 'active') || contracts[0];
            if (active && active.abi) {
                return typeof active.abi === 'string' ? JSON.parse(active.abi) : active.abi;
            }
        } catch (e) {}
        // 回退到内置 ABI（公开页面可能未引入，使用空数组）
        return typeof ChainRPS_ABI !== 'undefined' ? ChainRPS_ABI : [];
    },

    // 初始化链浏览器功能选择器
    _initChainExplorerFeatureSelector() {
        const selector = document.getElementById('chainExplorerFeatureSelector');
        if (!selector) return;
        // 从 localStorage 恢复上次选择的功能
        let saved = 'general';
        try {
            saved = localStorage.getItem('rps_chain_explorer_feature') || 'general';
        } catch (e) { /* ignore */
        }
        if (selector.value !== saved) {
            selector.value = saved;
        }
        this.switchChainExplorerFeature(saved, true);
    },

    // 切换链浏览器功能面板显示
    switchChainExplorerFeature(feature, skipRefresh) {
        const validFeatures = ['general', 'contract'];
        const target = validFeatures.indexOf(feature) >= 0 ? feature : 'general';

        // 切换面板 active 状态
        validFeatures.forEach(f => {
            const panel = document.getElementById('chain-explorer-feature-' + f);
            if (panel) {
                panel.classList.toggle('active', f === target);
            }
        });

        // 同步下拉框值
        const selector = document.getElementById('chainExplorerFeatureSelector');
        if (selector && selector.value !== target) {
            selector.value = target;
        }

        // 持久化选择到 localStorage
        try {
            localStorage.setItem('rps_chain_explorer_feature', target);
        } catch (e) { /* ignore */
        }

        this._currentChainExplorerFeature = target;

        // 切换时按需刷新数据（初始化时跳过）
        if (skipRefresh) return;
        if (target === 'general') {
            this.explorerQueryLatest();
        }
    },

    // 使用当前激活的合约
    useActiveContract() {
        const addr = CONFIG.getContractAddress ? CONFIG.getContractAddress() : '';
        if (addr) {
            document.getElementById('explorerContractAddress').value = addr;
            this.queryContractOnChain();
        } else {
            FWUI.Toast.warning('当前未配置合约地址');
        }
    },

    // 显示合约下拉菜单
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
                const path = '/api/ext/contracts';
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
                    <div class="dropdown-item" onclick="ExplorerApp.selectContract('${addr}', '${name}')">
                        <span style="font-weight: 500;">${name}</span>
                        <span style="font-family: monospace; font-size: 12px; color: #475569; display: block;">
                            ${addr.slice(0, 10)}...${addr.slice(-8)}
                        </span>
                        <span style="font-size: 11px; color: #cbd5e1;">
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

    // 选择合约
    selectContract(address, name) {
        document.getElementById('explorerContractAddress').value = address;
        document.getElementById('contractDropdown').style.display = 'none';
        FWUI.Toast.info(`已选择合约: ${name}`);
    },

    // 获取链浏览器合约实例
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

    // 链上查询合约信息
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

    // 加载链上对局列表
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
            tbody.innerHTML = '<tr><td colspan="8" style="text-align:center; padding: 40px; color: #475569;">暂无对局</td></tr>';
            document.getElementById('chainGamesPagination').textContent = '共 0 局';
            return;
        }

        tbody.innerHTML = '<tr><td colspan="8" style="text-align:center; padding: 40px; color: #475569;">加载中...</td></tr>';

        const games = [];
        for (let id = startId; id >= endId; id--) {
            try {
                const g = await contract.games(id);
                games.push({id, ...g});
            } catch (e) {
                continue;
            }
        }

        const statusMap = ['等待中', '提交阶段', '揭示阶段', '已结束', '已取消'];

        tbody.innerHTML = games.map(g => {
            const statusIdx = Number(g[4] || g.status || 0);
            const statusText = statusMap[statusIdx] || '未知';
            const tokenAddr = (g[3] || g.token || '').toString().toLowerCase();
            const isNative = CONFIG.isNativeToken(tokenAddr);
            const tokenSymbol = isNative ? CONFIG.getNativeSymbol() : 'ERC20';
            const decimals = isNative ? 18 : 6;
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
                    <td><button class="btn btn-outline" style="padding: 2px 8px; font-size: 12px;" onclick="ExplorerApp.showGameDetail(${g.id})">详情</button></td>
                </tr>
            `;
        }).join('');

        document.getElementById('chainGamesPagination').textContent =
            `共 ${total} 局，当前第 ${page} 页 (ID: ${endId} ~ ${startId})`;

        document.getElementById('prevChainGamesBtn').disabled = page <= 1;
        document.getElementById('nextChainGamesBtn').disabled = startId <= 1 || total <= page * perPage;
    },

    // 上一页对局
    prevChainGamesPage() {
        if (this._chainGamesPage > 1) {
            this._chainGamesPage--;
            this.loadChainGames();
        }
    },

    // 下一页对局
    nextChainGamesPage() {
        const maxPage = Math.ceil(this._chainGameCount / this._chainGamesPerPage);
        if (this._chainGamesPage < maxPage) {
            this._chainGamesPage++;
            this.loadChainGames();
        }
    },

    // 按ID查询对局
    queryGameById() {
        const id = document.getElementById('queryGameId').value.trim();
        if (!id || isNaN(id)) {
            FWUI.Toast.warning('请输入有效的游戏ID');
            return;
        }
        this.showGameDetail(parseInt(id));
    },

    // 显示对局详情
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

            const isNative = CONFIG.isNativeToken(tokenAddr);
            const decimals = isNative ? 18 : 6;
            const tokenSymbol = isNative ? CONFIG.getNativeSymbol() : 'ERC20';
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
            } catch (e) {
            }

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
                    <div><strong>提交截止:</strong> ${commitDeadline ? new Date(Number(commitDeadline) * 1000).toLocaleString('zh-CN', {
                timeZone: 'Asia/Shanghai',
                hour12: false
            }) : '-'}</div>
                    <div><strong>揭示截止:</strong> ${revealDeadline ? new Date(Number(revealDeadline) * 1000).toLocaleString('zh-CN', {
                timeZone: 'Asia/Shanghai',
                hour12: false
            }) : '-'}</div>
                </div>
            `;

            document.getElementById('gameDetailContent').innerHTML = detailHtml;
            document.getElementById('gameDetailCard').style.display = 'block';
            document.getElementById('gameDetailCard').scrollIntoView({behavior: 'smooth', block: 'nearest'});
        } catch (e) {
            console.error('查询游戏详情失败:', e);
            FWUI.Toast.error('查询失败: ' + e.message);
        }
    },

    // 链浏览器查询（自动识别类型）
    async explorerSearch() {
        const input = document.getElementById('explorerQueryInput');
        const query = (input?.value || '').trim();
        const resultEl = document.getElementById('explorerResult');

        if (!query) {
            FWUI.Toast.warning('请输入查询内容');
            return;
        }

        resultEl.innerHTML = '<span style="color: var(--text-secondary);">⏳ 查询中...</span>';

        try {
            const result = await this.apiRequest('/api/ext/explorer/query/' + encodeURIComponent(query));

            if (!result.success) {
                resultEl.innerHTML = `<span style="color: var(--danger-color);">❌ ${result.message || '查询失败'}</span>`;
                return;
            }

            this._renderExplorerResult(result.type, result.data);
        } catch (e) {
            resultEl.innerHTML = `<span style="color: var(--danger-color);">❌ 查询失败: ${e.message}</span>`;
        }
    },

    // 查询最新区块
    async explorerQueryLatest() {
        const resultEl = document.getElementById('explorerResult');
        resultEl.innerHTML = '<span style="color: var(--text-secondary);">⏳ 查询中...</span>';

        try {
            const result = await this.apiRequest('/api/ext/explorer/latest-block');

            if (!result.success) {
                resultEl.innerHTML = `<span style="color: var(--danger-color);">❌ ${result.message || '查询失败'}</span>`;
                return;
            }

            // 显示最新区块号 + 区块详情
            const block = result.block;
            if (!block) {
                resultEl.innerHTML = `<span style="color: var(--text-secondary);">最新区块号: ${result.block_number}</span>`;
                return;
            }

            this._renderExplorerResult('block', block);
            // 同步填充输入框
            document.getElementById('explorerQueryInput').value = String(result.block_number);
        } catch (e) {
            resultEl.innerHTML = `<span style="color: var(--danger-color);">❌ 查询失败: ${e.message}</span>`;
        }
    },

    // 渲染链浏览器查询结果
    _renderExplorerResult(type, data) {
        const resultEl = document.getElementById('explorerResult');
        if (!data) {
            resultEl.innerHTML = '<span style="color: var(--text-secondary);">无数据</span>';
            return;
        }

        const formatTime = (ts) => {
            if (!ts) return '-';
            return new Date(ts * 1000).toLocaleString('zh-CN', {timeZone: 'Asia/Shanghai'}) + ' (UTC+8)';
        };
        const shortHash = (h) => h ? h.slice(0, 12) + '...' + h.slice(-8) : '-';
        const linkStyle = 'color: var(--primary-color); cursor: pointer; text-decoration: underline;';

        if (type === 'block') {
            const txList = (data.transactions || []).slice(0, 10).map(tx => {
                const txStr = typeof tx === 'string' ? tx : (tx.hash || String(tx));
                return `<span style="${linkStyle}" onclick="ExplorerApp._explorerQueryFill('${txStr}')" title="${txStr}">${shortHash(txStr)}</span>`;
            }).join('、') || '<span style="color: var(--text-secondary);">无交易</span>';

            resultEl.innerHTML = `
                <div style="display: grid; grid-template-columns: repeat(auto-fill, minmax(220px, 1fr)); gap: 8px;">
                    <div><strong>区块号:</strong> <span style="${linkStyle}" onclick="ExplorerApp._explorerQueryFill('${data.number}')">${data.number}</span></div>
                    <div><strong>区块哈希:</strong> <span title="${data.hash}">${shortHash(data.hash)}</span></div>
                    <div><strong>时间:</strong> ${formatTime(data.timestamp)}</div>
                    <div><strong>矿工:</strong> <span style="${linkStyle}" onclick="ExplorerApp._explorerQueryFill('${data.miner}')" title="${data.miner}">${data.miner ? data.miner.slice(0, 10) + '...' : '-'}</span></div>
                    <div><strong>交易数:</strong> ${data.tx_count}</div>
                    <div><strong>Gas 使用:</strong> ${data.gas_used} / ${data.gas_limit}</div>
                    <div><strong>大小:</strong> ${data.size} bytes</div>
                </div>
                <div style="margin-top: 10px; padding-top: 8px; border-top: 1px solid var(--border-color);">
                    <strong>交易列表:</strong> ${txList}
                    ${data.tx_count > 10 ? '<span style="color: var(--text-secondary);">（仅显示前10笔）</span>' : ''}
                </div>
            `;
        } else if (type === 'transaction') {
            const statusText = data.status === 1 ? '<span style="color: var(--success-color);">✅ 成功</span>' :
                data.status === 0 ? '<span style="color: var(--danger-color);">❌ 失败</span>' : '⏳ 待确认';
            const nativeSymbol = (typeof CONFIG !== 'undefined' && CONFIG.getNativeSymbol) ? CONFIG.getNativeSymbol() : 'POL';
            resultEl.innerHTML = `
                <div style="display: grid; grid-template-columns: repeat(auto-fill, minmax(220px, 1fr)); gap: 8px;">
                    <div style="grid-column: 1 / -1;"><strong>交易哈希:</strong> <span style="font-family:monospace;font-size:12px;word-break:break-all;cursor:pointer;color:var(--primary-color);" onclick="ExplorerApp.copyToClipboard('${data.hash}')" title="点击复制">${data.hash}</span></div>
                    <div><strong>状态:</strong> ${statusText}</div>
                    <div><strong>区块:</strong> <span style="${linkStyle}" onclick="ExplorerApp._explorerQueryFill('${data.block_number}')">${data.block_number}</span></div>
                    <div style="grid-column: 1 / -1;"><strong>发送方:</strong> <span style="font-family:monospace;font-size:12px;cursor:pointer;color:var(--primary-color);" onclick="ExplorerApp._explorerQueryFill('${data.from}')" title="点击查询 · 右键复制">${data.from}</span> <span style="cursor:pointer;font-size:11px;color:var(--text-secondary);" onclick="event.stopPropagation();ExplorerApp.copyToClipboard('${data.from}')" title="复制地址">📋</span></div>
                    <div style="grid-column: 1 / -1;"><strong>接收方:</strong> <span style="font-family:monospace;font-size:12px;cursor:pointer;color:var(--primary-color);" onclick="ExplorerApp._explorerQueryFill('${data.to}')" title="点击查询 · 右键复制">${data.to || '合约创建'}</span>${data.to ? ' <span style="cursor:pointer;font-size:11px;color:var(--text-secondary);" onclick="event.stopPropagation();ExplorerApp.copyToClipboard(\'' + data.to + '\')" title="复制地址">📋</span>' : ''}</div>
                    <div><strong>金额:</strong> ${data.value} ${nativeSymbol}</div>
                    <div><strong>Gas:</strong> ${data.gas} (实际 ${data.gas_used || '-'})</div>
                    <div><strong>Gas 价格:</strong> ${data.gas_price} gwei</div>
                    <div><strong>Nonce:</strong> ${data.nonce}</div>
                    ${data.input && data.input !== '0x' ? '<div style="grid-column: 1 / -1;"><strong>Input Data:</strong> <span style="font-family:monospace;font-size:11px;word-break:break-all;color:var(--text-secondary);">' + data.input + '</span></div>' : ''}
                    ${data.contract_address ? '<div><strong>合约地址:</strong> <span style="' + linkStyle + '" onclick="ExplorerApp._explorerQueryFill(\'' + data.contract_address + '\')" title="' + data.contract_address + '">' + data.contract_address + '</span> <span style="color: var(--success-color);">📋 合约部署</span></div>' : ''}
                </div>
            `;
        } else if (type === 'address') {
            const nativeSymbol = (typeof CONFIG !== 'undefined' && CONFIG.getNativeSymbol) ? CONFIG.getNativeSymbol() : 'POL';
            resultEl.innerHTML = `
                <div style="display: grid; grid-template-columns: repeat(auto-fill, minmax(220px, 1fr)); gap: 8px;">
                    <div><strong>地址:</strong> <span style="font-family:monospace;font-size:12px;word-break:break-all;cursor:pointer;color:var(--primary-color);" onclick="ExplorerApp.copyToClipboard('${data.address}')" title="点击复制完整地址">${data.address}</span></div>
                    <div><strong>余额:</strong> <span style="color: var(--success-color); font-weight: 600;">${data.balance} ${nativeSymbol}</span></div>
                    <div><strong>交易数:</strong> ${data.nonce}</div>
                    <div><strong>类型:</strong> ${data.is_contract ? '📄 合约 (code size: ' + data.code_size + ')' : '👤 普通账户'}</div>
                </div>
                <div id="explorerErc20Balances" style="margin-top: 12px;"></div>
                <div style="margin-top: 12px;">
                    <button class="btn btn-outline" onclick="ExplorerApp.explorerQueryAddressTxs('${data.address}')" title="扫描最近区块查询该地址的交易记录">📜 查看交易记录</button>
                </div>
                <div id="explorerAddressTxs" style="margin-top: 12px;"></div>
            `;
            this._loadErc20Balances(data.address);
        }
    },

    // 查询地址的交易记录
    async explorerQueryAddressTxs(address) {
        const txsContainer = document.getElementById('explorerAddressTxs');
        if (!txsContainer) return;
        txsContainer.innerHTML = '<span style="color: var(--text-secondary);">⏳ 正在扫描区块查询交易记录...</span>';

        try {
            const result = await this.apiRequest('/api/ext/explorer/address/' + encodeURIComponent(address) + '/transactions?scan_blocks=100&limit=50');

            if (!result.success) {
                txsContainer.innerHTML = `<span style="color: var(--danger-color);">❌ ${result.message || '查询失败'}</span>`;
                return;
            }

            const txs = result.transactions || [];
            if (txs.length === 0) {
                txsContainer.innerHTML = `<span style="color: var(--text-secondary);">📝 最近 ${result.scanned_to_block - result.scanned_from_block + 1} 个区块内未找到该地址的交易记录</span>`;
                return;
            }

            this._lastAddressTxsAddress = address;
            this._lastAddressTxsData = result;
            this._renderAddressTxs(address, result);
        } catch (e) {
            txsContainer.innerHTML = `<span style="color: var(--danger-color);">❌ 查询失败: ${e.message}</span>`;
        }
    },

    _renderAddressTxs(address, result) {
        const txsContainer = document.getElementById('explorerAddressTxs');
        if (!txsContainer) return;
        const txs = result.transactions || [];
        const nativeSymbol = (typeof CONFIG !== 'undefined' && CONFIG.getNativeSymbol) ? CONFIG.getNativeSymbol() : 'POL';
        const formatTime = (ts) => {
            if (!ts) return '-';
            return new Date(ts * 1000).toLocaleString('zh-CN', {timeZone: 'Asia/Shanghai'});
        };
        const linkStyle = 'color: var(--primary-color); cursor: pointer; text-decoration: underline;';
        const direction = (tx) => tx.from && tx.from.toLowerCase() === address.toLowerCase() ? '📤 发送' : '📥 接收';
        const viewMode = this._txViewMode || 'list';

        const viewToggle = `
            <div style="display:flex;align-items:center;gap:8px;margin-bottom:8px;">
                <span style="font-size:12px;color:var(--text-secondary);">共 ${result.count} 笔交易（区块 #${result.scanned_from_block} - #${result.scanned_to_block}）${result.truncated ? '· <span style="color:var(--warning-color);">已截断</span>' : ''}</span>
                <div style="margin-left:auto;display:flex;align-items:center;gap:4px;">
                    <label style="font-size:12px;color:var(--text-secondary);">视图:</label>
                    <select id="txViewModeSelector" onchange="ExplorerApp.switchTxViewMode(this.value)" style="padding:4px 8px;border:1px solid var(--border-color);border-radius:6px;font-size:12px;background:var(--input-bg);color:var(--text-primary);">
                        <option value="list" ${viewMode === 'list' ? 'selected' : ''}>📋 列表</option>
                        <option value="card" ${viewMode === 'card' ? 'selected' : ''}>🃏 卡片</option>
                    </select>
                </div>
            </div>
        `;

        if (viewMode === 'card') {
            const cards = txs.map(tx => {
                const dir = direction(tx);
                const isSend = dir.includes('发送');
                return `
                    <div style="background:var(--bg-card);border:1px solid var(--border-color);border-radius:10px;padding:14px;margin-bottom:10px;border-left:3px solid ${isSend ? 'var(--warning-color)' : 'var(--success-color)'};">
                        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;">
                            <span style="font-size:13px;font-weight:500;">${dir}</span>
                            <span style="font-size:11px;color:var(--text-secondary);">${formatTime(tx.timestamp)}</span>
                        </div>
                        <div style="font-size:12px;margin-bottom:4px;">
                            <strong>哈希:</strong> <span style="font-family:monospace;word-break:break-all;cursor:pointer;color:var(--primary-color);" onclick="ExplorerApp._explorerQueryFill('${tx.hash}')" title="点击查看详情">${tx.hash}</span>
                        </div>
                        <div style="font-size:12px;margin-bottom:4px;">
                            <strong>发送方:</strong> <span style="font-family:monospace;cursor:pointer;color:var(--primary-color);" onclick="ExplorerApp._explorerQueryFill('${tx.from}')" title="点击查询">${tx.from}</span>
                            <span style="cursor:pointer;font-size:11px;color:var(--text-secondary);" onclick="event.stopPropagation();ExplorerApp.copyToClipboard('${tx.from}')" title="复制">📋</span>
                        </div>
                        <div style="font-size:12px;margin-bottom:4px;">
                            <strong>接收方:</strong> <span style="font-family:monospace;cursor:pointer;color:var(--primary-color);" onclick="ExplorerApp._explorerQueryFill('${tx.to || ''}')" title="点击查询">${tx.to || '合约创建'}</span>
                            ${tx.to ? '<span style="cursor:pointer;font-size:11px;color:var(--text-secondary);" onclick="event.stopPropagation();ExplorerApp.copyToClipboard(\'' + tx.to + '\')" title="复制">📋</span>' : ''}
                        </div>
                        <div style="display:flex;justify-content:space-between;font-size:12px;">
                            <span><strong>金额:</strong> ${tx.value} ${nativeSymbol}</span>
                            <span><strong>区块:</strong> <span style="cursor:pointer;color:var(--primary-color);" onclick="ExplorerApp._explorerQueryFill('${tx.block_number}')">#${tx.block_number}</span></span>
                        </div>
                    </div>
                `;
            }).join('');
            txsContainer.innerHTML = viewToggle + cards;
        } else {
            const rows = txs.map(tx => {
                const dir = direction(tx);
                const isSend = dir.includes('发送');
                return `
                    <tr>
                        <td><span style="font-family:monospace;font-size:11px;word-break:break-all;cursor:pointer;color:var(--primary-color);" onclick="ExplorerApp._explorerQueryFill('${tx.hash}')" title="点击查看详情">${tx.hash.slice(0, 14)}...${tx.hash.slice(-6)}</span></td>
                        <td><span style="cursor:pointer;color:var(--primary-color);" onclick="ExplorerApp._explorerQueryFill('${tx.block_number}')">#${tx.block_number}</span></td>
                        <td style="font-size:11px;">${formatTime(tx.timestamp)}</td>
                        <td style="color:${isSend ? 'var(--warning-color)' : 'var(--success-color)'};font-weight:500;white-space:nowrap;">${dir}</td>
                        <td><span style="font-family:monospace;font-size:11px;cursor:pointer;color:var(--primary-color);" onclick="ExplorerApp._explorerQueryFill('${tx.from}')" title="${tx.from} · 点击查询">${tx.from}</span> <span style="cursor:pointer;font-size:10px;color:var(--text-secondary);" onclick="event.stopPropagation();ExplorerApp.copyToClipboard('${tx.from}')" title="复制">📋</span></td>
                        <td><span style="font-family:monospace;font-size:11px;cursor:pointer;color:var(--primary-color);" onclick="ExplorerApp._explorerQueryFill('${tx.to || ''}')" title="${tx.to || ''} · 点击查询">${tx.to || '合约创建'}</span>${tx.to ? ' <span style="cursor:pointer;font-size:10px;color:var(--text-secondary);" onclick="event.stopPropagation();ExplorerApp.copyToClipboard(\'' + tx.to + '\')" title="复制">📋</span>' : ''}</td>
                        <td style="white-space:nowrap;">${tx.value} ${nativeSymbol}</td>
                    </tr>
                `;
            }).join('');

            txsContainer.innerHTML = viewToggle + `
                <div style="overflow-x:auto;">
                    <table class="data-table" style="font-size: 12px;">
                        <thead><tr><th>交易哈希</th><th>区块</th><th>时间</th><th>方向</th><th>发送方</th><th>接收方</th><th>金额</th></tr></thead>
                        <tbody>${rows}</tbody>
                    </table>
                </div>
            `;
        }
    },

    async _loadErc20Balances(address) {
        const container = document.getElementById('explorerErc20Balances');
        if (!container) return;
        container.innerHTML = '<span style="color:var(--text-secondary);font-size:12px;">⏳ 查询 ERC20 代币余额...</span>';
        try {
            const balances = await this._getErc20Balances(address);
            if (balances.length === 0) {
                container.innerHTML = '';
                return;
            }
            const nativeSymbol = (typeof CONFIG !== 'undefined' && CONFIG.getNativeSymbol) ? CONFIG.getNativeSymbol() : 'POL';
            const cards = balances.map(b => `
                <div style="display:inline-flex;align-items:center;gap:6px;padding:6px 12px;background:var(--bg-secondary);border:1px solid var(--border-color);border-radius:8px;margin-right:8px;margin-bottom:6px;font-size:13px;">
                    <span style="font-weight:600;">${b.symbol}</span>
                    <span style="color:${b.error ? 'var(--text-secondary)' : 'var(--success-color)'};">${parseFloat(b.balance).toLocaleString(undefined, {maximumFractionDigits: 4})}</span>
                    <span style="font-size:10px;color:var(--text-secondary);cursor:pointer;" onclick="ExplorerApp.copyToClipboard('${b.address}')" title="复制合约地址">📋</span>
                </div>
            `).join('');
            container.innerHTML = `
                <div style="margin-bottom:4px;font-size:13px;font-weight:500;">💰 ERC20 代币余额</div>
                <div>${cards}</div>
            `;
        } catch (e) {
            container.innerHTML = `<span style="color:var(--text-secondary);font-size:12px;">ERC20 查询失败</span>`;
        }
    },

    // 填充查询框并自动查询
    _explorerQueryFill(value) {
        document.getElementById('explorerQueryInput').value = value;
        this.explorerSearch();
    },

    // 初始化（页面加载时调用）
    init() {
        this._initProvider();
        this._initTxViewMode();
        this._initChainExplorerFeatureSelector();
        this._syncChainConfig();
        if (this._currentChainExplorerFeature === 'general') {
            this.explorerQueryLatest();
        }
    },

    async _syncChainConfig() {
        try {
            const data = await this.apiRequest('/api/ext/chain-config');
            if (data && data.success) {
                if (data.settlement_token && data.settlement_token.address) {
                    CONFIG.setSettlementTokenAddress(data.settlement_token.address);
                }
                if (data.contract_address) {
                    CONFIG.setContractAddress(data.contract_address);
                }
            }
        } catch (e) {
            console.warn('ExplorerApp: 同步链配置失败', e);
        }
    },

    _initProvider() {
        try {
            const rpcUrl = (typeof CONFIG !== 'undefined' && CONFIG.getLocalRpcUrl)
                ? CONFIG.getLocalRpcUrl()
                : 'http://127.0.0.1:8686';
            this._provider = new ethers.JsonRpcProvider(rpcUrl);
        } catch (e) {
            console.warn('ExplorerApp: provider init failed', e);
        }
    },

    _initTxViewMode() {
        const saved = localStorage.getItem('rps_explorer_tx_view');
        if (saved) {
            this._txViewMode = saved;
        } else {
            this._txViewMode = window.innerWidth < 768 ? 'card' : 'list';
        }
        const selector = document.getElementById('txViewModeSelector');
        if (selector) selector.value = this._txViewMode;
    },

    switchTxViewMode(mode) {
        this._txViewMode = mode;
        localStorage.setItem('rps_explorer_tx_view', mode);
        const selector = document.getElementById('txViewModeSelector');
        if (selector) selector.value = mode;
        if (this._lastAddressTxsData) {
            this._renderAddressTxs(this._lastAddressTxsAddress, this._lastAddressTxsData);
        }
    },

    copyToClipboard(text) {
        navigator.clipboard.writeText(text).catch(() => {
            const textarea = document.createElement('textarea');
            textarea.value = text;
            document.body.appendChild(textarea);
            textarea.select();
            document.execCommand('copy');
            document.body.removeChild(textarea);
        });
        FWUI.Toast.success('已复制: ' + text.slice(0, 10) + '...');
    },

    async _getErc20Balances(address) {
        if (!this._provider) return [];
        let tokens = [];
        try {
            const resp = await this.apiRequest('/api/ext/tokens');
            if (resp && resp.success && resp.tokens) {
                tokens = resp.tokens.filter(t => t.address && t.address !== '0x0000000000000000000000000000000000000000');
            }
        } catch (e) {
            console.warn('从后端获取代币列表失败，回退到本地配置:', e);
        }
        if (tokens.length === 0) {
            const network = (typeof CONFIG !== 'undefined' && CONFIG.getCurrentNetwork) ? CONFIG.getCurrentNetwork() : null;
            const localTokens = network && network.supportedTokens ? network.supportedTokens : [];
            tokens = localTokens.filter(t => t.address && t.address !== '0x0000000000000000000000000000000000000000');
        }
        if (CONFIG._settlementTokenAddress) {
            const usdc = tokens.find(t => t.symbol === 'USDC');
            if (usdc) {
                usdc.address = CONFIG._settlementTokenAddress;
            }
        }
        const results = [];
        for (const token of tokens) {
            if (!token.address || token.address === '0x0000000000000000000000000000000000000000') continue;
            try {
                const contract = new ethers.Contract(token.address, this._erc20Abi, this._provider);
                const balance = await contract.balanceOf(address);
                const formatted = ethers.formatUnits(balance, token.decimals);
                results.push({
                    symbol: token.symbol,
                    name: token.name,
                    balance: formatted,
                    address: token.address,
                    decimals: token.decimals,
                });
            } catch (e) {
                results.push({symbol: token.symbol, name: token.name, balance: '0', address: token.address, decimals: token.decimals, error: true});
            }
        }
        return results;
    },
};

document.addEventListener('DOMContentLoaded', () => {
    ExplorerApp.init();
});