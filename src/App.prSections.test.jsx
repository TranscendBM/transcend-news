/* global URLSearchParams */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, within, act, waitFor } from '@testing-library/react';

// ── Excel 匯出：只驗證「有沒有被呼叫、傳了什麼」，不真的寫檔
const exportNewsExcel = vi.fn();
const exportMediaExposureExcel = vi.fn();
const exportExposurePerformanceExcel = vi.fn();
vi.mock('./utils/formatting.js', () => ({
  exportNewsExcel: (...a) => exportNewsExcel(...a),
  exportMediaExposureExcel: (...a) => exportMediaExposureExcel(...a),
  exportExposurePerformanceExcel: (...a) => exportExposurePerformanceExcel(...a),
  exportExposureInsightsExcel: vi.fn(),
}));

// ── App 層測試用：資料 hook 換成「掛載時登記一次」的替身，用來確認切換子頁／分頁
//    不會讓這些 hook（＝Firestore 監聽器的所在）重新掛載。
const mounts = vi.hoisted(() => ({ feed: 0, pr: 0, exposure: 0, upstream: 0 }));
vi.mock('./services/firebase.js', () => ({
  getDb: () => ({ __fake: 'db' }),
  doc: () => ({ __fake: 'docRef' }),
  onSnapshot: () => () => {},
  getDoc: async () => ({ exists: () => false }),
}));
vi.mock('./features/news/useNewsFeed.js', async () => {
  const { useEffect } = await import('react');
  return { useNewsFeed: () => { useEffect(() => { mounts.feed += 1; }, []); return { news: [], loading: false, refresh: vi.fn() }; } };
});
vi.mock('./features/news/usePRNews.js', async () => {
  const { useEffect } = await import('react');
  return { usePRNews: () => { useEffect(() => { mounts.pr += 1; }, []); return { articles: [], status: 'ready', refresh: vi.fn() }; } };
});
vi.mock('./features/news/useUpstreamNews.js', async () => {
  const { useEffect } = await import('react');
  return { useUpstreamNews: () => { useEffect(() => { mounts.upstream += 1; }, []); return { articles: [], status: 'ready', refresh: vi.fn() }; } };
});
vi.mock('./features/pr/useMediaExposure.js', async () => {
  const { useEffect } = await import('react');
  return { useMediaExposure: () => { useEffect(() => { mounts.exposure += 1; }, []); return { records: [], status: 'ready', refresh: vi.fn() }; } };
});

import App from './App.jsx';
import { PRTab } from './features/pr/PRTab.jsx';
import { PR_SECTIONS } from './features/pr/prSections.js';
import { KEY_MEDIA } from './utils/news.js';

// ═══════════════════════════════════════════════════════════
// 測試資料
// ═══════════════════════════════════════════════════════════
const NOW = Date.now();
const hoursAgo = h => new Date(NOW - h * 3600e3);

// 8 則創見 PR 報導（最新的是 0 號）、8 則競品新聞
const prArticles = Array.from({ length: 8 }, (_, i) => ({
  id: `pr${i}`, title: `創見PR新聞第${i}號報導`, pubDate: hoursAgo(i + 1), cat: 'transcend',
  mediaName: i % 2 ? '電子時報' : '經濟日報', content: '創見資訊', link: `https://example.com/pr${i}`, sentiment: 'neutral',
}));
const competitorNews = Array.from({ length: 8 }, (_, i) => ({
  id: `c${i}`, title: `競品動態第${i}號消息`, pubDate: hoursAgo(i + 1), cat: 'competitor',
  brand: i % 2 ? 'Innodisk' : 'ADATA', mediaName: '媒體C', content: '競品', link: `https://example.com/c${i}`, sentiment: 'neutral',
}));
const exposure = (id, day, media, title, extra = {}) => ({
  id, exposureDate: new Date(Date.UTC(2026, 8, day, 4)), mediaName: media, reporter: '王記者', title,
  link: `https://example.com/e${id}`, exposureType: 'online',
  noteInternal: '內部備註不可外流', sources: [{ file: 'secret.xlsx', sheet: '09', row: 7 }],
  rawLink: 'https://raw.example.com/leak', rawMediaName: '原始媒體名稱', file: 'secret.xlsx', ...extra,
});
const exposures = [
  exposure('e1', 1, '經濟日報', '創見推出新品固態硬碟 搶攻工控'),
  exposure('e2', 3, '鉅亨網', '創見董事長談記憶體缺貨將延續到明年'),
  exposure('e3', 5, '經濟日報', '創見榮獲 COMPUTEX 永續設計獎'),
];

