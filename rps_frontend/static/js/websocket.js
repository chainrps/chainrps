// WebSocket通信模块
const GameSocket = (function() {
    let ws = null;
    let playerAddress = null;
    let reconnectAttempts = 0;
    let maxReconnectAttempts = 5;
    let reconnectDelay = 3000;
    let isManuallyClosed = false;

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

    // 连接WebSocket服务器
    function connect(wsUrl, address) {
        if (!address) {
            throw new Error('玩家地址不能为空');
        }

        playerAddress = address;
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
        };

        // WebSocket连接关闭回调
        ws.onclose = (event) => {
            emit('close', event);

            if (!isManuallyClosed && reconnectAttempts < maxReconnectAttempts) {
                reconnectAttempts++;
                // 重连定时器回调
                setTimeout(() => {
                    if (!isManuallyClosed) {
                        connect(wsUrl, address);
                    }
                }, reconnectDelay);
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

    // 检查是否已连接
    function isConnected() {
        return ws && ws.readyState === WebSocket.OPEN;
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
        on,
        once,
        off
    };
})();
