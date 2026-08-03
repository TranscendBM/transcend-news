import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';
import { StrictMode } from 'react';
import { useUpstreamNews } from './useUpstreamNews.js';

const unsubSpy = vi.fn();
const onSnapshot = vi.fn(() => unsubSpy);

vi.mock('../../services/firebase.js', () => ({
  getDb: () => ({ __fake: 'db' }),
  collection: (db, name) => ({ __marker: 'collection', name }),
  where: (...args) => ({ __marker: 'where', args }),
  orderBy: (...args) => ({ __marker: 'orderBy', args }),
  query: (...constraints) => ({ __marker: 'query', constraints }),
  onSnapshot: (...args) => onSnapshot(...args),
}));

function fakeDoc(id, data) {
  return { id, data: () => data };
}

function fakeSnapshot(docs) {
  return { docs };
}

// 依呼叫順序取出第 i 次 onSnapshot() 呼叫的 (query, onNext, onError)。
function callArgs(i) {
  return onSnapshot.mock.calls[i];
}
function nthNext(i) { return callArgs(i)[1]; }
function nthError(i) { return callArgs(i)[2]; }
function nthWhere(i, field) {
  const [q] = callArgs(i);
  return q.constraints.find(c => c.__marker === 'where' && c.args[0] === field);
}

// 建構「台灣時間 y-m-d h:mi:s」對應的實際時刻，不依賴測試環境本身的時區。
function taipei(year, month, day, hour = 0, minute = 0, second = 0) {
  return new Date(Date.UTC(year, month - 1, day, hour, minute, second) - 8 * 60 * 60 * 1000);
}

beforeEach(() => {
  unsubSpy.mockClear();
  onSnapshot.mockClear();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('useUpstreamNews — 查詢範圍固定為「本月」且 cat 為 usMarket/supplier', () => {
  it('queries cat in [usMarket, supplier] AND pubDate >= this month start, ordered by pubDate desc', async () => {
    vi.setSystemTime(taipei(2026, 7, 20, 12, 0, 0));
    renderHook(() => useUpstreamNews());
    await waitFor(() => expect(onSnapshot).toHaveBeenCalledTimes(1));

    const catWhere = nthWhere(0, 'cat');
    expect(catWhere.args[1]).toBe('in');
    expect(catWhere.args[2]).toEqual(['usMarket', 'supplier']);

    const pubDateWhere = nthWhere(0, 'pubDate');
    expect(pubDateWhere.args[1]).toBe('>=');
    expect(pubDateWhere.args[2]).toEqual(taipei(2026, 7, 1, 0, 0, 0));

    const [q] = callArgs(0);
    const whereConstraints = q.constraints.filter(c => c.__marker === 'where');
    const orderByConstraints = q.constraints.filter(c => c.__marker === 'orderBy');
    expect(whereConstraints).toHaveLength(2);
    expect(orderByConstraints).toEqual([{ __marker: 'orderBy', args: ['pubDate', 'desc'] }]);
  });

  it('never falls back to a cat-only query (no date bound) under any circumstance', async () => {
    renderHook(() => useUpstreamNews());
    await waitFor(() => expect(onSnapshot).toHaveBeenCalledTimes(1));
    for (const call of onSnapshot.mock.calls) {
      const [q] = call;
      const whereConstraints = q.constraints.filter(c => c.__marker === 'where');
      expect(whereConstraints.length).toBeGreaterThanOrEqual(2);
      expect(whereConstraints.some(c => c.args[0] === 'pubDate')).toBe(true);
    }
  });
});

describe('useUpstreamNews — 狀態與資料', () => {
  it('starts in loading state and moves to ready once data arrives', async () => {
    const { result } = renderHook(() => useUpstreamNews());
    expect(result.current.status).toBe('loading');

    await act(async () => {
      nthNext(0)(fakeSnapshot([fakeDoc('a1', { title: 'x', cat: 'usMarket' })]));
    });

    expect(result.current.status).toBe('ready');
    expect(result.current.articles).toEqual([{ id: 'a1', title: 'x', cat: 'usMarket' }]);
  });

  it('moves to error state (without silently showing zero) when the query fails, and does not fall back to a broader query', async () => {
    const { result } = renderHook(() => useUpstreamNews());
    await waitFor(() => expect(onSnapshot).toHaveBeenCalledTimes(1));

    await act(async () => {
      nthError(0)(new Error('FAILED_PRECONDITION: The query requires an index'));
    });

    expect(result.current.status).toBe('error');
    expect(onSnapshot).toHaveBeenCalledTimes(1);
  });
});

describe('useUpstreamNews — enabled 開關', () => {
  it('does not create a listener when enabled=false', async () => {
    renderHook(() => useUpstreamNews({ enabled: false }));
    // 給非同步流程一點時間，確認確實從未呼叫 onSnapshot。
    await act(async () => { await Promise.resolve(); });
    expect(onSnapshot).not.toHaveBeenCalled();
  });

  it('refresh() does not create a query while enabled=false', async () => {
    const { result } = renderHook(() => useUpstreamNews({ enabled: false }));
    act(() => { result.current.refresh(); });
    await act(async () => { await Promise.resolve(); });
    expect(onSnapshot).not.toHaveBeenCalled();
  });

  it('tears down the active listener as soon as enabled flips from true to false', async () => {
    const { rerender } = renderHook(({ enabled }) => useUpstreamNews({ enabled }), {
      initialProps: { enabled: true },
    });
    await waitFor(() => expect(onSnapshot).toHaveBeenCalledTimes(1));

    rerender({ enabled: false });
    expect(unsubSpy).toHaveBeenCalledTimes(1);
    expect(onSnapshot).toHaveBeenCalledTimes(1); // 沒有因此又建立新的查詢
  });

  it('creates exactly one listener when enabled flips from false to true', async () => {
    const { rerender } = renderHook(({ enabled }) => useUpstreamNews({ enabled }), {
      initialProps: { enabled: false },
    });
    await act(async () => { await Promise.resolve(); });
    expect(onSnapshot).not.toHaveBeenCalled();

    rerender({ enabled: true });
    await waitFor(() => expect(onSnapshot).toHaveBeenCalledTimes(1));
  });
});

describe('useUpstreamNews — refresh() 可以重試失敗的查詢', () => {
  it('refresh() restarts the query after an error', async () => {
    const { result } = renderHook(() => useUpstreamNews());
    await waitFor(() => expect(onSnapshot).toHaveBeenCalledTimes(1));

    await act(async () => { nthError(0)(new Error('down')); });
    expect(result.current.status).toBe('error');

    act(() => { result.current.refresh(); });
    await waitFor(() => expect(onSnapshot).toHaveBeenCalledTimes(2));
    expect(result.current.status).toBe('loading');

    await act(async () => {
      nthNext(1)(fakeSnapshot([fakeDoc('a1', { title: 'x', cat: 'usMarket' })]));
    });
    expect(result.current.status).toBe('ready');
    expect(result.current.articles).toHaveLength(1);
  });
});

describe('useUpstreamNews — 跨月後重新建立查詢', () => {
  it('tears down the old listener and subscribes with the new month start after crossing into a new Taipei month', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(taipei(2026, 7, 31, 23, 59, 0));

    renderHook(() => useUpstreamNews());
    expect(onSnapshot).toHaveBeenCalledTimes(1);
    expect(nthWhere(0, 'pubDate').args[2]).toEqual(taipei(2026, 7, 1, 0, 0, 0));

    await act(async () => {
      await vi.advanceTimersByTimeAsync(2 * 60 * 1000);
    });

    expect(unsubSpy).toHaveBeenCalledTimes(1);
    expect(onSnapshot).toHaveBeenCalledTimes(2);
    expect(nthWhere(1, 'pubDate').args[2]).toEqual(taipei(2026, 8, 1, 0, 0, 0));
  });

  it('does not rebuild the query when still within the same Taipei month', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(taipei(2026, 7, 15, 12, 0, 0));

    renderHook(() => useUpstreamNews());
    expect(onSnapshot).toHaveBeenCalledTimes(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(2 * 60 * 1000);
    });

    expect(onSnapshot).toHaveBeenCalledTimes(1);
    expect(unsubSpy).not.toHaveBeenCalled();
  });

  it('does not rebuild across the month boundary while disabled', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(taipei(2026, 7, 31, 23, 59, 0));

    renderHook(() => useUpstreamNews({ enabled: false }));
    expect(onSnapshot).not.toHaveBeenCalled();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(2 * 60 * 1000);
    });

    expect(onSnapshot).not.toHaveBeenCalled();
  });
});

