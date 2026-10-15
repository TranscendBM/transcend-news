import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';

import Icon, { ICON_NAMES } from './Icon.jsx';
import { tagClass, TAG_TONES } from './tagStyles.js';

// 所有原始碼（不含測試檔），用來檢查沒有殘留彩色 emoji、圖示名稱都存在
const sources = import.meta.glob(['../**/*.js', '../**/*.jsx'], { query: '?raw', import: 'default', eager: true });
const appFiles = Object.entries(sources).filter(([path]) => !/\.test\./.test(path));

// 彩色 emoji＝Unicode 的 Extended_Pictographic（📊 ⚠ 🎯 …）或帶 emoji 變體選擇符（U+FE0F）；
// ✓ ▲ ▼ ● ○ ↻ → 這類單色文字符號不在其中。
const COLOR_EMOJI = /\p{Extended_Pictographic}|\uFE0F/u;
// 只允許出現在說明文字的符號（✓ ✔ 屬於單色文字字形，不在上面範圍）
const ALLOWED_FILES = [/ErrorBoundary\.jsx$/];

describe('Icon', () => {
  it('每個名稱都能畫出單色線條圖示（currentColor，不含固定顏色）', () => {
    ICON_NAMES.forEach(name => {
      const { container, unmount } = render(<Icon name={name} />);
      const svg = container.querySelector('svg');
      expect(svg, name).toBeTruthy();
      expect(container.querySelectorAll('path').length, name).toBeGreaterThan(0);
      const stroke = svg.getAttribute('stroke');
      expect(stroke === 'currentColor' || svg.getAttribute('fill') === 'currentColor', name).toBe(true);
      expect(svg.outerHTML).not.toMatch(/#[0-9a-f]{3,6}/i);
      unmount();
    });
  });

  it('未知名稱不畫東西，也不會把名稱當文字顯示', () => {
    const { container } = render(<Icon name="no-such-icon" />);
    expect(container.innerHTML).toBe('');
  });
});

describe('專案內的圖示用法', () => {
  it('原始碼裡沒有殘留彩色 emoji（改用 <Icon />）', () => {
    const offenders = appFiles
      .filter(([path]) => !ALLOWED_FILES.some(re => re.test(path)))
      .flatMap(([path, text]) => text.split(/\r?\n/)
        .map((line, i) => ({ path, line: i + 1, text: line }))
        .filter(l => !/^\s*(\/\/|\*|\/\*|\{\/\*)/.test(l.text) && COLOR_EMOJI.test(l.text))
        .map(l => `${l.path}:${l.line} ${l.text.trim().slice(0, 60)}`));
    expect(offenders).toEqual([]);
  });

  it('icon="…" / icon: \'…\' 指定的名稱都存在於圖示表', () => {
    const used = new Set();
    appFiles.forEach(([, text]) => {
      for (const m of text.matchAll(/\bicon(?:=|: ?)["']([a-z]+)["']/g)) used.add(m[1]);
    });
    expect(used.size).toBeGreaterThan(10);
    expect([...used].filter(name => !ICON_NAMES.includes(name))).toEqual([]);
  });
});

describe('tagClass', () => {
  it('標籤用淺底深字＋同色細框（白底上清楚可讀），不用暗色系半透明底', () => {
    Object.entries(TAG_TONES).forEach(([tone, cls]) => {
      expect(cls, tone).toMatch(/\bbg-\w+-(50|100)\b/);
      expect(cls, tone).toMatch(/\btext-\w+-(600|700|800)\b/);
      expect(cls, tone).toMatch(/\bborder-\w+-(300)\b/);
      expect(cls, tone).not.toMatch(/-900\//);
    });
    expect(tagClass('green', 'shrink-0')).toContain('shrink-0');
    expect(tagClass('unknown-tone')).toContain(TAG_TONES.gray);
  });
});
