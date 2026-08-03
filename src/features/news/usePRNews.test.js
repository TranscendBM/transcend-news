import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';
import { StrictMode } from 'react';
import { usePRNews } from './usePRNews.js';

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
function nthWhereValue(i, field) {
  const [q] = callArgs(i);
  const w = q.constraints.find(c => c.__marker === 'where' && c.args[0] === field);
  return w?.args[2];
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

describe('usePRNews — 查詢範圍固定為「本月」', () => {
  it('queries cat == transcend AND pubDate >= this month start, ordered by pubDate desc', async () => {
    vi.setSystemTime(taipei(2026, 7, 20, 12, 0, 0));
    renderHook(() => usePRNews());
    await waitFor(() => expect(onSnapshot).toHaveBeenCalledTimes(1));

    expect(nthWhereValue(0, 'cat')).toBe('transcend');
    expect(nthWhereValue(0, 'pubDate')).toEqual(taipei(2026, 7, 1, 0, 0, 0));

    const [q] = callArgs(0);
    const whereConstraints = q.constraints.filter(c => c.__marker === 'where');
    const orderByConstraints = q.constraints.filter(c => c.__marker === 'orderBy');
    // 剛好兩個 where（cat、pubDate），不可以只有 cat（那樣又會變回讀
    // 整個 transcend 分類、沒有月份範圍限制的舊查詢）。
    expect(whereConstraints).toHaveLength(2);
    expect(orderByConstraints).toEqual([{ __marker: 'orderBy', args: ['pubDate', 'desc'] }]);
  });

  it('never falls back to a cat-only query (no date bound) under any circumstance', async () => {
    renderHook(() => usePRNews());
    await waitFor(() => expect(onSnapshot).toHaveBeenCalledTimes(1));
    for (const call of onSnapshot.mock.calls) {
      const [q] = call;
      const whereConstraints = q.constraints.filter(c => c.__marker === 'where');
      expect(whereConstraints.length).toBeGreaterThanOrEqual(2);
      expect(whereConstraints.some(c => c.args[0] === 'pubDate')).toBe(true);
    }
  });
});

describe('usePRNews — 狀態與資料', () => {
  it('starts in loading state and moves to ready once data arrives', async () => {
    const { result } = renderHook(() => usePRNews());
    expect(result.current.status).toBe('loading');

    await act(async () => {
      nthNext(0)(fakeSnapshot([fakeDoc('a1', { title: 'x', cat: 'transcend' })]));
    });

    expect(result.current.status).toBe('ready');
    expect(result.current.articles).toEqual([{ id: 'a1', title: 'x', cat: 'transcend' }]);
  });

  it('moves to error state (without silently showing zero) when the query fails, and does not fall back to a broader query', async () => {
    const { result } = renderHook(() => usePRNews());
    await waitFor(() => expect(onSnapshot).toHaveBeenCalledTimes(1));

    await act(async () => {
      nthError(0)(new Error('FAILED_PRECONDITION: The query requires an index'));
    });

    expect(result.current.status).toBe('error');
    // 失敗後不應該自動又打一次別的查詢（例如退回只查 cat 的版本）。
    expect(onSnapshot).toHaveBeenCalledTimes(1);
  });
});

describe('usePRNews — refresh() 可以重試失敗的查詢', () => {
  it('refresh() restarts the query after an error', async () => {
    const { result } = renderHook(() => usePRNews());
    await waitFor(() => expect(onSnapshot).toHaveBeenCalledTimes(1));

    await act(async () => { nthError(0)(new Error('down')); });
    expect(result.current.status).toBe('error');

    act(() => { result.current.refresh(); });
    await waitFor(() => expect(onSnapshot).toHaveBeenCalledTimes(2));
    expect(result.current.status).toBe('loading');

    await act(async () => {
      nthNext(1)(fakeSnapshot([fakeDoc('a1', { title: 'x', cat: 'transcend' })]));
    });
    expect(result.current.status).toBe('ready');
    expect(result.current.articles).toHaveLength(1);
  });

  it('refresh() while already subscribed tears down the old listener before creating a new one (no duplicate active listeners)', async () => {
    renderHook(() => usePRNews());
    await waitFor(() => expect(onSnapshot).toHaveBeenCalledTimes(1));

    const { result } = renderHook(() => usePRNews());
    await waitFor(() => expect(onSnapshot).toHaveBeenCalledTimes(2));

    const unsubCountBefore = unsubSpy.mock.calls.length;
    act(() => { result.current.refresh(); });

    // refresh 呼叫當下就同步 teardown+start（onSnapshot 本身是同步呼叫），
    // 不會有兩個訂閱同時活著的空窗。
    expect(unsubSpy.mock.calls.length).toBe(unsubCountBefore + 1);
    expect(onSnapshot).toHaveBeenCalledTimes(3);
  });
});

describe('usePRNews — 跨月後重新建立查詢', () => {
  it('tears down the old listener and subscribes with the new month start after crossing into a new Taipei month', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(taipei(2026, 7, 31, 23, 59, 0));

    renderHook(() => usePRNews());
    expect(onSnapshot).toHaveBeenCalledTimes(1);
    expect(nthWhereValue(0, 'pubDate')).toEqual(taipei(2026, 7, 1, 0, 0, 0));

    // 推進到 8/1 00:00（跨月）後，再推進到下一次 60 秒檢查點。
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2 * 60 * 1000);
    });

    expect(unsubSpy).toHaveBeenCalledTimes(1); // 舊監聽器已取消
    expect(onSnapshot).toHaveBeenCalledTimes(2); // 用新月份重新訂閱
    expect(nthWhereValue(1, 'pubDate')).toEqual(taipei(2026, 8, 1, 0, 0, 0));
  });

  it('does not rebuild the query when still within the same Taipei month', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(taipei(2026, 7, 15, 12, 0, 0));

    renderHook(() => usePRNews());
    expect(onSnapshot).toHaveBeenCalledTimes(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(2 * 60 * 1000); // still 7 月
    });

    expect(onSnapshot).toHaveBeenCalledTimes(1);
    expect(unsubSpy).not.toHaveBeenCalled();
  });
});

