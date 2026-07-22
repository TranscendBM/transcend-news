"""
創見資訊新聞監控系統 — 抓取邏輯
正式排程：Cloud Functions（見 main.py，部署於 transcend-news-tbm）
手動備援：GitHub Actions workflow_dispatch（python functions/fetch_news.py）
儲存結果到 Firebase Firestore（transcend-news-monitor 專案）
"""

import os
import json
import hashlib
import datetime
import sys
import time
import uuid
import requests
import feedparser
import firebase_admin
from firebase_admin import credentials, firestore

import intelligence

# ─── 情緒關鍵字 ───
POS_KW = ['獲獎','表揚','優勝','榮獲','營收','新高','成長','獲利','上漲','突破',
           '合作','推出','創新','領先','冠軍','熱銷','供不應求','超預期','亮眼',
           'award','growth','revenue','record high','profit','partnership','launch',
           'beats','strong','bullish','surge','rise','positive','upgrade','outperform']
NEG_KW = ['崩盤','瑕疵','虧損','下滑','召回','訴訟','罰款','跌','下跌','危機',
           '裁員','停產','倒閉','供應鏈中斷','市場萎縮','利空',
           'recall','loss','lawsuit','fine','crash','decline','fall','drop',
           'risk','bearish','weak','miss','cut','layoff','bankruptcy','downgrade']

# ─── 台灣媒體對照表 ───
TAIWAN_MEDIA = {
    'udn.com': '聯合報', 'money.udn.com': '經濟日報', 'ctee.com.tw': '工商時報',
    'chinatimes.com': '中時新聞網', 'technews.tw': '科技新報', 'ithome.com.tw': 'iThome',
    'digitimes.com.tw': '電子時報', 'digitimes.com': '電子時報',
    'eettaiwan.com': 'EE Times Taiwan', 'eetimes.com': 'EE Times',
    'anue.com.tw': '鉅亨網', 'cnyes.com': '鉅亨網', 'news.cnyes.com': '鉅亨網', 'm.cnyes.com': '鉅亨網',
    'wantrich.chinatimes.com': '旺得富理財網',
    'ltn.com.tw': '自由時報', 'ec.ltn.com.tw': '自由時報', 'setn.com': '三立新聞', 'tvbs.com.tw': 'TVBS',
    'ettoday.net': 'ETtoday', 'finance.ettoday.net': 'ETtoday財經雲', 'storm.mg': '風傳媒', 'businessweekly.com.tw': '商業週刊',
    'cw.com.tw': '天下雜誌', 'bnext.com.tw': 'Meet 創業小聚', 'inside.com.tw': 'INSIDE',
    'moneydj.com': '精實財經(MoneyDJ)', 'stockfeel.com.tw': '股感',
    'nownews.com': 'NOWnews', 'mirrormedia.mg': '鏡週刊', 'ctinews.com': '中天新聞',
    # 新增媒體
    'cna.com.tw': '中央社',
    'wealth.com.tw': '財訊雙周刊',
    'nextapple.com': '壹蘋新聞網', 'news.nextapple.com': '壹蘋新聞網',
    'mnews.tw': '鏡報', 'mirrordaily.news': '鏡報',
    'newtalk.tw': 'Newtalk',
    'gvm.com.tw': '遠見',
    'ustv.com.tw': '非凡財經',
    'trendforce.com': '集邦科技(TrendForce)',
    'pcdiy.com.tw': 'PC DIY',
    'imageinfo.com.tw': 'Image Media',
    'ioiotimes.com': 'ioio Times',
    'moneyweekly.com.tw': '理財周刊',
    'ftnn.com.tw': 'FTNN新聞網',
    'chinatimes.com/stock': '時報資訊',
}

