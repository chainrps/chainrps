const GameSocket = (function() {
    let ws = null;
    let playerAddress = null;
    let reconnectAttempts = 0;
    let maxReconnectAttempts = 5;
    let reconnectDelay = 3000;
    let isManuallyClosed = false;

    const listeners = {
        open: [],
        close: [],
        error: [],
        message: [],
        matched: [],
        opponent_joined: [],
        opponent_committed: [],
        opponent_revealed: [],
        game_settled: [],
        timeout_warning: [],
        heartbeat: []
    };

    function on(event, callback) {
        if (listeners[event]) {
            listeners[event].push(callback);
        }
    }

    function off(event, callback) {
        if (listeners[event]) {
            listeners[event] = listeners[event].filter(cb => cb !== callback);
        }
    }

    function emit(event, ...args) {
        if (listeners[event]) {
            listeners[event].forEach(cb => cb(...args));
        }
    }

    function connect(wsUrl, address) {
        if (!address) {
            throw new Error('玩家地址不能为空');
        }

        playerAddress = address;
        isManuallyClosed = false;

        const url = `${wsUrl.replace('http', 'ws').replace('https', 'wss')}/api/ws/${address}`;

        try {
            ws = new WebSocket(url);
        } catch (e) {
            emit('error', e);
            return null;
        }

        ws.onopen = () => {
            reconnectAttempts = 0;
            emit('open');
        };

        ws.onclose = (event) => {
            emit('close', event);
            
            if (!isManuallyClosed && reconnectAttempts < maxReconnectAttempts) {
                reconnectAttempts++;
                setTimeout(() => {
                    if (!isManuallyClosed) {
                        connect(wsUrl, address);
                    }
                }, reconnectDelay);
            }
        };

        ws.onerror = (error) => {
            emit('error', error);
        };

        ws.onmessage = (event) => {
            try {
                const data = JSON.parse(event.data);
                emit('message', data);
                
                if (data.type) {
                    emit(data.type, data.data || data);
                }
            } catch (e) {
                emit('message', event.data);
            }
        };

        return ws;
    }

    function disconnect() {
        isManuallyClosed = true;
        if (ws) {
            ws.close();
            ws = null;
        }
    }

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

    function isConnected() {
        return ws && ws.readyState === WebSocket.OPEN;
    }

    function getReadyState() {
        return ws ? ws.readyState : WebSocket.CLOSED;
    }

    return {
        connect,
        disconnect,
        send,
        isConnected,
        getReadyState,
        on,
        off
    };
})();
