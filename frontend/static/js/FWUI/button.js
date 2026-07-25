(function() {
    function createButton(options = {}) {
        let {
            text = '',
            type = 'default',
            size = 'medium',
            block = false,
            disabled = false,
            loading = false,
            icon = '',
            onClick = null
        } = options;

        const btn = document.createElement('button');
        btn.className = `fwui-btn fwui-btn-${type} fwui-btn-${size}`;
        btn.type = 'button';

        const typeStyles = {
            primary: `
                background: #6366f1;
                color: #fff;
                border: none;
            `,
            default: `
                background: #fff;
                color: #0f172a;
                border: 1px solid #e2e8f0;
            `,
            success: `
                background: #10b981;
                color: #fff;
                border: none;
            `,
            danger: `
                background: #ef4444;
                color: #fff;
                border: none;
            `,
            ghost: `
                background: transparent;
                color: #0f172a;
                border: none;
            `,
            link: `
                background: transparent;
                color: #6366f1;
                border: none;
                padding: 0;
            `
        };

        const sizeStyles = {
            small: 'padding: 6px 14px; font-size: 12px;',
            medium: 'padding: 10px 20px; font-size: 14px;',
            large: 'padding: 12px 28px; font-size: 16px;'
        };

        let style = `
            ${typeStyles[type] || typeStyles.default}
            ${sizeStyles[size] || sizeStyles.medium}
            border-radius: 10px;
            font-weight: 500;
            cursor: pointer;
            transition: all 0.15s ease;
            display: inline-flex;
            align-items: center;
            justify-content: center;
            gap: 8px;
            white-space: nowrap;
            ${block ? 'width: 100%;' : ''}
        `;

        btn.style.cssText = style;

        function updateContent() {
            let content = '';
            if (loading) {
                content += `<span class="fwui-btn-loading" style="
                    width: 14px;
                    height: 14px;
                    border: 2px solid currentColor;
                    border-top-color: transparent;
                    border-radius: 50%;
                    animation: fwui-spin 0.8s linear infinite;
                    display: inline-block;
                "></span>`;
            } else if (icon) {
                content += `<span class="fwui-btn-icon">${icon}</span>`;
            }
            content += `<span>${text}</span>`;
            btn.innerHTML = content;
        }

        updateContent();

        if (disabled) {
            btn.disabled = true;
            btn.style.opacity = '0.5';
            btn.style.cursor = 'not-allowed';
        }

        if (onClick && !disabled) {
            btn.addEventListener('click', onClick);
        }

        btn.addEventListener('mouseenter', () => {
            if (!btn.disabled) {
                if (type === 'primary') {
                    btn.style.background = '#4f46e5';
                } else if (type === 'default') {
                    btn.style.background = '#f1f5f9';
                }
            }
        });

        btn.addEventListener('mouseleave', () => {
            if (!btn.disabled) {
                if (type === 'primary') {
                    btn.style.background = '#6366f1';
                } else if (type === 'default') {
                    btn.style.background = '#fff';
                }
            }
        });

        function setText(newText) {
            text = newText;
            updateContent();
        }

        function setLoading(isLoading) {
            loading = isLoading;
            btn.disabled = isLoading;
            updateContent();
        }

        function setDisabled(isDisabled) {
            btn.disabled = isDisabled;
            btn.style.opacity = isDisabled ? '0.5' : '1';
            btn.style.cursor = isDisabled ? 'not-allowed' : 'pointer';
        }

        return {
            element: btn,
            setText,
            setLoading,
            setDisabled
        };
    }

    if (typeof FWUI !== 'undefined') {
        FWUI.Button = { create: createButton };
    } else {
        window.FWUI = window.FWUI || {};
        window.FWUI.Button = { create: createButton };
    }

    if (typeof module !== 'undefined' && module.exports) {
        module.exports = { create: createButton };
    }
})();

if (typeof document !== 'undefined') {
    const style = document.createElement('style');
    style.textContent = `
        @keyframes fwui-spin {
            to { transform: rotate(360deg); }
        }
    `;
    document.head.appendChild(style);
}