const setUrl = search => window.history.replaceState(null, '', `/${search}`);
const tabNamed = name => screen.getByRole('tab', { name });
const selectedTab = () => screen.getAllByRole('tab').find(t => t.getAttribute('aria-selected') === 'true')?.textContent.trim();
const clickTab = name => fireEvent.click(tabNamed(name));

function renderPR(props = {}) {
  return render(<PRTab
    news={competitorNews} prArticles={prArticles} prStatus="ready" refreshPRNews={vi.fn()}
    mediaExposure={exposures} mediaExposureStatus="ready" refreshMediaExposure={vi.fn()} {...props} />);
}
const cardOf = (title, selector = 'h3') => screen.getByText(title, { selector }).closest('.bg-gray-900');

beforeEach(() => {
  mounts.feed = 0; mounts.pr = 0; mounts.exposure = 0; mounts.upstream = 0;
  exportNewsExcel.mockClear(); exportMediaExposureExcel.mockClear(); exportExposurePerformanceExcel.mockClear();
});

// ═══════════════════════════════════════════════════════════
describe('PR 子頁籤 — 預設與切換', () => {
  it('沒有 section 參數時預設進入「總覽」，四個子頁籤都存在', () => {
    renderPR();
    expect(PR_SECTIONS.map(s => s.label)).toEqual(['總覽', '新聞監測', '競品動態', '曝光成效']);
    expect(screen.getAllByRole('tab').map(t => t.textContent.trim())).toEqual(['總覽', '新聞監測', '競品動態', '曝光成效']);
    expect(selectedTab()).toBe('總覽');
    expect(cardOf('創見最新報導')).toBeTruthy();   // 總覽的摘要卡
  });

  it('四個子頁都能切換，並寫入網址 ?section=', () => {
    renderPR();
    [['新聞監測', 'news'], ['競品動態', 'competitors'], ['曝光成效', 'exposure'], ['總覽', 'overview']].forEach(([label, id]) => {
      clickTab(label);
      expect(selectedTab()).toBe(label);
      expect(window.location.search).toBe(`?tab=pr&section=${id}`);
    });
  });
});

describe('PR 子頁籤 — 每個功能只出現在正確的子頁', () => {
  const NEWS_TOOLBAR = '搜尋標題、內容、媒體或品牌…';

  it('總覽：摘要卡；沒有搜尋工具列、完整清單、品牌篩選、上傳或匯出', () => {
    renderPR();
    ['創見媒體曝光', '創見最新報導', '競品最新動態', '新聞稿曝光成效', '重點媒體曝光監控'].forEach(t =>
      expect(screen.getByText(t, { selector: 'h3' }), t).toBeTruthy());
    expect(screen.queryByPlaceholderText(NEWS_TOOLBAR)).toBeNull();
    expect(screen.queryByText('競品動態監測')).toBeNull();
    expect(screen.queryByText('人工彙整曝光', { selector: 'h3' })).toBeNull();
    expect(screen.queryByText('上傳 Excel')).toBeNull();
    expect(screen.queryByText(/匯出/)).toBeNull();
  });

  it('新聞監測：搜尋／媒體／情緒工具列、統計卡、創見最新報導、期間篩選與匯出', () => {
    setUrl('?section=news');
    renderPR();
    expect(screen.getAllByPlaceholderText(NEWS_TOOLBAR)).toHaveLength(1);
    expect(screen.getByLabelText('依媒體篩選')).toBeTruthy();
    expect(screen.getByLabelText('依情緒篩選')).toBeTruthy();
    expect(screen.getByText('媒體曝光｜今天')).toBeTruthy();
    const card = cardOf('創見最新報導');
    ['今天', '本週', '本月', '上月'].forEach(t => expect(within(card).getByText(t)).toBeTruthy());
    expect(within(card).getByText('匯出 Excel')).toBeTruthy();
    // 不屬於這一頁的功能
    expect(screen.queryByText('競品動態監測')).toBeNull();
    expect(screen.queryByText('新聞稿曝光成效')).toBeNull();
    expect(screen.queryByText('重點媒體曝光監控')).toBeNull();
  });

  it('競品動態：品牌篩選與期間篩選（沒有新聞監測的搜尋工具列）', () => {
    setUrl('?section=competitors');
    renderPR();
    const card = cardOf('競品動態監測');
    ['全部', 'ADATA 威剛', 'Innodisk 宜鼎', 'Teamgroup 十銓', 'Apacer 宇瞻', 'Silicon Power 廣穎'].forEach(t =>
      expect(within(card).getAllByText(t).length, t).toBeGreaterThan(0));
    ['今天', '本週', '本月', '上月', '已載入資料'].forEach(t => expect(within(card).getAllByText(t).length).toBeGreaterThan(0));
    expect(within(card).getByTestId('brand-exposure')).toBeTruthy();        // 各品牌新聞曝光數量表
    expect(within(card).queryByText('本年')).toBeNull();      // 新聞只保留本月＋上個月，沒有本年
    expect(screen.queryByPlaceholderText(NEWS_TOOLBAR)).toBeNull();
    expect(screen.queryByLabelText('依媒體篩選')).toBeNull();
    expect(screen.queryByText('新聞稿曝光成效')).toBeNull();
  });

  it('曝光成效：新聞稿曝光成效、重點媒體曝光監控、人工彙整曝光（上傳、匯出）、曝光分析', () => {
    setUrl('?section=exposure');
    renderPR();
    ['新聞稿曝光成效', '重點媒體曝光監控', '人工彙整曝光'].forEach(t => expect(screen.getByText(t, { selector: 'h3' }), t).toBeTruthy());
    expect(screen.getByText('上傳 Excel')).toBeTruthy();
    expect(screen.getByText('曝光分析')).toBeTruthy();
    expect(screen.getByLabelText('曝光媒體篩選')).toBeTruthy();
    expect(screen.queryByPlaceholderText(NEWS_TOOLBAR)).toBeNull();
    expect(screen.queryByText('競品動態監測')).toBeNull();
  });
});

