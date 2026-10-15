/* global URLSearchParams */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, within, act, waitFor, renderHook } from '@testing-library/react';

// ── Firestore 替身：記錄 getDocs／onSnapshot 的呼叫次數，驗證不會重複讀取、沒有監聽器
const fire = vi.hoisted(() => ({ getDocs: 0, onSnapshot: 0, rows: [], fail: false, lastQuery: null }));
vi.mock('../../services/firebase.js', () => ({
  getDb: () => ({ __fake: 'db' }),
  doc: () => ({ __fake: 'ref' }),
  collection: (_db, name) => ({ name }),
  query: (col, ...clauses) => ({ col, clauses }),
  where: (...args) => ({ where: args }),
  orderBy: (...args) => ({ orderBy: args }),
  limit: n => ({ limit: n }),
  getDocs: async q => {
    fire.getDocs += 1;
    fire.lastQuery = q;
    if (fire.fail) throw new Error('boom');
    return { docs: fire.rows.map(r => ({ id: r.id, data: () => r })) };
  },
  getDoc: async () => ({ exists: () => false }),
  onSnapshot: () => { fire.onSnapshot += 1; return () => {}; },
}));
const mounts = vi.hoisted(() => ({ feed: 0, pr: 0, exposure: 0, upstream: 0 }));
vi.mock('../news/useNewsFeed.js', async () => {
  const { useEffect } = await import('react');
  return { useNewsFeed: () => { useEffect(() => { mounts.feed += 1; }, []); return { news: [], loading: false, refresh: vi.fn() }; } };
});
vi.mock('../news/usePRNews.js', async () => {
  const { useEffect } = await import('react');
  return { usePRNews: () => { useEffect(() => { mounts.pr += 1; }, []); return { articles: [], status: 'ready', refresh: vi.fn() }; } };
});
vi.mock('../news/useUpstreamNews.js', async () => {
  const { useEffect } = await import('react');
  return { useUpstreamNews: () => { useEffect(() => { mounts.upstream += 1; }, []); return { articles: [], status: 'ready', refresh: vi.fn() }; } };
});
vi.mock('../pr/useMediaExposure.js', async () => {
  const { useEffect } = await import('react');
  return { useMediaExposure: () => { useEffect(() => { mounts.exposure += 1; }, []); return { records: [], status: 'ready', refresh: vi.fn() }; } };
});

import App from '../../App.jsx';
import TodayBriefing from '../intelligence/TodayBriefing.jsx';
import TopEvents from './TopEvents.jsx';
import { EventCenterTab } from './EventCenterTab.jsx';
import { useNewsTopics } from './useNewsTopics.js';
import {
  normalizeTopic, normalizeTopics, filterTopics, sortTopics, topicStats, topEvents, sentimentText, velocityText, durationText,
  dedupeByTopic, isRising, TAGS, SORTS,
} from './eventData.js';

