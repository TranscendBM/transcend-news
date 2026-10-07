import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    // 本機開發時把 Excel 上傳 API 轉到已部署的網站（Hosting rewrite 只存在線上）
    proxy: {
      '/api': { target: 'https://transcend-news.web.app', changeOrigin: true, secure: true },
    },
  },
  build: {
    outDir: 'dist',
  },
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./src/test/setup.js'],
  },
});
