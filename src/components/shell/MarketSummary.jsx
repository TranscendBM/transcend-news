import { useState } from 'react';

import Icon from '../Icon.jsx';
import StatusBadge from '../ui/StatusBadge.jsx';
import { Delta } from '../ui/MetricCard.jsx';
import { fmtStockUpdated } from '../../utils/dates.js';

const fmtPct = v => (v == null ? '' : `${v > 0 ? '+' : ''}${Number(v).toFixed(2)}%`);

function Quote({ name, stock }) {
  return (
    <span className="inline-flex items-baseline gap-1.5 whitespace-nowrap">
      <span className="text-ui-muted">{name}</span>
      <span className="font-semibold text-ui-text tabular-nums">${stock.price}</span>
      <Delta value={stock.changePct} text={fmtPct(stock.changePct)} />
    </span>
  );
}

/**
 * 可收合的市場摘要（不 sticky，不永久占用 Header 高度）。
 * 收合時只有一行：創見股價＋漲跌（過期時加警示徽章）；展開才列出競品與更新倒數。
 *
 * quotes: [{ code, name, stock }]（競品）；self：創見股價資料；countdown：倒數元件（節點）。
 */
export default function MarketSummary({ self, quotes, stale, staleHint, countdown }) {
  const [open, setOpen] = useState(false);
  if (!self && quotes.length === 0 && !countdown) return null;
  return (
    <div className="bg-ui-surface border-b border-ui-line">
      <div className="max-w-content mx-auto px-3 sm:px-4 min-h-10 py-1 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs">
        <button type="button" onClick={() => setOpen(o => !o)} aria-expanded={open} aria-controls="market-summary-detail"
          className="ui-focus inline-flex items-center gap-1 font-medium text-ui-secondary min-h-8 -ml-1 px-1 rounded">
          市場摘要<Icon name={open ? 'chevronup' : 'chevrondown'} />
        </button>
        {self && <Quote name="創見" stock={self} />}
        {stale && <StatusBadge tone="warn" title={staleHint}>股價資料過期</StatusBadge>}
        {open && (
          <>
            <span id="market-summary-detail" className="contents">
              {quotes.map(q => <Quote key={q.code} name={q.name} stock={q.stock} />)}
              {self && <span className="text-ui-muted">{fmtStockUpdated(self)}</span>}
              {countdown}
            </span>
          </>
        )}
        {!open && <span id="market-summary-detail" className="hidden" />}
      </div>
    </div>
  );
}
