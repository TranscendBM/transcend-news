import ExposureInsightsPage from './ExposureInsightsPage.jsx';
import ExposurePerformancePanel from './ExposurePerformancePanel.jsx';
import MatchReviewPanel from './MatchReviewPanel.jsx';
import { KeyMediaPanel } from './KeyMediaPanel.jsx';
import { ManualExposurePanel } from './ManualExposurePanel.jsx';
import { usePRState } from './prState.jsx';
import { SegmentedControl } from '../../components/ui/index.js';

// 「人工彙整曝光」（上傳的 Excel 彙整）與「待確認配對」（系統建議、人工在 Sheet 確認）是兩件事，名稱分開標示。
const PARTS = [
  { id: 'performance', label: '新聞稿成效' },
  { id: 'review', label: '待確認配對' },
  { id: 'media', label: '重點媒體' },
  { id: 'manual', label: '人工彙整曝光' },
];

// ═══════════════════════════════════════════════════════════
// PR 曝光成效：把原本分散的曝光相關區塊放在同一頁——
//   新聞稿曝光成效（摘要、類型分布、媒體排行、新聞稿／主題展開明細、篩選、匯出新聞稿成效）
//   重點媒體曝光監控
//   人工彙整曝光（Excel 上傳、匯出曝光明細、最新清單、曝光分析）
// 曝光分析是這個子頁內的「下一頁」：進去後子頁籤仍在上方，按返回回到這裡。
// ═══════════════════════════════════════════════════════════
export function PRExposureSection({
  validTranscend, prArticles, prStatus,
  mediaExposure, mediaExposureStatus, refreshMediaExposure, pressSync = null,
}) {
  const [view, setView] = usePRState('exposure.view', 'main');   // 'main'｜'insights'
  const [part, setPart] = usePRState('exposure.part', 'performance');
  const goView = next => {
    setView(next);
    try { window.scrollTo(0, 0); } catch { /* 非瀏覽器環境略過 */ }
  };

  if (view === 'insights') {
    return (
      <ExposureInsightsPage records={mediaExposure} autoArticles={prArticles} onBack={() => goView('main')} />
    );
  }

  return (
    <div className="space-y-4">
      {/* 四個區塊各自一個檢視，一次只顯示一個，避免曝光成效變成一頁超長捲動（選擇會保留，切換子頁再回來仍在） */}
      <SegmentedControl label="曝光成效檢視" value={part} onChange={setPart} options={PARTS} />

      {/* 四個檢視都留在 DOM（順序固定、狀態不會因切換而重置），只顯示目前選的那個 */}
      <div hidden={part !== 'performance'}>
        <ExposurePerformancePanel
          records={mediaExposure}
          status={mediaExposureStatus}
          onRetry={refreshMediaExposure}
          sync={pressSync}
        />
      </div>

      {/* 待確認配對：建議配對／未配對／已人工確認／已人工排除（覆核在 Google Sheet 完成，公開網站只讀） */}
      <div hidden={part !== 'review'}>
        <MatchReviewPanel records={mediaExposure} status={mediaExposureStatus} sync={pressSync} />
      </div>

      {/* 重點媒體曝光監控：用全部有效創見報導（不受新聞監測搜尋工具列影響） */}
      <div hidden={part !== 'media'}>
        <KeyMediaPanel articles={validTranscend} status={prStatus} />
      </div>

      <div hidden={part !== 'manual'}>
        <ManualExposurePanel
          records={mediaExposure}
          status={mediaExposureStatus}
          onRetry={refreshMediaExposure}
          onImported={refreshMediaExposure}
          onOpenInsights={() => goView('insights')}
        />
      </div>
    </div>
  );
}
