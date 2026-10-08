import { useState, useEffect, useCallback } from 'react';

import Card from '../../components/Card.jsx';
import Icon from '../../components/Icon.jsx';
import { getDb, collection, doc, getDoc, getDocs, query, orderBy, limit } from '../../services/firebase.js';

// 排程總覽（跟 functions/main.py 的實際排程設定同步維護）——
// cadence 只是給人看的說明文字，不參與判斷邏輯。
const JOBS = [
  { key: 'stocks', label: '即時股價', fn: 'stocks_job', cadence: '交易日 09:00–13:35 每分鐘' },
  { key: 'news', label: 'RSS 新聞', fn: 'news_job', cadence: '每 15 分鐘' },
  { key: 'trading', label: '每日交易資料（開收盤／三大法人）', fn: 'trading_job', cadence: '交易日 13:40 / 17:40' },
  { key: 'finance', label: '財務資料（月營收／季損益／股利／重訊）', fn: 'finance_job', cadence: '每天 17:30（申報期加密）' },
  { key: 'digest_tw', label: '台灣 DRAM/Flash 產業摘要信', fn: 'tw_dram_digest_job', cadence: '平日 08:00' },
  { key: 'digest_us', label: '美國 DRAM/Flash 產業摘要信', fn: 'us_dram_digest_job', cadence: '平日 16:30' },
  { key: 'news_cleanup', label: '新聞保存期限清理', fn: 'news_cleanup_job', cadence: '每天 02:30' },
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
    const hours = (ms == null) ? null : (now - ms) / 3_600_000;
    if (hours != null && hours > 0.5) return { level: 'warn', text: `最新一篇新聞是 ${fmtAgo(ms, now)}抓到的` };
    return { level: 'ok', text: `最新一篇新聞是 ${fmtAgo(ms, now)}抓到的` };
  }
  return null;
}

function StatusBadge({ level }) {
  const cfg = {
    ok: { text: '正常', cls: 'text-green-400' },
    warn: { text: '資料偏舊', cls: 'text-yellow-400' },
    stale: { text: '過期', cls: 'text-yellow-400' },
    error: { text: '執行失敗', cls: 'text-red-400' },
    unknown: { text: '尚無紀錄', cls: 'text-gray-500' },
  }[level] || { text: '尚無紀錄', cls: 'text-gray-500' };
  return <span className={`inline-flex items-center gap-1 text-sm font-semibold ${cfg.cls}`}><Icon name="dot" className="text-[1.3em]" />{cfg.text}</span>;
}

function JobRow({ job, statusDoc, dataDoc, now }) {
  const hasError = !!statusDoc?.lastError;
  const lastSuccessMs = tsToMs(statusDoc?.lastSuccessAt);
  const ageHours = lastSuccessMs == null ? null : (now - lastSuccessMs) / 3_600_000;
  const isRunStale = !hasError && (lastSuccessMs == null || ageHours > STALE_AFTER_HOURS);
  const freshness = dataFreshnessNote(job.key, dataDoc, now);

  let level = 'ok';
  if (hasError) level = 'error';
  else if (isRunStale) level = 'stale';
  else if (freshness && (freshness.level === 'warn' || freshness.level === 'stale')) level = 'warn';

  return (
    <div className="border-b border-gray-800/40 py-3 last:border-0">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div>
          <p className="text-sm font-medium text-gray-200">{job.label}</p>
          <p className="text-xs text-gray-600">{job.fn} · {job.cadence}</p>
        </div>
        <StatusBadge level={level} />
      </div>
      <p className="text-xs text-gray-500 mt-1">
        上次成功執行：{lastSuccessMs == null ? '從未' : `${fmtAgo(lastSuccessMs, now)}`}
      </p>
      {hasError && (
        <p className="text-xs text-red-400/90 mt-1 break-all">
          <Icon name="alert" /> {statusDoc.lastError}
          {statusDoc.lastErrorAt && ` （${fmtAgo(tsToMs(statusDoc.lastErrorAt), now)}）`}
        </p>
      )}
      {freshness && (
        <p className={`text-xs mt-1 ${freshness.level === 'ok' ? 'text-gray-600' : 'text-yellow-500/90'}`}>
          {freshness.level === 'ok' ? <Icon name="check" /> : <Icon name="alert" />} {freshness.text}
        </p>
      )}
    </div>
  );
}

