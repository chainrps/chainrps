// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/**
 * @title RPSGame
 * @notice 链上公平猜拳游戏 - 基于哈希承诺的石头剪刀布
 * @dev 使用 keccak256 哈希承诺机制确保出拳公平性
 */
contract RPSGame is Ownable, ReentrancyGuard {
    // 出拳类型
    enum Choice { None, Rock, Paper, Scissors }

    // 对局状态
    enum GameState {
        Waiting,        // 等待玩家加入
        BothJoined,     // 双方已加入，等待提交哈希
        CommitPhase,    // 提交哈希阶段
        RevealPhase,    // 揭晓阶段
        Finished,       // 已结算
        Cancelled       // 已取消
    }

    // 对局信息
    struct Game {
        address player1;            // 玩家1地址
        address player2;            // 玩家2地址
        address token;              // 代币地址
        uint256 betAmount;          // 下注金额
        bytes32 commit1;            // 玩家1哈希承诺
        bytes32 commit2;            // 玩家2哈希承诺
        Choice choice1;             // 玩家1出拳
        Choice choice2;             // 玩家2出拳
        uint256 salt1;              // 玩家1盐值
        uint256 salt2;              // 玩家2盐值
        GameState state;            // 对局状态
        uint256 createdAt;          // 创建时间
        uint256 commitDeadline;     // 提交哈希截止时间
        uint256 revealDeadline;    // 揭晓截止时间
        address winner;             // 获胜者
        bool isDraw;                // 是否平局
        bool player1Refunded;       // 玩家1是否已退款（平局情况）
        bool player2Refunded;       // 玩家2是否已退款（平局情况）
    }

    // 平局处理选项
    enum DrawAction { None, Refund, Rematch }

    // 代币配置
    struct TokenConfig {
        bool enabled;               // 是否启用
        address tokenAddress;       // 代币地址
    }

    // 公共变量
    uint256 public commitTimeout = 66;      // 提交哈希超时时间（秒）
    uint256 public revealTimeout = 88;     // 揭晓超时时间（秒）
    uint256 public feeRate = 200;           // 手续费比例（基点，200 = 2%）
    address public feeCollector;           // 手续费收取地址

    // 预设代币（Polygon 网络）
    mapping(string => TokenConfig) public tokenConfigs;
    mapping(address => bool) public supportedTokens;

    // 对局存储
    mapping(uint256 => Game) public games;
    uint256 public gameCount;

    // 玩家对局映射
    mapping(address => uint256[]) public playerGames;

    // 事件
    event GameCreated(uint256 indexed gameId, address indexed player1, address token, uint256 betAmount);
    event PlayerJoined(uint256 indexed gameId, address indexed player2);
    event CommitSubmitted(uint256 indexed gameId, address indexed player, bytes32 commit);
    event ChoiceRevealed(uint256 indexed gameId, address indexed player, Choice choice, uint256 salt);
    event GameSettled(uint256 indexed gameId, address winner, uint256 prize, uint256 fee);
    event DrawSettled(uint256 indexed gameId, address player1, address player2);
    event GameCancelled(uint256 indexed gameId, address indexed canceller);
    event FeeRateUpdated(uint256 oldRate, uint256 newRate);
    event FeeCollectorUpdated(address oldCollector, address newCollector);
    event TokenConfigured(string symbol, address tokenAddress, bool enabled);

    constructor(address _feeCollector) Ownable(msg.sender) {
        feeCollector = _feeCollector;

        // Polygon Amoy 测试网默认代币地址
        tokenConfigs["USDC"] = TokenConfig({
            enabled: true,
            tokenAddress: 0x41e94Eb019A70Ac5c8Fbf5e85D8C8D9B36e1f89E // Amoy USDC
        });
        tokenConfigs["USDT"] = TokenConfig({
            enabled: true,
            tokenAddress: 0x0E1b9E30d79C9a1b5d9bC3d4E3d3C2B1A9e8d7c6 // Amoy USDT (示例地址，需替换)
        });

        // 标记支持的代币
        supportedTokens[0x41e94Eb019A70Ac5c8Fbf5e85D8C8D9B36e1f89E] = true;
    }

    /**
     * @notice 创建新对局
     * @param token 代币地址
     * @param betAmount 下注金额
     * @return gameId 对局ID
     */
    function createGame(address token, uint256 betAmount) external nonReentrant returns (uint256) {
        require(supportedTokens[token], "Token not supported");
        require(betAmount > 0, "Bet amount must be positive");

        // 转入代币
        IERC20(token).transferFrom(msg.sender, address(this), betAmount);

        gameCount++;
        uint256 gameId = gameCount;

        Game storage game = games[gameId];
        game.player1 = msg.sender;
        game.token = token;
        game.betAmount = betAmount;
        game.state = GameState.Waiting;
        game.createdAt = block.timestamp;

        playerGames[msg.sender].push(gameId);

        emit GameCreated(gameId, msg.sender, token, betAmount);

        return gameId;
    }

    /**
     * @notice 加入对局
     * @param gameId 对局ID
     */
    function joinGame(uint256 gameId) external nonReentrant {
        Game storage game = games[gameId];

        require(game.state == GameState.Waiting, "Game not waiting for player");
        require(msg.sender != game.player1, "Cannot join your own game");
        require(game.player2 == address(0), "Game already full");

        // 转入代币
        IERC20(game.token).transferFrom(msg.sender, address(this), game.betAmount);

        game.player2 = msg.sender;
        game.state = GameState.CommitPhase;
        game.commitDeadline = block.timestamp + commitTimeout;

        playerGames[msg.sender].push(gameId);

        emit PlayerJoined(gameId, msg.sender);
    }

    /**
     * @notice 取消对局（仅等待状态可取消）
     * @param gameId 对局ID
     */
    function cancelGame(uint256 gameId) external {
        Game storage game = games[gameId];

        require(game.state == GameState.Waiting, "Can only cancel waiting game");
        require(msg.sender == game.player1, "Only creator can cancel");

        // 退还代币
        IERC20(game.token).transfer(game.player1, game.betAmount);

        game.state = GameState.Cancelled;

        emit GameCancelled(gameId, msg.sender);
    }

    /**
     * @notice 提交哈希承诺
     * @param gameId 对局ID
     * @param commit 哈希承诺 (keccak256(abi.encodePacked(choice, salt, msg.sender)))
     */
    function submitCommit(uint256 gameId, bytes32 commit) external {
        Game storage game = games[gameId];

        require(game.state == GameState.CommitPhase, "Not in commit phase");
        require(block.timestamp <= game.commitDeadline, "Commit phase ended");
        require(msg.sender == game.player1 || msg.sender == game.player2, "Not a player");

        if (msg.sender == game.player1) {
            require(game.commit1 == bytes32(0), "Already committed");
            game.commit1 = commit;
        } else {
            require(game.commit2 == bytes32(0), "Already committed");
            game.commit2 = commit;
        }

        emit CommitSubmitted(gameId, msg.sender, commit);

        // 双方都已提交，进入揭晓阶段
        if (game.commit1 != bytes32(0) && game.commit2 != bytes32(0)) {
            game.state = GameState.RevealPhase;
            game.revealDeadline = block.timestamp + revealTimeout;
        }
    }

    /**
     * @notice 揭晓出拳
     * @param gameId 对局ID
     * @param choice 出拳 (1=石头, 2=布, 3=剪刀)
     * @param salt 盐值
     */
    function revealChoice(uint256 gameId, Choice choice, uint256 salt) external {
        Game storage game = games[gameId];

        require(game.state == GameState.RevealPhase, "Not in reveal phase");
        require(block.timestamp <= game.revealDeadline, "Reveal phase ended");
        require(choice == Choice.Rock || choice == Choice.Paper || choice == Choice.Scissors, "Invalid choice");

        bytes32 commit = keccak256(abi.encodePacked(uint256(choice), salt, msg.sender));

        if (msg.sender == game.player1) {
            require(commit == game.commit1, "Invalid reveal");
            require(game.choice1 == Choice.None, "Already revealed");
            game.choice1 = choice;
            game.salt1 = salt;
        } else if (msg.sender == game.player2) {
            require(commit == game.commit2, "Invalid reveal");
            require(game.choice2 == Choice.None, "Already revealed");
            game.choice2 = choice;
            game.salt2 = salt;
        } else {
            revert("Not a player");
        }

        emit ChoiceRevealed(gameId, msg.sender, choice, salt);

        // 双方都已揭晓，自动结算
        if (game.choice1 != Choice.None && game.choice2 != Choice.None) {
            _settleGame(gameId);
        }
    }

    /**
     * @notice 平局处理 - 玩家选择退款或重新对战
     * @param gameId 对局ID
     * @param action 处理方式 (1=退款, 2=重新对战)
     */
    function handleDraw(uint256 gameId, DrawAction action) external {
        Game storage game = games[gameId];

        require(game.state == GameState.Finished, "Game not finished");
        require(game.isDraw, "Not a draw");
        require(msg.sender == game.player1 || msg.sender == game.player2, "Not a player");

        if (action == DrawAction.Refund) {
            // 退款给该玩家
            if (msg.sender == game.player1 && !game.player1Refunded) {
                game.player1Refunded = true;
                IERC20(game.token).transfer(game.player1, game.betAmount);
            } else if (msg.sender == game.player2 && !game.player2Refunded) {
                game.player2Refunded = true;
                IERC20(game.token).transfer(game.player2, game.betAmount);
            }
        }
        // Rematch 功能在二期实现
    }

    /**
     * @notice 超时判负 - 对方未按时提交哈希或揭晓
     * @param gameId 对局ID
     */
    function claimTimeout(uint256 gameId) external nonReentrant {
        Game storage game = games[gameId];

        require(
            game.state == GameState.CommitPhase || game.state == GameState.RevealPhase,
            "Game not in active phase"
        );
        require(msg.sender == game.player1 || msg.sender == game.player2, "Not a player");

        if (game.state == GameState.CommitPhase) {
            // 提交哈希阶段超时
            require(block.timestamp > game.commitDeadline, "Commit phase not ended");

            if (msg.sender == game.player1) {
                require(game.commit1 != bytes32(0), "You did not commit");
                require(game.commit2 == bytes32(0), "Opponent committed");
                // 玩家1已提交，玩家2未提交，玩家1获胜
                game.winner = game.player1;
            } else {
                require(game.commit2 != bytes32(0), "You did not commit");
                require(game.commit1 == bytes32(0), "Opponent committed");
                // 玩家2已提交，玩家1未提交，玩家2获胜
                game.winner = game.player2;
            }
        } else {
            // 揭晓阶段超时
            require(block.timestamp > game.revealDeadline, "Reveal phase not ended");

            if (msg.sender == game.player1) {
                require(game.choice1 != Choice.None, "You did not reveal");
                require(game.choice2 == Choice.None, "Opponent revealed");
                game.winner = game.player1;
            } else {
                require(game.choice2 != Choice.None, "You did not reveal");
                require(game.choice1 == Choice.None, "Opponent revealed");
                game.winner = game.player2;
            }
        }

        game.state = GameState.Finished;
        _distributePrize(gameId);
    }

    /**
     * @notice 结算对局（内部函数）
     */
    function _settleGame(uint256 gameId) internal {
        Game storage game = games[gameId];

        // 判断胜负
        if (game.choice1 == game.choice2) {
            // 平局
            game.isDraw = true;
            game.state = GameState.Finished;
            emit DrawSettled(gameId, game.player1, game.player2);
        } else {
            // 判断胜负
            bool player1Wins = _checkWin(game.choice1, game.choice2);
            game.winner = player1Wins ? game.player1 : game.player2;
            game.state = GameState.Finished;
            _distributePrize(gameId);
        }
    }

    /**
     * @notice 判断胜负（石头 > 剪刀 > 布 > 石头）
     */
    function _checkWin(Choice choice1, Choice choice2) internal pure returns (bool) {
        if (choice1 == Choice.Rock && choice2 == Choice.Scissors) return true;
        if (choice1 == Choice.Paper && choice2 == Choice.Rock) return true;
        if (choice1 == Choice.Scissors && choice2 == Choice.Paper) return true;
        return false;
    }

    /**
     * @notice 分配奖金
     */
    function _distributePrize(uint256 gameId) internal {
        Game storage game = games[gameId];

        uint256 totalPrize = game.betAmount * 2;
        uint256 fee = (totalPrize * feeRate) / 10000;  // 基点计算
        uint256 winnerPrize = totalPrize - fee;

        // 转给获胜者
        IERC20(game.token).transfer(game.winner, winnerPrize);

        // 转给手续费地址
        IERC20(game.token).transfer(feeCollector, fee);

        emit GameSettled(gameId, game.winner, winnerPrize, fee);
    }

    // ==================== Owner 函数 ====================

    /**
     * @notice 更新手续费比例
     * @param newRate 新比例（基点，100 = 1%）
     */
    function updateFeeRate(uint256 newRate) external onlyOwner {
        require(newRate <= 1000, "Fee rate too high");  // 最高 10%
        uint256 oldRate = feeRate;
        feeRate = newRate;
        emit FeeRateUpdated(oldRate, newRate);
    }

    /**
     * @notice 更新手续费收取地址
     * @param newCollector 新地址
     */
    function updateFeeCollector(address newCollector) external onlyOwner {
        require(newCollector != address(0), "Invalid address");
        address oldCollector = feeCollector;
        feeCollector = newCollector;
        emit FeeCollectorUpdated(oldCollector, newCollector);
    }

    /**
     * @notice 更新超时时间
     * @param newCommitTimeout 提交超时（秒）
     * @param newRevealTimeout 揭晓超时（秒）
     */
    function updateTimeouts(uint256 newCommitTimeout, uint256 newRevealTimeout) external onlyOwner {
        commitTimeout = newCommitTimeout;
        revealTimeout = newRevealTimeout;
    }

    /**
     * @notice 配置支持的代币
     * @param symbol 代币符号
     * @param tokenAddress 代币地址
     * @param enabled 是否启用
     */
    function configureToken(string memory symbol, address tokenAddress, bool enabled) external onlyOwner {
        tokenConfigs[symbol] = TokenConfig({
            enabled: enabled,
            tokenAddress: tokenAddress
        });
        supportedTokens[tokenAddress] = enabled;
        emit TokenConfigured(symbol, tokenAddress, enabled);
    }

    // ==================== 查询函数 ====================

    /**
     * @notice 获取对局详情
     */
    function getGame(uint256 gameId) external view returns (
        address player1,
        address player2,
        address token,
        uint256 betAmount,
        GameState state,
        uint256 createdAt,
        uint256 commitDeadline,
        uint256 revealDeadline,
        address winner,
        bool isDraw
    ) {
        Game storage game = games[gameId];
        return (
            game.player1,
            game.player2,
            game.token,
            game.betAmount,
            game.state,
            game.createdAt,
            game.commitDeadline,
            game.revealDeadline,
            game.winner,
            game.isDraw
        );
    }

    /**
     * @notice 获取玩家对局列表
     */
    function getPlayerGames(address player) external view returns (uint256[] memory) {
        return playerGames[player];
    }

    /**
     * @notice 获取代币配置
     */
    function getTokenConfig(string memory symbol) external view returns (bool enabled, address tokenAddress) {
        TokenConfig storage config = tokenConfigs[symbol];
        return (config.enabled, config.tokenAddress);
    }

    // ==================== 二期预留接口 ====================

    // 预留：锦标赛模式
    // mapping(uint256 => Tournament) public tournaments;

    // 预留：NFT 权益
    // mapping(address => bool) public nftHolders;

    // 预留：房间类型
    // enum RoomType { Public, Private, Tournament }
}