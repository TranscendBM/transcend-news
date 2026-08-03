import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';

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
    sentiment: 'neutral',
    ...extra,
  };
}

function renderPRTab({ prArticles = [], prStatus = 'ready', refreshPRNews = vi.fn(), news = [] } = {}) {
  return render(<PRTab news={news} prArticles={prArticles} prStatus={prStatus} refreshPRNews={refreshPRNews} />);
}

beforeEach(() => {
  exportNewsExcel.mockClear();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('PRTab — PR 統計不依賴全站 2000 筆上限的 news prop', () => {
  it('counts and lists an article that only exists via prArticles, even if absent from the news prop', () => {
    vi.setSystemTime(taipei(2026, 7, 20, 12, 0, 0));
    const onlyInPRQuery = mkTranscend('only-in-pr', '創見發布新品獨家', taipei(2026, 7, 15));

    // news prop（模擬全站 useNewsFeed 裁切後的結果）完全不含這篇文章，
    // 證明 PR 統計/清單走的是獨立的 prArticles（usePRNews 的查詢結果），
    // 不受這個 prop 內容影響。
    renderPRTab({ prArticles: [onlyInPRQuery], news: [] });

    expect(screen.getByText('媒體曝光｜本月').parentElement.textContent).toContain('1');
    expect(screen.getByText('創見發布新品獨家')).toBeTruthy();
  });
});

describe('PRTab — 去重與排除規則跟統計/清單共用同一套', () => {
  it('dedupes two documents with the same normalized title into a single count/entry', () => {
    vi.setSystemTime(taipei(2026, 7, 20, 12, 0, 0));
    const a = mkTranscend('a', '創見發布新品B', taipei(2026, 7, 15));
    const b = mkTranscend('b', '創見發布新品B！', taipei(2026, 7, 16)); // 正規化後標題相同（只差結尾標點）

    renderPRTab({ prArticles: [a, b] });

    expect(screen.getByText('媒體曝光｜本月').parentElement.textContent).toContain('1');
    expect(screen.getAllByText(/創見發布新品B/).length).toBe(1);
  });

  it('does not count excluded/irrelevant documents (e.g. CMoney-sourced) even though cat is transcend', () => {
    vi.setSystemTime(taipei(2026, 7, 20, 12, 0, 0));
    const excluded = mkTranscend('excluded', '創見股價創見盤中速報', taipei(2026, 7, 15), {
      mediaName: 'CMoney', link: 'https://cmoney.tw/x',
    });

    renderPRTab({ prArticles: [excluded] });

    expect(screen.getByText('媒體曝光｜本月').parentElement.textContent).toContain('0');
    expect(screen.queryByText('創見股價創見盤中速報')).toBeNull();
  });
});

describe('PRTab — 查詢失敗顯示明確錯誤，可重試', () => {
  it('shows an error state in the news list instead of an empty/zero result, and retry calls refreshPRNews', () => {
    const refreshPRNews = vi.fn();
    renderPRTab({ prArticles: [], prStatus: 'error', refreshPRNews });

    expect(screen.getByText('⚠ 報導載入失敗')).toBeTruthy();
    fireEvent.click(screen.getByText('重試'));
    expect(refreshPRNews).toHaveBeenCalledTimes(1);
  });

  it('does not show a plain 0 in the stats cards while loading or on error', () => {
    const { rerender } = render(
      <PRTab news={[]} prArticles={[]} prStatus="loading" refreshPRNews={vi.fn()} />);
    expect(screen.getByText('媒體曝光｜本月').parentElement.textContent).not.toContain('0');

    rerender(<PRTab news={[]} prArticles={[]} prStatus="error" refreshPRNews={vi.fn()} />);
    expect(screen.getByText('媒體曝光｜本月').parentElement.textContent).not.toContain('0');
  });
});

describe('PRTab — 篩選工具列（搜尋／媒體／情緒）', () => {
  it('search text filters both the news list and the stats count', () => {
    vi.setSystemTime(taipei(2026, 7, 20, 12, 0, 0));
    const match = mkTranscend('match', '創見發表最新記憶卡新品', taipei(2026, 7, 15));
    const noMatch = mkTranscend('nomatch', '創見獲獎新聞', taipei(2026, 7, 16));
    renderPRTab({ prArticles: [match, noMatch] });

    expect(screen.getByText('媒體曝光｜本月').parentElement.textContent).toContain('2');

    fireEvent.change(screen.getByPlaceholderText('搜尋標題、內容、媒體或品牌…'), {
      target: { value: '記憶卡' },
    });

    expect(screen.getByText('媒體曝光｜本月').parentElement.textContent).toContain('1');
    expect(screen.getByText('創見發表最新記憶卡新品')).toBeTruthy();
    expect(screen.queryByText('創見獲獎新聞')).toBeNull();
  });

  it('media filter affects the list, stats, and the key-media ranking', () => {
    vi.setSystemTime(taipei(2026, 7, 20, 12, 0, 0));
    // 電子時報／Digitimes 是 KEY_MEDIA 內建的重點媒體之一（見 utils/news.js）。
    const digitimes = mkTranscend('d1', '創見新品發表會', taipei(2026, 7, 15), { mediaName: '電子時報' });
    const other = mkTranscend('o1', '創見產能報導', taipei(2026, 7, 16), { mediaName: '其他媒體' });
    renderPRTab({ prArticles: [digitimes, other] });

    fireEvent.change(screen.getByLabelText('依媒體篩選'), { target: { value: '電子時報' } });

    expect(screen.getByText('媒體曝光｜本月').parentElement.textContent).toContain('1');
    expect(screen.getByText('創見新品發表會')).toBeTruthy();
    expect(screen.queryByText('創見產能報導')).toBeNull();
    // 重點媒體排行只算電子時報／Digitimes 的這篇——限定在 KeyMediaPanel
    // 卡片內查找，避免跟媒體篩選下拉選單裡的同名選項搞混。
    const keyMediaCard = screen.getByText('重點媒體曝光監控').closest('.bg-gray-900');
    const row = within(keyMediaCard).getByText('電子時報').closest('.group');
    expect(row.textContent).toBe('1電子時報Digitimes1');
  });

  it('sentiment filter affects the list and the stats count', () => {
    vi.setSystemTime(taipei(2026, 7, 20, 12, 0, 0));
    const positive = mkTranscend('pos', '創見獲獎肯定', taipei(2026, 7, 15), { sentiment: 'positive' });
    const negative = mkTranscend('neg', '創見產品下架', taipei(2026, 7, 16), { sentiment: 'negative' });
    renderPRTab({ prArticles: [positive, negative] });

    fireEvent.change(screen.getByLabelText('依情緒篩選'), { target: { value: 'positive' } });

    expect(screen.getByText('媒體曝光｜本月').parentElement.textContent).toContain('1');
    expect(screen.getByText('創見獲獎肯定')).toBeTruthy();
    expect(screen.queryByText('創見產品下架')).toBeNull();
  });

  it('resultCount/totalCount in the toolbar come from the PR-specific dataset, not a 2000-cap-limited source', () => {
    vi.setSystemTime(taipei(2026, 7, 20, 12, 0, 0));
    const a = mkTranscend('a', '創見新聞A', taipei(2026, 7, 15));
    const b = mkTranscend('b', '創見新聞B', taipei(2026, 7, 16));
    // news prop（模擬全站上限後的資料）刻意留空，證明工具列數字不是從這裡來的。
    renderPRTab({ prArticles: [a, b], news: [] });

    expect(screen.getByText(/顯示 2 \/ 2 則/)).toBeTruthy();
  });

  it('only one filter toolbar appears on the PR page', () => {
    renderPRTab({ prArticles: [] });
    expect(screen.getAllByPlaceholderText('搜尋標題、內容、媒體或品牌…')).toHaveLength(1);
  });
});

describe('PRTab — Excel 匯出符合目前搜尋條件、媒體、情緒與期間', () => {
  it('exports exactly the articles within the currently selected period (today) with the toolbar filters applied', () => {
    vi.setSystemTime(taipei(2026, 7, 20, 12, 0, 0));
    const today1 = mkTranscend('today1', '創見今日快訊一', taipei(2026, 7, 20, 8, 0, 0));
    const today2 = mkTranscend('today2', '創見今日快訊二（不同媒體）', taipei(2026, 7, 20, 9, 0, 0), { mediaName: '其他媒體' });
    const earlierThisMonth = mkTranscend('earlier', '創見月初新聞', taipei(2026, 7, 2));
    renderPRTab({ prArticles: [today1, today2, earlierThisMonth] });

    // 「今天」文字在畫面上不只一處（CompetitorNews 也有自己一份共用的
    // TIME_FILTERS，同樣有「今天」按鈕）——把查詢範圍限定在「創見最新
    // 報導」卡片內，才是 PR 專用的期間篩選按鈕。
    const card = screen.getByText('創見最新報導').closest('.bg-gray-900');
    fireEvent.click(within(card).getByText('今天'));

    // 再套用媒體篩選：只留「正常媒體」——應排除 today2（其他媒體）與
    // earlierThisMonth（已被期間篩選排除）。
    fireEvent.change(screen.getByLabelText('依媒體篩選'), { target: { value: '正常媒體' } });

    fireEvent.click(within(card).getByText('⬇ 匯出 Excel'));
    expect(exportNewsExcel).toHaveBeenCalledTimes(1);
    const [exported] = exportNewsExcel.mock.calls[0];
    expect(exported.map(a => a.id)).toEqual(['today1']);
  });
});