// ═══════════════════════════════════════════════════════════
describe('PR 總覽 — 摘要與「查看全部」', () => {
  it('創見最新報導與競品最新動態最多各顯示 5 則（最新的 5 則）', () => {
    renderPR();
    const pr = cardOf('創見最新報導');
    expect(pr.querySelectorAll('a')).toHaveLength(5);
    [0, 1, 2, 3, 4].forEach(i => expect(within(pr).getByText(`創見PR新聞第${i}號報導`)).toBeTruthy());
    [5, 6, 7].forEach(i => expect(within(pr).queryByText(`創見PR新聞第${i}號報導`)).toBeNull());

    const comp = cardOf('競品最新動態');
    expect(comp.querySelectorAll('a')).toHaveLength(5);
    expect(within(comp).getByText('競品動態第0號消息')).toBeTruthy();
    expect(within(comp).queryByText('競品動態第5號消息')).toBeNull();
  });

  it('重點媒體摘要只顯示前 5 家；曝光成效頁顯示全部重點媒體', () => {
    renderPR();
    expect(cardOf('重點媒體曝光監控').querySelectorAll('.group')).toHaveLength(5);
    clickTab('曝光成效');
    expect(cardOf('重點媒體曝光監控').querySelectorAll('.group')).toHaveLength(KEY_MEDIA.length);
  });

  it('新聞稿曝光成效摘要：總數、媒體數、主題數、最近曝光，以及最近的主題（最多 3 則）', () => {
    renderPR();
    const card = cardOf('新聞稿曝光成效');
    expect(within(card).getByText('人工彙整曝光').nextElementSibling.textContent).toBe('3');
    expect(within(card).getByText('涵蓋媒體').nextElementSibling.textContent).toBe('2');
    expect(within(card).getByText('新聞稿／主題').nextElementSibling.textContent).toBe('3');
    expect(within(card).getByText(/創見榮獲 COMPUTEX 永續設計獎/)).toBeTruthy();   // 最新的一則
  });

  it.each([
    ['創見媒體曝光', '新聞監測'],
    ['創見最新報導', '新聞監測'],
    ['競品最新動態', '競品動態'],
    ['新聞稿曝光成效', '曝光成效'],
    ['重點媒體曝光監控', '曝光成效'],
  ])('「%s」的「查看全部」切換到「%s」子頁', (title, target) => {
    renderPR();
    fireEvent.click(within(cardOf(title)).getByRole('button', { name: `查看全部：${title}` }));
    expect(selectedTab()).toBe(target);
  });
});

