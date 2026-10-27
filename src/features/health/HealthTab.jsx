import { useState, useEffect, useCallback } from 'react';

import Icon from '../../components/Icon.jsx';
import { ActionButton, DataStateBanner, ErrorState, LastUpdatedLabel, LoadingSkeleton, PageHeader, SectionCard, StatusBadge } from '../../components/ui/index.js';
import { getDb, collection, doc, getDoc, getDocs, query, orderBy, limit } from '../../services/firebase.js';
import { fmtNextRun, nextRun } from './schedule.js';

// 排程總覽（跟 functions/main.py 的實際排程設定同步維護）——
// cadence 只是給人看的說明文字；schedule 用來估算「下一次預計執行」，都不參與健康判斷。
// （每日產業新聞摘要信 tw/us_dram_digest_job 已停止並移除，所以不在這裡。）
const JOBS = [
  { key: 'stocks', label: '即時股價', fn: 'stocks_job', cadence: '交易日 09:00–13:35 每分鐘', schedule: { window: [[9, 0], [13, 35]], weekdays: true } },
  { key: 'news', label: 'RSS 新聞', fn: 'news_job', cadence: '每 15 分鐘', schedule: { every: 15 } },
  { key: 'trading', label: '每日交易資料（開收盤／三大法人）', fn: 'trading_job', cadence: '交易日 13:40 / 17:40', schedule: { daily: [[13, 40], [17, 40]], weekdays: true } },
  { key: 'finance', label: '財務資料（月營收／季損益／股利／重訊）', fn: 'finance_job', cadence: '每天 17:30（申報期加密）', schedule: { daily: [[17, 30]] } },
  { key: 'press_release_sync', label: '新聞稿稿單同步與曝光配對', fn: 'press_release_sync_job', cadence: '每天 06:30', schedule: { daily: [[6, 30]] } },
  { key: 'topic_cluster', label: '事件話題聚類', fn: 'topic_cluster_job', cadence: '每 30 分鐘', schedule: { every: 30 } },
  { key: 'news_cleanup', label: '新聞保存期限清理', fn: 'news_cleanup_job', cadence: '每天 02:30', schedule: { daily: [[2, 30]] } },
];

// 排程本身「多久沒成功執行一次」才算異常——只抓「函式本身丟例外」
// 這種硬性失敗，寬鬆抓 3 天（涵蓋長週末），避免誤報。
const STALE_AFTER_HOURS = 72;

function tsToMs(ts) {
  if (!ts) return null;
  if (typeof ts.toDate === 'function') return ts.toDate().getTime();
  if (typeof ts.seconds === 'number') return ts.seconds * 1000;
  return null;
}

function fmtAgo(ms, now) {
  if (ms == null) return '從未';
  const hours = (now - ms) / 3_600_000;
  if (hours < 1) return `${Math.round(hours * 60)} 分鐘前`;
  if (hours < 48) return `${hours.toFixed(1)} 小時前`;
  return `${(hours / 24).toFixed(1)} 天前`;
}

