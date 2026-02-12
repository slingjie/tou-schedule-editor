import type { BackendLoadAnalysisResponse } from './types';
import { getApiBaseUrl } from './desktopBackend';
import * as XLSX from 'xlsx';

const BASE_URL = getApiBaseUrl();

/**
 * 预处理文件：如果是 Excel 或非标准 CSV，尝试转换为标准 CSV (Timestamp, Load)
 */
async function preprocessFile(file: File): Promise<File> {
  // 如果是 Excel 文件，解析并转换为 CSV
  if (file.name.endsWith('.xlsx') || file.name.endsWith('.xls')) {
    console.debug('[loadApi] 检测到 Excel 文件，正在转换为 CSV...');
    const buffer = await file.arrayBuffer();
    const workbook = XLSX.read(buffer, { type: 'array' });
    const firstSheetName = workbook.SheetNames[0];
    const worksheet = workbook.Sheets[firstSheetName];

    // 转换为 CSV 字符串
    const csvOutput = XLSX.utils.sheet_to_csv(worksheet);

    // 创建新的 File 对象
    // 使用 UTF-8 BOM 防止乱码 (虽然我们后端已支持 UTF-8)
    const blob = new Blob([csvOutput], { type: 'text/csv;charset=utf-8' });
    return new File([blob], file.name.replace(/\.(xlsx|xls)$/, '.csv'), { type: 'text/csv' });
  }

  // 对于 CSV 文件，也可以选择性地进行清洗，或者直接透传
  // 为了保证兼容性，这里直接返回原文件，依赖后端的增强解析逻辑
  return file;
}

export const analyzeLoadFile = async (originalFile: File): Promise<BackendLoadAnalysisResponse> => {
  const file = await preprocessFile(originalFile);

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