describe('usePRNews — StrictMode 不產生重複查詢', () => {
  it('mount → cleanup → mount (StrictMode dev double-invoke) still ends with exactly one active listener', async () => {
    const { result, unmount } = renderHook(() => usePRNews(), { wrapper: StrictMode });

    // StrictMode 開發模式下，effect 會立刻「掛載→清理→再掛載」一次；
    // 兩次掛載各自呼叫一次 onSnapshot，各自的 cleanup 也各自 unsubscribe 一次，
    // 最終只留下最後一次掛載建立的監聽器仍在運作，不會同時有兩個訂閱疊加。
    await waitFor(() => expect(onSnapshot).toHaveBeenCalledTimes(2));
    expect(unsubSpy).toHaveBeenCalledTimes(1); // 第一次掛載的 cleanup 已呼叫一次

    await act(async () => {
      nthNext(1)(fakeSnapshot([fakeDoc('a1', { title: 'x', cat: 'transcend' })]));
    });
    expect(result.current.articles).toHaveLength(1);

    unmount();
    expect(unsubSpy).toHaveBeenCalledTimes(2); // 第二次（真正留下來那個）掛載的 cleanup
  });
});

describe('usePRNews — unmount 後不再 setState', () => {
  it('does not update state after unmount even if a snapshot event arrives late', async () => {
    const { result, unmount } = renderHook(() => usePRNews());
    await waitFor(() => expect(onSnapshot).toHaveBeenCalledTimes(1));

    const capturedNext = nthNext(0);
    unmount();

    // 元件卸載後，監聽器的 callback 理論上不該再被觸發（真正的 Firestore
    // SDK 在 unsubscribe 後不會再呼叫），但即使某個排隊中的事件在
    // unsubscribe 生效前就已經觸發，也不能造成卸載後的 setState。
    act(() => {
      capturedNext(fakeSnapshot([fakeDoc('late', { title: '太晚了', cat: 'transcend' })]));
    });

    expect(result.current.articles).toEqual([]);
    expect(result.current.status).toBe('loading');
  });
});
