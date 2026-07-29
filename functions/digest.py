"""
DRAM/Flash 產業新聞摘要信件 — Phase 1（零 API 費用，沿用 intelligence.py 規則層）。

平日 08:00 寄台灣 DRAM/Flash 產業新聞、16:30 寄美國 DRAM/Flash 產業新聞
（實際排程設定見 main.py）。內容摘要用 intelligence.rule_summary()，
不呼叫任何付費 AI；之後若導入本機 Ollama 摘要，只需替換
build_digest_email() 產生的內文，其餘（篩選、寄信、進度追蹤）不動。

範圍鎖定「上游供應商 + 產業市場」新聞，不含創見自己或競品的公司新聞
（那些已有前端 PR/競品動態分頁可看，這封信只做產業情報）。

寄件透過創見 Mail2000 郵件伺服器（email.transcend-info.com:587，STARTTLS）：
  - SMTP 認證帳號：elvis_cheng@transcend-info.com（已由 IT 授權 Send As）
  - 寄件地址／顯示名稱：「每日產業新聞」<bm@transcend-info.com>
  - 密碼存於 Secret Manager 的 MAIL2000_SMTP_PASSWORD，不進 repo、不進程式碼
  - 伺服器 TLS 交握不會附上中介憑證，需額外載入同資料夾的
    sectigo-intermediate.pem 才能拼出完整信任鏈；一律維持完整憑證驗證，
    不關閉憑證檢查（AUTH LOGIN 會送出帳密，關掉驗證等於讓中間人能冒充
    伺服器竊取帳密）
  - 伺服器憑證效期至 2026-08-22，到期後憑證鏈不保證沿用同一張中介憑證，
    屆時需重新用瀏覽器或 openssl 檢查伺服器送出的鏈並更新這個檔案；
    在那之前這是已知的營運風險（憑證到期未更新會讓寄信失敗，
    不是安全漏洞，但會讓摘要信悄悄停止寄送）

進度追蹤（at-least-once，避免與 15 分鐘一次的 news_job 排程競態）：
  tw_dram_digest_job（08:00）與 us_dram_digest_job（16:30）都可能跟同時
  觸發的 news_job 重疊執行。若用「寄信成功當下的時間」當作下次查詢的
  起點，news_job 在摘要查詢 Firestore 之後才寫入一篇 pubDate 較早的文章時，
  這篇文章的發布日會落在下次查詢起點之前，永遠不會再被選中。
  因此改為：查詢窗口固定回溯 DIGEST_LOOKBACK_HOURS 小時（見下方常數，
  非「上次寄送時間」的移動游標），「是否已寄過」改用 sentIds 集合判斷；
  只要文章還在回溯窗口內、id 不在 sentIds 裡，不論它是何時才寫進
  Firestore，下一輪一定會被選到、寄出。sentIds 只在寄信成功後才寫入，
  並依保留天數與筆數上限裁切，避免 checkpoint 文件無限增長。
"""

import datetime
import html
import os
import smtplib
import ssl
from email.mime.multipart import MIMEMultipart
from email.mime.text import MIMEText
from email.utils import formatdate

import fetch_news
import intelligence

SMTP_HOST = 'email.transcend-info.com'
SMTP_PORT = 587
DIGEST_SMTP_AUTH_USER = 'elvis_cheng@transcend-info.com'
DIGEST_SENDER_ADDR = 'bm@transcend-info.com'
DIGEST_SENDER_NAME = '每日產業新聞'
DIGEST_RECIPIENTS = ['bm@transcend-info.com']
DIGEST_MAX_ITEMS = 20

_INTERMEDIATE_CERT_PATH = os.path.join(os.path.dirname(__file__), 'sectigo-intermediate.pem')

# 查詢窗口固定回溯的小時數（每次執行都用，不是只有第一次）。
# 週五 08:00/16:30 執行到週一同一時段的排程空檔是 72 小時，
# 這裡取 96 小時留安全餘裕，同時也是 news_job 寫入延遲的容錯範圍。
DIGEST_LOOKBACK_HOURS = 96

# 已寄送文章 id 的保留天數／筆數上限：遠大於 DIGEST_LOOKBACK_HOURS 即可
# （文章離開回溯窗口後就不會再被選中，保留其 id 只是防止窗口邊界附近
# 因排程時間誤差重複寄送），加上筆數硬上限雙重保護 checkpoint 文件大小。
DIGEST_SENT_ID_RETENTION_DAYS = 14
DIGEST_SENT_ID_MAX_ENTRIES = 1000

