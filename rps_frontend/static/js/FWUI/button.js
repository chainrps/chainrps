/**
 * FWUI Button v2 — 5 态状态机 + CSS 变量
 *
 * 5 态语义：
 *   idle      主按钮默认状态，渐变主色
 *   loading   网络请求中，Spinner + 禁用
 *   approved  已完成前置操作（如 Approval），次色提示
 *   error     错误，红框 + 错误文字直接内嵌按钮
 *   success   成功，绿框，自动消失
 *
 * 使用：
 *   FWUI.Button.create({ text: '开始对局', state: 'idle', onClick: ... })
 *   btn.setState('loading')
 *   btn.setState('error', '余额不足 · 需充值 50 USDC')
 */
(function() {
    // 状态样式映射（全部引用 CSS 变量，主题切换自动适配）
    const STATE_CSS = {
        idle: {
            background: 'var(--btn-bg-idle)',
            color: 'var(--btn-text-idle)',
            border: 'none',
            cursor: 'pointer',
            opacity: 1,
            disabled: false,
        },
        loading: {
            background: 'var(--btn-bg-loading)',
            color: 'var(--btn-text-loading)',
            border: 'none',
            cursor: 'not-allowed',
            opacity: 0.7,
            disabled: true,
            spinner: true,
        },
        approved: {
            background: 'var(--btn-bg-approved)',
            color: 'var(--btn-text-approved)',
            border: '1px solid var(--btn-border-approved)',
            cursor: 'default',
            opacity: 1,
            disabled: false,
        },
        error: {
            background: 'var(--btn-bg-error)',
            color: 'var(--btn-text-error)',
            border: '1px solid var(--btn-border-error)',
            cursor: 'pointer',
            opacity: 1,
            disabled: false,
        },
        success: {
            background: 'var(--btn-bg-success)',
            color: 'var(--btn-text-success)',
            border: '1px solid var(--btn-border-success)',
            cursor: 'default',
            opacity: 1,
            disabled: false,
            autoReset: true,
            resetAfter: 1500,
        },
    };

    const SIZE_STYLES = {
        small: 'padding: 6px 14px; font-size: 12px;',
        medium: 'padding: 10px 20px; font-size: 14px;',
        large: 'padding: 12px 28px; font-size: 16px;',
    };

    function applyState(btn, state, textOverride, originalText) {
        const s = STATE_CSS[state] || STATE_CSS.idle;
        btn.dataset.state = state;
        btn.style.background = s.background;
        btn.style.color = s.color;
        btn.style.border = s.border;
        btn.style.cursor = s.cursor;
        btn.style.opacity = s.opacity;
        btn.disabled = !!s.disabled;
        btn.style.boxShadow = (state === 'idle') ? '0 4px 16px rgba(var(--primary-rgb), 0.25)' : 'none';

        const displayText = textOverride !== undefined ? textOverride : originalText;

        let inner = '';
        if (s.spinner) {
            inner += `<span style="width:14px;height:14px;border:2px solid currentColor;border-top-color:transparent;border-radius:50%;animation:fwui-spin .7s linear infinite;display:inline-block;"></span>`;
        }
        if (state === 'success') {
            inner += `<span style="font-weight:700;">✓</span> `;
        }
        inner += `<span>${displayText}</span>`;
        btn.innerHTML = inner;

        if (s.autoReset && s.resetAfter) {
            setTimeout(() => {
                applyState(btn, 'idle', undefined, originalText);
            }, s.resetAfter);
        }
    }

    function createButton(options = {}) {
        const {
            text = '',
            size = 'medium',
            state = 'idle',
            block = false,
            icon = '',
            onClick = null,
            onError = null,
        } = options;

        const btn = document.createElement('button');
        btn.className = 'fwui-btn';
        btn.type = 'button';

        btn.style.cssText = `
            border-radius: 10px;
            font-weight: 600;
            transition: all var(--transition-fast);
            display: inline-flex;
            align-items: center;
            justify-content: center;
            gap: 8px;
            white-space: nowrap;
            ${SIZE_STYLES[size] || SIZE_STYLES.medium}
            ${block ? 'width:100%;' : ''}
        `;

        btn.dataset.state = state;
        btn.dataset.originalText = text;

        // 应用初始状态
        applyState(btn, state, undefined, text);

        // hover 效果（仅 idle + error 态有）
        btn.addEventListener('mouseenter', () => {
            const cur = btn.dataset.state;
            if (cur === 'idle') {
                btn.style.transform = 'translateY(-1px)';
                btn.style.boxShadow = '0 6px 20px rgba(var(--primary-rgb), 0.35)';
            }
        });
        btn.addEventListener('mouseleave', () => {
            const cur = btn.dataset.state;
            if (cur === 'idle') {
                btn.style.transform = 'translateY(0)';
                btn.style.boxShadow = '0 4px 16px rgba(var(--primary-rgb), 0.25)';
            }
        });

        // 点击事件（error 态触发 onError 回调）
        btn.addEventListener('click', () => {
            const cur = btn.dataset.state;
            if (cur === 'error' && onError) {
                onError();
                return;
            }
            if (cur === 'idle' || cur === 'approved') {
                if (onClick) onClick();
            }
        });

        function setState(newState, textOverride) {
            applyState(btn, newState, textOverride, btn.dataset.originalText);
            return api;
        }
        function setText(newText) {
            btn.dataset.originalText = newText;
            applyState(btn, btn.dataset.state, undefined, newText);
            return api;
        }
        function loading(isLoading) {
            setState(isLoading ? 'loading' : 'idle');
            return api;
        }
        function success(textOverride) {
            setState('success', textOverride);
            return api;
        }
        function error(textOverride) {
            setState('error', textOverride);
            return api;
        }

        const api = {
            element: btn,
            setState, setText, loading, success, error,
            // 向后兼容
            setDisabled: (v) => { btn.disabled = v; btn.style.opacity = v ? '0.5' : '1'; return api; },
            setLoading: (v) => loading(v),
        };
        return api;
    }

    window.FWUI = window.FWUI || {};
    window.FWUI.Button = { create: createButton };

    if (typeof module !== 'undefined' && module.exports) {
        module.exports = { create: createButton };
    }
})();
