import type {
  BackendStorageCyclesResponse,
  BackendStorageCurvesResponse,
  MonthlyTouPrices,
  CleaningAnalysisResponse,
  CleaningConfigRequest,
  CleaningResultResponse,
  StorageEconomicsInput,
  StorageEconomicsResult,
} from './types';
import { getApiBaseUrl } from './desktopBackend';

export const BASE_URL = getApiBaseUrl();

export interface StorageParamsPayload {
  storage: {
    capacity_kwh: number;
    c_rate: number;
    single_side_efficiency: number; // η
    depth_of_discharge: number;     // DOD
    soc_min?: number;
    soc_max?: number;
    initial_soc?: number;
    reserve_charge_kw?: number;
    reserve_discharge_kw?: number;
    metering_mode: 'monthly_demand_max' | 'transformer_capacity';
    transformer_capacity_kva?: number;
    transformer_power_factor?: number;
    calc_style?: 'window_avg';
    energy_formula?: 'physics' | 'sample';
    soc_carry_over?: boolean;
    merge_threshold_minutes?: number;
  };
  strategySource: {
    monthlySchedule: any[]; // 24h * 12 months，复用现有结构
    dateRules: any[];       // 复用现有结构
  };
  monthlyTouPrices: MonthlyTouPrices;
  // 可选：直接复用“负荷分析”页面上传后的点数组（程序互通）
  // 若提供 points，可不传 file；后端将优先使用 points。
  points?: { timestamp: string; load_kwh: number }[];
}

export const computeStorageCycles = async (
  file: File | null,
  payload: StorageParamsPayload,
): Promise<BackendStorageCyclesResponse> => {
  const formData = new FormData();
  if (file) formData.append('file', file);
  formData.append('payload', JSON.stringify(payload));

  const url = `${BASE_URL}/api/storage/cycles`;
  console.debug('[storageApi] POST', url, { base: BASE_URL });

  const response = await fetch(url, {
    method: 'POST',
    body: formData,
  });

  const contentType = response.headers.get('content-type') || '';
  let result: any = null;
  let rawText: string | null = null;
  try {
    if (contentType.includes('application/json')) {
      result = await response.json().catch(() => null);
    } else {
      rawText = await response.text().catch(() => null);
      try { result = rawText ? JSON.parse(rawText) : null; } catch { /* ignore */ }
    }
  } catch (e) {
    // ignore parse errors
  }

  if (!response.ok) {
    const detail = result?.detail || rawText || `${response.status} ${response.statusText}` || '服务器处理失败，请稍后重试。';
    console.error('[storageApi] computeStorageCycles failed', {
      url,
      status: response.status,
      statusText: response.statusText,
      detail,
      payload,
      rawText,
    });
    throw new Error(detail);
  }

  return result as BackendStorageCyclesResponse;
};

/**
 * 按需导出储能次数测算的 Excel 报表。
 *
 * 与 computeStorageCycles 共用同一个后端接口，仅额外传递 export_excel=true，
 * 让后端在已有计算逻辑基础上生成 Excel 文件并返回 excel_path。
 * 说明：
 * - 默认测算不导出 Excel，以降低每次测算的耗时；
 * - 只有在用户点击“导出报表”时才调用本函数。
 */
export const exportStorageCyclesReport = async (
  file: File | null,
  payload: StorageParamsPayload,
): Promise<BackendStorageCyclesResponse> => {
  const formData = new FormData();
  if (file) formData.append('file', file);
  formData.append('payload', JSON.stringify(payload));
  formData.append('export_excel', 'true');

  const url = `${BASE_URL}/api/storage/cycles`;
  console.debug('[storageApi] POST export cycles excel', url, { base: BASE_URL });

  const response = await fetch(url, {
    method: 'POST',
    body: formData,
  });

  const contentType = response.headers.get('content-type') || '';
  let result: any = null;
  let rawText: string | null = null;
  try {
    if (contentType.includes('application/json')) {
      result = await response.json().catch(() => null);
    } else {
      rawText = await response.text().catch(() => null);
      try { result = rawText ? JSON.parse(rawText) : null; } catch { /* ignore */ }
    }
  } catch {
    // ignore parse errors
  }

  if (!response.ok) {
    const detail =
      result?.detail ||
      rawText ||
      `${response.status} ${response.statusText}` ||
      '储能次数报表导出失败，请稍后重试。';
    console.error('[storageApi] exportStorageCyclesReport failed', {
      url,
      status: response.status,
      statusText: response.statusText,
      detail,
      payload,
      rawText,
    });
    throw new Error(detail);
  }

  return result as BackendStorageCyclesResponse;
};

