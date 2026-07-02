/**
 * WebSocket 连接管理
 * 用于接收后端实时推送
 */

class WebSocketManager {
    constructor() {
        this.ws = null;
        this.isConnected = false;
        this.reconnectAttempts = 0;
        this.maxReconnectAttempts = 5;
        this.reconnectDelay = 3000;
        
        // WebSocket 服务器地址
        this.serverUrl = null; // 部署后设置，如 'ws://localhost:8000/api/ws/'
        
        // 心跳定时器
        this.heartbeatTimer = null;
        this.heartbeatInterval = 30000;
        
        // 消息回调
        this.callbacks = {};
    }

    /**
     * 设置服务器地址
     */
    setServerUrl(url) {
        this.serverUrl = url;
    }

    /**
     * 连接 WebSocket
     */
    connect(playerAddress) {
        if (!this.serverUrl) {
            console.warn('WebSocket server URL not set');
            return;
        }
        
        const wsUrl = `${this.serverUrl}${playerAddress}`;
        
        try {
            this.ws = new WebSocket(wsUrl);
            
            this.ws.onopen = () => {
                console.log('WebSocket connected');
                this.isConnected = true;
                this.reconnectAttempts = 0;
                this.startHeartbeat();
                this.callbacks.onConnect?.();
            };
            
            this.ws.onmessage = (event) => {
                try {
                    const message = JSON.parse(event.data);
                    this.handleMessage(message);
                } catch (error) {
                    console.error('WebSocket message parse error:', error);
                }
            };
            
            this.ws.onclose = () => {
                console.log('WebSocket closed');
                this.isConnected = false;
                this.stopHeartbeat();
                this.callbacks.onDisconnect?.();
                this.attemptReconnect(playerAddress);
            };
            
            this.ws.onerror = (error) => {
                console.error('WebSocket error:', error);
                this.callbacks.onError?.(error);
            };
            
        } catch (error) {
            console.error('WebSocket connection error:', error);
        }
    }

    /**
     * 断开连接
     */
    disconnect() {
        if (this.ws) {
            this.ws.close();
            this.ws = null;
        }
        
        this.isConnected = false;
        this.stopHeartbeat();
    }

    /**
     * 发送消息
     */
    send(type, data) {
        if (!this.ws || !this.isConnected) {
            console.warn('WebSocket not connected');
            return false;
        }
        
        try {
            const message = JSON.stringify({
                type: type,
                data: data,
                timestamp: Date.now()
            });
            
            this.ws.send(message);
            return true;
        } catch (error) {
            console.error('WebSocket send error:', error);
            return false;
        }
    }

    /**
     * 处理接收到的消息
     */
    handleMessage(message) {
        const { type, data, timestamp } = message;
        
        switch (type) {
            case 'connected':
                console.log('WebSocket connection confirmed');
                break;
                
            case 'heartbeat':
            case 'pong':
                // 心跳响应
                break;
                
            case 'match_success':
                this.callbacks.onMatchSuccess?.(data);
                break;
                
            case 'opponent_commit':
                this.callbacks.onOpponentCommit?.(data);
                break;
                
            case 'reveal_start':
                this.callbacks.onRevealStart?.(data);
                break;
                
            case 'opponent_reveal':
                this.callbacks.onOpponentReveal?.(data);
                break;
                
            case 'game_result':
            case 'game_win':
            case 'game_loss':
            case 'game_draw':
                this.callbacks.onGameResult?.(data);
                break;
                
            case 'timeout_warning':
                this.callbacks.onTimeoutWarning?.(data);
                break;
                
            case 'timeout_win':
            case 'timeout_loss':
            case 'timeout_draw':
                this.callbacks.onTimeoutResult?.(data);
                break;
                
            default:
                console.log('Unknown message type:', type);
        }
    }

    /**
     * 开始心跳
     */
    startHeartbeat() {
        this.heartbeatTimer = setInterval(() => {
            this.send('ping', {});
        }, this.heartbeatInterval);
    }

    /**
     * 停止心跳
     */
    stopHeartbeat() {
        if (this.heartbeatTimer) {
            clearInterval(this.heartbeatTimer);
            this.heartbeatTimer = null;
        }
    }

    /**
     * 尝试重连
     */
    attemptReconnect(playerAddress) {
        if (this.reconnectAttempts >= this.maxReconnectAttempts) {
            console.log('Max reconnect attempts reached');
            return;
        }
        
        this.reconnectAttempts++;
        
        console.log(`Attempting reconnect (${this.reconnectAttempts}/${this.maxReconnectAttempts})...`);
        
        setTimeout(() => {
            this.connect(playerAddress);
        }, this.reconnectDelay);
    }

    /**
     * 设置回调函数
     */
    setCallbacks(callbacks) {
        this.callbacks = callbacks;
    }

    /**
     * 订阅特定对局
     */
    subscribeGame(gameId) {
        this.send('subscribe_game', { game_id: gameId });
    }
}

const wsManager = new WebSocketManager();