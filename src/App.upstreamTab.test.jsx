import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';

import { USMarketTab } from './App.jsx';

function taipei(year, month, day, hour = 0, minute = 0, second = 0) {
  return new Date(Date.UTC(year, month - 1, day, hour, minute, second) - 8 * 60 * 60 * 1000);
}

// 文章時間一律落在台灣時間白天中段（12:00–18:00），系統「現在」設在
// 台灣晚間 20:00：TodayBriefing.jsx 自己的「今天」判斷是用瀏覽器本地
// 曆日（new Date().getFullYear()/getMonth()/getDate()，不是 Asia/Taipei
// 位移),測試環境（跟大多數 CI 一樣）預設 TZ=UTC，若文章時間太靠近台灣
// 午夜（例如台灣 07:00 = UTC 前一天 23:00），會落在 UTC 曆日的「昨天」，
// 讓 TodayBriefing 判斷成「不是今天」而消失，即使 Asia/Taipei 觀點認定
// 是同一天——這不是本次要修的既有行為，選在白天中段可以確保跟
// USMarketTab 自己的 Asia/Taipei 期間篩選（taipeiDayStart 等）看法一致，
// 不因測試環境時區而產生假失敗。
const NOW = taipei(2026, 7, 20, 20, 0, 0);

function mkUpstream(id, title, pubDate, extra = {}) {
  return {
    id, title, pubDate, cat: 'usMarket',
    // 預設內容刻意不含任何 BRIEFING_RULES 關鍵字（風險/財務/機會/市場），
    // 避免文章意外被算進「今日重要情報」，干擾不需要今日情報參與的測試。
    // 需要驗證今日情報同步的測試，改在 title 裡明確放入關鍵字。
    mediaName: '正常媒體', content: '例行產業動態', link: `https://example.com/${id}`,
    sentiment: 'neutral',
    ...extra,
  };
}

function renderUSMarketTab({ upstreamArticles = [], upstreamStatus = 'ready', refreshUpstreamNews = vi.fn() } = {}) {
  return render(
    <USMarketTab
      upstreamArticles={upstreamArticles}
      upstreamStatus={upstreamStatus}
      refreshUpstreamNews={refreshUpstreamNews}
    />
  );
}

// 「上游供應鏈 ＆ DRAM / Flash 市場新聞」卡片：期間/品牌篩選按鈕跟
// 下方的新聞清單都在這個容器內。
function newsListCard() {
  return screen.getByText(/上游供應鏈/).closest('.bg-gray-900');
}

// 「上游市場今日重要情報」卡片（TodayBriefing）。
function briefingPanel() {
  return screen.getByText('上游市場今日重要情報').closest('.bg-gray-900');
}

function statCard(label) {
  return screen.getByText(label).closest('.bg-gray-900');
}

afterEach(() => {
  vi.useRealTimers();
});

describe('USMarketTab — 統計卡片／今日重要情報／新聞清單三者各自正確且一致', () => {
  it('a briefing-eligible article shows exactly once in the news list AND exactly once in TodayBriefing', () => {
    vi.setSystemTime(NOW);
    const title = 'Samsung 記憶體現貨價創新高';
    const a = mkUpstream('a1', title, taipei(2026, 7, 20, 14, 0, 0), { sourceName: 'Samsung Newsroom' });
    renderUSMarketTab({ upstreamArticles: [a] });

    // 分別限定在各自容器內檢查，不用整頁 getAllByText(...).length>=1
    // 帶過——今日情報與新聞清單各自只能顯示這篇故事一次。
    expect(within(newsListCard()).getByText(title)).toBeTruthy();
    expect(within(briefingPanel()).getByText(title)).toBeTruthy();
    expect(within(statCard('本期新聞')).getByText('1')).toBeTruthy();
  });

  it('dedupes two documents with the same normalized title into a single entry in the news list, and keeps it out of TodayBriefing when it matches no briefing keyword', () => {
    vi.setSystemTime(NOW);
    const title = '亞洲科技廠人事異動公告';
    const a = mkUpstream('a', title, taipei(2026, 7, 20, 14, 0, 0));
    const b = mkUpstream('b', `${title}！`, taipei(2026, 7, 20, 16, 0, 0));
    renderUSMarketTab({ upstreamArticles: [a, b] });

    // 新聞清單：去重後只剩一筆——用 getByText（在容器內找不到或找到
    // 超過一個都會丟例外），不是「整頁次數等於 1」。
    expect(within(newsListCard()).getByText(title)).toBeTruthy();
    // 這篇文章不含任何 BRIEFING_RULES 關鍵字，today Briefing 應該完全
    // 沒有它（不是「至少出現一次」的寬鬆判斷，是明確判斷「找不到」）。
    expect(within(briefingPanel()).queryByText(title)).toBeNull();
    expect(within(briefingPanel()).getByText('今天目前沒有需要處理的重要情報')).toBeTruthy();
    expect(within(statCard('本期新聞')).getByText('1')).toBeTruthy();
  });
});

