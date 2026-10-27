import Icon from '../Icon.jsx';
import ActionButton from './ActionButton.jsx';

/** 載入失敗：紅色錯誤＋重試按鈕（role=alert，讀屏會立即朗讀）。 */
export default function ErrorState({ message = '載入失敗', onRetry, className = '' }) {
  return (
    <div role="alert" className={`flex flex-col items-center gap-2 py-6 px-4 text-center text-[color:var(--danger)] ${className}`}>
      <p className="text-sm font-medium"><Icon name="alert" /> {message}</p>
      {onRetry && <ActionButton onClick={onRetry} icon="refresh">重試</ActionButton>}
    </div>
  );
}
