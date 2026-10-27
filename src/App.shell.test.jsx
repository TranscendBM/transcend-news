/* global URLSearchParams */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, within, act, waitFor } from '@testing-library/react';

// ── 外殼（Header／第一層導覽／市場摘要）測試：Firestore 與資料 hook 換成替身，登記監聽器與 hook 掛載次數
const counts = vi.hoisted(() => ({ feed: 0, pr: 0, exposure: 0, upstream: 0, snapshot: 0, getDoc: 0 }));
vi.mock('./services/firebase.js', () => ({
  getDb: () => ({ __fake: 'db' }),
  doc: () => ({ __fake: 'docRef' }),
  collection: () => ({}),
  query: () => ({}),
  orderBy: () => ({}),
  limit: () => ({}),
  where: () => ({}),
  getDocs: async () => ({ forEach: () => {}, docs: [] }),
  onSnapshot: () => { counts.snapshot += 1; return () => {}; },
  getDoc: async () => { counts.getDoc += 1; return { exists: () => false }; },
}));
vi.mock('./features/news/useNewsFeed.js', async () => {
  const { useEffect } = await import('react');
  return { useNewsFeed: () => { useEffect(() => { counts.feed += 1; }, []); return { news: [], loading: false, refresh: vi.fn() }; } };
});
vi.mock('./features/news/usePRNews.js', async () => {
  const { useEffect } = await import('react');
  return { usePRNews: () => { useEffect(() => { counts.pr += 1; }, []); return { articles: [], status: 'ready', refresh: vi.fn() }; } };
});
vi.mock('./features/news/useUpstreamNews.js', async () => {
  const { useEffect } = await import('react');
  return { useUpstreamNews: () => { useEffect(() => { counts.upstream += 1; }, []); return { articles: [], status: 'ready', refresh: vi.fn() }; } };
});
vi.mock('./features/pr/useMediaExposure.js', async () => {
  const { useEffect } = await import('react');
  return { useMediaExposure: () => { useEffect(() => { counts.exposure += 1; }, []); return { records: [], status: 'ready', refresh: vi.fn() }; } };
});

import App from './App.jsx';

const setUrl = search => window.history.replaceState(null, '', `/${search}`);
const params = () => Object.fromEntries(new URLSearchParams(window.location.search));
const nav = () => screen.getByRole('navigation', { name: '主要導覽' });

async function renderApp() {
  const utils = render(<App />);
  await act(async () => {});
  return utils;
}

beforeEach(() => { Object.keys(counts).forEach(k => { counts[k] = 0; }); });

describe('App 外殼 — 第一層導覽', () => {
  it('四個主分頁都在導覽裡（事件已整合進上游市場，不再有獨立的「事件中心」），目前頁有 aria-current', async () => {
    setUrl('?tab=ir');
    await renderApp();
    const names = within(nav()).getAllByRole('button').map(b => b.textContent.trim());
    expect(names).toEqual(['PR 媒體戰情', 'IR 投資情報', '上游市場', '系統健康']);
    expect(within(nav()).getByRole('button', { name: 'IR 投資情報' }).getAttribute('aria-current')).toBe('page');
    expect(within(nav()).getByRole('button', { name: 'PR 媒體戰情' }).getAttribute('aria-current')).toBeNull();
  });

  it('點擊切換主分頁並同步網址 ?tab=；瀏覽器上一頁回到前一個分頁', async () => {
    setUrl('?tab=pr');
    await renderApp();
    await act(async () => { fireEvent.click(within(nav()).getByRole('button', { name: 'IR 投資情報' })); });
    expect(params().tab).toBe('ir');
    await act(async () => { fireEvent.click(within(nav()).getByRole('button', { name: '系統健康' })); });
    expect(params().tab).toBe('health');
    await act(async () => { window.history.back(); });
    await waitFor(() => expect(params().tab).toBe('ir'));
    await waitFor(() => expect(within(nav()).getByRole('button', { name: 'IR 投資情報' }).getAttribute('aria-current')).toBe('page'));
  });

  it('既有 deep link（tab／section／filter）照常運作', async () => {
    setUrl('?tab=us&section=events&filter=upstream');
    await renderApp();
    expect((await screen.findByRole('tab', { name: '事件' })).getAttribute('aria-selected')).toBe('true');
    expect(params()).toEqual({ tab: 'us', section: 'events', filter: 'upstream' });
  });

  it('五個區域都能切換（PR、IR、上游市場、系統健康），上游市場內有事件子頁', async () => {
    setUrl('');
    await renderApp();
    for (const [label, tab] of [['IR 投資情報', 'ir'], ['上游市場', 'us'], ['系統健康', 'health'], ['PR 媒體戰情', 'pr']]) {
      await act(async () => { fireEvent.click(within(nav()).getByRole('button', { name: label })); });
      expect(params().tab === tab || (tab === 'pr' && !params().tab)).toBe(true);
    }
    await act(async () => { fireEvent.click(within(nav()).getByRole('button', { name: '上游市場' })); });
    expect(await screen.findByRole('tab', { name: '事件' })).toBeTruthy();
  });
});

describe('App 外殼 — Header', () => {
  it('固定保留：網站連線狀態、最後更新時間、重新整理', async () => {
    await renderApp();
    expect(screen.getAllByText(/Firebase 已連線/).length).toBeGreaterThan(0);   // 桌機顯示文字、手機只給讀屏文字
    expect(screen.getByRole('button', { name: '重新整理' })).toBeTruthy();
    expect(await screen.findByText(/更新/, { selector: 'span' })).toBeTruthy();
  });

  it('按「重新整理」會重新讀取資料，但不新增 Firestore 監聽器或重新掛載資料 hook', async () => {
    await renderApp();
    const before = { ...counts };
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '重新整理' })); });
    expect(counts.getDoc).toBeGreaterThan(before.getDoc);
    expect(counts.snapshot).toBe(before.snapshot);
    for (const k of ['feed', 'pr', 'exposure', 'upstream']) expect(counts[k]).toBe(before[k]);
  });

  it('有「跳到主要內容」連結與主要內容區 landmark', async () => {
    await renderApp();
    expect(screen.getByRole('link', { name: '跳到主要內容' }).getAttribute('href')).toBe('#main-content');
    expect(document.getElementById('main-content').tagName).toBe('MAIN');
  });

  it('市場摘要預設收合，按鈕有 aria-expanded', async () => {
    await renderApp();
    expect(screen.getByRole('button', { name: /市場摘要/ }).getAttribute('aria-expanded')).toBe('false');
  });
});
