import { useCallback, useEffect, useRef, useState } from 'react';
import { getDb, collection, query, where, orderBy, limit, getDocs } from '../../services/firebase.js';
import { normalizeTopics } from './eventData.js';

const TOPIC_WINDOW_DAYS = 14;
const TOPIC_LIMIT = 300;

/**
 * 事件中心的資料：一次性讀取 news_topics（近 14 天有更新、最多 300 個話題）。
 * 沒有 onSnapshot：後端每 30 分鐘才更新一次，不需要即時監聽，也就不會有監聽器可以重複建立；
 * 「重新整理」按鈕會呼叫 refresh() 重讀一次。查詢條件只有 lastPublishedAt 單一欄位（範圍＋排序），不需要複合索引。
 *
 * 回傳 { topics, status, refresh }：status 為 'loading' | 'ready' | 'error'；
 * 失敗時 topics 維持上次成功的內容，呼叫端應顯示錯誤與重試，不能把失敗當成「沒有事件」。
 */
export function useNewsTopics({ enabled = true } = {}) {
  const [topics, setTopics] = useState([]);
  const [status, setStatus] = useState('loading');
  const mountedRef = useRef(false);
  const runRef = useRef(0);
  const fetchedRef = useRef(false);

  const refresh = useCallback(async () => {
    fetchedRef.current = true;
    const run = ++runRef.current;
    try {
      const since = new Date(Date.now() - TOPIC_WINDOW_DAYS * 86400e3);
      const q = query(collection(getDb(), 'news_topics'),
        where('lastPublishedAt', '>=', since), orderBy('lastPublishedAt', 'desc'), limit(TOPIC_LIMIT));
      const snap = await getDocs(q);
      if (!mountedRef.current || run !== runRef.current) return;
      setTopics(normalizeTopics(snap.docs.map(d => ({ ...d.data(), id: d.id }))));
      setStatus('ready');
    } catch (error) {
      console.error('news_topics:', error);
      if (!mountedRef.current || run !== runRef.current) return;
      setStatus('error');
    }
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  // 只在需要的頁籤第一次進來時讀一次（IR／系統健康用不到，就不讀）；之後靠 refresh() 手動重讀
  useEffect(() => {
    if (enabled && !fetchedRef.current) refresh();
  }, [enabled, refresh]);

  return { topics, status, refresh };
}
