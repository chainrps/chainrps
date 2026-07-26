// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/utils/Pausable.sol";

/**
 * @title chainrps
 * @notice 链上公平猜拳游戏 - 基于哈希承诺的石头剪刀布
 * @dev 使用 keccak256 哈希承诺机制确保出拳公平性
 *      防仿标识：官方开发者地址、部署时间戳、版本号硬编码
 *
 *      锁定机制（v1.1.0 引入）：
 *      - 平台锁定（假锁定）：Waiting 与 CommitPhase（双方都未提交 commit）状态，
 *        用户可自主撤销退款；
 *      - 真正锁定：任一方提交 commit 后进入 RevealPhase，资金真正锁定，
 *        任何人（含 Owner）都无权撤销或全额退款。
 *
 *      超时机制（v1.1.0 调整）：
 *      - 提交/揭晓阶段默认 5 分钟超时；
 *      - 超时后无论双方都未操作或仅一方操作，统一全额退款，不判超时方负。
 *
 *      平局机制：零手续费，原路退回。
 */
// 链上公平猜拳游戏合约 - 基于哈希承诺的石头剪刀布
contract chainrps is Ownable, ReentrancyGuard, Pausable {
    // ==================== 常量与防仿标识 ====================

    // 版本号
    string public constant VERSION = "v1.1.0";
    // 合约部署时间戳
    uint256 public immutable deployTimestamp;
    // 官方开发者地址
    address public immutable officialDeveloper;

    // 官方网站
    string public officialWebsite;
    // 官方 Twitter
    string public officialTwitter;
    // 官方 Discord
    string public officialDiscord;

    // ==================== 枚举定义 ====================

    // 出拳选择：None(0)-无, Rock(1)-石头, Paper(2)-布, Scissors(3)-剪刀
    enum Choice {None, Rock, Paper, Scissors}

    // 游戏状态枚举
    enum GameStatus {
        Waiting,        // 等待玩家加入（平台锁定，player1 可自主撤销）
        CommitPhase,    // 双方已加入，提交承诺阶段（任一方未提交前可自主撤销）
        RevealPhase,    // 揭晓阶段（资金真正锁定，不可撤销）
        Finished,       // 已结束
        Cancelled       // 已取消
    }

    // ==================== 数据结构 ====================

    // 游戏数据结构
    struct Game {
        address player1;      // 玩家1地址
        address player2;      // 玩家2地址
        uint256 amount;       // 下注金额
        address token;        // 代币地址
        bytes32 commit1;      // 玩家1的哈希承诺
        bytes32 commit2;      // 玩家2的哈希承诺
        uint8 choice1;        // 玩家1的出拳
        uint8 choice2;        // 玩家2的出拳
        uint256 commitDeadline;  // 提交阶段截止时间
        uint256 revealDeadline;  // 揭晓阶段截止时间
        GameStatus status;    // 游戏状态
        address winner;       // 获胜者地址
        bool isDraw;          // 是否平局
        bool player1Refunded; // 玩家1是否已退款
        bool player2Refunded; // 玩家2是否已退款
    }

    // ==================== 状态变量 ====================

    // 提交阶段超时时间（秒）
    uint256 public commitTimeout = 300;     // 5 分钟
    // 揭晓阶段超时时间（秒）
    uint256 public revealTimeout = 300;     // 5 分钟
    // 手续费率（基点）
    uint256 public feeRate = 200;            // 2%（基点）
    // 最小下注金额
    uint256 public constant MIN_BET = 1e15;  // 最小下注 0.001 单位
    // 最高手续费率（基点）
    uint256 public constant MAX_FEE_RATE = 1000; // 最高 10%

    // 手续费接收地址
    address public feeCollector;

    // 支持的代币列表
    mapping(address => bool) public supportedTokens;

    // 游戏列表（gameId => Game）
    mapping(uint256 => Game) public games;
    // 游戏总数
    uint256 public gameCount;

    // 玩家游戏列表（player => gameId[]）
    mapping(address => uint256[]) public playerGames;

    // ==================== 扩展字段预留（v1.1.0 占位） ====================

    // 二期扩展：赛事、NFT、房间类型
    // 仅定义占位 mapping，便于后续平滑升级，当前不参与任何业务逻辑
    mapping(uint256 => uint256) public extTournamentId;   // 赛事 ID（预留）
    mapping(uint256 => uint256) public extRoomType;       // 房间类型（预留）
    mapping(address => bool) public extNftHolder;         // NFT 权益（预留）

    // ==================== 事件定义 ====================

    // 创建游戏事件
    event GameCreated(uint256 indexed gameId, address indexed creator, uint256 amount, address token);
    // 玩家加入事件
    event PlayerJoined(uint256 indexed gameId, address indexed player);
    // 提交承诺事件
    event CommitSubmitted(uint256 indexed gameId, address indexed player, bytes32 commit);
    // 揭晓出拳事件
    event ChoiceRevealed(uint256 indexed gameId, address indexed player, uint8 choice);
    // 游戏结算事件
    event GameSettled(uint256 indexed gameId, address winner, uint256 amount, uint256 fee);
    // 超时处理事件
    event TimeoutClaimed(uint256 indexed gameId, address indexed claimer, bool refunded);
    // 平局处理事件
    event DrawHandled(uint256 indexed gameId);
    // 平局退款事件
    event DrawRefunded(uint256 indexed gameId, address indexed player, uint256 amount);
    // 手续费率变更事件
    event FeeRateChanged(uint256 oldRate, uint256 newRate);
    // 取消游戏事件
    event MatchCancelled(uint256 indexed gameId, address indexed canceller);
    // 开发者地址变更事件
    event DeveloperAddressChanged(address oldAddr, address newAddr);
    // 官方信息更新事件
    event OfficialInfoUpdated(string website, string twitter, string discord);
    // 代币支持变更事件
    event TokenSupportUpdated(address indexed token, bool supported);
    // 超时时间变更事件
    event TimeoutChanged(uint256 oldCommit, uint256 newCommit, uint256 oldReveal, uint256 newReveal);
    // 紧急提取事件
    event EmergencyWithdraw(address indexed token, uint256 amount, address indexed to);

    // ==================== 构造函数 ====================

    // 构造函数 - 初始化手续费接收地址和开发者地址
    constructor(address _feeCollector, address _officialDeveloper) Ownable(msg.sender) {
        require(_feeCollector != address(0), "Invalid fee collector");
        require(_officialDeveloper != address(0), "Invalid developer address");

        feeCollector = _feeCollector;
        officialDeveloper = _officialDeveloper;
        deployTimestamp = block.timestamp;

        officialWebsite = "https://chainrps.io";
        officialTwitter = "@ChainRPS";
        officialDiscord = "discord.gg/chainrps";

        supportedTokens[address(0)] = true;
    }

    // ==================== 核心对局函数 ====================

    // 创建对局 - 资金进入"平台锁定"阶段，player1 可自主撤销
    /**
     * @notice 创建对局 - 资金进入"平台锁定"阶段，player1 可自主撤销
     * @param amount 下注金额
     * @param token 代币地址（address(0) 表示 ETH）
     * @return gameId 对局ID
     */
    function createMatch(uint256 amount, address token)
    external
    payable
    nonReentrant
    whenNotPaused
    returns (uint256)
    {
        require(supportedTokens[token], "Token not supported");
        require(amount >= MIN_BET, "Bet below minimum");

        if (token == address(0)) {
            require(msg.value == amount, "ETH amount mismatch");
        } else {
            IERC20(token).transferFrom(msg.sender, address(this), amount);
        }

        gameCount++;
        uint256 gameId = gameCount;

        Game storage game = games[gameId];
        game.player1 = msg.sender;
        game.amount = amount;
        game.token = token;
        game.status = GameStatus.Waiting;

        playerGames[msg.sender].push(gameId);

        emit GameCreated(gameId, msg.sender, amount, token);

        return gameId;
    }

    // 加入对局 - 进入提交承诺阶段（双方资金均已平台锁定）
    /**
     * @notice 加入对局 - 进入提交承诺阶段（双方资金均已平台锁定）
     * @param gameId 对局ID
     */
    function joinMatch(uint256 gameId) external payable nonReentrant whenNotPaused {
        Game storage game = games[gameId];

        require(game.status == GameStatus.Waiting, "Game not waiting");
        require(msg.sender != game.player1, "Cannot join own game");
        require(game.player2 == address(0), "Game already full");

        if (game.token == address(0)) {
            require(msg.value == game.amount, "ETH amount mismatch");
        } else {
            IERC20(game.token).transferFrom(msg.sender, address(this), game.amount);
        }

        game.player2 = msg.sender;
        game.status = GameStatus.CommitPhase;
        game.commitDeadline = block.timestamp + commitTimeout;

        playerGames[msg.sender].push(gameId);

        emit PlayerJoined(gameId, msg.sender);
    }

    // 提交哈希承诺 - 一旦任一方提交，资金进入"真正锁定"状态
    /**
     * @notice 提交哈希承诺 - 一旦任一方提交，资金进入"真正锁定"状态
     * @param gameId 对局ID
     * @param commit 哈希承诺 keccak256(choice + salt + address)
     */
    function submitCommit(uint256 gameId, bytes32 commit) external whenNotPaused {
        Game storage game = games[gameId];

        require(game.status == GameStatus.CommitPhase, "Not in commit phase");
        require(block.timestamp <= game.commitDeadline, "Commit deadline passed");
        require(msg.sender == game.player1 || msg.sender == game.player2, "Not a player");

        if (msg.sender == game.player1) {
            require(game.commit1 == bytes32(0), "Already committed");
            game.commit1 = commit;
        } else {
            require(game.commit2 == bytes32(0), "Already committed");
            game.commit2 = commit;
        }

        emit CommitSubmitted(gameId, msg.sender, commit);

        if (game.commit1 != bytes32(0) && game.commit2 != bytes32(0)) {
            game.status = GameStatus.RevealPhase;
            game.revealDeadline = block.timestamp + revealTimeout;
        }
    }

    // 揭晓出拳 - 验证哈希承诺并公布实际出拳
    /**
     * @notice 揭晓出拳
     * @param gameId 对局ID
     * @param choice 出拳 (1=石头, 2=布, 3=剪刀)
     * @param salt 盐值
     */
    function revealChoice(uint256 gameId, uint8 choice, bytes32 salt)
    external
    nonReentrant
    whenNotPaused
    {
        Game storage game = games[gameId];

        require(game.status == GameStatus.RevealPhase, "Not in reveal phase");
        require(block.timestamp <= game.revealDeadline, "Reveal deadline passed");
        require(choice >= 1 && choice <= 3, "Invalid choice");

        bytes32 commit = keccak256(abi.encodePacked(choice, salt, msg.sender));

        if (msg.sender == game.player1) {
            require(commit == game.commit1, "Commit mismatch");
            require(game.choice1 == 0, "Already revealed");
            game.choice1 = choice;
        } else if (msg.sender == game.player2) {
            require(commit == game.commit2, "Commit mismatch");
            require(game.choice2 == 0, "Already revealed");
            game.choice2 = choice;
        } else {
            revert("Not a player");
        }

        emit ChoiceRevealed(gameId, msg.sender, choice);

        if (game.choice1 != 0 && game.choice2 != 0) {
            _settleGame(gameId);
        }
    }

    // 超时处理 - 提交/揭晓阶段超时后，统一全额退款，不判超时方负
    /**
     * @notice 超时处理 - 提交/揭晓阶段超时后，统一全额退款，不判超时方负
     * @dev 无论是双方都未操作、还是仅一方操作，超时后都全额退款给双方
     * @param gameId 对局ID
     */
    function claimTimeout(uint256 gameId) external nonReentrant whenNotPaused {
        Game storage game = games[gameId];

        require(
            game.status == GameStatus.CommitPhase || game.status == GameStatus.RevealPhase,
            "Game not active"
        );
        require(msg.sender == game.player1 || msg.sender == game.player2, "Not a player");

        if (game.status == GameStatus.CommitPhase) {
            require(block.timestamp > game.commitDeadline, "Commit phase not ended");
        } else {
            require(block.timestamp > game.revealDeadline, "Reveal phase not ended");
        }

        // 统一标记为平局式退款，等待双方调用 handleDraw 领取
        game.status = GameStatus.Finished;
        game.isDraw = true;

        emit TimeoutClaimed(gameId, msg.sender, true);
        emit DrawHandled(gameId);
    }

    // 平局退款 - 双方分别领取退款（零手续费）
    /**
     * @notice 平局退款 - 双方分别领取退款（零手续费）
     * @dev 触发场景：对局平局、超时退款
     * @param gameId 对局ID
     */
    function handleDraw(uint256 gameId) external nonReentrant whenNotPaused {
        Game storage game = games[gameId];

        require(game.status == GameStatus.Finished, "Game not finished");
        require(game.isDraw, "Not a draw");
        require(msg.sender == game.player1 || msg.sender == game.player2, "Not a player");

        if (msg.sender == game.player1 && !game.player1Refunded) {
            game.player1Refunded = true;
            _safeTransfer(game.token, game.player1, game.amount);
            emit DrawRefunded(gameId, game.player1, game.amount);
        } else if (msg.sender == game.player2 && !game.player2Refunded) {
            game.player2Refunded = true;
            _safeTransfer(game.token, game.player2, game.amount);
            emit DrawRefunded(gameId, game.player2, game.amount);
        }
    }

    // 玩家自主撤销对局 - 仅在"平台锁定"阶段可用
    /**
     * @notice 玩家自主撤销对局 - 仅在"平台锁定"阶段可用
     * @dev Waiting 状态：仅 player1 可撤销
     *      CommitPhase 状态：双方都未提交 commit 时任一方可撤销
     *      RevealPhase 及之后：资金已真正锁定，任何人（含 Owner）都无权撤销
     * @param gameId 对局ID
     */
    function cancelMatch(uint256 gameId) external nonReentrant whenNotPaused {
        Game storage game = games[gameId];
        require(msg.sender == game.player1 || msg.sender == game.player2, "Not a player");

        if (game.status == GameStatus.Waiting) {
            require(msg.sender == game.player1, "Only creator can cancel");
        } else if (game.status == GameStatus.CommitPhase) {
            require(
                game.commit1 == bytes32(0) && game.commit2 == bytes32(0),
                "Commit submitted, cannot cancel"
            );
        } else {
            revert("Cannot cancel after reveal phase");
        }

        game.status = GameStatus.Cancelled;

        emit MatchCancelled(gameId, msg.sender);

        _refundBoth(gameId);
    }

    // ==================== 内部函数 ====================

    // 结算对局 - 判断胜负并分发奖励或标记平局
    function _settleGame(uint256 gameId) internal {
        Game storage game = games[gameId];

        if (game.choice1 == game.choice2) {
            // 平局：零手续费，全额退款（等待玩家调用 handleDraw 领取）
            game.isDraw = true;
            game.status = GameStatus.Finished;
            emit DrawHandled(gameId);
        } else {
            bool player1Wins = _checkWin(game.choice1, game.choice2);
            game.winner = player1Wins ? game.player1 : game.player2;
            game.status = GameStatus.Finished;
            _distributePrize(gameId);
        }
    }

    // 判断玩家1是否获胜 - 石头(1)胜剪刀(3), 剪刀(3)胜布(2), 布(2)胜石头(1)
    function _checkWin(uint8 choice1, uint8 choice2) internal pure returns (bool) {
        if (choice1 == 1 && choice2 == 3) return true;
        if (choice1 == 2 && choice2 == 1) return true;
        if (choice1 == 3 && choice2 == 2) return true;
        return false;
    }

    // 分发奖励 - 扣取手续费后将剩余金额转给获胜者
    function _distributePrize(uint256 gameId) internal {
        Game storage game = games[gameId];

        uint256 totalPrize = game.amount * 2;
        uint256 fee = (totalPrize * feeRate) / 10000;
        uint256 winnerPrize = totalPrize - fee;

        _safeTransfer(game.token, game.winner, winnerPrize);
        _safeTransfer(game.token, feeCollector, fee);

        emit GameSettled(gameId, game.winner, winnerPrize, fee);
    }

    // 退还双方资金 - 用于取消对局时的退款操作
    function _refundBoth(uint256 gameId) internal {
        Game storage game = games[gameId];

        if (game.player1 != address(0)) {
            _safeTransfer(game.token, game.player1, game.amount);
        }
        if (game.player2 != address(0)) {
            _safeTransfer(game.token, game.player2, game.amount);
        }
    }

    // 安全转账 - 支持 ETH 和 ERC20 代币，转账失败时抛出异常
    function _safeTransfer(address token, address to, uint256 amount) internal {
        require(to != address(0), "Zero address");
        if (token == address(0)) {
            (bool ok,) = payable(to).call{value: amount}("");
            require(ok, "ETH transfer failed");
        } else {
            bool ok = IERC20(token).transfer(to, amount);
            require(ok, "Token transfer failed");
        }
    }

    // ==================== 查询函数 ====================

    // 查询对局状态
    /**
     * @notice 查询对局状态
     * @param gameId 对局ID
     */
    function getGame(uint256 gameId)
    external
    view
    returns (
        address player1,
        address player2,
        uint256 amount,
        address token,
        GameStatus status,
        uint256 commitDeadline,
        uint256 revealDeadline,
        address winner,
        bool isDraw
    )
    {
        Game storage game = games[gameId];
        return (
            game.player1,
            game.player2,
            game.amount,
            game.token,
            game.status,
            game.commitDeadline,
            game.revealDeadline,
            game.winner,
            game.isDraw
        );
    }

    // 查询玩家承诺
    /**
     * @notice 查询玩家承诺
     * @param gameId 对局ID
     * @param player 玩家地址
     */
    function getCommit(uint256 gameId, address player) external view returns (bytes32) {
        Game storage game = games[gameId];
        if (player == game.player1) return game.commit1;
        if (player == game.player2) return game.commit2;
        return bytes32(0);
    }

    // 获取玩家对局列表
    /**
     * @notice 获取玩家对局列表
     */
    function getPlayerGames(address player) external view returns (uint256[] memory) {
        return playerGames[player];
    }

    // 查询合约余额（仅审计/运维用）
    /**
     * @notice 查询合约余额（仅审计/运维用，不影响用户资金）
     * @param token 代币地址（address(0) 表示 ETH）
     */
    function getContractBalance(address token) external view returns (uint256) {
        if (token == address(0)) {
            return address(this).balance;
        }
        return IERC20(token).balanceOf(address(this));
    }

    // 验证是否为官方合约（返回防仿标识）
    /**
     * @notice 验证是否为官方合约
     * @dev 返回防仿标识信息供前端校验
     */
    function getAntiFakeInfo()
    external
    view
    returns (
        address developer,
        uint256 deployTime,
        string memory version,
        string memory website,
        string memory twitter,
        string memory discord
    )
    {
        return (
            officialDeveloper,
            deployTimestamp,
            VERSION,
            officialWebsite,
            officialTwitter,
            officialDiscord
        );
    }

    // ==================== Owner 权限函数 ====================

    // 修改手续费率
    /**
     * @notice 修改手续费率
     * @param newRate 新费率（基点，100=1%，上限 1000=10%）
     */
    function setFeeRate(uint256 newRate) external onlyOwner {
        require(newRate <= MAX_FEE_RATE, "Fee rate too high");
        uint256 oldRate = feeRate;
        feeRate = newRate;
        emit FeeRateChanged(oldRate, newRate);
    }

    // 修改开发者/手续费接收地址
    /**
     * @notice 修改开发者/手续费接收地址
     * @param newAddr 新地址
     */
    function setDeveloperAddress(address newAddr) external onlyOwner {
        require(newAddr != address(0), "Invalid address");
        address oldAddr = feeCollector;
        feeCollector = newAddr;
        emit DeveloperAddressChanged(oldAddr, newAddr);
    }

    // 更新官方信息（域名、社交链接）
    /**
     * @notice 更新官方信息（域名、社交链接）
     */
    function updateOfficialInfo(
        string calldata website,
        string calldata twitter,
        string calldata discord
    ) external onlyOwner {
        officialWebsite = website;
        officialTwitter = twitter;
        officialDiscord = discord;
        emit OfficialInfoUpdated(website, twitter, discord);
    }

    // 添加/移除支持的代币
    /**
     * @notice 添加/移除支持的代币（禁止移除 ETH 支持）
     */
    function setTokenSupport(address token, bool supported) external onlyOwner {
        require(token != address(0), "Cannot modify ETH support");
        supportedTokens[token] = supported;
        emit TokenSupportUpdated(token, supported);
    }

    // 修改超时时间
    /**
     * @notice 修改超时时间
     * @param newCommitTimeout 提交阶段超时（秒）
     * @param newRevealTimeout 揭晓阶段超时（秒）
     */
    function setTimeouts(uint256 newCommitTimeout, uint256 newRevealTimeout) external onlyOwner {
        require(newCommitTimeout > 0 && newRevealTimeout > 0, "Invalid timeout");
        uint256 oldCommit = commitTimeout;
        uint256 oldReveal = revealTimeout;
        commitTimeout = newCommitTimeout;
        revealTimeout = newRevealTimeout;
        emit TimeoutChanged(oldCommit, newCommitTimeout, oldReveal, newRevealTimeout);
    }

    // 暂停合约
    /**
     * @notice 暂停合约
     */
    function pause() external onlyOwner {
        _pause();
    }

    // 恢复合约
    /**
     * @notice 恢复合约
     */
    function unpause() external onlyOwner {
        _unpause();
    }

    // 紧急提取误转入的非对局资金
    /**
     * @notice 紧急提取误转入的非对局资金
     * @dev 仅可提取合约余额中超过"用户对局锁定资金"的部分，绝不动用户下注资金
     * @param token 代币地址（address(0) 表示 ETH）
     * @param to 接收地址
     * @param amount 提取金额
     */
    function emergencyWithdraw(address token, address to, uint256 amount) external onlyOwner nonReentrant {
        require(to != address(0), "Invalid address");

        // 计算所有活跃对局锁定的资金总额
        uint256 locked = 0;
        for (uint256 i = 1; i <= gameCount; i++) {
            Game storage g = games[i];
            if (
                g.status == GameStatus.Waiting ||
                g.status == GameStatus.CommitPhase ||
                g.status == GameStatus.RevealPhase
            ) {
                // Waiting 状态只有 player1 锁定；其他状态双方都已锁定
                locked += g.amount;
                if (g.player2 != address(0)) {
                    locked += g.amount;
                }
            } else if (g.status == GameStatus.Finished && g.isDraw) {
                // 平局状态：未领取的退款仍属于玩家
                if (!g.player1Refunded && g.player1 != address(0)) locked += g.amount;
                if (!g.player2Refunded && g.player2 != address(0)) locked += g.amount;
            }
        }

        uint256 balance = token == address(0)
            ? address(this).balance
            : IERC20(token).balanceOf(address(this));

        require(balance >= locked + amount, "Insufficient withdrawable balance");

        _safeTransfer(token, to, amount);
        emit EmergencyWithdraw(token, amount, to);
    }

    // ==================== 扩展预留（二期占位） ====================

    // 赛事模式：extTournamentId / extRoomType 已在状态变量区定义
    // NFT 权益：extNftHolder 已在状态变量区定义
    // 当前仅占位，不参与任何业务逻辑，二期可通过新合约或代理扩展
}