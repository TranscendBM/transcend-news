import { useState, useEffect, useRef } from 'react';
import Icon from './Icon.jsx';

// 股價自動更新倒數：獨立成自己的元件，狀態完全留在元件內部，每秒的
// -1 更新只會讓這個小元件重新渲染，不會連帶讓整個 App()（含目前顯示
// 的分頁，PRTab/USMarketTab/IRTab 三者加起來近 1900 行）每秒重新渲染
// 一次。onExpire 用 ref 存放：interval 只在掛載時建立一次，不需要因
// App() 重新產生一個新的 onExpire function 參考就重建計時器。
export default function StockCountdown({ resetSignal, onExpire }) {
  const [countdown, setCountdown] = useState(300); // 300s = 5 min（配合 Actions 排程）
  const onExpireRef = useRef(onExpire);
  onExpireRef.current = onExpire;

  // 股價 onSnapshot 即時推送、或手動重新整理成功時，resetSignal（stocks
  // 物件參考）會改變——倒數立刻重置為 300，不用等到自然歸零。
  useEffect(() => {
    setCountdown(300);
  }, [resetSignal]);

  useEffect(() => {
    const tick = setInterval(() => {
      setCountdown(s => {
        if (s <= 1) {
          onExpireRef.current(); // 時間到：靜默刷新股價 + 每日交易
          return 300;
        }
        return s - 1;
      });
    }, 1000);
    return () => clearInterval(tick);
  }, []);

  return (
    <span className="text-gray-700" title="股價自動更新倒數">
      <Icon name="clock" /> {Math.floor(countdown / 60)}:{String(countdown % 60).padStart(2, '0')}
    </span>
  );
}
