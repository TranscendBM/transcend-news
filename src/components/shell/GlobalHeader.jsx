import Spinner from '../Spinner.jsx';
import Icon from '../Icon.jsx';
import TranscendMark from '../logos/TranscendMark.jsx';
import LastUpdatedLabel from '../ui/LastUpdatedLabel.jsx';
import ActionButton from '../ui/ActionButton.jsx';

/**
 * 全站固定 Header（單列、56px）：網站名稱｜第一層導覽（children）｜連線狀態、最後更新時間、重新整理。
 * 創見紅底、白色 logo 與白字（維持品牌識別）；手機的底部導覽仍是白底。
 */
export default function GlobalHeader({ children, connected, updated, loading, onRefresh }) {
  return (
    <header className="ui-header sticky top-0 z-50 bg-brand text-white border-b border-brand-strong">
      <div className="max-w-content mx-auto px-3 sm:px-4 h-14 flex items-center gap-3 md:gap-5">
        <div className="flex items-center gap-3 shrink-0">
          <TranscendMark height={18} fill="#ffffff" />
          <div className="hidden xl:block border-l border-white/30 pl-3">
            <p className="text-sm font-bold text-white leading-tight">新聞監控</p>
            <p className="text-xs text-white/80 leading-tight">News Intelligence</p>
          </div>
        </div>

        {children}

        <div className="ml-auto flex items-center gap-2 sm:gap-3 shrink-0">
          <span className={`inline-flex items-center gap-1 text-xs ${connected ? 'text-white' : 'text-amber-200'}`}
            role="status" title={connected ? 'Firebase 已連線' : '連線中…'}>
            <Icon name="dot" className={`text-[1.3em] ${connected ? 'text-green-300' : 'text-amber-200'}`} />
            <span className="hidden xl:inline">{connected ? 'Firebase 已連線' : '連線中…'}</span>
            <span className="sr-only xl:hidden">{connected ? 'Firebase 已連線' : '連線中'}</span>
          </span>
          <LastUpdatedLabel date={updated} className="text-[11px] sm:text-xs !text-white/85" />
          <ActionButton onClick={onRefresh} disabled={loading} aria-label={loading ? '載入中' : '重新整理'} title="重新整理資料"
            icon={loading ? undefined : 'refresh'}
            className="!bg-white/10 !text-white !border-white/50 hover:!bg-white/20">
            {loading && <Spinner />}
            <span className="hidden sm:max-lg:hidden lg:inline">{loading ? '載入中' : '重新整理'}</span>
          </ActionButton>
        </div>
      </div>
    </header>
  );
}
