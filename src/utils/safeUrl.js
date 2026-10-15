/* global URL */

/**
 * 只允許 http / https 的安全網址。回傳正規化後的網址字串；不安全或無法解析回傳 ''。
 *
 * 拒絕：javascript: / data: / vbscript: / file: 等非 http(s) 通訊協定、內含帳號密碼
 * （https://user:pass@host）、含空白或控制字元、沒有主機名稱。
 * 用在所有「由資料庫內容產生、可點擊」的連結，避免資料被污染時變成 XSS 入口。
 */
export function safeHttpUrl(value) {
  if (typeof value !== 'string') return '';
  const raw = value.trim();
  if (!raw || raw.length > 2048) return '';
  // 空白與控制字元（含換行、NUL）：瀏覽器解析網址時會悄悄移除它們，
  // 例如 "java\nscript:..." 會被當成 javascript:，所以直接拒絕。
  // eslint-disable-next-line no-control-regex
  if (/[\s\u0000-\u001f\u007f]/.test(raw)) return '';
  let url;
  try {
    url = new URL(raw);
  } catch {
    return '';
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return '';
  if (!url.hostname) return '';
  if (url.username || url.password) return '';
  return url.href;
}