# ─── RSS 新聞來源 ───
def get_sources(mode):
    """
    mode: 'morning' = 創見 + 競品 + 供應商
          'afternoon' = 美國市場 + 競品 + 供應商
          'all' = 全部
    """
    transcend = [
        {'label': '創見資訊', 'url': 'https://news.google.com/rss/search?q=創見資訊&hl=zh-TW&gl=TW&ceid=TW:zh-Hant', 'cat': 'transcend'},
        {'label': 'Transcend Info', 'url': 'https://news.google.com/rss/search?q=Transcend+Information+memory&hl=en&gl=TW&ceid=TW:zh-Hant', 'cat': 'transcend'},
        {'label': '2451 股票', 'url': 'https://news.google.com/rss/search?q=2451+創見+股票&hl=zh-TW&gl=TW&ceid=TW:zh-Hant', 'cat': 'transcend'},
        {'label': '聯合報科技', 'url': 'https://udn.com/rssfeed/news/2/6644?ch=news', 'cat': 'transcend', 'filter': '創見'},
        {'label': '中央社', 'url': 'https://www.cna.com.tw/rss/aall.aspx', 'cat': 'transcend', 'filter': '創見'},
        {'label': '財訊', 'url': 'https://www.wealth.com.tw/rss/all', 'cat': 'transcend', 'filter': '創見'},
        {'label': '遠見', 'url': 'https://www.gvm.com.tw/rss', 'cat': 'transcend', 'filter': '創見'},
        {'label': '壹蘋新聞', 'url': 'https://tw.nextapple.com/rss.xml', 'cat': 'transcend', 'filter': '創見'},
        {'label': 'TrendForce', 'url': 'https://www.trendforce.com/rss', 'cat': 'transcend', 'filter': 'Transcend'},
        {'label': 'Google-財訊創見', 'url': 'https://news.google.com/rss/search?q=創見+site:wealth.com.tw&hl=zh-TW&gl=TW&ceid=TW:zh-Hant', 'cat': 'transcend'},
        {'label': 'Google-中央社創見', 'url': 'https://news.google.com/rss/search?q=創見+site:cna.com.tw&hl=zh-TW&gl=TW&ceid=TW:zh-Hant', 'cat': 'transcend'},
        {'label': 'Google-電子時報創見', 'url': 'https://news.google.com/rss/search?q=創見+site:digitimes.com.tw&hl=zh-TW&gl=TW&ceid=TW:zh-Hant', 'cat': 'transcend'},
        {'label': 'Google-非凡創見', 'url': 'https://news.google.com/rss/search?q=創見+非凡財經&hl=zh-TW&gl=TW&ceid=TW:zh-Hant', 'cat': 'transcend'},
        {'label': 'Google-PC DIY', 'url': 'https://news.google.com/rss/search?q=Transcend+site:pcdiy.com.tw&hl=zh-TW&gl=TW&ceid=TW:zh-Hant', 'cat': 'transcend'},
        {'label': 'Google-TrendForce', 'url': 'https://news.google.com/rss/search?q=Transcend+site:trendforce.com&hl=en&gl=US&ceid=US:en', 'cat': 'transcend'},
        # ─── 補齊重要財經媒體 ───
        {'label': 'Google-經濟日報創見', 'url': 'https://news.google.com/rss/search?q=創見+site:money.udn.com&hl=zh-TW&gl=TW&ceid=TW:zh-Hant', 'cat': 'transcend'},
        {'label': 'Google-工商時報創見', 'url': 'https://news.google.com/rss/search?q=創見+site:ctee.com.tw&hl=zh-TW&gl=TW&ceid=TW:zh-Hant', 'cat': 'transcend'},
        {'label': 'Google-中時新聞創見', 'url': 'https://news.google.com/rss/search?q=創見+site:chinatimes.com&hl=zh-TW&gl=TW&ceid=TW:zh-Hant', 'cat': 'transcend'},
        {'label': 'Google-鉅亨網創見',   'url': 'https://news.google.com/rss/search?q=創見+site:cnyes.com&hl=zh-TW&gl=TW&ceid=TW:zh-Hant', 'cat': 'transcend'},
        {'label': 'Google-自由時報創見', 'url': 'https://news.google.com/rss/search?q=創見+site:ltn.com.tw&hl=zh-TW&gl=TW&ceid=TW:zh-Hant', 'cat': 'transcend'},
        {'label': 'Google-MoneyDJ創見',  'url': 'https://news.google.com/rss/search?q=創見+site:moneydj.com&hl=zh-TW&gl=TW&ceid=TW:zh-Hant', 'cat': 'transcend'},
        {'label': 'Google-時報資訊創見', 'url': 'https://news.google.com/rss/search?q=創見+site:chinatimes.com/stock&hl=zh-TW&gl=TW&ceid=TW:zh-Hant', 'cat': 'transcend'},
        {'label': 'Google-FTNN創見',     'url': 'https://news.google.com/rss/search?q=創見+FTNN&hl=zh-TW&gl=TW&ceid=TW:zh-Hant', 'cat': 'transcend'},
        {'label': 'Google-理財周刊創見', 'url': 'https://news.google.com/rss/search?q=創見+site:moneyweekly.com.tw&hl=zh-TW&gl=TW&ceid=TW:zh-Hant', 'cat': 'transcend'},
        # ─── 補齊 4/15 新聞稿未抓到的媒體 ───
        {'label': '鉅亨網台股 RSS',       'url': 'https://news.cnyes.com/rss/cat/tw_stock', 'cat': 'transcend', 'filter': '創見'},
        {'label': '鉅亨網台股新聞 RSS',   'url': 'https://news.cnyes.com/rss/cat/tw_stock_news', 'cat': 'transcend', 'filter': '創見'},
        {'label': 'Google-旺得富創見',    'url': 'https://news.google.com/rss/search?q=創見+site:wantrich.chinatimes.com&hl=zh-TW&gl=TW&ceid=TW:zh-Hant', 'cat': 'transcend'},
        {'label': '聯合報財經 RSS',        'url': 'https://udn.com/rssfeed/news/2/6645?ch=news', 'cat': 'transcend', 'filter': '創見'},
        {'label': '聯合報股市 RSS',        'url': 'https://udn.com/rssfeed/news/2/6881?ch=news', 'cat': 'transcend', 'filter': '創見'},
        {'label': '經濟日報 RSS',          'url': 'https://money.udn.com/rssfeed/news/1001/5591?ch=news', 'cat': 'transcend', 'filter': '創見'},
        {'label': 'Google-聯合報創見',    'url': 'https://news.google.com/rss/search?q=創見+site:udn.com&hl=zh-TW&gl=TW&ceid=TW:zh-Hant', 'cat': 'transcend'},
        # ─── 依 clipping report 補齊高頻媒體 ───
        {'label': 'Google-鏡報創見(mnews)',    'url': 'https://news.google.com/rss/search?q=創見+site:mnews.tw&hl=zh-TW&gl=TW&ceid=TW:zh-Hant', 'cat': 'transcend'},
        {'label': 'Google-鏡報創見(mirror)',   'url': 'https://news.google.com/rss/search?q=創見+site:mirrordaily.news&hl=zh-TW&gl=TW&ceid=TW:zh-Hant', 'cat': 'transcend'},
        {'label': 'Google-Newtalk創見',        'url': 'https://news.google.com/rss/search?q=創見+site:newtalk.tw&hl=zh-TW&gl=TW&ceid=TW:zh-Hant', 'cat': 'transcend'},
        {'label': 'Google-ETtoday財經創見',    'url': 'https://news.google.com/rss/search?q=創見+site:finance.ettoday.net&hl=zh-TW&gl=TW&ceid=TW:zh-Hant', 'cat': 'transcend'},
        {'label': 'Google-自由時報財經創見',   'url': 'https://news.google.com/rss/search?q=創見+site:ec.ltn.com.tw&hl=zh-TW&gl=TW&ceid=TW:zh-Hant', 'cat': 'transcend'},
        {'label': 'Google-非凡財經創見',       'url': 'https://news.google.com/rss/search?q=創見+site:ustv.com.tw&hl=zh-TW&gl=TW&ceid=TW:zh-Hant', 'cat': 'transcend'},
    ]
    us_market = [
        # ─── TrendForce 市場研究 ───
        {'label': 'TrendForce',          'url': 'https://www.trendforce.com/rss', 'cat': 'usMarket'},
        {'label': 'TrendForce DRAM',     'url': 'https://news.google.com/rss/search?q=TrendForce+DRAM+memory&hl=en&gl=US&ceid=US:en', 'cat': 'usMarket'},
        {'label': 'TrendForce NAND',     'url': 'https://news.google.com/rss/search?q=TrendForce+NAND+flash+storage&hl=en&gl=US&ceid=US:en', 'cat': 'usMarket'},
        {'label': 'TrendForce Flash',    'url': 'https://news.google.com/rss/search?q=TrendForce+flash+storage+market&hl=en&gl=US&ceid=US:en', 'cat': 'usMarket'},
        # ─── Kingston 金士頓（記憶體模組龍頭，上游市場觀測）───
        {'label': 'Kingston EN', 'url': 'https://news.google.com/rss/search?q=%22Kingston+Technology%22+OR+%22Kingston+FURY%22+memory+OR+SSD+OR+DRAM&hl=en&gl=US&ceid=US:en', 'cat': 'usMarket'},
        # ─── 應用端需求：AI / IPC / AIoT / 終端裝置 ───
        {'label': 'HBM Market',           'url': 'https://news.google.com/rss/search?q=HBM+high+bandwidth+memory+market+2025&hl=en&gl=US&ceid=US:en', 'cat': 'usMarket'},
        {'label': 'HBM AI Demand',        'url': 'https://news.google.com/rss/search?q=HBM+AI+GPU+memory+demand+supply&hl=en&gl=US&ceid=US:en', 'cat': 'usMarket'},
        {'label': 'AI Server DRAM HBM',  'url': 'https://news.google.com/rss/search?q=AI+server+DRAM+HBM+memory+demand&hl=en&gl=US&ceid=US:en', 'cat': 'usMarket'},
        {'label': 'AI Data Center Flash','url': 'https://news.google.com/rss/search?q=AI+data+center+flash+storage+NAND&hl=en&gl=US&ceid=US:en', 'cat': 'usMarket'},
        {'label': 'IPC Industrial Flash','url': 'https://news.google.com/rss/search?q=industrial+computing+IPC+embedded+flash+DRAM&hl=en&gl=US&ceid=US:en', 'cat': 'usMarket'},
        {'label': 'AIoT Memory Demand',  'url': 'https://news.google.com/rss/search?q=AIoT+edge+AI+memory+flash+storage+demand&hl=en&gl=US&ceid=US:en', 'cat': 'usMarket'},
        {'label': 'iPhone Mac NAND',     'url': 'https://news.google.com/rss/search?q=iPhone+Mac+Apple+NAND+flash+storage+demand&hl=en&gl=US&ceid=US:en', 'cat': 'usMarket'},
        {'label': 'Smart Device Flash',  'url': 'https://news.google.com/rss/search?q=smartphone+wearable+smart+device+DRAM+flash+demand&hl=en&gl=US&ceid=US:en', 'cat': 'usMarket'},
    ]
    tw_market = [
        # ─── 台灣科技媒體：Flash/DRAM/AI/IoT 相關 ───
        {'label': 'DigiTimes 記憶體',    'url': 'https://news.google.com/rss/search?q=site:digitimes.com.tw+DRAM+OR+Flash+OR+記憶體+OR+儲存&hl=zh-TW&gl=TW&ceid=TW:zh-Hant', 'cat': 'twMarket'},
        {'label': 'DigiTimes AI',        'url': 'https://news.google.com/rss/search?q=site:digitimes.com.tw+AI+OR+AIoT+OR+IPC+OR+智慧裝置&hl=zh-TW&gl=TW&ceid=TW:zh-Hant', 'cat': 'twMarket'},
        {'label': 'iThome 記憶體',       'url': 'https://news.google.com/rss/search?q=site:ithome.com.tw+DRAM+OR+Flash+OR+記憶體&hl=zh-TW&gl=TW&ceid=TW:zh-Hant', 'cat': 'twMarket'},
        {'label': 'iThome AI',           'url': 'https://news.google.com/rss/search?q=site:ithome.com.tw+AI+OR+AIoT+OR+智慧製造&hl=zh-TW&gl=TW&ceid=TW:zh-Hant', 'cat': 'twMarket'},
        {'label': '電子時報 記憶體',     'url': 'https://news.google.com/rss/search?q=site:epaper.com.tw+DRAM+OR+Flash+OR+記憶體&hl=zh-TW&gl=TW&ceid=TW:zh-Hant', 'cat': 'twMarket'},
        {'label': '科技新報 記憶體',     'url': 'https://news.google.com/rss/search?q=site:technews.tw+DRAM+OR+Flash+OR+記憶體+OR+儲存&hl=zh-TW&gl=TW&ceid=TW:zh-Hant', 'cat': 'twMarket'},
        {'label': '科技新報 AI',         'url': 'https://news.google.com/rss/search?q=site:technews.tw+AI+OR+AIoT+OR+IPC+OR+iPhone+OR+Mac&hl=zh-TW&gl=TW&ceid=TW:zh-Hant', 'cat': 'twMarket'},
        {'label': '數位時代 AI儲存',     'url': 'https://news.google.com/rss/search?q=site:bnext.com.tw+記憶體+OR+AI+OR+Flash+OR+儲存&hl=zh-TW&gl=TW&ceid=TW:zh-Hant', 'cat': 'twMarket'},
        {'label': 'EE Times Taiwan',     'url': 'https://news.google.com/rss/search?q=site:eettaiwan.com+DRAM+OR+Flash+OR+記憶體+OR+AI&hl=zh-TW&gl=TW&ceid=TW:zh-Hant', 'cat': 'twMarket'},
    ]
    competitors = [
        # ─── ADATA 威剛（多來源確保抓到）───
        {'label': 'ADATA 威剛 ZH',      'url': 'https://news.google.com/rss/search?q=威剛科技&hl=zh-TW&gl=TW&ceid=TW:zh-Hant', 'cat': 'competitor', 'brand': 'ADATA'},
        {'label': 'ADATA 3260',         'url': 'https://news.google.com/rss/search?q=3260+威剛&hl=zh-TW&gl=TW&ceid=TW:zh-Hant', 'cat': 'competitor', 'brand': 'ADATA'},
        {'label': 'ADATA EN',           'url': 'https://news.google.com/rss/search?q=ADATA+memory+storage+SSD&hl=en&gl=US&ceid=US:en', 'cat': 'competitor', 'brand': 'ADATA'},
        # ─── 其他競品 ───
        {'label': 'Innodisk 宜鼎',      'url': 'https://news.google.com/rss/search?q=宜鼎+Innodisk&hl=zh-TW&gl=TW&ceid=TW:zh-Hant', 'cat': 'competitor', 'brand': 'Innodisk'},
        {'label': 'Innodisk EN',        'url': 'https://news.google.com/rss/search?q=Innodisk+industrial+embedded&hl=en&gl=US&ceid=US:en', 'cat': 'competitor', 'brand': 'Innodisk'},
        {'label': 'Apacer 宇瞻',        'url': 'https://news.google.com/rss/search?q=宇瞻+Apacer&hl=zh-TW&gl=TW&ceid=TW:zh-Hant', 'cat': 'competitor', 'brand': 'Apacer'},
        {'label': 'Silicon Power 廣穎', 'url': 'https://news.google.com/rss/search?q=廣穎+Silicon+Power&hl=zh-TW&gl=TW&ceid=TW:zh-Hant', 'cat': 'competitor', 'brand': 'Silicon Power'},
        {'label': '十銓科技 Teamgroup',  'url': 'https://news.google.com/rss/search?q=十銓科技+Teamgroup&hl=zh-TW&gl=TW&ceid=TW:zh-Hant', 'cat': 'competitor', 'brand': 'Teamgroup'},
        {'label': 'Teamgroup EN',        'url': 'https://news.google.com/rss/search?q=Teamgroup+(SSD+OR+DRAM+OR+Industrial+OR+Embedded)&hl=en&gl=US&ceid=US:en', 'cat': 'competitor', 'brand': 'Teamgroup'},
        {'label': 'Lexar 雷克沙',       'url': 'https://news.google.com/rss/search?q=Lexar+記憶卡+OR+雷克沙&hl=zh-TW&gl=TW&ceid=TW:zh-Hant', 'cat': 'competitor', 'brand': 'Lexar'},
        {'label': 'PNY 必恩威',         'url': 'https://news.google.com/rss/search?q=PNY+必恩威&hl=zh-TW&gl=TW&ceid=TW:zh-Hant', 'cat': 'competitor', 'brand': 'PNY'},
    ]
    suppliers = [
        # ─── 供應商：僅中文 ───
        {'label': '三星 Samsung',    'url': 'https://news.google.com/rss/search?q=三星+Samsung+半導體+記憶體&hl=zh-TW&gl=TW&ceid=TW:zh-Hant', 'cat': 'supplier', 'brand': 'Samsung'},
        {'label': '美光 Micron',     'url': 'https://news.google.com/rss/search?q=美光+Micron+記憶體&hl=zh-TW&gl=TW&ceid=TW:zh-Hant', 'cat': 'supplier', 'brand': 'Micron'},
        {'label': 'SK 海力士',       'url': 'https://news.google.com/rss/search?q=SK+海力士+Hynix+記憶體&hl=zh-TW&gl=TW&ceid=TW:zh-Hant', 'cat': 'supplier', 'brand': 'SK Hynix'},
        {'label': 'Kioxia 鎧俠',     'url': 'https://news.google.com/rss/search?q=Kioxia+鎧俠+快閃+儲存&hl=zh-TW&gl=TW&ceid=TW:zh-Hant', 'cat': 'supplier', 'brand': 'Kioxia'},
        {'label': 'SanDisk 威騰',    'url': 'https://news.google.com/rss/search?q=SanDisk+威騰+儲存&hl=zh-TW&gl=TW&ceid=TW:zh-Hant', 'cat': 'supplier', 'brand': 'SanDisk/WD'},
        {'label': '慧榮 SMI',        'url': 'https://news.google.com/rss/search?q=慧榮+Silicon+Motion&hl=zh-TW&gl=TW&ceid=TW:zh-Hant', 'cat': 'supplier', 'brand': 'SMI'},
        {'label': '群聯 Phison',     'url': 'https://news.google.com/rss/search?q=群聯+Phison&hl=zh-TW&gl=TW&ceid=TW:zh-Hant', 'cat': 'supplier', 'brand': 'Phison'},
        {'label': '金士頓 Kingston', 'url': 'https://news.google.com/rss/search?q=金士頓+Kingston+記憶體+OR+SSD&hl=zh-TW&gl=TW&ceid=TW:zh-Hant', 'cat': 'supplier', 'brand': 'Kingston'},
        {'label': '瑞昱 Realtek',    'url': 'https://news.google.com/rss/search?q=瑞昱+Realtek&hl=zh-TW&gl=TW&ceid=TW:zh-Hant', 'cat': 'supplier', 'brand': 'Realtek'},
    ]

    community = [
        # ─── 社群觀測（PTT Stock，過濾含創見/2451的討論）───
        {'label': 'PTT Stock-創見', 'url': 'https://www.ptt.cc/bbs/Stock/index.rss', 'cat': 'community', 'filter': '創見'},
        {'label': 'PTT Stock-2451', 'url': 'https://www.ptt.cc/bbs/Stock/index.rss', 'cat': 'community', 'filter': '2451'},
    ]

    if mode == 'morning':
        return transcend + competitors + suppliers + community
    elif mode == 'afternoon':
        return us_market + competitors + suppliers + community
    elif mode == 'tw_market':
        return tw_market
    else:  # all
        return transcend + us_market + tw_market + competitors + suppliers + community


