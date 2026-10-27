import { useMemo } from 'react';

import { ActionButton, ListStatus, PageHeader, SectionCard, SegmentedControl } from '../../components/ui/index.js';
import ShowMoreButton, { useShowMore } from '../../components/ShowMore.jsx';
import NewsFilterToolbar from '../../components/filters/NewsFilterToolbar.jsx';
import NewsCard from '../news/NewsCard.jsx';
import { useNow } from '../../hooks/useNow.js';
import { exportNewsExcel } from '../../utils/formatting.js';
import { taipeiPeriodRange, inPeriod } from '../../utils/dates.js';
import { filterNewsList } from '../../utils/news.js';
import { PRStatsPanel } from './PRStatsPanel.jsx';
import { PR_LIST_TIME_FILTERS } from './prData.js';
import { usePRState } from './prState.jsx';

// ═══════════════════════════════════════════════════════════
// PR 新聞監測：搜尋／媒體／情緒篩選 → 統計卡 → 創見最新報導完整清單（期間篩選、匯出）
// 資料一律來自 usePRNews 的本月＋上月創見報導（validTranscend），不是全站 2,000 則新聞。
// ═══════════════════════════════════════════════════════════
export function PRNewsSection({ validTranscend, prStatus, refreshPRNews }) {
  // 篩選狀態放在 PR store：切換子頁後再回來，搜尋／媒體／情緒／期間都還在
  const [timeFilter, setTimeFilter] = usePRState('news.period', 'month');
  const [prQuery, setPrQuery] = usePRState('news.query', '');
  const [prMedia, setPrMedia] = usePRState('news.media', 'all');
  const [prSentiment, setPrSentiment] = usePRState('news.sentiment', 'all');

  const mediaOptions = useMemo(
    () => [...new Set(validTranscend.map(n => n.mediaName || n.sourceName || '未知媒體'))]
      .sort((a, b) => a.localeCompare(b, 'zh-Hant')),
    [validTranscend]);

  // PR 頁面唯一的搜尋工具列（搜尋／媒體／情緒），只影響這個子頁的創見 PR 統計／清單／匯出，
  // 不影響「競品動態」（那是獨立的品牌＋期間篩選，資料來源也不同）。
  const searchFiltered = useMemo(
    () => filterNewsList(validTranscend, { query: prQuery, media: prMedia, sentiment: prSentiment }),
    [validTranscend, prQuery, prMedia, prSentiment]);

  const resetPRFilters = () => {
    setPrQuery('');
    setPrMedia('all');
    setPrSentiment('all');
  };

  // useNow()：時間篩選的邊界必須隨「目前時間」更新，否則頁面開著跨過午夜／跨週／跨月，
  // 清單會停在舊邊界（同 PRStatsPanel 的說明）。
  const now = useNow();

  // 完整的期間篩選結果（未截斷）：Excel 匯出要跟畫面上「這個期間有幾篇」的定義完全一致，
  // 不能只看畫面上顯示的前 N 筆。
  const transcendFull = useMemo(() => {
    const range = taipeiPeriodRange(timeFilter, now);
    return searchFiltered.filter(n => inPeriod(n, range));
  }, [searchFiltered, timeFilter, now]);

  // 畫面清單先顯示前 50 篇，可按「顯示更多」展開（渲染效能考量，不是資料本身被裁切）。
  const more = useShowMore(transcendFull, 50, [timeFilter, prQuery, prMedia, prSentiment]);
  const transcend = more.shown;

  return (
    <div className="space-y-4">
      <PageHeader title="新聞監測" description="創見相關報導：搜尋、媒體、情緒與期間篩選，可匯出目前的結果。"
        actions={
          <ActionButton icon="download" onClick={() => exportNewsExcel(transcendFull, '創見最新報導', '創見最新報導')}
            disabled={transcendFull.length === 0}>匯出 Excel</ActionButton>
        } />
      {/* resultCount／totalCount 一律來自 usePRNews 的本月＋上月資料 */}
      <NewsFilterToolbar
        query={prQuery} setQuery={setPrQuery}
        media={prMedia} setMedia={setPrMedia}
        sentiment={prSentiment} setSentiment={setPrSentiment}
        mediaOptions={mediaOptions}
        resultCount={searchFiltered.length} totalCount={validTranscend.length}
        onReset={resetPRFilters}
      />

      {/* 統計卡片：套用搜尋／媒體／情緒篩選，但不套用今天／本週／本月的期間篩選——
          這幾個期間的數字本來就要同時顯示。 */}
      <PRStatsPanel articles={searchFiltered} status={prStatus} />

      <SectionCard title="創見最新報導" icon="news">
        {/* 期間：今天／本週／本月／上月，PR 專用 */}
        <SegmentedControl label="期間" value={timeFilter} onChange={setTimeFilter} options={PR_LIST_TIME_FILTERS} className="mb-3" />
        <ListStatus status={prStatus} count={transcend.length} errorText="報導載入失敗" onRetry={refreshPRNews}
          emptyText="此區間沒有符合的報導" emptyHint="可調整上方的期間或篩選條件">
          <div className="space-y-2">{transcend.map((n, i) => <NewsCard key={n.id || i} article={n} />)}</div>
          <ShowMoreButton remaining={more.remaining} step={50} onMore={more.showMore} onAll={more.showAll} />
        </ListStatus>
      </SectionCard>
    </div>
  );
}