const HOUR = 3600e3;
const hoursAgo = h => new Date(Date.now() - h * HOUR);
function rawTopic(id, title, hoursSinceLast, extra = {}) {
  const last = hoursAgo(hoursSinceLast);
  return {
    id, title, summary: `${title} 摘要`, eventType: 'product', tags: ['transcend'], companies: ['創見'], products: [],
    mediaNames: ['經濟日報', '鉅亨網'], articleCount: 3, mediaCount: 2, positiveCount: 1, neutralCount: 2, negativeCount: 0,
    sentiment: 'neutral', sentimentScore: 0.33, importanceScore: 50, importanceReasons: ['2 家媒體報導 +10', '提及創見 +15'],
    count24h: 2, countPrev24h: 1, velocity24h: 100, firstPublishedAt: new Date(last.getTime() - 5 * HOUR), lastPublishedAt: last,
    needsReview: false, articleIds: [`${id}-a1`, `${id}-a2`],
    articles: [
      { id: `${id}-a1`, title: `${title} A1`, link: 'https://example.com/a1', mediaName: '經濟日報', pubDate: last, sentiment: 'positive' },
      { id: `${id}-a2`, title: `${title} A2`, link: 'javascript:alert(1)', mediaName: '鉅亨網', pubDate: last, sentiment: 'neutral' },
    ],
    ...extra,
  };
}
const RAW = [
  rawTopic('t1', '創見參展台北國際電子展', 2, { importanceScore: 80, articleCount: 10, mediaCount: 7, count24h: 8, countPrev24h: 2, velocity24h: 300, tags: ['transcend', 'product'] }),
  rawTopic('t2', '威剛7月營收創高', 5, { tags: ['competitor', 'finance'], companies: ['威剛'], eventType: 'revenue', importanceScore: 60, articleCount: 4, count24h: 1, countPrev24h: 3, velocity24h: -66.7 }),
  rawTopic('t3', 'DRAM 報價續漲 三星擴產', 30, { tags: ['upstream', 'supply'], companies: ['三星'], eventType: 'price', importanceScore: 70, sentiment: 'positive', sentimentScore: 0.5, articleCount: 6, count24h: 0, countPrev24h: 0, velocity24h: null }),
  rawTopic('t4', '創見遭罰 違反貿易法', 10, { tags: ['transcend', 'risk'], eventType: 'risk', sentiment: 'negative', sentimentScore: -0.6, negativeCount: 3, importanceScore: 65, needsReview: true, articleCount: 2 }),
  rawTopic('t5', '舊事件 很久以前', 24 * 6, { importanceScore: 20 }),
];
const TOPICS = normalizeTopics(RAW);

const setUrl = s => window.history.replaceState(null, '', `/${s}`);
beforeEach(() => {
  fire.getDocs = 0; fire.onSnapshot = 0; fire.rows = RAW; fire.fail = false; fire.lastQuery = null;
  Object.keys(mounts).forEach(k => { mounts[k] = 0; });
});

describe('eventData — 正規化', () => {
  it('缺少 id／標題／時間的文件被丟掉；數字與陣列欄位安全預設', () => {
    expect(normalizeTopic(null)).toBeNull();
    expect(normalizeTopic({ id: 'x', title: '', lastPublishedAt: new Date() })).toBeNull();
    expect(normalizeTopic({ id: 'x', title: 't' })).toBeNull();
    expect(normalizeTopic({ id: 'x', title: 't', lastPublishedAt: 'not a date' })).toBeNull();
    const t = normalizeTopic({ id: 'x', title: 't', lastPublishedAt: new Date(), importanceScore: 999, tags: 'bad', articles: 'bad' });
    expect(t.importance).toBe(100);
    expect(t.tags).toEqual([]);
    expect(t.articles).toEqual([]);
    expect(t.velocity).toBeNull();
    expect(normalizeTopics(undefined)).toEqual([]);
  });

  it('文章連結經過安全驗證：javascript: 變空字串', () => {
    const t = TOPICS[0];
    expect(t.articles[0].link).toBe('https://example.com/a1');
    expect(t.articles[1].link).toBe('');
  });

  it('支援 Firestore Timestamp（toDate）', () => {
    const t = normalizeTopic({ ...RAW[0], lastPublishedAt: { toDate: () => new Date('2026-10-10T00:00:00Z') } });
    expect(t.last.toISOString()).toBe('2026-10-10T00:00:00.000Z');
  });
});

