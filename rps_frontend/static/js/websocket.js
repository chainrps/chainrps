// WebSocket通信模块
// 增强版：心跳保活、指数退避重连、房间/对局订阅、消息上行
const GameSocket = (function() {
    let ws = null;
    let playerAddress = null;
    let wsBaseUrl = null;
    let reconnectAttempts = 0;
    const MAX_RECONNECT_ATTEMPTS = 10;
    const BASE_RECONNECT_DELAY = 1000; // 1s 起步
    const MAX_RECONNECT_DELAY = 15000; // 上限 15s
    let isManuallyClosed = false;

    // 心跳配置
    const HEARTBEAT_INTERVAL = 25000; // 25s 发送一次 ping
    let heartbeatTimer = null;
    let lastPongTime = 0;
    // 心跳超时阈值：超过 60s 未收到 pong，认为连接已死，主动断开重连
    const PONG_TIMEOUT = 60000;

    // 当前订阅的房间和对局（重连后自动重新订阅）
    let subscribedRoomId = null;
    let subscribedGameIds = new Set();

    const listeners = {};

    // 获取指定事件的监听器列表
    function _getListeners(event) {
        if (!listeners[event]) {
            listeners[event] = [];
        }
        return listeners[event];
    }

    // 注册事件监听器
    function on(event, callback) {
        _getListeners(event).push(callback);
    }

    // 注册一次性事件监听器
    function once(event, callback) {
        // 一次性监听器包装函数
        const wrapper = (...args) => {
            off(event, wrapper);
            callback(...args);
        };
        on(event, wrapper);
    }

    // 移除事件监听器
    function off(event, callback) {
        const list = listeners[event];
        if (list) {
            listeners[event] = list.filter(cb => cb !== callback);
        }
    }

    // 触发事件
    function emit(event, ...args) {
        const list = listeners[event];
        if (list) {
            list.forEach(cb => cb(...args));
        }
    }

    // 启动心跳定时器
    function _startHeartbeat() {
        _stopHeartbeat();
        lastPongTime = Date.now();
        heartbeatTimer = setInterval(() => {
            if (!ws || ws.readyState !== WebSocket.OPEN) {
                return;
            }
            // 检查 pong 是否超时
            if (Date.now() - lastPongTime > PONG_TIMEOUT) {
                console.warn('[GameSocket] 心跳超时，主动断开重连');
                try { ws.close(); } catch (_) {}
                return;
            }
            // 发送 ping
            send({ type: 'ping' });
        }, HEARTBEAT_INTERVAL);
    }

    // 停止心跳定时器
    function _stopHeartbeat() {
        if (heartbeatTimer) {
            clearInterval(heartbeatTimer);
            heartbeatTimer = null;
        }
    }

    // 计算指数退避延迟
    function _getReconnectDelay() {
        // 1s, 2s, 4s, 8s, 15s, 15s, ...（上限 15s）
        const delay = BASE_RECONNECT_DELAY * Math.pow(2, reconnectAttempts);
        return Math.min(delay, MAX_RECONNECT_DELAY);
    }

    // 重连后自动恢复订阅
    function _resubscribe() {
        if (!ws || ws.readyState !== WebSocket.OPEN) return;
        if (subscribedRoomId) {
            send({ type: 'subscribe_room', room_id: subscribedRoomId });
        }
        subscribedGameIds.forEach((gid) => {
            send({ type: 'subscribe_game', game_id: gid });
        });
    }

    // 连接WebSocket服务器
    function connect(wsUrl, address) {
        if (!address) {
            throw new Error('玩家地址不能为空');
        }

        playerAddress = address;
        wsBaseUrl = wsUrl;
        isManuallyClosed = false;

        const url = `${wsUrl.replace('http', 'ws').replace('https', 'wss')}/ws/${address}`;

        try {
            ws = new WebSocket(url);
        } catch (e) {
            emit('error', e);
            return null;
        }

        // WebSocket连接打开回调
        ws.onopen = () => {
            reconnectAttempts = 0;
            emit('open');
            // 启动心跳
            _startHeartbeat();
            // 自动恢复订阅
            _resubscribe();
        };

        // WebSocket连接关闭回调
        ws.onclose = (event) => {
            _stopHeartbeat();
            emit('close', event);

            if (!isManuallyClosed && reconnectAttempts < MAX_RECONNECT_ATTEMPTS) {
                const delay = _getReconnectDelay();
                reconnectAttempts++;
                console.log(`[GameSocket] 将在 ${delay}ms 后重连（第 ${reconnectAttempts} 次）`);
                setTimeout(() => {
                    if (!isManuallyClosed) {
                        connect(wsBaseUrl, address);
                    }
                }, delay);
            } else if (reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
                emit('reconnect_failed');
                console.error('[GameSocket] 达到最大重连次数，停止重连');
            }
        };

        // WebSocket错误回调
        ws.onerror = (error) => {
            emit('error', error);
        };

        // WebSocket消息接收回调
        ws.onmessage = (event) => {
            try {
                const data = JSON.parse(event.data);
                emit('message', data);

                // 处理 pong 心跳响应
                if (data.type === 'pong') {
                    lastPongTime = Date.now();
                    return;
                }

                if (data.type) {
                    emit(data.type, data.data || data);
                }
            } catch (e) {
                emit('message', event.data);
            }
        };

        return ws;
    }

    // 断开WebSocket连接
    function disconnect() {
        isManuallyClosed = true;
        _stopHeartbeat();
        if (ws) {
            ws.close();
            ws = null;
        }
    }

    // 发送消息
    function send(data) {
        if (!ws || ws.readyState !== WebSocket.OPEN) {
            return false;
        }

        try {
            ws.send(JSON.stringify(data));
            return true;
        } catch (e) {
            emit('error', e);
            return false;
        }
    }

    // 订阅房间（重连后自动恢复）
    function subscribeRoom(roomId) {
        subscribedRoomId = roomId;
        return send({ type: 'subscribe_room', room_id: roomId });
    }

    // 取消订阅房间
    function unsubscribeRoom() {
        if (subscribedRoomId) {
            send({ type: 'unsubscribe_room', room_id: subscribedRoomId });
            subscribedRoomId = null;
        }
    }

    // 订阅对局（重连后自动恢复）
    function subscribeGame(gameId) {
        subscribedGameIds.add(gameId);
        return send({ type: 'subscribe_game', game_id: gameId });
    }

    // 取消订阅对局
    function unsubscribeGame(gameId) {
        if (subscribedGameIds.has(gameId)) {
            send({ type: 'unsubscribe_game', game_id: gameId });
            subscribedGameIds.delete(gameId);
        }
    }

    // 检查是否已连接
    function isConnected() {
        return ws && ws.readyState === WebSocket.OPEN;
    }

    // 注入外部消息（用于 P2P 通道消息复用 WS 事件监听器）
    // P2P 收到消息后调用此方法，即可触发所有已注册的 WS 事件监听器
    function inject(type, data) {
        if (!type) return;
        const msg = { type, data: data || {}, timestamp: Date.now() };
        emit('message', msg);
        emit(type, data || {});
    }

    // 获取连接状态
    function getReadyState() {
        return ws ? ws.readyState : WebSocket.CLOSED;
    }

    // 返回WebSocket相关函数
    return {
        connect,
        disconnect,
        send,
        isConnected,
        getReadyState,
        inject,
        on,
        once,
        off,
        subscribeRoom,
        unsubscribeRoom,
        subscribeGame,
        unsubscribeGame
    };
})();
