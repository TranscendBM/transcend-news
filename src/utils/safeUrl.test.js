import { describe, it, expect } from 'vitest';

import { safeHttpUrl } from './safeUrl.js';

describe('safeHttpUrl', () => {
  it('http / https 網址通過並回傳正規化後的網址', () => {
    expect(safeHttpUrl('https://example.com/a?x=1')).toBe('https://example.com/a?x=1');
    expect(safeHttpUrl('  http://example.com  ')).toBe('http://example.com/');
    expect(safeHttpUrl('HTTPS://Example.COM/Path')).toBe('https://example.com/Path');
  });

  it('拒絕 javascript: / data: / vbscript: / file: 等危險協定（含大小寫與夾雜空白字元的變形）', () => {
    [
      'javascript:alert(1)', 'JaVaScRiPt:alert(1)', 'java\nscript:alert(1)', 'java\tscript:alert(1)',
      ' javascript:alert(1)', 'data:text/html,<script>alert(1)</script>', 'vbscript:msgbox(1)',
      'file:///etc/passwd', 'ftp://example.com/x', 'blob:https://example.com/abc',
    ].forEach(url => expect(safeHttpUrl(url), url).toBe(''));
  });

  it('拒絕帳號密碼、空白、控制字元、沒有主機名稱、相對路徑與非字串', () => {
    [
      'https://user:pass@example.com/', 'https://user@example.com/', 'https://exa mple.com/',
      'https://example.com/\u0000', 'https://', '/relative/path', 'example.com/no-scheme',
      '', '   ', null, undefined, 123, {}, ['https://example.com'],
    ].forEach(v => expect(safeHttpUrl(v), String(v)).toBe(''));
  });

  it('過長的網址視為不安全', () => {
    expect(safeHttpUrl('https://example.com/' + 'a'.repeat(3000))).toBe('');
  });
});