// job_status/{key} 只能抓到「函式本身丟例外」的硬性失敗；stocks_job/
// finance_job 這類「函式順利跑完、只是外部 API 失敗被內部 try/except
// 吞掉、沒寫入新資料」的軟性失敗，得另外比對實際資料的 updatedAt。
function dataFreshnessNote(jobKey, dataDoc, now) {
  if (jobKey === 'stocks') {
    if (!dataDoc) return null;
    const ages = Object.values(dataDoc)
      .map(v => tsToMs(v?.updatedAt))
      .filter(ms => ms != null);
    if (!ages.length) return { level: 'stale', text: '尚未取得任何股價資料' };
    const newestMs = Math.max(...ages);
    const hours = (now - newestMs) / 3_600_000;
    // 30 分鐘門檻只在真的有意義時才提醒；非交易時段本來就不會更新，
    // 這裡不特別排除非交易時段——資訊性質，讓人自行判斷即可。
    if (hours > 0.5) return { level: 'warn', text: `最新一檔股價也是 ${fmtAgo(newestMs, now)}更新` };
    return { level: 'ok', text: `最新股價 ${fmtAgo(newestMs, now)}更新` };
  }
  if (jobKey === 'finance') {
    const ms = tsToMs(dataDoc?.updatedAt);
    if (ms == null) return { level: 'stale', text: '尚未取得月營收資料' };
    const hours = (now - ms) / 3_600_000;
    if (hours > 30) return { level: 'warn', text: `revenue/2451 是 ${fmtAgo(ms, now)}更新` };
    return { level: 'ok', text: `revenue/2451 是 ${fmtAgo(ms, now)}更新` };
  }
  if (jobKey === 'trading') {
    const ms = tsToMs(dataDoc?.updatedAt);
    if (ms == null) return null;
    return { level: 'ok', text: `daily/2451 是 ${fmtAgo(ms, now)}更新` };
  }
  if (jobKey === 'news') {
    const ms = dataDoc;
    if (ms == null) return null;
    const hours = (now - ms) / 3_600_000;
    if (hours > 0.5) return { level: 'warn', text: `最新一篇新聞是 ${fmtAgo(ms, now)}抓到的` };
    return { level: 'ok', text: `最新一篇新聞是 ${fmtAgo(ms, now)}抓到的` };
  }
  return null;
}

// 單一排程的狀態等級：error（執行失敗）> stale（過期）> warn（資料偏舊）> ok
function jobLevel(statusDoc, freshness, now) {
  if (statusDoc?.lastError) return 'error';
  const lastSuccessMs = tsToMs(statusDoc?.lastSuccessAt);
  if (lastSuccessMs == null || (now - lastSuccessMs) / 3_600_000 > STALE_AFTER_HOURS) return 'stale';
  if (freshness && (freshness.level === 'warn' || freshness.level === 'stale')) return 'warn';
  return 'ok';
}

const LEVEL_BADGE = {
  ok: { tone: 'ok', text: '正常' },
  warn: { tone: 'warn', text: '資料偏舊' },
  stale: { tone: 'warn', text: '過期' },
  error: { tone: 'error', text: '執行失敗' },
  unknown: { tone: 'neutral', text: '尚無紀錄' },
};
const SEVERITY = { error: 0, stale: 1, warn: 2, unknown: 3, ok: 4 };

function LevelBadge({ level }) {
  const b = LEVEL_BADGE[level] || LEVEL_BADGE.unknown;
  return <StatusBadge tone={b.tone}>{b.text}</StatusBadge>;
}

// 一列排程：先給結論（狀態徽章），再給「最後成功／下一次預計／最近錯誤／資料是否過期」；
// 函式名稱等技術細節預設收合。
function HealthRow({ title, level, lastSuccessMs, nextText, error, errorAt, freshness, extra, tech, now }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="border-b border-ui-line py-3 last:border-0">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <p className="text-sm font-medium text-ui-text min-w-0">{title}</p>
        <LevelBadge level={level} />
      </div>
      <dl className="mt-1.5 grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-0.5 text-xs text-ui-muted">
        <div><dt className="inline">上次成功執行：</dt><dd className="inline">{lastSuccessMs == null ? '從未' : fmtAgo(lastSuccessMs, now)}</dd></div>
        {nextText && <div><dt className="inline">下一次預計：</dt><dd className="inline">{nextText}</dd></div>}
      </dl>
      {extra && <p className="text-xs text-ui-muted mt-1">{extra}</p>}
      {error && (
        <p className="text-xs text-[color:var(--danger)] mt-1 break-all">
          <Icon name="alert" /> 最近錯誤：{error}
          {errorAt && ` （${fmtAgo(tsToMs(errorAt), now)}）`}
        </p>
      )}
      {freshness && (
        <p className={`text-xs mt-1 ${freshness.level === 'ok' ? 'text-ui-muted' : 'text-[color:var(--warn)]'}`}>
          <Icon name={freshness.level === 'ok' ? 'check' : 'alert'} /> {freshness.text}
        </p>
      )}
      {tech && (
        <>
          <button type="button" onClick={() => setOpen(o => !o)} aria-expanded={open}
            className="ui-focus mt-1 inline-flex items-center gap-1 text-xs text-ui-secondary underline min-h-8">
            技術細節<Icon name={open ? 'chevronup' : 'chevrondown'} />
          </button>
          {open && <p className="text-xs text-ui-muted break-all">{tech}</p>}
        </>
      )}
    </div>
  );
}

