/**
 * 前端启动入口。
 * 主题变量由 ThemeProvider 从 theme/tokens.ts 注入（<html> 内联样式）；
 * styles.css 里有一份同名兜底，供 JS 执行前的首屏使用（index.html 的引导脚本负责设 data-theme）。
 */
import React from 'react';
import ReactDOM from 'react-dom/client';
import dayjs from 'dayjs';
import relativeTime from 'dayjs/plugin/relativeTime';
import 'antd/dist/reset.css';
import './styles.css';
import './i18n';
import App from './App';

dayjs.extend(relativeTime);

/**
 * 发版换 hash 后，旧页面里按需加载的路由会去请求已经不存在的 /assets/xxx.js，
 * 浏览器直接报「Failed to fetch dynamically imported module」。
 * Vite 会派发 vite:preloadError；这里防抖后整页刷新一次，拿到新的 index.html。
 * 30 秒内只自动刷新一次：如果线上资源确实缺失，刷新也救不了，交给页面里的「重试」提示。
 */
const CHUNK_RELOAD_KEY = 'tgcc:chunk-reload-at';
window.addEventListener('vite:preloadError', (event) => {
  event.preventDefault();
  const last = Number(window.sessionStorage.getItem(CHUNK_RELOAD_KEY) || 0);
  if (Date.now() - last < 30_000) return;
  window.sessionStorage.setItem(CHUNK_RELOAD_KEY, String(Date.now()));
  window.location.reload();
});

const container = document.getElementById('root');
if (!container) throw new Error('找不到 #root 挂载点');

ReactDOM.createRoot(container).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