// ═══════════════════════════════════════════════════════════
describe('PR 子頁籤 — 狀態保存', () => {
  const type = (el, value) => fireEvent.change(el, { target: { value } });

  it('切換子頁後再回來，新聞監測的搜尋、媒體、期間篩選都還在', () => {
    setUrl('?section=news');
    renderPR();
    type(screen.getByPlaceholderText('搜尋標題、內容、媒體或品牌…'), 'PR新聞第3號');
    type(screen.getByLabelText('依媒體篩選'), '電子時報');
    fireEvent.click(within(cardOf('創見最新報導')).getByText('本週'));
    expect(within(cardOf('創見最新報導')).getByText('本週').className).toContain('text-white');

    clickTab('競品動態');
    clickTab('曝光成效');
    clickTab('新聞監測');

    expect(screen.getByPlaceholderText('搜尋標題、內容、媒體或品牌…').value).toBe('PR新聞第3號');
    expect(screen.getByLabelText('依媒體篩選').value).toBe('電子時報');
    expect(within(cardOf('創見最新報導')).getByText('本週').className).toContain('text-white');
    expect(within(cardOf('創見最新報導')).getByText('創見PR新聞第3號報導')).toBeTruthy();
  });

  it('競品動態的品牌與期間、曝光成效的篩選與展開狀態，切換子頁後都保留', () => {
    setUrl('?section=competitors');
    renderPR();
    fireEvent.click(within(cardOf('競品動態監測')).getAllByText('Innodisk 宜鼎').at(-1));
    fireEvent.click(within(cardOf('競品動態監測')).getAllByText('上月').at(-1));

    clickTab('曝光成效');
    type(screen.getByLabelText('曝光媒體篩選'), '經濟日報');
    const topic = screen.getAllByRole('button', { expanded: false }).find(b => b.textContent.includes('創見推出新品固態硬碟'));
    fireEvent.click(topic);
    fireEvent.click(screen.getByRole('button', { name: '曝光數最多' }));

    clickTab('總覽');
    clickTab('競品動態');
    expect(within(cardOf('競品動態監測')).getAllByText('Innodisk 宜鼎').at(-1).className).toContain('text-white');
    expect(within(cardOf('競品動態監測')).getAllByText('上月').at(-1).className).toContain('text-white');

    clickTab('曝光成效');
    expect(screen.getByLabelText('曝光媒體篩選').value).toBe('經濟日報');
    expect(screen.getByRole('button', { name: '曝光數最多' }).className).toContain('text-white');
    const reopened = screen.getAllByRole('button', { expanded: true }).find(b => b.textContent.includes('創見推出新品固態硬碟'));
    expect(reopened).toBeTruthy();   // 展開的主題仍然是展開的
  });

  it('競品篩選與新聞監測搜尋工具列互相獨立：改競品品牌不影響新聞監測的篩選，反之亦然', () => {
    setUrl('?section=news');
    renderPR();
    type(screen.getByLabelText('依媒體篩選'), '經濟日報');
    clickTab('競品動態');
    fireEvent.click(within(cardOf('競品動態監測')).getAllByText('ADATA 威剛').at(-1));
    expect(screen.queryByLabelText('依媒體篩選')).toBeNull();
    clickTab('新聞監測');
    expect(screen.getByLabelText('依媒體篩選').value).toBe('經濟日報');
  });
});

