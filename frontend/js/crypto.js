/**
 * 哈希承诺加密工具
 * 使用 keccak256 哈希算法
 */

class CryptoUtils {
    /**
     * 生成随机盐值 (uint256)
     */
    generateSalt() {
        // 使用 crypto API 或 ethers.js 生成随机数
        const array = new Uint32Array(8);
        crypto.getRandomValues(array);
        
        // 组合成 uint256 (64位十六进制)
        let salt = '0x';
        for (let i = 0; i < 8; i++) {
            salt += array[i].toString(16).padStart(8, '0');
        }
        
        return salt;
    }

    /**
     * 计算哈希承诺
     * @param {number} choice - 出拳选择 (1=石头, 2=布, 3=剪刀)
     * @param {string} salt - 盐值 (uint256)
     * @param {string} address - 玩家地址
     * @returns {string} keccak256 哈希值
     */
    computeCommit(choice, salt, address) {
        // keccak256(abi.encodePacked(choice, salt, address))
        // 使用 ethers.js 的 solidityPackedKeccak256
        const encoded = ethers.solidityPackedKeccak256(
            ['uint256', 'uint256', 'address'],
            [choice, salt, address]
        );
        return encoded;
    }

    /**
     * 验证哈希承诺
     * @param {string} commit - 原始哈希
     * @param {number} choice - 出拳选择
     * @param {string} salt - 盐值
     * @param {string} address - 玩家地址
     * @returns {boolean} 是否匹配
     */
    verifyCommit(commit, choice, salt, address) {
        const computed = this.computeCommit(choice, salt, address);
        return computed.toLowerCase() === commit.toLowerCase();
    }

    /**
     * 将出拳字符串转换为数字
     * @param {string} choiceStr - "rock", "paper", "scissors"
     * @returns {number} 1, 2, 3
     */
    choiceToNumber(choiceStr) {
        switch (choiceStr) {
            case 'rock': return 1;
            case 'paper': return 2;
            case 'scissors': return 3;
            default: return 0;
        }
    }

    /**
     * 将数字转换为出拳字符串
     * @param {number} choiceNum - 1, 2, 3
     * @returns {string} "rock", "paper", "scissors"
     */
    numberToChoice(choiceNum) {
        switch (choiceNum) {
            case 1: return 'rock';
            case 2: return 'paper';
            case 3: return 'scissors';
            default: return 'none';
        }
    }

    /**
     * 存储本轮对局的加密信息（用于后续揭晓）
     */
    storeGameSecrets(gameId, choice, salt) {
        const secrets = JSON.parse(localStorage.getItem('rps_secrets') || '{}');
        secrets[gameId] = {
            choice: choice,
            salt: salt,
            timestamp: Date.now()
        };
        localStorage.setItem('rps_secrets', JSON.stringify(secrets));
    }

    /**
     * 获取对局的加密信息
     */
    getGameSecrets(gameId) {
        const secrets = JSON.parse(localStorage.getItem('rps_secrets') || '{}');
        return secrets[gameId] || null;
    }

    /**
     * 清除对局的加密信息
     */
    clearGameSecrets(gameId) {
        const secrets = JSON.parse(localStorage.getItem('rps_secrets') || '{}');
        delete secrets[gameId];
        localStorage.setItem('rps_secrets', JSON.stringify(secrets));
    }
}

const cryptoUtils = new CryptoUtils();