# ─── 標題相似度去重工具 ───
def is_too_similar(article, selected, threshold=0.5):
    """若與已選文章標題關鍵詞重疊率 >= threshold 則視為過度相似"""
    import re
    stop = {'the','and','for','that','with','this','are','has','have','from',
            'will','its','new','said','says','amid','after','over','into','more',
            'also','been','their','about','which','would','could','during'}
    def kws(text):
        words = set(re.findall(r'\b[a-zA-Z\u4e00-\u9fff]{3,}\b', text.lower()))
        return words - stop
    a_kws = kws(article.get('title',''))
    if not a_kws:
        return False
    for s in selected:
        s_kws = kws(s.get('title',''))
        if not s_kws:
            continue
        overlap = len(a_kws & s_kws) / min(len(a_kws), len(s_kws))
        if overlap >= threshold:
            return True
    return False

def cleanup_msn_articles(db):
    """刪除 Firestore 中所有 link 含 msn.com 的文章"""
    print("\n🗑️  清除 MSN 文章...")
    try:
        docs = list(db.collection('news').stream())
        to_delete = [d for d in docs if 'msn.com' in (d.to_dict().get('link') or '').lower()]
        print(f"  找到 {len(to_delete)} 篇 MSN 文章")
        deleted = 0
        for i in range(0, len(to_delete), 400):
            batch = db.batch()
            for d in to_delete[i:i+400]:
                batch.delete(d.reference)
            batch.commit()
            deleted += len(to_delete[i:i+400])
        print(f"  ✅ 已刪除 {deleted} 篇")
    except Exception as e:
        print(f"  ✗ 清除失敗: {e}")


def analyze_sentiment(title, content=''):
    text = (title + ' ' + content).lower()
    pos = sum(1 for k in POS_KW if k.lower() in text)
    neg = sum(1 for k in NEG_KW if k.lower() in text)
    if pos > neg:
        return 'positive'
    elif neg > pos:
        return 'negative'
    return 'neutral'


def extract_media_from_title(title):
    """從標題後綴提取媒體名稱（Google News 格式：「標題 - 媒體名稱」）"""
    import re
    if not title:
        return None
    match = re.search(r'[-–—]\s*([^-–—]{2,40})\s*$', title)
    if not match:
        return None
    candidate = match.group(1).strip()
    for name in TAIWAN_MEDIA.values():
        if candidate == name or name in candidate or candidate in name:
            return name
    if 2 <= len(candidate) <= 30 and not candidate.isdigit():
        return candidate
    return None


def get_media_name(entry, link='', title=''):
    # 1. 優先從標題後綴解析（Google News 格式）
    from_title = extract_media_from_title(title)
    if from_title:
        return from_title

    # 2. 從 author 欄位比對
    author = getattr(entry, 'author', '') or ''
    if author and len(author) < 40 and '@' not in author and 'google' not in author.lower():
        for name in TAIWAN_MEDIA.values():
            if name in author or author in name:
                return name
        if len(author) >= 2 and not author.startswith('http'):
            return author

    # 3. 從連結 domain 比對（排除 news.google.com）
    try:
        from urllib.parse import urlparse
        domain = urlparse(link).netloc.replace('www.', '')
        if domain and 'google' not in domain:
            for key, name in TAIWAN_MEDIA.items():
                if key in domain or domain in key:
                    return name
            return domain
    except Exception:
        pass

    return '未知媒體'


def make_article_id(link, title):
    raw = (link or title or '') + 'v1'
    return hashlib.md5(raw.encode('utf-8')).hexdigest()[:20]


def parse_date(entry):
    """Try multiple date fields, return datetime object."""
    for field in ['published_parsed', 'updated_parsed', 'created_parsed']:
        val = getattr(entry, field, None)
        if val:
            try:
                return datetime.datetime(*val[:6], tzinfo=datetime.timezone.utc)
            except Exception:
                pass
    return datetime.datetime.now(datetime.timezone.utc)


def clean_html(text):
    import re
    return re.sub(r'<[^>]+>', '', text or '').strip()


# ══════════════════════════════════════════════════════════════
# 純函式工具（無外部相依，供主流程與單元測試共用）
# ══════════════════════════════════════════════════════════════

def normalize_title(title, max_len=30):
    """標題正規化（去除空白與符號、轉小寫、取前 max_len 字元），用於新聞去重"""
    import re
    return re.sub(r'[\s\W]+', '', (title or '')).lower()[:max_len]


def is_tw_market_open(dt):
    """判斷給定「台灣時間」datetime 是否在台股交易時段（週一~五 09:00–13:35，含收盤緩衝）"""
    if dt.weekday() > 4:          # 5=週六, 6=週日
        return False
    minutes = dt.hour * 60 + dt.minute
    return 9 * 60 <= minutes <= 13 * 60 + 35


def is_stock_stale(updated_at, now, stale_minutes=30):
    """
    股價資料是否過期：交易時段中超過 stale_minutes 未更新即視為過期。
    非交易時段顯示的是最近收盤價，不視為過期。
    updated_at / now 皆為台灣時間 datetime；updated_at 為 None 一律視為過期。
    （前端 index.html 的過期標示邏輯與此函式一致）
    """
    if updated_at is None:
        return True
    if not is_tw_market_open(now):
        return False
    return (now - updated_at).total_seconds() > stale_minutes * 60


def finmind_revenue_period(date_str):
    """
    FinMind 月營收 date 欄位（申報月，格式 'YYYY-MM...'）→ 實際營收 (year, month)。
    申報月比實際營收月晚 1 個月：'2024-03' → (2024, 2)、'2024-01' → (2023, 12)。
    格式錯誤回傳 None。
    """
    try:
        yr, mon = int(str(date_str)[:4]), int(str(date_str)[5:7])
    except (ValueError, TypeError):
        return None
    if yr < 1000 or not 1 <= mon <= 12:
        return None
    if mon == 1:
        return (yr - 1, 12)
    return (yr, mon - 1)


def roc_date_to_iso(roc_str):
    """民國日期 '114/04/24' 或 '114-04-24' → '2025-04-24'；無法解析則原樣回傳"""
    try:
        s = str(roc_str).strip().replace('-', '/')
        parts = s.split('/')
        return f"{int(parts[0]) + 1911}-{parts[1]}-{parts[2]}"
    except Exception:
        return roc_str


def extract_reporter(raw_author):
    """嘗試從作者欄位辨識個人記者姓名（排除媒體機構名稱）"""
    if not raw_author:
        return None
    a = raw_author.strip()
    if not a or len(a) < 2 or len(a) > 15 or '@' in a or 'http' in a:
        return None
    # 排除已知媒體名稱
    for name in TAIWAN_MEDIA.values():
        if a == name or name in a or a in name:
            return None
    # 中文人名（2-4字）或英文人名（含空格大寫開頭）
    import re
    is_cn = bool(re.match(r'^[\u4e00-\u9fa5]{2,4}$', a))
    is_en = bool(re.match(r'^[A-Z][a-z]+([ ][A-Z][a-z]+)+$', a))
    return a if (is_cn or is_en) else None


RSS_TIMEOUT = 15   # 秒；RSS 來源逾時上限（feedparser 自抓網路沒有 timeout，會卡死排程）


def fetch_source(src, retry=2):
    for attempt in range(retry + 1):
        try:
            # 先用 requests（帶 timeout）取回內容，再交給 feedparser 解析，
            # 避免單一來源無回應拖垮整個排程
            resp = requests.get(src['url'], timeout=RSS_TIMEOUT, headers={
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
            })
            feed = feedparser.parse(resp.content)
            items = []
            kw_filter = src.get('filter')
            for entry in feed.entries[:30]:
                title = clean_html(getattr(entry, 'title', ''))
                if not title:
                    continue
                if kw_filter and kw_filter not in title:
                    continue
                link = getattr(entry, 'link', '') or getattr(entry, 'id', '')

                # ─── 過濾 MSN 連結 ───
                if 'msn.com' in (link or '').lower():
                    continue

                content = clean_html(getattr(entry, 'summary', '') or getattr(entry, 'description', ''))[:500]
                pub_date = parse_date(entry)

                # ─── 60 天舊文過濾：跳過超過 60 天的文章 ───
                now_utc = datetime.datetime.now(datetime.timezone.utc)
                if pub_date and (now_utc - pub_date).days > 60:
                    continue

                raw_author = (getattr(entry, 'author', '') or '').strip()
                media_name = get_media_name(entry, link, title)

                # 去除標題後面的「- 媒體名稱」（Google News 格式）
                import re as _re
                suffix_match = _re.search(r'\s*[-–—]\s*([^-–—]{2,40})\s*$', title)
                if suffix_match:
                    removed = suffix_match.group(1).strip()
                    if media_name != '未知媒體' and (removed == media_name or media_name in removed or removed in media_name):
                        title = title[:suffix_match.start()].strip()

                article = {
                    'id': make_article_id(link, title),
                    'title': title,
                    'content': content,
                    'link': link,
                    'pubDate': pub_date,
                    'sentiment': analyze_sentiment(title, content),
                    'cat': src['cat'],
                    'brand': src.get('brand'),
                    'sourceName': src['label'],
                    'mediaName': media_name,
                    'rawAuthor': raw_author,
                    'fetchedAt': datetime.datetime.now(datetime.timezone.utc),
                    'fetchMode': os.environ.get('FETCH_MODE', 'all'),
                }
                items.append(article)
            print(f"  ✓ {src['label']}: {len(items)} 則新聞")
            return items
        except Exception as e:
            if attempt < retry:
                print(f"  ⚠ {src['label']} 失敗 (嘗試 {attempt+1}/{retry}): {e}")
                time.sleep(2)
            else:
                print(f"  ✗ {src['label']} 最終失敗: {e}")
                return []


