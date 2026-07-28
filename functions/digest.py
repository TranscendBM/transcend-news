"""
DRAM/Flash 產業新聞摘要信件 — Phase 1（零 API 費用，沿用 intelligence.py 規則層）。

平日 08:00 寄台灣 DRAM/Flash 產業新聞、16:30 寄美國 DRAM/Flash 產業新聞
（實際排程設定見 main.py）。內容摘要用 intelligence.rule_summary()，
不呼叫任何付費 AI；之後若導入本機 Ollama 摘要，只需替換
build_digest_email() 產生的內文，其餘（篩選、寄信、進度追蹤）不動。

寄件帳號使用 Gmail SMTP（tselvis814@gmail.com + App Password），
App Password 存於 Secret Manager 的 DIGEST_EMAIL_APP_PASSWORD，
不進 repo、不進程式碼。
"""

import datetime
import smtplib
from email.mime.text import MIMEText
from email.utils import formatdate

import intelligence

SMTP_HOST = 'smtp.gmail.com'
SMTP_PORT = 587
DIGEST_SENDER = 'tselvis814@gmail.com'
DIGEST_RECIPIENTS = ['ai_mkd@transcend-info.com']
DIGEST_MAX_ITEMS = 20

# 首次執行、尚無「上次寄送時間」紀錄時的保守預設回溯區間，
# 避免第一次執行把過往全部歷史新聞塞進一封信。
DIGEST_DEFAULT_LOOKBACK_HOURS = 48

DIGEST_CATS = {
    'tw': {'cat': 'twMarket', 'label': '台灣 DRAM/Flash 產業新聞'},
    'us': {'cat': 'usMarket', 'label': '美國 DRAM/Flash 產業新聞'},
}


def select_digest_articles(articles, since_dt, limit=DIGEST_MAX_ITEMS):
    """
    純函式：從文章清單中挑出「since_dt 之後發布」且經 intelligence 規則
    判定為相關（relevant）的文章，依重要性分數（importanceScore）由高到低
    排序，最多回傳 limit 筆。

    回傳 [(article, rule_analysis), ...]。
    """
    scored = []
    for article in articles:
        pub_dt = article.get('pubDate')
        if not isinstance(pub_dt, datetime.datetime) or pub_dt <= since_dt:
            continue
        rules = intelligence.analyze_article_rules(article)
        if not rules.get('relevant'):
            continue
        scored.append((article, rules))
    scored.sort(key=lambda pair: pair[1]['importanceScore'], reverse=True)
    return scored[:limit]


def build_digest_email(label, items, now=None):
    """純函式：把挑選出的文章組成信件標題與純文字內文。"""
    now = now or datetime.datetime.now(datetime.timezone(datetime.timedelta(hours=8)))
    date_str = now.strftime('%Y-%m-%d')
    subject = f'[創見新聞監控] {date_str} {label}（共 {len(items)} 則）'

    if not items:
        body = f'{date_str}\n\n目前沒有符合條件的{label}。\n'
        return subject, body

    lines = [f'{date_str} {label}，共 {len(items)} 則（依重要性排序）：', '']
    for i, (article, rules) in enumerate(items, 1):
        lines.append(f'{i}. {intelligence.rule_summary(article, rules)}')
        link = article.get('link')
        if link:
            lines.append(f'   {link}')
        lines.append('')
    return subject, '\n'.join(lines)


def send_email(subject, body, to_addrs, app_password, from_addr=DIGEST_SENDER):
    """寄出純文字信件（Gmail SMTP，587 埠 + STARTTLS）。"""
    msg = MIMEText(body, 'plain', 'utf-8')
    msg['Subject'] = subject
    msg['From'] = from_addr
    msg['To'] = ', '.join(to_addrs)
    msg['Date'] = formatdate(localtime=True)

    with smtplib.SMTP(SMTP_HOST, SMTP_PORT, timeout=30) as server:
        server.starttls()
        server.login(from_addr, app_password)
        server.sendmail(from_addr, to_addrs, msg.as_string())


def _checkpoint_ref(db, name):
    return db.collection('meta').document(f'digest_{name}')


def get_last_digest_time(db, name, default_lookback_hours=DIGEST_DEFAULT_LOOKBACK_HOURS):
    """
    讀取上次成功寄出的時間戳；沒有紀錄時（第一次執行）回傳
    「現在往前推 default_lookback_hours 小時」。
    """
    snap = _checkpoint_ref(db, name).get()
    if getattr(snap, 'exists', False):
        ts = (snap.to_dict() or {}).get('lastSentAt')
        if ts is not None:
            return ts
    now = datetime.datetime.now(datetime.timezone.utc)
    return now - datetime.timedelta(hours=default_lookback_hours)


def set_last_digest_time(db, name, when):
    _checkpoint_ref(db, name).set({'lastSentAt': when}, merge=True)


def fetch_cat_articles(db, cat):
    """讀取指定分類（twMarket/usMarket）目前 Firestore 中的所有文章。"""
    docs = db.collection('news').where('cat', '==', cat).stream()
    return [d.to_dict() for d in docs]


def run_digest(db, key, app_password):
    """
    執行一次摘要寄信（key='tw' 或 'us'）。
    先讀取上次寄送時間、篩選新文章、組信、寄出，最後才更新寄送時間戳記——
    若寄信失敗會拋出例外、時間戳記不會更新，下次執行會用同一個區間重試，
    不會漏掉這中間的新聞。
    回傳 dict(count=已挑選則數)，供呼叫端印出執行結果。
    """
    cfg = DIGEST_CATS[key]
    since = get_last_digest_time(db, key)
    articles = fetch_cat_articles(db, cfg['cat'])
    items = select_digest_articles(articles, since)
    subject, body = build_digest_email(cfg['label'], items)
    send_email(subject, body, DIGEST_RECIPIENTS, app_password)
    set_last_digest_time(db, key, datetime.datetime.now(datetime.timezone.utc))
    return {'count': len(items)}