# 新聞連結來自不可信的外部 RSS。只允許 http/https，避免 javascript:／
# data:／file: 等 scheme 被當成信件裡的可點擊連結（等同信件內 XSS／
# 本機檔案存取）。純文字內文與 HTML 版本都要套用同一個檢查。
_SAFE_URL_SCHEMES = ('http://', 'https://')

DIGEST_CATS = {
    'tw': {'cat': 'twMarket', 'label': '台灣 DRAM/Flash 產業新聞', 'lang': 'zh'},
    'us': {'cat': 'usMarket', 'label': 'US DRAM/Flash Industry News', 'lang': 'en'},
}

# 競品公司代號（intelligence.COMPANIES 扣掉創見自己）：這封信只做上游供應商
# ／產業市場情報，創見自己與競品的公司新聞已有前端 PR／競品動態分頁可看，
# 提到這些公司的文章一律排除，避免跟那邊的內容重複。
_COMPETITOR_CODES = frozenset(intelligence.COMPANIES) - {'2451'}

# PNG，不是 SVG——不少信箱用戶端（尤其 Outlook 桌面版）不支援在信件裡
# 顯示 SVG 圖片，PNG 相容性才夠好。
LOGO_URL = 'https://transcend-news.web.app/logos/transcend-white.png'
BRAND_COLOR = '#960014'

# Outlook 桌面版用 Word 引擎渲染 HTML 信件，不會把 <body> 上設定的
# font-family 往下繼承到表格/div 裡，只寫在 body 會被忽略、退回 Outlook
# 自己的中文預設字型（新細明體）。因此下面 HTML 樣板裡每一個會顯示文字
# 的元素都要重複寫一次這個字型堆疊，不能只靠 CSS 繼承。
FONT_STACK = "Calibri,'Microsoft JhengHei','微軟正黑體',sans-serif"

EVENT_LABELS = {
    'crisis':       ('風險', '#dc2626'),
    'financial':    ('財務', '#2563eb'),
    'supply_chain': ('供應鏈', '#c2410c'),
    'product':      ('產品', '#16a34a'),
    'partnership':  ('合作', '#7c3aed'),
    'market':       ('市場', '#ca8a04'),
    'other':        ('新聞', '#6b7280'),
}

EVENT_LABELS_EN = {
    'crisis':       ('Risk', '#dc2626'),
    'financial':    ('Financial', '#2563eb'),
    'supply_chain': ('Supply Chain', '#c2410c'),
    'product':      ('Product', '#16a34a'),
    'partnership':  ('Partnership', '#7c3aed'),
    'market':       ('Market', '#ca8a04'),
    'other':        ('News', '#6b7280'),
}


def _mentions_tracked_company(rules):
    """是否提及創見自己或任一競品（這幾家公司新聞已有前端分頁可看，這封信不重複收錄）。"""
    return any(e.get('code') in _COMPETITOR_CODES or e.get('code') == '2451'
               for e in rules.get('entities', []))


def _article_identity(article):
    """
    文章的穩定識別 id，用於 sentIds 比對「是否已寄過」。
    優先使用 Firestore 文件本身的 id（fetch_news.make_article_id 產生，
    寫入資料庫時就有）；缺少時（例如測試資料）退回同一套規則現算，
    確保同一篇文章不論何時計算都得到相同的值。
    """
    return article.get('id') or fetch_news.make_article_id(article.get('link'), article.get('title'))


def _safe_article_url(link):
    """
    只允許 http/https 開頭的網址進入信件（HTML 連結或純文字內文皆同）。
    javascript:／data:／file: 等 scheme、控制字元、空白或無法辨識 scheme
    的字串一律視為無效網址，回傳 None——呼叫端遇到 None 只顯示標題文字，
    不建立可點擊連結。
    """
    if not isinstance(link, str):
        return None
    candidate = link.strip()
    if not candidate:
        return None
    if any(ord(ch) < 0x20 or ord(ch) == 0x7f for ch in candidate):
        return None
    if not candidate.lower().startswith(_SAFE_URL_SCHEMES):
        return None
    return candidate


