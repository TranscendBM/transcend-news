import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';

const { getDoc, getDocs } = vi.hoisted(() => ({ getDoc: vi.fn(), getDocs: vi.fn() }));

vi.mock('../../services/firebase.js', () => ({
  getDb: () => ({ __fake: 'db' }),
  collection: (db, name) => ({ __collection: name }),
  doc: (db, coll, id) => ({ __doc: `${coll}/${id}` }),
  query: (...args) => ({ __query: args }),
  orderBy: () => ({ __orderBy: true }),
  limit: () => ({ __limit: true }),
  getDoc,
  getDocs,
}));

import { HealthTab } from './HealthTab.jsx';

function ts(date) {
  return { toDate: () => date };
}

function setupMocks({ jobStatus = {}, stocks = null, daily = null, revenue = null, latestNews = null } = {}) {
  getDoc.mockImplementation(async (ref) => {
    if (ref.__doc === 'stocks/latest') return { exists: () => !!stocks, data: () => stocks };
    if (ref.__doc === 'daily/2451') return { exists: () => !!daily, data: () => daily };
    if (ref.__doc === 'revenue/2451') return { exists: () => !!revenue, data: () => revenue };
    return { exists: () => false, data: () => null };
  });
  getDocs.mockImplementation(async (ref) => {
    if (ref.__collection === 'job_status') {
      return { forEach: cb => Object.entries(jobStatus).forEach(([id, data]) => cb({ id, data: () => data })) };
    }
    // news 的最新一篇查詢
    return { docs: latestNews ? [{ data: () => ({ fetchedAt: latestNews }) }] : [] };
  });
}

beforeEach(() => {
  getDoc.mockReset();
  getDocs.mockReset();
});

describe('HealthTab — 排程狀態', () => {
  it('shows a green OK badge for a job with a recent success and no error', async () => {
    setupMocks({ jobStatus: {
      news: { lastSuccessAt: ts(new Date(Date.now() - 5 * 60 * 1000)), lastError: null },
    } });
    render(<HealthTab />);

    const row = (await screen.findByText('RSS 新聞')).closest('div.border-b');
    expect(within(row).getByText(/正常/)).toBeTruthy();
  });

  it('shows a red error badge with the error message when lastError is set', async () => {
    setupMocks({ jobStatus: {
      finance: { lastSuccessAt: null, lastError: 'FinMind HTTP 402', lastErrorAt: ts(new Date()) },
    } });
    render(<HealthTab />);

    const row = (await screen.findByText(/財務資料/)).closest('div.border-b');
    expect(within(row).getByText(/執行失敗/)).toBeTruthy();
    expect(within(row).getByText(/FinMind HTTP 402/)).toBeTruthy();
  });

  it('shows a stale badge when a job has never recorded a success', async () => {
    setupMocks({ jobStatus: {} });
    render(<HealthTab />);

    const row = (await screen.findByText('新聞保存期限清理')).closest('div.border-b');
    expect(within(row).getByText(/過期/)).toBeTruthy();
    expect(within(row).getByText(/從未/)).toBeTruthy();
  });

  it('flags stocks as warm-warning when the freshest tracked stock is more than 30 minutes old', async () => {
    setupMocks({
      jobStatus: { stocks: { lastSuccessAt: ts(new Date()), lastError: null } },
      stocks: { '2451': { price: 300, updatedAt: ts(new Date(Date.now() - 60 * 60 * 1000)) } },
    });
    render(<HealthTab />);

    const row = (await screen.findByText('即時股價')).closest('div.border-b');
    expect(within(row).getByText(/最新一檔股價也是/)).toBeTruthy();
  });

  it('does not flag stocks freshness when the data was updated moments ago', async () => {
    setupMocks({
      jobStatus: { stocks: { lastSuccessAt: ts(new Date()), lastError: null } },
      stocks: { '2451': { price: 300, updatedAt: ts(new Date()) } },
    });
    render(<HealthTab />);

    const row = (await screen.findByText('即時股價')).closest('div.border-b');
    expect(within(row).getByText(/最新股價/)).toBeTruthy();
  });
});

