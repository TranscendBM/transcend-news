import { useCallback, useEffect, useRef, useState } from 'react';
import { getDb, collection, query, where, onSnapshot } from '../../services/firebase.js';

/**
 * PR 媒體曝光統計專用的新聞來源：獨立查詢 Firestore `news` 集合中
 * `cat == 'transcend'` 的文件，不透過 useNewsFeed（那條管線把整站新聞
 * 裁到最新 2000 則，本月/上個月的創見 PR 報導可能被排擠在外，導致統計
 * 跟畫面實際存在的報導對不上）。
 *
 * 只用單一等式篩選（where cat == 'transcend'，沒有 orderBy/其他 where），
 * Firestore 對這種查詢一律有自動單欄位索引可用，不需要額外手動部署
 * composite index。也因為資料庫本身現在只保留「本月＋上個月」
 * （見 functions/news_cleanup.py），這個查詢的結果集本來就有界，
 * 不是在讀整個 news 集合——只是讀 transcend 這個分類而已。
 *
 * 回傳 { articles, status }：
 *   status: 'loading' | 'ready' | 'error'
 *   查詢失敗時 status 會是 'error'，articles 維持上次成功取得的內容
 *   （呼叫端應顯示明確的錯誤狀態，不能悄悄顯示 0 篇當作正常結果）。
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

  const baseQuery = useCallback(() => {
    const db = getDb();
    return query(collection(db, 'news'), where('cat', '==', 'transcend'));
  }, []);

  const start = useCallback(() => {
    if (unsubRef.current) return;      // 已有監聽器在跑
    if (startingRef.current) return;   // 已有一次啟動流程在跑
    if (!mountedRef.current) return;   // 保險：呼叫當下元件已經不在了
    startingRef.current = true;

    try {
      unsubRef.current = onSnapshot(
        baseQuery(),
        snap => {
          if (!mountedRef.current) return; // unmounted 後不得 setState
          setArticles(snap.docs.map(d => ({ id: d.id, ...d.data() })));
          setStatus('ready');
        },
        err => {
          if (!mountedRef.current) return;
          console.error('PR news 查詢中斷:', err);
          setStatus('error');
          unsubRef.current = null;
        },
      );
      startingRef.current = false;
    } catch (e) {
      if (mountedRef.current) {
        console.error('PR news 啟動失敗:', e);
        setStatus('error');
      }
      startingRef.current = false;
    }
  }, [baseQuery]);

  useEffect(() => {
    mountedRef.current = true;
    start();
    return () => {
      // 一定要最先標記 unmounted，讓所有還卡在檢查點的呼叫立刻看到最新狀態。
      mountedRef.current = false;
      if (unsubRef.current) unsubRef.current();
      unsubRef.current = null;
      startingRef.current = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return { articles, status };
}
