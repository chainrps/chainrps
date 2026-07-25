const History = (function() {
    let games = [];

    function loadFromStorage() {
        try {
            const data = localStorage.getItem('rps_history');
            if (data) {
                games = JSON.parse(data);
            }
        } catch (e) {
            games = [];
        }
        return games;
    }

    function saveToStorage() {
        try {
            localStorage.setItem('rps_history', JSON.stringify(games));
            return true;
        } catch (e) {
            return false;
        }
    }

    function addGame(gameRecord) {
        games.unshift(gameRecord);
        if (games.length > 100) {
            games = games.slice(0, 100);
        }
        saveToStorage();
    }

    function getGames(limit = 50) {
        return games.slice(0, limit);
    }

    function getStats() {
        const stats = {
            total: games.length,
            wins: 0,
            losses: 0,
            draws: 0
        };
        
        games.forEach(g => {
            if (g.result === 'win') stats.wins++;
            else if (g.result === 'lose') stats.losses++;
            else if (g.result === 'draw') stats.draws++;
        });
        
        return stats;
    }

    function renderHistoryList(container, currentAddress) {
        if (games.length === 0) {
            container.innerHTML = `
                <div class="empty-state">
                    <span class="empty-icon">📭</span>
                    <p>暂无对局记录</p>
                </div>
            `;
            return;
        }

        const html = games.slice(0, 50).map(game => {
            const isWin = game.result === 'win';
            const isDraw = game.result === 'draw';
            const resultClass = isWin ? 'win' : (isDraw ? 'draw' : 'lose');
            const resultText = isWin ? '胜利' : (isDraw ? '平局' : '失败');
            const resultClass2 = isWin ? 'result-win' : (isDraw ? 'result-draw' : 'result-lose');
            
            const myChoiceEmoji = game.myChoice ? RPSCrypto.getChoiceEmoji(game.myChoice) : '❓';
            const opponentChoiceEmoji = game.opponentChoice ? RPSCrypto.getChoiceEmoji(game.opponentChoice) : '❓';
            
            return `
                <div class="history-item ${resultClass2}" data-game-id="${game.gameId}">
                    <div class="history-choice">${myChoiceEmoji}${opponentChoiceEmoji}</div>
                    <div class="history-info">
                        <div class="history-vs">对局 #${game.gameId}</div>
                        <div class="history-amount">${game.amount} ${game.token || 'USDC'}</div>
                    </div>
                    <div class="history-result ${resultClass}">${resultText}</div>
                </div>
            `;
        }).join('');

        container.innerHTML = html;
    }

    function clear() {
        games = [];
        saveToStorage();
    }

    async function syncFromChain(playerAddress) {
        if (!playerAddress || !Contract.getContract()) return [];

        try {
            let gameIds = [];
            try {
                gameIds = await Contract.getPlayerGames(playerAddress);
            } catch (e) {
                // 链上无对局记录时返回 0x，解码失败属正常情况
                console.warn('getPlayerGames 返回空数据（可能无对局记录）:', e.message);
                return [];
            }
            if (!gameIds || gameIds.length === 0) return [];

            const newGames = [];

            for (const gameId of gameIds.slice(-20).reverse()) {
                try {
                    const game = await Contract.getGame(gameId);
                    const isPlayer1 = game.player1.toLowerCase() === playerAddress.toLowerCase();
                    const myChoice = isPlayer1 ? game.choice1 : game.choice2;
                    const opponentChoice = isPlayer1 ? game.choice2 : game.choice1;
                    
                    let result = 'playing';
                    if (game.status === 3) {
                        if (game.isDraw) {
                            result = 'draw';
                        } else if (game.winner) {
                            result = game.winner.toLowerCase() === playerAddress.toLowerCase() ? 'win' : 'lose';
                        }
                    }
                    
                    if (myChoice || opponentChoice) {
                        newGames.push({
                            gameId,
                            myChoice,
                            opponentChoice,
                            amount: game.amount,
                            token: game.token,
                            result,
                            timestamp: Math.floor(Date.now() / 1000)
                        });
                    }
                } catch (e) {
                    continue;
                }
            }
            
            if (newGames.length > 0) {
                games = newGames;
                saveToStorage();
            }
            
            return newGames;
        } catch (e) {
            console.error('同步链上历史失败:', e);
            return [];
        }
    }

    async function syncFromBackend(playerAddress, page = 1, size = 50) {
        if (!playerAddress) return [];
        try {
            const res = await fetch(CONFIG.backendUrl + `/api/player/${playerAddress}/games?page=${page}&size=${size}`);
            if (res.ok) {
                const data = await res.json();
                const newGames = data.games.map(g => ({
                    gameId: g.game_id || g.id,
                    myChoice: g.player1_choice,
                    opponentChoice: g.player2_choice,
                    amount: g.amount || 0,
                    token: g.token || 'USDC',
                    result: g.result || (g.winner ? (g.winner.toLowerCase() === playerAddress.toLowerCase() ? 'win' : 'lose') : 'playing'),
                    timestamp: g.created_at ? new Date(g.created_at).getTime() / 1000 : Date.now() / 1000
                }));
                if (newGames.length > 0) {
                    games = newGames;
                    saveToStorage();
                }
                return newGames;
            }
        } catch (e) {
            console.warn('从后端同步历史失败:', e);
        }
        return [];
    }

    return {
        loadFromStorage,
        addGame,
        getGames,
        getStats,
        renderHistoryList,
        clear,
        syncFromChain,
        syncFromBackend
    };
})();
