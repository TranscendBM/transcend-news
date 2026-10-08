import Icon from './Icon.jsx';

// 放在卡片右上角：切換「預設視窗（例如近 24 個月）」與「全部歷史」。
// total 是該資料實際有幾筆（月／年／季），defaultCount 是預設只顯示幾筆；
// 資料本來就沒有比預設更多時按鈕停用，並提示已經是全部。
export default function HistoryToggle({ expanded, onToggle, total, defaultCount, unit }) {
  const nothingMore = total <= defaultCount;
  const label = nothingMore
    ? `✓ 已顯示全部歷史（${total} ${unit}）`
    : expanded
      ? <><Icon name="undo" /> 收合為預設範圍</>
      : <><Icon name="history" /> 顯示全部歷史（共 {total} {unit}）</>;
  return (
    <button onClick={onToggle} disabled={nothingMore} aria-pressed={expanded}
      className="text-sm px-3.5 py-1.5 rounded-lg border border-gray-700/60 text-gray-400 hover:text-gray-200 hover:bg-gray-800 transition disabled:opacity-50 disabled:cursor-default shrink-0">
      {label}
    </button>
  );
}
