import { useCallback, useEffect, useRef, useState } from 'react';
import {
  getDb, collection, query, where, orderBy, onSnapshot,
} from '../../services/firebase.js';
import { taipeiMonthStart } from '../../utils/dates.js';

// 每分鐘檢查一次是否已經跨入新的台灣月份，跟 usePRNews()/useNow() 預設 interval 一致。
const MONTH_CHECK_INTERVAL_MS = 60000;

const UPSTREAM_CATS = ['usMarket', 'supplier'];

/**
 * 上游市場（供應鏈 + DRAM/Flash 市場）專用的新聞來源：獨立查詢 Firestore
 * `news` 集合中「本月」（Asia/Taipei 日曆月份）且 cat 為 usMarket 或
 * supplier 的文件，不透過 useNewsFeed（那條管線把整站新聞裁到最新 2000
 * 則，本月的上游報導可能被排擠在外，導致統計跟畫面實際存在的報導對
 * 不上——跟 usePRNews 取代舊 PR 資料來源的理由完全相同）。
 *
 * 查詢條件固定為：
 *   where('cat', 'in', ['usMarket', 'supplier'])
 *   where('pubDate', '>=', taipeiMonthStart(now))
 *   orderBy('pubDate', 'desc')
 * 只查「本月」而不是整個上游分類，理由同 usePRNews：正式資料庫目前只
 * 保留「本月＋上個月」，但單一分類的文件量仍可能達到數千筆。
 *
 * 這個查詢用得上既有的 composite index（cat ASC + pubDate DESC，見
 * repo 根目錄 firestore.indexes.json）：Firestore 的 `in` 查詢在執行面
 * 是拆成多個 `==` 查詢後再合併結果，所需要的索引跟單一 `==` 等值查詢
 * 相同，不需要另外替 `in` 建立新的 composite index。詳見 README 的
 * 「📡 上游市場新聞」章節。
 *
 * 絕不 fallback 成「查詢失敗就退回只查 cat、不限制日期」——那樣又會變
 * 回讀全部上游文件的舊問題。查詢失敗（含 index 缺失的
 * FAILED_PRECONDITION）一律回報 status='error'，不猜測、不降級查詢。
 *
 * enabled 參數：使用者停留在 PR 或 IR 分頁時，不需要持續讀取上游市場
 * 資料——enabled=false 時不建立查詢（若已有監聽器，立即取消），
 * refresh() 也不得建立查詢；enabled 由 false 轉為 true 時才開始訂閱。
 *
 * 回傳 { articles, status, refresh }：意義與跨月/unmount/StrictMode
 * 安全性處理方式都跟 usePRNews 一致，見該檔案內對應說明。
 */
export function useUpstreamNews({ enabled = true } = {}) {
  const [articles, setArticles] = useState([]);
  const [status, setStatus] = useState('loading');

  const unsubRef = useRef(null);
  const startingRef = useRef(false);
  const mountedRef = useRef(false);
  const enabledRef = useRef(enabled);
  const subscribedMonthStartMsRef = useRef(null); // 目前監聽器訂閱的月份起點（ms）

  const buildQuery = useCallback((monthStart) => {
    const db = getDb();
    return query(
      collection(db, 'news'),
      where('cat', 'in', UPSTREAM_CATS),
      where('pubDate', '>=', monthStart),
      orderBy('pubDate', 'desc'),
    );
  }, []);

  const teardown = useCallback(() => {
    if (unsubRef.current) {
      unsubRef.current();
      unsubRef.current = null;
    }
  }, []);

  const start = useCallback(() => {
    if (!enabledRef.current) return;   // enabled=false 時不得建立查詢
    if (unsubRef.current) return;      // 已有監聽器在跑
    if (startingRef.current) return;   // 已有一次啟動流程在跑
    if (!mountedRef.current) return;   // 保險：呼叫當下元件已經不在了
    startingRef.current = true;
    setStatus('loading');

    const monthStart = taipeiMonthStart(new Date());
    subscribedMonthStartMsRef.current = monthStart.getTime();

    try {
      unsubRef.current = onSnapshot(
        buildQuery(monthStart),
        snap => {
          if (!mountedRef.current) return; // unmounted 後不得 setState
          setArticles(snap.docs.map(d => ({ id: d.id, ...d.data() })));
          setStatus('ready');
        },
        err => {
          if (!mountedRef.current) return;
          // 查詢失敗（含缺少 composite index 的 FAILED_PRECONDITION）
          // 一律顯示明確錯誤，絕不 fallback 成不限日期的查詢。
          console.error('上游市場新聞查詢中斷:', err);
          setStatus('error');
          unsubRef.current = null;
        },
      );
    } catch (e) {
      if (mountedRef.current) {
        console.error('上游市場新聞啟動失敗:', e);
        setStatus('error');
      }
    } finally {
      startingRef.current = false;
    }
  }, [buildQuery]);

  const refresh = useCallback(() => {
    teardown();
    start();
  }, [teardown, start]);

  // 掛載/卸載生命週期：跟 usePRNews 一致，只在掛載時跑一次。
  useEffect(() => {
    mountedRef.current = true;
    if (enabledRef.current) start();

    const monthCheckTimer = setInterval(() => {
      if (!mountedRef.current || !enabledRef.current) return;
      const currentMonthStartMs = taipeiMonthStart(new Date()).getTime();
      if (subscribedMonthStartMsRef.current !== null
          && currentMonthStartMs !== subscribedMonthStartMsRef.current) {
        teardown();
        start();
      }
    }, MONTH_CHECK_INTERVAL_MS);

    return () => {
      mountedRef.current = false;
      clearInterval(monthCheckTimer);
      teardown();
      startingRef.current = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // enabled 開關：由 false 轉 true 時建立查詢，由 true 轉 false 時立即
  // 取消監聽器。start()/teardown() 兩者都是穩定參照（useCallback 依賴
  // 不變），只有 enabled 真的改變時這個 effect 才會重新執行。
  useEffect(() => {
    enabledRef.current = enabled;
    if (!mountedRef.current) return; // 尚未掛載完成（初始掛載由上面那個 effect 處理）
    if (enabled) {
      start();
    } else {
      teardown();
    }
  }, [enabled, start, teardown]);

  return { articles, status, refresh };
}
