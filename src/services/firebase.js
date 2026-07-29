import { initializeApp, getApps, getApp } from 'firebase/app';
import {
  initializeFirestore,
  persistentLocalCache,
  persistentMultipleTabManager,
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

/**
 * 取得 Firestore 實例（singleton）。全專案唯一的初始化入口——不得在
 * 其他地方呼叫 getFirestore(app) 或再次呼叫 initializeFirestore(app, ...)，
 * 同一個 app 對 initializeFirestore 呼叫第二次會直接拋出例外
 * （"Firestore has already been started"）。
 *
 * 改用新版離線快取設定 API（initializeFirestore + persistentLocalCache +
 * persistentMultipleTabManager）取代舊版 getFirestore() 之後另外呼叫
 * enableMultiTabIndexedDbPersistence() 的兩段式做法：
 *   - 快取設定在建立實例當下就決定，不是之後才非同步「啟用」——不會
 *     有「第一個新聞查詢在快取設定完成前就先跑」的競態，也不需要呼叫端
 *     額外 await 一個「持久化已啟用」的 promise 才能安全查詢
 *   - persistentMultipleTabManager 原生支援多分頁同開，不會再出現舊版
 *     enableIndexedDbPersistence 那種多分頁互搶導致的 failed-precondition
 *   - 不會再印出 enableMultiTabIndexedDbPersistence() will be deprecated 警告
 */
export function getDb() {
  if (!dbInstance) {
    const app = getApps().length ? getApp() : initializeApp(FIREBASE_CONFIG);
    dbInstance = initializeFirestore(app, {
      localCache: persistentLocalCache({
        tabManager: persistentMultipleTabManager(),
      }),
    });
  }
  return dbInstance;
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