def select_digest_articles(articles, since_dt, sent_ids=None, limit=DIGEST_MAX_ITEMS):
    """
    純函式：從文章清單中挑出符合以下條件的文章：
      1. since_dt 之後發布（since_dt 是查詢回溯窗口的起點，不是「上次
         寄送時間」的游標——詳見模組開頭 at-least-once 設計說明）
      2. 尚未寄送過（_article_identity 不在 sent_ids 內）
      3. 經 intelligence 規則判定為相關（relevant）
      4. 不是創見自己或競品的公司新聞（只保留上游供應商/產業市場情報）
      5. 標題正規化後不重複（同一則新聞被多個來源/搜尋條件重複收錄時，
         只留下重要性分數最高的那一則）

    依重要性分數（importanceScore）由高到低排序，最多回傳 limit 筆。
    回傳 [(article, rule_analysis), ...]。
    """
    sent_ids = sent_ids or {}
    scored = []
    for article in articles:
        pub_dt = article.get('pubDate')
        if not isinstance(pub_dt, datetime.datetime) or pub_dt <= since_dt:
            continue
        if _article_identity(article) in sent_ids:
            continue
        rules = intelligence.analyze_article_rules(article)
        if not rules.get('relevant'):
            continue
        if _mentions_tracked_company(rules):
            continue
        scored.append((article, rules))
    scored.sort(key=lambda pair: pair[1]['importanceScore'], reverse=True)

    deduped = []
    seen_titles = set()
    for article, rules in scored:
        key = fetch_news.normalize_title(article.get('title'))
        if key and key in seen_titles:
            continue
        seen_titles.add(key)
        deduped.append((article, rules))
    return deduped[:limit]


def _event_badge(event_type, lang='zh'):
    table = EVENT_LABELS_EN if lang == 'en' else EVENT_LABELS
    return table.get(event_type, table['other'])


def _item_summary(article, rules, lang='zh'):
    """單則新聞的一行摘要文字（English 版不透過 intelligence.rule_summary，
    那個函式的來源/類型標籤是寫死的中文）。"""
    if lang != 'en':
        return intelligence.rule_summary(article, rules)
    title = ' '.join(str(article.get('title') or '').split())
    source = str(article.get('mediaName') or article.get('sourceName') or 'Unknown source')
    event_label, _ = _event_badge(rules.get('eventType'), lang='en')
    return f'{title} (Source: {source}; Type: {event_label})'[:300]


