import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';

const mockUsePRNews = vi.fn();
vi.mock('./features/news/usePRNews.js', () => ({
  usePRNews: (...args) => mockUsePRNews(...args),
}));

const exportNewsExcel = vi.fn();
vi.mock('./utils/formatting.js', () => ({
  exportNewsExcel: (...args) => exportNewsExcel(...args),
}));

import { PRTab } from './App.jsx';

function taipei(year, month, day, hour = 0, minute = 0, second = 0) {
  return new Date(Date.UTC(year, month - 1, day, hour, minute, second) - 8 * 60 * 60 * 1000);
}

function mkTranscend(id, title, pubDate, extra = {}) {
  return {
    id, title, pubDate, cat: 'transcend',
    mediaName: '正常媒體', content: '創見資訊', link: `https://example.com/${id}`,
    ...extra,
  };
}

beforeEach(() => {
  mockUsePRNews.mockReset();
  exportNewsExcel.mockClear();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('PRTab — PR 統計不依賴全站 2000 筆上限的 news prop', () => {
  it('counts and lists an article that only exists via usePRNews, even if absent from the news prop', () => {
    vi.setSystemTime(taipei(2026, 7, 20, 12, 0, 0));
    const onlyInPRQuery = mkTranscend('only-in-pr', '創見發布新品獨家', taipei(2026, 7, 15));
    mockUsePRNews.mockReturnValue({ articles: [onlyInPRQuery], status: 'ready' });

    // news prop（模擬全站 useNewsFeed 裁切後的結果）完全不含這篇文章，
    // 證明 PR 統計/清單走的是獨立的 usePRNews，不受這個 prop 內容影響。
    render(<PRTab news={[]} />);

    expect(screen.getByText('媒體曝光｜本月').parentElement.textContent).toContain('1');
    expect(screen.getByText('創見發布新品獨家')).toBeTruthy();
  });
});

describe('PRTab — 去重與排除規則跟統計/清單共用同一套', () => {
  it('dedupes two documents with the same normalized title into a single count/entry', () => {
    vi.setSystemTime(taipei(2026, 7, 20, 12, 0, 0));
    const a = mkTranscend('a', '創見發布新品B', taipei(2026, 7, 15));
    const b = mkTranscend('b', '創見發布新品B！', taipei(2026, 7, 16)); // 正規化後標題相同（只差結尾標點）
    mockUsePRNews.mockReturnValue({ articles: [a, b], status: 'ready' });

    render(<PRTab news={[]} />);

    expect(screen.getByText('媒體曝光｜本月').parentElement.textContent).toContain('1');
    expect(screen.getAllByText(/創見發布新品B/).length).toBe(1);
  });

  it('does not count excluded/irrelevant documents (e.g. CMoney-sourced) even though cat is transcend', () => {
    vi.setSystemTime(taipei(2026, 7, 20, 12, 0, 0));
    const excluded = mkTranscend('excluded', '創見股價創見盤中速報', taipei(2026, 7, 15), {
      mediaName: 'CMoney', link: 'https://cmoney.tw/x',
    });
    mockUsePRNews.mockReturnValue({ articles: [excluded], status: 'ready' });

    render(<PRTab news={[]} />);

    expect(screen.getByText('媒體曝光｜本月').parentElement.textContent).toContain('0');
    expect(screen.queryByText('創見股價創見盤中速報')).toBeNull();
  });
});

describe('PRTab — 查詢失敗顯示明確錯誤，不是安靜的 0', () => {
  it('shows an error state in the news list instead of an empty/zero result', () => {
    mockUsePRNews.mockReturnValue({ articles: [], status: 'error' });
    render(<PRTab news={[]} />);
    expect(screen.getByText('⚠ 報導載入失敗，請稍後重新整理')).toBeTruthy();
  });
});

describe('PRTab — Excel 匯出符合目前選取期間', () => {
  it('exports exactly the articles within the currently selected period (today), not the default month, not truncated', () => {
    vi.setSystemTime(taipei(2026, 7, 20, 12, 0, 0));
    const today1 = mkTranscend('today1', '創見今日快訊一', taipei(2026, 7, 20, 8, 0, 0));
    const today2 = mkTranscend('today2', '創見今日快訊二', taipei(2026, 7, 20, 9, 0, 0));
    const earlierThisMonth = mkTranscend('earlier', '創見月初新聞', taipei(2026, 7, 2));
    mockUsePRNews.mockReturnValue({
      articles: [today1, today2, earlierThisMonth], status: 'ready',
    });

    render(<PRTab news={[]} />);

    // 「今天」文字在畫面上不只一處（CompetitorNews 也有自己一份共用的
    // TIME_FILTERS，同樣有「今天」按鈕）——把查詢範圍限定在「創見最新
    // 報導」卡片內，才是 PR 專用的期間篩選按鈕。
    const card = screen.getByText('創見最新報導').closest('.bg-gray-900');
    fireEvent.click(within(card).getByText('今天'));

    fireEvent.click(within(card).getByText('⬇ 匯出 Excel'));
    expect(exportNewsExcel).toHaveBeenCalledTimes(1);
    const [exported] = exportNewsExcel.mock.calls[0];
    const exportedIds = exported.map(a => a.id).sort();
    expect(exportedIds).toEqual(['today1', 'today2']);
  });
});
