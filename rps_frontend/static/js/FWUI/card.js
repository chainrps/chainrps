/**
 * FWUI Card — 通用卡片容器
 *
 * 使用 CSS 变量，hover 时边框高亮（暗色有发光效果）
 *   type="game-room"  游戏房间卡片
 *   type="info"       信息块卡片
 *   type="blank"      默认卡片
 */
(function() {
    function create(content, opts = {}) {
        const { type = 'blank', padding = '18px', hoverable = true } = opts;
        const card = document.createElement('div');
        card.className = `fwui-card fwui-card-${type}`;
        card.style.cssText = `
            background:var(--card-bg);
            border:1px solid var(--card-border);
            border-radius:var(--radius-md);
            padding:${padding};
            transition:all var(--transition-fast);
            ${hoverable ? 'cursor:pointer;' : ''}
        `;
        if (hoverable) {
            card.addEventListener('mouseenter', () => {
                card.style.borderColor = 'var(--card-border-hover)';
                card.style.boxShadow = '0 0 20px rgba(var(--primary-rgb), 0.15)';
                card.style.transform = 'translateY(-1px)';
            });
            card.addEventListener('mouseleave', () => {
                card.style.borderColor = 'var(--card-border)';
                card.style.boxShadow = 'none';
                card.style.transform = 'translateY(0)';
            });
        }
        if (typeof content === 'string') card.innerHTML = content;
        else if (content instanceof HTMLElement) card.appendChild(content);
        return card;
    }

    window.FWUI = window.FWUI || {};
    window.FWUI.Card = { create };
})();
