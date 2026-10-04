// P2P 通信模块（WebRTC 数据通道 + WS 信令中转）
// 用于房间内两个玩家之间的私密实时通信，后端仅转发信令，不接触游戏数据。
// 接口与 GameSocket 兼容（on/once/off/send/emit），便于 app.js 双通道智能切换。
//
// 协商策略：
//   - 后连接信令的玩家会收到 peer_joined，由其主动创建 offer（initiator）
//   - 先连接的玩家被动应答 answer（responder）
//   - 使用 "polite" 策略避免 glare 冲突
const P2PChannel = (function () {
    // ============ 配置 ============
    const ICE_SERVERS = [
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'stun:stun1.l.google.com:19302' },
    ];
    const HEARTBEAT_INTERVAL = 20000;   // 数据通道心跳 20s
    const PONG_TIMEOUT = 45000;         // 45s 未收到 pong 视为断连
    const SIGNALING_RECONNECT_DELAY = 2000;
    const MAX_SIGNALING_RECONNECT = 5;
    const DATA_CHANNEL_LABEL = 'game';
    const RECONNECT_DELAY = 3000;       // P2P 断开后重试间隔
    const MAX_P2P_RECONNECT = 3;        // P2P 最大重连次数

    // ============ 状态 ============
    let signalingWs = null;
    let pc = null;                      // RTCPeerConnection
    let dc = null;                      // 数据通道（发送方侧创建）
    let receiveDc = null;               // 数据通道（接收方侧引用）
    let playerAddress = null;
    let roomId = null;
    let wsBaseUrl = null;
    let isManuallyClosed = false;
    let isInitiator = false;            // 是否为 offer 创建方
    let isConnected = false;            // 数据通道是否就绪
    let signalingReady = false;
    let reconnectAttempts = 0;
    let signalingReconnectAttempts = 0;

    // 心跳
    let heartbeatTimer = null;
    let lastPongTime = 0;

    // 重连定时器
    let reconnectTimer = null;
    let signalingReconnectTimer = null;

    // 协商防冲突：双方同时创建 offer 时，polite 方让步
    const isPolite = true; // 本端固定为 polite，简化逻辑（实际可基于地址比较）

    // 事件监听
    const listeners = {};

    // 缓存的待发送消息（数据通道未就绪时）
    let pendingMessages = [];

    // ============ 事件系统 ============
    function _getListeners(event) {
        if (!listeners[event]) listeners[event] = [];
        return listeners[event];
    }

    function on(event, callback) {
        _getListeners(event).push(callback);
    }

    function once(event, callback) {
        const wrapper = (...args) => {
            off(event, wrapper);
            callback(...args);
        };
        on(event, wrapper);
    }

    function off(event, callback) {
        const list = listeners[event];
        if (list) {
            listeners[event] = list.filter(cb => cb !== callback);
        }
    }

    function emit(event, ...args) {
        const list = listeners[event];
        if (list) list.forEach(cb => cb(...args));
    }

    // ============ 信令 WebSocket ============
    function _buildSignalingUrl() {
        if (!wsBaseUrl || !roomId || !playerAddress) return null;
        const wsScheme = wsBaseUrl.startsWith('https') ? 'wss' : (wsBaseUrl.startsWith('http') ? 'ws' : '');
        const base = wsScheme ? wsBaseUrl.replace(/^https?/, wsScheme) : wsBaseUrl;
        return `${base}/ws/signaling/${roomId}/${playerAddress}`;
    }

    function _connectSignaling() {
        const url = _buildSignalingUrl();
        if (!url) {
            console.warn('[P2P] 缺少参数，无法连接信令');
            return;
        }

        try {
            signalingWs = new WebSocket(url);
        } catch (e) {
            console.error('[P2P] 信令 WebSocket 创建失败:', e);
            emit('error', e);
            _scheduleSignalingReconnect();
            return;
        }

        signalingWs.onopen = () => {
            signalingReady = true;
            signalingReconnectAttempts = 0;
            console.log('[P2P] 信令通道已连接');
            emit('signaling_open');
        };

        signalingWs.onclose = () => {
            signalingReady = false;
            console.log('[P2P] 信令通道关闭');
            emit('signaling_close');
            if (!isManuallyClosed) {
                _scheduleSignalingReconnect();
            }
        };

        signalingWs.onerror = (err) => {
            console.error('[P2P] 信令通道错误:', err);
            emit('error', err);
        };

        signalingWs.onmessage = (event) => {
            try {
                const msg = JSON.parse(event.data);
                _handleSignalingMessage(msg);
            } catch (e) {
                console.warn('[P2P] 信令消息解析失败:', e);
            }
        };
    }

    function _scheduleSignalingReconnect() {
        if (isManuallyClosed) return;
        if (signalingReconnectAttempts >= MAX_SIGNALING_RECONNECT) {
            console.error('[P2P] 信令重连次数已达上限');
            emit('signaling_failed');
            return;
        }
        signalingReconnectAttempts++;
        if (signalingReconnectTimer) clearTimeout(signalingReconnectTimer);
        signalingReconnectTimer = setTimeout(() => {
            if (!isManuallyClosed) {
                console.log(`[P2P] 信令重连第 ${signalingReconnectAttempts} 次`);
                _connectSignaling();
            }
        }, SIGNALING_RECONNECT_DELAY);
    }

    function _sendSignaling(data) {
        if (!signalingWs || signalingWs.readyState !== WebSocket.OPEN) return false;
        try {
            signalingWs.send(JSON.stringify(data));
            return true;
        } catch (e) {
            console.error('[P2P] 发送信令失败:', e);
            return false;
        }
    }

    // ============ 信令消息处理 ============
    async function _handleSignalingMessage(msg) {
        const type = msg.type;
        const data = msg.data || {};

        if (type === 'peer_joined') {
            // 对端加入，由本端主动创建 offer
            console.log('[P2P] 对端加入房间，本端作为发起方创建 offer');
            isInitiator = true;
            await _createOffer();
        } else if (type === 'peer_left') {
            console.log('[P2P] 对端离开房间');
            _handlePeerLeft();
        } else if (type === 'offer') {
            console.log('[P2P] 收到 offer');
            await _handleOffer(data);
        } else if (type === 'answer') {
            console.log('[P2P] 收到 answer');
            await _handleAnswer(data);
        } else if (type === 'candidate') {
            console.log('[P2P] 收到 ICE candidate');
            await _handleCandidate(data);
        } else if (type === 'bye') {
            console.log('[P2P] 对端主动关闭');
            _handlePeerLeft();
        }
    }

    // ============ WebRTC 连接管理 ============
    function _createPeerConnection() {
        if (pc) {
            try { pc.close(); } catch (_) {}
            pc = null;
        }

        const config = { iceServers: ICE_SERVERS };
        pc = new RTCPeerConnection(config);

        // ICE candidate 收集后通过信令转发
        pc.onicecandidate = (event) => {
            if (event.candidate) {
                _sendSignaling({
                    type: 'candidate',
                    candidate: event.candidate.candidate,
                    sdpMid: event.candidate.sdpMid,
                    sdpMLineIndex: event.candidate.sdpMLineIndex,
                });
            }
        };

        // 连接状态变化
        pc.onconnectionstatechange = () => {
            const state = pc ? pc.connectionState : 'closed';
            console.log('[P2P] 连接状态:', state);
            if (state === 'connected') {
                // 数据通道就绪
            } else if (state === 'disconnected' || state === 'failed') {
                _handleP2PDisconnect();
            } else if (state === 'closed') {
                _handleP2PDisconnect();
            }
        };

        // 数据通道（接收方侧，对端创建的 dc）
        pc.ondatachannel = (event) => {
            console.log('[P2P] 收到对端数据通道');
            receiveDc = event.channel;
            _bindDataChannel(receiveDc);
        };

        return pc;
    }

    function _bindDataChannel(channel) {
        dc = channel;

        channel.onopen = () => {
            console.log('[P2P] 数据通道已打开');
            isConnected = true;
            reconnectAttempts = 0;
            _startHeartbeat();
            _flushPendingMessages();
            emit('open');
        };

        channel.onclose = () => {
            console.log('[P2P] 数据通道已关闭');
            isConnected = false;
            _stopHeartbeat();
            emit('close');
            if (!isManuallyClosed) {
                _handleP2PDisconnect();
            }
        };

        channel.onerror = (err) => {
            console.error('[P2P] 数据通道错误:', err);
            emit('error', err);
        };

        channel.onmessage = (event) => {
            try {
                const data = JSON.parse(event.data);
                // 心跳 pong 响应
                if (data.type === 'pong') {
                    lastPongTime = Date.now();
                    return;
                }
                if (data.type === 'ping') {
                    // 收到 ping 立即回 pong
                    _sendRaw({ type: 'pong' });
                    return;
                }
                // 业务消息
                emit('message', data);
                if (data.type) {
                    emit(data.type, data.data || data);
                }
            } catch (e) {
                console.warn('[P2P] 数据通道消息解析失败:', e);
                emit('message', event.data);
            }
        };
    }

    async function _createOffer() {
        if (!pc) _createPeerConnection();
        try {
            // 创建数据通道（仅发起方创建）
            if (!dc) {
                dc = pc.createDataChannel(DATA_CHANNEL_LABEL, { ordered: true });
                _bindDataChannel(dc);
            }
            const offer = await pc.createOffer();
            await pc.setLocalDescription(offer);
            _sendSignaling({ type: 'offer', sdp: offer.sdp });
        } catch (e) {
            console.error('[P2P] 创建 offer 失败:', e);
            emit('error', e);
            _handleP2PDisconnect();
        }
    }

    async function _handleOffer(data) {
        if (!pc) _createPeerConnection();
        try {
            // glare 冲突处理：如果本端也是 initiator 且不 polite，则拒绝；这里固定 polite 让步
            if (isInitiator && !isPolite) {
                console.warn('[P2P] glare 冲突，本端拒绝对端 offer');
                return;
            }
            // 如果本端正在发起但 polite，则让步，回退为 responder
            if (isInitiator && isPolite) {
                console.log('[P2P] glare 冲突，本端让步为应答方');
                isInitiator = false;
                // 回滚本地描述
                try {
                    if (pc.signalingState !== 'stable') {
                        await pc.setLocalDescription({ type: 'rollback' });
                    }
                } catch (_) {}
                // 关闭已创建的 dc（将由对端 ondatachannel 接收）
                if (dc) {
                    try { dc.close(); } catch (_) {}
                    dc = null;
                }
            }
            const offer = { type: 'offer', sdp: data.sdp };
            await pc.setRemoteDescription(offer);
            const answer = await pc.createAnswer();
            await pc.setLocalDescription(answer);
            _sendSignaling({ type: 'answer', sdp: answer.sdp });
        } catch (e) {
            console.error('[P2P] 处理 offer 失败:', e);
            emit('error', e);
        }
    }

    async function _handleAnswer(data) {
        if (!pc) return;
        try {
            const answer = { type: 'answer', sdp: data.sdp };
            await pc.setRemoteDescription(answer);
        } catch (e) {
            console.error('[P2P] 处理 answer 失败:', e);
            emit('error', e);
        }
    }

    async function _handleCandidate(data) {
        if (!pc) return;
        try {
            const candidate = new RTCIceCandidate({
                candidate: data.candidate,
                sdpMid: data.sdpMid || null,
                sdpMLineIndex: data.sdpMLineIndex !== undefined ? data.sdpMLineIndex : null,
            });
            await pc.addIceCandidate(candidate);
        } catch (e) {
            console.warn('[P2P] 添加 ICE candidate 失败:', e);
        }
    }

    function _handlePeerLeft() {
        emit('peer_left');
        _cleanupDataChannel();
        _cleanupPeerConnection();
        isConnected = false;
    }

    function _handleP2PDisconnect() {
        if (isConnected) {
            isConnected = false;
            _stopHeartbeat();
            emit('close');
        }
        if (!isManuallyClosed && reconnectAttempts < MAX_P2P_RECONNECT) {
            reconnectAttempts++;
            console.log(`[P2P] 数据通道断开，${RECONNECT_DELAY}ms 后重试（第 ${reconnectAttempts} 次）`);
            if (reconnectTimer) clearTimeout(reconnectTimer);
            reconnectTimer = setTimeout(() => {
                if (!isManuallyClosed) {
                    _retryConnection();
                }
            }, RECONNECT_DELAY);
        } else if (reconnectAttempts >= MAX_P2P_RECONNECT) {
            console.error('[P2P] 重连次数已达上限，降级到 WS');
            emit('reconnect_failed');
        }
    }

    async function _retryConnection() {
        // 清理旧连接，重新协商（不重建信令）
        _cleanupDataChannel();
        _cleanupPeerConnection();
        _createPeerConnection();
        // 等待对端发起或本端发起
        if (isInitiator) {
            await _createOffer();
        }
        // 非 initiator 等待对端 offer
    }

    // ============ 心跳 ============
    function _startHeartbeat() {
        _stopHeartbeat();
        lastPongTime = Date.now();
        heartbeatTimer = setInterval(() => {
            if (!isConnected) return;
            if (Date.now() - lastPongTime > PONG_TIMEOUT) {
                console.warn('[P2P] 心跳超时，主动断开重连');
                _handleP2PDisconnect();
                return;
            }
            _sendRaw({ type: 'ping' });
        }, HEARTBEAT_INTERVAL);
    }

    function _stopHeartbeat() {
        if (heartbeatTimer) {
            clearInterval(heartbeatTimer);
            heartbeatTimer = null;
        }
    }

    // ============ 消息发送 ============
    function _sendRaw(obj) {
        if (!dc || dc.readyState !== 'open') return false;
        try {
            dc.send(JSON.stringify(obj));
            return true;
        } catch (e) {
            console.error('[P2P] 数据通道发送失败:', e);
            return false;
        }
    }

    function send(data) {
        if (!isConnected) {
            // 缓存待发送消息，连接就绪后自动 flush
            pendingMessages.push(data);
            return false;
        }
        return _sendRaw(data);
    }

    function _flushPendingMessages() {
        if (!pendingMessages.length) return;
        const queue = pendingMessages.slice();
        pendingMessages = [];
        queue.forEach((msg) => _sendRaw(msg));
    }

    // ============ 清理 ============
    function _cleanupDataChannel() {
        if (dc) {
            try { dc.close(); } catch (_) {}
            dc = null;
        }
        receiveDc = null;
    }

    function _cleanupPeerConnection() {
        if (pc) {
            try {
                pc.onicecandidate = null;
                pc.onconnectionstatechange = null;
                pc.ondatachannel = null;
                pc.close();
            } catch (_) {}
            pc = null;
        }
    }

    function _cleanupSignaling() {
        if (signalingWs) {
            try { signalingWs.close(); } catch (_) {}
            signalingWs = null;
        }
        signalingReady = false;
    }

    // ============ 公共 API ============
    function connect(wsUrl, address, rid) {
        wsBaseUrl = wsUrl;
        playerAddress = address;
        roomId = rid;
        isManuallyClosed = false;
        reconnectAttempts = 0;
        signalingReconnectAttempts = 0;
        isInitiator = false;
        isConnected = false;
        pendingMessages = [];

        // 创建 PeerConnection
        _createPeerConnection();

        // 连接信令通道
        _connectSignaling();

        console.log(`[P2P] 开始连接房间 ${roomId}（地址: ${playerAddress}）`);
    }

    function disconnect() {
        isManuallyClosed = true;
        // 通知对端离开
        if (signalingWs && signalingWs.readyState === WebSocket.OPEN) {
            _sendSignaling({ type: 'bye', reason: 'manual_disconnect' });
        }
        _stopHeartbeat();
        if (reconnectTimer) clearTimeout(reconnectTimer);
        if (signalingReconnectTimer) clearTimeout(signalingReconnectTimer);
        _cleanupDataChannel();
        _cleanupPeerConnection();
        _cleanupSignaling();
        isConnected = false;
        isInitiator = false;
        roomId = null;
        playerAddress = null;
        wsBaseUrl = null;
        pendingMessages = [];
        console.log('[P2P] 已断开');
    }

    function isConnectedReady() {
        return isConnected;
    }

    function isSignalingReady() {
        return signalingReady;
    }

    function getRoomId() {
        return roomId;
    }

    return {
        connect,
        disconnect,
        send,
        on,
        once,
        off,
        isConnected: isConnectedReady,
        isSignalingReady,
        getRoomId,
    };
})();