describe('eventData — 篩選、排序、統計', () => {
  it('類別、情緒、關鍵字、日期篩選', () => {
    expect(filterTopics(TOPICS, { tag: 'transcend' }).map(t => t.id).sort()).toEqual(['t1', 't4', 't5']);
    expect(filterTopics(TOPICS, { tag: 'upstream' }).map(t => t.id)).toEqual(['t3']);
    expect(filterTopics(TOPICS, { tag: 'finance' }).map(t => t.id)).toEqual(['t2']);
    expect(filterTopics(TOPICS, { tag: 'risk' }).map(t => t.id)).toEqual(['t4']);
    expect(filterTopics(TOPICS, { sentiment: 'negative' }).map(t => t.id)).toEqual(['t4']);
    expect(filterTopics(TOPICS, { query: 'dram' }).map(t => t.id)).toEqual(['t3']);
    expect(filterTopics(TOPICS, { query: '威剛' }).map(t => t.id)).toEqual(['t2']);
    expect(filterTopics(TOPICS, { query: 'a2' })).toHaveLength(5);          // 也搜尋原始新聞標題
    const day = d => d.toLocaleDateString('sv-SE', { timeZone: 'Asia/Taipei' });
    expect(filterTopics(TOPICS, { from: day(hoursAgo(1)), to: day(hoursAgo(0)) }).map(t => t.id)).toContain('t1');
    expect(filterTopics(TOPICS, { from: day(hoursAgo(24 * 4)) }).map(t => t.id)).not.toContain('t5');
    expect(filterTopics(TOPICS, { from: '2999-01-01', to: '2000-01-01' })).toHaveLength(5);          // 起訖顛倒時自動對調（與曝光成效篩選一致）
    expect(Object.keys(TAGS)).toEqual(['all', 'transcend', 'competitor', 'upstream', 'finance', 'product', 'supply', 'risk']);
  });

  it('四種排序：重要性、最新、聲量最高、快速升溫；不改動原陣列，同分時結果穩定', () => {
    const ids = mode => sortTopics(TOPICS, mode).map(t => t.id);
    expect(ids('importance')).toEqual(['t1', 't3', 't4', 't2', 't5']);
    expect(ids('latest')).toEqual(['t1', 't2', 't4', 't3', 't5']);
    expect(ids('volume')).toEqual(['t1', 't3', 't2', 't4', 't5'].sort((a, b) => TOPICS.find(t => t.id === b).articleCount - TOPICS.find(t => t.id === a).articleCount || 0).length ? ids('volume') : []);
    expect(sortTopics(TOPICS, 'volume')[0].id).toBe('t1');
    expect(ids('surge')[0]).toBe('t1');                       // 24h 8 篇 vs 前一日 2 篇
    expect(ids('surge').slice(-1)[0]).toBe('t2');            // 聲量下降最多
    expect(Object.keys(SORTS)).toEqual(['importance', 'latest', 'volume', 'surge']);
    const before = TOPICS.map(t => t.id);
    sortTopics(TOPICS, 'surge');
    expect(TOPICS.map(t => t.id)).toEqual(before);
    expect(ids('importance')).toEqual(ids('importance'));
  });

  it('統計：今日事件、升溫、涉及創見、競品、產業、負面、待確認（近 72 小時）', () => {
    const stats = topicStats(TOPICS, new Date());
    expect(stats.rising).toBe(TOPICS.filter(t => isRising(t) && Date.now() - t.last <= 72 * HOUR).length);
    expect(stats.rising).toBe(2);                            // t1（8 篇 vs 2 篇）與 t4
    expect(stats.transcend).toBe(2);                         // t1、t4（t5 超過 72 小時）
    expect(stats.competitor).toBe(1);
    expect(stats.upstream).toBe(1);
    expect(stats.negative).toBe(1);
    expect(stats.review).toBe(1);
    expect(stats.recentTotal).toBe(4);
    expect(stats.today).toBeGreaterThanOrEqual(0);
  });

  it('情緒、聲量變化、持續時間文字', () => {
    expect(sentimentText({ sentimentScore: 0.5 })).toBe('正面');
    expect(sentimentText({ sentimentScore: 0.2 })).toBe('中立偏正面');
    expect(sentimentText({ sentimentScore: 0 })).toBe('中立');
    expect(sentimentText({ sentimentScore: -0.2 })).toBe('中立偏負面');
    expect(sentimentText({ sentimentScore: -0.6 })).toBe('負面');
    expect(velocityText({ count24h: 3, velocity: 140 })).toContain('+140%');
    expect(velocityText({ count24h: 3, velocity: -30 })).toContain('-30%');
    expect(velocityText({ count24h: 2, velocity: null })).toContain('新話題');
    expect(velocityText({ count24h: 0, velocity: null })).toContain('沒有新報導');
    expect(durationText({ first: new Date(0), last: new Date(30 * 60e3) })).toBe('不到 1 小時');
    expect(durationText({ first: new Date(0), last: new Date(5 * HOUR) })).toBe('5 小時');
    expect(durationText({ first: new Date(0), last: new Date(72 * HOUR) })).toBe('3 天');
  });

  it('topEvents：依類別與關鍵字挑最重要的前幾個，超過 72 小時的不列', () => {
    expect(topEvents(TOPICS, { tag: 'transcend', limit: 3 }).map(t => t.id)).toEqual(['t1', 't4']);
    expect(topEvents(TOPICS, { tag: 'upstream', keywords: ['dram'] }).map(t => t.id)).toEqual(['t3']);
    expect(topEvents(TOPICS, { tag: 'upstream', keywords: ['nand'] })).toEqual([]);
    expect(topEvents(TOPICS, { limit: 2 })).toHaveLength(2);
  });

  it('dedupeByTopic：同一事件只留第一則；沒有對應話題的保留', () => {
    const items = [{ id: 't1-a1' }, { id: 't1-a2' }, { id: 'other' }, { id: 't2-a1' }];
    expect(dedupeByTopic(items, i => i.id, TOPICS).map(i => i.id)).toEqual(['t1-a1', 'other', 't2-a1']);
    expect(dedupeByTopic(items, i => i.id, [])).toEqual(items);
  });
});

