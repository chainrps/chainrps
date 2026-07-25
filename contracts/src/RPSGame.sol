// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/utils/Pausable.sol";

/**
 * @title RPSGame
 * @notice 链上公平猜拳游戏 - 基于哈希承诺的石头剪刀布
 * @dev 使用 keccak256 哈希承诺机制确保出拳公平性
 *      防仿标识：官方开发者地址、部署时间戳、版本号硬编码
 */
contract RPSGame is Ownable, ReentrancyGuard, Pausable {
    // ==================== 常量与防仿标识 ====================

    string public constant VERSION = "v1.0.0";
    uint256 public immutable deployTimestamp;
    address public immutable officialDeveloper;

    string public officialWebsite;
    string public officialTwitter;
    string public officialDiscord;

    // ==================== 枚举定义 ====================

    enum Choice { None, Rock, Paper, Scissors }

    enum GameStatus {
        Waiting,
        CommitPhase,
        RevealPhase,
        Finished,
        Cancelled
    }

    // ==================== 数据结构 ====================

    struct Game {
        address player1;
        address player2;
        uint256 amount;
        address token;
        bytes32 commit1;
        bytes32 commit2;
        uint8 choice1;
        uint8 choice2;
        uint256 commitDeadline;
        uint256 revealDeadline;
        GameStatus status;
        address winner;
        bool isDraw;
        bool player1Refunded;
        bool player2Refunded;
    }

    // ==================== 状态变量 ====================

    uint256 public commitTimeout = 66;
    uint256 public revealTimeout = 88;
    uint256 public feeRate = 200;
    address public feeCollector;

    mapping(address => bool) public supportedTokens;

    mapping(uint256 => Game) public games;
    uint256 public gameCount;

    mapping(address => uint256[]) public playerGames;

    // ==================== 事件定义 ====================

    event GameCreated(uint256 indexed gameId, address indexed creator, uint256 amount, address token);
    event PlayerJoined(uint256 indexed gameId, address indexed player);
    event CommitSubmitted(uint256 indexed gameId, address indexed player, bytes32 commit);
    event ChoiceRevealed(uint256 indexed gameId, address indexed player, uint8 choice);
    event GameSettled(uint256 indexed gameId, address winner, uint256 amount, uint256 fee);
    event TimeoutClaimed(uint256 indexed gameId, address indexed claimer);
    event DrawHandled(uint256 indexed gameId);
    event FeeRateChanged(uint256 oldRate, uint256 newRate);
    event MatchCancelled(uint256 indexed gameId, address indexed canceller);
    event DeveloperAddressChanged(address oldAddr, address newAddr);
    event OfficialInfoUpdated(string website, string twitter, string discord);
    event TokenSupportUpdated(address indexed token, bool supported);

    // ==================== 构造函数 ====================

    constructor(address _feeCollector, address _officialDeveloper) Ownable(msg.sender) {
        require(_feeCollector != address(0), "Invalid fee collector");
        require(_officialDeveloper != address(0), "Invalid developer address");

        feeCollector = _feeCollector;
        officialDeveloper = _officialDeveloper;
        deployTimestamp = block.timestamp;

        officialWebsite = "https://chainrps.io";
        officialTwitter = "@ChainRPS";
        officialDiscord = "discord.gg/chainrps";
    }

    // ==================== 核心对局函数 ====================

    /**
     * @notice 创建对局
     * @param amount 下注金额
     * @param token 代币地址
     * @return gameId 对局ID
     */
    function createMatch(uint256 amount, address token)
        external
        nonReentrant
        whenNotPaused
        returns (uint256)
    {
        require(supportedTokens[token], "Token not supported");
        require(amount > 0, "Amount must be positive");

        IERC20(token).transferFrom(msg.sender, address(this), amount);

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

    /**
     * @notice 加入对局
     * @param gameId 对局ID
     */
    function joinMatch(uint256 gameId) external nonReentrant whenNotPaused {
        Game storage game = games[gameId];

        require(game.status == GameStatus.Waiting, "Game not waiting");
        require(msg.sender != game.player1, "Cannot join own game");
        require(game.player2 == address(0), "Game already full");

        IERC20(game.token).transferFrom(msg.sender, address(this), game.amount);

        game.player2 = msg.sender;
        game.status = GameStatus.CommitPhase;
        game.commitDeadline = block.timestamp + commitTimeout;

        playerGames[msg.sender].push(gameId);

        emit PlayerJoined(gameId, msg.sender);
    }

    /**
     * @notice 提交哈希承诺
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

    /**
     * @notice 超时索赔
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

            if (msg.sender == game.player1) {
                require(game.commit1 != bytes32(0), "You did not commit");
                require(game.commit2 == bytes32(0), "Opponent committed");
                game.winner = game.player1;
            } else {
                require(game.commit2 != bytes32(0), "You did not commit");
                require(game.commit1 == bytes32(0), "Opponent committed");
                game.winner = game.player2;
            }
        } else {
            require(block.timestamp > game.revealDeadline, "Reveal phase not ended");

            if (msg.sender == game.player1) {
                require(game.choice1 != 0, "You did not reveal");
                require(game.choice2 == 0, "Opponent revealed");
                game.winner = game.player1;
            } else {
                require(game.choice2 != 0, "You did not reveal");
                require(game.choice1 == 0, "Opponent revealed");
                game.winner = game.player2;
            }
        }

        game.status = GameStatus.Finished;
        emit TimeoutClaimed(gameId, msg.sender);

        _distributePrize(gameId);
    }

    /**
     * @notice 平局处理 - 双方全额退款，无手续费
     * @param gameId 对局ID
     */
    function handleDraw(uint256 gameId) external nonReentrant whenNotPaused {
        Game storage game = games[gameId];

        require(game.status == GameStatus.Finished, "Game not finished");
        require(game.isDraw, "Not a draw");
        require(msg.sender == game.player1 || msg.sender == game.player2, "Not a player");

        if (msg.sender == game.player1 && !game.player1Refunded) {
            game.player1Refunded = true;
            IERC20(game.token).transfer(game.player1, game.amount);
        } else if (msg.sender == game.player2 && !game.player2Refunded) {
            game.player2Refunded = true;
            IERC20(game.token).transfer(game.player2, game.amount);
        }

        if (game.player1Refunded && game.player2Refunded) {
            emit DrawHandled(gameId);
        }
    }

    // ==================== 内部函数 ====================

    function _settleGame(uint256 gameId) internal {
        Game storage game = games[gameId];

        if (game.choice1 == game.choice2) {
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

    function _checkWin(uint8 choice1, uint8 choice2) internal pure returns (bool) {
        if (choice1 == 1 && choice2 == 3) return true;
        if (choice1 == 2 && choice2 == 1) return true;
        if (choice1 == 3 && choice2 == 2) return true;
        return false;
    }

    function _distributePrize(uint256 gameId) internal {
        Game storage game = games[gameId];

        uint256 totalPrize = game.amount * 2;
        uint256 fee = (totalPrize * feeRate) / 10000;
        uint256 winnerPrize = totalPrize - fee;

        IERC20(game.token).transfer(game.winner, winnerPrize);
        IERC20(game.token).transfer(feeCollector, fee);

        emit GameSettled(gameId, game.winner, winnerPrize, fee);
    }

    // ==================== 查询函数 ====================

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

    /**
     * @notice 获取玩家对局列表
     */
    function getPlayerGames(address player) external view returns (uint256[] memory) {
        return playerGames[player];
    }

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

    /**
     * @notice 修改手续费率
     * @param newRate 新费率（基点，100=1%）
     */
    function setFeeRate(uint256 newRate) external onlyOwner {
        require(newRate <= 1000, "Fee rate too high");
        uint256 oldRate = feeRate;
        feeRate = newRate;
        emit FeeRateChanged(oldRate, newRate);
    }

    /**
     * @notice 取消对局 - 退回双方资金
     * @param gameId 对局ID
     */
    function cancelMatch(uint256 gameId) external onlyOwner nonReentrant {
        Game storage game = games[gameId];

        require(
            game.status == GameStatus.Waiting ||
            game.status == GameStatus.CommitPhase ||
            game.status == GameStatus.RevealPhase,
            "Cannot cancel finished game"
        );

        if (game.player1 != address(0)) {
            IERC20(game.token).transfer(game.player1, game.amount);
        }
        if (game.player2 != address(0)) {
            IERC20(game.token).transfer(game.player2, game.amount);
        }

        game.status = GameStatus.Cancelled;

        emit MatchCancelled(gameId, msg.sender);
    }

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

    /**
     * @notice 添加/移除支持的代币
     */
    function setTokenSupport(address token, bool supported) external onlyOwner {
        supportedTokens[token] = supported;
        emit TokenSupportUpdated(token, supported);
    }

    /**
     * @notice 修改超时时间
     */
    function setTimeouts(uint256 newCommitTimeout, uint256 newRevealTimeout) external onlyOwner {
        require(newCommitTimeout > 0 && newRevealTimeout > 0, "Invalid timeout");
        commitTimeout = newCommitTimeout;
        revealTimeout = newRevealTimeout;
    }

    /**
     * @notice 暂停合约
     */
    function pause() external onlyOwner {
        _pause();
    }

    /**
     * @notice 恢复合约
     */
    function unpause() external onlyOwner {
        _unpause();
    }

    // ==================== 扩展预留 ====================

    // 预留：赛事模式
    // 预留：NFT 权益
    // 预留：房间类型
}
