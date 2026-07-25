(function() {
    const toastContainer = document.createElement('div');
    toastContainer.className = 'fwui-toast-container';
    toastContainer.style.cssText = `
        position: fixed;
        top: 20px;
        left: 50%;
        transform: translateX(-50%);
        z-index: 10000;
        display: flex;
        flex-direction: column;
        gap: 10px;
        pointer-events: none;
    `;
    document.body.appendChild(toastContainer);

    function showToast(message, type = 'info', duration = 3000) {
        const toast = document.createElement('div');
        toast.className = `fwui-toast fwui-toast-${type}`;

        const icons = {
            success: '✓',
            error: '✕',
            warning: '⚠',
            info: 'ℹ'
        };

        const colors = {
            success: { bg: '#d1fae5', text: '#10b981' },
            error: { bg: '#fee2e2', text: '#ef4444' },
            warning: { bg: '#fef3c7', text: '#f59e0b' },
            info: { bg: '#dbeafe', text: '#3b82f6' }
        };

        const color = colors[type] || colors.info;

        toast.style.cssText = `
            background: ${color.bg};
            color: ${color.text};
            padding: 12px 20px;
            border-radius: 10px;
            font-size: 14px;
            display: flex;
            align-items: center;
            gap: 10px;
            box-shadow: 0 4px 6px -1px rgb(0 0 0 / 0.1), 0 2px 4px -2px rgb(0 0 0 / 0.1);
            opacity: 0;
            transform: translateY(-20px);
            transition: all 0.3s ease;
            pointer-events: auto;
            max-width: 90vw;
            word-break: break-word;
        `;

        toast.innerHTML = `
            <span style="font-size: 16px; font-weight: bold;">${icons[type] || icons.info}</span>
            <span>${message}</span>
        `;

        toastContainer.appendChild(toast);

        requestAnimationFrame(() => {
            toast.style.opacity = '1';
            toast.style.transform = 'translateY(0)';
        });

        function remove() {
            toast.style.opacity = '0';
            toast.style.transform = 'translateY(-20px)';
            setTimeout(() => {
                if (toast.parentNode) {
                    toast.parentNode.removeChild(toast);
                }
            }, 300);
        }

        if (duration > 0) {
            setTimeout(remove, duration);
        }

        return { remove };
    }

    const Toast = {
        success: (msg, duration) => showToast(msg, 'success', duration),
        error: (msg, duration) => showToast(msg, 'error', duration),
        warning: (msg, duration) => showToast(msg, 'warning', duration),
        info: (msg, duration) => showToast(msg, 'info', duration),
        show: showToast
    };

    window.FWUI = window.FWUI || {};
    window.FWUI.Toast = Toast;

    if (typeof module !== 'undefined' && module.exports) {
        module.exports = Toast;
    }
})();