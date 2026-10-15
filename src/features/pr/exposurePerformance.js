import { dayKeyOf } from './exposureInsights.js';
import { safeHttpUrl } from '../../utils/safeUrl.js';

// 「新聞稿曝光成效」的分組與統計（純函式，不碰畫面與 Firestore）。
//
// 資料來源：media_exposure（公開、已去除內部備註的人工確認曝光）。
// 隱私：toPublicRecord 只挑白名單欄位。就算上游資料物件意外帶了
// media_exposure_private 的欄位（內部備註、來源檔名、工作表、列號…），
// 也不會進到畫面、統計或 Excel。

export const EXPOSURE_TYPE_LABELS = { online: '網路新聞', video: '影音', social: '社群' };
export const typeLabel = type => EXPOSURE_TYPE_LABELS[type] || '其他';

/** media_exposure_private 的欄位名稱——測試用來確認它們不會出現在畫面或匯出。 */
export const PRIVATE_FIELD_NAMES = ['noteInternal', 'sources', 'rawMediaName', 'rawLink', 'file', 'sheet', 'row'];

const toDate = v => (v?.toDate ? v.toDate() : new Date(v || 0));
const str = v => (typeof v === 'string' ? v.trim() : '');

// ── 文字正規化 ────────────────────────────────────────────
/** NFKC（全形→半形、相容字元統一）＋ 小寫。搜尋與分組都用它。 */
export const normalizeText = s => String(s ?? '').normalize('NFKC').toLowerCase();

/**
 * 標題分組鍵（保守）：NFKC → 小寫 → 移除所有空白 → 去掉「首尾」的標點與符號。
 * 刻意不做：同義詞、斷詞、相似度比對、移除標題中間的標點、移除媒體後綴。
 * 兩個標題只有在正規化後「完全相同」才會合併；無法判斷就分開。
 */
export function normalizeTitleKey(title) {
  return normalizeText(title)
    .replace(/\s+/g, '')
    .replace(/^[\p{P}\p{S}]+/u, '')
    .replace(/[\p{P}\p{S}]+$/u, '');
}

const collapse = s => String(s ?? '').replace(/\s+/g, ' ').trim();

// ── 公開欄位白名單 ────────────────────────────────────────
/** 把 Firestore 文件轉成「只含公開欄位」的紀錄；日期無效的紀錄回傳 null。 */
export function toPublicRecord(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const date = toDate(raw.exposureDate);
  if (isNaN(date.getTime())) return null;
  return {
    id: String(raw.id ?? ''),
    date,
    day: dayKeyOf(date),
    mediaName: collapse(raw.mediaName) || '未知媒體',
    reporter: collapse(raw.reporter),
    title: collapse(raw.title),
    link: safeHttpUrl(raw.link),           // 不安全網址一律變成 ''，畫面不會輸出可點擊連結
    type: str(raw.exposureType) || 'online',
    // 若資料日後有可靠的新聞稿識別欄位，優先用它分組（標題正規化只是 fallback）
    campaignId: str(raw.campaignId) || str(raw.pressReleaseId),
    campaignName: collapse(raw.campaignName) || collapse(raw.pressReleaseTitle),
  };
}

export const toPublicRecords = rows => (rows || []).map(toPublicRecord).filter(Boolean);

// ── 篩選 ──────────────────────────────────────────────────
export const EMPTY_FILTERS = { query: '', media: 'all', type: 'all', from: '', to: '' };

export function hasActiveFilters(f) {
  return Boolean(f.query.trim()) || f.media !== 'all' || f.type !== 'all' || Boolean(f.from) || Boolean(f.to);
}

/**
 * 統一的篩選入口：統計卡、媒體排行、主題分組、明細、Excel 匯出全部吃這一份結果，
 * 數字才不會互相不一致。日期是台灣日曆日（YYYY-MM-DD，含起訖當天）；起日晚於迄日時對調。
 */
export function applyFilters(records, filters = EMPTY_FILTERS) {
  const q = normalizeText(filters.query).trim();
  let { from, to } = filters;
  if (from && to && from > to) [from, to] = [to, from];
  return records.filter(r => {
    if (filters.media !== 'all' && r.mediaName !== filters.media) return false;
    if (filters.type !== 'all' && r.type !== filters.type) return false;
    if (from && r.day < from) return false;
    if (to && r.day > to) return false;
    if (q && !normalizeText(`${r.title} ${r.mediaName} ${r.reporter}`).includes(q)) return false;
    return true;
  });
}

// ── 分組 ──────────────────────────────────────────────────
const byNewest = (a, b) => b.date - a.date || a.mediaName.localeCompare(b.mediaName, 'zh-Hant') || a.id.localeCompare(b.id);
const countsToList = (counts, total, labelOf) => Object.entries(counts)
  .map(([key, count]) => ({ key, label: labelOf ? labelOf(key) : key, count, share: total ? count / total : 0 }))
  .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label, 'zh-Hant'));
const bump = (obj, key) => { obj[key] = (obj[key] || 0) + 1; };

