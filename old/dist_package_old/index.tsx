
import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import { ErrorBoundary } from './components/ErrorBoundary';
import { isTauriDesktop, startBackend, stopBackend } from './desktopBackend';

const rootElement = document.getElementById('root');
if (!rootElement) {
  throw new Error("Could not find root element to mount to");
}

async function bootstrap() {
  // 桌面版：启动后端 sidecar
  if (isTauriDesktop()) {
    try {
      await startBackend();
    } catch (err) {
      console.error('后端启动失败:', err);
      // 即使后端启动失败也渲染 UI（部分功能可离线使用）
    }

    // 窗口关闭时终止后端
    window.addEventListener('beforeunload', () => {
      stopBackend();
    });
  }

  const root = ReactDOM.createRoot(rootElement);
  root.render(
    <React.StrictMode>
      <ErrorBoundary>
        <App />
      </ErrorBoundary>
    </React.StrictMode>
  );
}

bootstrap();
