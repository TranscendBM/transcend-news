import { describe, it, expect } from 'vitest';
import {
  fmtDate, sortByDate, isStockStale, stockUpdatedAtMs,
  taipeiDayStart, taipeiWeekStart, taipeiMonthStart,
} from './dates.js';

// 建構「台灣時間 y-m-d h:mi:s」對應的實際時刻（不依賴測試環境本身的時區）：
// 台灣沒有 DST，固定 UTC+8，所以台灣的實際時刻 = 同樣數字當作 UTC 讀取後
// 再減 8 小時。跟 dates.js 內 taipeiInstant() 用的是同一個換算方式，
// 用來在測試裡明確指定「台灣掛鐘時間是幾點」，不受 sandbox 時區影響。
function taipei(year, month, date, hour = 0, minute = 0, second = 0) {
  return new Date(Date.UTC(year, month, date, hour, minute, second) - 8 * 60 * 60 * 1000);
}

describe('fmtDate', () => {
  it('formats a Date as M/D', () => {
    expect(fmtDate(new Date(2026, 6, 20))).toBe('7/20');
  });

  it('returns empty string for falsy input', () => {
    expect(fmtDate(null)).toBe('');
    expect(fmtDate(undefined)).toBe('');
  });

  it('unwraps a Firestore-Timestamp-like object via toDate()', () => {
    const fake = { toDate: () => new Date(2026, 0, 5) };
    expect(fmtDate(fake)).toBe('1/5');
  });
});

describe('sortByDate', () => {
  it('sorts newest first', () => {
    const arr = [
      { id: 'old', pubDate: new Date('2026-01-01') },
      { id: 'new', pubDate: new Date('2026-06-01') },
    ];
    expect(sortByDate(arr).map(a => a.id)).toEqual(['new', 'old']);
  });

  it('does not mutate the input array', () => {
    const arr = [{ id: 'a', pubDate: new Date('2026-01-01') }, { id: 'b', pubDate: new Date('2026-06-01') }];
    const copy = [...arr];
    sortByDate(arr);
    expect(arr).toEqual(copy);
  });
});

describe('stockUpdatedAtMs / isStockStale', () => {
  it('treats missing updatedAt as stale', () => {
    expect(isStockStale({})).toBe(true);
  });

  it('reads Firestore Timestamp-like {seconds} shape', () => {
    const ms = stockUpdatedAtMs({ updatedAt: { seconds: 1700000000 } });
    expect(ms).toBe(1700000000 * 1000);
  });
});

describe('taipeiDayStart', () => {
  it("returns today's midnight in Taipei time", () => {
    const now = taipei(2026, 6, 20, 23, 59, 0); // 7/20 23:59 台灣時間
    expect(taipeiDayStart(now)).toEqual(taipei(2026, 6, 20, 0, 0, 0));
  });

  it('rolls over to the next day right at Taipei midnight', () => {
    const justBefore = taipei(2026, 6, 20, 23, 59, 59);
    const justAfter = taipei(2026, 6, 21, 0, 0, 0);
    expect(taipeiDayStart(justBefore)).toEqual(taipei(2026, 6, 20, 0, 0, 0));
    expect(taipeiDayStart(justAfter)).toEqual(taipei(2026, 6, 21, 0, 0, 0));
  });

  it('uses Taipei wall-clock time, not the UTC calendar date', () => {
    // UTC 2026-07-31 16:30 = 台灣時間 2026-08-01 00:30——已經跨進 8/1，
    // 若沒有正確加上 +8 小時位移，會誤判成 7/31。
    const nowUtc = new Date(Date.UTC(2026, 6, 31, 16, 30, 0));
    expect(taipeiDayStart(nowUtc)).toEqual(taipei(2026, 7, 1, 0, 0, 0));
  });
});

describe('taipeiWeekStart', () => {
  it('starts on Monday, not "the last 7 days"', () => {
    // 2026-08-03 是台灣時間的週一
    const wednesday = taipei(2026, 7, 5, 10, 0, 0); // 8/5 週三
    expect(taipeiWeekStart(wednesday)).toEqual(taipei(2026, 7, 3, 0, 0, 0));
  });

  it('treats Sunday as the last day of the current week (not the start of a new one)', () => {
    const sunday = taipei(2026, 7, 9, 23, 0, 0); // 8/9 週日
    expect(taipeiWeekStart(sunday)).toEqual(taipei(2026, 7, 3, 0, 0, 0)); // 仍是本週一 8/3
  });

  it('is itself the start when now is already Monday midnight', () => {
    const mondayMidnight = taipei(2026, 7, 3, 0, 0, 0);
    expect(taipeiWeekStart(mondayMidnight)).toEqual(taipei(2026, 7, 3, 0, 0, 0));
  });

  it('updates after crossing into a new week', () => {
    const sundayNight = taipei(2026, 7, 9, 23, 59, 59); // 上週日快結束
    const mondayStart = taipei(2026, 7, 10, 0, 0, 0);   // 新的一週開始（週一）
    expect(taipeiWeekStart(sundayNight)).toEqual(taipei(2026, 7, 3, 0, 0, 0));
    expect(taipeiWeekStart(mondayStart)).toEqual(taipei(2026, 7, 10, 0, 0, 0));
  });
});

describe('taipeiMonthStart', () => {
  it("returns this month's first day at midnight in Taipei time", () => {
    const now = taipei(2026, 7, 20, 10, 0, 0);
    expect(taipeiMonthStart(now)).toEqual(taipei(2026, 7, 1, 0, 0, 0));
  });

  it('rolls over to the new month right at Taipei midnight', () => {
    const justBefore = taipei(2026, 6, 30, 23, 59, 59);
    const justAfter = taipei(2026, 7, 1, 0, 0, 0);
    expect(taipeiMonthStart(justBefore)).toEqual(taipei(2026, 6, 1, 0, 0, 0));
    expect(taipeiMonthStart(justAfter)).toEqual(taipei(2026, 7, 1, 0, 0, 0));
  });

  it('uses Taipei wall-clock time, not the UTC calendar date, at the month boundary', () => {
    const nowUtc = new Date(Date.UTC(2026, 6, 31, 16, 30, 0)); // 台灣時間已是 8/1 00:30
    expect(taipeiMonthStart(nowUtc)).toEqual(taipei(2026, 7, 1, 0, 0, 0));
  });
});
