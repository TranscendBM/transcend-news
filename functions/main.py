"""
創見新聞監控 — Cloud Functions 排程進入點
部署於 Firebase 專案 transcend-news-tbm（asia-east1），Firestore 資料庫
現在也在同一個專案（transcend-news-tbm）——get_db() 使用 Cloud Functions
執行環境本身的 Application Default Credentials（見 db_same_project.py），
不再需要 Secret Manager 的 MONITOR_SERVICE_ACCOUNT 跨專案憑證。

排程總覽（皆為台灣時間 Asia/Taipei）：
  stocks_job     交易日 09:00–13:35 每 1 分鐘   即時股價
  news_job       每 15 分鐘                     RSS 新聞
  trading_job    交易日 13:40 / 17:10           每日開收盤 + 三大法人
  finance_job    每天 17:30                     月營收/季損益/股利/重大訊息
  finance_early_month_job  每月 1–10 日 09–18 時每小時（申報期加密）
  tw_dram_digest_job  平日 08:00                台灣 DRAM/Flash 產業新聞摘要信
  us_dram_digest_job  平日 16:30                美國 DRAM/Flash 產業新聞摘要信
  news_cleanup_job    每天 02:30                新聞保存期限清理（只留本月＋上個月）
  ai_worker_health_job  每天 02:35              彙總本機 AI worker 積壓狀況（ai_jobs/ai_insights）

HTTPS 端點：
  upload_media_exposure  網站「人工確認曝光」上傳 Excel（POST /api/media-exposure，
                         由 Hosting rewrite 轉進來；以 MEDIA_EXPOSURE_UPLOAD_PASSCODE 把關）

防重疊機制：每個 job 皆設 max_instances=1，並以 Firestore lease lock
（meta/lock_*）防止「上一次還在跑、下一次又觸發」的重疊執行；
鎖有 TTL（皆大於該函式 timeout），函式異常中止時鎖會過期被接管，
不會永久鎖死。所有寫入皆為固定文件 ID 的冪等寫入，重跑不產生重複資料。

stocks_job/trading_job/finance_job/finance_early_month_job 皆帶入
FINMIND_API_TOKEN（Secret Manager）——FinMind 匿名（無權杖）存取已不再
可靠（實測回 402），股價/月營收/季損益/股利/三大法人皆改用附權杖請求。

每個排程執行成功/失敗都會寫進 job_status/{lock_name}（見 _run_locked），
搭配 ai_worker_health_job 彙總的本機 AI worker 積壓狀況，前端「系統健康」
分頁可以一次看到所有排程 + 本機 worker 的最新狀態，不需要再手動查
Cloud Logging。
"""

import datetime
import json

from firebase_functions import scheduler_fn, https_fn
from firebase_functions.options import MemoryOption, CorsOptions
from firebase_functions.params import SecretParam
from firebase_admin import firestore

from db_same_project import get_db
import fetch_news
import digest
import news_cleanup
import ai_worker_health
import media_exposure_upload

TZ = 'Asia/Taipei'
REGION = 'asia-east1'
MAIL2000_SMTP_PASSWORD = SecretParam('MAIL2000_SMTP_PASSWORD')
FINMIND_API_TOKEN = SecretParam('FINMIND_API_TOKEN')
MEDIA_EXPOSURE_UPLOAD_PASSCODE = SecretParam('MEDIA_EXPOSURE_UPLOAD_PASSCODE')


def _tw_now():
    return datetime.datetime.now(datetime.timezone(datetime.timedelta(hours=8)))


def _run_locked(lock_name, work_fn, ttl_minutes):
    """
    取得 Firestore lease lock（transaction + owner token）後執行 work_fn(db)；
    拿不到鎖（另一實例執行中）則跳過本次。
    以 try/finally 確保釋放，且只釋放本次 token 持有的鎖——
    即使執行超時後鎖被接管，也不會誤刪接管者的鎖。

    同時把「這次有沒有成功跑完」寫進 job_status/{lock_name}（客戶端可讀，
    見 firestore.rules）——這只能抓到「函式本身丟例外」的失敗，抓不到
    fetch_stock_prices() 這類函式內部已經 try/except 吞掉、印一行警告
    但沒有真的往外拋例外的「軟性失敗」（例如 TWSE/FinMind 掛掉但程式
    本身順利跑完、只是沒寫入新資料）。這類軟性失敗要靠前端「系統健康」
    頁面另外比對實際資料的 updatedAt 是否夠新來抓，兩者互補、缺一不可。
    """
    db = get_db()
    token = fetch_news.acquire_lock(db, lock_name, ttl_minutes=ttl_minutes)
    if token is None:
        print(f"⏭ 鎖 {lock_name} 使用中（另一執行個體進行中），跳過本次")
        return False
    status_ref = db.collection('job_status').document(lock_name)
    try:
        work_fn(db)
        status_ref.set({
            'lastSuccessAt': firestore.SERVER_TIMESTAMP,
            'lastAttemptAt': firestore.SERVER_TIMESTAMP,
            'lastError': None,
            'lastErrorAt': None,
        }, merge=True)
        return True
    except Exception as e:
        status_ref.set({
            'lastAttemptAt': firestore.SERVER_TIMESTAMP,
            'lastError': str(e)[:500],
            'lastErrorAt': firestore.SERVER_TIMESTAMP,
        }, merge=True)
        raise
    finally:
        fetch_news.release_lock(db, lock_name, token)