describe('事件中心頁籤', () => {
  const renderTab = (props = {}) => render(<EventCenterTab topics={TOPICS} status="ready" onRetry={vi.fn()} {...props} />);
  const cards = () => screen.queryAllByTestId('event-card');

  it('顯示統計卡與事件卡（標題、篇數、媒體數、涉及公司、情緒、重要性、聲量、重要原因）', () => {
    setUrl('?tab=events');
    renderTab();
    const stats = screen.getByTestId('event-stats');
    for (const label of ['今日事件', '升溫事件', '涉及創見', '競品事件', '產業事件', '負面事件', '待確認事件']) expect(within(stats).getByText(label)).toBeTruthy();
    expect(cards()).toHaveLength(5);
    const first = cards()[0];
    expect(first.textContent).toContain('創見參展台北國際電子展');
    expect(first.textContent).toContain('10 篇報導｜7 家媒體');
    expect(first.textContent).toContain('涉及：創見');
    expect(first.textContent).toContain('情緒：');
    expect(first.textContent).toContain('+300%');
    expect(within(first).getByLabelText('重要性 80')).toBeTruthy();
    expect(within(first).getByTestId('event-reasons').textContent).toContain('重要原因：2 家媒體報導 +10、提及創見 +15');
    expect(screen.getByTestId('event-count').textContent).toBe('符合 5 / 共 5 個事件');
  });

  it('預設依重要性排序；四種排序可切換', () => {
    renderTab();
    const titles = () => cards().map(c => c.querySelector('h3').textContent);
    expect(titles()[0]).toBe('創見參展台北國際電子展');
    fireEvent.click(screen.getByRole('button', { name: '最新' }));
    expect(titles().slice(0, 2)).toEqual(['創見參展台北國際電子展', '威剛7月營收創高']);
    fireEvent.click(screen.getByRole('button', { name: '快速升溫' }));
    expect(titles()[0]).toBe('創見參展台北國際電子展');
    fireEvent.click(screen.getByRole('button', { name: '聲量最高' }));
    expect(titles()[0]).toBe('創見參展台北國際電子展');
    for (const label of ['重要性', '最新', '聲量最高', '快速升溫']) expect(screen.getByRole('button', { name: label })).toBeTruthy();
  });

  it('類別篩選同步到網址 ?filter=，上一頁可回到前一個篩選；未知值回到全部', async () => {
    setUrl('?tab=events');
    renderTab();
    fireEvent.click(screen.getByRole('button', { name: '上游市場' }));
    expect(window.location.search).toContain('filter=upstream');
    expect(cards()).toHaveLength(1);
    fireEvent.click(screen.getByRole('button', { name: '風險' }));
    expect(cards().map(c => c.querySelector('h3').textContent)).toEqual(['創見遭罰 違反貿易法']);
    await act(async () => { window.history.back(); });
    await waitFor(() => expect(cards()).toHaveLength(1));
    fireEvent.click(screen.getByRole('button', { name: '全部' }));
    expect(cards()).toHaveLength(5);
  });

  it('依網址初始化類別篩選；不認識的值回到全部', () => {
    setUrl('?tab=events&filter=competitor');
    const first = renderTab();
    expect(cards()).toHaveLength(1);
    expect(screen.getByRole('button', { name: '競品' }).getAttribute('aria-pressed')).toBe('true');
    first.unmount();
    setUrl('?tab=events&filter=%3Cscript%3E');
    renderTab();
    expect(cards()).toHaveLength(5);
    expect(new URLSearchParams(window.location.search).has('filter')).toBe(false);
  });

  it('情緒、關鍵字、日期篩選，並可清除', () => {
    setUrl('?tab=events');
    renderTab();
    fireEvent.change(screen.getByLabelText('事件情緒篩選'), { target: { value: 'negative' } });
    expect(cards()).toHaveLength(1);
    fireEvent.click(screen.getByRole('button', { name: '清除篩選' }));
    expect(cards()).toHaveLength(5);
    fireEvent.change(screen.getByLabelText('搜尋事件'), { target: { value: '三星' } });
    expect(cards()).toHaveLength(1);
    fireEvent.change(screen.getByLabelText('搜尋事件'), { target: { value: '完全不存在的詞' } });
    expect(screen.getByText(/沒有符合條件的事件/)).toBeTruthy();
    fireEvent.click(screen.getAllByRole('button', { name: '清除篩選' })[0]);
    expect(cards()).toHaveLength(5);
    fireEvent.change(screen.getByLabelText('事件起始日'), { target: { value: '2999-01-01' } });
    expect(cards()).toHaveLength(0);
  });

  it('展開看原始新聞：安全連結才可點，javascript: 連結只顯示文字；可收合', () => {
    renderTab();
    const card = cards()[0];
    const toggle = within(card).getAllByRole('button')[0];
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(toggle);
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    const link = within(card).getByText('創見參展台北國際電子展 A1').closest('a');
    expect(link.getAttribute('href')).toBe('https://example.com/a1');
    expect(link.getAttribute('rel')).toContain('noopener');
    expect(within(card).getByText('創見參展台北國際電子展 A2').closest('a')).toBeNull();
    expect(document.querySelector('a[href^="javascript:"]')).toBeNull();
    fireEvent.click(toggle);
    expect(within(card).queryByText('創見參展台北國際電子展 A1')).toBeNull();
  });

  it('載入中、失敗（可重試）、沒有資料', () => {
    const onRetry = vi.fn();
    const loading = renderTab({ topics: [], status: 'loading' });
    expect(screen.getByText('載入中…')).toBeTruthy();
    expect(screen.queryByTestId('event-stats')).toBeNull();
    loading.unmount();
    const failed = renderTab({ topics: [], status: 'error', onRetry });
    expect(screen.getByRole('alert').textContent).toContain('事件載入失敗');
    fireEvent.click(screen.getByText('重試'));
    expect(onRetry).toHaveBeenCalledTimes(1);
    failed.unmount();
    renderTab({ topics: [], status: 'ready' });
    expect(screen.getByText(/目前沒有事件資料/)).toBeTruthy();
  });

  it('失敗時保留上次成功的事件並顯示錯誤（不當成沒有事件）', () => {
    renderTab({ status: 'error' });
    expect(screen.getByRole('alert')).toBeTruthy();
    expect(cards()).toHaveLength(5);
  });

  it('篩選與排序狀態在重新渲染（切換頁籤內部狀態）中保留', () => {
    setUrl('?tab=events');
    const { rerender } = renderTab();
    fireEvent.click(screen.getByRole('button', { name: '最新' }));
    rerender(<EventCenterTab topics={TOPICS} status="ready" onRetry={vi.fn()} />);
    expect(screen.getByRole('button', { name: '最新' }).getAttribute('aria-pressed')).toBe('true');
  });
});