// ═══════════════════════════════════════════════════════════
describe('PR 子頁籤 — 網址（?section=）與上一頁／下一頁', () => {
  it.each([['competitors', '競品動態'], ['exposure', '曝光成效'], ['news', '新聞監測'], ['overview', '總覽']])(
    '網址 ?section=%s 直接開啟對應子頁', (id, label) => {
      setUrl(`?tab=pr&section=${id}`);
      renderPR();
      expect(selectedTab()).toBe(label);
    });

  it('不認識的 section 回退到總覽，並把壞掉的參數從網址移除（不新增歷史紀錄）', async () => {
    setUrl('?tab=pr&section=%3Cscript%3E');
    const before = window.history.length;
    renderPR();
    expect(selectedTab()).toBe('總覽');
    await waitFor(() => expect(new URLSearchParams(window.location.search).has('section')).toBe(false));
    expect(window.history.length).toBe(before);
    expect(screen.getByText('創見最新報導', { selector: 'h3' })).toBeTruthy();   // 不是空白頁
  });

  it('切換子頁時保留網址上的其他參數', () => {
    setUrl('?tab=pr&foo=bar#top');
    renderPR();
    clickTab('競品動態');
    expect(window.location.search).toBe('?tab=pr&foo=bar&section=competitors');
    expect(window.location.hash).toBe('#top');
  });

  it('瀏覽器上一頁／下一頁會切換子頁', async () => {
    renderPR();
    clickTab('新聞監測');
    clickTab('競品動態');
    expect(selectedTab()).toBe('競品動態');

    await act(async () => { window.history.back(); });
    await waitFor(() => expect(selectedTab()).toBe('新聞監測'));
    await act(async () => { window.history.back(); });
    await waitFor(() => expect(selectedTab()).toBe('總覽'));
    await act(async () => { window.history.forward(); });
    await waitFor(() => expect(selectedTab()).toBe('新聞監測'));
  });

  it('重新整理（重新 render）後回到網址上的子頁', () => {
    const first = renderPR();
    clickTab('曝光成效');
    first.unmount();                       // 重新整理＝整個頁面重建，網址還在
    renderPR();
    expect(selectedTab()).toBe('曝光成效');
  });
});

// ═══════════════════════════════════════════════════════════
describe('PR 子頁籤 — 無障礙與鍵盤', () => {
  it('tablist／tab／tabpanel 語意：aria-selected、aria-controls 指向存在的 tabpanel，並以 aria-labelledby 對回', () => {
    renderPR();
    expect(screen.getByRole('tablist', { name: 'PR 媒體戰情子頁' })).toBeTruthy();
    screen.getAllByRole('tab').forEach(t => {
      const panel = document.getElementById(t.getAttribute('aria-controls'));
      expect(panel, t.textContent).toBeTruthy();
      expect(panel.getAttribute('role')).toBe('tabpanel');
      expect(panel.getAttribute('aria-labelledby')).toBe(t.id);
      expect(panel.hidden).toBe(t.getAttribute('aria-selected') !== 'true');
    });
    expect(screen.getAllByRole('tab').filter(t => t.getAttribute('aria-selected') === 'true')).toHaveLength(1);
    // 只有目前的子頁有內容，其他 tabpanel 是空的
    expect(document.getElementById('pr-panel-news').childElementCount).toBe(0);
  });

  it('roving tabindex：只有目前的標籤在 Tab 鍵順序內', () => {
    renderPR();
    expect(screen.getAllByRole('tab').map(t => t.tabIndex)).toEqual([0, -1, -1, -1]);
    clickTab('競品動態');
    expect(screen.getAllByRole('tab').map(t => t.tabIndex)).toEqual([-1, -1, 0, -1]);
  });

  it('方向鍵、Home、End 切換子頁並移動焦點（頭尾循環）', () => {
    renderPR();
    const key = (el, k) => fireEvent.keyDown(el, { key: k });
    key(tabNamed('總覽'), 'ArrowRight');
    expect(selectedTab()).toBe('新聞監測');
    expect(document.activeElement).toBe(tabNamed('新聞監測'));
    key(tabNamed('新聞監測'), 'End');
    expect(selectedTab()).toBe('曝光成效');
    key(tabNamed('曝光成效'), 'ArrowRight');
    expect(selectedTab()).toBe('總覽');                       // 尾 → 頭
    key(tabNamed('總覽'), 'ArrowLeft');
    expect(selectedTab()).toBe('曝光成效');                   // 頭 → 尾
    key(tabNamed('曝光成效'), 'Home');
    expect(selectedTab()).toBe('總覽');
    key(tabNamed('總覽'), 'Tab');                             // 其他按鍵不處理
    expect(selectedTab()).toBe('總覽');
  });

  it('手機：子頁籤整列可橫向捲動、標籤不換行也不縮小（只有這一列自己捲動）', () => {
    renderPR();
    const list = screen.getByRole('tablist');
    expect(list.className).toContain('overflow-x-auto');
    expect(list.className).toContain('whitespace-nowrap');
    screen.getAllByRole('tab').forEach(t => {
      expect(t.className).toContain('shrink-0');
      expect(t.className).toContain('whitespace-nowrap');
    });
    // sticky 在主 Header（h-14）下方
    expect(list.parentElement.className).toContain('sticky');
    expect(list.parentElement.className).toContain('top-14');
  });
});