/** 分組鍵：有可靠識別欄位就用它；否則用標題正規化；標題是空的就各自獨立。 */
export function topicKeyOf(record) {
  if (record.campaignId) return { key: `id:${record.campaignId}`, source: 'id' };
  const title = normalizeTitleKey(record.title);
  if (title) return { key: `title:${title}`, source: 'title' };
  return { key: `untitled:${record.id || record.date.getTime()}`, source: 'title' };
}

export function groupByTopic(records) {
  const groups = new Map();
  [...records].sort((a, b) => a.date - b.date).forEach(r => {
    const { key, source } = topicKeyOf(r);
    let g = groups.get(key);
    if (!g) { g = { key, source, items: [], titleCounts: new Map(), campaignName: '' }; groups.set(key, g); }
    g.items.push(r);
    if (r.campaignName && !g.campaignName) g.campaignName = r.campaignName;
    if (r.title) g.titleCounts.set(r.title, (g.titleCounts.get(r.title) || 0) + 1);
  });

  return [...groups.values()].map(g => {
    const total = g.items.length;
    const mediaCounts = {}; const typeCounts = {};
    g.items.forEach(r => { bump(mediaCounts, r.mediaName); bump(typeCounts, r.type); });
    // 名稱：優先用資料給的名稱；否則取出現最多次的原始標題（同數量取最早出現的）
    let name = g.campaignName;
    if (!name) {
      let best = '', bestN = 0;
      g.titleCounts.forEach((n, t) => { if (n > bestN) { best = t; bestN = n; } });
      name = best || '（無標題）';
    }
    const items = [...g.items].sort(byNewest);
    return {
      key: g.key, source: g.source, name, total,
      mediaCount: Object.keys(mediaCounts).length,
      firstDate: g.items[0].date, lastDate: g.items[g.items.length - 1].date,
      typeCounts: countsToList(typeCounts, total, typeLabel),
      topMedia: countsToList(mediaCounts, total).slice(0, 3),
      items,
    };
  }).sort((a, b) => b.total - a.total || b.lastDate - a.lastDate || a.name.localeCompare(b.name, 'zh-Hant'));
}

/** 一份（已篩選的）紀錄 → 摘要、類型分布、媒體排行、主題分組。 */
export function buildPerformance(records) {
  const total = records.length;
  const mediaCounts = {}; const typeCounts = {};
  records.forEach(r => { bump(mediaCounts, r.mediaName); bump(typeCounts, r.type); });
  const topics = groupByTopic(records);
  let firstDate = null; let latestDate = null;
  records.forEach(r => {
    if (!firstDate || r.date < firstDate) firstDate = r.date;
    if (!latestDate || r.date > latestDate) latestDate = r.date;
  });
  return {
    total,
    mediaCount: Object.keys(mediaCounts).length,
    topicCount: topics.length,
    firstDate, latestDate,
    typeCounts: countsToList(typeCounts, total, typeLabel),
    mediaRanking: countsToList(mediaCounts, total),
    topics,
  };
}

/** 篩選選項（媒體、類型）依「全部已載入資料」產生，篩選後選項不會消失。 */
export function filterOptions(records) {
  const media = [...new Set(records.map(r => r.mediaName))].sort((a, b) => a.localeCompare(b, 'zh-Hant'));
  const types = [...new Set(records.map(r => r.type))].sort();
  return { media, types };
}

// ── Excel ─────────────────────────────────────────────────
/**
 * 試算表公式注入防護：以 = + - @ 開頭（含前面有空白／控制字元）的文字，前面補一個
 * 單引號，Excel 就會當成純文字而不是公式。非字串（數字、日期）原樣保留。
 */
export function sanitizeCell(value) {
  // eslint-disable-next-line no-control-regex
  return typeof value === 'string' && /^[\s\u0000-\u001f]*[=+\-@]/.test(value) ? `'${value}` : value;
}
const sanitizeRow = row => Object.fromEntries(Object.entries(row).map(([k, v]) => [k, sanitizeCell(v)]));

const dayText = d => dayKeyOf(d);

/** 曝光明細列：只有白名單欄位（沒有任何內部備註／來源檔案資訊）。 */
export function buildDetailRows(topics) {
  return topics.flatMap(t => t.items.map(r => sanitizeRow({
    '新聞稿／主題': t.name,
    日期: r.day,
    媒體: r.mediaName,
    記者: r.reporter,
    新聞標題: r.title,
    曝光類型: typeLabel(r.type),
    連結: r.link,
  })));
}

export function buildSummaryRows(topics) {
  return topics.map(t => sanitizeRow({
    '新聞稿／主題': t.name,
    曝光總數: t.total,
    不重複媒體數: t.mediaCount,
    首次曝光: dayText(t.firstDate),
    最近曝光: dayText(t.lastDate),
    主要媒體: t.topMedia.map(m => `${m.label}（${m.count}）`).join('、'),
    類型分布: t.typeCounts.map(c => `${c.label} ${c.count}`).join('、'),
  }));
}