def save_to_firestore(db, articles):
    """批次寫入 Firestore，每 400 筆一批（低於單批 500 上限）"""
    batch_size = 400
    saved = 0
    for i in range(0, len(articles), batch_size):
        batch = db.batch()
        chunk = articles[i:i + batch_size]
        for a in chunk:
            ref = db.collection('news').document(a['id'])
            batch.set(ref, a, merge=True)
        batch.commit()
        saved += len(chunk)
    return saved


def enqueue_ai_jobs(db, articles):
    """把值得分析的新文章放入 ai_jobs，供公司電腦上的本機 AI worker 處理。"""
    jobs = []
    for article in articles:
        content_hash = article_content_hash(article)
        job = intelligence.build_ai_job(article, content_hash, firestore.SERVER_TIMESTAMP)
        if job:
            jobs.append(job)

    batch_size = 400
    for i in range(0, len(jobs), batch_size):
        batch = db.batch()
        for job in jobs[i:i + batch_size]:
            ref = db.collection('ai_jobs').document(job['articleId'])
            batch.set(ref, job, merge=True)
        batch.commit()
    if jobs:
        print(f"  🤖 本機 AI 待分析工作：{len(jobs)} 筆")
    return len(jobs)


# ── 文章內容雜湊：判斷「內容是否真的變了」用 ──────────────────
# 只納入穩定的內容欄位；fetchedAt / fetchMode 這類每次執行都會變的欄位
# 不參與雜湊，否則永遠判定為「有變更」。
_HASH_FIELDS = ('title', 'content', 'link', 'sentiment', 'cat', 'brand',
                'sourceName', 'mediaName', 'rawAuthor', 'pushCount')


def article_content_hash(article):
    """對文章的穩定內容欄位計算雜湊（含 pubDate），內容不變則雜湊不變"""
    pub = article.get('pubDate')
    pub_s = pub.isoformat() if hasattr(pub, 'isoformat') else str(pub or '')
    parts = [pub_s] + [str(article.get(f) or '') for f in _HASH_FIELDS]
    return hashlib.md5('\x1f'.join(parts).encode('utf-8')).hexdigest()[:16]


# ── 去重索引（分片設計）──────────────────────────────────────
# meta/newsIndex_0 … newsIndex_f 共 16 個分片文件，依文章 id（md5 hex）
# 第一個字元分片，內容為 hashes: {文章id → {h: 內容雜湊, t: YYYYMMDD}}。
#
# 為什麼要分片（1 MiB / 40,000 index-entry 上限評估）：
#   90 天保留窗口估計約 2~4 萬篇不重複文章。單一文件時
#   大小 ≈ 45B × 36K ≈ 1.6MB（超過 1 MiB 上限）、
#   map 葉欄位自動索引項 ≈ 4 × 36K ≈ 144K（超過 40K 上限）。
#   分 16 片後每片 ≈ 2.3K 條 ≈ 100KB / 9K 索引項，皆有數倍餘裕；
#   另設 NEWS_INDEX_MAX_ENTRIES_PER_SHARD 硬上限做大小保護。
NEWS_INDEX_COLLECTION = 'meta'
NEWS_INDEX_RETENTION_DAYS = 90            # 需大於 fetch_source 的 60 天舊文窗口
NEWS_INDEX_MAX_ENTRIES_PER_SHARD = 6000   # 硬上限：約 <300KB、<24K 索引項/分片
_HEX_CHARS = set('0123456789abcdef')


def _shard_doc_id(article_id):
    """文章 id（md5 hex）→ 索引分片文件 id；非 hex 開頭一律落到 0 號分片"""
    c = (article_id or '0')[0].lower()
    return f"newsIndex_{c if c in _HEX_CHARS else '0'}"


def _run_in_transaction(db, fn):
    """
    在 Firestore transaction 內執行 fn(txn)。
    測試用 FakeDB 提供 run_in_transaction(fn) 介面時改用之（語意相同：
    fn 內的讀取看到的是最新狀態、寫入原子生效）。
    """
    if hasattr(db, 'run_in_transaction'):
        return db.run_in_transaction(fn)
    transaction = db.transaction()
    return firestore.transactional(fn)(transaction)


def _txn_merge_index_shard(db, shard_id, new_entries, cutoff):
    """
    以 transaction 將 new_entries 合併進索引分片：
    txn 內重新讀取最新分片內容再合併，消除 news_job / community_job
    並行修改索引時的 lost-update 競態（後寫者不會蓋掉先寫者的條目）。
    同時做保留期瘦身與分片大小硬上限保護。
    """
    ref = db.collection(NEWS_INDEX_COLLECTION).document(shard_id)

    def fn(txn):
        snap = ref.get(transaction=txn)
        current = {}
        if getattr(snap, 'exists', False):
            current = (snap.to_dict() or {}).get('hashes', {}) or {}
        merged = {**current, **new_entries}
        pruned = {k: v for k, v in merged.items() if v.get('t', '') >= cutoff}
        if len(pruned) > NEWS_INDEX_MAX_ENTRIES_PER_SHARD:
            newest = sorted(pruned.items(), key=lambda kv: kv[1].get('t', ''),
                            reverse=True)[:NEWS_INDEX_MAX_ENTRIES_PER_SHARD]
            pruned = dict(newest)
        txn.set(ref, {'hashes': pruned, 'updatedAt': firestore.SERVER_TIMESTAMP})

    _run_in_transaction(db, fn)


def save_new_articles(db, articles, now=None):
    """
    只寫入「新文章」或「內容確實變更」的文章，避免每 15 分鐘重寫舊新聞。
    已存在且未變更的文章完全不碰（不 set、不 update、不刷新 fetchedAt）。

    索引讀取失敗時**中止本次儲存**（拋出例外）：絕不以空索引繼續寫入，
    否則會誤判全部為新文章、且回寫時覆蓋掉原索引。

    回傳 dict(added=…, updated=…, skipped=…)。
    """
    if not articles:
        return {'added': 0, 'updated': 0, 'skipped': 0}
    now = now or datetime.datetime.now(datetime.timezone(datetime.timedelta(hours=8)))
    today = now.strftime('%Y%m%d')

    # ① 讀取相關索引分片；任何一片讀取失敗 → 中止（不寫入任何文章）
    shard_ids = sorted({_shard_doc_id(a['id']) for a in articles})
    index = {}
    try:
        for sid in shard_ids:
            snap = db.collection(NEWS_INDEX_COLLECTION).document(sid).get()
            if getattr(snap, 'exists', False):
                index.update((snap.to_dict() or {}).get('hashes', {}) or {})
    except Exception as e:
        raise RuntimeError(f'newsIndex 分片 {sid} 讀取失敗，中止本次儲存'
                           f'（避免以空索引重寫全部文章/覆蓋索引）: {e}') from e

    # ② 比對內容雜湊，找出需要寫入的文章
    to_write = []
    new_entries_by_shard = {}
    added = updated = skipped = 0
    for a in articles:
        h = article_content_hash(a)
        entry = index.get(a['id'])
        if entry and entry.get('h') == h:
            skipped += 1
            continue
        updated += 1 if entry else 0
        added += 0 if entry else 1
        to_write.append(a)
        new_entries_by_shard.setdefault(_shard_doc_id(a['id']), {})[a['id']] = {'h': h, 't': today}

    # ③ 先寫文章並建立 AI 待辦、最後才更新索引：順序不可顛倒。
    #    若先記索引，後續寫入失敗時會被永久誤判為已處理；
    #    現在這個順序若在索引階段失敗，下次只會冪等地重試。
    if to_write:
        save_to_firestore(db, to_write)
        enqueue_ai_jobs(db, to_write)

    # ④ transaction 逐分片合併回寫（見 _txn_merge_index_shard）
    cutoff = (now - datetime.timedelta(days=NEWS_INDEX_RETENTION_DAYS)).strftime('%Y%m%d')
    for sid, entries in new_entries_by_shard.items():
        _txn_merge_index_shard(db, sid, entries, cutoff)

    print(f"  📊 寫入統計：新增 {added} / 更新 {updated} / 跳過(未變更) {skipped}")
    return {'added': added, 'updated': updated, 'skipped': skipped}


# ══════════════════════════════════════════════════════════════
# 排程執行鎖（Firestore lease lock，transaction 原子操作）
# 防止排程因外部服務延遲而與下一次觸發重疊執行。
# - 取得/過期接管都在 transaction 內完成，兩個執行個體同時搶鎖只會有一個成功
# - 每次持鎖產生唯一 owner token（UUID），release 只刪除 token 相符的鎖，
#   舊執行者不可能誤刪已被接管的新鎖
# - 鎖有到期時間（lease）：函式異常死掉時，過期後可被接管，不會永久鎖死。
#   TTL 必須大於該排程函式的 timeout。
# ══════════════════════════════════════════════════════════════

def is_lock_expired(lock_dict, now):
    """純函式：鎖文件內容是否已過期（不存在/缺欄位一律視為過期）"""
    if not lock_dict:
        return True
    exp = lock_dict.get('expiresAt')
    if exp is None:
        return True
    return exp <= now


def _lock_ref(db, name):
    return db.collection('meta').document(f'lock_{name}')


def acquire_lock(db, name, ttl_minutes=15, now=None):
    """
    以 transaction 原子性取得排程鎖。
    成功回傳本次持鎖的 owner token（uuid 字串，交給 release_lock 用）；
    他人持鎖中（未過期）回傳 None，呼叫端應跳過本次執行。
    過期鎖的接管同樣在 transaction 內：txn 重讀最新狀態，
    兩個執行個體同時接管時只有先提交者成功。
    """
    now = now or datetime.datetime.now(datetime.timezone.utc)
    token = uuid.uuid4().hex
    ref = _lock_ref(db, name)
    payload = {
        'owner':      token,
        'revision':   os.environ.get('K_REVISION', 'local'),
        'acquiredAt': now,
        'expiresAt':  now + datetime.timedelta(minutes=ttl_minutes),
    }

    def fn(txn):
        snap = ref.get(transaction=txn)
        current = snap.to_dict() if getattr(snap, 'exists', False) else None
        if current is not None and not is_lock_expired(current, now):
            return None                      # 他人持鎖中
        if current is not None:
            print(f"  🔓 鎖 {name} 已過期（前次執行可能異常中止），接管")
        txn.set(ref, payload)
        return token

    try:
        return _run_in_transaction(db, fn)
    except Exception as e:
        print(f"  ⚠ 取得鎖 {name} 失敗，保守跳過本次執行: {e}")
        return None


