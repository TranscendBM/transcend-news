import { useMemo } from 'react';

import { safeHttpUrl } from '../../utils/safeUrl.js';
import { fmtStockUpdated } from '../../utils/dates.js';
import { STOCK_META } from '../../config/competitors.js';
import FinancialMetricCard, { Delta } from './FinancialMetricCard.jsx';
import { DataStatusBadge } from './DataStatus.jsx';
import {
  dataStatus, stocksStatus, latestRevenueSummary, latestQuarterSummary, latestDividendSummary,
  sortMaterial, fmtNum, fmtPct, fmtMillions, fmtSignedPct, trend,
} from './irData.js';

// 總覽與各子頁共用的「摘要視圖」：同一份選擇器（irData.js）算出來，兩邊顯示一致、不複製公式。

/** 各資料集狀態（統一：正常／更新中／資料過期／載入失敗／尚無資料）。 */
export function useIRStatuses({ stocks, revenue, financials, dividends, material, loadErrors = {}, loading = false }) {
  return useMemo(() => ({
    stocks: stocksStatus(stocks, { hasError: !!loadErrors.stocks, receivedAny: !loading }),
    revenue: dataStatus(revenue, { hasError: !!loadErrors.revenue }),
    financials: dataStatus(financials, { hasError: !!loadErrors.financials }),
    dividends: dataStatus(dividends, { hasError: !!loadErrors.dividends }),
    material: dataStatus(material, { hasError: !!loadErrors.material }),
  }), [stocks, revenue, financials, dividends, material, loadErrors, loading]);
}

export const STATUS_TARGET = {
  stocks: { label: '股價', section: 'market' },
  revenue: { label: '月營收', section: 'financials' },
  financials: { label: '季度財報', section: 'financials' },
  dividends: { label: '股利', section: 'disclosures' },
  material: { label: '重大訊息', section: 'disclosures' },
};

/** 一排資料狀態徽章；有問題（過期／失敗）的可以點，帶使用者前往相關子頁。 */
export function StatusStrip({ statuses, onNavigate, keys = Object.keys(STATUS_TARGET) }) {
  return (
    <div className="flex flex-wrap items-center gap-2" aria-label="資料狀態">
      {keys.map(key => {
        const st = statuses[key];
        const target = STATUS_TARGET[key];
        const badge = <DataStatusBadge status={st} label={target.label} />;
        return (st === 'stale' || st === 'error') && onNavigate
          ? <button key={key} type="button" onClick={() => onNavigate(target.section)}
              aria-label={`${target.label}${st === 'stale' ? '資料過期' : '載入失敗'}，前往查看`}
              className="rounded-full">{badge}</button>
          : <span key={key}>{badge}</span>;
      })}
    </div>
  );
}

const volumeText = v => (Number(v) > 0 ? `${(Number(v) / 1000).toFixed(0)} 張` : '—');
const noData = status => (status === 'loading' ? '資料更新中…' : status === 'error' ? '載入失敗' : '尚無資料');

/** 創見股價摘要：價格、漲跌（▲▼＋正負號）、成交量、更新時間。過期的不當作即時價格。 */
export function SelfStockSummary({ stock, status }) {
  if (!stock) return null;
  const stale = status === 'stale';
  const pct = stock.changePct;
  const change = stock.change != null ? `${Number(stock.change) > 0 ? '+' : ''}${Number(stock.change).toFixed(1)}` : '—';
  return (
    <div>
      <div className="flex flex-wrap items-end gap-x-3 gap-y-1">
        <p className="text-3xl font-bold text-ink tabular-nums">{stock.price != null ? `$${fmtNum(stock.price)}` : '—'}</p>
        <Delta value={pct} text={`${fmtSignedPct(pct)}（${change}）`} />
        {stale && <DataStatusBadge status="stale" />}
      </div>
      <p className="text-sm text-gray-600 mt-1">成交量 {volumeText(stock.volume)}</p>
      <p className={`text-xs mt-1 ${stale ? 'text-amber-500/80' : 'text-gray-600'}`}>
        {fmtStockUpdated(stock)}{stale ? '（非即時，交易時段內已超過 30 分鐘未更新）' : ''}
      </p>
    </div>
  );
}

