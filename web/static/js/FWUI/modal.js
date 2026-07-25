const FWUI = (function() {
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
            background: var(--bg-card, #fff);
            border-radius: var(--radius-lg, 16px);
            width: ${width};
            max-width: 90vw;
            max-height: 85vh;
            display: flex;
            flex-direction: column;
            box-shadow: var(--shadow-xl, 0 20px 25px -5px rgb(0 0 0 / 0.1));
            transform: scale(0.9);
            transition: transform 0.2s ease;
            overflow: hidden;
        `;

        let headerHtml = '';
        if (title || closable) {
            headerHtml = `
                <div class="fwui-modal-header" style="
                    padding: 20px 24px;
                    border-bottom: 1px solid var(--border-color, #e2e8f0);
                    display: flex;
                    align-items: center;
                    justify-content: space-between;
                    flex-shrink: 0;
                ">
                    <div class="fwui-modal-title" style="
                        font-size: 18px;
                        font-weight: 600;
                        color: var(--text-primary, #0f172a);
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
                            border-radius: var(--radius-sm, 6px);
                            color: var(--text-tertiary, #94a3b8);
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
                    border-top: 1px solid var(--border-color, #e2e8f0);
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
                color: var(--text-secondary, #475569);
            ">${typeof content === 'function' ? content() : content}</div>
            ${footerHtml}
        `;

        mask.appendChild(modal);
        document.body.appendChild(mask);

        requestAnimationFrame(() => {
            mask.style.opacity = '1';
            modal.style.transform = 'scale(1)';
        });

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

        if (maskClosable) {
            mask.addEventListener('click', (e) => {
                if (e.target === mask) {
                    close();
                }
            });
        }

        function setContent(newContent) {
            const body = modal.querySelector('.fwui-modal-body');
            if (body) {
                body.innerHTML = typeof newContent === 'function' ? newContent() : newContent;
            }
        }

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
                    border-radius: var(--radius-md, 10px);
                    font-size: 14px;
                    font-weight: 500;
                    cursor: pointer;
                    border: 1px solid var(--border-color, #e2e8f0);
                    background: var(--bg-card, #fff);
                    color: var(--text-primary, #0f172a);
                    transition: all 0.15s ease;
                ">${cancelText}</button>
                <button class="fwui-btn fwui-btn-${okType}" data-action="ok" style="
                    padding: 8px 20px;
                    border-radius: var(--radius-md, 10px);
                    font-size: 14px;
                    font-weight: 500;
                    cursor: pointer;
                    border: none;
                    background: var(--primary-color, #6366f1);
                    color: #fff;
                    transition: all 0.15s ease;
                ">${okText}</button>
            `
        });

        const okBtn = modal.element.querySelector('[data-action="ok"]');
        const cancelBtn = modal.element.querySelector('[data-action="cancel"]');

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

        cancelBtn.addEventListener('click', () => {
            if (typeof onCancel === 'function') {
                onCancel();
            }
            modal.close();
        });

        return modal;
    }

    return {
        Modal: {
            create: createModal,
            confirm
        }
    };
})();

if (typeof module !== 'undefined' && module.exports) {
    module.exports = FWUI;
}
