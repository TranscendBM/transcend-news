import { isStockStale, stockUpdatedAtMs } from '../../utils/dates.js';

// IR 投資情報的「摘要」選擇器：總覽與各子頁共用同一份計算，不複製公式。
// 公式與既有圖表／表格一致：年增率 = (本期 − 去年同月) ÷ 去年同月；去年同月沒有（或為 0）→ 沒有年增率。

const isNum = v => v != null && v !== '' && Number.isFinite(Number(v));

/** 日期（YYYY-MM-DD、YYYY/MM、YYYY…）轉成可比較的數字 YYYYMMDD；解析不出來回傳 0（排在最舊）。 */
export function dateKey(value) {
  const m = /^(\d{4})\D?(\d{1,2})?\D?(\d{1,2})?/.exec(String(value ?? '').trim());
  if (!m) return 0;
  return Number(m[1]) * 10000 + Number(m[2] || 0) * 100 + Number(m[3] || 0);
}

/** 重大訊息依日期新→舊排序（數字比較，不用字串排序）。 */
export function sortMaterial(material) {
  if (!Array.isArray(material)) return [];
  return [...material].sort((a, b) => dateKey(b.date) - dateKey(a.date));
}

/** 重大訊息的年份清單（新→舊）。 */
export function materialYears(material) {
  const years = new Set();
  (material || []).forEach(r => { const y = Math.floor(dateKey(r.date) / 10000); if (y) years.add(y); });
  return [...years].sort((a, b) => b - a);
}

export function filterMaterial(sorted, { code = 'all', year = 'all' } = {}) {
  return sorted.filter(r =>
    (code === 'all' || r.code === code) &&
    (year === 'all' || Math.floor(dateKey(r.date) / 10000) === Number(year)));
}

/** 最近一個月營收＋月增率＋年增率（單位：元）。沒有資料回傳 null。 */
export function latestRevenueSummary(revenue) {
  if (!Array.isArray(revenue) || !revenue.length) return null;
  const rows = revenue
    .filter(r => isNum(r.year) && isNum(r.month) && isNum(r.revenue))
    .map(r => ({ year: Number(r.year), month: Number(r.month), revenue: Number(r.revenue) }))
    .sort((a, b) => (a.year * 12 + a.month) - (b.year * 12 + b.month));
  if (!rows.length) return null;
  const cur = rows[rows.length - 1];
  const byKey = new Map(rows.map(r => [r.year * 12 + r.month, r.revenue]));
  const pct = (now, base) => (base > 0 ? +(((now - base) / base) * 100).toFixed(2) : null);
  return {
    year: cur.year,
    month: cur.month,
    revenue: cur.revenue,
    mom: pct(cur.revenue, byKey.get(cur.year * 12 + cur.month - 1)),
    yoy: pct(cur.revenue, byKey.get((cur.year - 1) * 12 + cur.month)),
  };
}

/** 最新一季：毛利率／營業利益率／稅後淨利率（0 或空值 → null，與表格一致顯示「—」）與 EPS。 */
export function latestQuarterSummary(financials) {
  if (!Array.isArray(financials) || !financials.length) return null;
  const latest = [...financials].sort((a, b) => dateKey(b.date) - dateKey(a.date))[0];
  const pct = v => (isNum(v) && Number(v) !== 0 ? Number(v) : null);
  return {
    date: latest.date || '',
    grossMargin: pct(latest.grossMargin),
    opMargin: pct(latest.opMargin),
    netMargin: pct(latest.netMargin),
    eps: isNum(latest.eps) ? Number(latest.eps) : null,
  };
}

/** 單筆股利的合計：優先用 totalDividend，否則現金＋股票（先轉成數字再相加，不會變成字串拼接）。 */
export function dividendTotal(record) {
  const total = Number(record?.totalDividend);
  if (Number.isFinite(total) && total > 0) return total;
  return (Number(record?.cashDividend) || 0) + (Number(record?.stockDividend) || 0);
}

/** 股利依年度新→舊（數字比較）。 */
export function sortDividends(dividends) {
  if (!Array.isArray(dividends)) return [];
  return [...dividends].sort((a, b) => dateKey(b.year) - dateKey(a.year));
}

/** 最近一個年度的股利。沒有資料回傳 null。 */
export function latestDividendSummary(dividends) {
  const latest = sortDividends(dividends)[0];
  if (!latest) return null;
  return {
    year: latest.year,
    cash: Number(latest.cashDividend) > 0 ? Number(latest.cashDividend) : null,
    stock: Number(latest.stockDividend) > 0 ? Number(latest.stockDividend) : null,
    total: dividendTotal(latest) > 0 ? dividendTotal(latest) : null,
  };
}

/**
 * 資料狀態（全站 IR 統一）：
 *   loading 更新中｜error 載入失敗｜empty 尚無資料｜stale 資料過期｜ok 正常
 * value === null 代表還在載入；hasError 由載入流程回報；過期只針對股價（沿用既有的 isStockStale 門檻）。
 */
export function dataStatus(value, { hasError = false, isEmpty, stale = false } = {}) {
  if (hasError) return 'error';
  if (value === null || value === undefined) return 'loading';
  const empty = typeof isEmpty === 'boolean' ? isEmpty
    : Array.isArray(value) ? value.length === 0
    : Object.keys(value).length === 0;
  if (empty) return 'empty';
  return stale ? 'stale' : 'ok';
}

export const STATUS_LABEL = {
  ok: '正常', loading: '更新中', stale: '資料過期', error: '載入失敗', empty: '尚無資料',
};

/** 股價整體狀態：2451 缺資料 → empty；任一檔過期 → stale。stocks 初始是 {}（尚未收到），視為 loading。 */
export function stocksStatus(stocks, { hasError = false, receivedAny = false } = {}) {
  if (hasError) return 'error';
  const keys = Object.keys(stocks || {});
  if (!keys.length) return receivedAny ? 'empty' : 'loading';
  return keys.some(code => isStockStale(stocks[code])) ? 'stale' : 'ok';
}

/** 股價最後更新時間（毫秒）：取各檔最新的一個；都沒有 → null。 */
export function latestStockUpdate(stocks) {
  const times = Object.values(stocks || {}).map(stockUpdatedAtMs).filter(Boolean);
  return times.length ? Math.max(...times) : null;
}

/** 價格數字 → 字串；缺值 → '—'（不會出現 NaN、undefined、0.00）。 */
export function fmtNum(v, digits = 2) {
  return isNum(v) ? Number(v).toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits }) : '—';
}

/** 百分比（帶正負號）；缺值 → '—'。 */
export function fmtSignedPct(v) {
  if (!isNum(v)) return '—';
  const n = Number(v);
  return `${n > 0 ? '+' : ''}${n.toFixed(2)}%`;
}

/** 百分比（不帶正負號，利潤率用）；缺值 → '—'。 */
export function fmtPct(v) {
  return isNum(v) ? `${Number(v).toFixed(1)}%` : '—';
}

/** 營收（元）→ 百萬元字串；缺值 → '—'。 */
export function fmtMillions(v) {
  return isNum(v) ? `${Math.round(Number(v) / 1e6).toLocaleString('en-US')} 百萬元` : '—';
}

/** 漲跌方向（台股：紅漲綠跌）。 */
export function trend(v) {
  if (!isNum(v)) return 'none';
  return Number(v) > 0 ? 'up' : Number(v) < 0 ? 'down' : 'flat';
}
