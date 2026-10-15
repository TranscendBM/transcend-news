import { useMemo } from 'react';

import { useSectionNav } from '../../hooks/useSectionNav.js';
import { PRStatsPanel } from './PRStatsPanel.jsx';
import { KeyMediaPanel } from './KeyMediaPanel.jsx';
import { ManualExposurePanel } from './ManualExposurePanel.jsx';
import { PROverview } from './PROverview.jsx';
import { PRNewsSection } from './PRNewsSection.jsx';
import { PRCompetitorSection } from './PRCompetitorSection.jsx';
import { PRExposureSection } from './PRExposureSection.jsx';
import PRSubNavigation from './PRSubNavigation.jsx';
import { PRStateProvider } from './prState.jsx';
import { selectValidTranscend } from './prData.js';
import { DEFAULT_PR_SECTION, PR_SECTIONS, PR_SECTION_IDS, prPanelId, prTabId } from './prSections.js';

// 舊的匯入路徑（測試與其他檔案從 PRTab.jsx 取用）維持可用
export { PRStatsPanel, KeyMediaPanel, ManualExposurePanel };

// ═══════════════════════════════════════════════════════════
// PR 媒體戰情 — 第二層導覽（總覽／新聞監測／競品動態／曝光成效）
//
// 資料與監聽器都在 App 層（useNewsFeed／usePRNews／useMediaExposure），由 props 傳進來；
// 這裡切換子頁只是換掉「顯示哪一塊」，不會建立任何新的 Firestore 查詢，也不會重抓資料。
// 目前的子頁存在網址 ?section=（沒有或不認識的值 → 總覽），上一頁／下一頁會切換子頁。
// 各子頁的篩選／展開狀態放在 PRStateProvider，切換子頁後仍保留。
// ═══════════════════════════════════════════════════════════
export function PRTab({
  news,
  prArticles,
  prStatus,
  refreshPRNews,
  mediaExposure = [],
  mediaExposureStatus = 'idle',
  refreshMediaExposure = () => {},
  pressSync = null,
}) {
  const [section, navigate] = useSectionNav('pr', PR_SECTION_IDS, DEFAULT_PR_SECTION);

  // 所有有效創見 PR 文章（已排除 CMoney／券商明細並去重）：總覽、新聞監測、曝光成效共用這一份
  const validTranscend = useMemo(() => selectValidTranscend(prArticles), [prArticles]);

  const content = {
    overview: (
      <PROverview
        news={news} validTranscend={validTranscend} prStatus={prStatus} refreshPRNews={refreshPRNews}
        mediaExposure={mediaExposure} mediaExposureStatus={mediaExposureStatus}
        refreshMediaExposure={refreshMediaExposure} onNavigate={navigate}
      />
    ),
    news: <PRNewsSection validTranscend={validTranscend} prStatus={prStatus} refreshPRNews={refreshPRNews} />,
    competitors: <PRCompetitorSection news={news} />,
    exposure: (
      <PRExposureSection
        validTranscend={validTranscend} prArticles={prArticles} prStatus={prStatus}
        mediaExposure={mediaExposure} mediaExposureStatus={mediaExposureStatus}
        refreshMediaExposure={refreshMediaExposure} pressSync={pressSync}
      />
    ),
  }[section];

  return (
    <PRStateProvider>
      <div className="space-y-4">
        <PRSubNavigation active={section} onChange={navigate} />

        {/* 每個子頁一個 tabpanel：目前的有內容，其他的是空的隱藏面板（讓 aria-controls 都找得到對象） */}
        {PR_SECTIONS.map(s => (
          <div key={s.id} role="tabpanel" id={prPanelId(s.id)} aria-labelledby={prTabId(s.id)}
            hidden={s.id !== section} tabIndex={s.id === section ? 0 : undefined}
            className="outline-none focus-visible:ring-2 focus-visible:ring-red-700 rounded-xl">
            {s.id === section ? content : null}
          </div>
        ))}
      </div>
    </PRStateProvider>
  );
}
