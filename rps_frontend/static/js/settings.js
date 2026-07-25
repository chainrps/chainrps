const Settings = (function() {
    let currentPreferences = null;

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

    function saveToStorage(address) {
        try {
            const key = 'rps_settings_' + (address || 'default');
            localStorage.setItem(key, JSON.stringify(currentPreferences));
            return true;
        } catch (e) {
            return false;
        }
    }

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

    function getPreferences() {
        return currentPreferences;
    }

    function setPreference(key, value) {
        if (currentPreferences) {
            currentPreferences[key] = value;
        }
    }

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

    function applyTheme(theme) {
        document.documentElement.setAttribute('data-theme', theme);
        localStorage.setItem('theme', theme);
        const toggle = document.getElementById('themeToggle');
        if (toggle) {
            toggle.querySelector('.theme-icon').textContent = theme === 'dark' ? '☀️' : '🌙';
        }
    }

    function isSoundEnabled() {
        return currentPreferences ? currentPreferences.sound_enabled !== false : true;
    }

    function isAutoReveal() {
        return currentPreferences ? currentPreferences.auto_reveal === true : false;
    }

    function getDefaultMode() {
        return currentPreferences ? currentPreferences.default_mode : 'A';
    }

    function getDefaultToken() {
        return currentPreferences ? currentPreferences.default_token : 'USDC';
    }

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