/** 最新財務數字：月營收（含月增率／年增率）、EPS、毛利率、營業利益率、稅後淨利率。 */
export function FinancialSnapshot({ revenue, financials, statuses, showNetMargin = false }) {
  const rev = useMemo(() => latestRevenueSummary(revenue), [revenue]);
  const q = useMemo(() => latestQuarterSummary(financials), [financials]);
  const quarter = q ? (q.date || '').slice(0, 7) : '';
  const revHint = rev ? undefined : noData(statuses.revenue);
  const finHint = q ? undefined : noData(statuses.financials);
  return (
    <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
      <FinancialMetricCard label={rev ? `月營收（${rev.year}/${String(rev.month).padStart(2, '0')}）` : '最近月營收'}
        value={rev ? fmtMillions(rev.revenue) : '—'} hint={revHint}>
        {rev && <>
          <span>月增 <Delta value={rev.mom} text={fmtSignedPct(rev.mom)} /></span>
          <span>年增 <Delta value={rev.yoy} text={fmtSignedPct(rev.yoy)} /></span>
        </>}
      </FinancialMetricCard>
      <FinancialMetricCard label={quarter ? `EPS（${quarter}）` : '最新季度 EPS'}
        value={q && q.eps != null ? `$${fmtNum(q.eps)}` : '—'} hint={finHint} />
      <FinancialMetricCard label="毛利率" value={q ? fmtPct(q.grossMargin) : '—'} hint={finHint} />
      <FinancialMetricCard label="營業利益率" value={q ? fmtPct(q.opMargin) : '—'} hint={finHint} />
      {showNetMargin && (
        <FinancialMetricCard label="稅後淨利率" value={q ? fmtPct(q.netMargin) : '—'} hint={finHint} />
      )}
    </div>
  );
}

/** 最新股利：現金、股票、合計；沒有資料顯示「—」。 */
export function DividendSnapshot({ dividends, status }) {
  const d = useMemo(() => latestDividendSummary(dividends), [dividends]);
  if (!d) return <p className="text-sm text-gray-500 text-center py-4">{noData(status)}</p>;
  return (
    <div className="grid grid-cols-3 gap-3">
      <FinancialMetricCard label={`${d.year} 現金股利`} value={d.cash != null ? `$${fmtNum(d.cash)}` : '—'} />
      <FinancialMetricCard label="股票股利" value={d.stock != null ? `$${fmtNum(d.stock)}` : '—'} />
      <FinancialMetricCard label="合計" value={d.total != null ? `$${fmtNum(d.total)}` : '—'} />
    </div>
  );
}

/** 最近重大訊息（摘要用，最多 limit 則；日期以數字比較排序）。 */
export function RecentMaterialList({ material, limit = 5, status }) {
  const rows = useMemo(() => sortMaterial(material).slice(0, limit), [material, limit]);
  if (!rows.length) return <p className="text-sm text-gray-500 text-center py-4">{noData(status)}</p>;
  return (
    <ul className="space-y-1.5">
      {rows.map((r, i) => {
        const link = safeHttpUrl(r.link);
        const name = (STOCK_META[r.code] && STOCK_META[r.code].name) || r.name || r.code;
        return (
          <li key={`${r.code}|${r.date}|${i}`} className="flex items-start gap-2 text-sm">
            <span className="font-semibold text-ink shrink-0">{name}</span>
            <span className="text-gray-500 shrink-0 tabular-nums">{r.date}</span>
            {link
              ? <a href={link} target="_blank" rel="noopener noreferrer" className="content-title min-w-0 flex-1 truncate hover:underline">{r.summary}</a>
              : <span className="text-gray-300 min-w-0 flex-1 truncate">{r.summary}</span>}
          </li>
        );
      })}
    </ul>
  );
}

/** 競品股價摘要列（價格＋漲跌）。 */
export function CompetitorStockRows({ stocks, codes }) {
  return (
    <ul className="divide-y divide-gray-800/50">
      {codes.map(code => {
        const s = stocks[code];
        const t = trend(s && s.changePct);
        return (
          <li key={code} className="flex items-center justify-between gap-2 py-1.5 text-sm">
            <span className="min-w-0 truncate">
              <span className="text-gray-500 tabular-nums">{code}</span>{' '}
              <span className="text-ink font-medium">{(s && s.name) || STOCK_META[code].name}</span>
            </span>
            <span className="flex items-center gap-3 shrink-0 tabular-nums">
              <span className="text-ink">{s && s.price != null ? `$${fmtNum(s.price)}` : '—'}</span>
              <span className="w-24 text-right"><Delta value={s && s.changePct} text={s ? fmtSignedPct(s.changePct) : '—'} /></span>
              <span className="sr-only">{t === 'up' ? '上漲' : t === 'down' ? '下跌' : t === 'flat' ? '平盤' : '無漲跌資料'}</span>
            </span>
          </li>
        );
      })}
    </ul>
  );
}
