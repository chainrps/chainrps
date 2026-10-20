/**
 * FWUI Interactions — 统一 data-* 属性交互事件委托（A-03）
 *
 * 在任何元素上加一个 data-* 属性，自动获得行为。
 * 所有事件委托到 document.body，无重复绑定，新增页面零 JS。
 *
 * 支持的属性：
 *   data-copy             点击复制元素 textContent 或 data-copy 的值
 *   data-copy-target      配合 data-copy，指定目标元素的 CSS 选择器
 *   data-toast            复制成功后的 Toast 文案（默认"已复制到剪贴板"）
 *
 *   data-toggle-theme     点击切换亮/暗主题（自动找 #themeToggle 触发）
 *
 *   data-dropdown         点击切换指定 dropdown（值=dropdown id）
 *   data-dropdown-close   点击关闭 dropdown
 *
 *   data-confirm          点击触发二次确认 Modal（值=确认文案）
 *   data-confirm-title    confirm 标题（默认"确认"）
 *   data-confirm-ok       confirm 按钮文案（默认"确定"）
 *   data-confirm-cancel   cancel 按钮文案（默认"取消"）
 *   data-action           confirm 通过后执行的自定义 action 函数名（挂在 window 上）
 *
 *   data-number           自动等宽数字格式化（tabular-nums + JetBrains Mono）
 *
 * 用法示例：
 *   <span data-copy="0xabc...def" data-toast="地址已复制">0xabc...def</span>
 *   <button data-toggle-theme>🌙</button>
 *   <button data-confirm="确定下注 10 USDC？" data-action="PlaceBet">下注</button>
 */
(function() {
    if (window.__FWUI_INTERACTIONS_LOADED) return;
    window.__FWUI_INTERACTIONS_LOADED = true;

    document.addEventListener('click', async function(e) {
        const el = e.target.closest('[data-copy], [data-toggle-theme], [data-dropdown], [data-confirm]');
        if (!el) return;

        // ====== data-copy ======
        if (el.hasAttribute('data-copy') || el.hasAttribute('data-copy-target')) {
            let text;
            if (el.hasAttribute('data-copy-target')) {
                const target = document.querySelector(el.dataset.copyTarget);
                text = target ? (target.dataset.copyValue || target.textContent.trim()) : '';
            } else {
                text = el.dataset.copy || el.textContent.trim();
            }
            try {
                if (navigator.clipboard) {
                    await navigator.clipboard.writeText(text);
                } else {
                    // fallback
                    const ta = document.createElement('textarea');
                    ta.value = text; document.body.appendChild(ta);
                    ta.select(); document.execCommand('copy'); document.body.removeChild(ta);
                }
                const toastMsg = el.dataset.toast || '已复制到剪贴板';
                if (window.FWUI && FWUI.Toast) FWUI.Toast.success(toastMsg);
            } catch {
                if (window.FWUI && FWUI.Toast) FWUI.Toast.error('复制失败');
            }
            return;
        }

        // ====== data-toggle-theme ======
        if (el.hasAttribute('data-toggle-theme')) {
            // 找主题切换按钮复用其逻辑，或自己实现
            const toggle = document.getElementById('themeToggle');
            if (toggle) toggle.click();
            else {
                const isDark = document.documentElement.getAttribute('data-theme') === 'dark';
                document.documentElement.setAttribute('data-theme', isDark ? 'light' : 'dark');
                localStorage.setItem('theme', isDark ? 'light' : 'dark');
            }
            return;
        }

        // ====== data-dropdown ======
        if (el.hasAttribute('data-dropdown')) {
            const id = el.dataset.dropdown;
            const dd = document.getElementById(id);
            if (dd) dd.classList.toggle('hidden');
            return;
        }
        if (el.hasAttribute('data-dropdown-close')) {
            const id = el.dataset.dropdownClose;
            const dd = document.getElementById(id);
            if (dd) dd.classList.add('hidden');
            return;
        }

        // ====== data-confirm ======
        if (el.hasAttribute('data-confirm')) {
            const msg = el.dataset.confirm;
            const title = el.dataset.confirmTitle || '确认';
            const okText = el.dataset.confirmOk || '确定';
            const cancelText = el.dataset.confirmCancel || '取消';
            const actionName = el.dataset.action;

            if (window.FWUI && FWUI.Modal && FWUI.Modal.confirm) {
                FWUI.Modal.confirm({
                    title, content: msg, okText, cancelText,
                    onOk: () => {
                        if (actionName && typeof window[actionName] === 'function') {
                            window[actionName](el);
                        }
                    },
                });
            } else {
                if (confirm(msg)) {
                    if (actionName && typeof window[actionName] === 'function') {
                        window[actionName](el);
                    }
                }
            }
            return;
        }
    }, false);

    // ====== data-number 自动格式化（DOMContentLoaded 后跑一次 + MutationObserver）======
    function formatNumberEl(el) {
        el.classList.add('number-mono');
        // 可扩展：自动千分位、后缀 USDC 等
    }
    document.addEventListener('DOMContentLoaded', () => {
        document.querySelectorAll('[data-number]').forEach(formatNumberEl);
    });
    // 监听后续新增的 data-number 元素
    const mo = new MutationObserver((mutations) => {
        mutations.forEach((m) => {
            m.addedNodes.forEach((node) => {
                if (node.nodeType === 1) {
                    if (node.matches('[data-number]')) formatNumberEl(node);
                    node.querySelectorAll('[data-number]').forEach(formatNumberEl);
                }
            });
        });
    });
    document.addEventListener('DOMContentLoaded', () => {
        mo.observe(document.body, { childList: true, subtree: true });
    });

    window.FWUI = window.FWUI || {};
    window.FWUI.Interactions = {
        refresh: () => document.querySelectorAll('[data-number]').forEach(formatNumberEl),
    };
})();
