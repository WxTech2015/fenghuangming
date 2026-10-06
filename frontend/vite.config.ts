import { defineConfig, loadEnv } from 'vite';
import vue from '@vitejs/plugin-vue';
import { fileURLToPath } from 'node:url';
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, fileURLToPath(new URL('./', import.meta.url)), 'VITE_');
  const target = env.VITE_API_PROXY_TARGET || 'http://127.0.0.1:19988';
  const url = new URL(target);
  if (!['http:', 'https:'].includes(url.protocol) || url.pathname !== '/' || url.search || url.hash || url.username || url.password) throw new Error('VITE_API_PROXY_TARGET 必须是 HTTP / HTTPS 根地址');
  const port = Number(url.port || (url.protocol === 'https:' ? 443 : 80));
  return { plugins: [vue()], define: { __BACKEND_PORT__: JSON.stringify(port) }, server: { port: 5173, strictPort: true, proxy: { '/api': { target, changeOrigin: false }, '/ws': { target, changeOrigin: false, ws: true }, '/healthz': { target, changeOrigin: false } } }, build: { outDir: 'dist' } };
});
