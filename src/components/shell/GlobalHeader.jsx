import Spinner from '../Spinner.jsx';
import Icon from '../Icon.jsx';
import TranscendMark from '../logos/TranscendMark.jsx';
import LastUpdatedLabel from '../ui/LastUpdatedLabel.jsx';
import ActionButton from '../ui/ActionButton.jsx';

/**
 * 全站固定 Header（單列、56px）：網站名稱｜第一層導覽（children）｜連線狀態、最後更新時間、重新整理。
 * 白底細邊框，品牌紅只出現在 logo 與選取狀態。
 */
export default function GlobalHeader({ children, connected, updated, loading, onRefresh }) {
  return (
    <header className="sticky top-0 z-50 bg-ui-surface border-b border-ui-line">
      <div className="max-w-content mx-auto px-3 sm:px-4 h-14 flex items-center gap-3 md:gap-5">
        <div className="flex items-center gap-3 shrink-0">
          <TranscendMark height={18} fill="#960014" />
          <div className="hidden lg:block border-l border-ui-line pl-3">
            <p className="text-sm font-bold text-ui-text leading-tight">新聞監控</p>
            <p className="text-xs text-ui-muted leading-tight">News Intelligence</p>
          </div>
        </div>

        {children}

        <div className="ml-auto flex items-center gap-2 sm:gap-3 shrink-0">
          <span className={`inline-flex items-center gap-1 text-xs ${connected ? 'text-[color:var(--ok)]' : 'text-[color:var(--warn)]'}`}
            role="status" title={connected ? 'Firebase 已連線' : '連線中…'}>
            <Icon name="dot" className="text-[1.3em]" />
            <span className="hidden md:inline">{connected ? 'Firebase 已連線' : '連線中…'}</span>
            <span className="sr-only md:hidden">{connected ? 'Firebase 已連線' : '連線中'}</span>
          </span>
          <LastUpdatedLabel date={updated} className="text-[11px] sm:text-xs" />
          <ActionButton onClick={onRefresh} disabled={loading} aria-label={loading ? '載入中' : '重新整理'} title="重新整理資料"
            icon={loading ? undefined : 'refresh'}>
            {loading && <Spinner />}
            <span className="hidden sm:inline">{loading ? '載入中' : '重新整理'}</span>
          </ActionButton>
        </div>
      </div>
    </header>
  );
}
