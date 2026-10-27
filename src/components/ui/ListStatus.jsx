import EmptyState from './EmptyState.jsx';
import ErrorState from './ErrorState.jsx';
import LoadingSkeleton from './LoadingSkeleton.jsx';

/**
 * 清單的四種狀態用同一個元件處理（loading／error／empty／ready），各頁不再各寫一套：
 *   status='error'   → 紅色錯誤＋重試
 *   count === 0 且 status='ready' → 空狀態（說明為什麼沒有資料）
 *   count === 0 且尚在載入         → 骨架
 *   其他 → 顯示 children
 */
export default function ListStatus({ status, count, errorText = '載入失敗', emptyText = '目前沒有符合的資料', emptyHint, onRetry, children }) {
  if (status === 'error') return <ErrorState message={errorText} onRetry={onRetry} />;
  if (count === 0) {
    return status === 'ready'
      ? <EmptyState title={emptyText} hint={emptyHint} />
      : <LoadingSkeleton lines={4} className="py-4" />;
  }
  return children;
}
