import { safeHttpUrl } from '../../utils/safeUrl.js';
import { taipeiDayStart } from '../../utils/dates.js';

// 事件中心（news_topics）的純函式：正規化、篩選、排序、統計。不碰畫面與 Firestore。
// 資料由後端 topic_cluster_job 產生（透明規則、零 API 費用）；這裡只讀、不寫。

export const TAGS = {
  all: '全部', transcend: '創見', competitor: '競品', upstream: '上游市場',
  finance: '財務', product: '產品', supply: '供應鏈', risk: '風險',
};
export const SENTIMENTS = { all: '情緒：全部', positive: '正面', neutral: '中立', negative: '負面' };
export const SORTS = { importance: '重要性', latest: '最新', volume: '聲量最高', surge: '快速升溫' };
export const EVENT_TYPE_LABELS = {
  revenue: '營收', earnings: '財報', exhibition: '展覽', product: '產品', supply: '供應鏈', price: '價格',
  risk: '風險', stock: '股市', corporate: '公司', other: '其他',
};
const HOUR = 3600e3;
export const TRANSCEND_NAME = '創見';

const toDate = v => {
  if (!v) return null;
  const d = v.toDate ? v.toDate() : new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
};
const strList = v => (Array.isArray(v) ? v.filter(x => typeof x === 'string') : []);
const num = (v, d = 0) => (Number.isFinite(Number(v)) && v !== null && v !== '' ? Number(v) : d);

/** 後端文件 → 畫面用的話題。缺少 id／標題／時間的文件回傳 null；文章連結一律經過 safeHttpUrl。 */
export function normalizeTopic(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const id = typeof raw.id === 'string' ? raw.id : '';
  const title = typeof raw.title === 'string' ? raw.title.trim() : '';
  const last = toDate(raw.lastPublishedAt);
  if (!id || !title || !last) return null;
  const companies = strList(raw.companies);
  // 「涉及創見」只認 companies／entities 明確包含創見；後端的 tags 即使有 transcend 也要再確認一次（第二層保護）。
  // 篩選、統計、PR 總覽與事件中心都讀正規化後的 tags，判定只有這一處，數字與清單才會一致。
  const mentionsTranscend = [...companies, ...strList(raw.entities)].includes(TRANSCEND_NAME);
  const tags = strList(raw.tags).filter(tag => tag !== 'transcend' || mentionsTranscend);
  if (mentionsTranscend && !tags.includes('transcend')) tags.push('transcend');
  const articles = (Array.isArray(raw.articles) ? raw.articles : []).map(a => ({
    id: String(a?.id ?? ''),
    title: String(a?.title ?? '').trim(),
    link: safeHttpUrl(a?.link),
    mediaName: String(a?.mediaName ?? '').trim() || '未知媒體',
    date: toDate(a?.pubDate),
    sentiment: ['positive', 'neutral', 'negative'].includes(a?.sentiment) ? a.sentiment : 'neutral',
  })).filter(a => a.id && a.title);
  return {
    id, title,
    summary: typeof raw.summary === 'string' ? raw.summary : '',
    eventType: typeof raw.eventType === 'string' ? raw.eventType : 'other',
    tags,
    companies,
    products: strList(raw.products),
    mediaNames: strList(raw.mediaNames),
    articleCount: num(raw.articleCount, articles.length),
    mediaCount: num(raw.mediaCount, strList(raw.mediaNames).length),
    positiveCount: num(raw.positiveCount), neutralCount: num(raw.neutralCount), negativeCount: num(raw.negativeCount),
    sentiment: ['positive', 'neutral', 'negative'].includes(raw.sentiment) ? raw.sentiment : 'neutral',
    sentimentScore: num(raw.sentimentScore),
    importance: Math.max(0, Math.min(100, num(raw.importanceScore))),
    importanceReasons: strList(raw.importanceReasons),
    count24h: num(raw.count24h), countPrev24h: num(raw.countPrev24h),
    velocity: raw.velocity24h === null || raw.velocity24h === undefined ? null : num(raw.velocity24h, null),
    first: toDate(raw.firstPublishedAt) || last, last,
    needsReview: Boolean(raw.needsReview),
    articleIds: strList(raw.articleIds),
    articles,
  };
}

export const normalizeTopics = rows => (rows || []).map(normalizeTopic).filter(Boolean);

export const isRising = t => t.count24h >= 2 && t.count24h > t.countPrev24h;
export const surgeScore = t => t.count24h - t.countPrev24h;

/** 情緒文字：用正負面比例，不只一個標籤（例如「中立偏正面」）。 */
export function sentimentText(t) {
  const s = t.sentimentScore;
  if (s > 0.3) return '正面';
  if (s > 0.1) return '中立偏正面';
  if (s < -0.3) return '負面';
  if (s < -0.1) return '中立偏負面';
  return '中立';
}

