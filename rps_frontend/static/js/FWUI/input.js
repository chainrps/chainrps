(function() {
    // 创建输入框
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
            border: 1px solid #e2e8f0;
            border-radius: 10px;
            background: #fff;
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
            color: #0f172a;
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
                color: #94a3b8;
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
                color: #94a3b8;
                display: flex;
                align-items: center;
                flex-shrink: 0;
            `;
            suffixEl.innerHTML = suffix;
            wrapper.appendChild(suffixEl);
        }

        // 输入框聚焦事件处理
        input.addEventListener('focus', () => {
            wrapper.style.borderColor = '#6366f1';
            wrapper.style.boxShadow = '0 0 0 3px #e0e7ff';
            if (onFocus) onFocus();
        });

        // 输入框失焦事件处理
        input.addEventListener('blur', () => {
            wrapper.style.borderColor = '#e2e8f0';
            wrapper.style.boxShadow = 'none';
            if (onBlur) onBlur();
        });

        if (onChange) {
            input.addEventListener('change', (e) => onChange(e.target.value, e));
        }

        if (onInput) {
            input.addEventListener('input', (e) => onInput(e.target.value, e));
        }

        // 获取输入框的值
        function getValue() {
            return input.value;
        }

        // 设置输入框的值
        function setValue(val) {
            input.value = val;
        }

        // 设置禁用状态
        function setDisabled(isDisabled) {
            input.disabled = isDisabled;
            wrapper.style.opacity = isDisabled ? '0.5' : '1';
            wrapper.style.cursor = isDisabled ? 'not-allowed' : 'pointer';
        }

        // 聚焦输入框
        function focus() {
            input.focus();
        }

        // 失焦输入框
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