function JobRow({ job, statusDoc, dataDoc, now }) {
  const freshness = dataFreshnessNote(job.key, dataDoc, now);
  const level = jobLevel(statusDoc, freshness, now);
  return (
    <HealthRow title={job.label} level={level} now={now}
      lastSuccessMs={tsToMs(statusDoc?.lastSuccessAt)}
      nextText={fmtNextRun(nextRun(job.schedule, new Date(now)), new Date(now))}
      error={statusDoc?.lastError} errorAt={statusDoc?.lastErrorAt} freshness={freshness}
      tech={`${job.fn} · ${job.cadence}`} />
  );
}

const AI_TITLE = '本機 AI Worker（tools/local_ai_worker.py）';
const AI_TECH = '跑在使用者自己的電腦上，每天 02:35 由 Cloud Functions 彙總一次狀態';

function aiWorkerLevel(statusDoc, now) {
  if (!statusDoc) return 'unknown';
  const pending = statusDoc.pendingCount ?? 0;
  const lastInsightMs = tsToMs(statusDoc.lastInsightAt);
  const insightAgeDays = lastInsightMs == null ? null : (now - lastInsightMs) / 86_400_000;
  // worker 完全沒在跑：積壓 > 0 且最近一次分析是很久以前（或從未有過）。
  return pending > 0 && (insightAgeDays == null || insightAgeDays > 2) ? 'stale' : 'ok';
}

function AiWorkerRow({ statusDoc, level, now }) {
  if (!statusDoc) {
    return <HealthRow title={AI_TITLE} level="unknown" now={now} extra="尚無彙總紀錄" tech={AI_TECH} />;
  }
  const pending = statusDoc.pendingCount ?? 0;
  const lastInsightMs = tsToMs(statusDoc.lastInsightAt);
  return (
    <HealthRow title={AI_TITLE} level={level} now={now} tech={AI_TECH}
      nextText="每天 02:35 彙總"
      extra={`待處理新聞分析：${pending} 筆 · 最近一次完成分析：${lastInsightMs == null ? '從未' : fmtAgo(lastInsightMs, now)}`}
      freshness={level === 'stale' ? { level: 'warn', text: '有積壓工作但很久沒有新的分析結果，本機 worker 可能沒有在執行' } : null} />
  );
}

const OVERALL = {
  error: { state: 'error', title: '異常：有排程執行失敗', hint: '請先處理下方「需要處理」的項目。' },
  warn: { state: 'stale', title: '注意：部分排程或資料已過期', hint: '資料可能不是最新；請看下方「需要處理」的項目。' },
};