function AiWorkerRow({ statusDoc, now }) {
  if (!statusDoc) {
    return (
      <div className="border-b border-gray-800/40 py-3 last:border-0">
        <div className="flex items-center justify-between gap-3 flex-wrap">
          <div>
            <p className="text-sm font-medium text-gray-200">本機 AI Worker（tools/local_ai_worker.py）</p>
            <p className="text-xs text-gray-600">跑在使用者自己的電腦上，每天 02:35 由 Cloud Functions 彙總一次狀態</p>
          </div>
          <StatusBadge level="unknown" />
        </div>
        <p className="text-xs text-gray-500 mt-1">尚無彙總紀錄</p>
      </div>
    );
  }

  const pending = statusDoc.pendingCount ?? 0;
  const lastInsightMs = tsToMs(statusDoc.lastInsightAt);
  const insightAgeDays = lastInsightMs == null ? null : (now - lastInsightMs) / 86_400_000;
  // worker 完全沒在跑：積壓 > 0 且最近一次分析是很久以前（或從未有過）。
  const looksDown = pending > 0 && (insightAgeDays == null || insightAgeDays > 2);
  const level = looksDown ? 'stale' : 'ok';

  return (
    <div className="border-b border-gray-800/40 py-3 last:border-0">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div>
          <p className="text-sm font-medium text-gray-200">本機 AI Worker（tools/local_ai_worker.py）</p>
          <p className="text-xs text-gray-600">跑在使用者自己的電腦上，每天 02:35 由 Cloud Functions 彙總一次狀態</p>
        </div>
        <StatusBadge level={level} />
      </div>
      <p className="text-xs text-gray-500 mt-1">
        待處理新聞分析：{pending} 筆 · 最近一次完成分析：{lastInsightMs == null ? '從未' : fmtAgo(lastInsightMs, now)}
      </p>
      {looksDown && (
        <p className="text-xs text-yellow-500/90 mt-1">
          <Icon name="alert" /> 有積壓工作但很久沒有新的分析結果，本機 worker 可能沒有在執行
        </p>
      )}
    </div>
  );
}

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

  return (
    <div className="space-y-4 fade-in">
      <Card title="排程健康狀態" icon="activity"
        actions={
          <button onClick={load} disabled={loading}
            className="text-xs px-2.5 py-1 rounded-lg border border-gray-700/60 text-gray-400 hover:text-gray-200 hover:bg-gray-800 transition disabled:opacity-40">
            {loading ? '檢查中…' : '↻ 重新檢查'}
          </button>
        }>
        <p className="text-xs text-gray-600 mb-3">
          {checkedAt ? `本頁最後檢查時間：${checkedAt.toLocaleTimeString('zh-TW', { hour: '2-digit', minute: '2-digit' })} · ` : ''}
          各排程實際成功/失敗紀錄每天由 Cloud Functions 寫入，這裡不是即時監控，是每次開啟這頁時查詢一次目前狀態。
        </p>
        {error ? (
          <div className="h-20 flex items-center justify-center text-red-400 text-sm"><Icon name="alert" /> 載入失敗，請重試</div>
        ) : loading && !jobStatus ? (
          <div className="h-20 flex items-center justify-center text-gray-600 text-sm">載入中…</div>
        ) : (
          <div>
            {JOBS.map(job => {
              let dataDoc = null;
              if (job.key === 'stocks') dataDoc = stocksData;
              else if (job.key === 'finance') dataDoc = revenueData;
              else if (job.key === 'trading') dataDoc = dailyData;
              else if (job.key === 'news') dataDoc = latestNewsAt;
              return (
                <JobRow key={job.key} job={job} statusDoc={jobStatus?.[job.key]} dataDoc={dataDoc} now={now} />
              );
            })}
            <AiWorkerRow statusDoc={jobStatus?.ai_worker} now={now} />
          </div>
        )}
      </Card>
    </div>
  );
}