// ═══════════════════════════════════════════════════════════
describe('PR 子頁 — 載入、錯誤、空資料與重試', () => {
  it('總覽：PR 報導載入失敗時顯示錯誤並可重試，不顯示成 0', () => {
    const refreshPRNews = vi.fn();
    renderPR({ prArticles: [], prStatus: 'error', refreshPRNews });
    const card = cardOf('創見最新報導');
    expect(within(card).getByText(/報導載入失敗/)).toBeTruthy();
    fireEvent.click(within(card).getByText('重試'));
    expect(refreshPRNews).toHaveBeenCalledTimes(1);
  });

  it('總覽：新聞稿曝光成效載入失敗可重試；載入中與尚未匯入資料顯示對應狀態', () => {
    const refreshMediaExposure = vi.fn();
    const { unmount } = renderPR({ mediaExposure: [], mediaExposureStatus: 'error', refreshMediaExposure });
    fireEvent.click(within(cardOf('新聞稿曝光成效')).getByText('重試'));
    expect(refreshMediaExposure).toHaveBeenCalledTimes(1);
    unmount();

    const loading = renderPR({ mediaExposure: [], mediaExposureStatus: 'loading' });
    expect(within(cardOf('新聞稿曝光成效')).getByText('載入中…')).toBeTruthy();
    loading.unmount();

    renderPR({ mediaExposure: [], mediaExposureStatus: 'ready' });
    expect(within(cardOf('新聞稿曝光成效')).getByText('尚未匯入人工彙整曝光資料')).toBeTruthy();
  });

  it('總覽：沒有競品報導、沒有創見報導時顯示空狀態，頁面不崩潰', () => {
    renderPR({ news: [], prArticles: [], mediaExposure: [] });
    expect(within(cardOf('競品最新動態')).getByText('暫無競品報導')).toBeTruthy();
    expect(within(cardOf('創見最新報導')).getByText('目前沒有創見報導')).toBeTruthy();
  });

  it('新聞監測：載入失敗可重試；競品動態沒有資料時顯示空狀態', () => {
    setUrl('?section=news');
    const refreshPRNews = vi.fn();
    const { unmount } = renderPR({ prArticles: [], prStatus: 'error', refreshPRNews });
    fireEvent.click(within(cardOf('創見最新報導')).getByText('重試'));
    expect(refreshPRNews).toHaveBeenCalledTimes(1);
    unmount();

    setUrl('?section=competitors');
    renderPR({ news: [] });
    expect(screen.getByText('暫無競品報導')).toBeTruthy();
  });

  it('曝光成效：載入失敗與尚未匯入資料的狀態、重試', () => {
    setUrl('?section=exposure');
    const refreshMediaExposure = vi.fn();
    renderPR({ mediaExposure: [], mediaExposureStatus: 'error', refreshMediaExposure });
    fireEvent.click(within(cardOf('新聞稿曝光成效')).getByText('重試'));
    fireEvent.click(within(cardOf('人工彙整曝光')).getByText('重試'));
    expect(refreshMediaExposure).toHaveBeenCalledTimes(2);
  });
});