def release_lock(db, name, token):
    """
    釋放排程鎖（呼叫端應放在 finally 內）。
    transaction 內檢查 owner token：只刪除自己持有的鎖；
    鎖已被接管（token 不符）時不動作，回傳 False。
    """
    if not token:
        return False
    ref = _lock_ref(db, name)

    def fn(txn):
        snap = ref.get(transaction=txn)
        current = snap.to_dict() if getattr(snap, 'exists', False) else None
        if current and current.get('owner') == token:
            txn.delete(ref)
            return True
        return False

    try:
        return _run_in_transaction(db, fn)
    except Exception as e:
        print(f"  ⚠ 釋放鎖 {name} 失敗（將於到期後自動失效）: {e}")
        return False


def fetch_monthly_revenue(db, stock_code='2451'):
    """從公開資訊觀測站（MOPS）抓取月營收並存入 Firebase revenue/{stock_code}"""
    import re
    from bs4 import BeautifulSoup

    print(f"\n💰 抓取 {stock_code} 月營收（公開資訊觀測站）...")
    all_records = []
    seen = set()

    def parse_num(s):
        s2 = re.sub(r'[^\d\-\.]', '', str(s or ''))
        try: return float(s2) if '.' in s2 else (int(s2) if s2 else 0)
        except: return 0

    def try_fetch(url, method='POST', payload=None, encoding='utf-8'):
        hdrs = {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
            'Accept-Language': 'zh-TW,zh;q=0.9',
            'Content-Type': 'application/x-www-form-urlencoded',
            'Referer': 'https://mops.twse.com.tw/',
            'Origin':  'https://mops.twse.com.tw',
            'X-Requested-With': 'XMLHttpRequest',
        }
        if method == 'POST':
            r = requests.post(url, data=payload, headers=hdrs, timeout=20)
        else:
            r = requests.get(url, headers=hdrs, timeout=20)
        r.encoding = encoding
        return r

    html = None
    filter_code = stock_code  # 用於表格過濾
    BASE_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'

    # ── 方法 1：FinMind 開源 API（不受 IP 限制，免費無需 token）────
    try:
        import json as _json
        now_tw = datetime.datetime.now(datetime.timezone(datetime.timedelta(hours=8)))
        start_date = f'{now_tw.year - 10}-01-01'
        url1 = (
            'https://api.finmindtrade.com/api/v4/data'
            f'?dataset=TaiwanStockMonthRevenue&data_id={stock_code}'
            f'&start_date={start_date}&token='
        )
        r1 = requests.get(url1, headers={'User-Agent': BASE_UA}, timeout=20)
        print(f"  [方法1 FinMind] HTTP {r1.status_code}, {len(r1.content)} bytes")
        if r1.status_code == 200:
            data = _json.loads(r1.text)
            rows = data.get('data', [])
            print(f"  [方法1] 取得 {len(rows)} 筆記錄")
            if rows:
                print(f"  [方法1] 第一筆 keys: {list(rows[0].keys())}")
            for row in rows:
                try:
                    # FinMind 欄位: date(YYYY-MM), revenue(元), revenue_year(去年同期,元),
                    #   revenue_month(累計,元), revenue_year_difference(YoY%), revenue_month_difference(MoM%)
                    # FinMind date = 申報月（比實際營收月多 1 個月），需減 1 還原
                    period = finmind_revenue_period(row.get('date', ''))
                    if not period:
                        continue
                    yr, mon = period
                    rev     = int(str(row.get('revenue', 0) or 0).replace(',', '') or 0)
                    prev_yr = int(str(row.get('revenue_year', 0) or row.get('last_year_revenue', 0) or 0).replace(',', '') or 0)
                    cumrev  = int(str(row.get('revenue_month', 0) or 0).replace(',', '') or 0)
                    yoy_pct = float(row.get('revenue_year_difference', 0) or 0)
                    mom_pct = float(row.get('revenue_month_difference', 0) or 0)
                    if yr < 2000 or not (1 <= mon <= 12):
                        continue
                    key = f'{yr}-{mon:02d}'
                    if key in seen:
                        continue
                    seen.add(key)
                    all_records.append({
                        'year': yr, 'month': mon, 'revenue': rev,
                        'cumRevenue': cumrev, 'prevYr': prev_yr,
                        'momPct': mom_pct, 'yoyPct': yoy_pct,
                        'label': key,
                    })
                except Exception:
                    continue
    except Exception as e:
        print(f"  [方法1] 失敗: {e}")

    # ── 方法 2：MOPS NAS 靜態 HTML（不同 subdomain，較少受限）─
    if not all_records:
        try:
            now_tw = datetime.datetime.now(datetime.timezone(datetime.timedelta(hours=8)))
            roc_yr = now_tw.year - 1911
            # 嘗試每年靜態檔
            for yr_offset in range(3):
                if all_records:
                    break
                yr = roc_yr - yr_offset
                for url_try in [
                    f'https://mops.twse.com.tw/nas/t05/t05st10_{yr}.html',
                    f'https://mops.twse.com.tw/nas/t05/t05st10.html',
                ]:
                    try:
                        r2 = requests.get(url_try, headers={'User-Agent': BASE_UA}, timeout=15)
                        print(f"  [方法2] {url_try} → HTTP {r2.status_code}, {len(r2.content)} bytes")
                        for enc in ['big5', 'utf-8', 'cp950']:
                            try:
                                r2.encoding = enc
                                if '<table' in r2.text.lower() and stock_code in r2.text:
                                    print(f"  [方法2] 找到表格 (enc={enc})")
                                    html = r2.text
                                    break
                            except Exception:
                                continue
                        if html:
                            break
                    except Exception as e:
                        print(f"  [方法2] {url_try} 失敗: {e}")
        except Exception as e:
            print(f"  [方法2] 整體失敗: {e}")

    # 方法 1 已直接填入 all_records，不需 HTML 解析
    if all_records:
        print(f"  [方法1 直接 JSON] 已取得 {len(all_records)} 筆，跳過 HTML 解析")
    elif not html:
        print("  ✗ 無法取得 MOPS 資料")
        return
    else:
        soup = BeautifulSoup(html, 'lxml')
        tables = soup.find_all('table')
        print(f"  找到 {len(tables)} 個 <table>")

        for ti, table in enumerate(tables):
            rows = table.find_all('tr')
            if len(rows) < 2:
                continue
            # 印出前兩列幫助除錯
            for ri in range(min(2, len(rows))):
                sample = [c.get_text(strip=True) for c in rows[ri].find_all(['th','td'])]
                print(f"  Table[{ti}] Row[{ri}]: {sample[:10]}")

            for row in rows:
                cols = [td.get_text(strip=True) for td in row.find_all('td')]
                if len(cols) < 6:
                    continue

                # ── 自動找 ROC 年份欄（值介於 100~200）和月份欄（值 1~12 且緊接在年後）
                year_idx = month_idx = None
                for i, c in enumerate(cols):
                    v = parse_num(c)
                    if 100 <= v <= 200 and year_idx is None:
                        year_idx = i
                    elif year_idx is not None and 1 <= v <= 12 and month_idx is None:
                        month_idx = i
                        break

                if year_idx is None or month_idx is None:
                    continue

                try:
                    roc_year = parse_num(cols[year_idx])
                    month    = int(parse_num(cols[month_idx]))
                    ad_year  = int(roc_year) + 1911
                    base     = month_idx + 1        # 當月營收欄起始
                    if base >= len(cols):
                        continue

                    revenue = parse_num(cols[base])
                    cumrev  = parse_num(cols[base+1]) if base+1 < len(cols) else 0
                    prev_yr = parse_num(cols[base+2]) if base+2 < len(cols) else 0
                    mom_pct = parse_num(cols[base+4]) if base+4 < len(cols) else 0
                    yoy_pct = parse_num(cols[base+5]) if base+5 < len(cols) else 0

                    key = f'{ad_year}-{month:02d}'
                    if key in seen:
                        continue
                    seen.add(key)
                    all_records.append({
                        'year':       ad_year,
                        'month':      month,
                        'revenue':    int(revenue),
                        'cumRevenue': int(cumrev),
                        'prevYr':     int(prev_yr),
                        'momPct':     float(mom_pct),
                        'yoyPct':     float(yoy_pct),
                        'label':      key,
                    })
                except Exception:
                    continue

    all_records.sort(key=lambda x: (x['year'], x['month']))

    if all_records:
        db.collection('revenue').document(stock_code).set({
            'records':   all_records,
            'stockCode': stock_code,
            'updatedAt': firestore.SERVER_TIMESTAMP,
        })
        first, last = all_records[0]['label'], all_records[-1]['label']
        print(f"  ✅ 月營收已儲存 {len(all_records)} 筆（{first} ～ {last}）")
    else:
        print("  ⚠ 未解析到月營收（請把上方除錯輸出貼給開發者）")


