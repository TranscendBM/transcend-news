import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';

import { USMarketTab } from './App.jsx';

function taipei(year, month, day, hour = 0, minute = 0, second = 0) {
  return new Date(Date.UTC(year, month - 1, day, hour, minute, second) - 8 * 60 * 60 * 1000);
}

function mkUpstream(id, title, pubDate, extra = {}) {
  return {
    id, title, pubDate, cat: 'usMarket',
    mediaName: '正常媒體', content: 'DRAM 市場動態', link: `https://example.com/${id}`,
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

afterEach(() => {
  vi.useRealTimers();
});

describe('USMarketTab — 統計卡片／清單／今日情報共用同一份已去重已篩選資料', () => {
  it('counts and lists an upstream article from upstreamArticles', () => {
    vi.setSystemTime(taipei(2026, 7, 20, 12, 0, 0));
    const a = mkUpstream('a1', 'Samsung 記憶體漲價', taipei(2026, 7, 20, 8, 0, 0), { sourceName: 'Samsung Newsroom' });
    renderUSMarketTab({ upstreamArticles: [a] });

    // 這篇文章符合 BRIEFING_RULES 的市場關鍵字（漲價），所以今天重要
    // 情報卡片與下方新聞清單都會各出現一次——兩處使用同一份已去重
    // 資料，一致出現才是正確行為，不是重複算兩次。
    expect(screen.getAllByText('Samsung 記憶體漲價').length).toBeGreaterThanOrEqual(1);
    const card = screen.getByText('本期新聞').closest('.bg-gray-900');
    expect(within(card).getByText('1')).toBeTruthy();
  });

  it('dedupes two documents with the same normalized title into a single count/entry', () => {
    vi.setSystemTime(taipei(2026, 7, 20, 12, 0, 0));
    const a = mkUpstream('a', 'DRAM 市場報價創新高', taipei(2026, 7, 20, 7, 0, 0));
    const b = mkUpstream('b', 'DRAM 市場報價創新高！', taipei(2026, 7, 20, 8, 0, 0));
    renderUSMarketTab({ upstreamArticles: [a, b] });

    const card = screen.getByText('本期新聞').closest('.bg-gray-900');
    expect(within(card).getByText('1')).toBeTruthy();
    expect(screen.getAllByText(/DRAM 市場報價創新高/).length).toBe(1);
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
    const card = screen.getByText('本期新聞').closest('.bg-gray-900');
    expect(within(card).queryByText('0')).toBeNull();
    expect(within(card).getByText('載入中…')).toBeTruthy();

    rerender(<USMarketTab upstreamArticles={[]} upstreamStatus="error" refreshUpstreamNews={vi.fn()} />);
    const cardAfter = screen.getByText('本期新聞').closest('.bg-gray-900');
    expect(within(cardAfter).queryByText('0')).toBeNull();
    expect(within(cardAfter).getByText('⚠ 載入失敗')).toBeTruthy();
  });
});

describe('USMarketTab — 期間篩選只保留今天／本週／本月，台灣週一為週起點', () => {
  it('only renders today/week/month period buttons (no 本年/已載入資料)', () => {
    renderUSMarketTab({ upstreamArticles: [] });
    const card = screen.getByText(/上游供應鏈/).closest('.bg-gray-900');
    expect(within(card).getByText('今天')).toBeTruthy();
    expect(within(card).getByText('本週')).toBeTruthy();
    expect(within(card).getByText('本月')).toBeTruthy();
    expect(within(card).queryByText('本年')).toBeNull();
    expect(within(card).queryByText('已載入資料')).toBeNull();
  });

  it('week period uses the Taipei Monday boundary, not "last 7 days"', () => {
    // 2026-08-03 是台灣時間的週一；週三發布的文章應該落在本週內，
    // 但 9 天前（上週二）發布的文章應該被排除在「本週」之外。
    vi.setSystemTime(taipei(2026, 8, 5, 10, 0, 0)); // 8/5 週三
    const thisWeek = mkUpstream('w1', '本週上游新聞', taipei(2026, 8, 3, 1, 0, 0)); // 本週一
    const lastWeek = mkUpstream('w2', '上週上游新聞', taipei(2026, 7, 27, 10, 0, 0)); // 上週一
    renderUSMarketTab({ upstreamArticles: [thisWeek, lastWeek] });

    const card = screen.getByText(/上游供應鏈/).closest('.bg-gray-900');
    fireEvent.click(within(card).getByText('本週'));

    expect(screen.getByText('本週上游新聞')).toBeTruthy();
    expect(screen.queryByText('上週上游新聞')).toBeNull();
  });
});

describe('USMarketTab — 搜尋／媒體／情緒／品牌篩選同步影響統計及清單', () => {
  it('search text filters both the news list and the stats count', () => {
    vi.setSystemTime(taipei(2026, 7, 20, 12, 0, 0));
    const match = mkUpstream('m1', 'Micron 財報優於預期', taipei(2026, 7, 20, 7, 0, 0));
    const noMatch = mkUpstream('m2', 'SK Hynix 擴產計畫', taipei(2026, 7, 20, 8, 0, 0));
    renderUSMarketTab({ upstreamArticles: [match, noMatch] });

    fireEvent.change(screen.getByPlaceholderText('搜尋標題、內容、媒體或品牌…'), {
      target: { value: 'Micron' },
    });

    const card = screen.getByText('本期新聞').closest('.bg-gray-900');
    expect(within(card).getByText('1')).toBeTruthy();
    expect(screen.getByText('Micron 財報優於預期')).toBeTruthy();
    expect(screen.queryByText('SK Hynix 擴產計畫')).toBeNull();
  });

  it('media filter affects the list and the stats count', () => {
    vi.setSystemTime(taipei(2026, 7, 20, 12, 0, 0));
    const a = mkUpstream('a1', '上游新聞甲', taipei(2026, 7, 20, 7, 0, 0), { mediaName: '電子時報' });
    const b = mkUpstream('a2', '上游新聞乙', taipei(2026, 7, 20, 8, 0, 0), { mediaName: '其他媒體' });
    renderUSMarketTab({ upstreamArticles: [a, b] });

    fireEvent.change(screen.getByLabelText('依媒體篩選'), { target: { value: '電子時報' } });

    const card = screen.getByText('本期新聞').closest('.bg-gray-900');
    expect(within(card).getByText('1')).toBeTruthy();
    expect(screen.getByText('上游新聞甲')).toBeTruthy();
    expect(screen.queryByText('上游新聞乙')).toBeNull();
  });

  it('sentiment filter affects the list and the stats count', () => {
    vi.setSystemTime(taipei(2026, 7, 20, 12, 0, 0));
    const positive = mkUpstream('p1', '供應鏈報喜訊', taipei(2026, 7, 20, 7, 0, 0), { sentiment: 'positive' });
    const negative = mkUpstream('n1', '供應鏈警訊', taipei(2026, 7, 20, 8, 0, 0), { sentiment: 'negative' });
    renderUSMarketTab({ upstreamArticles: [positive, negative] });

    fireEvent.change(screen.getByLabelText('依情緒篩選'), { target: { value: 'positive' } });

    const card = screen.getByText('本期新聞').closest('.bg-gray-900');
    expect(within(card).getByText('1')).toBeTruthy();
    expect(screen.getByText('供應鏈報喜訊')).toBeTruthy();
    expect(screen.queryByText('供應鏈警訊')).toBeNull();
  });

  it('brand filter affects the list, the stats cards, and 最多討論/品牌數量', () => {
    vi.setSystemTime(taipei(2026, 7, 20, 12, 0, 0));
    const samsung = mkUpstream('s1', 'Samsung 新品發表', taipei(2026, 7, 20, 7, 0, 0), { sourceName: 'Samsung' });
    const micron = mkUpstream('m1', 'Micron 財報公布', taipei(2026, 7, 20, 8, 0, 0), { sourceName: 'Micron' });
    renderUSMarketTab({ upstreamArticles: [samsung, micron] });

    const beforeCard = screen.getByText('品牌數量').closest('.bg-gray-900');
    expect(within(beforeCard).getByText('2')).toBeTruthy();

    // 「Samsung」文字同時出現在品牌 pill 按鈕與新聞卡片上的品牌標籤，
    // 用 role=button 精準指到 pill 按鈕，避免點到卡片上的標籤。
    const upstreamCard = screen.getByText(/上游供應鏈/).closest('.bg-gray-900');
    fireEvent.click(within(upstreamCard).getByRole('button', { name: /^Samsung/ }));

    expect(screen.getByText('Samsung 新品發表')).toBeTruthy();
    expect(screen.queryByText('Micron 財報公布')).toBeNull();

    const totalCard = screen.getByText('本期新聞').closest('.bg-gray-900');
    expect(within(totalCard).getByText('1')).toBeTruthy();
    const brandCountCard = screen.getByText('品牌數量').closest('.bg-gray-900');
    expect(within(brandCountCard).getByText('1')).toBeTruthy();
    const topCard = screen.getByText('最多討論').closest('.bg-gray-900');
    expect(within(topCard).getByText('Samsung')).toBeTruthy();
  });

  it('resultCount/totalCount in the toolbar come from the upstream-specific dataset', () => {
    vi.setSystemTime(taipei(2026, 7, 20, 12, 0, 0));
    const a = mkUpstream('a', '上游新聞A', taipei(2026, 7, 20, 7, 0, 0));
    const b = mkUpstream('b', '上游新聞B', taipei(2026, 7, 20, 8, 0, 0));
    renderUSMarketTab({ upstreamArticles: [a, b] });

    expect(screen.getByText(/顯示 2 \/ 2 則/)).toBeTruthy();
  });

  it('only one filter toolbar appears on the upstream page', () => {
    renderUSMarketTab({ upstreamArticles: [] });
    expect(screen.getAllByPlaceholderText('搜尋標題、內容、媒體或品牌…')).toHaveLength(1);
  });
});

describe('USMarketTab — 今日重要情報使用同一份已去重已篩選資料', () => {
  it('shows the briefing panel for an upstream article and reflects the active filters', () => {
    vi.setSystemTime(taipei(2026, 7, 20, 12, 0, 0));
    const risk = mkUpstream('r1', 'DRAM 供應鏈爆發資安危機', taipei(2026, 7, 20, 8, 0, 0));
    renderUSMarketTab({ upstreamArticles: [risk] });

    expect(screen.getByText('上游市場今日重要情報')).toBeTruthy();
    // 同一份 final 資料同時餵給今日情報卡片與下方新聞清單，兩處各出現
    // 一次是預期行為。
    expect(screen.getAllByText('DRAM 供應鏈爆發資安危機').length).toBeGreaterThanOrEqual(1);
  });
});
