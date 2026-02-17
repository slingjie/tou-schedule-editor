/**
 * 桌面版后端 Sidecar 启动与管理模块
 *
 * 仅在 Tauri 桌面环境下使用（通过 window.__TAURI_INTERNALS__ 检测）。
 * 负责：
 * - 启动 backend-server sidecar 进程
 * - 轮询健康检查等待后端就绪
 * - 窗口关闭时自动终止后端进程
 */

// 检测是否处于 Tauri 桌面环境
export const isTauriDesktop = (): boolean => {
    return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
};

// 桌面版后端固定端口
const BACKEND_PORT = 8000;
const BACKEND_URL = `http://127.0.0.1:${BACKEND_PORT}`;
const HEALTH_URL = `${BACKEND_URL}/health`;

// 最大健康检查等待时间（ms）
const MAX_WAIT_MS = 30_000;
const POLL_INTERVAL_MS = 500;

/** 后端进程引用（用于清理） */
let backendChild: any = null;

/**
 * 检查后端是否已就绪
 */
async function checkHealth(): Promise<boolean> {
    try {
        const res = await fetch(HEALTH_URL, { signal: AbortSignal.timeout(2000) });
        if (res.ok) {
            const data = await res.json();
            return data?.status === 'ok';
        }
        return false;
    } catch {
        return false;
    }
}

/**
 * 等待后端就绪（轮询健康检查）
 */
async function waitForBackend(): Promise<void> {
    const start = Date.now();
    while (Date.now() - start < MAX_WAIT_MS) {
        if (await checkHealth()) {
            console.log('[desktop] 后端已就绪');
            return;
        }
        await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
    }
    throw new Error(`后端在 ${MAX_WAIT_MS / 1000}s 内未就绪，请检查是否有端口冲突`);
}

/**
 * 启动后端 Sidecar 进程
 *
 * 调用时机：App 挂载前（index.tsx）
 */
export async function startBackend(): Promise<void> {
    if (!isTauriDesktop()) {
        console.log('[desktop] 非桌面环境，跳过后端启动');
        return;
    }

    // 检查后端是否已在运行
    if (await checkHealth()) {
        console.log('[desktop] 后端已在运行（端口已占用），跳过启动');
        return;
    }

    try {
        // 动态导入 Tauri shell 插件
        const { Command } = await import('@tauri-apps/plugin-shell');

        console.log('[desktop] 正在启动后端 sidecar...');
        const command = Command.sidecar('binaries/backend-server');

        command.on('error', (error: string) => {
            console.error('[desktop] 后端进程错误:', error);
        });

        command.stdout.on('data', (line: string) => {
            console.log('[backend]', line);
        });

        command.stderr.on('data', (line: string) => {
            console.warn('[backend:err]', line);
        });

        command.on('close', (data: { code: number; signal: number | null }) => {
            console.log('[desktop] 后端进程已退出, code:', data.code);
            backendChild = null;
        });

        backendChild = await command.spawn();
        console.log('[desktop] 后端进程已启动, pid:', backendChild.pid);

        // 等待后端就绪
        await waitForBackend();
    } catch (err) {
        console.error('[desktop] 启动后端失败:', err);
        throw err;
    }
}

/**
 * 停止后端 Sidecar 进程
 */
export async function stopBackend(): Promise<void> {
    if (backendChild) {
        try {
            await backendChild.kill();
            console.log('[desktop] 后端进程已终止');
        } catch (err) {
            console.warn('[desktop] 终止后端进程失败:', err);
        }
        backendChild = null;
    }
}

/**
 * 获取桌面版 API Base URL
 *
 * 桌面版固定使用 http://127.0.0.1:8000
 * Web 版返回空字符串（依赖 Vite proxy）或 VITE_BACKEND_BASE_URL
 */
export function getApiBaseUrl(): string {
    if (isTauriDesktop()) {
        return BACKEND_URL;
    }
    // Web 模式：依赖 Vite proxy 或 VITE_BACKEND_BASE_URL 环境变量
    try {
        const envUrl = (import.meta as any).env?.VITE_BACKEND_BASE_URL || '';
        return envUrl.replace(/\/$/, '');
    } catch {
        return '';
    }
}
