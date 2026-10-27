# UI 設計系統（全站一致化）

只改前端呈現，不改資料來源、Firestore 查詢、排程、Functions 與商業邏輯。

## Design Tokens
定義在 `src/styles/tokens.css`（CSS 變數），Tailwind 對應在 `tailwind.config.js`（`brand`、`ui-*`、`max-w-content`）。

| 類別 | 變數 |
|---|---|
| 品牌 | `--brand`（創見紅，只用於主操作、選取狀態、重點數字）、`--brand-strong`、`--brand-soft`、`--brand-line` |
| 表面／文字 | `--page`、`--surface`、`--surface-soft`、`--line`、`--text`、`--text-secondary`、`--muted`（白底對比 ≥ 4.5:1） |
| 狀態 | `--ok`、`--warn`、`--danger`、`--info`、`--neutral`（各含 `-bg`、`-line`）；台股慣例 `--up`（紅）、`--down`（綠） |
| 間距／圓角／陰影 | `--space-*`、`--radius-*`、`--shadow-sm` |
| 字級 | `--text-*`、`--leading-*` |
| 版面 | `--content-max`（1280px）、`--header-h`、`--bottom-nav-h`、`--tap`（44px） |
| 斷點 | 手機 < 768px、平板 768–1023px、桌機 ≥ 1024px（Tailwind `md`／`lg`） |

## 共用元件（`src/components/ui`，統一從 `index.js` 取用）
`ActionButton`／`IconButton`、`StatusBadge`、`DataStateBanner`、`LoadingSkeleton`／`MetricSkeleton`、`EmptyState`、`ErrorState`、
`ListStatus`（loading／error／empty／ready 四態）、`LastUpdatedLabel`、`SectionCard`（含統一的「查看全部」）、`MetricCard`／`Delta`、
`SearchField`、`SegmentedControl`、`FilterBar`、`PageHeader`、`DataTable`／`MobileCardList`（桌機表格、手機卡片）、`useMediaQuery`。

外殼（`src/components/shell`）：`AppShell`、`GlobalHeader`、`PrimaryNavigation`（桌機 Header 內、手機底部）、`MarketSummary`（可收合）。
第二層導覽 `SectionTabs`＝`SubNavigation`。

## 資料狀態規範
| 狀態 | 呈現 |
|---|---|
| loading | 骨架（`LoadingSkeleton`／`MetricCard state="loading"`），`aria-busy` |
| ready | 正常資料；單一欄位缺值才顯示「—」 |
| empty | `EmptyState`／`MetricCard state="empty"`：「尚無資料」並說明原因與下一步 |
| stale | 黃色 `DataStateBanner`，保留最後資料並標示時間與下一步 |
| error | 紅色 `ErrorState`／`DataStateBanner`（`role="alert"`），可重試 |
| cache | 藍色 `DataStateBanner state="cache"`（目前沒有頁面使用；元件已備好） |

## 原則
- 相同功能一律使用同一個元件；頁面不自行定義近似但不同的顏色、卡片、按鈕。
- 顏色只表達語意：紅＝上漲／風險／選取、綠＝下跌／正常、黃＝注意；狀態一律「符號＋文字＋顏色」。
- 總覽只放決策摘要（每塊最多 3～5 筆）＋「查看全部」；詳細資料在子頁。
- 匯出放在頁面 `PageHeader`；篩選集中在單一 `FilterBar`，目前條件以晶片顯示並可一鍵清除，手機收合成「篩選（N）」。
