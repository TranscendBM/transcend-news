import { useMemo } from 'react';

import Icon from '../../components/Icon.jsx';
import NewsCard from '../news/NewsCard.jsx';
import TodayBriefing from '../intelligence/TodayBriefing.jsx';
import { sortByDate } from '../../utils/dates.js';
import { isBriefingCandidate } from '../../utils/news.js';
import TopEvents, { openEventCenter } from '../events/TopEvents.jsx';
import { PRStatsPanel } from './PRStatsPanel.jsx';
import { KeyMediaPanel } from './KeyMediaPanel.jsx';
import PRSummaryCard from './PRSummaryCard.jsx';
import { selectCompetitorNews } from './prData.js';
import {
  buildPerformance, coverageScopeText, defaultCoverageFilter, filterByCoverage, sortTopics, toPublicRecords,
} from './exposurePerformance.js';

// ═══════════════════════════════════════════════════════════
// PR 總覽：只放「快速判讀」的摘要。每一塊最多 5 筆、右上角「查看全部」切到對應子頁；
// 完整清單、篩選、匯出都在各子頁，這裡不再渲染長清單。
// 全部使用既有資料的摘要結果（同一份選取／統計函式），沒有新增查詢或監聽器。
// ═══════════════════════════════════════════════════════════
export const OVERVIEW_LIMIT = 5;

const fmtDay = d => (d ? d.toLocaleDateString('zh-TW', { timeZone: 'Asia/Taipei' }) : '—');

function ListMessage({ children }) {
  return <p className="text-sm text-gray-600 text-center py-6">{children}</p>;
}

function RetryMessage({ children, onRetry }) {
  return (
    <div className="py-6 text-center text-sm text-red-400" role="alert">
      <p><Icon name="alert" /> {children}</p>
      <button onClick={onRetry}
        className="mt-2 text-sm px-3.5 py-1.5 rounded-lg border border-red-700/60 text-red-300 hover:bg-red-900/30 transition">
        重試
      </button>
    </div>
  );
}

function ExposureSummary({ records, status, onRetry }) {
  // 正式的新聞稿曝光成效只算「新聞稿衍生曝光」（有分類資料時）；一般公司報導、產業連帶、待確認、不相關另計
  const publicRecords = useMemo(() => toPublicRecords(records), [records]);
  const scope = useMemo(() => defaultCoverageFilter(publicRecords), [publicRecords]);
  const perf = useMemo(() => buildPerformance(filterByCoverage(publicRecords, scope)), [publicRecords, scope]);
  const latestTopics = useMemo(() => sortTopics(perf.topics, 'recent').slice(0, 3), [perf]);

  if (status === 'error') return <RetryMessage onRetry={onRetry}>新聞稿曝光成效載入失敗</RetryMessage>;
  if (status === 'loading' && perf.total === 0) return <ListMessage>載入中…</ListMessage>;
  if (perf.total === 0) return <ListMessage>尚未匯入人工確認曝光資料</ListMessage>;

  return (
    <div>
      <div className="grid grid-cols-2 gap-2">
        {[
          ['人工確認曝光', perf.total, '則'],
          ['涵蓋媒體', perf.mediaCount, '家'],
          ['新聞稿／主題', perf.topicCount, '依標題彙整'],
          ['最近曝光', fmtDay(perf.latestDate), ''],
        ].map(([label, value, hint]) => (
          <div key={label} className="rounded-xl border border-gray-700/60 bg-gray-900 p-2.5 text-center">
            <p className="text-xs text-gray-500">{label}</p>
            <p className="text-lg font-bold text-ink mt-0.5 tabular-nums">{value}</p>
            {hint && <p className="text-xs text-gray-600">{hint}</p>}
          </div>
        ))}
      </div>
      <p className="text-xs text-gray-500 mt-2" data-testid="overview-exposure-scope">{coverageScopeText(scope, perf.total)}</p>
      <p className="text-xs text-gray-500 mt-3 mb-1.5">最近的新聞稿／主題</p>
      <ul className="space-y-1.5">
        {latestTopics.map(t => (
          <li key={t.key} className="flex items-start gap-2 text-sm">
            <span className="min-w-0 flex-1 text-ink leading-snug line-clamp-2">{t.name}</span>
            <span className="shrink-0 text-xs text-gray-500 tabular-nums">{t.total} 則・{fmtDay(t.lastDate)}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

export function PROverview({
  news, validTranscend, prStatus, refreshPRNews,
  mediaExposure, mediaExposureStatus, refreshMediaExposure, onNavigate, topics = [], topicsStatus = 'ready',
}) {
  const briefingArticles = useMemo(() => news.filter(isBriefingCandidate), [news]);
  const latestPR = useMemo(() => sortByDate(validTranscend).slice(0, OVERVIEW_LIMIT), [validTranscend]);
  const latestCompetitors = useMemo(() => selectCompetitorNews(news).slice(0, OVERVIEW_LIMIT), [news]);

  return (
    <div className="space-y-4">
      <TodayBriefing articles={briefingArticles} topics={topics} />

      <PRSummaryCard title="涉及創見的重要事件" icon="radar" onViewAll={() => openEventCenter('transcend')}>
        <TopEvents topics={topics} status={topicsStatus} tag="transcend" limit={3} />
      </PRSummaryCard>

      <PRSummaryCard title="創見媒體曝光" icon="chart" onViewAll={() => onNavigate('news')}>
        <PRStatsPanel articles={validTranscend} status={prStatus} />
      </PRSummaryCard>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 items-stretch">
        <PRSummaryCard title="創見最新報導" icon="news" onViewAll={() => onNavigate('news')}>
          {prStatus === 'error'
            ? <RetryMessage onRetry={refreshPRNews}>報導載入失敗</RetryMessage>
            : latestPR.length > 0
              ? <div className="space-y-2">{latestPR.map((n, i) => <NewsCard key={n.id || i} article={n} />)}</div>
              : <ListMessage>{prStatus === 'ready' ? '目前沒有創見報導' : '載入中…'}</ListMessage>}
        </PRSummaryCard>

        <PRSummaryCard title="競品最新動態" icon="target" onViewAll={() => onNavigate('competitors')}>
          {latestCompetitors.length > 0
            ? <div className="space-y-2">{latestCompetitors.map((n, i) => <NewsCard key={n.id || i} article={n} />)}</div>
            : <ListMessage>暫無競品報導</ListMessage>}
        </PRSummaryCard>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 items-stretch">
        <PRSummaryCard title="新聞稿曝光成效" icon="chart" onViewAll={() => onNavigate('exposure')}>
          <ExposureSummary records={mediaExposure} status={mediaExposureStatus} onRetry={refreshMediaExposure} />
        </PRSummaryCard>

        <KeyMediaPanel articles={validTranscend} status={prStatus} limit={OVERVIEW_LIMIT}
          onViewAll={() => onNavigate('exposure')} />
      </div>
    </div>
  );
}