/**
 * 导出“运行与收益业务报表”（CSV 多表打包 ZIP）。
 *
 * 与 exportStorageCyclesReport 复用同一后端接口，但额外指定
 * export_mode=business，使后端调用新的业务报表导出函数。
 * 后端会生成多张 CSV（如日度/月度运行统计、运行看板、逐点曲线精简），
 * 并打包为一个 ZIP 文件返回，前端仍通过 excel_path 下载。
 */
export const exportStorageBusinessReport = async (
  file: File | null,
  payload: StorageParamsPayload,
): Promise<BackendStorageCyclesResponse> => {
  const formData = new FormData();
  if (file) formData.append('file', file);
  formData.append('payload', JSON.stringify(payload));
  formData.append('export_excel', 'true');
  formData.append('export_mode', 'business');

  const url = `${BASE_URL}/api/storage/cycles`;
  console.debug('[storageApi] POST export business report (csv zip)', url, { base: BASE_URL });

  const response = await fetch(url, {
    method: 'POST',
    body: formData,
  });

  const contentType = response.headers.get('content-type') || '';
  let result: any = null;
  let rawText: string | null = null;
  try {
    if (contentType.includes('application/json')) {
      result = await response.json().catch(() => null);
    } else {
      rawText = await response.text().catch(() => null);
      try { result = rawText ? JSON.parse(rawText) : null; } catch { /* ignore */ }
    }
  } catch {
    // ignore parse errors
  }

  if (!response.ok) {
    const detail =
      result?.detail ||
      rawText ||
      `${response.status} ${response.statusText}` ||
      '运行与收益报表导出失败，请稍后重试。';
    console.error('[storageApi] exportStorageBusinessReport failed', {
      url,
      status: response.status,
      statusText: response.statusText,
      detail,
      payload,
      rawText,
    });
    throw new Error(detail);
  }

  return result as BackendStorageCyclesResponse;
};