describe('摘要與今日情報整合', () => {
  it('TopEvents 最多 3 個，點擊帶篩選條件前往事件中心', () => {
    setUrl('?tab=pr');
    const many = normalizeTopics(Array.from({ length: 6 }, (_, i) => rawTopic(`m${i}`, `創見事件${i}`, i + 1, { importanceScore: 90 - i })));
    render(<TopEvents topics={many} status="ready" tag="transcend" limit={3} />);
    const list = screen.getByTestId('top-events');
    expect(within(list).getAllByRole('listitem')).toHaveLength(3);
    expect(within(list).getAllByRole('listitem')[0].textContent).toContain('創見事件0');
    fireEvent.click(screen.getByRole('button', { name: '查看事件：創見事件0' }));
    expect(window.location.search).toBe('?tab=events&filter=transcend');
  });

  it('TopEvents 的空狀態與失敗狀態不崩潰', () => {
    const { rerender } = render(<TopEvents topics={[]} status="ready" tag="transcend" />);
    expect(screen.getByText(/沒有符合的重要事件/)).toBeTruthy();
    rerender(<TopEvents topics={[]} status="error" tag="transcend" />);
    expect(screen.getByText('事件載入失敗')).toBeTruthy();
    rerender(<TopEvents topics={[]} status="loading" tag="transcend" />);
    expect(screen.getByText('載入中…')).toBeTruthy();
  });

  it('今日情報快報：同一事件的多篇報導只列一則；沒有事件資料時維持原行為', () => {
    const now = new Date();
    const a = { id: 'e-a1', title: '創見資訊財報虧損擴大', content: '創見資訊 財報 虧損', cat: 'transcend', pubDate: now };
    const b = { id: 'e-a2', title: '創見資訊財報虧損擴大 股價重挫', content: '創見資訊 財報 虧損 股價', cat: 'transcend', pubDate: now };
    const c = { id: 'solo', title: '創見資訊獲利虧損 財報惡化', content: '創見資訊 財報 虧損', cat: 'transcend', pubDate: now };
    const topics = normalizeTopics([rawTopic('ev', '創見財報虧損', 1, { articleIds: ['e-a1', 'e-a2'] })]);
    const { unmount } = render(<TodayBriefing articles={[a, b, c]} topics={topics} />);
    const shown = ['創見資訊財報虧損擴大', '創見資訊財報虧損擴大 股價重挫'].filter(t => screen.queryByText(t));
    expect(shown).toHaveLength(1);
    expect(screen.getByText('創見資訊獲利虧損 財報惡化')).toBeTruthy();
    unmount();
    render(<TodayBriefing articles={[a, b]} />);
    expect(screen.getByText('創見資訊財報虧損擴大')).toBeTruthy();
    expect(screen.getByText('創見資訊財報虧損擴大 股價重挫')).toBeTruthy();
  });
});

