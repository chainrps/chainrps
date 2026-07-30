// 用户设置模块
const Settings = (function() {
    let currentPreferences = null;

    // 从服务器加载用户配置
    async function loadFromServer(address) {
        if (!address) return null;
        try {
            const res = await fetch(CONFIG.backendUrl + `/api/user/profile/${address}`);
            if (res.ok) {
                currentPreferences = await res.json();
                return currentPreferences;
            }
        } catch (e) {
            console.warn('加载用户配置失败:', e);
        }
        return loadFromStorage(address);
    }

    // 从本地存储加载用户配置
    function loadFromStorage(address) {
        try {
            const key = 'rps_settings_' + (address || 'default');
            const data = localStorage.getItem(key);
            if (data) {
                currentPreferences = JSON.parse(data);
                return currentPreferences;
            }
        } catch (e) {}
        currentPreferences = {
            nickname: '',
            theme: 'light',
            default_mode: 'A',
            default_token: 'USDC',
            signature_mode: 'A',
            notifications_enabled: true,
            sound_enabled: true,
            auto_reveal: false,
            timeout_choice: 'random'
        };
        return currentPreferences;
    }

    // 保存配置到本地存储
    function saveToStorage(address) {
        try {
            const key = 'rps_settings_' + (address || 'default');
            localStorage.setItem(key, JSON.stringify(currentPreferences));
            return true;
        } catch (e) {
            return false;
        }
    }

    // 保存配置到服务器
    async function saveToServer(address) {
        if (!address) return false;
        try {
            const res = await fetch(CONFIG.backendUrl + `/api/user/profile/${address}`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(currentPreferences)
            });
            return res.ok;
        } catch (e) {
            console.warn('保存配置到服务器失败:', e);
            return false;
        }
    }

    // 获取当前用户配置
    function getPreferences() {
        return currentPreferences;
    }

    // 设置单个配置项
    function setPreference(key, value) {
        if (currentPreferences) {
            currentPreferences[key] = value;
        }
    }

    // 根据当前网络重新填充默认代币下拉选项
    // 不同网络支持的代币不同（如 Polygon 主网含 POL/USDC，Amoy 含 USDC），
    // 避免出现当前网络不支持的代币仍显示在下拉中。
    function populateTokenOptions() {
        const tokenEl = document.getElementById('settingDefaultToken');
        if (!tokenEl || typeof CONFIG === 'undefined') return;

        const tokens = CONFIG.getSupportedTokens();
        const currentSel = (currentPreferences && currentPreferences.default_token) || 'USDC';

        tokenEl.innerHTML = '';
        tokens.forEach(t => {
            const opt = document.createElement('option');
            opt.value = t.symbol;
            opt.textContent = t.symbol;
            tokenEl.appendChild(opt);
        });

        // 若用户已保存的代币在当前网络支持列表中则选中它，否则回退到该网络默认代币（首个）
        const exists = tokens.some(t => t.symbol === currentSel);
        tokenEl.value = exists ? currentSel : (tokens.length > 0 ? tokens[0].symbol : 'USDC');
    }

    // 渲染设置表单
    function renderSettingsForm() {
        if (!currentPreferences) return;

        const nicknameEl = document.getElementById('settingNickname');
        const themeEl = document.getElementById('settingTheme');
        const modeEl = document.getElementById('settingDefaultMode');
        const timeoutEl = document.getElementById('settingTimeoutChoice');
        const notifEl = document.getElementById('settingNotifications');
        const soundEl = document.getElementById('settingSound');
        const autoRevealEl = document.getElementById('settingAutoReveal');

        if (nicknameEl) nicknameEl.value = currentPreferences.nickname || '';
        if (themeEl) themeEl.value = currentPreferences.theme || 'light';
        if (modeEl) modeEl.value = currentPreferences.default_mode || 'A';
        if (timeoutEl) timeoutEl.value = currentPreferences.timeout_choice || 'random';
        if (notifEl) notifEl.checked = currentPreferences.notifications_enabled !== false;
        if (soundEl) soundEl.checked = currentPreferences.sound_enabled !== false;
        if (autoRevealEl) autoRevealEl.checked = currentPreferences.auto_reveal === true;

        // 默认代币下拉：按当前网络过滤可选代币
        populateTokenOptions();

        // 网络与合约配置
        const serverIpEl = document.getElementById('settingServerIp');
        const serverPortEl = document.getElementById('settingServerPort');
        const contractAddrEl = document.getElementById('settingContractAddress');

        if (serverIpEl) serverIpEl.value = CONFIG.getServerIp();
        if (serverPortEl) serverPortEl.value = CONFIG.getServerPort();
        if (contractAddrEl) contractAddrEl.value = CONFIG.getContractAddress() || '';

        // 渲染签名模式（A/B）相关 UI
        renderSignatureModeSection();
    }

    // 从表单收集配置数据
    function collectFromForm() {
        const prefs = {};

        const nicknameEl = document.getElementById('settingNickname');
        const themeEl = document.getElementById('settingTheme');
        const modeEl = document.getElementById('settingDefaultMode');
        const tokenEl = document.getElementById('settingDefaultToken');
        const timeoutEl = document.getElementById('settingTimeoutChoice');
        const notifEl = document.getElementById('settingNotifications');
        const soundEl = document.getElementById('settingSound');
        const autoRevealEl = document.getElementById('settingAutoReveal');
        const sigModeEl = document.getElementById('settingSignatureMode');

        if (nicknameEl) prefs.nickname = nicknameEl.value;
        if (themeEl) prefs.theme = themeEl.value;
        if (modeEl) prefs.default_mode = modeEl.value;
        if (tokenEl) prefs.default_token = tokenEl.value;
        if (timeoutEl) prefs.timeout_choice = timeoutEl.value;
        if (notifEl) prefs.notifications_enabled = notifEl.checked;
        if (soundEl) prefs.sound_enabled = soundEl.checked;
        if (autoRevealEl) prefs.auto_reveal = autoRevealEl.checked;
        if (sigModeEl) prefs.signature_mode = sigModeEl.value;

        return prefs;
    }

    // 保存所有设置
    async function saveSettings(address) {
        const newPrefs = collectFromForm();
        currentPreferences = { ...currentPreferences, ...newPrefs, address };

        saveToStorage(address);
        applyTheme(currentPreferences.theme);

        // 保存网络与合约配置
        const serverIpEl = document.getElementById('settingServerIp');
        const serverPortEl = document.getElementById('settingServerPort');
        const contractAddrEl = document.getElementById('settingContractAddress');

        if (serverIpEl && serverPortEl) {
            const ip = serverIpEl.value.trim() || '127.0.0.1';
            const port = serverPortEl.value.trim() || '8000';
            CONFIG.setServerAddress(ip, port);
        }

        if (contractAddrEl) {
            const contractAddr = contractAddrEl.value.trim();
            CONFIG.setContractAddress(contractAddr);
        }

        if (address) {
            await saveToServer(address);
        }

        return currentPreferences;
    }

    // 应用主题（统一委托给 UI.setTheme，避免两套实现互相覆盖）
    function applyTheme(theme) {
        if (typeof UI !== 'undefined' && UI && typeof UI.setTheme === 'function') {
            UI.setTheme(theme);
        } else {
            // 兜底：UI 模块未加载时直接操作 DOM
            document.documentElement.setAttribute('data-theme', theme);
            const toggle = document.getElementById('themeToggle');
            if (toggle) {
                const icon = toggle.querySelector('.theme-icon');
                if (icon) icon.textContent = theme === 'dark' ? '🌙' : '☀️';
            }
        }
        localStorage.setItem('rps_theme', theme);
    }

    // 检查音效是否启用
    function isSoundEnabled() {
        return currentPreferences ? currentPreferences.sound_enabled !== false : true;
    }

    // 检查是否自动揭晓
    function isAutoReveal() {
        return currentPreferences ? currentPreferences.auto_reveal === true : false;
    }

    // 获取默认游戏模式
    function getDefaultMode() {
        return currentPreferences ? currentPreferences.default_mode : 'A';
    }

    // 获取默认代币
    function getDefaultToken() {
        return currentPreferences ? currentPreferences.default_token : 'USDC';
    }

    // ==================== F1-06：A/B 签名模式切换 ====================
    // localStorage 键：持久化用户选择的签名模式（A=单次签名 / B=7天零签名）
    const SIGNATURE_MODE_KEY = 'rps_signature_mode';
    // relayer 7 天授权时长（秒），与合约 authorizeRelayer 默认值一致
    const RELAYER_DURATION_SECONDS = 7 * 24 * 3600;

    // 获取签名模式（'A' 或 'B'），默认 A
    function getSignatureMode() {
        const stored = localStorage.getItem(SIGNATURE_MODE_KEY);
        return stored === 'B' ? 'B' : 'A';
    }

    // 持久化签名模式到 localStorage
    function setSignatureMode(mode) {
        localStorage.setItem(SIGNATURE_MODE_KEY, mode === 'B' ? 'B' : 'A');
        if (currentPreferences) {
            currentPreferences.signature_mode = (mode === 'B' ? 'B' : 'A');
        }
    }

    // 渲染签名模式区域：根据当前模式显示/隐藏 B 模式状态区
    function renderSignatureModeSection() {
        const sigModeEl = document.getElementById('settingSignatureMode');
        const statusSection = document.getElementById('modeBStatusSection');
        if (sigModeEl) {
            sigModeEl.value = getSignatureMode();
        }
        if (!statusSection) return;

        const mode = getSignatureMode();
        if (mode === 'B') {
            statusSection.classList.remove('hidden');
            refreshRelayerAuthStatus();
        } else {
            statusSection.classList.add('hidden');
        }
    }

    // 查询链上 relayer 授权状态并刷新 UI（剩余天数等）
    async function refreshRelayerAuthStatus() {
        const contentEl = document.getElementById('modeBStatusContent');
        const revokeBtn = document.getElementById('revokeRelayerBtn');
        const authorizeBtn = document.getElementById('authorizeRelayerBtn');
        if (!contentEl) return;

        // 依赖 Contract 模块已初始化（合约地址已配置 + 钱包已连接）
        if (typeof Contract === 'undefined' || !Contract || !Contract.getContract) {
            contentEl.textContent = '⚠️ 合约未初始化，请先连接钱包并配置合约地址';
            if (revokeBtn) revokeBtn.disabled = true;
            if (authorizeBtn) authorizeBtn.disabled = true;
            return;
        }

        let address = null;
        try {
            address = (typeof Wallet !== 'undefined' && Wallet && Wallet.getAddress) ? Wallet.getAddress() : null;
        } catch (e) {}
        if (!address) {
            contentEl.textContent = '⚠️ 请先连接钱包';
            if (revokeBtn) revokeBtn.disabled = true;
            if (authorizeBtn) authorizeBtn.disabled = true;
            return;
        }

        contentEl.textContent = '查询中...';
        try {
            const auth = await Contract.getRelayerAuthorization(address);
            const now = Math.floor(Date.now() / 1000);
            if (auth.active && auth.deadline > now) {
                const remainSec = auth.deadline - now;
                const remainDays = Math.ceil(remainSec / 86400);
                const relayerShort = auth.relayer
                    ? auth.relayer.slice(0, 6) + '...' + auth.relayer.slice(-4)
                    : '未知';
                contentEl.innerHTML =
                    `✅ 已授权<br>` +
                    `<small>Relayer: ${relayerShort}</small><br>` +
                    `<small>剩余: ${remainDays} 天（${remainSec} 秒）</small>`;
                if (revokeBtn) revokeBtn.disabled = false;
                if (authorizeBtn) authorizeBtn.disabled = true;
            } else {
                contentEl.textContent = '❌ 未授权（点击下方按钮授权 7 天）';
                if (revokeBtn) revokeBtn.disabled = true;
                if (authorizeBtn) authorizeBtn.disabled = false;
            }
        } catch (e) {
            contentEl.textContent = '⚠️ 查询授权状态失败：' + (e.message || e);
            if (revokeBtn) revokeBtn.disabled = true;
            if (authorizeBtn) authorizeBtn.disabled = true;
        }
    }

    // 从后端获取 relayer 地址
    async function fetchRelayerAddress() {
        try {
            const res = await fetch(CONFIG.backendUrl + '/api/game/relayer/address');
            if (res.ok) {
                const data = await res.json();
                if (data.success && data.relayer_address) {
                    return data.relayer_address;
                }
            }
        } catch (e) {}
        return null;
    }

    // 授权 relayer（7 天）
    async function handleAuthorizeRelayer() {
        if (typeof Contract === 'undefined' || !Contract || !Contract.authorizeRelayer) {
            FWUI.Toast.error('合约未初始化');
            return;
        }
        const relayerAddr = await fetchRelayerAddress();
        if (!relayerAddr) {
            FWUI.Toast.error('无法获取 relayer 地址，请确认后端服务已配置 RELAYER_ADDRESS');
            return;
        }
        try {
            await Contract.authorizeRelayer(relayerAddr, RELAYER_DURATION_SECONDS);
            FWUI.Toast.success('已授权 relayer 7 天代操作');
            await refreshRelayerAuthStatus();
        } catch (e) {
            FWUI.Toast.error('授权失败：' + (e.message || e));
        }
    }

    // 撤销 relayer 授权
    async function handleRevokeRelayer() {
        if (typeof Contract === 'undefined' || !Contract || !Contract.revokeRelayer) {
            FWUI.Toast.error('合约未初始化');
            return;
        }
        try {
            await Contract.revokeRelayer();
            FWUI.Toast.success('已撤销 relayer 授权');
            await refreshRelayerAuthStatus();
        } catch (e) {
            FWUI.Toast.error('撤销失败：' + (e.message || e));
        }
    }

    // 初始化签名模式相关事件监听（由 app.js 初始化时调用一次）
    let signatureModeEventsBound = false;
    function initSignatureModeEvents() {
        if (signatureModeEventsBound) return;
        signatureModeEventsBound = true;

        const sigModeEl = document.getElementById('settingSignatureMode');
        if (sigModeEl) {
            sigModeEl.addEventListener('change', (e) => {
                const mode = e.target.value === 'B' ? 'B' : 'A';
                setSignatureMode(mode);
                renderSignatureModeSection();
            });
        }

        const authorizeBtn = document.getElementById('authorizeRelayerBtn');
        if (authorizeBtn) {
            authorizeBtn.addEventListener('click', handleAuthorizeRelayer);
        }
        const revokeBtn = document.getElementById('revokeRelayerBtn');
        if (revokeBtn) {
            revokeBtn.addEventListener('click', handleRevokeRelayer);
        }
    }

    // 返回设置相关函数
    return {
        loadFromServer,
        loadFromStorage,
        saveToStorage,
        saveToServer,
        saveSettings,
        getPreferences,
        setPreference,
        renderSettingsForm,
        applyTheme,
        isSoundEnabled,
        isAutoReveal,
        getDefaultMode,
        getDefaultToken,
        // F1-06：A/B 签名模式
        getSignatureMode,
        setSignatureMode,
        renderSignatureModeSection,
        refreshRelayerAuthStatus,
        initSignatureModeEvents
    };
})();
