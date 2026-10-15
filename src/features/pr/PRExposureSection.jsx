import ExposureInsightsPage from './ExposureInsightsPage.jsx';
import ExposurePerformancePanel from './ExposurePerformancePanel.jsx';
import { KeyMediaPanel } from './KeyMediaPanel.jsx';
import { ManualExposurePanel } from './ManualExposurePanel.jsx';
import { usePRState } from './prState.jsx';

// ═══════════════════════════════════════════════════════════
// PR 曝光成效：把原本分散的曝光相關區塊放在同一頁——
//   新聞稿曝光成效（摘要、類型分布、媒體排行、新聞稿／主題展開明細、篩選、匯出新聞稿成效）
//   重點媒體曝光監控
//   人工確認曝光（Excel 上傳、匯出曝光明細、最新清單、曝光分析）
// 曝光分析是這個子頁內的「下一頁」：進去後子頁籤仍在上方，按返回回到這裡。
// ═══════════════════════════════════════════════════════════
export function PRExposureSection({
  validTranscend, prArticles, prStatus,
  mediaExposure, mediaExposureStatus, refreshMediaExposure,
}) {
  const [view, setView] = usePRState('exposure.view', 'main');   // 'main'｜'insights'
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
      <ExposurePerformancePanel
        records={mediaExposure}
        status={mediaExposureStatus}
        onRetry={refreshMediaExposure}
      />

      {/* 重點媒體曝光監控：用全部有效創見報導（不受新聞監測搜尋工具列影響） */}
      <KeyMediaPanel articles={validTranscend} status={prStatus} />

      <ManualExposurePanel
        records={mediaExposure}
        status={mediaExposureStatus}
        onRetry={refreshMediaExposure}
        onImported={refreshMediaExposure}
        onOpenInsights={() => goView('insights')}
      />
    </div>
  );
}
