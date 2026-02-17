import type { BackendLoadAnalysisResponse } from './types';
import { getApiBaseUrl } from './desktopBackend';

const BASE_URL = getApiBaseUrl();

export const analyzeLoadFile = async (file: File): Promise<BackendLoadAnalysisResponse> => {
  const formData = new FormData();
  formData.append('file', file);

  const url = `${BASE_URL}/api/load/analyze`;
  console.debug('[loadApi] POST', url, { base: BASE_URL });

  const response = await fetch(url, {
    method: 'POST',
    body: formData,
  });

  const contentType = response.headers.get('content-type') || '';
  let payload: any = null;
  let rawText: string | null = null;
  try {
    if (contentType.includes('application/json')) {
      payload = await response.json().catch(() => null);
    } else {
      rawText = await response.text().catch(() => null);
      try { payload = rawText ? JSON.parse(rawText) : null; } catch { /* ignore */ }
    }
  } catch (e) {
    // ignore parse errors
  }

  if (!response.ok) {
    const detail = payload?.detail || rawText || `${response.status} ${response.statusText}` || '服务器处理失败，请稍后重试。';
    console.error('[loadApi] analyzeLoadFile failed', {
      url,
      status: response.status,
      statusText: response.statusText,
      detail,
      payload,
      rawText,
    });
    throw new Error(detail);
  }

  return payload as BackendLoadAnalysisResponse;
};

// 带上传进度的版本：使用 XMLHttpRequest 监听上传进度事件
export const analyzeLoadFileWithProgress = (
  file: File,
  onProgress?: (loaded: number, total: number) => void,
): { promise: Promise<BackendLoadAnalysisResponse>; abort: () => void } => {
  const formData = new FormData();
  formData.append('file', file);
  const url = `${BASE_URL}/api/load/analyze`;
  console.debug('[loadApi] XHR POST', url, { base: BASE_URL, file: { name: file.name, size: file.size } });

  const xhr = new XMLHttpRequest();
  xhr.open('POST', url, true);

  if (onProgress) {
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) {
        onProgress(e.loaded, e.total);
      }
    };
  }

  const promise = new Promise<BackendLoadAnalysisResponse>((resolve, reject) => {
    xhr.onerror = () => {
      reject(new Error('网络错误，无法上传文件。'));
    };
    xhr.upload.onload = () => {
      // 上传完毕（服务器可能仍在解析），不在此处 resolve
    };
    xhr.onreadystatechange = () => {
      if (xhr.readyState === 4) {
        const contentType = xhr.getResponseHeader('content-type') || '';
        let payload: any = null;
        let rawText: string | null = null;
        try {
          rawText = xhr.responseText;
          if (contentType.includes('application/json')) {
            payload = JSON.parse(rawText);
          } else {
            try { payload = rawText ? JSON.parse(rawText) : null; } catch { /* ignore */ }
          }
        } catch { /* ignore parse */ }

        if (xhr.status < 200 || xhr.status >= 300) {
          const detail = payload?.detail || rawText || `${xhr.status} ${xhr.statusText}` || '服务器处理失败，请稍后重试。';
          console.error('[loadApi] analyzeLoadFileWithProgress failed', {
            url,
            status: xhr.status,
            statusText: xhr.statusText,
            detail,
            payload,
            rawText,
          });
          reject(new Error(detail));
          return;
        }
        resolve(payload as BackendLoadAnalysisResponse);
      }
    };
    try {
      xhr.send(formData);
    } catch (err) {
      reject(err instanceof Error ? err : new Error(String(err)));
    }
  });

  return {
    promise,
    abort: () => {
      try { xhr.abort(); } catch { /* ignore */ }
    },
  };
};