// 带上传进度与取消能力的版本（主要针对开始测算按钮上传大文件时的交互优化）
export const computeStorageCyclesWithProgress = (
  file: File | null,
  payload: StorageParamsPayload,
  onUploadProgress?: (loaded: number, total: number) => void,
): { promise: Promise<BackendStorageCyclesResponse>; abort: () => void } => {
  const formData = new FormData();
  if (file) formData.append('file', file);
  formData.append('payload', JSON.stringify(payload));
  const url = `${BASE_URL}/api/storage/cycles`;
  console.debug('[storageApi] XHR POST cycles', url, { base: BASE_URL, hasFile: !!file });

  const xhr = new XMLHttpRequest();
  xhr.open('POST', url, true);

  if (onUploadProgress) {
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) {
        onUploadProgress(e.loaded, e.total);
      }
    };
  }

  const promise = new Promise<BackendStorageCyclesResponse>((resolve, reject) => {
    xhr.onerror = () => {
      reject(new Error('网络错误，无法提交测算请求。'));
    };
    xhr.onreadystatechange = () => {
      if (xhr.readyState === 4) {
        const contentType = xhr.getResponseHeader('content-type') || '';
        let result: any = null;
        let rawText: string | null = null;
        try {
          rawText = xhr.responseText;
          if (contentType.includes('application/json')) {
            result = JSON.parse(rawText);
          } else {
            try { result = rawText ? JSON.parse(rawText) : null; } catch { /* ignore */ }
          }
        } catch { /* ignore parse */ }

        if (xhr.status < 200 || xhr.status >= 300) {
          const detail = result?.detail || rawText || `${xhr.status} ${xhr.statusText}` || '服务器处理失败，请稍后重试。';
          console.error('[storageApi] computeStorageCyclesWithProgress failed', {
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
        resolve(result as BackendStorageCyclesResponse);
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
    abort: () => { try { xhr.abort(); } catch { /* ignore */ } },
  };
};

export const fetchStorageCurves = async (
  payload: StorageParamsPayload,
  date: string,
): Promise<BackendStorageCurvesResponse> => {
  const url = `${BASE_URL}/api/storage/cycles/curves`;
  console.debug('[storageApi] POST', url, { base: BASE_URL, date });

  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ payload, date }),
  });

  const contentType = response.headers.get('content-type') || '';
  let result: any = null;
  let rawText: string | null = null;
  try {
    if (contentType.includes('application/json')) {
      result = await response.json().catch(() => null);
    } else {
      rawText = await response.text().catch(() => null);
      try { result = rawText ? JSON.parse(rawText) : null; } catch { /* ignore */ }
    }
  } catch (e) {
    // ignore parse errors
  }

  if (!response.ok) {
    const detail = result?.detail || rawText || `${response.status} ${response.statusText}` || '获取储能收益曲线失败，请稍后重试。';
    console.error('[storageApi] fetchStorageCurves failed', {
      url,
      status: response.status,
      statusText: response.statusText,
      detail,
      payload,
      rawText,
    });
    throw new Error(detail);
  }

  return result as BackendStorageCurvesResponse;
};

// ===================== 数据清洗相关 API =====================

/**
 * 分析上传的数据，检测零值、负值时段，返回清洗建议
 * @param fileOrPoints - 文件对象或数据点数组
 */
export const analyzeDataForCleaning = async (
  fileOrPoints: File | { timestamp: string; load_kwh: number }[],
): Promise<CleaningAnalysisResponse> => {
  const formData = new FormData();

  if (fileOrPoints instanceof File) {
    formData.append('file', fileOrPoints);
  } else {
    // 传入数据点数组
    formData.append('payload', JSON.stringify({ points: fileOrPoints }));
  }

  const url = `${BASE_URL}/api/cleaning/analyze`;
  console.debug('[storageApi] POST cleaning/analyze', url, { isFile: fileOrPoints instanceof File, pointsCount: fileOrPoints instanceof File ? 'N/A' : fileOrPoints.length });

  const response = await fetch(url, {
    method: 'POST',
    body: formData,
  });

  const contentType = response.headers.get('content-type') || '';
  let result: any = null;
  let rawText: string | null = null;
  try {
    if (contentType.includes('application/json')) {
      result = await response.json().catch(() => null);
    } else {
      rawText = await response.text().catch(() => null);
      try { result = rawText ? JSON.parse(rawText) : null; } catch { /* ignore */ }
    }
  } catch (e) {
    // ignore parse errors
  }

  if (!response.ok) {
    const detail = result?.detail || rawText || `${response.status} ${response.statusText}` || '分析数据失败';
    console.error('[storageApi] analyzeDataForCleaning failed', { url, status: response.status, detail });
    throw new Error(detail);
  }

  return result as CleaningAnalysisResponse;
};

/**
 * 应用用户确认的清洗配置，返回清洗后的数据
 * @param fileOrPoints - 文件对象或数据点数组
 * @param config - 清洗配置
 */
export const applyDataCleaning = async (
  fileOrPoints: File | { timestamp: string; load_kwh: number }[],
  config: CleaningConfigRequest,
): Promise<CleaningResultResponse> => {
  const formData = new FormData();

  if (fileOrPoints instanceof File) {
    formData.append('file', fileOrPoints);
    formData.append('payload', JSON.stringify({ config }));
  } else {
    // 传入数据点数组
    formData.append('payload', JSON.stringify({ points: fileOrPoints, config }));
  }

  const url = `${BASE_URL}/api/cleaning/apply`;
  console.debug('[storageApi] POST cleaning/apply', url, { isFile: fileOrPoints instanceof File });

  const response = await fetch(url, {
    method: 'POST',
    body: formData,
  });

  const contentType = response.headers.get('content-type') || '';
  let result: any = null;
  let rawText: string | null = null;
  try {
    if (contentType.includes('application/json')) {
      result = await response.json().catch(() => null);
    } else {
      rawText = await response.text().catch(() => null);
      try { result = rawText ? JSON.parse(rawText) : null; } catch { /* ignore */ }
    }
  } catch (e) {
    // ignore parse errors
  }

  if (!response.ok) {
    const detail = result?.detail || rawText || `${response.status} ${response.statusText}` || '数据清洗失败';
    console.error('[storageApi] applyDataCleaning failed', { url, status: response.status, detail });
    throw new Error(detail);
  }

  return result as CleaningResultResponse;
};

// ===================== 储能经济性测算 API =====================

/**
 * 计算储能项目经济性指标（IRR、静态回收期、年度现金流）
 * @param input - 经济性测算输入参数
 */
export const computeStorageEconomics = async (
  input: StorageEconomicsInput,
): Promise<StorageEconomicsResult> => {
  const url = `${BASE_URL}/api/storage/economics`;
  console.debug('[storageApi] POST storage/economics', url, input);

  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });

  const contentType = response.headers.get('content-type') || '';
  let result: any = null;
  let rawText: string | null = null;
  try {
    if (contentType.includes('application/json')) {
      result = await response.json().catch(() => null);
    } else {
      rawText = await response.text().catch(() => null);
      try { result = rawText ? JSON.parse(rawText) : null; } catch { /* ignore */ }
    }
  } catch (e) {
    // ignore parse errors
  }

  if (!response.ok) {
    const detail = result?.detail || rawText || `${response.status} ${response.statusText}` || '经济性测算失败';
    console.error('[storageApi] computeStorageEconomics failed', { url, status: response.status, detail, input });
    throw new Error(detail);
  }

  return result as StorageEconomicsResult;
};

