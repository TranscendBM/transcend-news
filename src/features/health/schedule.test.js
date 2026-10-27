import { describe, it, expect } from 'vitest';

import { fmtNextRun, nextRun } from './schedule.js';

// 台北時間 → Date（UTC+8）
const tw = (y, mo, d, h, mi) => new Date(Date.UTC(y, mo - 1, d, h - 8, mi));

describe('nextRun（排程下一次預計執行時間）', () => {
  it('每 15 分鐘：下一個整刻', () => {
    const now = tw(2026, 10, 27, 11, 52);
    expect(nextRun({ every: 15 }, now).getTime()).toBe(tw(2026, 10, 27, 12, 0).getTime());
  });

  it('每天固定時間：已過就是明天', () => {
    expect(nextRun({ daily: [[17, 30]] }, tw(2026, 10, 27, 10, 0)).getTime()).toBe(tw(2026, 10, 27, 17, 30).getTime());
    expect(nextRun({ daily: [[17, 30]] }, tw(2026, 10, 27, 18, 0)).getTime()).toBe(tw(2026, 10, 28, 17, 30).getTime());
  });

  it('只在平日：週五過了時間，下一次是下週一', () => {
    const fri = tw(2026, 10, 30, 18, 0);                 // 2026-10-30 是週五
    expect(nextRun({ daily: [[13, 40], [17, 40]], weekdays: true }, fri).getTime()).toBe(tw(2026, 11, 2, 13, 40).getTime());
  });

  it('交易時段內每分鐘：約 1 分鐘後；收盤後是下一個交易日開盤', () => {
    const spec = { window: [[9, 0], [13, 35]], weekdays: true };
    const open = tw(2026, 10, 27, 10, 30);
    expect(nextRun(spec, open).getTime() - open.getTime()).toBe(60000);
    expect(nextRun(spec, tw(2026, 10, 27, 14, 0)).getTime()).toBe(tw(2026, 10, 28, 9, 0).getTime());
  });
});

describe('fmtNextRun', () => {
  const now = tw(2026, 10, 27, 12, 0);
  it('分鐘、今天、明天、星期', () => {
    expect(fmtNextRun(tw(2026, 10, 27, 12, 0), now)).toBe('約 1 分鐘內');
    expect(fmtNextRun(tw(2026, 10, 27, 12, 30), now)).toBe('約 30 分鐘後');
    expect(fmtNextRun(tw(2026, 10, 27, 17, 30), now)).toBe('今天 17:30');
    expect(fmtNextRun(tw(2026, 10, 28, 2, 30), now)).toBe('明天 02:30');
    expect(fmtNextRun(tw(2026, 10, 30, 9, 0), now)).toBe('週五 09:00');
    expect(fmtNextRun(null, now)).toBe('未知');
  });
});
