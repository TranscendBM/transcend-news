import Card from '../../components/Card.jsx';
import Icon from '../../components/Icon.jsx';
import { tagClass } from '../../components/tagStyles.js';
import { useNow } from '../../hooks/useNow.js';
import { exportMediaExposureExcel } from '../../utils/formatting.js';
import { safeHttpUrl } from '../../utils/safeUrl.js';
import { taipeiMonthStart } from '../../utils/dates.js';
import MediaExposureUpload from './MediaExposureUpload.jsx';
import { usePRState } from './prState.jsx';

// ═══════════════════════════════════════════════════════════
// PR — 人工彙整曝光（與自動新聞監測分開計算）：Excel 上傳、曝光分析入口、匯出曝光明細、最新清單
// ═══════════════════════════════════════════════════════════
function exposureDate(record) {
  return record.exposureDate?.toDate
    ? record.exposureDate.toDate()
    : new Date(record.exposureDate || 0);
}

export function ManualExposurePanel({
  records = [], status = 'idle', onRetry = () => {}, onImported = () => {}, onOpenInsights = () => {},
}) {
  const [uploadOpen, setUploadOpen] = usePRState('exposure.uploadOpen', false);
  const now = useNow();
  const monthStart = taipeiMonthStart(now);
  const monthRecords = records.filter(record => exposureDate(record) >= monthStart);
  const uniqueMedia = new Set(records.map(record => record.mediaName).filter(Boolean)).size;
  const latest = records.slice(0, 12);

  return (
    <Card title="人工彙整曝光" icon="checkcircle"
      actions={
        <div className="flex gap-1.5 max-w-full flex-wrap justify-end">
          <button onClick={onOpenInsights} disabled={records.length === 0}
            className="text-sm px-3.5 py-1.5 rounded-lg border border-red-700/50 text-red-400 hover:bg-red-900/20 transition disabled:opacity-40 disabled:cursor-not-allowed">
            <Icon name="chart" /> 曝光分析 <Icon name="chevronright" />
          </button>
          <button onClick={() => setUploadOpen(open => !open)} aria-expanded={uploadOpen}
            className="text-sm px-3.5 py-1.5 rounded-lg border border-gray-700/60 text-gray-400 hover:text-gray-200 hover:bg-gray-800 transition">
            {uploadOpen ? '收合上傳' : <><Icon name="upload" /> 上傳 Excel</>}
          </button>
          {/* 這顆匯出「全部已載入的人工彙整曝光」原始清單（不受上面新聞稿成效的篩選影響），
              跟「新聞稿曝光成效」的匯出（目前篩選結果＋主題彙整）內容不同，所以按鈕名稱分開標示。 */}
          <button onClick={() => exportMediaExposureExcel(records)}
            disabled={records.length === 0}
            className="text-sm px-3.5 py-1.5 rounded-lg border border-gray-700/60 text-gray-400 hover:text-gray-200 hover:bg-gray-800 transition disabled:opacity-40 disabled:cursor-not-allowed">
            <Icon name="download" /> 匯出曝光明細
          </button>
        </div>
      }>
      <p className="text-xs text-gray-500 mb-4">
        新聞稿發布後由同仁人工核對的實際曝光。此區與自動新聞監測分開統計，內部備註不會顯示在網站。
      </p>

      {uploadOpen && <MediaExposureUpload onImported={onImported} />}

      {status === 'error' ? (
        <div className="py-8 text-center text-sm text-red-400">
          <p><Icon name="alert" /> 人工曝光載入失敗</p>
          <button onClick={onRetry}
            className="mt-2 text-xs px-3 py-1 rounded-lg border border-red-700/60 text-red-300 hover:bg-red-900/30 transition">
            重試
          </button>
        </div>
      ) : (
        <>
          <div className="grid grid-cols-3 gap-3 mb-4">
            {[
              ['本月人工彙整', monthRecords.length],
              ['已載入曝光', records.length],
              ['涵蓋媒體', uniqueMedia],
            ].map(([label, value]) => (
              <div key={label} className="rounded-xl border border-gray-700/60 bg-gray-900 p-3 text-center">
                <p className="text-xs text-gray-500">{label}</p>
                <p className="text-2xl font-bold text-ink mt-1 tabular-nums">
                  {status === 'loading' ? '…' : value}
                </p>
              </div>
            ))}
          </div>

          {latest.length > 0 ? (
            <div className="divide-y divide-gray-800/70">
              {latest.map(record => {
                const date = exposureDate(record);
                return (
                  <div key={record.id} className="py-2.5 flex gap-3 items-start">
                    <span className={tagClass('green', 'shrink-0')}>
                      人工確認
                    </span>
                    <div className="min-w-0 flex-1">
                      {safeHttpUrl(record.link)
                        ? (
                          <a href={safeHttpUrl(record.link)} target="_blank" rel="noopener noreferrer"
                            className="text-sm text-ink hover:text-red-500 leading-snug line-clamp-2">
                            {record.title}
                          </a>
                        )
                        : <span className="text-sm text-ink leading-snug line-clamp-2">{record.title}</span>}
                      <p className="text-xs text-gray-500 mt-1">
                        {record.mediaName || '未知媒體'}
                        {record.reporter ? `｜${record.reporter}` : ''}
                        {!isNaN(date.getTime())
                          ? `｜${date.toLocaleDateString('zh-TW', { timeZone: 'Asia/Taipei' })}`
                          : ''}
                      </p>
                    </div>
                  </div>
                );
              })}
            </div>
          ) : status === 'ready' ? (
            <div className="py-8 text-center text-sm text-gray-600">尚未匯入人工彙整曝光</div>
          ) : null}
          {records.length > latest.length && (
            <p className="text-xs text-gray-600 text-right mt-3">顯示最新 {latest.length} 筆，共 {records.length} 筆</p>
          )}
        </>
      )}
    </Card>
  );
}
