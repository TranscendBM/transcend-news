import { dayKeyOf } from './exposureInsights.js';
import { safeHttpUrl } from '../../utils/safeUrl.js';
import { detectEvent, EVENT_KIND_LABELS } from './exposureEvents.js';

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

// ── 相似標題（同一則新聞稿、各媒體改了標題）────────────────
/** 兩個標題的字元雙連詞 Dice 相似度（0～1）。只在發布日相差 1 天內才拿來比。 */
export const SIMILAR_THRESHOLD = 0.4;
const DAY_MS = 86400000;
const dayNum = day => { const [y, m, d] = day.split('-').map(Number); return Date.UTC(y, m - 1, d); };

function bigrams(title) {
  const s = normalizeText(title).replace(/[\s\p{P}\p{S}]/gu, '');
  const grams = new Set();
  for (let i = 0; i < s.length - 1; i++) grams.add(s.slice(i, i + 2));
  return grams;
}
export function titleSimilarity(a, b) {
  const ga = bigrams(a); const gb = bigrams(b);
  if (!ga.size || !gb.size) return 0;
  let shared = 0;
  ga.forEach(g => { if (gb.has(g)) shared += 1; });
  return (2 * shared) / (ga.size + gb.size);
}

export const BASIS_LABELS = {
  id: '新聞稿編號',
  event: '事件規則',
  similar: '標題相似',
  title: '標題相同',
  single: '單篇',
};

/**
 * 分組（由嚴到寬，每一層都是可解釋的規則；同一組內任兩篇只要被任何一層連起來就算同組）：
 *   1. campaignId／pressReleaseId 相同（有編號的紀錄只跟同編號的合併，不再套用下面的規則）
 *   2. 事件規則相同（同一期的月營收公告、同一季的財報／獲利，見 exposureEvents.js）
 *   3. 正規化後標題完全相同（不限日期）
 *   4. 發布日相差 1 天內、標題相似度 ≥ SIMILAR_THRESHOLD（兩篇已被認成不同事件的不比）
 * 都不符合就各自獨立。
 */
