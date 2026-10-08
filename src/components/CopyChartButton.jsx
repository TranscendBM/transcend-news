import { useEffect, useRef, useState } from 'react';

import Icon from './Icon.jsx';
import { copyChartImage } from '../utils/copyChart.js';

// 放在圖表卡片右上角：把 containerRef 裡的 <svg> 轉成圖片複製到剪貼簿，
// 貼到 PowerPoint / Word / Google Slides 都是一張圖。
export default function CopyChartButton({ containerRef, title, legend, note }) {
  const [state, setState] = useState('idle'); // idle | busy | copied | downloaded | error
  const timerRef = useRef(null);
  useEffect(() => () => clearTimeout(timerRef.current), []);

  const onClick = async () => {
    const svg = containerRef.current?.querySelector('svg');
    if (!svg || state === 'busy') return;
    setState('busy');
    try {
      setState(await copyChartImage(svg, { title, legend, note }));
    } catch (e) {
      console.error('複製圖表失敗:', e);
      setState('error');
    }
    clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => setState('idle'), 2500);
  };

  const label = {
    idle: <><Icon name="copy" /> 複製圖表</>,
    busy: '處理中…',
    copied: '✓ 已複製，可貼到簡報／Word',
    downloaded: <><Icon name="download" /> 已下載圖片</>,
    error: <><Icon name="alert" /> 複製失敗</>,
  }[state];

  return (
    <button onClick={onClick} disabled={state === 'busy'} title={`複製圖表：${title}`}
      className="text-sm px-3.5 py-1.5 rounded-lg border border-gray-700/60 text-gray-400 hover:text-gray-200 hover:bg-gray-800 transition disabled:opacity-60 shrink-0">
      {label}
    </button>
  );
}
