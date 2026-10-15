
import Card from '../../components/Card.jsx';

// ═══════════════════════════════════════════════════════════
// IR TAB — 每日交易資訊（開收盤、三大法人）
// ═══════════════════════════════════════════════════════════
export function DailyTrading({ daily }) {
  const fmtK = v => {
    const n = Math.abs(Number(v || 0));
    if (n >= 10000) return `${(n / 10000).toFixed(0)}萬`;
    if (n >= 1000) return `${(n / 1000).toFixed(1)}千`;
    return n.toLocaleString();
  };
  const netStr = (v, unit = '') => {
    if (v == null) return '—';
    return (v > 0 ? '+' : '') + fmtK(v) + unit;
  };
  // 台股慣例：上漲/買超用紅色、下跌/賣超用綠色（跟美股相反）
  const nc = v => v == null ? 'text-gray-400' : v > 0 ? 'text-red-400' : v < 0 ? 'text-green-400' : 'text-gray-400';

  if (!daily || (!daily.close && !daily.open)) return (
    <Card title="創見 2451 每日交易資訊" icon="chart">
      <div className="h-20 flex items-center justify-center text-gray-600 text-sm">
        {daily === null ? '載入中…' : '尚無資料（Actions 跑完後自動更新）'}
      </div>
    </Card>
  );

  const change = (daily.close != null && daily.open != null)
    ? +(daily.close - daily.open).toFixed(2) : null;

  return (
    <Card title="創見 2451 每日交易資訊" icon="chart">
      <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
        {/* 股價 */}
        <div className="bg-gray-800/40 rounded-xl p-3 border border-gray-700/40">
          <p className="text-xs text-gray-500 mb-1">{daily.priceDate || ''} 股價</p>
          {change != null && (
            <p className={`text-2xl font-bold mb-2 ${nc(change)}`}>
              {change > 0 ? '+' : ''}{change}
            </p>
          )}
          <div className="space-y-1.5">
            {[['開盤', daily.open], ['收盤', daily.close], ['最高', daily.high], ['最低', daily.low]].map(([k, v]) => (
              <div key={k} className="flex justify-between text-sm">
                <span className="text-gray-500">{k}</span>
                <span className="text-ink tabular-nums">{v != null ? v : '—'}</span>
              </div>
            ))}
            <div className="flex justify-between text-sm border-t border-gray-700/40 pt-1 mt-1">
              <span className="text-gray-500">交易量</span>
              <span className="text-ink tabular-nums">{daily.volume ? fmtK(daily.volume) + ' 股' : '—'}</span>
            </div>
          </div>
        </div>

        {/* 外資 */}
        <div className="bg-gray-800/40 rounded-xl p-3 border border-gray-700/40">
          <p className="text-xs text-gray-500 mb-1">{daily.institutionalDate || daily.priceDate || ''} 外資</p>
          <p className={`text-2xl font-bold mb-2 ${nc(daily.foreignNet)}`}>
            {netStr(daily.foreignNet)}
          </p>
          <div className="space-y-1.5">
            <div className="flex justify-between text-sm">
              <span className="text-gray-500">買進</span>
              <span className="text-red-400/80 tabular-nums">{daily.foreignBuy != null ? fmtK(daily.foreignBuy) : '—'}</span>
            </div>
            <div className="flex justify-between text-sm">
              <span className="text-gray-500">賣出</span>
              <span className="text-green-400/80 tabular-nums">{daily.foreignSell != null ? fmtK(daily.foreignSell) : '—'}</span>
            </div>
          </div>
          {daily.foreignBuy == null && <p className="text-xs text-gray-600 mt-2">暫無法人資料</p>}
        </div>

        {/* 投信 */}
        <div className="bg-gray-800/40 rounded-xl p-3 border border-gray-700/40">
          <p className="text-xs text-gray-500 mb-1">{daily.institutionalDate || daily.priceDate || ''} 投信</p>
          <p className={`text-2xl font-bold mb-2 ${nc(daily.trustNet)}`}>
            {netStr(daily.trustNet)}
          </p>
          <div className="space-y-1.5">
            <div className="flex justify-between text-sm">
              <span className="text-gray-500">買進</span>
              <span className="text-red-400/80 tabular-nums">{daily.trustBuy != null ? fmtK(daily.trustBuy) : '—'}</span>
            </div>
            <div className="flex justify-between text-sm">
              <span className="text-gray-500">賣出</span>
              <span className="text-green-400/80 tabular-nums">{daily.trustSell != null ? fmtK(daily.trustSell) : '—'}</span>
            </div>
          </div>
          {daily.trustBuy == null && <p className="text-xs text-gray-600 mt-2">暫無法人資料</p>}
        </div>
      </div>
      <p className="text-xs text-gray-700 mt-2">* 股價：TWSE 即時報價 · 法人：FinMind · 數量單位：股</p>
    </Card>
  );
}