export function HealthTab() {
  const [jobStatus, setJobStatus] = useState(null);
  const [stocksData, setStocksData] = useState(null);
  const [dailyData, setDailyData] = useState(null);
  const [revenueData, setRevenueData] = useState(null);
  const [latestNewsAt, setLatestNewsAt] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [checkedAt, setCheckedAt] = useState(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(false);
    try {
      const db = getDb();
      const [statusSnap, stocksSnap, dailySnap, revenueSnap, newsSnap] = await Promise.all([
        getDocs(collection(db, 'job_status')),
        getDoc(doc(db, 'stocks', 'latest')),
        getDoc(doc(db, 'daily', '2451')),
        getDoc(doc(db, 'revenue', '2451')),
        getDocs(query(collection(db, 'news'), orderBy('fetchedAt', 'desc'), limit(1))),
      ]);

      const statusMap = {};
      statusSnap.forEach(d => { statusMap[d.id] = d.data(); });
      setJobStatus(statusMap);
      setStocksData(stocksSnap.exists() ? stocksSnap.data() : null);
      setDailyData(dailySnap.exists() ? dailySnap.data() : null);
      setRevenueData(revenueSnap.exists() ? revenueSnap.data() : null);
      const newsDoc = newsSnap.docs[0]?.data();
      setLatestNewsAt(newsDoc ? tsToMs(newsDoc.fetchedAt) : null);
      setCheckedAt(new Date());
    } catch (e) {
      console.error('HealthTab load:', e);
      setError(true);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const now = Date.now();
  const dataFor = key => ({ stocks: stocksData, finance: revenueData, trading: dailyData, news: latestNewsAt })[key] ?? null;

  // 每一列先算好狀態，才能依嚴重度分組與排序（失敗、過期的排在最前面）
  const rows = jobStatus ? [
    ...JOBS.map(job => {
      const statusDoc = jobStatus[job.key];
      const level = jobLevel(statusDoc, dataFreshnessNote(job.key, dataFor(job.key), now), now);
      return { id: job.key, level, node: <JobRow key={job.key} job={job} statusDoc={statusDoc} dataDoc={dataFor(job.key)} now={now} /> };
    }),
    (() => {
      const level = aiWorkerLevel(jobStatus.ai_worker, now);
      return { id: 'ai_worker', level, node: <AiWorkerRow key="ai_worker" statusDoc={jobStatus.ai_worker} level={level} now={now} /> };
    })(),
  ].sort((a, b) => SEVERITY[a.level] - SEVERITY[b.level]) : [];

  const attention = rows.filter(r => r.level !== 'ok' && r.level !== 'unknown');
  const fine = rows.filter(r => r.level === 'ok' || r.level === 'unknown');
  const overall = attention.some(r => r.level === 'error') ? 'error' : attention.length ? 'warn' : 'ok';

  return (
    <div className="space-y-4 fade-in">
      <PageHeader title="系統健康" description="排程的實際成功／失敗紀錄由 Cloud Functions 寫入；這裡不是即時監控，是每次開啟本頁時查詢一次目前狀態。"
        meta={<LastUpdatedLabel date={checkedAt} label="最後檢查" />}
        actions={
          <ActionButton onClick={load} disabled={loading} icon="refresh" aria-label="重新檢查">
            {loading ? '檢查中…' : '重新檢查'}
          </ActionButton>
        } />

      {error ? (
        <ErrorState message="載入失敗，請重試" onRetry={load} />
      ) : loading && !jobStatus ? (
        <LoadingSkeleton lines={5} className="py-4" label="檢查排程狀態中" />
      ) : (
        <>
          {overall === 'ok'
            ? <div className="flex items-center gap-2 text-sm"><StatusBadge tone="ok">整體正常</StatusBadge><span className="text-ui-muted">所有排程近期都有成功執行，資料沒有過期。</span></div>
            : <DataStateBanner state={OVERALL[overall].state} title={OVERALL[overall].title}>{OVERALL[overall].hint}</DataStateBanner>}

          {attention.length > 0 && (
            <SectionCard title={`需要處理（${attention.length}）`} icon="alert">
              {attention.map(r => r.node)}
            </SectionCard>
          )}
          <SectionCard title={`運作正常（${fine.length}）`} icon="checkcircle">
            {fine.length ? fine.map(r => r.node) : <p className="text-sm text-ui-muted">目前沒有運作正常的項目。</p>}
          </SectionCard>
        </>
      )}
    </div>
  );
}
