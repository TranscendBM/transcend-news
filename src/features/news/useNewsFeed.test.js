import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';
import { useNewsFeed } from './useNewsFeed.js';

// query/collection/where/orderBy/limit/startAfter 只需要是可辨識的 marker，
// 真正的過濾/排序在真實 Firestore 伺服器端完成，這裡的假 db 層只需要
// 忠實回放測試安排好的文件、並讓測試能檢查呼叫參數（例如 limit 用了多少）。
let onSnapshotNext = null;
let onSnapshotError = null;
const unsubSpy = vi.fn();

const getDocsFromCache = vi.fn();
const getDocsFromServer = vi.fn();
const onSnapshot = vi.fn((q, onNext, onError) => {
  onSnapshotNext = onNext;
  onSnapshotError = onError;
  return unsubSpy;
});

vi.mock('../../services/firebase.js', () => ({
  getDb: () => ({ __fake: 'db' }),
  collection: () => ({ __marker: 'collection' }),
  query: (...constraints) => ({ __marker: 'query', constraints }),
  where: (...args) => ({ __marker: 'where', args }),
  orderBy: (...args) => ({ __marker: 'orderBy', args }),
  limit: (n) => ({ __marker: 'limit', n }),
  startAfter: (cursor) => ({ __marker: 'startAfter', cursor }),
  onSnapshot: (...args) => onSnapshot(...args),
  getDocsFromCache: (...args) => getDocsFromCache(...args),
  getDocsFromServer: (...args) => getDocsFromServer(...args),
}));

function fakeDoc(id, data) {
  return { id, data: () => data };
}

function fakeSnapshot({ docs = [], fromCache = false }) {
  return {
    metadata: { fromCache },
    empty: docs.length === 0,
    size: docs.length,
    docs,
    docChanges: () => docs.map(doc => ({ type: 'added', doc })),
  };
}

function findLimitArg(mockCall) {
  const [q] = mockCall;
  const found = q.constraints.find(c => c.__marker === 'limit');
  return found?.n;
}

beforeEach(() => {
  onSnapshotNext = null;
  onSnapshotError = null;
  unsubSpy.mockClear();
  getDocsFromCache.mockReset();
  getDocsFromServer.mockReset();
  onSnapshot.mockClear();
  // 預設：快取為空（首次造訪），rest 補抓也不主動觸發，除非測試另外安排。
  getDocsFromCache.mockResolvedValue({ empty: true, size: 0, docs: [] });
});

afterEach(() => {
  vi.useRealTimers();
});

describe('useNewsFeed — 快取不完整時繼續補抓', () => {
  it('fetches the remaining docs via cursor when the live snapshot is not yet complete', async () => {
    getDocsFromServer.mockResolvedValue({
      docs: [fakeDoc('old-1', { title: '舊聞', pubDate: new Date('2026-01-02') })],
    });

    const { result } = renderHook(() => useNewsFeed());

    await waitFor(() => expect(onSnapshot).toHaveBeenCalledTimes(1));

    // 模擬「最新 300 則」監聽觸發，且不是來自快取（server 有回應）：
    // 資料尚不完整（未達 fullLoaded），應觸發 cursor 補抓。
    await act(async () => {
      onSnapshotNext(fakeSnapshot({
        fromCache: false,
        docs: [fakeDoc('live-1', { title: '最新新聞', pubDate: new Date('2026-01-03') })],
      }));
    });

    await waitFor(() => expect(getDocsFromServer).toHaveBeenCalledTimes(1));
    // 補抓上限應為 1700（300 + 1700 = 2000）
    expect(findLimitArg(getDocsFromServer.mock.calls[0])).toBe(1700);

    await waitFor(() => expect(result.current.news.length).toBe(2));
  });

  it('does not issue a rest-fetch when the cache already loaded the full 2000-doc window', async () => {
    const cachedDocs = Array.from({ length: 2000 }, (_, i) => fakeDoc(`c${i}`, { title: `t${i}`, pubDate: new Date() }));
    getDocsFromCache.mockResolvedValue({ empty: false, size: 2000, docs: cachedDocs });

    renderHook(() => useNewsFeed());
    await waitFor(() => expect(onSnapshot).toHaveBeenCalledTimes(1));

    await act(async () => {
      onSnapshotNext(fakeSnapshot({ fromCache: false, docs: [fakeDoc('c0', { title: 't0', pubDate: new Date() })] }));
    });

    // 讓任何可能的微任務跑完
    await act(async () => { await Promise.resolve(); });
    expect(getDocsFromServer).not.toHaveBeenCalled();
  });
});

