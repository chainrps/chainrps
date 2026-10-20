/**
 * FWUI Input v2 — CSS 变量
 *
 * 变体：type="text"（普通）、type="amount"（等宽+右对齐）、type="address"（长地址）
 */
(function() {
    const SIZE_STYLES = {
        small: 'padding: 6px 12px; font-size: 12px;',
        medium: 'padding: 10px 14px; font-size: 14px;',
        large: 'padding: 12px 16px; font-size: 16px;',
    };

    function createInput(options = {}) {
        const {
            type = 'text',
            inputType = 'text',
            placeholder = '',
            value = '',
            size = 'medium',
            disabled = false,
            prefix = '',
            suffix = '',
            maxLength = null,
            onChange = null,
            onInput = null,
            onFocus = null,
            onBlur = null,
        } = options;

        const wrapper = document.createElement('div');
        wrapper.style.cssText = `
            display:flex; align-items:center;
            border:1px solid var(--fwui-border-input);
            border-radius:10px;
            background:var(--fwui-bg-input);
            transition:all var(--transition-fast);
            position:relative;
        `;

        const input = document.createElement('input');
        input.type = inputType;
        input.className = 'fwui-input';
        input.placeholder = placeholder;
        input.value = value;

        let extra = '';
        if (type === 'amount') {
            extra = 'font-family:var(--fwui-font-mono, JetBrains Mono, Consolas, monospace); font-variant-numeric:tabular-nums; text-align:right;';
        } else if (type === 'address') {
            extra = 'font-family:var(--fwui-font-mono, JetBrains Mono, Consolas, monospace);';
        }

        input.style.cssText = `
            flex:1; border:none; outline:none; background:transparent;
            color:var(--text-heading);
            ${SIZE_STYLES[size] || SIZE_STYLES.medium}
            min-width:0;
            ${extra}
        `;

        if (disabled) {
            input.disabled = true;
            wrapper.style.opacity = '0.5';
            wrapper.style.cursor = 'not-allowed';
        }
        if (maxLength) input.maxLength = maxLength;

        if (prefix) {
            const p = document.createElement('span');
            p.style.cssText = 'padding-left:14px; color:var(--text-label); display:flex; align-items:center; flex-shrink:0;';
            p.innerHTML = prefix;
            wrapper.appendChild(p);
        }

        wrapper.appendChild(input);

        if (suffix) {
            const s = document.createElement('span');
            s.style.cssText = 'padding-right:14px; color:var(--text-label); display:flex; align-items:center; flex-shrink:0;';
            s.innerHTML = suffix;
            wrapper.appendChild(s);
        }

        input.addEventListener('focus', () => {
            wrapper.style.borderColor = 'var(--fwui-border-input-focus)';
            wrapper.style.boxShadow = '0 0 0 3px rgba(var(--primary-rgb), 0.15)';
            if (onFocus) onFocus();
        });
        input.addEventListener('blur', () => {
            wrapper.style.borderColor = 'var(--fwui-border-input)';
            wrapper.style.boxShadow = 'none';
            if (onBlur) onBlur();
        });
        if (onChange) input.addEventListener('change', (e) => onChange(e.target.value, e));
        if (onInput) input.addEventListener('input', (e) => onInput(e.target.value, e));

        return {
            element: wrapper, input,
            getValue: () => input.value,
            setValue: (v) => { input.value = v; },
            setDisabled: (d) => {
                input.disabled = d;
                wrapper.style.opacity = d ? '0.5' : '1';
                wrapper.style.cursor = d ? 'not-allowed' : 'pointer';
            },
            focus: () => input.focus(),
            blur: () => input.blur(),
        };
    }

    window.FWUI = window.FWUI || {};
    window.FWUI.Input = { create: createInput };

    if (typeof module !== 'undefined' && module.exports) {
        module.exports = { create: createInput };
    }
})();
