/**
 * FWUI Modal v2 — CSS 变量 + 无 outerHTML 序列化 bug
 *
 * 保留原有 API：create / confirm / alert
 * 关键修复：footer 支持 HTMLElement 直接 appendChild，不再用 outerHTML 序列化丢失事件
 */
(function() {
    function createModal(options = {}) {
        const {
            title = '', content = '', width = '480px',
            closable = true, maskClosable = true,
            onClose = null,
            // footer: 可以是 string、function 返回 string、HTMLElement、或 HTMLElement[]
            footer = null,
        } = options;

        const mask = document.createElement('div');
        mask.style.cssText = `
            position:fixed; top:0; left:0; right:0; bottom:0;
            background:rgba(0,0,0,0.5);
            display:flex; align-items:center; justify-content:center;
            z-index:9999; opacity:0; transition:opacity var(--transition-fast);
        `;

        const modal = document.createElement('div');
        modal.style.cssText = `
            background:var(--fwui-bg-modal);
            border-radius:var(--radius-lg);
            width:${width}; max-width:90vw; max-height:85vh;
            display:flex; flex-direction:column;
            box-shadow:var(--shadow-xl);
            transform:scale(0.9); transition:transform var(--transition-fast);
            overflow:hidden; border:1px solid var(--card-border);
        `;

        let headerHtml = '';
        if (title || closable) {
            headerHtml = `
                <div style="padding:20px 24px; border-bottom:1px solid var(--card-border); display:flex; align-items:center; justify-content:space-between; flex-shrink:0;">
                    <div style="font-size:18px; font-weight:600; color:var(--text-heading);">${title}</div>
                    ${closable ? `<button class="fwui-modal-close" style="background:none;border:none;cursor:pointer;padding:4px;display:flex;align-items:center;justify-content:center;border-radius:6px;color:var(--text-label);transition:all var(--transition-fast);font-size:20px;line-height:1;">×</button>` : ''}
                </div>`;
        }

        // 先放 header + body
        modal.innerHTML = headerHtml + `
            <div style="padding:24px; overflow-y:auto; flex:1; color:var(--text-body);">
                ${typeof content === 'function' ? content() : content}
            </div>`;

        // footer 处理：统一生成一个 footerContainer DOM 元素
        if (footer) {
            const footerContainer = document.createElement('div');
            footerContainer.style.cssText = `
                padding:16px 24px; border-top:1px solid var(--card-border);
                display:flex; justify-content:flex-end; gap:12px; flex-shrink:0;
            `;

            if (footer instanceof HTMLElement) {
                footerContainer.appendChild(footer);
            } else if (Array.isArray(footer)) {
                footer.forEach((el) => { if (el instanceof HTMLElement) footerContainer.appendChild(el); });
            } else {
                // string 或 function
                const html = typeof footer === 'function' ? footer() : footer;
                footerContainer.innerHTML = html;
            }

            modal.appendChild(footerContainer);
        }

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
                if (mask.parentNode) mask.parentNode.removeChild(mask);
                if (typeof onClose === 'function') onClose();
            }, 200);
        }

        if (closable) {
            const cb = modal.querySelector('.fwui-modal-close');
            if (cb) cb.addEventListener('click', close);
        }
        if (maskClosable) {
            mask.addEventListener('click', (e) => { if (e.target === mask) close(); });
        }

        return { close, element: mask, modal,
            setContent: (c) => {
                const body = modal.children[1];
                if (body) body.innerHTML = typeof c === 'function' ? c() : c;
            },
            setTitle: (t) => {
                if (title) {
                    const hdr = modal.children[0];
                    if (hdr) hdr.children[0].textContent = t;
                }
            },
        };
    }

    function confirm(options = {}) {
        const {
            title = '确认', content = '',
            okText = '确定', cancelText = '取消',
            onOk = null, onCancel = null,
        } = options;

        const cancelBtn = document.createElement('button');
        cancelBtn.textContent = cancelText;
        cancelBtn.style.cssText = `
            padding:10px 20px; border-radius:10px; font-size:14px; font-weight:500;
            cursor:pointer; border:1px solid var(--card-border);
            background:transparent; color:var(--text-body); transition:all var(--transition-fast);
        `;
        cancelBtn.addEventListener('click', () => {
            if (typeof onCancel === 'function') onCancel();
            modal.close();
        });

        const okBtn = FWUI.Button.create({
            text: okText, state: 'idle',
            onClick: async () => {
                if (typeof onOk === 'function') {
                    const result = onOk();
                    if (result instanceof Promise) {
                        okBtn.loading(true);
                        try { await result; modal.close(); }
                        catch { okBtn.loading(false); }
                    } else if (result !== false) {
                        modal.close();
                    }
                } else {
                    modal.close();
                }
            },
        });

        const modal = createModal({
            title, content, closable: false, maskClosable: false,
            footer: [cancelBtn, okBtn.element],  // HTMLElement[] — 直接 appendChild，事件保留
        });
        return modal;
    }

    function alert(options = {}) {
        const { title = '提示', content = '', okText = '确定', onOk = null } = options;

        const okBtn = FWUI.Button.create({
            text: okText, state: 'idle',
            onClick: () => {
                if (typeof onOk === 'function') onOk();
                modal.close();
            },
        });

        const modal = createModal({
            title, content, closable: true, maskClosable: true,
            footer: [okBtn.element],  // HTMLElement — 事件保留
        });
        return modal;
    }

    window.FWUI = window.FWUI || {};
    window.FWUI.Modal = { create: createModal, confirm, alert };

    if (typeof module !== 'undefined' && module.exports) module.exports = window.FWUI;
})();