export function groupByTopic(records, { similarThreshold = SIMILAR_THRESHOLD } = {}) {
  const items = [...records].sort((a, b) => a.date - b.date || a.id.localeCompare(b.id));
  const n = items.length;
  const parent = items.map((_, i) => i);
  const find = i => { let r = i; while (parent[r] !== r) r = parent[r]; let c = i; while (parent[c] !== r) { const next = parent[c]; parent[c] = r; c = next; } return r; };
  const union = (i, j) => { const ri = find(i); const rj = find(j); if (ri !== rj) parent[rj] = ri; };

  const events = items.map(r => (r.campaignId ? null : detectEvent(r.title, r.day)));
  const titleKeys = items.map(r => normalizeTitleKey(r.title));

  // 1)～3)：用「鍵」合併
  const firstByKey = new Map();
  const link = (key, i) => { if (firstByKey.has(key)) union(i, firstByKey.get(key)); else firstByKey.set(key, i); };
  items.forEach((r, i) => {
    if (r.campaignId) { link('id:' + r.campaignId, i); return; }
    if (events[i]) link(events[i].key, i);
    if (titleKeys[i]) link('title:' + titleKeys[i], i);
  });

  // 4)：發布日相差 1 天內的相似標題
  const grams = items.map(r => (r.campaignId ? null : bigrams(r.title)));
  const dayNums = items.map(r => dayNum(r.day));
  for (let i = 0; i < n; i++) {
    if (!grams[i] || !grams[i].size) continue;
    for (let j = i + 1; j < n && dayNums[j] - dayNums[i] <= DAY_MS; j++) {
      if (!grams[j] || !grams[j].size || find(i) === find(j)) continue;
      if (events[i] && events[j] && events[i].key !== events[j].key) continue;
      let shared = 0;
      grams[i].forEach(g => { if (grams[j].has(g)) shared += 1; });
      if ((2 * shared) / (grams[i].size + grams[j].size) >= similarThreshold) union(i, j);
    }
  }

  const groups = new Map();
  items.forEach((r, i) => {
    const root = find(i);
    let g = groups.get(root);
    if (!g) { g = { items: [], events: new Map(), titleCounts: new Map(), campaignName: '', titleKeys: new Set(), hasId: false }; groups.set(root, g); }
    g.items.push(r);
    if (r.campaignId) g.hasId = true;
    if (r.campaignName && !g.campaignName) g.campaignName = r.campaignName;
    if (events[i]) g.events.set(events[i].key, (g.events.get(events[i].key) || { ...events[i], count: 0 }));
    if (events[i]) g.events.get(events[i].key).count += 1;
    if (r.title) g.titleCounts.set(r.title, (g.titleCounts.get(r.title) || 0) + 1);
    g.titleKeys.add(titleKeys[i]);
  });

  return [...groups.values()].map(g => {
    const total = g.items.length;
    const mediaCounts = {}; const typeCounts = {};
    g.items.forEach(r => { bump(mediaCounts, r.mediaName); bump(typeCounts, r.type); });

    // 主要事件（同一組若有多個事件鍵，取報導最多的）
    const event = [...g.events.values()].sort((a, b) => b.count - a.count)[0] || null;

    let basis = 'single';
    if (g.hasId) basis = 'id';
    else if (event && total > 1) basis = 'event';
    else if (total > 1) basis = g.titleKeys.size === 1 ? 'title' : 'similar';

    // 名稱：編號給的名稱 → 事件名稱 → 出現最多次的原始標題（同數量取最早出現的）
    let name = g.campaignName;
    if (!name && basis === 'event') name = event.label;
    if (!name) {
      let best = ''; let bestN = 0;
      g.titleCounts.forEach((count, t) => { if (count > bestN) { best = t; bestN = count; } });
      name = best || '（無標題）';
    }
    const sorted = [...g.items].sort(byNewest);
    return {
      key: g.hasId ? 'id:' + g.items[0].campaignId : (basis === 'event' ? event.key : 'g:' + g.items[0].id + ':' + g.items[0].date.getTime()),
      basis, basisLabel: BASIS_LABELS[basis],
      eventKind: basis === 'event' ? event.kind : null,
      name, total,
      mediaCount: Object.keys(mediaCounts).length,
      firstDate: g.items[0].date, lastDate: g.items[g.items.length - 1].date,
      typeCounts: countsToList(typeCounts, total, typeLabel),
      topMedia: countsToList(mediaCounts, total).slice(0, 3),
      items: sorted,
    };
  }).sort((x, y) => y.total - x.total || y.lastDate - x.lastDate || x.name.localeCompare(y.name, 'zh-Hant'));
}

// ── 主題排序 ─────────────────────────────────────────────
export const TOPIC_SORTS = { recent: '最新優先', count: '曝光數最多' };

/**
 * 主題清單排序（不改動原陣列）：
 *   recent：依「最近曝光時間」由近到遠；同一時間再依曝光數、首次曝光時間、名稱
 *   count ：依曝光數由多到少；同數量再依最近曝光時間（groupByTopic 的原始順序）
 * 畫面清單與 Excel 匯出都用同一個排序結果，兩邊順序一致。
 */
export function sortTopics(topics, mode = 'recent') {
  const list = [...topics];
  if (mode === 'count') {
    return list.sort((a, b) => b.total - a.total || b.lastDate - a.lastDate || a.name.localeCompare(b.name, 'zh-Hant'));
  }
  return list.sort((a, b) => b.lastDate - a.lastDate || b.total - a.total || b.firstDate - a.firstDate
    || a.name.localeCompare(b.name, 'zh-Hant'));
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
    分組依據: t.basis === 'single' ? '' : t.basisLabel + (t.eventKind ? '（' + EVENT_KIND_LABELS[t.eventKind] + '）' : ''),
    曝光總數: t.total,
    不重複媒體數: t.mediaCount,
    首次曝光: dayText(t.firstDate),
    最近曝光: dayText(t.lastDate),
    主要媒體: t.topMedia.map(m => `${m.label}（${m.count}）`).join('、'),
    類型分布: t.typeCounts.map(c => `${c.label} ${c.count}`).join('、'),
  }));
}
