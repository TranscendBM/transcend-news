import { useEffect, useState } from 'react';

const hasMatchMedia = () => typeof window !== 'undefined' && typeof window.matchMedia === 'function';

/** 視窗是否符合媒體查詢。沒有 matchMedia（測試環境）時回傳 fallback（預設＝桌機）。 */
export function useMediaQuery(query, fallback = true) {
  const [matches, setMatches] = useState(() => (hasMatchMedia() ? window.matchMedia(query).matches : fallback));
  useEffect(() => {
    if (!hasMatchMedia()) return undefined;
    const mq = window.matchMedia(query);
    const on = () => setMatches(mq.matches);
    on();
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, [query]);
  return matches;
}

/** md（768px）以上＝平板／桌機。 */
export const useIsWide = () => useMediaQuery('(min-width: 768px)');
