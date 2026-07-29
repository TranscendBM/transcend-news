import { describe, it, expect } from 'vitest';
import { fmtDate, sortByDate, isStockStale, stockUpdatedAtMs } from './dates.js';

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
