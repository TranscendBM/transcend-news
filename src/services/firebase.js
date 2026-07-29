import { initializeApp, getApps } from 'firebase/app';
import {
  getFirestore,
  enableMultiTabIndexedDbPersistence,
  collection,
  doc,
  onSnapshot,
  getDoc,
  getDocs,
  getDocsFromCache,
  getDocsFromServer,
  query,
  where,
  orderBy,
  limit,
  startAfter,
} from 'firebase/firestore';

// Firebase 前端設定不是秘密：這是 Firebase 用來識別專案的公開 client
// apiKey，安全性由 Firestore Rules 把關（前端唯讀、寫入只允許 Admin
// SDK），不是需要保密的 Service Account 金鑰，本來就會隨網頁公開。
export const FIREBASE_CONFIG = {
  apiKey: 'AIzaSyD9uEf6a0Q8qDeyfPDa5JsgrR0GO0XLmNw',
  authDomain: 'transcend-news-monitor.firebaseapp.com',
  projectId: 'transcend-news-monitor',
  storageBucket: 'transcend-news-monitor.firebasestorage.app',
  messagingSenderId: '724058805854',
  appId: '1:724058805854:web:ec0afc075f51f093be86cf',
};

let dbInstance = null;
let persistenceEnabled = false;

/** 取得（並視需要初始化）Firestore 實例；重複呼叫不會重複 initializeApp。 */
export function getDb() {
  if (!dbInstance) {
    const app = getApps().length ? getApps()[0] : initializeApp(FIREBASE_CONFIG);
    dbInstance = getFirestore(app);
  }
  return dbInstance;
}

/**
 * 啟用離線快取（IndexedDB，多分頁同步）：資料存在瀏覽器，第二次開啟起
 * 可立即顯示上次資料再於背景同步。必須在任何查詢之前呼叫；多分頁同開時
 * 可能失敗（failed-precondition），屬正常情況，不視為錯誤中止流程。
 * （對應舊版 compat API 的 db.enablePersistence({synchronizeTabs:true})）
 */
export async function enablePersistenceOnce(db) {
  if (persistenceEnabled) return;
  try {
    await enableMultiTabIndexedDbPersistence(db);
  } catch (e) {
    console.warn('離線快取未啟用（不影響功能）:', e.code || e);
  } finally {
    persistenceEnabled = true;
  }
}

export {
  collection,
  doc,
  onSnapshot,
  getDoc,
  getDocs,
  getDocsFromCache,
  getDocsFromServer,
  query,
  where,
  orderBy,
  limit,
  startAfter,
};
