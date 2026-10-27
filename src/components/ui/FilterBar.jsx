import { useEffect, useId, useState } from 'react';

import Icon from '../Icon.jsx';
import ActionButton from './ActionButton.jsx';

/**
 * 全站統一的篩選列：搜尋／下拉／日期／分段選擇都放進 children；
 * 目前生效的條件以「晶片」顯示（可個別移除），並有一個「清除全部」。
 * 手機（< md）預設收合成「篩選（N）」按鈕，展開後才顯示欄位；按 Escape 收合。
 *
 * active: [{ key, label, onClear }]；resultText：例如「顯示 12 / 80 則」。
 */
export default function FilterBar({ children, active = [], onClearAll, resultText, className = '' }) {
  const [open, setOpen] = useState(false);
  const panelId = useId();
  useEffect(() => {
    if (!open) return undefined;
    const onKey = e => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open]);

  return (
    <div className={`ui-card !p-3 space-y-2 ${className}`} role="search" aria-label="篩選條件">
      <div className="flex items-center justify-between gap-2 md:hidden">
        <ActionButton aria-expanded={open} aria-controls={panelId} onClick={() => setOpen(o => !o)} icon="filter">
          篩選{active.length ? `（${active.length}）` : ''}
        </ActionButton>
        {resultText && <span className="text-xs text-ui-muted tabular-nums">{resultText}</span>}
      </div>
      <div id={panelId} className={`${open ? 'flex' : 'hidden'} md:flex flex-col md:flex-row md:flex-wrap md:items-center gap-2`}>
        {children}
        {resultText && <span className="hidden md:inline ml-auto text-xs text-ui-muted tabular-nums">{resultText}</span>}
      </div>
      {active.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5" aria-label="目前的篩選條件">
          {active.map(a => (
            <button key={a.key} type="button" onClick={a.onClear} aria-label={`移除篩選：${a.label}`}
              className="ui-focus inline-flex items-center gap-1 rounded-full border border-brand-line bg-brand-soft text-brand px-2.5 min-h-8 text-xs font-medium">
              {a.label}<Icon name="close" />
            </button>
          ))}
          {onClearAll && <button type="button" onClick={onClearAll} className="ui-focus text-xs font-medium text-ui-secondary underline px-2 min-h-8">清除全部</button>}
        </div>
      )}
    </div>
  );
}
