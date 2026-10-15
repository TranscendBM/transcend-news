import Icon from '../../components/Icon.jsx';
import { COMPETITOR_ORDER, STOCK_META } from '../../config/competitors.js';
import { StockCard } from './StockCard.jsx';

export const ALL_STOCK_CODES = ['2451', ...COMPETITOR_ORDER];

/** 創見＋競品股價卡（可只顯示指定公司）。沒有資料的公司顯示等待更新的佔位卡。 */
export default function StockCardsGrid({ stocks, codes = ALL_STOCK_CODES }) {
  return (
    <>
      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-3">
        {codes.map(code => (
          stocks[code]
            ? <StockCard key={code} code={code} data={stocks[code]} />
            : <div key={code} className="p-4 rounded-2xl border border-gray-700/60 bg-gray-900 flex flex-col items-center justify-center gap-2 min-h-[100px]">
                <span className="text-xs text-gray-500 font-bold">{code}</span>
                <span className="text-xs text-gray-600">{STOCK_META[code].name}</span>
                <span className="text-xs text-gray-700">等待 Actions 更新</span>
              </div>
        ))}
      </div>
      {Object.keys(stocks).length === 0 && (
        <div className="text-xs text-yellow-600/70 bg-yellow-900/10 border border-yellow-800/30 rounded-xl px-4 py-3 mt-3">
          <Icon name="alert" /> 尚未取得股價 — 請先在 GitHub Actions 手動執行一次 fetch-news workflow，確認 Firebase stocks/latest 文件已建立。
        </div>
      )}
    </>
  );
}
