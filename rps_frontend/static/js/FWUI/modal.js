(function() {
    // 创建模态框
    function createModal(options = {}) {
        const {
            title = '',
            content = '',
            width = '480px',
            closable = true,
            maskClosable = true,
            onClose = null,
            footer = null
        } = options;

        const mask = document.createElement('div');
        mask.className = 'fwui-modal-mask';
        mask.style.cssText = `
            position: fixed;
            top: 0;
            left: 0;
            right: 0;
            bottom: 0;
            background: rgba(0, 0, 0, 0.5);
            display: flex;
            align-items: center;
            justify-content: center;
            z-index: 9999;
            opacity: 0;
            transition: opacity 0.2s ease;
        `;

        const modal = document.createElement('div');
        modal.className = 'fwui-modal';
        modal.style.cssText = `
            background: #fff;
            border-radius: 16px;
            width: ${width};
            max-width: 90vw;
            max-height: 85vh;
            display: flex;
            flex-direction: column;
            box-shadow: 0 20px 25px -5px rgb(0 0 0 / 0.1), 0 8px 10px -6px rgb(0 0 0 / 0.1);
            transform: scale(0.9);
            transition: transform 0.2s ease;
            overflow: hidden;
        `;

        let headerHtml = '';
        if (title || closable) {
            headerHtml = `
                <div class="fwui-modal-header" style="
                    padding: 20px 24px;
                    border-bottom: 1px solid #e2e8f0;
                    display: flex;
                    align-items: center;
                    justify-content: space-between;
                    flex-shrink: 0;
                ">
                    <div class="fwui-modal-title" style="
                        font-size: 18px;
                        font-weight: 600;
                        color: #0f172a;
                    ">${title}</div>
                    ${closable ? `
                        <button class="fwui-modal-close" style="
                            background: none;
                            border: none;
                            cursor: pointer;
                            padding: 4px;
                            display: flex;
                            align-items: center;
                            justify-content: center;
                            border-radius: 6px;
                            color: #94a3b8;
                            transition: all 0.15s ease;
                            font-size: 20px;
                            line-height: 1;
                        ">&times;</button>
                    ` : ''}
                </div>
            `;
        }

        let footerHtml = '';
        if (footer) {
            footerHtml = `
                <div class="fwui-modal-footer" style="
                    padding: 16px 24px;
                    border-top: 1px solid #e2e8f0;
                    display: flex;
                    justify-content: flex-end;
                    gap: 12px;
                    flex-shrink: 0;
                ">${typeof footer === 'function' ? footer() : footer}</div>
            `;
        }

        modal.innerHTML = `
            ${headerHtml}
            <div class="fwui-modal-body" style="
                padding: 24px;
                overflow-y: auto;
                flex: 1;
                color: #475569;
            ">${typeof content === 'function' ? content() : content}</div>
            ${footerHtml}
        `;

        mask.appendChild(modal);
        document.body.appendChild(mask);

        requestAnimationFrame(() => {
            mask.style.opacity = '1';
            modal.style.transform = 'scale(1)';
        });

        // 关闭模态框
        function close() {
            mask.style.opacity = '0';
            modal.style.transform = 'scale(0.9)';
            setTimeout(() => {
                if (mask.parentNode) {
                    mask.parentNode.removeChild(mask);
                }
                if (typeof onClose === 'function') {
                    onClose();
                }
            }, 200);
        }

        if (closable) {
            const closeBtn = modal.querySelector('.fwui-modal-close');
            if (closeBtn) {
                closeBtn.addEventListener('click', close);
            }
        }

        // 点击遮罩层关闭模态框
        if (maskClosable) {
            mask.addEventListener('click', (e) => {
                if (e.target === mask) {
                    close();
                }
            });
        }

        // 设置模态框内容
        function setContent(newContent) {
            const body = modal.querySelector('.fwui-modal-body');
            if (body) {
                body.innerHTML = typeof newContent === 'function' ? newContent() : newContent;
            }
        }

        // 设置模态框标题
        function setTitle(newTitle) {
            const titleEl = modal.querySelector('.fwui-modal-title');
            if (titleEl) {
                titleEl.textContent = newTitle;
            }
        }

        return {
            close,
            setContent,
            setTitle,
            element: mask
        };
    }

    // 确认对话框
    function confirm(options = {}) {
        const {
            title = '确认',
            content = '',
            okText = '确定',
            cancelText = '取消',
            okType = 'primary',
            onOk = null,
            onCancel = null
        } = options;

        const modal = createModal({
            title,
            content,
            closable: false,
            maskClosable: false,
            footer: `
                <button class="fwui-btn fwui-btn-default" data-action="cancel" style="
                    padding: 8px 20px;
                    border-radius: 10px;
                    font-size: 14px;
                    font-weight: 500;
                    cursor: pointer;
                    border: 1px solid #e2e8f0;
                    background: #fff;
                    color: #0f172a;
                    transition: all 0.15s ease;
                ">${cancelText}</button>
                <button class="fwui-btn fwui-btn-${okType}" data-action="ok" style="
                    padding: 8px 20px;
                    border-radius: 10px;
                    font-size: 14px;
                    font-weight: 500;
                    cursor: pointer;
                    border: none;
                    background: #6366f1;
                    color: #fff;
                    transition: all 0.15s ease;
                ">${okText}</button>
            `
        });

        const okBtn = modal.element.querySelector('[data-action="ok"]');
        const cancelBtn = modal.element.querySelector('[data-action="cancel"]');

        // 确认按钮点击事件处理
        okBtn.addEventListener('click', async () => {
            if (typeof onOk === 'function') {
                const result = onOk();
                if (result instanceof Promise) {
                    okBtn.disabled = true;
                    okBtn.textContent = '处理中...';
                    try {
                        await result;
                        modal.close();
                    } catch (e) {
                        okBtn.disabled = false;
                        okBtn.textContent = okText;
                    }
                } else if (result !== false) {
                    modal.close();
                }
            } else {
                modal.close();
            }
        });

        // 取消按钮点击事件处理
        cancelBtn.addEventListener('click', () => {
            if (typeof onCancel === 'function') {
                onCancel();
            }
            modal.close();
        });

        return modal;
    }

    // 输入对话框
    function prompt(options = {}) {
        const {
            title = '输入',
            message = '',
            placeholder = '',
            value = '',
            confirmText = '确定',
            cancelText = '取消',
            onConfirm = null,
            onCancel = null
        } = options;

        const inputId = 'fwui-prompt-input-' + Date.now();
        const modal = createModal({
            title,
            content: `
                ${message ? `<div style="margin-bottom: 12px; font-size: 14px; color: #475569;">${message}</div>` : ''}
                <input id="${inputId}" type="text" value="${value}" placeholder="${placeholder}" style="
                    width: 100%;
                    padding: 10px 12px;
                    border: 1px solid #e2e8f0;
                    border-radius: 10px;
                    font-size: 14px;
                    color: #0f172a;
                    background: #f8fafc;
                    box-sizing: border-box;
                    outline: none;
                    transition: border-color 0.15s ease;
                " />
            `,
            closable: false,
            maskClosable: false,
            footer: `
                <button class="fwui-btn fwui-btn-default" data-action="cancel" style="
                    padding: 8px 20px;
                    border-radius: 10px;
                    font-size: 14px;
                    font-weight: 500;
                    cursor: pointer;
                    border: 1px solid #e2e8f0;
                    background: #fff;
                    color: #0f172a;
                    transition: all 0.15s ease;
                ">${cancelText}</button>
                <button class="fwui-btn fwui-btn-primary" data-action="ok" style="
                    padding: 8px 20px;
                    border-radius: 10px;
                    font-size: 14px;
                    font-weight: 500;
                    cursor: pointer;
                    border: none;
                    background: #6366f1;
                    color: #fff;
                    transition: all 0.15s ease;
                ">${confirmText}</button>
            `
        });

        const input = modal.element.querySelector('#' + inputId);
        // 自动聚焦
        setTimeout(() => {
            if (input) {
                input.focus();
                input.select();
            }
        }, 100);

        // 回车确认
        if (input) {
            // 输入框按键事件处理
            input.addEventListener('keydown', (e) => {
                if (e.key === 'Enter') {
                    const val = input.value;
                    if (typeof onConfirm === 'function') {
                        onConfirm(val);
                    }
                    modal.close();
                } else if (e.key === 'Escape') {
                    if (typeof onCancel === 'function') {
                        onCancel();
                    }
                    modal.close();
                }
            });
        }

        const okBtn = modal.element.querySelector('[data-action="ok"]');
        const cancelBtn = modal.element.querySelector('[data-action="cancel"]');

        // 确认按钮点击事件处理
        okBtn.addEventListener('click', () => {
            const val = input ? input.value : '';
            if (typeof onConfirm === 'function') {
                onConfirm(val);
            }
            modal.close();
        });

        // 取消按钮点击事件处理
        cancelBtn.addEventListener('click', () => {
            if (typeof onCancel === 'function') {
                onCancel();
            }
            modal.close();
        });

        return modal;
    }

    window.FWUI = window.FWUI || {};
    window.FWUI.Modal = {
        // 创建模态框
        create: createModal,
        // 确认对话框
        confirm,
        // 输入对话框
        prompt
    };
})();

if (typeof module !== 'undefined' && module.exports) {
    module.exports = window.FWUI;
}