def build_digest_email(label, items, now=None, lang='zh'):
    """
    純函式：把挑選出的文章組成信件標題、純文字內文與 HTML 內文
    （多數信箱優先顯示 HTML 版本，純文字版供不支援 HTML 的用戶端顯示）。
    lang='en' 時標題／內文／頁尾一律用英文（美國場新聞來源本身就是英文，
    只有樣板文字需要跟著換語言，新聞標題/媒體名稱不需要另外翻譯）。
    回傳 (subject, text_body, html_body)。
    """
    now = now or datetime.datetime.now(datetime.timezone(datetime.timedelta(hours=8)))
    date_str = now.strftime('%Y-%m-%d')

    if lang == 'en':
        subject = f'[Transcend News Monitor] {date_str} {label} ({len(items)} items)'
        intro_line = f'{date_str} {label} — {len(items)} items (sorted by importance):'
        empty_line = f'No qualifying items for {label} today.'
        header_sub = f'{date_str} · {len(items)} items'
        footer_text = 'Automatically generated by Transcend News Monitor'
    else:
        subject = f'[創見新聞監控] {date_str} {label}（共 {len(items)} 則）'
        intro_line = f'{date_str} {label}，共 {len(items)} 則（依重要性排序）：'
        empty_line = f'目前沒有符合條件的{label}。'
        header_sub = f'{date_str}・共 {len(items)} 則'
        footer_text = '創見新聞監控系統自動產生・規則版摘要'

    text_lines = [intro_line, '']
    card_html_parts = []

    if not items:
        text_lines.append(empty_line)
    else:
        for i, (article, rules) in enumerate(items, 1):
            text_lines.append(f'{i}. {_item_summary(article, rules, lang)}')
            link = _safe_article_url(article.get('link'))
            if link:
                text_lines.append(f'   {link}')
            text_lines.append('')

            title = html.escape(str(article.get('title') or ''))
            default_source = 'Unknown source' if lang == 'en' else '未知來源'
            source = html.escape(str(article.get('mediaName') or article.get('sourceName') or default_source))
            badge_label, badge_color = _event_badge(rules.get('eventType'), lang)
            title_html = (
                f'<a href="{html.escape(link, quote=True)}" style="color:#1f2937;text-decoration:none;">{title}</a>'
                if link else title
            )
            card_html_parts.append(f'''
        <tr>
          <td style="padding:16px 0;border-bottom:1px solid #e5e7eb;font-family:{FONT_STACK};">
            <span style="display:inline-block;font-family:{FONT_STACK};font-size:14px;font-weight:bold;color:#ffffff;
                         background:{badge_color};border-radius:10px;padding:4px 10px;margin-bottom:8px;">
              {html.escape(badge_label)}
            </span>
            <div style="font-family:{FONT_STACK};font-size:18px;font-weight:600;line-height:1.5;margin-top:6px;">{title_html}</div>
            <div style="font-family:{FONT_STACK};font-size:14px;color:#6b7280;margin-top:6px;">{source}</div>
          </td>
        </tr>''')

    text_body = '\n'.join(text_lines)

    items_html = (
        ''.join(card_html_parts) if items else
        f'<tr><td style="padding:24px 0;color:#6b7280;font-size:16px;font-family:{FONT_STACK};">{html.escape(empty_line)}</td></tr>'
    )

    html_body = f'''<!doctype html>
<html>
<head>
<meta charset="utf-8">
<!--[if mso]>
<style type="text/css">
  body, table, td, div, span, a {{ font-family: Calibri, "Microsoft JhengHei", sans-serif !important; }}
</style>
<![endif]-->
</head>
<body style="margin:0;padding:0;background:#f5f6f8;font-family:{FONT_STACK};">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f5f6f8;padding:24px 0;font-family:{FONT_STACK};">
    <tr>
      <td align="center" style="font-family:{FONT_STACK};">
        <table role="presentation" width="600" cellpadding="0" cellspacing="0"
               style="background:#ffffff;border-radius:12px;overflow:hidden;max-width:600px;width:100%;font-family:{FONT_STACK};">
          <tr>
            <td style="background:{BRAND_COLOR};padding:20px 24px;font-family:{FONT_STACK};">
              <img src="{LOGO_URL}" alt="Transcend" height="22" style="display:block;border:0;">
              <div style="font-family:{FONT_STACK};color:#ffffff;font-size:19px;font-weight:bold;margin-top:10px;">{html.escape(label)}</div>
              <div style="font-family:{FONT_STACK};color:rgba(255,255,255,0.7);font-size:14px;margin-top:2px;">{header_sub}</div>
            </td>
          </tr>
          <tr>
            <td style="padding:8px 24px 4px 24px;font-family:{FONT_STACK};">
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="font-family:{FONT_STACK};">
                {items_html}
              </table>
            </td>
          </tr>
          <tr>
            <td style="padding:16px 24px;background:#f8fafc;color:#9ca3af;font-size:13px;font-family:{FONT_STACK};">
              {html.escape(footer_text)}
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>'''

    return subject, text_body, html_body


def send_email(subject, text_body, html_body, to_addrs, smtp_password):
    """
    寄出信件（純文字 + HTML 雙版本）。透過創見 Mail2000 郵件伺服器，
    587 埠 + STARTTLS，並額外載入中介憑證補完 TLS 信任鏈（見模組說明）。
    認證帳號與寄件地址不同（Send As），寄件地址使用已授權的 bm@ 群組信箱。
    """
    msg = MIMEMultipart('alternative')
    msg['Subject'] = subject
    msg['From'] = f'"{DIGEST_SENDER_NAME}" <{DIGEST_SENDER_ADDR}>'
    msg['To'] = ', '.join(to_addrs)
    msg['Date'] = formatdate(localtime=True)
    msg.attach(MIMEText(text_body, 'plain', 'utf-8'))
    msg.attach(MIMEText(html_body, 'html', 'utf-8'))

    context = ssl.create_default_context()
    context.load_verify_locations(cafile=_INTERMEDIATE_CERT_PATH)

    with smtplib.SMTP(SMTP_HOST, SMTP_PORT, timeout=30) as server:
        server.starttls(context=context)
        server.login(DIGEST_SMTP_AUTH_USER, smtp_password)
        server.sendmail(DIGEST_SENDER_ADDR, to_addrs, msg.as_string())


