"""
創見新聞監控 — Cloud Functions 排程進入點
部署於 Firebase 專案 transcend-news-tbm（asia-east1），
透過 Secret Manager 的 FIREBASE_SERVICE_ACCOUNT 跨專案寫入
舊專案 transcend-news-monitor 的 Firestore。

排程總覽（皆為台灣時間 Asia/Taipei）：
  stocks_job     交易日 09:00–13:35 每 1 分鐘   即時股價
  news_job       每 15 分鐘                     RSS 新聞
  community_job  每 2 小時（08–22 時）           CMoney + PTT 社群討論
  trading_job    交易日 13:40 / 17:10           每日開收盤 + 三大法人
  finance_job    每天 17:30；每月 1–10 日加開    月營收/季損益/股利/重大訊息
  finance_early_month_job  每月 1–10 日 09–18 時每小時
"""

import datetime
import json
import os

import firebase_admin
from firebase_admin import credentials, firestore
from firebase_functions import scheduler_fn
from firebase_functions.options import MemoryOption
from firebase_functions.params import SecretParam

import fetch_news

TZ = 'Asia/Taipei'
REGION = 'asia-east1'
FIREBASE_SERVICE_ACCOUNT = SecretParam('FIREBASE_SERVICE_ACCOUNT')

_db = None


def get_db():
    """以 Secret 中的 service account 初始化（跨專案指向 transcend-news-monitor）"""
    global _db
    if _db is None:
        sa_dict = json.loads(FIREBASE_SERVICE_ACCOUNT.value.strip())
        cred = credentials.Certificate(sa_dict)
        if not firebase_admin._apps:
            firebase_admin.initialize_app(cred)
        _db = firestore.client()
        print(f"✅ Firestore 已連線（專案 {sa_dict.get('project_id')}）")
    return _db


def _tw_now():
    return datetime.datetime.now(datetime.timezone(datetime.timedelta(hours=8)))


# ─── 即時股價：交易日 09:00–13:59 每分鐘觸發，13:35 後自動略過 ───
@scheduler_fn.on_schedule(
    schedule='* 9-13 * * 1-5', timezone=TZ, region=REGION,
    memory=MemoryOption.MB_256, timeout_sec=120,
    secrets=[FIREBASE_SERVICE_ACCOUNT])
def stocks_job(event: scheduler_fn.ScheduledEvent) -> None:
    now = _tw_now().replace(tzinfo=None)
    if not fetch_news.is_tw_market_open(now):
        print(f"⏸ 非交易時段（{now:%H:%M}），略過")
        return
    fetch_news.fetch_stock_prices(get_db())


# ─── RSS 新聞：每 15 分鐘 ───
@scheduler_fn.on_schedule(
    schedule='*/15 * * * *', timezone=TZ, region=REGION,
    memory=MemoryOption.MB_512, timeout_sec=540,
    secrets=[FIREBASE_SERVICE_ACCOUNT])
def news_job(event: scheduler_fn.ScheduledEvent) -> None:
    fetch_news.fetch_and_save_news(get_db(), mode='all')


# ─── 社群討論（CMoney + PTT，爬蟲較慢）：08–22 時每 2 小時 ───
@scheduler_fn.on_schedule(
    schedule='10 8-22/2 * * *', timezone=TZ, region=REGION,
    memory=MemoryOption.MB_512, timeout_sec=540,
    secrets=[FIREBASE_SERVICE_ACCOUNT])
def community_job(event: scheduler_fn.ScheduledEvent) -> None:
    fetch_news.fetch_and_save_community(get_db())


# ─── 每日交易資料（開收盤 + 三大法人）：收盤後與法人公布後各一次 ───
@scheduler_fn.on_schedule(
    schedule='40 13,17 * * 1-5', timezone=TZ, region=REGION,
    memory=MemoryOption.MB_256, timeout_sec=300,
    secrets=[FIREBASE_SERVICE_ACCOUNT])
def trading_job(event: scheduler_fn.ScheduledEvent) -> None:
    db = get_db()
    fetch_news.fetch_stock_prices(db)   # 收盤價一併校正
    fetch_news.fetch_daily_trading(db, '2451')


# ─── 財務類（月營收/季損益/股利/重大訊息，含競品）：每天一次 ───
@scheduler_fn.on_schedule(
    schedule='30 17 * * *', timezone=TZ, region=REGION,
    memory=MemoryOption.MB_512, timeout_sec=540,
    secrets=[FIREBASE_SERVICE_ACCOUNT])
def finance_job(event: scheduler_fn.ScheduledEvent) -> None:
    fetch_news.fetch_all_financials(get_db())


# ─── 財務類加密頻：每月 1–10 日（月營收申報期）09–18 時每小時 ───
@scheduler_fn.on_schedule(
    schedule='15 9-18 1-10 * *', timezone=TZ, region=REGION,
    memory=MemoryOption.MB_512, timeout_sec=540,
    secrets=[FIREBASE_SERVICE_ACCOUNT])
def finance_early_month_job(event: scheduler_fn.ScheduledEvent) -> None:
    fetch_news.fetch_all_financials(get_db())
