/**
 * Cloud Sync Manager — device ID, push queue, pull sync, online/offline.
 *
 * Usage:
 *   import { enqueuePush, initSync, getSyncStatus } from './cloudSyncManager';
 *   enqueuePush({ type: 'project', id: project.id, action: 'upsert', data: { ... } });
 *   await initSync();  // call once at app startup
 */

import {
  registerDevice, pushEntities, uploadBlob,
  pullEntities,
  type PushEntity, type PullResponse,
} from './cloudSyncApi';
import {
  upsertProject, upsertDatasetWithPoints, upsertRunWithArtifacts,
  deleteProject, deleteDataset, deleteRun,
  type LocalProject, type LocalDataset, type LocalRun, type LocalRunArtifact,
} from './localProjectStore';

// ── Constants ──────────────────────────────────────────────

const DEVICE_ID_KEY = 'cloud_sync_device_id';
const LAST_PULL_KEY = 'cloud_sync_last_pull';
const PUSH_DEBOUNCE_MS = 2000;
const PULL_INTERVAL_MS = 5 * 60 * 1000; // 5 min
const TOU_STORAGE_KEY = 'tou_schedule_configurations';

// Flag to suppress push hooks during pull merge (breaks circular dependency)
let _skipSync = false;
export function isSyncPulling(): boolean { return _skipSync; }

// ── Sync status ────────────────────────────────────────────

export type SyncState = 'idle' | 'syncing' | 'offline' | 'error';

export type SyncStatus = {
  state: SyncState;
  lastPullAt: string | null;
  pendingPushCount: number;
  lastError: string | null;
};

let syncState: SyncState = 'idle';
let lastError: string | null = null;
const listeners: Array<() => void> = [];

function setSyncState(s: SyncState, err?: string): void {
  syncState = s;
  lastError = err ?? null;
  for (const fn of listeners) fn();
}

export function getSyncStatus(): SyncStatus {
  return {
    state: syncState,
    lastPullAt: getLastPullTime(),
    pendingPushCount: pushQueue.length,
    lastError,
  };
}

export function onSyncStatusChange(fn: () => void): () => void {
  listeners.push(fn);
  return () => {
    const idx = listeners.indexOf(fn);
    if (idx >= 0) listeners.splice(idx, 1);
  };
}

// ── Device ID ──────────────────────────────────────────────

let deviceId: string | null = null;
let registered = false;

function generateDeviceId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return `dev_${crypto.randomUUID()}`;
  }
  return `dev_${Math.random().toString(36).slice(2)}_${Date.now().toString(36)}`;
}

export function getDeviceId(): string {
  if (deviceId) return deviceId;
  try {
    const stored = localStorage.getItem(DEVICE_ID_KEY);
    if (stored) { deviceId = stored; return stored; }
  } catch { /* ignore */ }
  const id = generateDeviceId();
  deviceId = id;
  try { localStorage.setItem(DEVICE_ID_KEY, id); } catch { /* ignore */ }
  return id;
}

async function ensureRegistered(): Promise<void> {
  if (registered) return;
  const id = getDeviceId();
  try {
    await registerDevice({ device_id: id, device_name: navigator.userAgent.slice(0, 100) });
    registered = true;
  } catch (err) {
    console.warn('[CloudSync] register failed, will retry:', err);
  }
}

// ── Push queue ─────────────────────────────────────────────

let pushQueue: PushEntity[] = [];
let debounceTimer: ReturnType<typeof setTimeout> | null = null;
let pushing = false;

async function flushQueue(): Promise<void> {
  if (pushing || pushQueue.length === 0) return;
  pushing = true;

  const batch = pushQueue.splice(0, pushQueue.length);
  const seen = new Map<string, PushEntity>();
  for (const e of batch) seen.set(`${e.type}:${e.id}`, e);
  const deduped = Array.from(seen.values());

  try {
    await ensureRegistered();
    await pushEntities({ device_id: getDeviceId(), entities: deduped });
    console.log(`[CloudSync] pushed ${deduped.length} entities`);
  } catch (err) {
    console.warn('[CloudSync] push failed, re-queuing:', err);
    pushQueue.unshift(...deduped);
  } finally {
    pushing = false;
  }
}

/**
 * Enqueue an entity change for cloud sync.
 * Batches are flushed after a 2-second debounce.
 */
export function enqueuePush(entity: PushEntity): void {
  if (_skipSync) return; // suppress during pull merge
  pushQueue.push(entity);
  if (debounceTimer) clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => {
    debounceTimer = null;
    flushQueue();
  }, PUSH_DEBOUNCE_MS);
}

/**
 * Upload a large blob to R2 via the sync upload endpoint.
 */
export async function uploadToR2(r2Key: string, body: Blob | ArrayBuffer, contentType?: string): Promise<void> {
  await ensureRegistered();
  await uploadBlob({
    device_id: getDeviceId(),
    r2_key: r2Key,
    body,
    content_type: contentType,
  });
}

/**
 * Force flush any pending pushes immediately.
 */
export async function flushPendingSync(): Promise<void> {
  if (debounceTimer) { clearTimeout(debounceTimer); debounceTimer = null; }
  await flushQueue();
}

// ── Pull logic ─────────────────────────────────────────────

function getLastPullTime(): string | null {
  try { return localStorage.getItem(LAST_PULL_KEY); } catch { return null; }
}

function setLastPullTime(iso: string): void {
  try { localStorage.setItem(LAST_PULL_KEY, iso); } catch { /* ignore */ }
}

