import { describe, it, expect, vi, beforeEach } from 'vitest';

const initializeApp = vi.fn(() => ({ __app: true }));
const getApps = vi.fn(() => []);
const getApp = vi.fn(() => ({ __app: true }));
const initializeFirestore = vi.fn(() => ({ __db: true }));
const persistentLocalCache = vi.fn((opts) => ({ __cache: true, opts }));
const persistentMultipleTabManager = vi.fn(() => ({ __tabManager: true }));

vi.mock('firebase/app', () => ({ initializeApp, getApps, getApp }));
vi.mock('firebase/firestore', () => ({
  initializeFirestore, persistentLocalCache, persistentMultipleTabManager,
  collection: vi.fn(), doc: vi.fn(), onSnapshot: vi.fn(), getDoc: vi.fn(),
  getDocs: vi.fn(), getDocsFromCache: vi.fn(), getDocsFromServer: vi.fn(),
  query: vi.fn(), where: vi.fn(), orderBy: vi.fn(), limit: vi.fn(), startAfter: vi.fn(),
}));

describe('services/firebase — getDb 是唯一且單一的初始化入口', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getApps.mockReturnValue([]);
    vi.resetModules();
  });

  it('uses the modern persistentLocalCache + persistentMultipleTabManager API, not the old enable-persistence two-step', async () => {
    const { getDb } = await import('./firebase.js');
    getDb();
    expect(persistentMultipleTabManager).toHaveBeenCalledTimes(1);
    expect(persistentLocalCache).toHaveBeenCalledTimes(1);
    expect(initializeFirestore).toHaveBeenCalledTimes(1);
    const [, options] = initializeFirestore.mock.calls[0];
    expect(options.localCache).toEqual({ __cache: true, opts: { tabManager: { __tabManager: true } } });
  });

  it('only calls initializeFirestore once even when getDb() is called many times (singleton)', async () => {
    const { getDb } = await import('./firebase.js');
    const a = getDb();
    const b = getDb();
    const c = getDb();
    expect(initializeFirestore).toHaveBeenCalledTimes(1);
    expect(a).toBe(b);
    expect(b).toBe(c);
  });

  it('reuses an existing Firebase app instead of calling initializeApp twice', async () => {
    getApps.mockReturnValue([{ __app: true }]);
    const { getDb } = await import('./firebase.js');
    getDb();
    expect(initializeApp).not.toHaveBeenCalled();
    expect(getApp).toHaveBeenCalledTimes(1);
  });

  it('creates a fresh app when none exists yet', async () => {
    getApps.mockReturnValue([]);
    const { getDb } = await import('./firebase.js');
    getDb();
    expect(initializeApp).toHaveBeenCalledTimes(1);
  });
});