def _checkpoint_ref(db, name):
    return db.collection('meta').document(f'digest_{name}')


def get_digest_lookback_since(now=None, hours=DIGEST_LOOKBACK_HOURS):
    """純函式：本次查詢回溯窗口的起點。固定時數，不依賴任何 checkpoint 游標。"""
    now = now or datetime.datetime.now(datetime.timezone.utc)
    return now - datetime.timedelta(hours=hours)


def get_sent_article_ids(db, name):
    """讀取近期已成功寄出的文章 id 集合（dict：id → 寄送日期字串 YYYYMMDD）。沒有紀錄回傳空 dict。"""
    snap = _checkpoint_ref(db, name).get()
    if getattr(snap, 'exists', False):
        return dict((snap.to_dict() or {}).get('sentIds', {}) or {})
    return {}


def record_sent_articles(db, name, article_ids, now=None,
                          retention_days=DIGEST_SENT_ID_RETENTION_DAYS,
                          max_entries=DIGEST_SENT_ID_MAX_ENTRIES):
    """
    寄信成功後呼叫：把本次寄出的文章 id 併入已寄送集合。
    只應在確定寄信成功後呼叫——寄信失敗時完全不呼叫這個函式，
    下次執行才能用同一批候選文章重新嘗試（不會漏，也不會提早記成已寄）。
    依保留天數裁切過期項目，超過筆數上限時保留最新的，兩者都是避免
    checkpoint 文件無限增長的保護措施。
    """
    now = now or datetime.datetime.now(datetime.timezone.utc)
    today = now.strftime('%Y%m%d')
    sent_ids = get_sent_article_ids(db, name)
    for aid in article_ids:
        if aid:
            sent_ids[aid] = today
    cutoff = (now - datetime.timedelta(days=retention_days)).strftime('%Y%m%d')
    sent_ids = {k: v for k, v in sent_ids.items() if v >= cutoff}
    if len(sent_ids) > max_entries:
        newest = sorted(sent_ids.items(), key=lambda kv: kv[1], reverse=True)[:max_entries]
        sent_ids = dict(newest)
    _checkpoint_ref(db, name).set({'sentIds': sent_ids, 'lastRunAt': now}, merge=True)


def fetch_cat_articles(db, cat):
    """讀取指定分類（twMarket/usMarket）目前 Firestore 中的所有文章。"""
    docs = db.collection('news').where('cat', '==', cat).stream()
    return [d.to_dict() for d in docs]


def run_digest(db, key, smtp_password, now=None):
    """
    執行一次摘要寄信（key='tw' 或 'us'）。

    at-least-once 設計（見模組開頭說明）：查詢窗口固定回溯
    DIGEST_LOOKBACK_HOURS 小時，是否已寄送過改用 sentIds 集合判斷，
    不是「上次寄送時間」的移動游標。只有寄信成功後才把本次文章 id
    記入 sentIds；寄信失敗會拋出例外、完全不寫入 checkpoint，下次
    執行會用同一批候選文章重新嘗試，不會漏、也不會因為排程競態
    （news_job 在摘要查詢之後才寫入較舊日期的文章）被永久跳過。

    回傳 dict(count=已挑選則數)，供呼叫端印出執行結果。
    """
    cfg = DIGEST_CATS[key]
    now = now or datetime.datetime.now(datetime.timezone.utc)
    since = get_digest_lookback_since(now)
    sent_ids = get_sent_article_ids(db, key)
    articles = fetch_cat_articles(db, cfg['cat'])
    items = select_digest_articles(articles, since, sent_ids=sent_ids)
    # build_digest_email 的 now 是給信件標題/內文顯示台灣日期用，
    # 不能傳入上面 UTC 的 now（那是給 checkpoint 邏輯用），故意保持
    # 預設值讓它自己取台灣時間，避免 UTC 日期在台灣午夜前後顯示錯誤。
    subject, text_body, html_body = build_digest_email(cfg['label'], items, lang=cfg.get('lang', 'zh'))
    send_email(subject, text_body, html_body, DIGEST_RECIPIENTS, smtp_password)
    record_sent_articles(db, key, [_article_identity(a) for a, _ in items], now=now)
    return {'count': len(items)}
