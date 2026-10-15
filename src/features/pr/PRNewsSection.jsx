import { useMemo } from 'react';

import Card from '../../components/Card.jsx';
import Icon from '../../components/Icon.jsx';
import TabBtn from '../../components/TabBtn.jsx';
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

      <Card title="創見最新報導" icon="news"
        actions={
          <button onClick={() => exportNewsExcel(transcendFull, '創見最新報導', '創見最新報導')}
            disabled={transcendFull.length === 0}
            className="text-sm px-3.5 py-1.5 rounded-lg border border-gray-700/60 text-gray-400 hover:text-gray-200 hover:bg-gray-800 transition disabled:opacity-40 disabled:cursor-not-allowed shrink-0">
            <Icon name="download" /> 匯出 Excel
          </button>
        }>
        {/* 時間篩選：今天／本週／本月／上月，PR 專用 */}
        <div className="flex flex-wrap gap-1.5 mb-3">
          {PR_LIST_TIME_FILTERS.map(f => (
            <TabBtn key={f.id} active={timeFilter === f.id} onClick={() => setTimeFilter(f.id)}>
              {f.label}
            </TabBtn>
          ))}
        </div>
        {prStatus === 'error'
          ? <div className="h-32 flex flex-col items-center justify-center gap-2 text-red-400 text-sm">
              <span><Icon name="alert" /> 報導載入失敗</span>
              <button onClick={refreshPRNews}
                className="text-xs px-3 py-1 rounded-lg border border-red-700/60 text-red-300 hover:bg-red-900/30 transition">
                重試
              </button>
            </div>
          : transcend.length > 0
          ? <>
              <div className="space-y-2">{transcend.map((n, i) => <NewsCard key={n.id || i} article={n} />)}</div>
              <ShowMoreButton remaining={more.remaining} step={50} onMore={more.showMore} onAll={more.showAll} />
            </>
          : <div className="h-32 flex items-center justify-center text-gray-600 text-sm">
              {prStatus === 'ready' ? '此區間暫無符合報導' : '載入中…'}
            </div>
        }
      </Card>
    </div>
  );
}