describe('useUpstreamNews — StrictMode 不產生重複查詢', () => {
  it('mount → cleanup → mount (StrictMode dev double-invoke) still ends with exactly one active listener', async () => {
    const { result, unmount } = renderHook(() => useUpstreamNews(), { wrapper: StrictMode });

    await waitFor(() => expect(onSnapshot).toHaveBeenCalledTimes(2));
    expect(unsubSpy).toHaveBeenCalledTimes(1);

    await act(async () => {
      nthNext(1)(fakeSnapshot([fakeDoc('a1', { title: 'x', cat: 'usMarket' })]));
    });
    expect(result.current.articles).toHaveLength(1);

    unmount();
    expect(unsubSpy).toHaveBeenCalledTimes(2);
  });
});

describe('useUpstreamNews — unmount 後不再 setState', () => {
  it('does not update state after unmount even if a snapshot event arrives late', async () => {
    const { result, unmount } = renderHook(() => useUpstreamNews());
    await waitFor(() => expect(onSnapshot).toHaveBeenCalledTimes(1));

    const capturedNext = nthNext(0);
    unmount();

    act(() => {
      capturedNext(fakeSnapshot([fakeDoc('late', { title: '太晚了', cat: 'usMarket' })]));
    });

    expect(result.current.articles).toEqual([]);
    expect(result.current.status).toBe('loading');
  });

  it('cancels the pending month-check timer on unmount (no rebuild fires after unmount)', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(taipei(2026, 7, 31, 23, 59, 0));

    const { unmount } = renderHook(() => useUpstreamNews());
    expect(onSnapshot).toHaveBeenCalledTimes(1);
    unmount();
    expect(unsubSpy).toHaveBeenCalledTimes(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(5 * 60 * 1000); // 跨月時間點
    });

    // unmount 後 timer 已清除，不會再多觸發一次 teardown/start。
    expect(onSnapshot).toHaveBeenCalledTimes(1);
    expect(unsubSpy).toHaveBeenCalledTimes(1);
  });
});