describe('USMarketTab — 查詢失敗顯示明確錯誤，可重試', () => {
  it('shows an error state in the news list instead of an empty/zero result, and retry calls refreshUpstreamNews', () => {
    const refreshUpstreamNews = vi.fn();
    renderUSMarketTab({ upstreamArticles: [], upstreamStatus: 'error', refreshUpstreamNews });

    expect(screen.getByText('⚠ 上游新聞載入失敗')).toBeTruthy();
    fireEvent.click(screen.getByText('重試'));
    expect(refreshUpstreamNews).toHaveBeenCalledTimes(1);
  });

  it('does not show a plain 0 in the stats cards while loading or on error', () => {
    const { rerender } = render(
      <USMarketTab upstreamArticles={[]} upstreamStatus="loading" refreshUpstreamNews={vi.fn()} />);
    const card = statCard('本期新聞');
    expect(within(card).queryByText('0')).toBeNull();
    expect(within(card).getByText('載入中…')).toBeTruthy();

    rerender(<USMarketTab upstreamArticles={[]} upstreamStatus="error" refreshUpstreamNews={vi.fn()} />);
    const cardAfter = statCard('本期新聞');
    expect(within(cardAfter).queryByText('0')).toBeNull();
    expect(within(cardAfter).getByText('⚠ 載入失敗')).toBeTruthy();
  });
});

describe('USMarketTab — 期間篩選只保留今天／本週／本月，台灣週一為週起點', () => {
  it('only renders today/week/month period buttons (no 本年/已載入資料)', () => {
    renderUSMarketTab({ upstreamArticles: [] });
    const card = newsListCard();
    expect(within(card).getByText('今天')).toBeTruthy();
    expect(within(card).getByText('本週')).toBeTruthy();
    expect(within(card).getByText('本月')).toBeTruthy();
    expect(within(card).queryByText('本年')).toBeNull();
    expect(within(card).queryByText('已載入資料')).toBeNull();
  });

  it('week period uses the Taipei Monday boundary, not "last 7 days"', () => {
    // 2026-08-03 是台灣時間的週一；週三發布的文章應該落在本週內，
    // 但上週一發布的文章應該被排除在「本週」之外。
    vi.setSystemTime(taipei(2026, 8, 5, 10, 0, 0)); // 8/5 週三
    const thisWeek = mkUpstream('w1', '本週上游新聞', taipei(2026, 8, 3, 14, 0, 0)); // 本週一
    const lastWeek = mkUpstream('w2', '上週上游新聞', taipei(2026, 7, 27, 14, 0, 0)); // 上週一
    renderUSMarketTab({ upstreamArticles: [thisWeek, lastWeek] });

    const card = newsListCard();
    fireEvent.click(within(card).getByText('本週'));

    expect(within(card).getByText('本週上游新聞')).toBeTruthy();
    expect(within(card).queryByText('上週上游新聞')).toBeNull();
  });
});

