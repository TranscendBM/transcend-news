import { useMemo, useState } from 'react';

import { safeHttpUrl } from '../../utils/safeUrl.js';
import { fmtStockUpdated } from '../../utils/dates.js';
import { STOCK_META } from '../../config/competitors.js';
import MetricCard, { Delta } from '../../components/ui/MetricCard.jsx';
import DataStateBanner from '../../components/ui/DataStateBanner.jsx';
import LoadingSkeleton from '../../components/ui/LoadingSkeleton.jsx';
import EmptyState from '../../components/ui/EmptyState.jsx';
import ErrorState from '../../components/ui/ErrorState.jsx';
import StatusBadge from '../../components/ui/StatusBadge.jsx';
import { writeParams } from '../../utils/urlState.js';
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
              className="ui-focus rounded-full min-h-8">{badge}</button>
          : <span key={key}>{badge}</span>;
      })}
    </div>
  );
}

/**
 * IR 資料狀態列，依嚴重度只顯示一種：
 *   載入失敗／資料過期 → 紅／黃色橫幅（含可點的項目與下一步）；載入中 → 中性橫幅；
 *   全部正常 → 縮成一行「資料狀態正常」，需要時才展開明細。
 */
export function IRStatusBar({ statuses, onNavigate }) {
  const [open, setOpen] = useState(false);
  const values = Object.values(statuses);
  if (values.includes('error')) {
    return (
      <DataStateBanner state="error" title="部分資料載入失敗">
        <span className="block mt-1"><StatusStrip statuses={statuses} onNavigate={onNavigate} /></span>
        <span className="block mt-1">點選項目前往查看；也可按右上角「重新整理」重試。</span>
      </DataStateBanner>
    );
  }
  if (values.includes('stale')) {
    return (
      <DataStateBanner state="stale" title="部分資料已過期">
        <span className="block mt-1"><StatusStrip statuses={statuses} onNavigate={onNavigate} /></span>
        <span className="block mt-1">畫面保留最後一次的資料，請勿當作即時資訊；可按右上角「重新整理」，或到系統健康查看排程是否正常。</span>
      </DataStateBanner>
    );
  }
  if (values.includes('loading')) {
    return <DataStateBanner state="loading" title="資料更新中" compact><StatusStrip statuses={statuses} /></DataStateBanner>;
  }
  return (
    <div className="flex flex-wrap items-center gap-2 text-sm">
      <StatusBadge tone="ok">資料狀態正常</StatusBadge>
      <button type="button" onClick={() => setOpen(o => !o)} aria-expanded={open}
        className="ui-focus text-xs text-ui-secondary underline min-h-8 px-1">{open ? '收合明細' : '查看明細'}</button>
      {open && <StatusStrip statuses={statuses} />}
    </div>
  );
}

const volumeText = v => (Number(v) > 0 ? `${(Number(v) / 1000).toFixed(0)} 張` : '—');
// 資料集狀態 → 指標卡狀態：載入中＝骨架、失敗＝載入失敗、其餘（沒資料）＝尚無資料
const cardState = status => (status === 'loading' ? 'loading' : status === 'error' ? 'error' : 'empty');

/** 列表型內容在沒有資料時的狀態（骨架／失敗／尚無資料），不留空白。 */
function ListState({ status, emptyTitle = '尚無資料' }) {
  if (status === 'loading') return <LoadingSkeleton lines={3} label="資料更新中" />;
  if (status === 'error') return <ErrorState message="載入失敗，請按右上角「重新整理」重試" />;
  return <EmptyState title={emptyTitle} className="py-4" />;
}

/** 創見股價摘要：價格、漲跌（▲▼＋正負號）、成交量、更新時間。過期的不當作即時價格。 */
export function SelfStockSummary({ stock, status }) {
  if (!stock) return null;
  const stale = status === 'stale';
  const pct = stock.changePct;
  const change = stock.change != null ? `${Number(stock.change) > 0 ? '+' : ''}${Number(stock.change).toFixed(1)}` : '—';
  return (
    <div>
      <div className="flex flex-wrap items-end gap-x-3 gap-y-1">
        <p className="text-3xl font-bold text-ui-text tabular-nums">{stock.price != null ? `$${fmtNum(stock.price)}` : '—'}</p>
        <Delta value={pct} text={`${fmtSignedPct(pct)}（${change}）`} />
        {stale && <DataStatusBadge status="stale" />}
      </div>
      <p className="text-sm text-ui-muted mt-1">成交量 {volumeText(stock.volume)}</p>
      <p className={`text-xs mt-1 ${stale ? 'text-[color:var(--warn)]' : 'text-ui-muted'}`}>
        {fmtStockUpdated(stock)}{stale ? '（非即時，交易時段內已超過 30 分鐘未更新）' : ''}
      </p>
      {stale && (
        <p className="text-xs text-ui-muted mt-1">
          可按右上角「重新整理」；若持續過期，請{' '}
          <button type="button" onClick={() => writeParams({ tab: 'health', section: null, filter: null })}
            className="ui-focus underline text-ui-secondary">到系統健康查看股價排程</button>。
        </p>
      )}
    </div>
  );
}