def fetch_stock_prices(db):
    """抓取台股行情（使用台灣證交所官方 API）並存入 Firebase stocks/latest"""
    # tse = 上市（TWSE），otc = 上櫃（TPEx）
    # exchange: 'tse'=上市, 'otc'=上櫃, 'auto'=自動偵測(同時查兩個交易所)
    STOCKS = {
        '2451': ('創見資訊',  'tse'),   # 上市
        '3260': ('威剛科技',  'auto'),  # 自動偵測
        '4973': ('廣穎電通',  'auto'),  # 自動偵測
        '5289': ('宜鼎國際',  'auto'),  # 自動偵測
        '4967': ('十銓科技',  'tse'),   # 上市
        '8271': ('宇瞻科技',  'tse'),   # 上市
    }
    print("\n📈 抓取台股行情（台灣證交所）...")
    # auto 模式：同時帶入 tse_ 和 otc_ 前綴，API 會自動忽略不存在的那個
    all_codes = []
    for code, (_, ex) in STOCKS.items():
        if ex == 'auto':
            all_codes.append(f"tse_{code}.tw")
            all_codes.append(f"otc_{code}.tw")
        else:
            all_codes.append(f"{ex}_{code}.tw")
    ex_ch = '|'.join(all_codes)
    url = f"https://mis.twse.com.tw/stock/api/getStockInfo.jsp?ex_ch={ex_ch}&json=1&delay=0"
    try:
        r = requests.get(url, headers={
            'Referer': 'https://mis.twse.com.tw/',
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
        }, timeout=15)
        items = r.json().get('msgArray', [])
    except Exception as e:
        print(f"  ⚠ TWSE API 失敗: {e}")
        return

    stock_data = {}
    seen_codes = set()   # 防止 tse/otc 重複
    for item in items:
        code = item.get('c', '')
        if code not in STOCKS or code in seen_codes:
            continue
        seen_codes.add(code)
        name = STOCKS[code][0]
        # z = 當前成交價（非交易時間為 '-'），y = 昨日收盤
        z_raw = item.get('z', '-')
        y_raw = item.get('y', '0')
        try:
            y = float(y_raw) if y_raw and y_raw != '-' else 0
            price = float(z_raw) if z_raw and z_raw != '-' else y
        except (ValueError, TypeError):
            price, y = 0, 0
        change = round(price - y, 2) if y else 0
        pct = round(change / y * 100, 2) if y else 0
        try:
            vol = int(str(item.get('v', '0')).replace(',', '') or 0) * 1000
        except (ValueError, TypeError):
            vol = 0
        stock_data[code] = {
            'name': name,
            'price': round(price, 2),
            'change': change,
            'changePct': pct,
            'volume': vol,
            'updatedAt': firestore.SERVER_TIMESTAMP,
        }
        sign = '+' if change >= 0 else ''
        print(f"  {code} {name}: ${price:.1f} ({sign}{pct:.2f}%)")

    # ─── 若 TWSE 無資料（非交易時間），用 FinMind 取最近收盤價 ───
    if not stock_data:
        print("  ⚠ TWSE 即時 API 無資料（非交易時間），改用 FinMind 最近收盤價...")
        start_dt = (datetime.datetime.now() - datetime.timedelta(days=14)).strftime('%Y-%m-%d')
        end_dt   = datetime.datetime.now().strftime('%Y-%m-%d')
        for code, (name, _) in STOCKS.items():
            try:
                r2 = requests.get(
                    'https://api.finmindtrade.com/api/v4/data',
                    params={'dataset': 'TaiwanStockPrice', 'data_id': code,
                            'start_date': start_dt, 'end_date': end_dt},
                    timeout=15
                )
                records = r2.json().get('data', [])
                if len(records) >= 2:
                    latest  = records[-1]
                    prev    = records[-2]
                    price   = float(latest.get('close', 0))
                    prev_cl = float(prev.get('close', price))
                    change  = round(price - prev_cl, 2)
                    pct     = round(change / prev_cl * 100, 2) if prev_cl else 0
                    vol     = int(latest.get('Trading_Volume', 0))
                    stock_data[code] = {
                        'name':       name,
                        'price':      price,
                        'change':     change,
                        'changePct':  pct,
                        'volume':     vol,
                        'updatedAt':  firestore.SERVER_TIMESTAMP,
                    }
                    sign = '+' if change >= 0 else ''
                    print(f"  {code} {name}: ${price:.1f} ({sign}{pct:.2f}%) [FinMind 收盤]")
                elif len(records) == 1:
                    latest = records[-1]
                    price  = float(latest.get('close', 0))
                    stock_data[code] = {
                        'name': name, 'price': price,
                        'change': 0, 'changePct': 0,
                        'volume': int(latest.get('Trading_Volume', 0)),
                        'updatedAt': firestore.SERVER_TIMESTAMP,
                    }
                    print(f"  {code} {name}: ${price:.1f} [FinMind 收盤，無前日資料]")
            except Exception as e:
                print(f"  FinMind {code}: {e}")

    if stock_data:
        # merge=True：只覆蓋本次成功抓到的股票，其他股票保留舊值（不會被刪除）。
        # 每檔都帶自己的 updatedAt，前端據此標示「資料過期」。
        missing = [f"{c} {STOCKS[c][0]}" for c in STOCKS if c not in stock_data]
        if missing:
            print(f"  ⚠ 本次未更新：{'、'.join(missing)}（stocks/latest 保留舊值，前端將依 updatedAt 標示過期）")
        db.collection('stocks').document('latest').set(stock_data, merge=True)
        print(f"  ✅ 股價已存入 Firebase ({len(stock_data)} 檔)")
    else:
        print("  ⚠ 股價取得失敗（TWSE + FinMind 均無資料），stocks/latest 未變動")


# ══════════════════════════════════════════════════════════════
# 高階工作單元（Cloud Functions 與 CLI/GitHub Actions 共用）
# ══════════════════════════════════════════════════════════════

def init_db_from_env():
    """從 FIREBASE_SERVICE_ACCOUNT 環境變數初始化 Firestore（支援原始 JSON 或 Base64）"""
    sa_key = os.environ.get('FIREBASE_SERVICE_ACCOUNT')
    if not sa_key:
        raise RuntimeError('找不到 FIREBASE_SERVICE_ACCOUNT 環境變數')

    import base64
    sa_json = sa_key.strip()
    if not sa_json.startswith('{'):
        print("🔄 偵測到 Base64 格式，正在解碼...")
        sa_json = base64.b64decode(sa_json).decode('utf-8')

    sa_dict = json.loads(sa_json)
    cred = credentials.Certificate(sa_dict)
    if not firebase_admin._apps:
        firebase_admin.initialize_app(cred)
    print("✅ Firebase Firestore 已連線")
    return firestore.client()


def fetch_and_save_news(db, mode='all'):
    """抓取 RSS 新聞來源、去重並存入 Firestore；回傳儲存篇數"""
    sources = get_sources(mode)
    print(f"📡 開始抓取 {len(sources)} 個來源...\n")

    all_articles = []
    seen_links = set()
    seen_titles = set()
    for src in sources:
        articles = fetch_source(src)
        for a in articles:
            norm_title = normalize_title(a.get('title'))
            if norm_title and norm_title in seen_titles:
                continue
            if a['link'] and a['link'] in seen_links:
                continue
            seen_titles.add(norm_title)
            seen_links.add(a['link'])
            all_articles.append(a)

    print(f"\n📊 共抓取 {len(all_articles)} 則不重複新聞")

    if all_articles:
        print(f"\n💾 儲存到 Firebase Firestore（僅新增/變更）...")
        stats = save_new_articles(db, all_articles)
        print(f"✅ 新聞儲存完成：新增 {stats['added']} / 更新 {stats['updated']} / 跳過 {stats['skipped']}")
    else:
        print("⚠ 沒有新聞可儲存")

    pos = sum(1 for a in all_articles if a['sentiment'] == 'positive')
    neg = sum(1 for a in all_articles if a['sentiment'] == 'negative')
    neu = sum(1 for a in all_articles if a['sentiment'] == 'neutral')
    print(f"\n📈 情緒分佈: 正面 {pos} / 負面 {neg} / 中立 {neu}")
    return len(all_articles)


def fetch_all_financials(db):
    """財務類低頻資料一次抓齊：月營收（含競品）、季損益、股利、重大訊息"""
    fetch_monthly_revenue(db, '2451')
    fetch_quarterly_financials(db, '2451')
    fetch_dividend_data(db, '2451')
    # 競品月營收（ADATA 3260、Apacer 8271、十銓 4967、宜鼎 5289、廣穎 4973）
    for comp_code in ['3260', '8271', '4967', '5289', '4973']:
        fetch_monthly_revenue(db, comp_code)
    fetch_mops_material_news(db)


def main():
    mode = os.environ.get('FETCH_MODE', 'all')

    print(f"\n{'='*50}")
    print(f"創見資訊新聞監控 — 自動抓取")
    print(f"模式: {mode} | 時間: {datetime.datetime.now(datetime.timezone(datetime.timedelta(hours=8))).strftime('%Y-%m-%d %H:%M:%S')} (台灣時間)")
    print(f"{'='*50}")

    try:
        db = init_db_from_env()
    except Exception as e:
        print(f"❌ Firebase 初始化失敗: {e}")
        sys.exit(1)

    # 註：定時郵件（email_report / morning_email）與 Gemini 摘要（backfill_summaries）
    # 功能已於 2026-07 移除；如需恢復請參考 git 歷史。

    # ─── MSN 清理模式 ─────────────────────────────────────────────
    if mode == 'cleanup_msn':
        cleanup_msn_articles(db)
        print(f"\n{'='*50}\nMSN 清理完成！\n{'='*50}\n")
        return

    # ─── 股價快速更新模式 ─────────────────────────────────────────
    if mode == 'stocks_only':
        fetch_stock_prices(db)
        fetch_daily_trading(db, '2451')
        print(f"\n{'='*50}\n股價更新完成！\n{'='*50}\n")
        return

    # ─── 完整抓取 ───
    # 註：社群輿情抓取（CMoney/PTT）已於 2026-07 隨前端區塊一併移除
    fetch_and_save_news(db, mode)
    fetch_stock_prices(db)

    # ─── 每日交易資料（開收盤 + 三大法人）───
    fetch_daily_trading(db, '2451')

    # ─── 財務類資料（月營收/季損益/股利/重大訊息，含競品）───
    fetch_all_financials(db)

    print(f"\n{'='*50}")
    print("抓取完成！")
    print(f"{'='*50}\n")


