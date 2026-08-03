import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';
import { StrictMode } from 'react';
import { usePRNews } from './usePRNews.js';

let onSnapshotNext = null;
let onSnapshotError = null;
const unsubSpy = vi.fn();

const onSnapshot = vi.fn((q, onNext, onError) => {
  onSnapshotNext = onNext;
  onSnapshotError = onError;
  return unsubSpy;
});

let lastQueryArgs = null;

vi.mock('../../services/firebase.js', () => ({
  getDb: () => ({ __fake: 'db' }),
  collection: (db, name) => ({ __marker: 'collection', name }),
  where: (...args) => ({ __marker: 'where', args }),
  query: (...constraints) => {
    lastQueryArgs = constraints;
    return { __marker: 'query', constraints };
  },
  onSnapshot: (...args) => onSnapshot(...args),
}));

function fakeDoc(id, data) {
  return { id, data: () => data };
}

function fakeSnapshot(docs) {
  return { docs };
}

beforeEach(() => {
  onSnapshotNext = null;
  onSnapshotError = null;
  lastQueryArgs = null;
  unsubSpy.mockClear();
  onSnapshot.mockClear();
});

describe('usePRNews — 查詢範圍', () => {
  it('queries only cat == transcend, nothing else', async () => {
    renderHook(() => usePRNews());
    await waitFor(() => expect(onSnapshot).toHaveBeenCalledTimes(1));

    const whereConstraints = lastQueryArgs.filter(c => c.__marker === 'where');
    expect(whereConstraints).toHaveLength(1);
    expect(whereConstraints[0].args).toEqual(['cat', '==', 'transcend']);
    // 沒有 orderBy/limit 之類的其他 constraint（只有 collection ref 本身
    // 加上這一個 where），避免產生需要額外部署 composite index 的查詢。
    expect(lastQueryArgs.some(c => c.__marker === 'orderBy' || c.__marker === 'limit')).toBe(false);
  });
});

describe('usePRNews — 狀態與資料', () => {
  it('starts in loading state and moves to ready once data arrives', async () => {
    const { result } = renderHook(() => usePRNews());
    expect(result.current.status).toBe('loading');

    await act(async () => {
      onSnapshotNext(fakeSnapshot([fakeDoc('a1', { title: 'x', cat: 'transcend' })]));
    });

    expect(result.current.status).toBe('ready');
    expect(result.current.articles).toEqual([{ id: 'a1', title: 'x', cat: 'transcend' }]);
  });

  it('moves to error state (without silently showing zero) when the query fails', async () => {
    renderHook(() => usePRNews());
    await waitFor(() => expect(onSnapshot).toHaveBeenCalledTimes(1));

    const { result } = renderHook(() => usePRNews());
    await waitFor(() => expect(onSnapshot).toHaveBeenCalledTimes(2));

    await act(async () => {
      // 觸發第二個 hook 實例（本次渲染建立的那個）的錯誤 callback
      onSnapshotError(new Error('permission denied'));
    });

    expect(result.current.status).toBe('error');
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
      onSnapshotNext(fakeSnapshot([fakeDoc('a1', { title: 'x', cat: 'transcend' })]));
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

    const capturedNext = onSnapshotNext;
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