export function velocityText(t) {
  if (t.count24h === 0) return '近 24 小時沒有新報導';
  if (t.velocity === null) return `新話題（24 小時內 ${t.count24h} 篇）`;
  return `24 小時 ${t.velocity > 0 ? '+' : ''}${t.velocity}%（${t.count24h} 篇）`;
}

export function durationText(t) {
  if (t.last - t.first < HOUR) return '不到 1 小時';
  const hours = Math.round((t.last - t.first) / HOUR);
  if (hours < 24) return `${hours} 小時`;
  return `${Math.round(hours / 24)} 天`;
}

const dayKey = d => d.toLocaleDateString('sv-SE', { timeZone: 'Asia/Taipei' });   // YYYY-MM-DD（台灣日曆日）

export function filterTopics(topics, { tag = 'all', sentiment = 'all', query = '', from = '', to = '' } = {}) {
  const q = query.trim().toLowerCase();
  let lo = from; let hi = to;
  if (lo && hi && lo > hi) [lo, hi] = [hi, lo];
  return topics.filter(t => {
    if (tag !== 'all' && !t.tags.includes(tag)) return false;
    if (sentiment !== 'all' && t.sentiment !== sentiment) return false;
    if (lo && dayKey(t.last) < lo) return false;
    if (hi && dayKey(t.last) > hi) return false;
    if (q) {
      const hay = [t.title, t.summary, ...t.companies, ...t.products, ...t.articles.map(a => a.title)].join(' ').toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });
}

/** 排序（不改動原陣列；同分時依最新→重要性→id，結果穩定）。 */
export function sortTopics(topics, mode = 'importance') {
  const tie = (a, b) => b.last - a.last || b.importance - a.importance || a.id.localeCompare(b.id);
  const list = [...topics];
  switch (mode) {
    case 'latest': return list.sort((a, b) => b.last - a.last || b.importance - a.importance || a.id.localeCompare(b.id));
    case 'volume': return list.sort((a, b) => b.articleCount - a.articleCount || b.mediaCount - a.mediaCount || tie(a, b));
    case 'surge': return list.sort((a, b) => surgeScore(b) - surgeScore(a) || b.count24h - a.count24h || tie(a, b));
    default: return list.sort((a, b) => b.importance - a.importance || tie(a, b));
  }
}

/** 統計卡：今日事件＝最新報導在台灣今天；其餘以近 72 小時有更新的事件為範圍。 */
export function topicStats(topics, now = new Date()) {
  const todayStart = taipeiDayStart(now).getTime();
  const recent = topics.filter(t => now - t.last <= 72 * HOUR);
  return {
    today: topics.filter(t => t.last.getTime() >= todayStart).length,
    rising: recent.filter(isRising).length,
    transcend: recent.filter(t => t.tags.includes('transcend')).length,
    competitor: recent.filter(t => t.tags.includes('competitor')).length,
    upstream: recent.filter(t => t.tags.includes('upstream')).length,
    negative: recent.filter(t => t.sentiment === 'negative').length,
    review: recent.filter(t => t.needsReview).length,
    recentTotal: recent.length,
  };
}

/** 摘要用：某類事件最重要的前幾個（預設 72 小時內有更新）。 */
export function topEvents(topics, { tag, keywords = [], limit = 3, now = new Date(), maxAgeHours = 72 } = {}) {
  const kw = keywords.map(k => k.toLowerCase());
  const picked = topics.filter(t => now - t.last <= maxAgeHours * HOUR
    && (!tag || t.tags.includes(tag))
    && (!kw.length || kw.some(k => `${t.title} ${t.products.join(' ')}`.toLowerCase().includes(k))));
  return sortTopics(picked, 'importance').slice(0, limit);
}

/** 文章 id → 話題 id（今日情報快報用來避免同一事件重複出現）。 */
export function topicIndexByArticle(topics) {
  const map = new Map();
  topics.forEach(t => t.articleIds.forEach(id => { if (!map.has(id)) map.set(id, t.id); }));
  return map;
}

/** 依事件去重：同一事件只留 items 中排在最前面的一則；沒有對應話題的項目原樣保留。 */
export function dedupeByTopic(items, getArticleId, topics) {
  if (!topics || !topics.length) return items;
  const index = topicIndexByArticle(topics);
  const seen = new Set();
  return items.filter(item => {
    const topicId = index.get(getArticleId(item));
    if (!topicId) return true;
    if (seen.has(topicId)) return false;
    seen.add(topicId);
    return true;
  });
}
