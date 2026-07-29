import { useEffect, useState } from 'react';

/**
 * 回傳目前時間，每 intervalMs 更新一次並觸發使用它的元件重新渲染。
 *
 * 用於「今天／本月／本年」這類依賴日期邊界的統計：邊界（todayStart/
 * monthStart/yearStart）必須用目前時間重新計算才正確，若只放在
 * useMemo(() => ..., [articles]) 裡，articles 沒變時就永遠不會重新
 * 計算——頁面開著跨過午夜/跨月/跨年，統計會停在舊的邊界，不會自動
 * 更新，只有 articles 之後剛好變動才會連帶更新成新邊界（幾乎等於巧合）。
 * 用這個 hook 提供的 now 直接計算（不用 useMemo）就沒有這個問題。
 */
export function useNow(intervalMs = 60000) {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
  return now;
}
