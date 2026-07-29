import { useCallback, useEffect, useRef, useState } from 'react';
import {
  getDb, collection, query, where, orderBy, limit, startAfter,
  onSnapshot, getDocsFromCache, getDocsFromServer,
} from '../../services/firebase.js';
import { dedupeArticlesByTitle, isExcludedNews } from '../../utils/news.js';

const NEWS_WINDOW_START = new Date('2026-01-01T00:00:00+08:00');
const LIVE_LISTEN_LIMIT = 300;   // 只監聽「最新 300 則」範圍：新新聞即時推送、既有文章更新同步
const CACHE_LIMIT = 2000;        // 本機快取整批出圖上限
const REST_FETCH_LIMIT = 1700;   // cursor 補抓上限（與 300 相加 = 2000）
const MAX_AUTO_RETRIES = 2;      // 有上限的短時間自動重試

/**
 * 新聞列表載入管線：本機快取整批出圖 → 監聽最新 300 則（即時推送）→
 * cursor 補抓其餘文件 → 失敗時有上限的自動重試 + 手動重試 hook。
 *
 * 讀取量說明（docChanges 數量≠計費讀取數，不可作為依據）：
 * 有本機快取時，監聽「通常」以續傳方式只讀取異動文件；但 listener 中斷
 * 超過約 30 分鐘後重新連線，可能被視為新查詢而重新計算最新 300 則的讀取。
 * 快取能大幅降低讀取量，但不保證永遠只計異動文件。
 *
 * 載入狀態機：
 *   fullLoaded  = 已擁有完整資料 —— 只有「快取本身已達完整 2000 筆」或
 *                 「cursor 補抓確實成功」才為 true（快取非空≠完整，
 *                 例如上次首載中斷可能只留下 300 筆的部分快取）
 *   restLoading = cursor 補抓進行中 —— 防止 onSnapshot 連續觸發時
 *                 同時發出多個後續查詢
 *
 * Unmount 期間的生命週期保護（mountedRef）：
 *   啟動流程一開始就要 await 本機快取讀取，這中間有一段非同步空窗；
 *   若使用者在這個 Promise resolve 前就切走頁面（元件 unmount），
 *   cleanup 當下 unsubRef.current 還是 null，沒有東西可以取消——
 *   Promise resolve 後如果沒有額外檢查，程式仍會繼續建立 onSnapshot，
 *   產生一個「元件已經卸載後才出現、永遠不會被清理」的監聽器。
 *   cursor 補抓（fetchRest）用的是 getDocsFromServer，同樣有這個問題。
 *   因此每一個 await 之後、每一次要 setState／呼叫 onFirstPublish／
 *   建立 onSnapshot／安排 retry timer 之前，都要重新檢查 mountedRef，
 *   已卸載就直接放棄，不做任何有副作用的事。
 *
 * @param {object} [options]
 * @param {(loaded: boolean) => void} [options.onFirstPublish] 第一次成功
 *   發布新聞陣列時呼叫一次（用於同步外層彙總的 loading 旗標，行為與搬移前
 *   在 publish() 內直接呼叫外層 setLoading(false) 完全一致）。
 */
