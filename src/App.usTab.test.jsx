import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';

// App() 掛載時會呼叫 getDb/doc/onSnapshot/getDoc 做股價監聽與多個
// fetch*()（財報/股利/…），這些呼叫都已經用 try/catch 包住、失敗時
// 靜默 fallback（見 App.jsx 的 fetchStocks/fetchRevenue/…），所以這裡
// 只需要提供不會拋出例外的最小假實作，不需要真的回傳資料。
vi.mock('./services/firebase.js', () => ({
  getDb: () => ({ __fake: 'db' }),
  doc: () => ({ __fake: 'docRef' }),
  onSnapshot: () => () => {}, // 回傳一個什麼都不做的 unsubscribe
  getDoc: async () => ({ exists: () => false }),
}));

// USMarketTab 預設時間篩選是「本週」——用目前真實時間當 pubDate，
// 確保不管測試實際執行的日期是哪一天，這些文章一定落在「本週」範圍內。
const now = new Date();
const newsFeedNews = [
  { id: 'us1', title: '上游市場新聞A', cat: 'usMarket', mediaName: '媒體A', pubDate: now },
  { id: 'us2', title: '上游市場新聞B', cat: 'usMarket', mediaName: '媒體B', pubDate: now },
  { id: 'comp1', title: '威剛財報', cat: 'competitor', brand: 'ADATA', mediaName: '媒體C', pubDate: now },
];

vi.mock('./features/news/useNewsFeed.js', () => ({
  useNewsFeed: () => ({ news: newsFeedNews, loading: false, refresh: vi.fn() }),
}));

vi.mock('./features/news/usePRNews.js', () => ({
  usePRNews: () => ({ articles: [], status: 'ready', refresh: vi.fn() }),
}));

import App from './App.jsx';

beforeEach(() => {
  vi.clearAllMocks();
});

// App() 掛載時的 fetchAll() 會非同步 setState（即使 getDoc 已經 mock
// 成立即 resolve），用一個微任務刷新讓那些 pending 的狀態更新在渲染
// 斷言之前先完成，避免 act() 警告。
async function renderAppSettled() {
  const utils = render(<App />);
  await act(async () => {});
  return utils;
}

async function switchTab(label) {
  await act(async () => {
    fireEvent.click(screen.getByText(label));
  });
}

describe('App — 上游市場分頁的篩選功能不受 PR 分頁改動影響', () => {
  it('shows the shared toolbar on the US tab and search/media filters the US news list', async () => {
    await renderAppSettled();
    await switchTab('上游市場');

    // US 分頁的工具列仍然存在且能正常篩選。
    const searchBox = screen.getByPlaceholderText('搜尋標題、內容、媒體或品牌…');
    expect(searchBox).toBeTruthy();
    expect(screen.getByText('上游市場新聞A')).toBeTruthy();
    expect(screen.getByText('上游市場新聞B')).toBeTruthy();

    await act(async () => {
      fireEvent.change(searchBox, { target: { value: '新聞A' } });
    });
    expect(screen.getByText('上游市場新聞A')).toBeTruthy();
    expect(screen.queryByText('上游市場新聞B')).toBeNull();
  });

  it('media filter on the US tab only affects US news, using the un-capped-looking news feed as before', async () => {
    await renderAppSettled();
    await switchTab('上游市場');

    await act(async () => {
      fireEvent.change(screen.getByLabelText('依媒體篩選'), { target: { value: '媒體B' } });
    });
    expect(screen.queryByText('上游市場新聞A')).toBeNull();
    expect(screen.getByText('上游市場新聞B')).toBeTruthy();
  });
});

describe('App — PR 分頁只出現一個篩選工具列', () => {
  it('does not render the outer App-level toolbar on the PR tab (only PRTab\'s own)', async () => {
    await renderAppSettled();
    await switchTab('PR 媒體戰情');

    // 整個 PR 分頁只能有一個「搜尋標題、內容、媒體或品牌…」輸入框
    // （PRTab 自己管理的工具列），不能是 App 外層工具列 + PRTab 工具列兩個。
    expect(screen.getAllByPlaceholderText('搜尋標題、內容、媒體或品牌…')).toHaveLength(1);
  });
});
