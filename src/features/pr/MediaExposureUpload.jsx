/* global sessionStorage, FileReader */
import { useRef, useState } from 'react';

// 網站沒有登入機制，Firestore 也不允許客戶端寫入，所以上傳走後端 Cloud
// Function（Hosting rewrite 到 /api/media-exposure），用「上傳通行碼」把關。
// 流程跟 CLI 一樣分兩步：先「檢查」（只解析、不寫入），確認筆數與無效列後
// 再「確認匯入」。見 functions/media_exposure_upload.py。
export const UPLOAD_ENDPOINT = '/api/media-exposure';
const PASSCODE_KEY = 'mediaExposureUploadPasscode';
const MAX_FILES = 6;

function readStoredPasscode() {
  try { return sessionStorage.getItem(PASSCODE_KEY) || ''; } catch { return ''; }
}
function storePasscode(value) {
  try { sessionStorage.setItem(PASSCODE_KEY, value); } catch { /* 無痕模式等情況不影響上傳 */ }
}

function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(',')[1] || '');
    reader.onerror = () => reject(new Error(`無法讀取「${file.name}」`));
    reader.readAsDataURL(file);
  });
}

async function callUpload({ passcode, mode, files, approveSkippingInvalid }) {
  const body = {
    passcode, mode,
    files: await Promise.all(files.map(async f => ({ name: f.name, data: await fileToBase64(f) }))),
  };
  if (approveSkippingInvalid != null) body.approveSkippingInvalid = approveSkippingInvalid;
  let res;
  try {
    res = await fetch(UPLOAD_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  } catch {
    throw new Error('無法連線到伺服器，請檢查網路後再試');
  }
  let data = null;
  try { data = await res.json(); } catch { /* 非 JSON 回應 */ }
  if (!res.ok || !data?.ok) {
    throw new Error(data?.error || `上傳失敗（HTTP ${res.status}）`);
  }
  return data;
}

function Stat({ label, value, hint }) {
  return (
    <div className="rounded-xl border border-gray-700/60 bg-gray-900 p-3 text-center">
      <p className="text-xs text-gray-500">{label}</p>
      <p className="text-xl font-bold text-ink mt-0.5 tabular-nums">{value}</p>
      {hint && <p className="text-xs text-gray-600 mt-0.5">{hint}</p>}
    </div>
  );
}

export default function MediaExposureUpload({ onImported = () => {} }) {
  const inputRef = useRef(null);
  const [passcode, setPasscode] = useState(readStoredPasscode);
  const [files, setFiles] = useState([]);
  const [phase, setPhase] = useState('idle'); // idle | checking | checked | importing | done
  const [result, setResult] = useState(null);
  const [error, setError] = useState('');
  const [ackInvalid, setAckInvalid] = useState(false);

  const busy = phase === 'checking' || phase === 'importing';
  const invalidCount = result?.invalidRows?.length || 0;
  const canImport = phase === 'checked' && result?.uniqueRecords > 0 && (invalidCount === 0 || ackInvalid);

  const pickFiles = list => {
    const picked = [...list].filter(f => f.name.toLowerCase().endsWith('.xlsx'));
    if (list.length && picked.length !== list.length) setError('只接受 .xlsx 檔案，其他檔案已略過');
    else setError('');
    if (picked.length > MAX_FILES) {
      setError(`一次最多 ${MAX_FILES} 個檔案`);
      return;
    }
    setFiles(picked);
    setResult(null); setAckInvalid(false);
    setPhase('idle');
  };

  const run = async mode => {
    if (!passcode.trim()) { setError('請輸入上傳通行碼'); return; }
    setError('');
    setPhase(mode === 'check' ? 'checking' : 'importing');
    try {
      const data = await callUpload({
        passcode: passcode.trim(), mode, files,
        approveSkippingInvalid: mode === 'commit' && invalidCount ? invalidCount : undefined,
      });
      storePasscode(passcode.trim());
      setResult(data);
      if (mode === 'commit') {
        setPhase('done');
        setFiles([]);
        if (inputRef.current) inputRef.current.value = '';
        onImported(data);
      } else {
        setPhase('checked');
      }
    } catch (e) {
      setError(e.message);
      setPhase(mode === 'commit' ? 'checked' : 'idle');
    }
  };

  return (
    <div className="rounded-xl border border-gray-700/60 bg-gray-900 p-4 mb-4 space-y-3">
      <div>
        <p className="text-sm font-semibold text-gray-200">上傳 Excel 匯入人工確認曝光</p>
        <p className="text-xs text-gray-500 mt-1">
          欄位需包含「日期、媒體、新聞標題（或標題）、連結（或網址）」，「記者」「備註」可有可無；備註只存在後台，不會顯示在網站。
          重複上傳同一批檔案不會產生重複資料。
        </p>
      </div>

      <div className="flex flex-col sm:flex-row gap-2">
        <label className="flex-1 min-w-0">
          <span className="sr-only">選擇 Excel 檔案</span>
          <input ref={inputRef} type="file" accept=".xlsx" multiple
            onChange={e => pickFiles(e.target.files)}
            aria-label="選擇 Excel 檔案"
            className="block w-full text-sm text-gray-400 file:mr-3 file:rounded-lg file:border file:border-gray-700/60 file:bg-gray-800 file:px-3 file:py-1.5 file:text-xs file:text-gray-300 hover:file:bg-gray-700" />
        </label>
        <input type="password" value={passcode} autoComplete="off"
          onChange={e => setPasscode(e.target.value)}
          placeholder="上傳通行碼" aria-label="上傳通行碼"
          className="sm:w-44 rounded-xl border border-gray-700/60 px-3 py-1.5 text-sm outline-none focus:border-red-700" />
        <button onClick={() => run('check')} disabled={busy || files.length === 0}
          className="text-sm px-3.5 py-1.5 rounded-lg border border-gray-700/60 text-gray-300 hover:bg-gray-800 transition disabled:opacity-40 disabled:cursor-not-allowed shrink-0">
          {phase === 'checking' ? '檢查中…' : '① 檢查檔案'}
        </button>
      </div>

      {files.length > 0 && (
        <p className="text-xs text-gray-500">已選擇 {files.length} 個檔案：{files.map(f => f.name).join('、')}</p>
      )}

      {error && <p role="alert" className="text-sm text-red-400">⚠ {error}</p>}

      {result && phase !== 'done' && (
        <div className="space-y-3">
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
            <Stat label="讀到資料列" value={result.rowsSeen} />
            <Stat label="不重複曝光" value={result.uniqueRecords}
              hint={result.duplicateRows ? `${result.duplicateRows} 列網址重複，已合併` : ''} />
            <Stat label="新增 / 已存在" value={`${result.newRecords} / ${result.existingRecords}`}
              hint="已存在的會以本次內容更新" />
            <Stat label="涵蓋媒體" value={result.uniqueMedia} />
          </div>
          <p className="text-xs text-gray-500">
            各月筆數：{Object.entries(result.byMonth).map(([m, n]) => `${m}（${n}）`).join('、') || '—'}
          </p>

          {invalidCount > 0 && (
            <div className="rounded-xl border border-yellow-700/40 bg-yellow-900/10 p-3 text-sm">
              <p className="text-yellow-500 font-medium">有 {invalidCount} 列資料不完整，無法匯入：</p>
              <ul className="mt-1 text-xs text-gray-400 space-y-0.5 max-h-32 overflow-y-auto">
                {result.invalidRows.map(r => (
                  <li key={`${r.file}-${r.sheet}-${r.row}`}>
                    {r.file}／工作表「{r.sheet}」第 {r.row} 列：{r.reason}
                  </li>
                ))}
              </ul>
              <label className="flex items-center gap-2 mt-2 text-xs text-gray-300 cursor-pointer">
                <input type="checkbox" checked={ackInvalid} onChange={e => setAckInvalid(e.target.checked)} />
                我確認略過這 {invalidCount} 列，只匯入其餘資料
              </label>
            </div>
          )}

          <button onClick={() => run('commit')} disabled={!canImport || busy}
            className="text-sm px-4 py-2 rounded-lg bg-red-800 text-white hover:bg-red-700 transition disabled:opacity-40 disabled:cursor-not-allowed">
            {phase === 'importing' ? '匯入中…' : `② 確認匯入 ${result.uniqueRecords} 筆`}
          </button>
        </div>
      )}

      {phase === 'done' && result && (
        <p role="status" className="text-sm text-green-500">
          ✓ 已匯入 {result.written} 筆人工確認曝光（略過 {invalidCount} 列無效資料），列表會自動更新。
        </p>
      )}
    </div>
  );
}