def fetch_quarterly_financials(db, stock_code='2451'):
    """從 FinMind 抓取季度損益並存入 Firebase financials/{stock_code}
    依序嘗試多個 dataset 名稱，同時支援寬格式與長格式。
    """
    import json as _json
    print(f"\n📋 抓取 {stock_code} 季度損益（FinMind）...")
    BASE_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'

    # FinMind 可能的 dataset 名稱（依照成功機率排序）
    DATASETS = [
        'TaiwanStockFinancialStatements',
        'TaiwanStockProfitLossStatement',
        'TaiwanStockProfitLoss',
    ]

    quarters_by_date = {}  # date -> dict of metrics

    for dataset in DATASETS:
        try:
            url = (
                'https://api.finmindtrade.com/api/v4/data'
                f'?dataset={dataset}&data_id={stock_code}'
                f'&start_date=2019-01-01&token='
            )
            r = requests.get(url, headers={'User-Agent': BASE_UA}, timeout=20)
            print(f"  [{dataset}] HTTP {r.status_code}, {len(r.content)} bytes")
            if r.status_code != 200:
                continue
            data = _json.loads(r.text)
            rows = data.get('data', [])
            print(f"  [{dataset}] 取得 {len(rows)} 筆")
            if not rows:
                continue
            print(f"  [{dataset}] 第一筆 keys: {list(rows[0].keys())}")
            print(f"  [{dataset}] 第一筆: {rows[0]}")

            # 自動判斷格式：長格式(有 'type' key) 或 寬格式
            if 'type' in rows[0]:
                # 長格式：每行是一個指標，需 pivot
                # 同時以 type（英文）與 origin_name（中文）為 key 儲存，方便後續取值
                unique_types = sorted(set(r.get('origin_name','') for r in rows))
                print(f"  [{dataset}] 所有 origin_name: {unique_types}")
                for row in rows:
                    date   = row.get('date', '')
                    metric = row.get('type', '')
                    origin = row.get('origin_name', '')
                    val    = row.get('value', 0)
                    if date not in quarters_by_date:
                        quarters_by_date[date] = {'date': date}
                    if metric:
                        quarters_by_date[date][metric] = val      # 英文 key
                    if origin:
                        quarters_by_date[date][origin] = val      # 中文 key
            else:
                # 寬格式：每行是一季的所有指標
                for row in rows:
                    date = row.get('date', '')
                    quarters_by_date[date] = dict(row)

            if quarters_by_date:
                break  # 成功，不再嘗試其他 dataset
        except Exception as e:
            print(f"  [{dataset}] 失敗: {e}")

    # 轉換成標準格式並計算利潤率
    quarters = []
    for date, q in quarters_by_date.items():
        try:
            # FinMind value 是 float（如 462739000.0），須先轉 float 再 int
            def _i(v): return int(float(str(v or 0).replace(',', '') or 0))
            def _f(v): return float(v or 0)
            # 使用 FinMind 實際回傳的 origin_name（半形括號，已從 log 確認）
            rev     = _i(q.get('營業收入') or q.get('Revenue') or q.get('OperatingRevenue'))
            gross   = _i(q.get('營業毛利(毛損)') or q.get('GrossProfit') or q.get('毛利'))
            op_inc  = _i(q.get('營業利益(損失)') or q.get('OperatingIncome') or q.get('營業利益'))
            # 淨利優先取歸屬於母公司業主，再取合併淨利
            net_inc = _i(q.get('淨利(淨損)歸屬於母公司業主') or
                         q.get('本期淨利(淨損)') or
                         q.get('繼續營業單位本期淨利(淨損)') or
                         q.get('NetIncome') or q.get('ProfitAfterTax'))
            eps     = _f(q.get('基本每股盈餘') or q.get('EPS') or q.get('BasicEPS') or
                         q.get('每股盈餘'))

            gross_margin = round(gross   / rev * 100, 2) if rev else 0
            op_margin    = round(op_inc  / rev * 100, 2) if rev else 0
            net_margin   = round(net_inc / rev * 100, 2) if rev else 0

            quarters.append({
                'date': date, 'revenue': rev, 'grossProfit': gross,
                'opIncome': op_inc, 'netIncome': net_inc, 'eps': eps,
                'grossMargin': gross_margin, 'opMargin': op_margin, 'netMargin': net_margin,
            })
        except Exception:
            continue

    if quarters:
        quarters.sort(key=lambda x: x['date'])
        db.collection('financials').document(stock_code).set({
            'quarters': quarters, 'stockCode': stock_code,
            'updatedAt': firestore.SERVER_TIMESTAMP,
        })
        print(f"  ✅ 季度損益已儲存 {len(quarters)} 筆（{quarters[0]['date']} ～ {quarters[-1]['date']}）")
    else:
        print("  ⚠ 未解析到季度損益（請把上方除錯輸出貼給開發者）")


# ══════════════════════════════════════════════════════════════
# 創見與競品「重大訊息」（IR 新訊）
# 資料源：TWSE OpenAPI（上市）+ TPEx OpenAPI（上櫃）的「每日重大訊息」。
# 舊 MOPS ajax 端點與 FinMind TaiwanStockMaterial 已失效（2026-07 實測皆
# 無資料），且四月前舊資料混入新聞/股民評論；改為：每日抓取官方重訊、
# 與既有紀錄「累積合併」，並只保留帶合法 source 標記的重大訊息
# （首次寫入時順帶清除舊時代的非重訊內容）。
# ══════════════════════════════════════════════════════════════

MATERIAL_SOURCES = ('TWSE', 'TPEX', 'MOPS', 'FinMind')   # 合法重訊來源標記
MATERIAL_CAP = 500

# 上市（TWSE）/ 上櫃（TPEx）分流
MATERIAL_TWSE_CODES = {'2451': '創見資訊', '4967': '十銓科技', '8271': '宇瞻科技'}
MATERIAL_TPEX_CODES = {'3260': '威剛科技', '4973': '廣穎電通', '5289': '宜鼎國際'}
MATERIAL_HIGHLIGHT_KW = ['董事會', '股東會', '法人說明會', '股利', '盈餘分配', '現金增資',
                         '減資', '下市', '合併', '購併', '私募', '庫藏股', '資產重估', '重大訊息']


def material_date_to_iso(val):
    """重訊日期正規化：'1150717'/'115/07/17'（民國）、'20260717'/'2026-07-17'（西元）→ ISO；無法解析回傳 ''"""
    s = str(val or '').strip().replace('-', '/').replace('.', '/')
    if '/' in s:
        parts = s.split('/')
        if len(parts) == 3 and all(p.strip().isdigit() for p in parts):
            y = int(parts[0])
            y = y + 1911 if y < 1911 else y
            return f"{y}-{int(parts[1]):02d}-{int(parts[2]):02d}"
        return ''
    digits = ''.join(c for c in s if c.isdigit())
    if len(digits) == 7:      # 民國 yyymmdd
        return f"{int(digits[:3]) + 1911}-{digits[3:5]}-{digits[5:7]}"
    if len(digits) == 8:      # 西元 yyyymmdd
        return f"{digits[:4]}-{digits[4:6]}-{digits[6:8]}"
    return ''


def _material_key(r):
    return f"{r.get('code')}_{r.get('date')}_{str(r.get('summary', ''))[:30]}"


def merge_material_records(existing, new_records, cap=MATERIAL_CAP):
    """
    合併既有與新抓到的重訊（純函式）：
    - 只保留帶合法 source 標記者 → 清除舊時代混入的新聞/股民評論
    - 以 (code, date, 主旨前30字) 去重，日期新→舊排序，上限 cap 筆
    回傳 (merged, changed)
    """
    kept = [r for r in (existing or []) if r.get('source') in MATERIAL_SOURCES]
    purged = len(existing or []) - len(kept)
    seen = {_material_key(r) for r in kept}
    added = 0
    for r in new_records:
        k = _material_key(r)
        if k in seen:
            continue
        seen.add(k)
        kept.append(r)
        added += 1
    kept.sort(key=lambda x: str(x.get('date', '')), reverse=True)
    merged = kept[:cap]
    changed = added > 0 or purged > 0 or len(merged) != len(existing or [])
    return merged, changed


def _mk_material_record(code, name, date_iso, subject, source):
    kw = [k for k in MATERIAL_HIGHLIGHT_KW if k in subject]
    return {
        'code': code, 'name': name, 'date': date_iso,
        'summary': subject[:300], 'link': '',
        'highlight': len(kw) > 0, 'highlightKw': kw,
        'source': source,
    }


def fetch_mops_material_news(db):
    """抓取創見與競品「每日重大訊息」並累積存入 material/competitors（只留重訊）"""
    BASE_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
    print(f"\n📢 抓取創見與競品重大訊息（TWSE/TPEx OpenAPI）...")
    new_records = []

    # ── 上市（TWSE OpenAPI，每日重大訊息）──
    try:
        r = requests.get('https://openapi.twse.com.tw/v1/opendata/t187ap04_L',
                         headers={'User-Agent': BASE_UA, 'Accept': 'application/json'}, timeout=20)
        rows = r.json() if r.status_code == 200 else []
        for row in rows:
            code = str(row.get('公司代號', '')).strip()
            if code not in MATERIAL_TWSE_CODES:
                continue
            subject = str(row.get('主旨 ') or row.get('主旨') or '').strip()
            date_iso = material_date_to_iso(row.get('發言日期') or row.get('出表日期'))
            if not subject or not date_iso:
                continue
            new_records.append(_mk_material_record(
                code, MATERIAL_TWSE_CODES[code], date_iso, subject, 'TWSE'))
        print(f"  [TWSE] 今日全市場 {len(rows)} 筆，我方公司 {sum(1 for x in new_records if x['source']=='TWSE')} 筆")
    except Exception as e:
        print(f"  ⚠ [TWSE OpenAPI] 失敗: {e}")

    # ── 上櫃（TPEx OpenAPI，每日重大訊息）──
    try:
        r = requests.get('https://www.tpex.org.tw/openapi/v1/mopsfin_t187ap04_O',
                         headers={'User-Agent': BASE_UA, 'Accept': 'application/json'}, timeout=20)
        rows = r.json() if r.status_code == 200 else []
        for row in rows:
            code = str(row.get('SecuritiesCompanyCode') or row.get('公司代號') or '').strip()
            if code not in MATERIAL_TPEX_CODES:
                continue
            subject = str(row.get('主旨') or row.get('主旨 ') or '').strip()
            date_iso = material_date_to_iso(row.get('發言日期') or row.get('Date'))
            if not subject or not date_iso:
                continue
            new_records.append(_mk_material_record(
                code, MATERIAL_TPEX_CODES[code], date_iso, subject, 'TPEX'))
        print(f"  [TPEx] 今日全市場 {len(rows)} 筆，我方公司 {sum(1 for x in new_records if x['source']=='TPEX')} 筆")
    except Exception as e:
        print(f"  ⚠ [TPEx OpenAPI] 失敗: {e}")

    # ── 與既有紀錄累積合併（並清除舊時代非重訊內容）──
    ref = db.collection('material').document('competitors')
    try:
        snap = ref.get()
        existing = (snap.to_dict() or {}).get('records', []) if getattr(snap, 'exists', False) else []
    except Exception as e:
        print(f"  ⚠ 讀取既有重訊失敗，中止本次更新（避免覆蓋）: {e}")
        return

    merged, changed = merge_material_records(existing, new_records)
    if changed:
        ref.set({'records': merged, 'updatedAt': firestore.SERVER_TIMESTAMP})
        print(f"  ✅ 重訊已更新：新增 {len(new_records)} 筆（合併後共 {len(merged)} 筆，僅保留官方重大訊息）")
    else:
        print(f"  ✅ 重訊無新增（既有 {len(merged)} 筆）")



