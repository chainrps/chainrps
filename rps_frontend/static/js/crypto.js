
// 加密工具模块
const RPSCrypto = (function() {
    // 出拳选项常量
    const CHOICES = {
        ROCK: 1,
        PAPER: 2,
        SCISSORS: 3
    };

    const CHOICE_NAMES = {
        1: '石头',
        2: '布',
        3: '剪刀'
    };

    const CHOICE_EMOJIS = {
        1: '✊',
        2: '✋',
        3: '✌️'
    };

    // 生成随机盐值
    function generateSalt() {
        if (typeof window.crypto !== 'undefined' && window.crypto.getRandomValues) {
            const array = new Uint8Array(32);
            window.crypto.getRandomValues(array);
            return '0x' + Array.from(array).map(b => b.toString(16).padStart(2, '0')).join('');
        } else if (typeof ethers !== 'undefined') {
            return ethers.hexlify(ethers.randomBytes(32));
        } else {
            const chars = '0123456789abcdef';
            let salt = '0x';
            for (let i = 0; i < 64; i++) {
                salt += chars[Math.floor(Math.random() * 16)];
            }
            return salt;
        }
    }

    // 计算出拳承诺哈希
    function computeCommit(choice, salt, address) {
        if (typeof ethers === 'undefined') {
            throw new Error('ethers.js 未加载');
        }

        if (typeof choice === 'string') {
            choice = CHOICES[choice.toUpperCase()];
        }

        if (!choice || choice < 1 || choice > 3) {
            throw new Error('无效的出拳选择');
        }

        if (!salt || !salt.startsWith('0x')) {
            throw new Error('无效的盐值');
        }

        if (!address || !address.startsWith('0x')) {
            throw new Error('无效的地址');
        }

        return ethers.solidityPackedKeccak256(
            ['uint8', 'bytes32', 'address'],
            [choice, salt, address]
        );
    }

    // 验证承诺哈希
    function verifyCommit(commit, choice, salt, address) {
        const computed = computeCommit(choice, salt, address);
        return computed.toLowerCase() === commit.toLowerCase();
    }

    // 确定获胜者
    function determineWinner(choice1, choice2) {
        if (choice1 === choice2) {
            return 0;
        }

        if (
            (choice1 === 1 && choice2 === 3) ||
            (choice1 === 2 && choice2 === 1) ||
            (choice1 === 3 && choice2 === 2)
        ) {
            return 1;
        }

        return 2;
    }

    // 获取出拳名称
    function getChoiceName(choice) {
        return CHOICE_NAMES[choice] || '未知';
    }

    // 获取出拳表情符号
    function getChoiceEmoji(choice) {
        return CHOICE_EMOJIS[choice] || '❓';
    }

    // 根据名称获取出拳值
    function getChoiceValue(name) {
        const upper = name.toUpperCase();
        return CHOICES[upper] || 0;
    }

    // 存储盐值到本地存储
    function storeSalt(gameId, salt, choice) {
        try {
            const key = `rps_salt_${gameId}`;
            const data = {
                salt,
                choice,
                timestamp: Date.now()
            };
            localStorage.setItem(key, JSON.stringify(data));
            return true;
        } catch (e) {
            return false;
        }
    }

    // 从本地存储获取盐值
    function getSalt(gameId) {
        try {
            const key = `rps_salt_${gameId}`;
            const data = localStorage.getItem(key);
            if (data) {
                return JSON.parse(data);
            }
            return null;
        } catch (e) {
            return null;
        }
    }

    // 清除本地存储中的盐值
    function clearSalt(gameId) {
        try {
            const key = `rps_salt_${gameId}`;
            localStorage.removeItem(key);
            return true;
        } catch (e) {
            return false;
        }
    }

    // 返回加密工具函数
    return {
        CHOICES,
        CHOICE_NAMES,
        CHOICE_EMOJIS,
        generateSalt,
        computeCommit,
        verifyCommit,
        determineWinner,
        getChoiceName,
        getChoiceEmoji,
        getChoiceValue,
        storeSalt,
        getSalt,
        clearSalt
    };
})();