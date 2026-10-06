import { useCallback, useEffect, useRef, useState } from 'react';
import {
  getDb, collection, query, orderBy, limit, onSnapshot,
} from '../../services/firebase.js';

const MAX_EXPOSURE_RECORDS = 1000;

/**
 * 人工確認曝光的獨立資料管線。
 *
 * 這些資料是人工剪報結果，不是 RSS 自動新聞，因此刻意放在
 * `media_exposure`，不會被 news_cleanup 清除，也不會與 PR 自動監測篇數
 * 混算。前端只能讀取已去除內部備註的公開集合；原始檔案、列號與內部
 * 採訪備註保存在 `media_exposure_private`，由 Firestore Rules 預設拒絕。
 */
export function useMediaExposure({ enabled = true } = {}) {
  const [records, setRecords] = useState([]);
  const [status, setStatus] = useState(enabled ? 'loading' : 'idle');
  const unsubRef = useRef(null);
  const mountedRef = useRef(false);

  const teardown = useCallback(() => {
    if (unsubRef.current) {
      unsubRef.current();
      unsubRef.current = null;
    }
  }, []);

  const start = useCallback(() => {
    if (!enabled || !mountedRef.current || unsubRef.current) return;
    setStatus('loading');
    try {
      const q = query(
        collection(getDb(), 'media_exposure'),
        orderBy('exposureDate', 'desc'),
        limit(MAX_EXPOSURE_RECORDS),
      );
      unsubRef.current = onSnapshot(
        q,
        snap => {
          if (!mountedRef.current) return;
          setRecords(snap.docs.map(doc => ({ id: doc.id, ...doc.data() })));
          setStatus('ready');
        },
        error => {
          if (!mountedRef.current) return;
          console.error('人工確認曝光查詢失敗:', error);
          unsubRef.current = null;
          setStatus('error');
        },
      );
    } catch (error) {
      console.error('人工確認曝光啟動失敗:', error);
      if (mountedRef.current) setStatus('error');
    }
  }, [enabled]);

  const refresh = useCallback(() => {
    teardown();
    start();
  }, [start, teardown]);

  useEffect(() => {
    mountedRef.current = true;
    if (enabled) start();
    else setStatus('idle');
    return () => {
      mountedRef.current = false;
      teardown();
    };
  }, [enabled, start, teardown]);

  return { records, status, refresh };
}