# ─── 即時股價：交易日 09:00–13:59 每分鐘觸發，13:35 後自動略過 ───
@scheduler_fn.on_schedule(
    schedule='* 9-13 * * 1-5', timezone=TZ, region=REGION,
    memory=MemoryOption.MB_256, timeout_sec=120, max_instances=1,
    secrets=[FINMIND_API_TOKEN])
def stocks_job(event: scheduler_fn.ScheduledEvent) -> None:
    now = _tw_now().replace(tzinfo=None)
    if not fetch_news.is_tw_market_open(now):
        print(f"⏸ 非交易時段（{now:%H:%M}），略過")
        return
    _run_locked('stocks', lambda db: fetch_news.fetch_stock_prices(db), ttl_minutes=3)


# ─── RSS 新聞：每 15 分鐘 ───
@scheduler_fn.on_schedule(
    schedule='*/15 * * * *', timezone=TZ, region=REGION,
    memory=MemoryOption.MB_512, timeout_sec=540, max_instances=1)
def news_job(event: scheduler_fn.ScheduledEvent) -> None:
    _run_locked('news', lambda db: fetch_news.fetch_and_save_news(db, mode='all'),
                ttl_minutes=12)


# 註：community_job（CMoney/PTT 股市網路輿情）已於 2026-07 隨前端區塊一併移除

# ─── 每日交易資料（開收盤 + 三大法人）：收盤後與法人公布後各一次 ───
@scheduler_fn.on_schedule(
    schedule='40 13,17 * * 1-5', timezone=TZ, region=REGION,
    memory=MemoryOption.MB_256, timeout_sec=300, max_instances=1,
    secrets=[FINMIND_API_TOKEN])
def trading_job(event: scheduler_fn.ScheduledEvent) -> None:
    def work(db):
        fetch_news.fetch_stock_prices(db)   # 收盤價一併校正
        fetch_news.fetch_daily_trading(db, '2451')
    _run_locked('trading', work, ttl_minutes=8)


# ─── 財務類（月營收/季損益/股利/重大訊息，含競品）：每天一次 ───
# 與 finance_early_month_job 共用同一把鎖，兩排程不會互相重疊
@scheduler_fn.on_schedule(
    schedule='30 17 * * *', timezone=TZ, region=REGION,
    memory=MemoryOption.MB_512, timeout_sec=540, max_instances=1,
    secrets=[FINMIND_API_TOKEN])
def finance_job(event: scheduler_fn.ScheduledEvent) -> None:
    _run_locked('finance', lambda db: fetch_news.fetch_all_financials(db),
                ttl_minutes=12)


# ─── 財務類加密頻：每月 1–10 日（月營收申報期）09–18 時每小時 ───
@scheduler_fn.on_schedule(
    schedule='15 9-18 1-10 * *', timezone=TZ, region=REGION,
    memory=MemoryOption.MB_512, timeout_sec=540, max_instances=1,
    secrets=[FINMIND_API_TOKEN])
def finance_early_month_job(event: scheduler_fn.ScheduledEvent) -> None:
    _run_locked('finance', lambda db: fetch_news.fetch_all_financials(db),
                ttl_minutes=12)


# ─── DRAM/Flash 產業新聞摘要信（Phase 1，規則版摘要，零 API 費用）───
# 平日 08:00 寄台灣新聞、16:30 寄美國新聞；兩者各自獨立追蹤「上次寄送
# 時間」（meta/digest_tw、meta/digest_us），互不影響，遇到週末也不會
# 漏掉——週一 08:00 那次會自動涵蓋整個週末（上次寄送時間是上週五 08:00）。
@scheduler_fn.on_schedule(
    schedule='0 8 * * 1-5', timezone=TZ, region=REGION,
    memory=MemoryOption.MB_256, timeout_sec=120, max_instances=1,
    secrets=[MAIL2000_SMTP_PASSWORD])
