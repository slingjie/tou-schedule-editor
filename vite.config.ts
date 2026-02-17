import path from 'path';
import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, '.', '');
  return {
    // Tauri v2 适配
    clearScreen: false,
    envPrefix: ['VITE_', 'TAURI_ENV_'],
    server: {
      port: 5173,
      strictPort: true,
      host: '127.0.0.1',
      watch: {
        ignored: ['**/src-tauri/**'],
      },
      proxy: {
        // 仅代理真实后端接口路径，避免将本地模块如 /api.ts 误代理到后端
        '/api/': {
          target: env.VITE_BACKEND_BASE_URL || 'http://localhost:8000',
          changeOrigin: true,
          secure: false,
        },
        '/outputs/': {
          target: env.VITE_BACKEND_BASE_URL || 'http://localhost:8000',
          changeOrigin: true,
          secure: false,
        },
        // 便于在前端同源环境下自检后端版本/路由是否已加载
        '/openapi.json': {
          target: env.VITE_BACKEND_BASE_URL || 'http://localhost:8000',
          changeOrigin: true,
          secure: false,
        },
        '/health': {
          target: env.VITE_BACKEND_BASE_URL || 'http://localhost:8000',
          changeOrigin: true,
          secure: false,
        },
      }
    },
    plugins: [react()],
    define: {
      // 注意：API Key 不应注入前端包（安全审计 P0 #1）
      // 所有需要 API Key 的请求应通过后端代理
    },
    resolve: {
      alias: {
        '@': path.resolve(__dirname, '.'),
      }
    }
  };
});