describe('USMarketTab — 搜尋／媒體／情緒／品牌篩選同步影響統計、新聞清單與今日重要情報', () => {
  it('search text filters the news list, TodayBriefing, and the stats count in lockstep', () => {
    vi.setSystemTime(NOW);
    const matchTitle = 'Micron 財報優於預期';
    const noMatchTitle = 'SK Hynix 擴產計畫';
    const match = mkUpstream('m1', matchTitle, taipei(2026, 7, 20, 14, 0, 0));
    const noMatch = mkUpstream('m2', noMatchTitle, taipei(2026, 7, 20, 16, 0, 0));
    renderUSMarketTab({ upstreamArticles: [match, noMatch] });

    // 篩選前：兩篇都符合 BRIEFING_RULES 關鍵字，今日情報跟新聞清單都應該
    // 各看得到兩篇。
    expect(within(newsListCard()).getByText(matchTitle)).toBeTruthy();
    expect(within(newsListCard()).getByText(noMatchTitle)).toBeTruthy();
    expect(within(briefingPanel()).getByText(matchTitle)).toBeTruthy();
    expect(within(briefingPanel()).getByText(noMatchTitle)).toBeTruthy();

    fireEvent.change(screen.getByPlaceholderText('搜尋標題、內容、媒體或品牌…'), {
      target: { value: 'Micron' },
    });

    expect(within(statCard('本期新聞')).getByText('1')).toBeTruthy();
    expect(within(newsListCard()).getByText(matchTitle)).toBeTruthy();
    expect(within(newsListCard()).queryByText(noMatchTitle)).toBeNull();
    // 獨立確認 TodayBriefing 也同步套用了搜尋條件，不是只有新聞清單變了。
    expect(within(briefingPanel()).getByText(matchTitle)).toBeTruthy();
    expect(within(briefingPanel()).queryByText(noMatchTitle)).toBeNull();
  });

  it('media filter affects the news list, TodayBriefing, and the stats count in lockstep', () => {
    vi.setSystemTime(NOW);
    const aTitle = '記憶體現貨價本週上漲';
    const bTitle = '記憶體庫存去化牛步報導';
    const a = mkUpstream('a1', aTitle, taipei(2026, 7, 20, 14, 0, 0), { mediaName: '電子時報' });
    const b = mkUpstream('a2', bTitle, taipei(2026, 7, 20, 16, 0, 0), { mediaName: '其他媒體' });
    renderUSMarketTab({ upstreamArticles: [a, b] });

    fireEvent.change(screen.getByLabelText('依媒體篩選'), { target: { value: '電子時報' } });

    expect(within(statCard('本期新聞')).getByText('1')).toBeTruthy();
    expect(within(newsListCard()).getByText(aTitle)).toBeTruthy();
    expect(within(newsListCard()).queryByText(bTitle)).toBeNull();
    expect(within(briefingPanel()).getByText(aTitle)).toBeTruthy();
    expect(within(briefingPanel()).queryByText(bTitle)).toBeNull();
  });

  it('sentiment filter affects the news list, TodayBriefing, and the stats count in lockstep', () => {
    vi.setSystemTime(NOW);
    const posTitle = '供應鏈報喜訊格局回穩';
    const negTitle = '供應鏈拉警報恐生變數';
    const positive = mkUpstream('p1', posTitle, taipei(2026, 7, 20, 14, 0, 0), { sentiment: 'positive' });
    const negative = mkUpstream('n1', negTitle, taipei(2026, 7, 20, 16, 0, 0), { sentiment: 'negative' });
    renderUSMarketTab({ upstreamArticles: [positive, negative] });

    fireEvent.change(screen.getByLabelText('依情緒篩選'), { target: { value: 'positive' } });

    expect(within(statCard('本期新聞')).getByText('1')).toBeTruthy();
    expect(within(newsListCard()).getByText(posTitle)).toBeTruthy();
    expect(within(newsListCard()).queryByText(negTitle)).toBeNull();
    expect(within(briefingPanel()).getByText(posTitle)).toBeTruthy();
    expect(within(briefingPanel()).queryByText(negTitle)).toBeNull();
  });

  it('brand filter affects the news list, TodayBriefing, the stats cards, and 最多討論/品牌數量 in lockstep', () => {
    vi.setSystemTime(NOW);
    const samsungTitle = 'Samsung 新品發表亮相';
    const micronTitle = 'Micron 財報公布優於預期';
    const samsung = mkUpstream('s1', samsungTitle, taipei(2026, 7, 20, 14, 0, 0), { sourceName: 'Samsung' });
    const micron = mkUpstream('m1', micronTitle, taipei(2026, 7, 20, 16, 0, 0), { sourceName: 'Micron' });
    renderUSMarketTab({ upstreamArticles: [samsung, micron] });

    expect(within(statCard('品牌數量')).getByText('2')).toBeTruthy();

    // 「Samsung」文字同時出現在品牌 pill 按鈕與新聞卡片上的品牌標籤，
    // 用 role=button 精準指到 pill 按鈕，避免點到卡片上的標籤。
    fireEvent.click(within(newsListCard()).getByRole('button', { name: /^Samsung/ }));

    expect(within(statCard('本期新聞')).getByText('1')).toBeTruthy();
    expect(within(statCard('品牌數量')).getByText('1')).toBeTruthy();
    expect(within(statCard('最多討論')).getByText('Samsung')).toBeTruthy();

    expect(within(newsListCard()).getByText(samsungTitle)).toBeTruthy();
    expect(within(newsListCard()).queryByText(micronTitle)).toBeNull();
    expect(within(briefingPanel()).getByText(samsungTitle)).toBeTruthy();
    expect(within(briefingPanel()).queryByText(micronTitle)).toBeNull();
  });

  it('resultCount/totalCount in the toolbar come from the upstream-specific dataset', () => {
    vi.setSystemTime(NOW);
    const a = mkUpstream('a', '上游新聞A', taipei(2026, 7, 20, 14, 0, 0));
    const b = mkUpstream('b', '上游新聞B', taipei(2026, 7, 20, 16, 0, 0));
    renderUSMarketTab({ upstreamArticles: [a, b] });

    expect(screen.getByText(/顯示 2 \/ 2 則/)).toBeTruthy();
  });

  it('only one filter toolbar appears on the upstream page', () => {
    renderUSMarketTab({ upstreamArticles: [] });
    expect(screen.getAllByPlaceholderText('搜尋標題、內容、媒體或品牌…')).toHaveLength(1);
  });
});

describe('USMarketTab — 今日重要情報反映正確的分類（風險/財務/機會/市場）', () => {
  it('a risk-worthy article shows in TodayBriefing with the risk badge, and also in the news list, exactly once each', () => {
    vi.setSystemTime(NOW);
    const title = 'DRAM 供應鏈爆發資安危機';
    const risk = mkUpstream('r1', title, taipei(2026, 7, 20, 14, 0, 0));
    renderUSMarketTab({ upstreamArticles: [risk] });

    const briefing = briefingPanel();
    expect(within(briefing).getByText(title)).toBeTruthy();
    expect(within(briefing).getByText('風險')).toBeTruthy();
    expect(within(newsListCard()).getByText(title)).toBeTruthy();
    expect(within(statCard('本期新聞')).getByText('1')).toBeTruthy();
  });
});
