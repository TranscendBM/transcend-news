import { useCallback, useEffect, useRef, useState } from 'react';
import {
  getDb, collection, query, where, orderBy, onSnapshot,
} from '../../services/firebase.js';
import { taipeiMonthStart } from '../../utils/dates.js';

// 每分鐘檢查一次是否已經跨入新的台灣月份，跟 useNow() 預設 interval 一致。
const MONTH_CHECK_INTERVAL_MS = 60000;

/**
 * PR 媒體曝光統計專用的新聞來源：獨立查詢 Firestore `news` 集合中
 * 「本月」（Asia/Taipei 日曆月份）且 `cat == 'transcend'` 的文件，
 * 不透過 useNewsFeed（那條管線把整站新聞裁到最新 2000 則，本月的創見
 * PR 報導可能被排擠在外，導致統計跟畫面實際存在的報導對不上）。
 *
 * 查詢條件固定為：
 *   where('cat', '==', 'transcend')
 *   where('pubDate', '>=', taipeiMonthStart(now))
 *   orderBy('pubDate', 'desc')
 * 只查「本月」而不是整個 transcend 分類，是因為正式資料庫目前雖然只
 * 保留「本月＋上個月」（見 functions/news_cleanup.py），但 transcend
 * 分類單獨的文件量仍可能達到數千筆（例如清理排程尚未清完舊資料的過渡
 * 期）——PR 統計只需要「本月」的資料，沒有理由連上個月都一起讀進來。
 * 這個查詢需要 Firestore composite index（cat ASC + pubDate DESC，
 * 見 repo 根目錄 firestore.indexes.json），部署方式見 README。
 *
 * 絕不 fallback 成「index 還沒建好就退回只查 cat、不限制日期」——那樣
 * 又會變回讀全部 transcend 文件的舊問題。查詢失敗（含 index 缺失的
 * FAILED_PRECONDITION）一律回報 status='error'，不猜測、不降級查詢。
 *
 * 回傳 { articles, status, refresh }：
 *   status: 'loading' | 'ready' | 'error'
 *   查詢失敗時 status 會是 'error'，articles 維持上次成功取得的內容
 *   （呼叫端應顯示明確的錯誤狀態，不能悄悄顯示 0 篇當作正常結果）。
 *   refresh()：手動重新啟動查詢（用於「重新整理」按鈕重試失敗的查詢；
 *   若目前已有作用中的監聽器，會先取消再重新訂閱一次新的快照）。
 *
 * 跨月處理：由於這個 hook 本身不依賴外部元件的重新渲染來得知時間流逝，
 * 內部用一個 60 秒的 interval 檢查目前的 taipeiMonthStart 是否已經跟
 * 目前訂閱中的月份起點不同——一旦跨入新的台灣月曆月份，就取消舊的
 * onSnapshot 監聽器、用新的 taipeiMonthStart 重新建立查詢，避免停留在
 * 已經不是「本月」的舊查詢範圍。
 *
 * Unmount / StrictMode 安全性：跟 useNewsFeed 一致的 mountedRef 模式——
 * cleanup 一開始就標記 unmounted，callback 內每次都先檢查，避免元件
 * 卸載後才 setState；React StrictMode 開發模式下的「掛載→卸載→再掛載」
 * 雙重呼叫，每次掛載各自建立/清理自己的監聽器，不會累積出重複訂閱。
 */
export function usePRNews() {
  const [articles, setArticles] = useState([]);
  const [status, setStatus] = useState('loading');

  const unsubRef = useRef(null);
  const startingRef = useRef(false);
  const mountedRef = useRef(false);
  const subscribedMonthStartMsRef = useRef(null); // 目前監聽器訂閱的月份起點（ms）

  const buildQuery = useCallback((monthStart) => {
    const db = getDb();
    return query(
      collection(db, 'news'),
      where('cat', '==', 'transcend'),
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
          console.error('PR news 查詢中斷:', err);
          setStatus('error');
          unsubRef.current = null;
        },
      );
    } catch (e) {
      if (mountedRef.current) {
        console.error('PR news 啟動失敗:', e);
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

  useEffect(() => {
    mountedRef.current = true;
    start();

    // 跨月偵測：taipeiMonthStart 改變就代表已經進入新的台灣日曆月份，
    // 舊查詢的 pubDate >= 舊月份起點 已經不等於「本月」，必須重建查詢。
    const monthCheckTimer = setInterval(() => {
      if (!mountedRef.current) return;
      const currentMonthStartMs = taipeiMonthStart(new Date()).getTime();
      if (subscribedMonthStartMsRef.current !== null
          && currentMonthStartMs !== subscribedMonthStartMsRef.current) {
        teardown();
        start();
      }
    }, MONTH_CHECK_INTERVAL_MS);

    return () => {
      // 一定要最先標記 unmounted，讓所有還卡在檢查點的呼叫立刻看到最新狀態。
      mountedRef.current = false;
      clearInterval(monthCheckTimer);
      teardown();
      startingRef.current = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return { articles, status, refresh };
}
