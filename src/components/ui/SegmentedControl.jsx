// 分段選擇（期間、類別、排序共用）。每個選項是 aria-pressed 的按鈕，選取狀態用品牌紅底白字。
// options: [{ id, label, count? }]
export default function SegmentedControl({ options, value, onChange, label, className = '' }) {
  return (
    <div role="group" aria-label={label} className={`flex flex-wrap gap-1.5 ${className}`}>
      {options.map(o => {
        const on = o.id === value;
        return (
          <button key={o.id} type="button" aria-pressed={on} onClick={() => onChange(o.id)}
            className={`ui-focus min-h-11 md:min-h-9 px-3 rounded-lg text-sm font-medium border transition-colors ${on
              ? 'bg-brand text-white border-brand'
              : 'bg-ui-surface text-ui-secondary border-ui-strong hover:bg-ui-soft'}`}>
            {o.label}{o.count != null && <span className={`ml-1 text-xs tabular-nums ${on ? 'text-white/85' : 'text-ui-muted'}`}>{o.count}</span>}
          </button>
        );
      })}
    </div>
  );
}
