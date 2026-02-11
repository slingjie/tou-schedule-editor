import React from 'react';

type ErrorBoundaryState = {
  hasError: boolean;
  message: string;
  stack?: string;
};

// 全局错误边界：捕获渲染/生命周期中未处理的异常，避免白屏
export class ErrorBoundary extends React.Component<React.PropsWithChildren<{}>, ErrorBoundaryState> {
  constructor(props: {}) {
    super(props);
    this.state = { hasError: false, message: '', stack: undefined };
  }

  static getDerivedStateFromError(error: unknown): ErrorBoundaryState {
    const message = error instanceof Error ? error.message : String(error);
    const stack = error instanceof Error ? error.stack : undefined;
    return { hasError: true, message, stack };
  }

  componentDidCatch(error: unknown, errorInfo: React.ErrorInfo): void {
    // 输出到控制台，后续可对接远程日志
    console.error('[ErrorBoundary] 捕获异常', error, errorInfo);
  }

  render(): React.ReactNode {
    if (this.state.hasError) {
      return (
        <div className="min-h-screen bg-slate-100 flex items-center justify-center p-6">
          <div className="max-w-xl w-full bg-white rounded-xl shadow-lg p-6 border border-red-200">
            <h1 className="text-xl font-bold text-red-700 mb-2">页面发生错误</h1>
            <p className="text-sm text-slate-700">{this.state.message}</p>
            {this.state.stack && (
              <details className="mt-3 text-xs text-slate-500 whitespace-pre-wrap break-all">
                <summary className="cursor-pointer">展开错误堆栈</summary>
                {this.state.stack}
              </details>
            )}
            <button
              className="mt-4 px-4 py-2 bg-blue-600 text-white rounded-md"
              onClick={() => (window.location.href = '/')}
            >
              刷新页面
            </button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}

