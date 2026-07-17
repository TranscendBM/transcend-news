"""
functions/main.py（Cloud Functions 排程進入點）單元測試 — 完全離線

firebase_functions / firebase_admin 皆以 stub 取代：
- on_schedule 裝飾器改為 passthrough，排程參數存於 fn._schedule_opts 供驗證
- SecretParam 可注入測試值
不連接 Secret Manager、Firestore 或任何外部服務。
"""

import datetime
import json
import sys
import types
import unittest
from pathlib import Path
from unittest.mock import MagicMock, patch

# ── stub 外部相依（必須在 import main 之前）──────────────────────
for _mod in ('requests', 'feedparser', 'firebase_admin',
             'firebase_admin.credentials', 'firebase_admin.firestore'):
    if _mod not in sys.modules:
        sys.modules[_mod] = MagicMock(name=_mod)

_ff = types.ModuleType('firebase_functions')
_sched = types.ModuleType('firebase_functions.scheduler_fn')


def _on_schedule(**opts):
    def deco(fn):
        fn._schedule_opts = opts     # 保留排程參數供測試驗證
        return fn
    return deco


_sched.on_schedule = _on_schedule
_sched.ScheduledEvent = object

_opts = types.ModuleType('firebase_functions.options')


class _MemoryOption:
    MB_256 = 256
    MB_512 = 512


_opts.MemoryOption = _MemoryOption

_params = types.ModuleType('firebase_functions.params')


class _SecretParam:
    def __init__(self, name):
        self.name = name
        self.value = ''              # 測試中直接覆寫


_params.SecretParam = _SecretParam

_ff.scheduler_fn = _sched
_ff.options = _opts
_ff.params = _params
sys.modules.setdefault('firebase_functions', _ff)
sys.modules.setdefault('firebase_functions.scheduler_fn', _sched)
sys.modules.setdefault('firebase_functions.options', _opts)
sys.modules.setdefault('firebase_functions.params', _params)

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / 'functions'))

import fetch_news  # noqa: E402
import main        # noqa: E402

VALID_SA = json.dumps({
    'type': 'service_account',
    'project_id': 'transcend-news-monitor',
    'client_email': 'test@test.iam.gserviceaccount.com',
})


class GetDbTestBase(unittest.TestCase):
    def setUp(self):
        main._db = None
        # get_app 預設：named app 尚不存在 → 拋 ValueError（firebase_admin 行為）
        main.firebase_admin.get_app = MagicMock(side_effect=ValueError('no app'))
        main.firebase_admin.initialize_app = MagicMock(return_value='APP')
        main.credentials.Certificate = MagicMock(return_value='CERT')
        main.firestore.client = MagicMock(return_value='DB')

    def _set_secret(self, value):
        main.MONITOR_SERVICE_ACCOUNT = types.SimpleNamespace(value=value)


class TestGetDb(GetDbTestBase):
    def test_initializes_named_app_with_explicit_project_id(self):
        """跨專案關鍵：固定名稱 named app + 明確 projectId，
        且 firestore.client 必須明確傳入該 app——避免環境已有指向
        本專案（tbm）的 default app 時連錯專案"""
        self._set_secret(VALID_SA)
        db = main.get_db()
        self.assertEqual(db, 'DB')
        main.firebase_admin.initialize_app.assert_called_once_with(
            'CERT', {'projectId': 'transcend-news-monitor'},
            name=main.MONITOR_APP_NAME)
        main.firestore.client.assert_called_once_with(app='APP')

    def test_reuses_existing_named_app(self):
        """named app 已存在（暖啟動）時直接取用，不重複 initialize"""
        self._set_secret(VALID_SA)
        main.firebase_admin.get_app = MagicMock(return_value='EXISTING_APP')
        main.get_db()
        main.firebase_admin.initialize_app.assert_not_called()
        main.firestore.client.assert_called_once_with(app='EXISTING_APP')

    def test_default_app_presence_does_not_affect_target_project(self):
        """即使環境已有 default app（例如其他程式初始化過 tbm），
        get_db 仍必須走 named app 路徑，不受影響"""
        self._set_secret(VALID_SA)
        main.firebase_admin._apps = {'[DEFAULT]': 'tbm-default-app'}   # 模擬已存在 default app
        main.get_db()
        main.firestore.client.assert_called_once_with(app='APP')

    def test_db_cached_after_first_call(self):
        self._set_secret(VALID_SA)
        main.get_db()
        main.get_db()
        main.firebase_admin.initialize_app.assert_called_once()

    def test_empty_secret_raises_clear_error(self):
        self._set_secret('')
        with self.assertRaises(RuntimeError) as ctx:
            main.get_db()
        self.assertIn('MONITOR_SERVICE_ACCOUNT', str(ctx.exception))
        self.assertIsNone(main._db, '失敗後不得留下半初始化狀態')

    def test_invalid_json_secret_raises_without_leaking_content(self):
        self._set_secret('{這不是合法JSON')
        with self.assertRaises(RuntimeError) as ctx:
            main.get_db()
        msg = str(ctx.exception)
        self.assertIn('JSON', msg)
        self.assertNotIn('這不是合法JSON', msg, '錯誤訊息不得洩漏 secret 內容')

    def test_missing_project_id_raises(self):
        self._set_secret(json.dumps({'type': 'service_account'}))
        with self.assertRaises(RuntimeError) as ctx:
            main.get_db()
        self.assertIn('project_id', str(ctx.exception))