describe('useNewsFeed — 補抓失敗後可以重試', () => {
  it('retries the rest-fetch with backoff after a failure, and stops after success', async () => {
    vi.useFakeTimers();
    getDocsFromServer
      .mockRejectedValueOnce(new Error('network down'))
      .mockResolvedValueOnce({ docs: [fakeDoc('rest-1', { title: '補抓成功', pubDate: new Date() })] });

    renderHook(() => useNewsFeed());
    await vi.waitFor(() => expect(onSnapshot).toHaveBeenCalledTimes(1));

    await act(async () => {
      onSnapshotNext(fakeSnapshot({ fromCache: false, docs: [fakeDoc('live-1', { title: '最新', pubDate: new Date() })] }));
      await Promise.resolve();
    });
    expect(getDocsFromServer).toHaveBeenCalledTimes(1);

    // 第一次重試延遲為 5000 * 1ms
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000);
    });
    expect(getDocsFromServer).toHaveBeenCalledTimes(2);

    // 第二次成功，之後不應再排程重試
    await act(async () => {
      await vi.advanceTimersByTimeAsync(20000);
    });
    expect(getDocsFromServer).toHaveBeenCalledTimes(2);
  });

  it('gives up after MAX_AUTO_RETRIES consecutive failures without throwing', async () => {
    vi.useFakeTimers();
    getDocsFromServer.mockRejectedValue(new Error('always down'));

    renderHook(() => useNewsFeed());
    await vi.waitFor(() => expect(onSnapshot).toHaveBeenCalledTimes(1));

    await act(async () => {
      onSnapshotNext(fakeSnapshot({ fromCache: false, docs: [fakeDoc('live-1', { title: '最新', pubDate: new Date() })] }));
      await Promise.resolve();
    });
    expect(getDocsFromServer).toHaveBeenCalledTimes(1);

    await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
    expect(getDocsFromServer).toHaveBeenCalledTimes(2);

    await act(async () => { await vi.advanceTimersByTimeAsync(10000); });
    expect(getDocsFromServer).toHaveBeenCalledTimes(3);

    // MAX_AUTO_RETRIES = 2 已用盡，不會再排程下一次重試
    await act(async () => { await vi.advanceTimersByTimeAsync(60000); });
    expect(getDocsFromServer).toHaveBeenCalledTimes(3);
  });
});

describe('useNewsFeed — 多次 callback 不發出重複查詢', () => {
  it('does not start a second rest-fetch while one is already in flight', async () => {
    let resolveRest;
    getDocsFromServer.mockReturnValue(new Promise(resolve => { resolveRest = resolve; }));

    renderHook(() => useNewsFeed());
    await waitFor(() => expect(onSnapshot).toHaveBeenCalledTimes(1));

    // 連續兩次 snapshot 事件（模擬 onSnapshot 短時間內觸發多次），
    // 第一次補抓還在進行中（restLoading=true）時，第二次不應再發起新查詢。
    await act(async () => {
      onSnapshotNext(fakeSnapshot({ fromCache: false, docs: [fakeDoc('live-1', { title: 'A', pubDate: new Date() })] }));
      await Promise.resolve();
      onSnapshotNext(fakeSnapshot({ fromCache: false, docs: [fakeDoc('live-1', { title: 'A', pubDate: new Date() }), fakeDoc('live-2', { title: 'B', pubDate: new Date() })] }));
      await Promise.resolve();
    });

    expect(getDocsFromServer).toHaveBeenCalledTimes(1);

    await act(async () => { resolveRest({ docs: [] }); await Promise.resolve(); });
  });

  it('refresh() only retries the pending rest-fetch once a listener is already established (no new listener)', async () => {
    getDocsFromServer.mockResolvedValue({ docs: [] });
    const { result } = renderHook(() => useNewsFeed());
    await waitFor(() => expect(onSnapshot).toHaveBeenCalledTimes(1));

    await act(async () => { await result.current.refresh(); });

    // 已經有監聽器時，refresh() 不應該重新建立第二個 onSnapshot 監聽
    expect(onSnapshot).toHaveBeenCalledTimes(1);
  });
});

describe('useNewsFeed — 清理與錯誤處理', () => {
  it('unsubscribes the listener on unmount', async () => {
    const { unmount } = renderHook(() => useNewsFeed());
    await waitFor(() => expect(onSnapshot).toHaveBeenCalledTimes(1));
    unmount();
    expect(unsubSpy).toHaveBeenCalledTimes(1);
  });

  it('calls onFirstPublish exactly once on first data arrival', async () => {
    const onFirstPublish = vi.fn();
    getDocsFromCache.mockResolvedValue({
      empty: false, size: 1,
      docs: [fakeDoc('c1', { title: '快取新聞', pubDate: new Date() })],
    });
    renderHook(() => useNewsFeed({ onFirstPublish }));
    await waitFor(() => expect(onFirstPublish).toHaveBeenCalledTimes(1));

    await act(async () => {
      onSnapshotNext(fakeSnapshot({ fromCache: true, docs: [] }));
    });
    expect(onFirstPublish).toHaveBeenCalledTimes(1);
  });

  it('resets listener state after a permanent listener error so a later refresh can rebuild it', async () => {
    getDocsFromServer.mockResolvedValue({ docs: [] });
    const { result } = renderHook(() => useNewsFeed());
    await waitFor(() => expect(onSnapshot).toHaveBeenCalledTimes(1));

    await act(async () => { onSnapshotError(new Error('listen closed')); });

    await act(async () => { await result.current.refresh(); });
    // 監聽器已被清空狀態，refresh() 應該重新走一次完整初始化流程 → 建立第二個監聽
    expect(onSnapshot).toHaveBeenCalledTimes(2);
  });
});