def tw_dram_digest_job(event: scheduler_fn.ScheduledEvent) -> None:
    def work(db):
        result = digest.run_digest(db, 'tw', MAIL2000_SMTP_PASSWORD.value)
        print(f"  ✉ 台灣 DRAM/Flash 新聞摘要已寄出（{result['count']} 則）")
    _run_locked('digest_tw', work, ttl_minutes=5)


@scheduler_fn.on_schedule(
    schedule='30 16 * * 1-5', timezone=TZ, region=REGION,
    memory=MemoryOption.MB_256, timeout_sec=120, max_instances=1,
    secrets=[MAIL2000_SMTP_PASSWORD])
def us_dram_digest_job(event: scheduler_fn.ScheduledEvent) -> None:
    def work(db):
        result = digest.run_digest(db, 'us', MAIL2000_SMTP_PASSWORD.value)
        print(f"  ✉ 美國 DRAM/Flash 新聞摘要已寄出（{result['count']} 則）")
    _run_locked('digest_us', work, ttl_minutes=5)


# ─── 新聞保存期限清理：只保留本月＋上個月（Asia/Taipei 日曆月份，見 news_cleanup.py）───
# 每天凌晨低峰期執行一次，使用獨立鎖 news_cleanup（跟每 15 分鐘一次的
# news RSS 抓取鎖分開，互不影響、可各自獨立重試）。刪除失敗時例外會
# 直接往外拋（不吞掉），Cloud Logging 能看到失敗紀錄，下次排程會
# 重新查詢過期範圍再試一次——不需要額外的失敗重試邏輯。
@scheduler_fn.on_schedule(
    schedule='30 2 * * *', timezone=TZ, region=REGION,
    memory=MemoryOption.MB_256, timeout_sec=540, max_instances=1)
def news_cleanup_job(event: scheduler_fn.ScheduledEvent) -> None:
    def work(db):
        result = news_cleanup.cleanup_expired_news(db, dry_run=False)
        status = '尚有餘量待下次清理' if result['remaining'] else '本次已清完現有過期新聞'
        print(f"  🗑 新聞保存期限清理：刪除 {result['deleted']} 篇"
              f"（略過異常 pubDate {result['skipped_invalid']} 篇，{status}）")
    _run_locked('news_cleanup', work, ttl_minutes=15)


# ─── 本機 AI worker 健康檢查：每天一次，緊接在 news_cleanup_job 之後 ───
# 本機 AI worker（tools/local_ai_worker.py）跑在使用者自己的電腦上，
# Cloud Functions 完全看不到它有沒有在跑；這個排程只做唯讀彙總
# （ai_jobs 待處理筆數、ai_insights 最近一次分析時間），寫進客戶端
# 可讀的 job_status/ai_worker，讓前端「系統健康」頁面能看到 worker
# 是否已經很久沒動靜，不需要等使用者自己發現股價/新聞分析停滯。
@scheduler_fn.on_schedule(
    schedule='35 2 * * *', timezone=TZ, region=REGION,
    memory=MemoryOption.MB_256, timeout_sec=60, max_instances=1)
def ai_worker_health_job(event: scheduler_fn.ScheduledEvent) -> None:
    _run_locked('ai_worker_health', lambda db: ai_worker_health.check_ai_worker_health(db),
                ttl_minutes=5)

# ─── 人工確認曝光：網站上傳 Excel（POST /api/media-exposure）───
# 沒有登入機制的網站上開放寫入入口，必須帶上傳通行碼；解析／去重／寫入邏輯
# 全在 media_exposure_upload.py（跟 CLI 共用 media_exposure.py）。
@https_fn.on_request(
    region=REGION, memory=MemoryOption.MB_512, timeout_sec=120, max_instances=3,
    secrets=[MEDIA_EXPOSURE_UPLOAD_PASSCODE],
    cors=CorsOptions(
        cors_origins=[
            'https://transcend-news.web.app',
            'https://transcend-news-tbm.web.app',
            'https://transcend-news-tbm.firebaseapp.com',
        ],
        cors_methods=['POST']))
def upload_media_exposure(req: https_fn.Request) -> https_fn.Response:
    status, body = media_exposure_upload.respond(
        req.method, req.get_json(silent=True),
        passcode=MEDIA_EXPOSURE_UPLOAD_PASSCODE.value, get_db=get_db)
    return https_fn.Response(
        json.dumps(body, ensure_ascii=False, default=str),
        status=status, mimetype='application/json')

