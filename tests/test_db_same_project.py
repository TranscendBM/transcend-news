"""
functions/db_same_project.py 單元測試 — 完全離線。

這個模組目前完全沒有被 main.py import／呼叫（純參考實作，見該檔案
docstring），這裡直接測試它本身的邏輯：get_app() 優先、只有真的沒有
default app 時才 initialize_app()、且是模組層級的 singleton。

用 MagicMock 取代整個 firebase_admin 套件（不需要安裝 firebase-admin），
每個測試都重新 import 一次 db_same_project，確保拿到的是這次測試自己
設定的 mock，不會被同一個 process 裡其他測試檔案（例如
tests/test_news_cleanup.py）對 sys.modules['firebase_admin'] 的設定
影響到。
"""

import sys
import unittest
from pathlib import Path
from unittest.mock import MagicMock

FUNCTIONS_DIR = str(Path(__file__).resolve().parent.parent / 'functions')


class TestDbSameProject(unittest.TestCase):
    def setUp(self):
        if FUNCTIONS_DIR not in sys.path:
            sys.path.insert(0, FUNCTIONS_DIR)
        self._orig_firebase_admin = sys.modules.get('firebase_admin')
        self.mock_firebase_admin = MagicMock(name='firebase_admin')
        sys.modules['firebase_admin'] = self.mock_firebase_admin
        # 強制重新 import：確保這個模組內 `import firebase_admin` 綁定的
        # 是這次測試剛設定好的 mock，不是别的測試檔案留下來的舊物件。
        sys.modules.pop('db_same_project', None)
        import db_same_project
        self.db_same_project = db_same_project

    def tearDown(self):
        sys.modules.pop('db_same_project', None)
        if self._orig_firebase_admin is not None:
            sys.modules['firebase_admin'] = self._orig_firebase_admin
        else:
            sys.modules.pop('firebase_admin', None)

    def test_reuses_existing_default_app_without_calling_initialize_app(self):
        """default app 已存在：get_db() 應該直接重用它，完全不呼叫
        initialize_app()（呼叫已存在的 default app 會拋出
        'default app already exists' 錯誤）。"""
        fake_app = object()
        self.mock_firebase_admin.get_app.return_value = fake_app
        fake_db = object()
        self.mock_firebase_admin.firestore.client.return_value = fake_db

        result = self.db_same_project.get_db()

        self.mock_firebase_admin.get_app.assert_called_once_with()
        self.mock_firebase_admin.initialize_app.assert_not_called()
        self.mock_firebase_admin.firestore.client.assert_called_once_with(app=fake_app)
        self.assertIs(result, fake_db)

    def test_initializes_a_new_app_when_no_default_app_exists(self):
        """default app 不存在（get_app() 拋出 ValueError）：才呼叫
        initialize_app() 新建一個。"""
        self.mock_firebase_admin.get_app.side_effect = ValueError('no default app')
        fake_new_app = object()
        self.mock_firebase_admin.initialize_app.return_value = fake_new_app
        fake_db = object()
        self.mock_firebase_admin.firestore.client.return_value = fake_db

        result = self.db_same_project.get_db()

        self.mock_firebase_admin.initialize_app.assert_called_once_with()
        self.mock_firebase_admin.firestore.client.assert_called_once_with(app=fake_new_app)
        self.assertIs(result, fake_db)

    def test_repeated_calls_return_the_same_singleton_without_reinitializing(self):
        """重複呼叫 get_db()：回傳同一個實例，且 get_app()/firestore.client()
        都只在第一次呼叫時執行一次。"""
        self.mock_firebase_admin.get_app.return_value = object()
        self.mock_firebase_admin.firestore.client.return_value = object()

        first = self.db_same_project.get_db()
        second = self.db_same_project.get_db()

        self.assertIs(first, second)
        self.mock_firebase_admin.get_app.assert_called_once_with()
        self.mock_firebase_admin.firestore.client.assert_called_once_with(
            app=self.mock_firebase_admin.get_app.return_value)


if __name__ == '__main__':
    unittest.main()