def fetch_daily_trading(db, stock_code='2451'):
    """抓取每日股價（開/收/高/低/量）及三大法人買賣資料，存入 Firebase daily/{stock_code}"""
    import json as _json
    print(f"\n📊 抓取 {stock_code} 每日交易資料...")
    BASE_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
    now_tw  = datetime.datetime.now(datetime.timezone(datetime.timedelta(hours=8)))
    start   = (now_tw - datetime.timedelta(days=10)).strftime('%Y-%m-%d')
    result  = {'stockCode': stock_code}

    # ── 1. TWSE 即時行情：開盤 / 收盤 / 高 / 低 / 量 ──────────
    try:
        url = ('https://mis.twse.com.tw/stock/api/getStockInfo.jsp'
               f'?ex_ch=tse_{stock_code}.tw&json=1&delay=0')
        r = requests.get(url, headers={
            'Referer': 'https://mis.twse.com.tw/',
            'User-Agent': BASE_UA,
        }, timeout=15)
        items = r.json().get('msgArray', [])
        if items:
            item = items[0]
            def _fp(k):
                v = item.get(k, '-')
                try: return float(v) if v and v not in ('-', '') else None
                except: return None
            result['open']      = _fp('o')
            result['close']     = _fp('z') or _fp('y')
            result['high']      = _fp('h')
            result['low']       = _fp('l')
            result['priceDate'] = now_tw.strftime('%Y-%m-%d')
            try:
                result['volume'] = int(float(str(item.get('v','0')).replace(',','') or 0)) * 1000
            except Exception:
                result['volume'] = 0
            print(f"  [TWSE] 開:{result['open']} 收:{result['close']} 量:{result['volume']:,}")
    except Exception as e:
        print(f"  [TWSE 行情] 失敗: {e}")

    # ── 2. FinMind 三大法人 ────────────────────────────────────
    try:
        url2 = (f'https://api.finmindtrade.com/api/v4/data'
                f'?dataset=TaiwanStockInstitutionalInvestorsBuySell'
                f'&data_id={stock_code}&start_date={start}&token=')
        r2 = requests.get(url2, headers={'User-Agent': BASE_UA}, timeout=20)
        print(f"  [法人] HTTP {r2.status_code}, {len(r2.content)} bytes")
        if r2.status_code == 200:
            rows = _json.loads(r2.text).get('data', [])
            if rows:
                print(f"  [法人] 第一筆 keys: {list(rows[0].keys())}")
                print(f"  [法人] 第一筆 name 範例: {rows[0].get('name','')}")
                latest_date = max(row.get('date', '') for row in rows)
                # 支援 name 欄位可能是字串或整數，統一轉 str
                by_name = {str(row.get('name','')): row for row in rows if row.get('date') == latest_date}
                result['institutionalDate'] = latest_date
                print(f"  [法人] 最新日期: {latest_date}, 機構清單: {list(by_name.keys())}")

                def _get_val(row, *keys):
                    """嘗試多個欄位名取買賣量（FinMind 不同版本欄位名可能不同）"""
                    for k in keys:
                        v = row.get(k)
                        if v is not None:
                            try: return int(float(str(v).replace(',','') or 0))
                            except: pass
                    return 0

                # ── 外資：英文名（新 API）→ 中文名（舊 API）→ 子字串 fallback ──
                foreign_row = (
                    by_name.get('Foreign_Investor') or            # FinMind 新版英文
                    by_name.get('外資及陸資(不含外資自營商)') or
                    by_name.get('外資及陸資（不含外資自營商）') or
                    by_name.get('外資及陸資') or
                    by_name.get('外資') or
                    next((r for k, r in by_name.items()
                          if ('外資' in k or 'Foreign' in k) and
                             ('自營' not in k and 'Dealer' not in k)), None)
                )
                if foreign_row is not None:
                    result['foreignBuy']  = _get_val(foreign_row, 'buy', 'buy_volume', 'Buy')
                    result['foreignSell'] = _get_val(foreign_row, 'sell', 'sell_volume', 'Sell')
                    result['foreignNet']  = result['foreignBuy'] - result['foreignSell']
                    print(f"  外資 買:{result['foreignBuy']:,} 賣:{result['foreignSell']:,} 淨:{result['foreignNet']:+,}")
                else:
                    print(f"  ⚠ 找不到外資資料（機構清單: {list(by_name.keys())}）")

                # ── 投信：英文名 → 中文名 → 子字串 fallback ──
                trust_row = (
                    by_name.get('Investment_Trust') or            # FinMind 新版英文
                    by_name.get('投信') or
                    next((r for k, r in by_name.items()
                          if '投信' in k or 'Investment_Trust' in k), None)
                )
                if trust_row is not None:
                    result['trustBuy']  = _get_val(trust_row, 'buy', 'buy_volume', 'Buy')
                    result['trustSell'] = _get_val(trust_row, 'sell', 'sell_volume', 'Sell')
                    result['trustNet']  = result['trustBuy'] - result['trustSell']
                    print(f"  投信 買:{result['trustBuy']:,} 賣:{result['trustSell']:,} 淨:{result['trustNet']:+,}")
                else:
                    print(f"  ⚠ 找不到投信資料")
    except Exception as e:
        print(f"  [法人] 失敗: {e}")

    if any(k in result for k in ['open', 'close', 'foreignBuy', 'trustBuy']):
        db.collection('daily').document(stock_code).set({
            **result, 'updatedAt': firestore.SERVER_TIMESTAMP,
        })
        print(f"  ✅ 每日交易資料已儲存")
    else:
        print(f"  ⚠ 未取得任何交易資料")


def fetch_dividend_data(db, stock_code='2451'):
    """
    從 FinMind TaiwanStockDividend 抓取股利配息並存入 Firebase dividends/{stock_code}

    ★ 現金股利計算規則：
      CashEarningsDistribution        （盈餘分配）
    + CashStatutoryReserveTransfer    （法定公積轉入）
    + CashCapitalReserveTransfer      （資本公積轉入）
    ────────────────────────────────────────────────
      = 正確現金股利合計（不使用 Dividends 欄位，因其可能缺資本公積）

    ★ 年份邏輯：ROC year + 1912 = 西元除息年（113 + 1912 = 2025）
    """
    import json as _json
    print(f"\n💵 抓取 {stock_code} 股利資料（FinMind）...")
    BASE_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'

    def _f(v):
        try: return float(v or 0)
        except: return 0.0

    def _roc_to_ad(val):
        """ROC year → 西元除息年份（+1912）  '113年'/113 → 2025"""
        digits = ''.join(c for c in str(val or '') if c.isdigit())
        n = int(digits) if digits else 0
        return (n + 1912) if 0 < n < 1912 else n

    records = {}   # key = year_str

    # ══════════════════════════════════════════════════════════
    # 主資料源：TaiwanStockDividend
    #   現金股利 = Cash* 三項加總（不用 Dividends 欄位）
    # ══════════════════════════════════════════════════════════
    try:
        url_d = (
            'https://api.finmindtrade.com/api/v4/data'
            f'?dataset=TaiwanStockDividend&data_id={stock_code}'
            f'&start_date=2015-01-01&token='
        )
        r_d = requests.get(url_d, headers={'User-Agent': BASE_UA}, timeout=20)
        print(f"  [Dividend] HTTP {r_d.status_code}, {len(r_d.content)} bytes")
        rows_d = _json.loads(r_d.text).get('data', []) if r_d.status_code == 200 else []

        # ── 除錯：印出所有欄位名稱及最新兩筆原始資料 ──────────────
        if rows_d:
            print(f"  [Dividend] 欄位名稱: {list(rows_d[0].keys())}")
            print(f"  [Dividend] 最新 2 筆完整原始資料：")
            for raw in rows_d[-2:]:
                print(f"    {raw}")

        for row in rows_d:
            try:
                # ── 年份：直接用 date 欄位前 4 碼，最可靠 ──────────
                date_str = str(row.get('date', '') or '')
                year_ad  = int(date_str[:4]) if len(date_str) >= 4 and date_str[:4].isdigit() else _roc_to_ad(row.get('year', 0))
                year_str = str(year_ad)
                if year_ad < 2010:
                    continue

                # ── 現金股利：FinMind 實際欄位名稱 ──────────────────
                # CashEarningsDistribution  = 盈餘分配現金股利
                # CashStatutorySurplus      = 法定公積轉入現金股利  ← 注意：是 Surplus 不是 ReserveTransfer
                cash_e = _f(row.get('CashEarningsDistribution'))
                cash_s = _f(row.get('CashStatutorySurplus'))        # ← 正確欄位名
                total_cash = round(cash_e + cash_s, 2)

                # ── 股票股利：FinMind 實際欄位名稱 ──────────────────
                stk_e = _f(row.get('StockEarningsDistribution'))
                stk_s = _f(row.get('StockStatutorySurplus'))        # ← 正確欄位名
                total_stock = round(stk_e + stk_s, 2)

                print(
                    f"  [Dividend] {year_ad}: "
                    f"CashEarnings={cash_e} + CashStatutorySurplus={cash_s} → cash={total_cash} | "
                    f"StkEarnings={stk_e} + StkStatutorySurplus={stk_s} → stock={total_stock}"
                )

                if total_cash == 0 and total_stock == 0:
                    print(f"  [Dividend] {year_ad}: 全零，跳過")
                    continue

                # 同年份若有多筆（多次配息），則累加
                if year_str in records:
                    records[year_str]['cashDividend']  = round(records[year_str]['cashDividend']  + total_cash,  2)
                    records[year_str]['stockDividend'] = round(records[year_str]['stockDividend'] + total_stock, 2)
                    records[year_str]['totalDividend'] = round(
                        records[year_str]['cashDividend'] + records[year_str]['stockDividend'], 2)
                else:
                    records[year_str] = {
                        'date':          str(row.get('date', '')),
                        'year':          year_str,
                        'cashDividend':  total_cash,
                        'stockDividend': total_stock,
                        'totalDividend': round(total_cash + total_stock, 2),
                    }
            except Exception as ex:
                print(f"  [Dividend] 解析失敗: {ex} | {row}")
    except Exception as e:
        print(f"  [Dividend] 失敗: {e}")

    # ══════════════════════════════════════════════════════════
    # 診斷用：TaiwanStockDividendResult（僅印出，不覆蓋主資料）
    # ══════════════════════════════════════════════════════════
    try:
        url_r = (
            'https://api.finmindtrade.com/api/v4/data'
            f'?dataset=TaiwanStockDividendResult&data_id={stock_code}'
            f'&start_date=2015-01-01&token='
        )
        r_r = requests.get(url_r, headers={'User-Agent': BASE_UA}, timeout=20)
        print(f"  [Result] HTTP {r_r.status_code}, {len(r_r.content)} bytes")
        rows_r = _json.loads(r_r.text).get('data', []) if r_r.status_code == 200 else []
        if rows_r:
            print(f"  [Result] 欄位名稱: {list(rows_r[0].keys())}")
            print(f"  [Result] 最新 2 筆完整原始資料（僅診斷，不寫入）：")
            for raw in rows_r[-2:]:
                print(f"    {raw}")
    except Exception as e:
        print(f"  [Result] 診斷失敗: {e}")

    # ── 儲存 ──────────────────────────────────────────────────
    final = sorted(records.values(), key=lambda x: x['year'])
    if final:
        db.collection('dividends').document(stock_code).set({
            'records': final, 'stockCode': stock_code,
            'updatedAt': firestore.SERVER_TIMESTAMP,
        })
        print(f"  ✅ 股利已儲存 {len(final)} 筆（{final[0]['year']} ～ {final[-1]['year']}）")
        for r in final[-3:]:
            print(f"     {r['year']}: 現金={r['cashDividend']} 股票={r['stockDividend']} 合計={r['totalDividend']}")
    else:
        print("  ⚠ 未解析到股利資料")


if __name__ == '__main__':
    main()
