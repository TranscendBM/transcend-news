
import CompanyLogo from '../../components/logos/CompanyLogo.jsx';
import { isStockStale, fmtStockUpdated } from '../../utils/dates.js';
import { STOCK_META } from '../../config/competitors.js';

// ═══════════════════════════════════════════════════════════
// IR TAB — 股價卡片
// ═══════════════════════════════════════════════════════════
export function StockCard({ code, data }) {
  const meta = STOCK_META[code] || {};
  const up = data.changePct > 0, dn = data.changePct < 0;
  const stale = isStockStale(data);
  return (
    <div className="p-4 rounded-2xl bg-gray-900 transition-all">
      <div className="mb-2">
        <CompanyLogo code={code} height={24} />
      </div>
      <div className="flex justify-between items-start mb-2">
        <div>
          <p className="text-xs text-gray-500">{code}</p>
          <p className="font-bold text-ink">{data.name || meta.name}</p>
        </div>
        <div className="flex flex-col items-end gap-1">
          {stale && (
            <span className="text-xs px-2 py-0.5 rounded-full border" title="交易時段中超過 30 分鐘未更新"
              style={{ background: 'rgba(217,119,6,0.15)', color: '#b45309', borderColor: 'rgba(217,119,6,0.4)' }}>
              資料過期
            </span>
          )}
        </div>
      </div>
      <p className="text-2xl font-bold text-ink">{data.price != null ? `$${data.price}` : '—'}</p>
      {/* 台股慣例：上漲用紅色、下跌用綠色（跟美股相反） */}
      <div className={`flex items-center gap-1 text-sm font-semibold mt-1 ${up ? 'text-red-400' : dn ? 'text-green-400' : 'text-gray-400'}`}>
        <span>{up ? '▲' : dn ? '▼' : '─'}</span>
        <span>{data.changePct != null ? `${up ? '+' : ''}${Number(data.changePct).toFixed(2)}%` : '—'}</span>
      </div>
      <p className="text-sm text-gray-600 mt-1">
        {data.change != null ? `${up ? '+' : ''}${Number(data.change).toFixed(1)}` : '—'} ·
        量 {data.volume ? (data.volume / 1000).toFixed(0) + '張' : '—'}
      </p>
      <p className={`text-xs mt-1 ${stale ? 'text-amber-500/80' : 'text-gray-600'}`}>{fmtStockUpdated(data)}</p>
    </div>
  );
}