let pulling = false;

/**
 * Pull changes from cloud and merge into local stores.
 * Uses last-write-wins: cloud entity wins if its updated_at > local updated_at.
 */
export async function pullFromCloud(): Promise<void> {
  if (pulling) return;
  pulling = true;
  setSyncState('syncing');

  try {
    await ensureRegistered();
    const since = getLastPullTime() || '1970-01-01T00:00:00Z';
    const data: PullResponse = await pullEntities(getDeviceId(), since);

    // Suppress push hooks during merge to avoid circular push-back
    _skipSync = true;

    // Track the latest updated_at we see so we can advance the cursor
    let maxUpdatedAt = since;
    const track = (t: string | null | undefined) => {
      if (t && t > maxUpdatedAt) maxUpdatedAt = t;
    };

    // ── Merge projects ──
    for (const p of data.projects) {
      track(p.updated_at);
      if (p.deleted_at) {
        try { await deleteProject(p.id); } catch { /* already gone locally */ }
      } else {
        const local: LocalProject = {
          id: p.id,
          name: p.name,
          created_at: p.created_at,
          updated_at: p.updated_at,
        };
        await upsertProject(local);
      }
    }

    // ── Merge datasets (metadata only, no points from pull) ──
    for (const d of data.datasets) {
      track(d.updated_at);
      if (d.deleted_at) {
        try { await deleteDataset(d.id); } catch { /* already gone */ }
      } else {
        const local: LocalDataset = {
          id: d.id,
          project_id: d.project_id,
          name: d.name,
          source_filename: d.source_filename ?? undefined,
          fingerprint: d.fingerprint ?? undefined,
          start_time: d.start_time ?? undefined,
          end_time: d.end_time ?? undefined,
          interval_minutes: d.interval_minutes ?? undefined,
          points_count: d.points_count ?? 0,
          meta_json: (d.meta_json as any) ?? null,
          quality_report_json: (d.quality_report_json as any) ?? null,
          created_at: d.created_at,
          updated_at: d.updated_at,
        };
        // Upsert without points — keeps existing local points intact
        await upsertDatasetWithPoints(local, []);
      }
    }

    // ── Merge runs ──
    for (const r of data.runs) {
      track(r.updated_at);
      if (r.deleted_at) {
        try { await deleteRun(r.id); } catch { /* already gone */ }
      } else {
        const local: LocalRun = {
          id: r.id,
          project_id: r.project_id,
          name: r.name,
          created_at: r.created_at,
          updated_at: r.updated_at,
          dataset_id: r.dataset_id ?? undefined,
          config_snapshot: r.config_snapshot,
          cycles_snapshot: r.cycles_snapshot,
          economics_snapshot: r.economics_snapshot ?? undefined,
          profit_snapshot: r.profit_snapshot ?? undefined,
          quality_snapshot: (r.quality_snapshot as any) ?? undefined,
        };
        await upsertRunWithArtifacts(local, []);
      }
    }

    // ── Merge TOU configs (localStorage) ──
    if (data.tou_configs.length > 0) {
      const allConfigs = getTouConfigs();
      for (const c of data.tou_configs) {
        track(c.updated_at);
        if (c.deleted_at) {
          delete allConfigs[c.id];
        } else {
          allConfigs[c.id] = {
            id: c.id,
            name: c.name,
            scheduleData: c.schedule_data as any,
          };
        }
      }
      saveTouConfigs(allConfigs);
    }

    setLastPullTime(maxUpdatedAt);
    _skipSync = false;
    setSyncState('idle');
    console.log(`[CloudSync] pulled: ${data.projects.length}P ${data.datasets.length}D ${data.runs.length}R ${data.tou_configs.length}C`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn('[CloudSync] pull failed:', msg);
    setSyncState('error', msg);
  } finally {
    _skipSync = false;
    pulling = false;
  }
}

// ── TOU config helpers (localStorage) ──

function getTouConfigs(): Record<string, { id: string; name: string; scheduleData: any }> {
  try {
    const raw = localStorage.getItem(TOU_STORAGE_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch { return {}; }
}

function saveTouConfigs(configs: Record<string, { id: string; name: string; scheduleData: any }>): void {
  try { localStorage.setItem(TOU_STORAGE_KEY, JSON.stringify(configs)); } catch { /* ignore */ }
}

// ── Lifecycle ──────────────────────────────────────────────

let pullTimer: ReturnType<typeof setInterval> | null = null;

/**
 * Initialize cloud sync. Call once at app startup.
 * - Registers device
 * - Pulls latest changes
 * - Starts periodic pull (every 5 min)
 * - Listens for online/offline events
 */
export async function initSync(): Promise<void> {
  // Online/offline listeners
  if (typeof window !== 'undefined') {
    window.addEventListener('online', onOnline);
    window.addEventListener('offline', onOffline);
    if (!navigator.onLine) {
      setSyncState('offline');
      return; // don't attempt network calls while offline
    }
  }

  // Initial pull
  await pullFromCloud();

  // Periodic pull
  if (!pullTimer) {
    pullTimer = setInterval(() => {
      if (navigator.onLine) pullFromCloud();
    }, PULL_INTERVAL_MS);
  }
}

function onOnline(): void {
  console.log('[CloudSync] online — syncing');
  setSyncState('idle');
  // Flush pending pushes then pull
  flushPendingSync().then(() => pullFromCloud());
}

function onOffline(): void {
  console.log('[CloudSync] offline');
  setSyncState('offline');
}
