const RPSCrypto = (function() {
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

    function verifyCommit(commit, choice, salt, address) {
        const computed = computeCommit(choice, salt, address);
        return computed.toLowerCase() === commit.toLowerCase();
    }

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

    function getChoiceName(choice) {
        return CHOICE_NAMES[choice] || '未知';
    }

    function getChoiceEmoji(choice) {
        return CHOICE_EMOJIS[choice] || '❓';
    }

    function getChoiceValue(name) {
        const upper = name.toUpperCase();
        return CHOICES[upper] || 0;
    }

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

    function clearSalt(gameId) {
        try {
            const key = `rps_salt_${gameId}`;
            localStorage.removeItem(key);
            return true;
        } catch (e) {
            return false;
        }
    }

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
