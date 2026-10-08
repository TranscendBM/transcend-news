import { useEffect, useState } from 'react';

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

export default function ShowMoreButton({ remaining, step, onMore, onAll }) {
  if (remaining <= 0) return null;
  return (
    <div className="flex items-center justify-center gap-2 pt-3">
      <button onClick={onMore}
        className="text-sm px-3.5 py-1.5 rounded-lg border border-gray-700/60 text-gray-400 hover:text-gray-200 hover:bg-gray-800 transition">
        顯示更多（再 {Math.min(step, remaining)} 則）
      </button>
      {remaining > step && (
        <button onClick={onAll}
          className="text-sm px-3.5 py-1.5 rounded-lg text-gray-500 hover:text-gray-200 transition">
          全部顯示（尚有 {remaining} 則）
        </button>
      )}
    </div>
  );
}
