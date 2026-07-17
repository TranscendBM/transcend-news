"""
創見新聞監控 — Cloud Functions 排程進入點
部署於 Firebase 專案 transcend-news-tbm（asia-east1），
透過 Secret Manager 的 MONITOR_SERVICE_ACCOUNT 跨專案寫入
舊專案 transcend-news-monitor 的 Firestore。

排程總覽（皆為台灣時間 Asia/Taipei）：
  stocks_job     交易日 09:00–13:35 每 1 分鐘   即時股價
  news_job       每 15 分鐘                     RSS 新聞
  community_job  每 2 小時（08–22 時）           CMoney + PTT 社群討論
  trading_job    交易日 13:40 / 17:10           每日開收盤 + 三大法人
  finance_job    每天 17:30                     月營收/季損益/股利/重大訊息
  finance_early_month_job  每月 1–10 日 09–18 時每小時（申報期加密）

防重疊機制：每個 job 皆設 max_instances=1，並以 Firestore lease lock
（meta/lock_*）防止「上一次還在跑、下一次又觸發」的重疊執行；
鎖有 TTL（皆大於該函式 timeout），函式異常中止時鎖會過期被接管，
不會永久鎖死。所有寫入皆為固定文件 ID 的冪等寫入，重跑不產生重複資料。
"""

import datetime
import json

import firebase_admin
from firebase_admin import credentials, firestore
from firebase_functions import scheduler_fn
from firebase_functions.options import MemoryOption
from firebase_functions.params import SecretParam

import fetch_news

TZ = 'Asia/Taipei'
REGION = 'asia-east1'
MONITOR_SERVICE_ACCOUNT = SecretParam('MONITOR_SERVICE_ACCOUNT')

# 跨專案寫入專用的 named app 名稱。不用 default app：若執行環境已存在
# 指向本專案（tbm）的 default app，firestore.client() 會連錯專案。
MONITOR_APP_NAME = 'monitor-writer'

_db = None


def get_db():
    """以 Secret 中的 service account 初始化（跨專案指向 transcend-news-monitor）"""
    global _db
    if _db is None:
        raw = (MONITOR_SERVICE_ACCOUNT.value or '').strip()
        if not raw:
            raise RuntimeError(
                'Secret MONITOR_SERVICE_ACCOUNT 為空或不存在，'
                '請以 firebase functions:secrets:set MONITOR_SERVICE_ACCOUNT 設定')
        try:
            sa_dict = json.loads(raw)
        except json.JSONDecodeError as e:
            # 不印出 secret 內容，只回報格式錯誤位置
            raise RuntimeError(f'Secret MONITOR_SERVICE_ACCOUNT 不是有效 JSON（行 {e.lineno} 欄 {e.colno}）') from None
        project_id = sa_dict.get('project_id')
        if not project_id:
            raise RuntimeError('Secret MONITOR_SERVICE_ACCOUNT 缺少 project_id 欄位')
        # 固定名稱的 named app + 明確 projectId + 明確傳入 firestore.client：
        # 三者缺一都可能在「已存在 default app」的環境連到錯誤專案
        # （Cloud Functions 的 FIREBASE_CONFIG 預設專案是 tbm）。
        try:
            app = firebase_admin.get_app(MONITOR_APP_NAME)
        except ValueError:
            cred = credentials.Certificate(sa_dict)
            app = firebase_admin.initialize_app(
                cred, {'projectId': project_id}, name=MONITOR_APP_NAME)
        _db = firestore.client(app=app)
        print(f"✅ Firestore 已連線（專案 {project_id}）")
    return _db


def _tw_now():
    return datetime.datetime.now(datetime.timezone(datetime.timedelta(hours=8)))


def _run_locked(lock_name, work_fn, ttl_minutes):
    """
    取得 Firestore lease lock（transaction + owner token）後執行 work_fn(db)；
    拿不到鎖（另一實例執行中）則跳過本次。
    以 try/finally 確保釋放，且只釋放本次 token 持有的鎖——
    即使執行超時後鎖被接管，也不會誤刪接管者的鎖。
    """
    db = get_db()
    token = fetch_news.acquire_lock(db, lock_name, ttl_minutes=ttl_minutes)
    if token is None:
        print(f"⏭ 鎖 {lock_name} 使用中（另一執行個體進行中），跳過本次")
        return False
    try:
        work_fn(db)
        return True
    finally:
        fetch_news.release_lock(db, lock_name, token)


# ─── 即時股價：交易日 09:00–13:59 每分鐘觸發，13:35 後自動略過 ───
@scheduler_fn.on_schedule(
    schedule='* 9-13 * * 1-5', timezone=TZ, region=REGION,
    memory=MemoryOption.MB_256, timeout_sec=120, max_instances=1,
    secrets=[MONITOR_SERVICE_ACCOUNT])
def stocks_job(event: scheduler_fn.ScheduledEvent) -> None:
    now = _tw_now().replace(tzinfo=None)
    if not fetch_news.is_tw_market_open(now):
        print(f"⏸ 非交易時段（{now:%H:%M}），略過")
        return
    _run_locked('stocks', lambda db: fetch_news.fetch_stock_prices(db), ttl_minutes=3)


# ─── RSS 新聞：每 15 分鐘 ───
@scheduler_fn.on_schedule(
    schedule='*/15 * * * *', timezone=TZ, region=REGION,
    memory=MemoryOption.MB_512, timeout_sec=540, max_instances=1,
    secrets=[MONITOR_SERVICE_ACCOUNT])
def news_job(event: scheduler_fn.ScheduledEvent) -> None:
    _run_locked('news', lambda db: fetch_news.fetch_and_save_news(db, mode='all'),
                ttl_minutes=12)


# ─── 社群討論（CMoney + PTT，爬蟲較慢）：08–22 時每 2 小時 ───
@scheduler_fn.on_schedule(
    schedule='10 8-22/2 * * *', timezone=TZ, region=REGION,
    memory=MemoryOption.MB_512, timeout_sec=540, max_instances=1,
    secrets=[MONITOR_SERVICE_ACCOUNT])
def community_job(event: scheduler_fn.ScheduledEvent) -> None:
    _run_locked('community', lambda db: fetch_news.fetch_and_save_community(db),
                ttl_minutes=12)


# ─── 每日交易資料（開收盤 + 三大法人）：收盤後與法人公布後各一次 ───
@scheduler_fn.on_schedule(
    schedule='40 13,17 * * 1-5', timezone=TZ, region=REGION,
    memory=MemoryOption.MB_256, timeout_sec=300, max_instances=1,
    secrets=[MONITOR_SERVICE_ACCOUNT])
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
    secrets=[MONITOR_SERVICE_ACCOUNT])
def finance_job(event: scheduler_fn.ScheduledEvent) -> None:
    _run_locked('finance', lambda db: fetch_news.fetch_all_financials(db),
                ttl_minutes=12)


# ─── 財務類加密頻：每月 1–10 日（月營收申報期）09–18 時每小時 ───
@scheduler_fn.on_schedule(
    schedule='15 9-18 1-10 * *', timezone=TZ, region=REGION,
    memory=MemoryOption.MB_512, timeout_sec=540, max_instances=1,
    secrets=[MONITOR_SERVICE_ACCOUNT])
def finance_early_month_job(event: scheduler_fn.ScheduledEvent) -> None:
    _run_locked('finance', lambda db: fetch_news.fetch_all_financials(db),
                ttl_minutes=12)