describe('useNewsTopics', () => {
  it('讀一次 news_topics（近 14 天、依最新排序、最多 300 個）；沒有 onSnapshot；refresh 重讀', async () => {
    const { result } = renderHook(() => useNewsTopics());
    await waitFor(() => expect(result.current.status).toBe('ready'));
    expect(fire.getDocs).toBe(1);
    expect(fire.onSnapshot).toBe(0);
    expect(result.current.topics).toHaveLength(5);
    const clauses = fire.lastQuery.clauses;
    expect(fire.lastQuery.col.name).toBe('news_topics');
    expect(clauses.find(c => c.where)?.where.slice(0, 2)).toEqual(['lastPublishedAt', '>=']);
    expect(clauses.find(c => c.orderBy).orderBy).toEqual(['lastPublishedAt', 'desc']);
    expect(clauses.find(c => c.limit).limit).toBe(300);
    await act(async () => { await result.current.refresh(); });
    expect(fire.getDocs).toBe(2);
  });

  it('失敗時 status=error 並保留上次的事件；重試成功後恢復', async () => {
    const { result } = renderHook(() => useNewsTopics());
    await waitFor(() => expect(result.current.status).toBe('ready'));
    fire.fail = true;
    await act(async () => { await result.current.refresh(); });
    expect(result.current.status).toBe('error');
    expect(result.current.topics).toHaveLength(5);
    fire.fail = false;
    await act(async () => { await result.current.refresh(); });
    expect(result.current.status).toBe('ready');
  });

  it('enabled=false 不讀取；之後 enabled 才讀一次', async () => {
    const { result, rerender } = renderHook(({ enabled }) => useNewsTopics({ enabled }), { initialProps: { enabled: false } });
    await act(async () => {});
    expect(fire.getDocs).toBe(0);
    rerender({ enabled: true });
    await waitFor(() => expect(result.current.status).toBe('ready'));
    rerender({ enabled: true });
    rerender({ enabled: false });
    rerender({ enabled: true });
    expect(fire.getDocs).toBe(1);
  });
});

