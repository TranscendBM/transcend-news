import Icon from '../Icon.jsx';

/**
 * 第一層導覽（同一組元素，用 CSS 在不同尺寸換位置，DOM 只有一份）：
 *   桌機／平板（≥ 768px）：在 Header 內的一列文字導覽，目前頁用品牌紅底線＋粗體。
 *   手機：固定在畫面底部的四等分導覽（圖示＋文字，單手好按，每格至少 44px 高）。
 * 目前所在頁用 aria-current="page"，鍵盤 Tab 可逐一到達，focus 外框清楚。
 * items: [{ id, icon, label }]
 */
export default function PrimaryNavigation({ items, active, onChange }) {
  return (
    <nav aria-label="主要導覽"
      className="fixed bottom-0 inset-x-0 z-50 grid bg-ui-surface border-t border-ui-line md:static md:z-auto md:flex md:bg-transparent md:border-0 md:gap-1 md:self-stretch"
      style={{ gridTemplateColumns: `repeat(${items.length}, minmax(0, 1fr))`, paddingBottom: 'env(safe-area-inset-bottom)' }}>
      {items.map(item => {
        const on = item.id === active;
        return (
          <button key={item.id} type="button" onClick={() => onChange(item.id)} aria-current={on ? 'page' : undefined}
            className={`ui-focus relative flex flex-col md:flex-row items-center justify-center gap-0.5 md:gap-1.5 min-h-14 md:min-h-0 px-1 md:px-3 text-[11px] md:text-sm leading-tight transition-colors ${on
              ? 'text-brand font-bold'
              : 'text-ui-secondary font-medium hover:text-ui-text'}`}>
            <Icon name={item.icon} className="text-[1.45em] md:text-[1.15em]" />
            <span className="whitespace-nowrap">{item.label}</span>
            {on && <span aria-hidden="true" className="absolute top-0 inset-x-3 h-0.5 bg-brand md:top-auto md:bottom-0 md:inset-x-2" />}
          </button>
        );
      })}
    </nav>
  );
}
