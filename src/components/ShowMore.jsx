import { useEffect, useState } from 'react';

import ActionButton from './ui/ActionButton.jsx';

// 清單一次只渲染前 step 則（渲染效能考量，資料本身沒有被裁切），
// 按「顯示更多」再多顯示 step 則。resetKeys 改變（例如切換期間/品牌/
// 搜尋條件）時回到只顯示前 step 則。
export function useShowMore(items, step, resetKeys = []) {
  const [limit, setLimit] = useState(step);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { setLimit(step); }, resetKeys);
  return {
    shown: items.slice(0, limit),
    remaining: Math.max(items.length - limit, 0),
    showMore: () => setLimit(l => l + step),
    showAll: () => setLimit(items.length),
  };
}

/** 全站統一的「顯示更多／全部顯示」（事件、新聞、競品清單都用這個）。 */
export default function ShowMoreButton({ remaining, step, onMore, onAll }) {
  if (remaining <= 0) return null;
  return (
    <div className="flex flex-wrap items-center justify-center gap-2 pt-3">
      <ActionButton onClick={onMore}>顯示更多（再 {Math.min(step, remaining)} 則）</ActionButton>
      {remaining > step && (
        <ActionButton variant="ghost" onClick={onAll}>全部顯示（尚有 {remaining} 則）</ActionButton>
      )}
    </div>
  );
}
