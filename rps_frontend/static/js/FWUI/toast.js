/**
 * FWUI Toast v2 — CSS 变量
 */
(function() {
    const icons = { success: '✓', error: '✕', warning: '⚠', info: 'ℹ' };
    const TYPES = ['success', 'error', 'warning', 'info'];

    function getTypeStyles(type) {
        const map = {
            success: { bg: 'var(--fwui-bg-toast-success)',  color: 'var(--fwui-color-toast-success)' },
            error:   { bg: 'var(--fwui-bg-toast-error)',    color: 'var(--fwui-color-toast-error)' },
            warning: { bg: 'var(--fwui-bg-toast-warning)',  color: 'var(--fwui-color-toast-warning)' },
            info:    { bg: 'var(--fwui-bg-toast-info)',     color: 'var(--fwui-color-toast-info)' },
        };
        return map[type] || map.info;
    }

    const container = document.createElement('div');
    container.style.cssText = `
        position:fixed; top:20px; left:50%; transform:translateX(-50%);
        z-index:10000; display:flex; flex-direction:column; gap:10px; pointer-events:none;
    `;
    document.body.appendChild(container);

    function show(message, type = 'info', duration = 3000) {
        const toast = document.createElement('div');
        toast.style.cssText = `
            ${getTypeStyles(type).bg ? 'background:' + getTypeStyles(type).bg + ';' : ''}
            ${getTypeStyles(type).color ? 'color:' + getTypeStyles(type).color + ';' : ''}
            padding:12px 20px; border-radius:var(--radius-md); font-size:14px;
            display:flex; align-items:center; gap:10px;
            box-shadow:var(--shadow-lg);
            opacity:0; transform:translateY(-20px);
            transition:all var(--transition-normal);
            pointer-events:auto; max-width:90vw; word-break:break-word;
            border:1px solid var(--card-border);
        `;
        toast.innerHTML = `
            <span style="font-size:16px;font-weight:bold;">${icons[type] || icons.info}</span>
            <span>${message}</span>`;
        container.appendChild(toast);

        requestAnimationFrame(() => {
            toast.style.opacity = '1';
            toast.style.transform = 'translateY(0)';
        });

        function remove() {
            toast.style.opacity = '0';
            toast.style.transform = 'translateY(-20px)';
            setTimeout(() => { if (toast.parentNode) toast.parentNode.removeChild(toast); }, 300);
        }
        if (duration > 0) setTimeout(remove, duration);
        return { remove };
    }

    window.FWUI = window.FWUI || {};
    window.FWUI.Toast = {
        show, info: (m, d) => show(m, 'info', d),
        success: (m, d) => show(m, 'success', d),
        error: (m, d) => show(m, 'error', d),
        warning: (m, d) => show(m, 'warning', d),
    };

    if (typeof module !== 'undefined' && module.exports) module.exports = window.FWUI.Toast;
})();