/** 最新財務數字：月營收（含月增率／年增率）、EPS、毛利率、營業利益率、稅後淨利率。 */
export function FinancialSnapshot({ revenue, financials, statuses, showNetMargin = false }) {
  const rev = useMemo(() => latestRevenueSummary(revenue), [revenue]);
  const q = useMemo(() => latestQuarterSummary(financials), [financials]);
  const quarter = q ? (q.date || '').slice(0, 7) : '';
  const revState = rev ? 'ready' : cardState(statuses.revenue);
  const finState = q ? 'ready' : cardState(statuses.financials);
  return (
    <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
      <MetricCard label={rev ? `月營收（${rev.year}/${String(rev.month).padStart(2, '0')}）` : '最近月營收'}
        value={rev ? fmtMillions(rev.revenue) : null} state={revState}>
        <span>月增 <Delta value={rev && rev.mom} text={rev ? fmtSignedPct(rev.mom) : ''} /></span>
        <span>年增 <Delta value={rev && rev.yoy} text={rev ? fmtSignedPct(rev.yoy) : ''} /></span>
      </MetricCard>
      <MetricCard label={quarter ? `EPS（${quarter}）` : '最新季度 EPS'}
        value={q && q.eps != null ? `$${fmtNum(q.eps)}` : null} state={finState} />
      <MetricCard label="毛利率" value={q ? fmtPct(q.grossMargin) : null} state={finState} />
      <MetricCard label="營業利益率" value={q ? fmtPct(q.opMargin) : null} state={finState} />
      {showNetMargin && (
        <MetricCard label="稅後淨利率" value={q ? fmtPct(q.netMargin) : null} state={finState} />
      )}
    </div>
  );
}

/** 最新股利：現金、股票、合計；沒有資料顯示「—」。 */
export function DividendSnapshot({ dividends, status }) {
  const d = useMemo(() => latestDividendSummary(dividends), [dividends]);
  if (!d) return <ListState status={status} />;
  return (
    <div className="grid grid-cols-3 gap-3">
      <MetricCard label={`${d.year} 現金股利`} value={d.cash != null ? `$${fmtNum(d.cash)}` : null} />
      <MetricCard label="股票股利" value={d.stock != null ? `$${fmtNum(d.stock)}` : null} />
      <MetricCard label="合計" value={d.total != null ? `$${fmtNum(d.total)}` : null} />
    </div>
  );
}

/** 最近重大訊息（摘要用，最多 limit 則；日期以數字比較排序）。 */
export function RecentMaterialList({ material, limit = 5, status }) {
  const rows = useMemo(() => sortMaterial(material).slice(0, limit), [material, limit]);
  if (!rows.length) return <ListState status={status} />;
  return (
    <ul className="divide-y divide-ui-line">
      {rows.map((r, i) => {
        const link = safeHttpUrl(r.link);
        const name = (STOCK_META[r.code] && STOCK_META[r.code].name) || r.name || r.code;
        return (
          <li key={`${r.code}|${r.date}|${i}`} className="flex flex-wrap items-start gap-x-2 gap-y-0.5 text-sm py-2">
            <span className="font-semibold text-ui-text shrink-0">{name}</span>
            <span className="text-ui-muted shrink-0 tabular-nums">{r.date}</span>
            {link
              ? <a href={link} target="_blank" rel="noopener noreferrer" className="content-title min-w-0 basis-full sm:basis-0 sm:flex-1 sm:truncate hover:underline break-words">{r.summary}</a>
              : <span className="text-ui-secondary min-w-0 basis-full sm:basis-0 sm:flex-1 sm:truncate break-words">{r.summary}</span>}
          </li>
        );
      })}
    </ul>
  );
}

/** 競品股價摘要列（價格＋漲跌）。 */
export function CompetitorStockRows({ stocks, codes }) {
  return (
    <ul className="divide-y divide-ui-line">
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
              {s && s.price != null
                ? <>
                    <span className="text-ui-text">${fmtNum(s.price)}</span>
                    <span className="w-24 text-right"><Delta value={s.changePct} text={fmtSignedPct(s.changePct)} /></span>
                  </>
                : <span className="text-xs text-ui-muted">尚無股價</span>}
              <span className="sr-only">{t === 'up' ? '上漲' : t === 'down' ? '下跌' : t === 'flat' ? '平盤' : '無漲跌資料'}</span>
            </span>
          </li>
        );
      })}
    </ul>
  );
}