class TestRunLocked(unittest.TestCase):
    def setUp(self):
        self.db = MagicMock(name='db')
        self.patch_getdb = patch.object(main, 'get_db', return_value=self.db)
        self.patch_getdb.start()
        self.addCleanup(self.patch_getdb.stop)

    def test_skips_when_lock_busy(self):
        work = MagicMock()
        with patch.object(fetch_news, 'acquire_lock', return_value=None), \
             patch.object(fetch_news, 'release_lock') as mrel:
            result = main._run_locked('news', work, ttl_minutes=12)
        self.assertFalse(result)
        work.assert_not_called()
        mrel.assert_not_called()

    def test_runs_and_releases_with_own_token(self):
        work = MagicMock()
        with patch.object(fetch_news, 'acquire_lock', return_value='tok-123'), \
             patch.object(fetch_news, 'release_lock') as mrel:
            result = main._run_locked('news', work, ttl_minutes=12)
        self.assertTrue(result)
        work.assert_called_once_with(self.db)
        mrel.assert_called_once_with(self.db, 'news', 'tok-123')

    def test_releases_lock_even_when_work_raises(self):
        work = MagicMock(side_effect=RuntimeError('外部服務爆炸'))
        with patch.object(fetch_news, 'acquire_lock', return_value='tok-456'), \
             patch.object(fetch_news, 'release_lock') as mrel:
            with self.assertRaises(RuntimeError):
                main._run_locked('news', work, ttl_minutes=12)
        mrel.assert_called_once_with(self.db, 'news', 'tok-456')


class TestScheduledEntrypoints(unittest.TestCase):
    def test_all_jobs_have_max_instances_1(self):
        jobs = [main.stocks_job, main.news_job,
                main.trading_job, main.finance_job, main.finance_early_month_job]
        for job in jobs:
            self.assertEqual(job._schedule_opts.get('max_instances'), 1,
                             f'{job.__name__} 必須設 max_instances=1')

    def test_lock_ttl_exceeds_function_timeout(self):
        """鎖 TTL 必須大於函式 timeout，否則執行中的鎖可能被誤接管"""
        # (job, 對應 _run_locked ttl_minutes)——與 main.py 內設定同步維護
        ttls = {'stocks_job': 3, 'news_job': 12,
                'trading_job': 8, 'finance_job': 12, 'finance_early_month_job': 12}
        for job_name, ttl in ttls.items():
            timeout_sec = getattr(main, job_name)._schedule_opts['timeout_sec']
            self.assertGreater(ttl * 60, timeout_sec,
                               f'{job_name}: 鎖 TTL({ttl}分) 必須 > timeout({timeout_sec}秒)')

    def test_news_job_routes_through_lock(self):
        with patch.object(main, '_run_locked') as mrun:
            main.news_job(None)
        mrun.assert_called_once()
        self.assertEqual(mrun.call_args[0][0], 'news')

    def test_finance_jobs_share_same_lock(self):
        names = []
        with patch.object(main, '_run_locked', side_effect=lambda n, *a, **k: names.append(n)):
            main.finance_job(None)
            main.finance_early_month_job(None)
        self.assertEqual(names, ['finance', 'finance'],
                         '每日與月初加密排程必須共用同一把鎖')

    def test_stocks_job_skips_outside_market_hours(self):
        night = datetime.datetime(2026, 7, 15, 20, 0)   # 週三晚上
        with patch.object(main, '_tw_now',
                          return_value=night.replace(tzinfo=datetime.timezone(datetime.timedelta(hours=8)))), \
             patch.object(main, '_run_locked') as mrun:
            main.stocks_job(None)
        mrun.assert_not_called()

    def test_stocks_job_runs_during_market_hours(self):
        trading = datetime.datetime(2026, 7, 15, 10, 30)  # 週三盤中
        with patch.object(main, '_tw_now',
                          return_value=trading.replace(tzinfo=datetime.timezone(datetime.timedelta(hours=8)))), \
             patch.object(main, '_run_locked') as mrun:
            main.stocks_job(None)
        mrun.assert_called_once()
        self.assertEqual(mrun.call_args[0][0], 'stocks')


if __name__ == '__main__':
    unittest.main()