export function useNewsFeed(options = {}) {
  const { onFirstPublish } = options;
  const [news, setNews] = useState([]);
  const [loading, setLoading] = useState(true);

  const unsubRef = useRef(null);
  const retryRestRef = useRef(null);
  const cancelRetryRef = useRef(null);
  const hasPublishedRef = useRef(false);
  // 建立監聽器前有一段非同步空窗（等待本機快取讀取），unsubRef.current
  // 在那之前都還是 null；這個 flag 蓋住那段空窗，避免同一時間內第二次
  // 呼叫 startOrRetry（例如掛載時的自動啟動與外部手動刷新幾乎同時發生）
  // 又跑一次完整初始化、建立第二個 onSnapshot 監聽器。
  const startingRef = useRef(false);
  // 元件目前是否仍掛載。effect 啟動時設為 true；cleanup 一開始（在做
  // 其他清理動作之前）就設為 false，讓所有還在等待中的 await 之後的
  // 檢查點都能立刻看到最新狀態。
  const mountedRef = useRef(false);

  const baseQuery = useCallback(() => {
    const db = getDb();
    return query(
      collection(db, 'news'),
      where('pubDate', '>=', NEWS_WINDOW_START),
      orderBy('pubDate', 'desc'),
    );
  }, []);

  const startOrRetry = useCallback(async () => {
    // 已建立即時監聽器：更新由 listener 自動推送，不重建查詢；
    // 但若 cursor 補抓曾失敗（fullLoaded=false），手動刷新在此重試補抓。
    if (unsubRef.current) {
      if (retryRestRef.current) retryRestRef.current();
      return;
    }
    if (startingRef.current) return; // 已有一次啟動流程在跑，監聽器還沒建立，避免重複啟動
    if (!mountedRef.current) return; // 保險：呼叫當下元件已經不在了
    startingRef.current = true;

    const toObj = d => ({ id: d.id, ...d.data() });

    // 以 id → 文章 的 Map 合併各來源（快取整批 / 監聽最新段 / cursor 舊文段），
    // 保證無重複項；發佈前重新依 pubDate 排序，保證順序正確。
    const store = new Map();
    const publish = () => {
      if (!mountedRef.current) return; // unmounted 後不得 setState／呼叫 onFirstPublish
      const ms = v => (v?.toDate ? v.toDate().getTime() : new Date(v || 0).getTime());
      const arr = dedupeArticlesByTitle([...store.values()]
        .filter(n => !n.link?.includes('msn.com'))
        .filter(n => !isExcludedNews(n)))
        .sort((a, b) => ms(b.pubDate) - ms(a.pubDate))
        .slice(0, CACHE_LIMIT);
      setNews(arr);
      setLoading(false);
      if (!hasPublishedRef.current) {
        hasPublishedRef.current = true;
        onFirstPublish?.();
      }
    };

    let fullLoaded = false;
    let restLoading = false;
    let lastCursorDoc = null; // 最新補抓游標（供手動刷新/自動重試）
    let autoRetries = 0;
    let retryTimer = null;    // 自動重試 timer ID（唯一，可取消）

    const cancelRetryTimer = () => {
      if (retryTimer !== null) { clearTimeout(retryTimer); retryTimer = null; }
    };

    const fetchRest = async (cursorDoc) => {
      if (fullLoaded || restLoading || !cursorDoc) return;
      if (!mountedRef.current) return; // 保險：呼叫當下元件已經不在了
      restLoading = true; // 查詢開始：只設 restLoading
      try {
        const rest = await getDocsFromServer(
          query(baseQuery(), startAfter(cursorDoc), limit(REST_FETCH_LIMIT)),
        );
        if (!mountedRef.current) return; // unmount 發生在等待期間：不 publish、不標記 fullLoaded
        rest.docs.forEach(d => store.set(d.id, toObj(d)));
        publish();
        fullLoaded = true; // 只有 server 查詢成功才標記完成
        cancelRetryTimer(); // 成功：取消任何待執行的自動重試
      } catch (e) {
        if (!mountedRef.current) return; // unmount 發生在等待期間：不印 log、不安排重試
        // 失敗：fullLoaded 維持 false。重試管道有三：
        // ①短時間自動重試（有上限）②下一次 server snapshot ③使用者手動刷新
        console.error('News rest 補抓失敗（將自動重試，或按「重新整理」）:', e);
        if (autoRetries < MAX_AUTO_RETRIES) {
          autoRetries++;
          cancelRetryTimer(); // 建新排程前先取消舊 timer，確保同時最多一個
          retryTimer = setTimeout(() => {
            retryTimer = null;
            if (!mountedRef.current) return; // timer 觸發時元件可能已經卸載
            fetchRest(lastCursorDoc);
          }, 5000 * autoRetries);
        }
      } finally {
        restLoading = false;
      }
    };
    // 手動刷新重試 hook：先取消排程中的自動重試再立即補抓
    //（fetchRest 內的 fullLoaded/restLoading 檢查天然防重複）
    retryRestRef.current = () => { cancelRetryTimer(); fetchRest(lastCursorDoc); };
    cancelRetryRef.current = cancelRetryTimer;

    try {
      // ① 本機快取整批出圖（0 次伺服器讀取；第二次開啟起幾乎秒開）
      try {
        const cached = await getDocsFromCache(query(baseQuery(), limit(CACHE_LIMIT)));
        if (!mountedRef.current) { startingRef.current = false; return; } // 等待快取期間 unmount
        if (!cached.empty) {
          cached.docs.forEach(d => store.set(d.id, toObj(d)));
          publish();
          if (cached.size >= CACHE_LIMIT) fullLoaded = true; // 快取完整才算載入完成
        }
      } catch { /* 首次造訪無快取，屬正常 */ }

      if (!mountedRef.current) { startingRef.current = false; return; } // 再次確認：建立監聽器前最後一道防線

      // ② 只監聽「最新 300 則」範圍：新新聞即時推送、既有文章更新同步
      unsubRef.current = onSnapshot(
        query(baseQuery(), limit(LIVE_LISTEN_LIMIT)),
        snap => {
          if (!mountedRef.current) return; // 保險：unsubscribe 前的極短暫空窗
          if (snap.metadata.fromCache && snap.empty) return; // 首次無快取的空快取事件
          snap.docChanges().forEach(c => {
            if (c.type !== 'removed') store.set(c.doc.id, toObj(c.doc));
            // removed 僅代表移出「最新300」窗口，文章本身仍在，保留即可
          });
          publish();

          // ③ 資料尚不完整（無快取首次造訪、或部分快取）→ cursor 補抓其餘文件
          if (!snap.metadata.fromCache && snap.size > 0) {
            lastCursorDoc = snap.docs[snap.size - 1]; // 隨時保存最新游標
            if (!fullLoaded) fetchRest(lastCursorDoc);
          }
        },
        err => {
          // 監聽器永久錯誤：取消待執行的重試 timer、清理狀態，
          // 讓使用者按「重新整理」時能重建監聽
          console.error('News listen 中斷（按「重新整理」可重建）:', err);
          cancelRetryTimer();
          unsubRef.current = null;
          retryRestRef.current = null;
          cancelRetryRef.current = null;
        },
      );
      startingRef.current = false; // 監聽器已建立，之後改走上面「已建立」的分支
    } catch (e) {
      console.error('News:', e);
      startingRef.current = false; // 建立失敗，允許之後重新嘗試
    }
  }, [baseQuery, onFirstPublish]);

  useEffect(() => {
    mountedRef.current = true;
    startOrRetry();
    return () => {
      // 一定要最先標記 unmounted：讓所有還卡在 await 之後的檢查點
      // 立刻看到最新狀態，不會在這個 cleanup 執行完之後才失效。
      mountedRef.current = false;
      if (unsubRef.current) unsubRef.current();
      if (cancelRetryRef.current) cancelRetryRef.current();
      unsubRef.current = null;
      retryRestRef.current = null;
      cancelRetryRef.current = null;
      startingRef.current = false; // 回復到安全狀態
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return { news, loading, refresh: startOrRetry };
}
