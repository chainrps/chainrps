/**
 * FWUI Skeleton — 骨架屏（B-02）
 *
 * 纯 CSS shimmer，不阻塞交互。
 *   .skeleton-line   单行
 *   .skeleton-block  矩形块（用于头像等）
 *   .skeleton-card   卡片骨架（头像 + 3 行文字）
 */
(function() {
    function line(opts = {}) {
        const { width = '100%', height = '14px', marginBottom = '10px' } = opts;
        const el = document.createElement('div');
        el.className = 'skeleton-line anim-shimmer';
        el.style.width = width;
        el.style.height = height;
        el.style.marginBottom = marginBottom;
        el.style.borderRadius = '6px';
        return el;
    }

    function block(opts = {}) {
        const { width = '40px', height = '40px', round = true } = opts;
        const el = document.createElement('div');
        el.className = 'skeleton-block anim-shimmer';
        el.style.width = width;
        el.style.height = height;
        el.style.borderRadius = round ? '50%' : '8px';
        return el;
    }

    // 常用：列表行骨架
    function listRow(opts = {}) {
        const { count = 3 } = opts;
        const wrap = document.createElement('div');
        wrap.style.display = 'flex'; wrap.style.gap = '12px';
        for (let i = 0; i < count; i++) {
            const row = document.createElement('div');
            row.style.display = 'flex'; row.style.gap = '12px'; row.style.marginBottom = '14px';
            row.appendChild(block());
            const lines = document.createElement('div');
            lines.style.flex = '1';
            lines.appendChild(line({ width: '100%' }));
            lines.appendChild(line({ width: '60%', height: '12px' }));
            lines.appendChild(line({ width: '30%', height: '10px' }));
            row.appendChild(lines);
            wrap.appendChild(row);
        }
        return wrap;
    }

    window.FWUI = window.FWUI || {};
    window.FWUI.Skeleton = { line, block, listRow };
})();
