/**
 * 全站外殼：跳到主要內容的連結、固定 Header（含第一層導覽）、可收合市場摘要、內容區。
 * 內容區限制最大寬度（--content-max），手機底部讓出導覽的高度，避免內容被遮住。
 */
export default function AppShell({ header, summary, children }) {
  return (
    <div className="light-theme min-h-screen" style={{ fontFamily: "'Segoe UI',system-ui,sans-serif" }}>
      <a href="#main-content"
        className="sr-only focus:not-sr-only focus:fixed focus:top-2 focus:left-2 focus:z-[60] focus:bg-brand focus:text-white focus:px-3 focus:py-2 focus:rounded">
        跳到主要內容
      </a>
      {header}
      {summary}
      <main id="main-content" tabIndex={-1} className="app-main max-w-content mx-auto px-3 sm:px-4 pt-4 outline-none">
        {children}
      </main>
    </div>
  );
}
