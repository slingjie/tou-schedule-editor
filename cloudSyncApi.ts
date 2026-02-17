/**
 * Cloud Sync API client — talks to /api/sync/* Pages Functions.
 */

const SYNC_BASE = '/api/sync';

type RegisterPayload = {
  device_id: string;
  device_name?: string;
};

type RegisterResponse = {
  ok: boolean;
  device_id: string;
};

export type EntityAction = 'upsert' | 'delete';
export type EntityType = 'project' | 'dataset' | 'run' | 'run_artifact' | 'tou_config';

export type PushEntity = {
  type: EntityType;
  id: string;
  action: EntityAction;
  data?: Record<string, unknown>;
};

type PushPayload = {
  device_id: string;
  entities: PushEntity[];
};

type PushResponse = {
  ok: boolean;
  synced: number;
};

type UploadPayload = {
  device_id: string;
  r2_key: string;
  body: Blob | ArrayBuffer;
  content_type?: string;
};

type UploadResponse = {
  ok: boolean;
  r2_key: string;
  size_bytes: number;
};

/**
 * 从 localStorage 获取 Sync API Key（安全审计 P0 #2）
 * 用户需在应用设置中配置此 Key，与 Cloudflare 环境变量 SYNC_API_KEY 一致
 */
function getSyncApiKey(): string {
  try {
    return localStorage.getItem('SYNC_API_KEY') || '';
  } catch {
    return '';
  }
}

async function request<T>(path: string, init: RequestInit): Promise<T> {
  // 安全审计 P0 #2：自动附加 API Key
  const apiKey = getSyncApiKey();
  const headers = new Headers(init.headers || {});
  if (apiKey) {
    headers.set('X-API-Key', apiKey);
  }

  const res = await fetch(`${SYNC_BASE}${path}`, { ...init, headers });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Sync API ${path} failed (${res.status}): ${text}`);
  }
  return res.json() as Promise<T>;
}

export async function registerDevice(payload: RegisterPayload): Promise<RegisterResponse> {
  return request<RegisterResponse>('/register', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
}

export async function pushEntities(payload: PushPayload): Promise<PushResponse> {
  return request<PushResponse>('/push', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
}

export async function uploadBlob(payload: UploadPayload): Promise<UploadResponse> {
  return request<UploadResponse>('/upload', {
    method: 'POST',
    headers: {
      'Content-Type': payload.content_type || 'application/octet-stream',
      'X-Device-Id': payload.device_id,
      'X-R2-Key': payload.r2_key,
    },
    body: payload.body,
  });
}

// --- Phase 2: Pull ---

export type PullProject = {
  id: string;
  name: string;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
};

export type PullDataset = {
  id: string;
  project_id: string;
  name: string;
  source_filename: string | null;
  fingerprint: string | null;
  start_time: string | null;
  end_time: string | null;
  interval_minutes: number | null;
  points_count: number;
  meta_json: unknown | null;
  quality_report_json: unknown | null;
  r2_points_key: string | null;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
};

export type PullRun = {
  id: string;
  project_id: string;
  name: string;
  dataset_id: string | null;
  config_snapshot: unknown | null;
  cycles_snapshot: unknown | null;
  economics_snapshot: unknown | null;
  profit_snapshot: unknown | null;
  quality_snapshot: unknown | null;
  r2_embedded_points_key: string | null;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
};

export type PullTouConfig = {
  id: string;
  name: string;
  schedule_data: unknown;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
};

export type PullResponse = {
  ok: boolean;
  since: string;
  projects: PullProject[];
  datasets: PullDataset[];
  runs: PullRun[];
  tou_configs: PullTouConfig[];
};

export async function pullEntities(deviceId: string, since: string): Promise<PullResponse> {
  const params = new URLSearchParams({ device_id: deviceId, since });
  return request<PullResponse>(`/pull?${params}`, { method: 'GET' });
}

export async function downloadBlob(r2Key: string): Promise<Response> {
  const headers: Record<string, string> = {};
  const apiKey = getSyncApiKey();
  if (apiKey) {
    headers['X-API-Key'] = apiKey;
  }
  const res = await fetch(`${SYNC_BASE}/download/${encodeURIComponent(r2Key)}`, { headers });
  if (!res.ok) {
    throw new Error(`Download ${r2Key} failed (${res.status})`);
  }
  return res;
}
