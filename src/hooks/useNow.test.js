import { describe, it, expect, vi, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useNow } from './useNow.js';

describe('useNow', () => {
  afterEach(() => { vi.useRealTimers(); });

  it('returns the current time at mount', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 6, 20, 12, 0, 0));
    const { result } = renderHook(() => useNow(60000));
    expect(result.current.getTime()).toBe(new Date(2026, 6, 20, 12, 0, 0).getTime());
  });

  it('updates after intervalMs elapses, reflecting the new current time', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 6, 20, 23, 59, 0));
    const { result } = renderHook(() => useNow(60000));

    // 推進剛好一個 interval（60 秒）——同時也是唯一讓假時鐘往前走的方式：
    // advanceTimersByTimeAsync 會把目前的假時間往前推進，並觸發期間到期的計時器。
    await act(async () => { await vi.advanceTimersByTimeAsync(60000); });

    expect(result.current.getTime()).toBe(new Date(2026, 6, 21, 0, 0, 0).getTime());
  });

  it('stops updating after unmount (interval cleared)', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 6, 20, 0, 0, 0));
    const { result, unmount } = renderHook(() => useNow(60000));
    unmount();

    await act(async () => { await vi.advanceTimersByTimeAsync(120000); });

    // 已 unmount，result.current 停在最後一次 render 的值，不會再更新
    expect(result.current.getTime()).toBe(new Date(2026, 6, 20, 0, 0, 0).getTime());
  });
});
