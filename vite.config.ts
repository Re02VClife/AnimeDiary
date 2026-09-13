import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import fs from 'fs';
import path from 'path';
import { createApiHandler } from './server/api-routes';

/**
 * Vite 插件：把共用的 /api 处理器挂到 dev server。
 *
 * ⚠️ 这份处理器同时被 Electron 生产模式使用（electron/api-server.js 用同一个
 * createApiHandler 起本地 HTTP 服务），所以「开发时能用、打包后也能用」，
 * 不存在两套实现。所有后端逻辑都在 server/api-routes.ts。
 */
/** 把版本号写进 dist/version.json，桌面端靠它比较"内置 vs 已下载更新"谁更新 */
function versionFilePlugin(): Plugin {
  return {
    name: 'version-file',
    generateBundle() {
      const pkg = JSON.parse(fs.readFileSync(path.resolve(__dirname, 'package.json'), 'utf-8'));
      this.emitFile({
        type: 'asset',
        fileName: 'version.json',
        source: JSON.stringify({ version: pkg.version, buildTime: new Date().toISOString() }, null, 2),
      });
    },
  };
}

function excelApiPlugin(): Plugin {
  return {
    name: 'excel-api',
    configureServer(server) {
      // dev 模式：数据目录 = 项目根目录（与以往行为完全一致）
      server.middlewares.use(createApiHandler({ DATA_DIR: __dirname }));
    },
  };
}

export default defineConfig({
  plugins: [react(), excelApiPlugin(), versionFilePlugin()],
  // 打包后由 Electron 用 file:// 之外的本地 HTTP 提供，相对路径更稳
  base: './',
  root: '.',
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, 'src'),
    },
  },
  server: {
    port: 5173,
    strictPort: true,
    watch: {
      // 主进程/构建产物与前端无关；监视 electron/ 会在原子写文件时触发 EBUSY 让 dev server 崩溃
      ignored: ['**/electron/**', '**/server/**', '**/release/**', '**/backups/**', '**/build/**'],
    },
  },
  optimizeDeps: {
    include: ['xlsx'],
  },
});
