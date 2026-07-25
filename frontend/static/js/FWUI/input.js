(function() {
    function createInput(options = {}) {
        const {
            type = 'text',
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
            onBlur = null
        } = options;

        const wrapper = document.createElement('div');
        wrapper.className = 'fwui-input-wrapper';
        wrapper.style.cssText = `
            display: flex;
            align-items: center;
            border: 1px solid var(--border-color, #e2e8f0);
            border-radius: var(--radius-md, 10px);
            background: var(--bg-card, #fff);
            transition: all 0.15s ease;
            position: relative;
        `;

        const sizeStyles = {
            small: 'padding: 6px 12px; font-size: 12px;',
            medium: 'padding: 10px 14px; font-size: 14px;',
            large: 'padding: 12px 16px; font-size: 16px;'
        };

        const input = document.createElement('input');
        input.type = type;
        input.className = 'fwui-input';
        input.placeholder = placeholder;
        input.value = value;
        input.style.cssText = `
            flex: 1;
            border: none;
            outline: none;
            background: transparent;
            color: var(--text-primary, #0f172a);
            ${sizeStyles[size] || sizeStyles.medium}
            min-width: 0;
        `;

        if (disabled) {
            input.disabled = true;
            wrapper.style.opacity = '0.5';
            wrapper.style.cursor = 'not-allowed';
        }

        if (maxLength) {
            input.maxLength = maxLength;
        }

        if (prefix) {
            const prefixEl = document.createElement('span');
            prefixEl.className = 'fwui-input-prefix';
            prefixEl.style.cssText = `
                padding-left: 14px;
                color: var(--text-tertiary, #94a3b8);
                display: flex;
                align-items: center;
                flex-shrink: 0;
            `;
            prefixEl.innerHTML = prefix;
            wrapper.appendChild(prefixEl);
        }

        wrapper.appendChild(input);

        if (suffix) {
            const suffixEl = document.createElement('span');
            suffixEl.className = 'fwui-input-suffix';
            suffixEl.style.cssText = `
                padding-right: 14px;
                color: var(--text-tertiary, #94a3b8);
                display: flex;
                align-items: center;
                flex-shrink: 0;
            `;
            suffixEl.innerHTML = suffix;
            wrapper.appendChild(suffixEl);
        }

        input.addEventListener('focus', () => {
            wrapper.style.borderColor = 'var(--primary-color, #6366f1)';
            wrapper.style.boxShadow = '0 0 0 3px var(--primary-light, #e0e7ff)';
            if (onFocus) onFocus();
        });

        input.addEventListener('blur', () => {
            wrapper.style.borderColor = 'var(--border-color, #e2e8f0)';
            wrapper.style.boxShadow = 'none';
            if (onBlur) onBlur();
        });

        if (onChange) {
            input.addEventListener('change', (e) => onChange(e.target.value, e));
        }

        if (onInput) {
            input.addEventListener('input', (e) => onInput(e.target.value, e));
        }

        function getValue() {
            return input.value;
        }

        function setValue(val) {
            input.value = val;
        }

        function setDisabled(isDisabled) {
            input.disabled = isDisabled;
            wrapper.style.opacity = isDisabled ? '0.5' : '1';
            wrapper.style.cursor = isDisabled ? 'not-allowed' : 'pointer';
        }

        function focus() {
            input.focus();
        }

        function blur() {
            input.blur();
        }

        return {
            element: wrapper,
            input,
            getValue,
            setValue,
            setDisabled,
            focus,
            blur
        };
    }

    if (typeof FWUI !== 'undefined') {
        FWUI.Input = { create: createInput };
    } else {
        window.FWUI = window.FWUI || {};
        window.FWUI.Input = { create: createInput };
    }

    if (typeof module !== 'undefined' && module.exports) {
        module.exports = { create: createInput };
    }
})();
