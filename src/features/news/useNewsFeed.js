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

    const toObj = d => ({ id: d.id, ...d.data() });

    // 以 id → 文章 的 Map 合併各來源（快取整批 / 監聽最新段 / cursor 舊文段），
    // 保證無重複項；發佈前重新依 pubDate 排序，保證順序正確。
    const store = new Map();
    const publish = () => {
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
      restLoading = true; // 查詢開始：只設 restLoading
      try {
        const rest = await getDocsFromServer(
          query(baseQuery(), startAfter(cursorDoc), limit(REST_FETCH_LIMIT)),
        );
        rest.docs.forEach(d => store.set(d.id, toObj(d)));
        publish();
        fullLoaded = true; // 只有 server 查詢成功才標記完成
        cancelRetryTimer(); // 成功：取消任何待執行的自動重試
      } catch (e) {
        // 失敗：fullLoaded 維持 false。重試管道有三：
        // ①短時間自動重試（有上限）②下一次 server snapshot ③使用者手動刷新
        console.error('News rest 補抓失敗（將自動重試，或按「重新整理」）:', e);
        if (autoRetries < MAX_AUTO_RETRIES) {
          autoRetries++;
          cancelRetryTimer(); // 建新排程前先取消舊 timer，確保同時最多一個
          retryTimer = setTimeout(() => {
            retryTimer = null;
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
        if (!cached.empty) {
          cached.docs.forEach(d => store.set(d.id, toObj(d)));
          publish();
          if (cached.size >= CACHE_LIMIT) fullLoaded = true; // 快取完整才算載入完成
        }
      } catch { /* 首次造訪無快取，屬正常 */ }

      // ② 只監聽「最新 300 則」範圍：新新聞即時推送、既有文章更新同步
      unsubRef.current = onSnapshot(
        query(baseQuery(), limit(LIVE_LISTEN_LIMIT)),
        snap => {
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
    } catch (e) { console.error('News:', e); }
  }, [baseQuery, onFirstPublish]);

  useEffect(() => {
    startOrRetry();
    return () => {
      if (unsubRef.current) unsubRef.current();
      if (cancelRetryRef.current) cancelRetryRef.current();
      unsubRef.current = null;
      retryRestRef.current = null;
      cancelRetryRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return { news, loading, refresh: startOrRetry };
}