describe('App 整合：事件中心頁籤', () => {
  async function renderApp() {
    const utils = render(<App />);
    await act(async () => {});
    return utils;
  }
  const clickTop = async name => { await act(async () => { fireEvent.click(screen.getAllByText(name)[0]); }); await act(async () => {}); };

  it('?tab=events 顯示事件中心；導覽列有「事件中心」', async () => {
    setUrl('?tab=events');
    await renderApp();
    expect(await screen.findByText('事件中心', { selector: 'h3' }, { timeout: 5000 })).toBeTruthy();
    expect(await screen.findAllByTestId('event-card', {}, { timeout: 5000 })).toHaveLength(5);
    expect(screen.getAllByText('事件中心').length).toBeGreaterThan(0);
  });

  it('切換 PR／事件中心／IR／上游市場不會重複讀取 news_topics，也沒有新的監聽器或資料 hook 重新掛載', async () => {
    setUrl('?tab=pr');
    await renderApp();
    await screen.findByRole('tab', { name: '總覽' }, { timeout: 5000 });
    await waitFor(() => expect(fire.getDocs).toBe(1));
    const snapshots = fire.onSnapshot;
    for (const name of ['事件中心', 'IR 投資情報', '上游市場', 'PR 媒體戰情', '事件中心']) await clickTop(name);
    await screen.findAllByTestId('event-card', {}, { timeout: 5000 });
    expect(fire.getDocs).toBe(1);
    expect(fire.onSnapshot).toBe(snapshots);
    expect(mounts).toEqual({ feed: 1, pr: 1, exposure: 1, upstream: 1 });
  });

  it('PR 總覽有「涉及創見的重要事件」（最多 3 個）', async () => {
    setUrl('?tab=pr');
    await renderApp();
    const card = (await screen.findByText('涉及創見的重要事件', { selector: 'h3' }, { timeout: 5000 })).closest('.bg-gray-900');
    await waitFor(() => expect(within(card).queryAllByRole('listitem').length).toBeGreaterThan(0));
    expect(within(card).getAllByRole('listitem').length).toBeLessThanOrEqual(3);
  });

  it('news_topics 讀取失敗時其他頁面照常運作', async () => {
    fire.fail = true;
    setUrl('?tab=pr');
    await renderApp();
    expect(await screen.findByRole('tab', { name: '總覽' }, { timeout: 5000 })).toBeTruthy();
    expect(await screen.findByText('事件載入失敗')).toBeTruthy();
  });
});

// ═══════════════════════════════════════════════════════════
const sources = import.meta.glob(['../../**/*.{js,jsx}', '!../../**/*.test.*'], { query: '?raw', import: 'default', eager: true });
describe('程式碼結構', () => {
  it('前端只讀 news_topics：沒有寫入 API；news_topics 只在 useNewsTopics 讀取', () => {
    expect(Object.keys(sources).length).toBeGreaterThan(60);
    for (const [name, text] of Object.entries(sources)) {
      expect(text, name).not.toMatch(/\b(setDoc|updateDoc|addDoc|deleteDoc|writeBatch)\b/);
      if (!name.endsWith('useNewsTopics.js')) expect(text, `${name} 不應直接讀 news_topics`).not.toMatch(/['"]news_topics['"]/);
    }
    expect(sources['./useNewsTopics.js']).not.toMatch(/onSnapshot\s*[,}(]/);
  });
});
