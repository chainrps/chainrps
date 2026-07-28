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

    // 渲染设置表单
    function renderSettingsForm() {
        if (!currentPreferences) return;

        const nicknameEl = document.getElementById('settingNickname');
        const themeEl = document.getElementById('settingTheme');
        const modeEl = document.getElementById('settingDefaultMode');
        const tokenEl = document.getElementById('settingDefaultToken');
        const timeoutEl = document.getElementById('settingTimeoutChoice');
        const notifEl = document.getElementById('settingNotifications');
        const soundEl = document.getElementById('settingSound');
        const autoRevealEl = document.getElementById('settingAutoReveal');

        if (nicknameEl) nicknameEl.value = currentPreferences.nickname || '';
        if (themeEl) themeEl.value = currentPreferences.theme || 'light';
        if (modeEl) modeEl.value = currentPreferences.default_mode || 'A';
        if (tokenEl) tokenEl.value = currentPreferences.default_token || 'USDC';
        if (timeoutEl) timeoutEl.value = currentPreferences.timeout_choice || 'random';
        if (notifEl) notifEl.checked = currentPreferences.notifications_enabled !== false;
        if (soundEl) soundEl.checked = currentPreferences.sound_enabled !== false;
        if (autoRevealEl) autoRevealEl.checked = currentPreferences.auto_reveal === true;

        // 网络与合约配置
        const serverIpEl = document.getElementById('settingServerIp');
        const serverPortEl = document.getElementById('settingServerPort');
        const contractAddrEl = document.getElementById('settingContractAddress');

        if (serverIpEl) serverIpEl.value = CONFIG.getServerIp();
        if (serverPortEl) serverPortEl.value = CONFIG.getServerPort();
        if (contractAddrEl) contractAddrEl.value = CONFIG.getContractAddress() || '';
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

        if (nicknameEl) prefs.nickname = nicknameEl.value;
        if (themeEl) prefs.theme = themeEl.value;
        if (modeEl) prefs.default_mode = modeEl.value;
        if (tokenEl) prefs.default_token = tokenEl.value;
        if (timeoutEl) prefs.timeout_choice = timeoutEl.value;
        if (notifEl) prefs.notifications_enabled = notifEl.checked;
        if (soundEl) prefs.sound_enabled = soundEl.checked;
        if (autoRevealEl) prefs.auto_reveal = autoRevealEl.checked;

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
                if (icon) icon.textContent = theme === 'dark' ? '☀️' : '🌙';
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
        getDefaultToken
    };
})();
