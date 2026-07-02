/**
 * 多语言支持
 */
const translations = {
    en: {
        connect_wallet: "Connect Wallet",
        address: "Address:",
        disconnect: "Disconnect",
        select_bet: "Select Bet Amount",
        find_opponent: "Find Opponent",
        matching: "Matching...",
        queue_position: "Queue Position:",
        cancel: "Cancel",
        game_id: "Game #",
        opponent: "Opponent:",
        bet: "Bet:",
        time_left: "Time Left:",
        commit_phase: "Commit Phase",
        reveal_phase: "Reveal Phase",
        result: "Result",
        your_choice: "Your Choice",
        rock: "Rock",
        paper: "Paper",
        scissors: "Scissors",
        commit_success: "✅ Commit submitted successfully!",
        waiting_opponent: "Waiting for opponent...",
        reveal_your_choice: "Reveal Your Choice",
        reveal: "Reveal",
        you: "You:",
        prize: "Prize:",
        refund: "Refund",
        rematch: "Rematch",
        new_game: "New Game",
        game_history: "Game History",
        coming_soon: "Coming Soon",
        private_room: "Private Room",
        leaderboard: "Leaderboard",
        tournament: "Tournament",
        nft_perks: "NFT Perks",
        phase2: "Phase 2",
        play: "Play",
        history: "History",
        future: "Future",
        loading: "Loading...",
        error: "Error",
        close: "Close",
        win: "You Win!",
        loss: "You Lose",
        draw: "Draw",
        timeout_warning: "Time running out!",
        opponent_commit: "Opponent has submitted commit",
        opponent_reveal: "Opponent revealed choice",
        waiting_reveal: "Waiting for reveal phase...",
        select_choice: "Please select your choice first",
        connect_first: "Please connect wallet first",
        enter_amount: "Please enter bet amount",
        insufficient_balance: "Insufficient balance",
        approve_token: "Approving token...",
        submitting: "Submitting...",
        revealing: "Revealing...",
        no_games: "No games yet",
        game_cancelled: "Game cancelled",
        network_error: "Network error, please try again",
        wallet_not_supported: "Wallet not supported",
    },
    zh: {
        connect_wallet: "连接钱包",
        address: "地址:",
        disconnect: "断开连接",
        select_bet: "选择下注金额",
        find_opponent: "寻找对手",
        matching: "匹配中...",
        queue_position: "队列位置:",
        cancel: "取消",
        game_id: "对局 #",
        opponent: "对手:",
        bet: "下注:",
        time_left: "剩余时间:",
        commit_phase: "提交阶段",
        reveal_phase: "揭晓阶段",
        result: "结果",
        your_choice: "你的选择",
        rock: "石头",
        paper: "布",
        scissors: "剪刀",
        commit_success: "✅ 已成功提交承诺!",
        waiting_opponent: "等待对手...",
        reveal_your_choice: "揭晓你的选择",
        reveal: "揭晓",
        you: "你:",
        prize: "奖金:",
        refund: "退款",
        rematch: "重新对战",
        new_game: "新游戏",
        game_history: "对局历史",
        coming_soon: "即将推出",
        private_room: "私人房间",
        leaderboard: "排行榜",
        tournament: "锦标赛",
        nft_perks: "NFT权益",
        phase2: "二期",
        play: "游戏",
        history: "历史",
        future: "未来",
        loading: "加载中...",
        error: "错误",
        close: "关闭",
        win: "你赢了!",
        loss: "你输了",
        draw: "平局",
        timeout_warning: "时间即将耗尽!",
        opponent_commit: "对手已提交承诺",
        opponent_reveal: "对手已揭晓选择",
        waiting_reveal: "等待揭晓阶段...",
        select_choice: "请先选择你的出拳",
        connect_first: "请先连接钱包",
        enter_amount: "请输入下注金额",
        insufficient_balance: "余额不足",
        approve_token: "正在授权代币...",
        submitting: "提交中...",
        revealing: "揭晓中...",
        no_games: "暂无对局记录",
        game_cancelled: "对局已取消",
        network_error: "网络错误，请重试",
        wallet_not_supported: "不支持的钱包",
    }
};

class I18n {
    constructor() {
        this.currentLang = 'en';
        this.translations = translations;
    }

    setLanguage(lang) {
        this.currentLang = lang;
        this.updateAllTexts();
    }

    get(key) {
        return this.translations[this.currentLang][key] || key;
    }

    updateAllTexts() {
        document.querySelectorAll('[data-i18n]').forEach(el => {
            const key = el.getAttribute('data-i18n');
            el.textContent = this.get(key);
        });
    }
}

const i18n = new I18n();