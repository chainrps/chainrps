/**
 * FWUI Tabs — 标签切换
 *
 * 用法：
 *   const tabs = FWUI.Tabs.create({
 *     tabs: [{ key: 'history', label: '历史' }, { key: 'stats', label: '统计' }],
 *     onChange: (key) => { ... }
 *   });
 *   document.body.appendChild(tabs.element);
 */
(function() {
    function create(opts = {}) {
        const { tabs = [], active = '', onChange = null } = opts;
        const container = document.createElement('div');
        container.style.cssText = `
            display:flex; background:var(--bg-secondary);
            border-radius:var(--radius-md); padding:4px; gap:4px;
        `;

        tabs.forEach((t) => {
            const btn = document.createElement('button');
            btn.textContent = t.label;
            btn.dataset.key = t.key;
            const isActive = t.key === active || (active === '' && tabs[0].key === t.key);
            btn.style.cssText = `
                padding:8px 18px; border:none; border-radius:var(--radius-sm);
                font-size:13px; font-weight:500; cursor:pointer;
                transition:all var(--transition-fast);
                ${isActive
                    ? 'background:var(--primary-color); color:var(--text-inverse); box-shadow:var(--shadow-sm);'
                    : 'background:transparent; color:var(--text-body);'}
            `;
            btn.addEventListener('click', () => {
                container.querySelectorAll('button').forEach((b) => {
                    b.style.background = 'transparent';
                    b.style.color = 'var(--text-body)';
                    b.style.boxShadow = 'none';
                });
                btn.style.background = 'var(--primary-color)';
                btn.style.color = 'var(--text-inverse)';
                btn.style.boxShadow = 'var(--shadow-sm)';
                if (onChange) onChange(t.key);
            });
            container.appendChild(btn);
        });

        return { element: container };
    }

    window.FWUI = window.FWUI || {};
    window.FWUI.Tabs = { create };
})();