// ═══════════════════════════════════════════════════════════
describe('PR 曝光成效頁 — 上傳、匯出與隱私', () => {
  beforeEach(() => setUrl('?section=exposure'));

  it('Excel 上傳區可展開／收合', () => {
    renderPR();
    expect(screen.queryByLabelText('上傳通行碼')).toBeNull();
    fireEvent.click(screen.getByText('上傳 Excel'));
    expect(screen.getByLabelText('上傳通行碼')).toBeTruthy();
    fireEvent.click(screen.getByText('收合上傳'));
    expect(screen.queryByLabelText('上傳通行碼')).toBeNull();
  });

  it('兩個匯出按鈕名稱分開標示（匯出新聞稿成效／匯出曝光明細），畫面上沒有含糊的「匯出 Excel」', () => {
    renderPR();
    expect(screen.queryByText('匯出 Excel')).toBeNull();
    fireEvent.click(screen.getByText('匯出新聞稿成效'));
    expect(exportExposurePerformanceExcel).toHaveBeenCalledTimes(1);
    expect(exportExposurePerformanceExcel.mock.calls[0][0].detailRows).toHaveLength(3);
    fireEvent.click(screen.getByText('匯出曝光明細'));
    expect(exportMediaExposureExcel).toHaveBeenCalledTimes(1);
    expect(exportMediaExposureExcel.mock.calls[0][0]).toHaveLength(3);
  });

  it('新聞稿／主題預設收合，展開後才看到曝光明細', () => {
    renderPR();
    expect(screen.queryAllByRole('button', { expanded: true })).toHaveLength(0);
    expect(document.querySelectorAll('tbody tr')).toHaveLength(0);
    fireEvent.click(screen.getAllByRole('button', { expanded: false }).find(b => b.textContent.includes('創見榮獲 COMPUTEX')));
    expect(document.querySelectorAll('tbody tr')).toHaveLength(1);
  });

  it('曝光分析是曝光成效頁內的下一頁，子頁籤仍在上方；返回回到曝光成效', () => {
    renderPR();
    fireEvent.click(screen.getByText('曝光分析'));
    expect(screen.getByText('人工彙整曝光分析')).toBeTruthy();
    expect(selectedTab()).toBe('曝光成效');
    expect(screen.queryByText('重點媒體曝光監控')).toBeNull();
    fireEvent.click(screen.getByText('返回 PR 媒體戰情'));
    expect(screen.getByText('重點媒體曝光監控')).toBeTruthy();
  });

  it('四個子頁的畫面與匯出資料都沒有 media_exposure_private 的內容（內部備註、來源檔名、列號）', () => {
    const forbidden = ['內部備註不可外流', 'secret.xlsx', 'raw.example.com', '原始媒體名稱', 'noteInternal'];
    const { container } = renderPR();
    PR_SECTIONS.forEach(s => {
      clickTab(s.label);
      // 把所有主題展開，連明細都掃描
      screen.queryAllByRole('button', { expanded: false }).forEach(b => { if (b.hasAttribute('aria-controls') && !b.hasAttribute('role')) fireEvent.click(b); });
      forbidden.forEach(f => {
        expect(container.textContent, `${s.label}: ${f}`).not.toContain(f);
        expect(container.innerHTML, `${s.label}: ${f}`).not.toContain(f);
      });
    });
    clickTab('曝光成效');
    fireEvent.click(screen.getByText('匯出新聞稿成效'));
    const exported = JSON.stringify(exportExposurePerformanceExcel.mock.calls[0][0]);
    forbidden.forEach(f => expect(exported, f).not.toContain(f));
  });
});

// ═══════════════════════════════════════════════════════════
describe('App — 切換子頁／分頁不會重建資料 hook（Firestore 監聽器）', () => {
  async function renderApp() {
    const utils = render(<App />);
    await act(async () => {});
    return utils;
  }

  it('預設進入 PR 總覽；網址 ?tab= 控制主分頁；不認識的值回到 PR', async () => {
    setUrl('?tab=nonsense');
    await renderApp();
    expect(await screen.findByRole('tab', { name: '總覽' })).toBeTruthy();
    expect(new URLSearchParams(window.location.search).has('tab')).toBe(false);
  });

  it('依序切換四個子頁、再切到 IR／上游／系統健康又切回 PR，各資料 hook 都只掛載一次', async () => {
    await renderApp();
    await screen.findByRole('tab', { name: '總覽' });
    expect(mounts).toEqual({ feed: 1, pr: 1, exposure: 1, upstream: 1 });

    for (const name of ['新聞監測', '競品動態', '曝光成效', '總覽', '競品動態']) {
      await act(async () => { fireEvent.click(tabNamed(name)); });
    }
    for (const top of ['IR 投資情報', '上游市場', '系統健康', 'PR 媒體戰情']) {
      await act(async () => { fireEvent.click(screen.getByText(top)); });
      await act(async () => {});
    }
    await screen.findByRole('tab', { name: '總覽' });
    expect(mounts).toEqual({ feed: 1, pr: 1, exposure: 1, upstream: 1 });
  });

  it('主分頁切換寫入網址，上一頁會回到上一個主分頁', async () => {
    await renderApp();
    await screen.findByRole('tab', { name: '總覽' });
    await act(async () => { fireEvent.click(screen.getByText('上游市場')); });
    expect(new URLSearchParams(window.location.search).get('tab')).toBe('us');
    await act(async () => { window.history.back(); });
    await waitFor(() => expect(screen.getAllByRole('tab', { name: '總覽' })).toHaveLength(1));
  });
});