describe('HealthTab — 本機 AI Worker', () => {
  it('warns when there is a backlog but no recent insight (worker likely not running)', async () => {
    setupMocks({ jobStatus: {
      ai_worker: { pendingCount: 4264, lastInsightAt: ts(new Date('2026-08-04')) },
    } });
    render(<HealthTab />);

    const row = (await screen.findByText(/本機 AI Worker/)).closest('div.border-b');
    expect(within(row).getByText(/4264 筆/)).toBeTruthy();
    expect(within(row).getByText(/可能沒有在執行/)).toBeTruthy();
  });

  it('does not warn when the backlog is actively being worked through', async () => {
    setupMocks({ jobStatus: {
      ai_worker: { pendingCount: 12, lastInsightAt: ts(new Date(Date.now() - 10 * 60 * 1000)) },
    } });
    render(<HealthTab />);

    const row = (await screen.findByText(/本機 AI Worker/)).closest('div.border-b');
    expect(within(row).queryByText(/可能沒有在執行/)).toBeNull();
  });
});

describe('HealthTab — 重新檢查', () => {
  it('re-fetches all data when the refresh button is clicked', async () => {
    setupMocks({ jobStatus: { news: { lastSuccessAt: ts(new Date()), lastError: null } } });
    render(<HealthTab />);
    await screen.findByText('RSS 新聞');

    const callsBefore = getDocs.mock.calls.length;
    fireEvent.click(screen.getByText(/重新檢查/));
    await screen.findByText('RSS 新聞');
    expect(getDocs.mock.calls.length).toBeGreaterThan(callsBefore);
  });
});

describe('HealthTab — 整體狀態與分組', () => {
  const okJob = () => ({ lastSuccessAt: ts(new Date(Date.now() - 5 * 60 * 1000)), lastError: null });

  it('有執行失敗的排程：整體顯示「異常」，失敗的排在「需要處理」最前面，正常的在「運作正常」', async () => {
    setupMocks({ jobStatus: {
      news: okJob(),
      finance: { lastSuccessAt: null, lastError: 'FinMind HTTP 402', lastErrorAt: ts(new Date()) },
    } });
    render(<HealthTab />);
    expect(await screen.findByText(/異常：有排程執行失敗/)).toBeTruthy();
    const attention = screen.getByRole('region', { name: /需要處理/ });
    const first = within(attention).getAllByText(/./, { selector: 'p.text-sm' })[0];
    expect(first.textContent).toContain('財務資料');            // 失敗的排最前面
    expect(within(screen.getByRole('region', { name: /運作正常/ })).getByText('RSS 新聞')).toBeTruthy();
  });

  it('全部正常：整體顯示「整體正常」，沒有「需要處理」區塊', async () => {
    const fresh = okJob();
    setupMocks({
      jobStatus: { stocks: fresh, news: fresh, trading: fresh, finance: fresh, press_release_sync: fresh, topic_cluster: fresh, news_cleanup: fresh,
        ai_worker: { pendingCount: 0, lastInsightAt: ts(new Date()) } },
      stocks: { '2451': { price: 300, updatedAt: ts(new Date()) } },
      daily: { updatedAt: ts(new Date()) }, revenue: { updatedAt: ts(new Date()) }, latestNews: ts(new Date()),
    });
    render(<HealthTab />);
    expect(await screen.findByText('整體正常')).toBeTruthy();
    expect(screen.queryByRole('region', { name: /需要處理/ })).toBeNull();
  });

  it('技術細節預設收合，展開後才顯示函式名稱（aria-expanded）；已停止的每日摘要信排程不再列出', async () => {
    setupMocks({ jobStatus: { news: okJob() } });
    render(<HealthTab />);
    await screen.findByText('RSS 新聞');
    expect(screen.queryByText(/news_job/)).toBeNull();
    fireEvent.click(within(screen.getByText('RSS 新聞').closest('div.border-b')).getByRole('button', { name: /技術細節/ }));
    expect(screen.getByText(/news_job/)).toBeTruthy();
    expect(screen.queryByText(/DRAM\/Flash 產業摘要信/)).toBeNull();
  });
});