/**
 * 导出多年期经济性现金流明细报表（CSV格式）
 */
export const exportEconomicsCashflowReport = async (
  input: StorageEconomicsInput,
  userSharePercent: number = 0,
): Promise<{ excel_path: string; message: string }> => {
  const url = `${BASE_URL}/api/storage/economics/export`;
  const requestBody = {
    ...input,
    user_share_percent: userSharePercent,
  };

  console.debug('[storageApi] POST storage/economics/export', url, requestBody);

  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(requestBody),
  });

  const contentType = response.headers.get('content-type') || '';
  let result: any = null;
  let rawText: string | null = null;
  try {
    if (contentType.includes('application/json')) {
      result = await response.json().catch(() => null);
    } else {
      rawText = await response.text().catch(() => null);
      try { result = rawText ? JSON.parse(rawText) : null; } catch { /* ignore */ }
    }
  } catch (e) {
    // ignore parse errors
  }

  if (!response.ok) {
    // 对于422错误，显示详细的验证错误信息
    let errorMsg = '';
    if (response.status === 422 && result?.detail) {
      if (Array.isArray(result.detail)) {
        // FastAPI验证错误格式
        errorMsg = result.detail.map((err: any) =>
          `${err.loc?.join('.') || 'unknown'}: ${err.msg}`
        ).join('; ');
      } else {
        errorMsg = typeof result.detail === 'string' ? result.detail : JSON.stringify(result.detail);
      }
    } else {
      errorMsg = result?.detail || rawText || `${response.status} ${response.statusText}` || '报表生成失败';
    }

    console.error('[storageApi] exportEconomicsCashflowReport failed', {
      url,
      status: response.status,
      error: errorMsg,
      requestBody,
      responseDetail: result
    });
    throw new Error(errorMsg);
  }

  return result as { excel_path: string; message: string };
};
