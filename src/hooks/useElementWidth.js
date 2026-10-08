/* global ResizeObserver */
import { useEffect, useRef, useState } from 'react';

/**
 * 量測某個元素目前的寬度（px），元素大小改變時自動更新。
 *
 * 給 SVG 圖表用：把 viewBox 寬度設成容器實際寬度，圖表就會填滿整個卡片，
 * 字體大小也維持原樣；若寫死 viewBox 寬度（例如 800），容器比它寬時兩側就會
 * 留白。元素是「資料載入後才出現」也沒問題（每次 render 都會檢查有沒有換元素）。
 * 量不到寬度（測試環境、還沒排版）時用 fallback。
 */
export function useElementWidth(ref, fallback = 800) {
  const [width, setWidth] = useState(0);
  const observerRef = useRef(null);
  const observedRef = useRef(null);

  useEffect(() => {
    const el = ref.current;
    if (!el || observedRef.current === el) return;
    observedRef.current = el;
    const update = () => {
      const next = Math.round(el.getBoundingClientRect().width);
      setWidth(prev => (prev === next ? prev : next));
    };
    update();
    if (typeof ResizeObserver !== 'undefined') {
      if (observerRef.current) observerRef.current.disconnect();
      observerRef.current = new ResizeObserver(update);
      observerRef.current.observe(el);
    }
  });

  useEffect(() => () => { if (observerRef.current) observerRef.current.disconnect(); }, []);

  return width > 0 ? Math.max(width, 280) : fallback;
}
