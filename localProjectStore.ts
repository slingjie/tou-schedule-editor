import type { BackendAnalysisMeta, BackendQualityReport } from './types';
import { enqueuePush } from './cloudSyncManager';

export type LocalProject = {
  id: string;
  name: string;
  created_at: string;
  updated_at: string;
};

export type StoredLoadPoint = {
  timestamp: string;
  load_kwh: number;
};

export type LocalDataset = {
  id: string;
  project_id: string;
  name: string;
  source_filename?: string;
  fingerprint?: string;
  start_time?: string;
  end_time?: string;
  interval_minutes?: number;
  points_count: number;
  meta_json?: BackendAnalysisMeta | null;
  quality_report_json?: BackendQualityReport | null;
  created_at: string;
  updated_at: string;
};

export type LocalDatasetWithPoints = LocalDataset & { points: StoredLoadPoint[] };

const DB_NAME = 'load-analysis-local-store';
const DB_VERSION = 3;

const STORE_PROJECTS = 'projects';
const STORE_DATASETS = 'datasets';
const STORE_DATASET_POINTS = 'dataset_points';
const STORE_RUNS = 'runs';
const STORE_RUN_ARTIFACTS = 'run_artifacts';
const STORE_SYNC_META = 'sync_meta';

type DatasetPointsRow = { dataset_id: string; points: StoredLoadPoint[] };
type RunArtifactRow = {
  artifact_id: string;
  run_id: string;
  kind: string;
  filename: string;
  mime: string;
  blob: Blob;
  created_at: string;
};

const LS_KEY = 'load-analysis-local-store:v2';

const nowIso = () => new Date().toISOString();

const uuid = (): string => {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  return `id_${Math.random().toString(16).slice(2)}_${Date.now().toString(16)}`;
};

const isIndexedDbAvailable = (): boolean => {
  try {
    return typeof indexedDB !== 'undefined';
  } catch {
    return false;
  }
};

const computeFingerprint = async (points: StoredLoadPoint[]): Promise<string> => {
  const start = points[0]?.timestamp ?? '';
  const end = points[points.length - 1]?.timestamp ?? '';
  const head = `${points.length}|${start}|${end}`;
  const cryptoObj: Crypto | undefined = (typeof crypto !== 'undefined' ? crypto : undefined);
  if (!cryptoObj?.subtle) return head;
  try {
    const sample = points.slice(0, 2048).map(p => `${p.timestamp},${p.load_kwh}`).join('\n');
    const buf = new TextEncoder().encode(`${head}\n${sample}`);
    const digest = await cryptoObj.subtle.digest('SHA-256', buf);
    const hex = Array.from(new Uint8Array(digest)).map(b => b.toString(16).padStart(2, '0')).join('');
    return `${head}|sha256:${hex}`;
  } catch {
    return head;
  }
};

type LocalStoreSnapshot = {
  projects: LocalProject[];
  datasets: LocalDataset[];
  dataset_points: DatasetPointsRow[];
  runs: LocalRun[];
  run_artifacts: Array<Omit<RunArtifactRow, 'blob'> & { base64: string }>;
};

const readLocalStorageSnapshot = (): LocalStoreSnapshot => {
  if (typeof window === 'undefined') {
    return { projects: [], datasets: [], dataset_points: [], runs: [], run_artifacts: [] };
  }
  try {
    const raw = window.localStorage.getItem(LS_KEY);
    if (!raw) return { projects: [], datasets: [], dataset_points: [], runs: [], run_artifacts: [] };
    const parsed = JSON.parse(raw);
    return {
      projects: Array.isArray(parsed?.projects) ? parsed.projects : [],
      datasets: Array.isArray(parsed?.datasets) ? parsed.datasets : [],
      dataset_points: Array.isArray(parsed?.dataset_points) ? parsed.dataset_points : [],
      runs: Array.isArray(parsed?.runs) ? parsed.runs : [],
      run_artifacts: Array.isArray(parsed?.run_artifacts) ? parsed.run_artifacts : [],
    };
  } catch {
    return { projects: [], datasets: [], dataset_points: [], runs: [], run_artifacts: [] };
  }
};

const writeLocalStorageSnapshot = (snap: LocalStoreSnapshot) => {
  if (typeof window === 'undefined') return;
  window.localStorage.setItem(LS_KEY, JSON.stringify(snap));
};

const withLocalStorage = async <T>(fn: (snap: LocalStoreSnapshot) => T | Promise<T>): Promise<T> => {
  const snap = readLocalStorageSnapshot();
  const result = await fn(snap);
  writeLocalStorageSnapshot(snap);
  return result;
};

const openDb = (): Promise<IDBDatabase> => {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onerror = () => reject(req.error || new Error('IndexedDB 打开失败'));
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_PROJECTS)) {
        db.createObjectStore(STORE_PROJECTS, { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains(STORE_DATASETS)) {
        const ds = db.createObjectStore(STORE_DATASETS, { keyPath: 'id' });
        ds.createIndex('by_project_id', 'project_id', { unique: false });
      }
      if (!db.objectStoreNames.contains(STORE_DATASET_POINTS)) {
        db.createObjectStore(STORE_DATASET_POINTS, { keyPath: 'dataset_id' });
      }
      if (!db.objectStoreNames.contains(STORE_RUNS)) {
        const rs = db.createObjectStore(STORE_RUNS, { keyPath: 'id' });
        rs.createIndex('by_project_id', 'project_id', { unique: false });
      }
      if (!db.objectStoreNames.contains(STORE_RUN_ARTIFACTS)) {
        const ra = db.createObjectStore(STORE_RUN_ARTIFACTS, { keyPath: 'artifact_id' });
        ra.createIndex('by_run_id', 'run_id', { unique: false });
      }
      if (!db.objectStoreNames.contains(STORE_SYNC_META)) {
        db.createObjectStore(STORE_SYNC_META, { keyPath: 'entity_key' });
      }
    };
    req.onsuccess = () => resolve(req.result);
  });
};

const idbRequest = <T>(req: IDBRequest<T>): Promise<T> => {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error || new Error('IndexedDB 请求失败'));
  });
};

const idbTx = async <T>(db: IDBDatabase, stores: string | string[], mode: IDBTransactionMode, fn: (tx: IDBTransaction) => Promise<T>): Promise<T> => {
  const tx = db.transaction(stores, mode);
  const result = await fn(tx);
  await new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error || new Error('IndexedDB 事务失败'));
    tx.onabort = () => reject(tx.error || new Error('IndexedDB 事务中止'));
  });
  return result;
};

const canUseIdb = async (): Promise<boolean> => {
  if (!isIndexedDbAvailable()) return false;
  try {
    const db = await openDb();
    db.close();
    return true;
  } catch {
    return false;
  }
};

let idbDbPromise: Promise<IDBDatabase> | null = null;

const getDb = async (): Promise<IDBDatabase> => {
  if (!idbDbPromise) idbDbPromise = openDb();
  return await idbDbPromise;
};

export const getLocalStoreBackend = async (): Promise<'indexeddb' | 'localstorage'> => {
  return (await canUseIdb()) ? 'indexeddb' : 'localstorage';
};

export const listProjects = async (): Promise<LocalProject[]> => {
  if (!(await canUseIdb())) {
    return await withLocalStorage((snap) => snap.projects.slice().sort((a, b) => b.updated_at.localeCompare(a.updated_at)));
  }
  const db = await getDb();
  return await idbTx(db, STORE_PROJECTS, 'readonly', async (tx) => {
    const store = tx.objectStore(STORE_PROJECTS);
    const rows = await idbRequest(store.getAll());
    return (rows as LocalProject[]).slice().sort((a, b) => b.updated_at.localeCompare(a.updated_at));
  });
};

export const createProject = async (name: string): Promise<LocalProject> => {
  const trimmed = name.trim();
  if (!trimmed) throw new Error('项目名称不能为空');
  const created = nowIso();
  const project: LocalProject = { id: uuid(), name: trimmed, created_at: created, updated_at: created };

  const existing = await listProjects();
  if (existing.some(p => p.name === trimmed)) throw new Error('项目名称已存在');

  if (!(await canUseIdb())) {
    const result = await withLocalStorage((snap) => {
      snap.projects.push(project);
      return project;
    });
    enqueuePush({ type: 'project', id: project.id, action: 'upsert', data: { name: project.name, created_at: project.created_at, updated_at: project.updated_at } });
    return result;
  }

  const db = await getDb();
  await idbTx(db, STORE_PROJECTS, 'readwrite', async (tx) => {
    const store = tx.objectStore(STORE_PROJECTS);
    store.add(project);
    return await Promise.resolve();
  });
  enqueuePush({ type: 'project', id: project.id, action: 'upsert', data: { name: project.name, created_at: project.created_at, updated_at: project.updated_at } });
  return project;
};

export const upsertProject = async (project: LocalProject): Promise<void> => {
  if (!(await canUseIdb())) {
    await withLocalStorage((snap) => {
      const idx = snap.projects.findIndex(p => p.id === project.id);
      if (idx >= 0) {
        snap.projects[idx] = project;
      } else {
        snap.projects.push(project);
      }
    });
    return;
  }

  const db = await getDb();
  await idbTx(db, STORE_PROJECTS, 'readwrite', async (tx) => {
    const store = tx.objectStore(STORE_PROJECTS);
    store.put(project);
    return await Promise.resolve();
  });
};

export const upsertDatasetWithPoints = async (dataset: LocalDataset, points: StoredLoadPoint[]): Promise<void> => {
  if (!(await canUseIdb())) {
    await withLocalStorage((snap) => {
      const idx = snap.datasets.findIndex(d => d.id === dataset.id);
      if (idx >= 0) {
        snap.datasets[idx] = dataset;
      } else {
        snap.datasets.push(dataset);
      }
      // Only overwrite points if non-empty (pull sends [] to preserve existing)
      if (points.length > 0) {
        const pIdx = snap.dataset_points.findIndex(dp => dp.dataset_id === dataset.id);
        const row: DatasetPointsRow = { dataset_id: dataset.id, points };
        if (pIdx >= 0) {
          snap.dataset_points[pIdx] = row;
        } else {
          snap.dataset_points.push(row);
        }
      }
      const p = snap.projects.find(x => x.id === dataset.project_id);
      if (p) p.updated_at = nowIso();
    });
    return;
  }

  const db = await getDb();
  await idbTx(db, [STORE_DATASETS, STORE_DATASET_POINTS, STORE_PROJECTS], 'readwrite', async (tx) => {
    tx.objectStore(STORE_DATASETS).put(dataset);
    // Only overwrite points if non-empty
    if (points.length > 0) {
      tx.objectStore(STORE_DATASET_POINTS).put({ dataset_id: dataset.id, points } satisfies DatasetPointsRow);
    }
    const pStore = tx.objectStore(STORE_PROJECTS);
    const p = await idbRequest(pStore.get(dataset.project_id));
    if (p) pStore.put({ ...(p as LocalProject), updated_at: nowIso() });
    return await Promise.resolve();
  });
};

export const upsertRunWithArtifacts = async (run: LocalRun, artifacts: LocalRunArtifact[]): Promise<void> => {
  if (!(await canUseIdb())) {
    await withLocalStorage(async (snap) => {
      const idx = snap.runs.findIndex(r => r.id === run.id);
      if (idx >= 0) {
        snap.runs[idx] = run;
      } else {
        snap.runs.push(run);
      }

      snap.run_artifacts = snap.run_artifacts.filter(a => a.run_id !== run.id);
      for (const a of artifacts) {
        const base64 = await blobToBase64(a.blob);
        snap.run_artifacts.push({
          artifact_id: `${run.id}:${a.kind}:${uuid()}`,
          run_id: run.id,
          kind: a.kind,
          filename: a.filename,
          mime: a.mime,
          base64,
          created_at: nowIso(),
        });
      }

      const p = snap.projects.find(x => x.id === run.project_id);
      if (p) p.updated_at = nowIso();
    });
    return;
  }

  const db = await getDb();
  await idbTx(db, [STORE_RUNS, STORE_RUN_ARTIFACTS, STORE_PROJECTS], 'readwrite', async (tx) => {
    tx.objectStore(STORE_RUNS).put(run);

    const artifactsStore = tx.objectStore(STORE_RUN_ARTIFACTS);
    const byRunId = artifactsStore.index('by_run_id');
    const existing = await idbRequest(byRunId.getAll(run.id)) as RunArtifactRow[];
    for (const row of existing) artifactsStore.delete(row.artifact_id);

    for (const a of artifacts) {
      const row: RunArtifactRow = {
        artifact_id: `${run.id}:${a.kind}:${uuid()}`,
        run_id: run.id,
        kind: a.kind,
        filename: a.filename,
        mime: a.mime,
        blob: a.blob,
        created_at: nowIso(),
      };
      artifactsStore.add(row);
    }

    const pStore = tx.objectStore(STORE_PROJECTS);
    const p = await idbRequest(pStore.get(run.project_id));
    if (p) pStore.put({ ...(p as LocalProject), updated_at: nowIso() });
    return await Promise.resolve();
  });
};

export const renameProject = async (projectId: string, newName: string): Promise<void> => {
  const trimmed = newName.trim();
  if (!trimmed) throw new Error('项目名称不能为空');
  const projects = await listProjects();
  if (projects.some(p => p.name === trimmed && p.id !== projectId)) throw new Error('项目名称已存在');

  if (!(await canUseIdb())) {
    await withLocalStorage((snap) => {
      const p = snap.projects.find(x => x.id === projectId);
      if (!p) throw new Error('项目不存在');
      p.name = trimmed;
      p.updated_at = nowIso();
    });
    enqueuePush({ type: 'project', id: projectId, action: 'upsert', data: { name: trimmed, updated_at: nowIso() } });
    return;
  }

  const db = await getDb();
  await idbTx(db, STORE_PROJECTS, 'readwrite', async (tx) => {
    const store = tx.objectStore(STORE_PROJECTS);
    const p = await idbRequest(store.get(projectId));
    if (!p) throw new Error('项目不存在');
    const updated: LocalProject = { ...(p as LocalProject), name: trimmed, updated_at: nowIso() };
    store.put(updated);
    return await Promise.resolve();
  });
  enqueuePush({ type: 'project', id: projectId, action: 'upsert', data: { name: trimmed, updated_at: nowIso() } });
};

export const deleteProject = async (projectId: string): Promise<void> => {
  if (!(await canUseIdb())) {
    await withLocalStorage((snap) => {
      snap.projects = snap.projects.filter(p => p.id !== projectId);
      const dsIds = snap.datasets.filter(d => d.project_id === projectId).map(d => d.id);
      snap.datasets = snap.datasets.filter(d => d.project_id !== projectId);
      snap.dataset_points = snap.dataset_points.filter(dp => !dsIds.includes(dp.dataset_id));
      const runIds = snap.runs.filter(r => r.project_id === projectId).map(r => r.id);
      snap.runs = snap.runs.filter(r => r.project_id !== projectId);
      snap.run_artifacts = snap.run_artifacts.filter(a => !runIds.includes(a.run_id));
    });
    enqueuePush({ type: 'project', id: projectId, action: 'delete' });
    return;
  }

  const db = await getDb();
  await idbTx(db, [STORE_PROJECTS, STORE_DATASETS, STORE_DATASET_POINTS, STORE_RUNS, STORE_RUN_ARTIFACTS], 'readwrite', async (tx) => {
    const projects = tx.objectStore(STORE_PROJECTS);
    const datasets = tx.objectStore(STORE_DATASETS);
    const points = tx.objectStore(STORE_DATASET_POINTS);
    const runs = tx.objectStore(STORE_RUNS);
    const artifacts = tx.objectStore(STORE_RUN_ARTIFACTS);

    const byProject = (datasets.index('by_project_id') as IDBIndex);
    const dsRows = await idbRequest(byProject.getAll(projectId)) as LocalDataset[];
    for (const d of dsRows) {
      datasets.delete(d.id);
      points.delete(d.id);
    }

    const byProjectRuns = runs.index('by_project_id');
    const runRows = await idbRequest(byProjectRuns.getAll(projectId)) as LocalRun[];
    const byRunId = artifacts.index('by_run_id');
    for (const r of runRows) {
      const artRows = await idbRequest(byRunId.getAll(r.id)) as RunArtifactRow[];
      for (const a of artRows) {
        artifacts.delete(a.artifact_id);
      }
      runs.delete(r.id);
    }
    projects.delete(projectId);
    return await Promise.resolve();
  });
  enqueuePush({ type: 'project', id: projectId, action: 'delete' });
};

export const listDatasets = async (projectId: string): Promise<LocalDataset[]> => {
  if (!(await canUseIdb())) {
    return await withLocalStorage((snap) => {
      return snap.datasets
        .filter(d => d.project_id === projectId)
        .slice()
        .sort((a, b) => b.updated_at.localeCompare(a.updated_at));
    });
  }
  const db = await getDb();
  return await idbTx(db, STORE_DATASETS, 'readonly', async (tx) => {
    const store = tx.objectStore(STORE_DATASETS);
    const byProject = store.index('by_project_id');
    const rows = await idbRequest(byProject.getAll(projectId));
    return (rows as LocalDataset[]).slice().sort((a, b) => b.updated_at.localeCompare(a.updated_at));
  });
};

export const renameDataset = async (datasetId: string, newName: string): Promise<void> => {
  const trimmed = newName.trim();
  if (!trimmed) throw new Error('数据集名称不能为空');

  if (!(await canUseIdb())) {
    await withLocalStorage((snap) => {
      const d = snap.datasets.find(x => x.id === datasetId);
      if (!d) throw new Error('数据集不存在');
      d.name = trimmed;
      d.updated_at = nowIso();
    });
    enqueuePush({ type: 'dataset', id: datasetId, action: 'upsert', data: { name: trimmed, updated_at: nowIso() } });
    return;
  }

  const db = await getDb();
  await idbTx(db, STORE_DATASETS, 'readwrite', async (tx) => {
    const store = tx.objectStore(STORE_DATASETS);
    const row = await idbRequest(store.get(datasetId));
    if (!row) throw new Error('数据集不存在');
    store.put({ ...(row as LocalDataset), name: trimmed, updated_at: nowIso() });
    return await Promise.resolve();
  });
  enqueuePush({ type: 'dataset', id: datasetId, action: 'upsert', data: { name: trimmed, updated_at: nowIso() } });
};

export const deleteDataset = async (datasetId: string): Promise<void> => {
  if (!(await canUseIdb())) {
    await withLocalStorage((snap) => {
      snap.datasets = snap.datasets.filter(d => d.id !== datasetId);
      snap.dataset_points = snap.dataset_points.filter(dp => dp.dataset_id !== datasetId);
    });
    enqueuePush({ type: 'dataset', id: datasetId, action: 'delete' });
    return;
  }

  const db = await getDb();
  await idbTx(db, [STORE_DATASETS, STORE_DATASET_POINTS], 'readwrite', async (tx) => {
    tx.objectStore(STORE_DATASETS).delete(datasetId);
    tx.objectStore(STORE_DATASET_POINTS).delete(datasetId);
    return await Promise.resolve();
  });
  enqueuePush({ type: 'dataset', id: datasetId, action: 'delete' });
};

export const getDatasetWithPoints = async (datasetId: string): Promise<LocalDatasetWithPoints> => {
  if (!(await canUseIdb())) {
    return await withLocalStorage((snap) => {
      const d = snap.datasets.find(x => x.id === datasetId);
      if (!d) throw new Error('数据集不存在');
      const pointsRow = snap.dataset_points.find(x => x.dataset_id === datasetId);
      return { ...(d as LocalDataset), points: (pointsRow?.points || []) as StoredLoadPoint[] };
    });
  }

  const db = await getDb();
  return await idbTx(db, [STORE_DATASETS, STORE_DATASET_POINTS], 'readonly', async (tx) => {
    const d = await idbRequest(tx.objectStore(STORE_DATASETS).get(datasetId));
    if (!d) throw new Error('数据集不存在');
    const p = await idbRequest(tx.objectStore(STORE_DATASET_POINTS).get(datasetId));
    const points = (p as DatasetPointsRow | undefined)?.points || [];
    return { ...(d as LocalDataset), points };
  });
};

const inferIntervalMinutes = (points: StoredLoadPoint[]): number | undefined => {
  if (points.length < 2) return undefined;
  const t0 = Date.parse(points[0].timestamp);
  const t1 = Date.parse(points[1].timestamp);
  if (!Number.isFinite(t0) || !Number.isFinite(t1)) return undefined;
  const mins = Math.round(Math.abs(t1 - t0) / 60000);
  return Number.isFinite(mins) && mins > 0 ? mins : undefined;
};

export const saveDatasetFromAnalysis = async (input: {
  projectId: string;
  name: string;
  sourceFilename?: string;
  points: StoredLoadPoint[];
  meta?: BackendAnalysisMeta | null;
  report?: BackendQualityReport | null;
}): Promise<{ dataset: LocalDataset; duplicated_of?: string }> => {
  const projectId = input.projectId;
  const name = input.name.trim();
  if (!projectId) throw new Error('未选择项目');
  if (!name) throw new Error('数据集名称不能为空');
  if (!Array.isArray(input.points) || input.points.length === 0) throw new Error('没有可保存的点位数据');

  const points = input.points.slice().sort((a, b) => a.timestamp.localeCompare(b.timestamp));
  const fingerprint = await computeFingerprint(points);
  const start = points[0]?.timestamp;
  const end = points[points.length - 1]?.timestamp;

  const intervalMinutes = inferIntervalMinutes(points);
  const created = nowIso();
  const dataset: LocalDataset = {
    id: uuid(),
    project_id: projectId,
    name,
    source_filename: input.sourceFilename,
    fingerprint,
    start_time: start,
    end_time: end,
    interval_minutes: intervalMinutes,
    points_count: points.length,
    meta_json: input.meta ?? null,
    quality_report_json: input.report ?? null,
    created_at: created,
    updated_at: created,
  };

  const existing = await listDatasets(projectId);
  const duplicated = existing.find(d => d.fingerprint && d.fingerprint === fingerprint);
  if (duplicated) {
    return { dataset: duplicated, duplicated_of: duplicated.id };
  }

  if (!(await canUseIdb())) {
    const result = await withLocalStorage((snap) => {
      snap.datasets.push(dataset);
      snap.dataset_points.push({ dataset_id: dataset.id, points });
      const p = snap.projects.find(x => x.id === projectId);
      if (p) p.updated_at = nowIso();
      return { dataset };
    });
    enqueuePush({ type: 'dataset', id: dataset.id, action: 'upsert', data: {
      project_id: dataset.project_id, name: dataset.name, source_filename: dataset.source_filename,
      fingerprint: dataset.fingerprint, start_time: dataset.start_time, end_time: dataset.end_time,
      interval_minutes: dataset.interval_minutes, points_count: dataset.points_count,
      meta_json: dataset.meta_json, quality_report_json: dataset.quality_report_json,
      created_at: dataset.created_at, updated_at: dataset.updated_at,
    } });
    return result;
  }

  const db = await getDb();
  await idbTx(db, [STORE_DATASETS, STORE_DATASET_POINTS, STORE_PROJECTS], 'readwrite', async (tx) => {
    tx.objectStore(STORE_DATASETS).add(dataset);
    tx.objectStore(STORE_DATASET_POINTS).add({ dataset_id: dataset.id, points } satisfies DatasetPointsRow);
    const pStore = tx.objectStore(STORE_PROJECTS);
    const p = await idbRequest(pStore.get(projectId));
    if (p) pStore.put({ ...(p as LocalProject), updated_at: nowIso() });
    return await Promise.resolve();
  });

  enqueuePush({ type: 'dataset', id: dataset.id, action: 'upsert', data: {
    project_id: dataset.project_id, name: dataset.name, source_filename: dataset.source_filename,
    fingerprint: dataset.fingerprint, start_time: dataset.start_time, end_time: dataset.end_time,
    interval_minutes: dataset.interval_minutes, points_count: dataset.points_count,
    meta_json: dataset.meta_json, quality_report_json: dataset.quality_report_json,
    created_at: dataset.created_at, updated_at: dataset.updated_at,
  } });
  return { dataset };
};

export type LocalRunArtifact = {
  kind: string;
  filename: string;
  mime: string;
  blob: Blob;
};

export type LocalRun = {
  id: string;
  project_id: string;
  name: string;
  created_at: string;
  updated_at: string;
  dataset_id?: string;
  embedded_points?: StoredLoadPoint[];
  quality_snapshot?: {
    meta: BackendAnalysisMeta | null;
    report: BackendQualityReport | null;
  };
  config_snapshot: any;
  cycles_snapshot: any;
  economics_snapshot?: any;
  profit_snapshot?: any;
};

export type LocalRunWithArtifacts = LocalRun & { artifacts: LocalRunArtifact[] };

const blobToBase64 = (blob: Blob): Promise<string> => {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('读取 Blob 失败'));
    reader.onload = () => {
      const result = String(reader.result || '');
      // result is data:<mime>;base64,<...>
      const idx = result.indexOf('base64,');
      resolve(idx >= 0 ? result.slice(idx + 7) : '');
    };
    reader.readAsDataURL(blob);
  });
};

const base64ToBlob = (base64: string, mime: string): Blob => {
  const bytes = Uint8Array.from(atob(base64), c => c.charCodeAt(0));
  return new Blob([bytes], { type: mime || 'application/octet-stream' });
};

export const listRuns = async (projectId: string): Promise<LocalRun[]> => {
  if (!(await canUseIdb())) {
    return await withLocalStorage((snap) => {
      return snap.runs
        .filter(r => r.project_id === projectId)
        .slice()
        .sort((a, b) => b.updated_at.localeCompare(a.updated_at));
    });
  }
  const db = await getDb();
  return await idbTx(db, STORE_RUNS, 'readonly', async (tx) => {
    const store = tx.objectStore(STORE_RUNS);
    const byProject = store.index('by_project_id');
    const rows = await idbRequest(byProject.getAll(projectId));
    return (rows as LocalRun[]).slice().sort((a, b) => b.updated_at.localeCompare(a.updated_at));
  });
};

export const getRunWithArtifacts = async (runId: string): Promise<LocalRunWithArtifacts> => {
  if (!(await canUseIdb())) {
    return await withLocalStorage((snap) => {
      const r = snap.runs.find(x => x.id === runId);
      if (!r) throw new Error('快照不存在');
      const arts = snap.run_artifacts
        .filter(a => a.run_id === runId)
        .map((a) => ({
          kind: a.kind,
          filename: a.filename,
          mime: a.mime,
          blob: base64ToBlob(a.base64, a.mime),
        }));
      return { ...(r as LocalRun), artifacts: arts };
    });
  }

  const db = await getDb();
  return await idbTx(db, [STORE_RUNS, STORE_RUN_ARTIFACTS], 'readonly', async (tx) => {
    const r = await idbRequest(tx.objectStore(STORE_RUNS).get(runId));
    if (!r) throw new Error('快照不存在');
    const byRunId = tx.objectStore(STORE_RUN_ARTIFACTS).index('by_run_id');
    const rows = await idbRequest(byRunId.getAll(runId)) as RunArtifactRow[];
    const arts: LocalRunArtifact[] = rows.map((row) => ({
      kind: row.kind,
      filename: row.filename,
      mime: row.mime,
      blob: row.blob,
    }));
    return { ...(r as LocalRun), artifacts: arts };
  });
};

export const deleteRun = async (runId: string): Promise<void> => {
  if (!(await canUseIdb())) {
    await withLocalStorage((snap) => {
      snap.runs = snap.runs.filter(r => r.id !== runId);
      snap.run_artifacts = snap.run_artifacts.filter(a => a.run_id !== runId);
    });
    enqueuePush({ type: 'run', id: runId, action: 'delete' });
    return;
  }
  const db = await getDb();
  await idbTx(db, [STORE_RUNS, STORE_RUN_ARTIFACTS], 'readwrite', async (tx) => {
    const runs = tx.objectStore(STORE_RUNS);
    const artifacts = tx.objectStore(STORE_RUN_ARTIFACTS);
    const byRunId = artifacts.index('by_run_id');
    const rows = await idbRequest(byRunId.getAll(runId)) as RunArtifactRow[];
    for (const a of rows) artifacts.delete(a.artifact_id);
    runs.delete(runId);
    return await Promise.resolve();
  });
  enqueuePush({ type: 'run', id: runId, action: 'delete' });
};

export const addRunArtifacts = async (
  runId: string,
  artifacts: Array<{ kind: string; filename: string; mime: string; blob: Blob }>,
): Promise<void> => {
  if (!runId) throw new Error('缺少 runId');
  const list = Array.isArray(artifacts) ? artifacts : [];
  if (list.length === 0) return;

  const updatedAt = nowIso();

  if (!(await canUseIdb())) {
    await withLocalStorage(async (snap) => {
      const r = snap.runs.find(x => x.id === runId);
      if (!r) throw new Error('快照不存在');
      r.updated_at = updatedAt;
      for (const a of list) {
        const base64 = await blobToBase64(a.blob);
        snap.run_artifacts.push({
          artifact_id: `${runId}:${a.kind}:${uuid()}`,
          run_id: runId,
          kind: a.kind,
          filename: a.filename,
          mime: a.mime,
          base64,
          created_at: updatedAt,
        });
      }
    });
    enqueuePush({ type: 'run', id: runId, action: 'upsert', data: { updated_at: updatedAt } });
    return;
  }

  const db = await getDb();
  await idbTx(db, [STORE_RUNS, STORE_RUN_ARTIFACTS], 'readwrite', async (tx) => {
    const runs = tx.objectStore(STORE_RUNS);
    const artifactsStore = tx.objectStore(STORE_RUN_ARTIFACTS);
    const r = await idbRequest(runs.get(runId));
    if (!r) throw new Error('快照不存在');
    runs.put({ ...(r as LocalRun), updated_at: updatedAt });

    for (const a of list) {
      const row: RunArtifactRow = {
        artifact_id: `${runId}:${a.kind}:${uuid()}`,
        run_id: runId,
        kind: a.kind,
        filename: a.filename,
        mime: a.mime,
        blob: a.blob,
        created_at: updatedAt,
      };
      artifactsStore.add(row);
    }
    return await Promise.resolve();
  });
  enqueuePush({ type: 'run', id: runId, action: 'upsert', data: { updated_at: updatedAt } });
};

export const saveRunSnapshot = async (input: {
  projectId: string;
  name: string;
  datasetId?: string;
  embeddedPoints?: StoredLoadPoint[];
  qualitySnapshot?: { meta: BackendAnalysisMeta | null; report: BackendQualityReport | null };
  configSnapshot: any;
  cyclesSnapshot: any;
  economicsSnapshot?: any;
  profitSnapshot?: any;
  artifacts?: Array<{ kind: string; filename: string; mime: string; blob: Blob }>;
}): Promise<LocalRun> => {
  const projectId = input.projectId;
  const name = input.name.trim();
  if (!projectId) throw new Error('未选择项目');
  if (!name) throw new Error('快照名称不能为空');
  if (!input.datasetId && (!input.embeddedPoints || input.embeddedPoints.length === 0)) {
    throw new Error('缺少负荷数据引用：请先保存/选择数据集，或提供点位兜底');
  }
  if (!input.cyclesSnapshot) throw new Error('缺少 cycles 结果，无法保存快照');

  const created = nowIso();
  const run: LocalRun = {
    id: uuid(),
    project_id: projectId,
    name,
    created_at: created,
    updated_at: created,
    dataset_id: input.datasetId,
    embedded_points: input.embeddedPoints,
    quality_snapshot: input.qualitySnapshot ?? { meta: null, report: null },
    config_snapshot: input.configSnapshot,
    cycles_snapshot: input.cyclesSnapshot,
    economics_snapshot: input.economicsSnapshot,
    profit_snapshot: input.profitSnapshot,
  };

  const artifacts = Array.isArray(input.artifacts) ? input.artifacts : [];

  if (!(await canUseIdb())) {
    const result = await withLocalStorage(async (snap) => {
      snap.runs.push(run);
      for (const a of artifacts) {
        const base64 = await blobToBase64(a.blob);
        snap.run_artifacts.push({
          artifact_id: `${run.id}:${a.kind}:${uuid()}`,
          run_id: run.id,
          kind: a.kind,
          filename: a.filename,
          mime: a.mime,
          base64,
          created_at: nowIso(),
        });
      }
      const p = snap.projects.find(x => x.id === projectId);
      if (p) p.updated_at = nowIso();
      return run;
    });
    enqueuePush({ type: 'run', id: run.id, action: 'upsert', data: {
      project_id: run.project_id, name: run.name, dataset_id: run.dataset_id,
      config_snapshot: run.config_snapshot, cycles_snapshot: run.cycles_snapshot,
      economics_snapshot: run.economics_snapshot, profit_snapshot: run.profit_snapshot,
      quality_snapshot: run.quality_snapshot,
      created_at: run.created_at, updated_at: run.updated_at,
    } });
    return result;
  }

  const db = await getDb();
  await idbTx(db, [STORE_RUNS, STORE_RUN_ARTIFACTS, STORE_PROJECTS], 'readwrite', async (tx) => {
    tx.objectStore(STORE_RUNS).add(run);
    const artStore = tx.objectStore(STORE_RUN_ARTIFACTS);
    for (const a of artifacts) {
      const row: RunArtifactRow = {
        artifact_id: `${run.id}:${a.kind}:${uuid()}`,
        run_id: run.id,
        kind: a.kind,
        filename: a.filename,
        mime: a.mime,
        blob: a.blob,
        created_at: nowIso(),
      };
      artStore.add(row);
    }
    const pStore = tx.objectStore(STORE_PROJECTS);
    const p = await idbRequest(pStore.get(projectId));
    if (p) pStore.put({ ...(p as LocalProject), updated_at: nowIso() });
    return await Promise.resolve();
  });

  enqueuePush({ type: 'run', id: run.id, action: 'upsert', data: {
    project_id: run.project_id, name: run.name, dataset_id: run.dataset_id,
    config_snapshot: run.config_snapshot, cycles_snapshot: run.cycles_snapshot,
    economics_snapshot: run.economics_snapshot, profit_snapshot: run.profit_snapshot,
    quality_snapshot: run.quality_snapshot,
    created_at: run.created_at, updated_at: run.updated_at,
  } });
  return run;
};

export const exportProjectToJson = async (projectId: string): Promise<string> => {
  const projects = await listProjects();
  const project = projects.find(p => p.id === projectId);
  if (!project) throw new Error('项目不存在');
  const datasets = await listDatasets(projectId);
  const datasetsWithPoints: LocalDatasetWithPoints[] = [];
  for (const d of datasets) {
    const full = await getDatasetWithPoints(d.id);
    datasetsWithPoints.push(full);
  }
  const runs = await listRuns(projectId);
  const runsWithArtifacts: Array<LocalRun & { artifacts: Array<Omit<RunArtifactRow, 'blob'> & { base64: string }> }> = [];
  for (const r of runs) {
    const full = await getRunWithArtifacts(r.id);
    const artifacts: Array<Omit<RunArtifactRow, 'blob'> & { base64: string }> = [];
    for (const a of full.artifacts) {
      artifacts.push({
        artifact_id: `${r.id}:${a.kind}:${uuid()}`,
        run_id: r.id,
        kind: a.kind,
        filename: a.filename,
        mime: a.mime,
        base64: await blobToBase64(a.blob),
        created_at: nowIso(),
      });
    }
    runsWithArtifacts.push({ ...(r as LocalRun), artifacts });
  }
  return JSON.stringify(
    {
      version: 2,
      exported_at: nowIso(),
      project,
      datasets: datasetsWithPoints,
      runs: runsWithArtifacts,
    },
    null,
    2,
  );
};

export const exportAllProjectsToJson = async (): Promise<string> => {
  const projects = await listProjects();
  const bundles: any[] = [];
  for (const p of projects) {
    const json = await exportProjectToJson(p.id);
    try {
      bundles.push(JSON.parse(json));
    } catch {
      // ignore broken single export
    }
  }
  return JSON.stringify(
    {
      version: 2,
      exported_at: nowIso(),
      kind: "all-projects",
      projects: bundles.map(b => b.project).filter(Boolean),
      datasets: bundles.flatMap(b => Array.isArray(b.datasets) ? b.datasets : []),
      runs: bundles.flatMap(b => Array.isArray(b.runs) ? b.runs : []),
    },
    null,
    2,
  );
};

export const importAllProjectsFromJson = async (jsonText: string): Promise<void> => {
  const parsed = JSON.parse(jsonText);
  const projects = Array.isArray(parsed?.projects) ? parsed.projects : [];
  const datasets = Array.isArray(parsed?.datasets) ? parsed.datasets : [];
  const runs = Array.isArray(parsed?.runs) ? parsed.runs : [];

  for (const p of projects) {
    const id = String(p?.id ?? '').trim();
    const name = String(p?.name ?? '').trim();
    if (!id || !name) continue;
    const created_at = String(p?.created_at ?? nowIso());
    const updated_at = String(p?.updated_at ?? created_at);
    await upsertProject({ id, name, created_at, updated_at });
  }

  for (const d of datasets) {
    const id = String(d?.id ?? '').trim();
    const project_id = String(d?.project_id ?? '').trim();
    const name = String(d?.name ?? '').trim();
    if (!id || !project_id || !name) continue;
    const points = Array.isArray(d?.points) ? d.points : [];
    const normalizedPoints: StoredLoadPoint[] = points
      .map((p: any) => ({ timestamp: String(p?.timestamp ?? ''), load_kwh: Number(p?.load_kwh ?? 0) }))
      .filter((p: StoredLoadPoint) => !!p.timestamp);
    const dataset: LocalDataset = {
      id,
      project_id,
      name,
      source_filename: d?.source_filename ? String(d.source_filename) : undefined,
      fingerprint: d?.fingerprint ? String(d.fingerprint) : undefined,
      start_time: d?.start_time ? String(d.start_time) : undefined,
      end_time: d?.end_time ? String(d.end_time) : undefined,
      interval_minutes: d?.interval_minutes != null ? Number(d.interval_minutes) : undefined,
      points_count: Number(d?.points_count ?? normalizedPoints.length ?? 0),
      meta_json: d?.meta_json ?? null,
      quality_report_json: d?.quality_report_json ?? null,
      created_at: String(d?.created_at ?? nowIso()),
      updated_at: String(d?.updated_at ?? nowIso()),
    };
    await upsertDatasetWithPoints(dataset, normalizedPoints);
  }

  for (const r of runs) {
    const id = String(r?.id ?? '').trim();
    const project_id = String(r?.project_id ?? '').trim();
    const name = String(r?.name ?? '').trim();
    if (!id || !project_id || !name) continue;
    const run: LocalRun = {
      id,
      project_id,
      name,
      created_at: String(r?.created_at ?? nowIso()),
      updated_at: String(r?.updated_at ?? nowIso()),
      dataset_id: r?.dataset_id ? String(r.dataset_id) : undefined,
      embedded_points: Array.isArray(r?.embedded_points) ? r.embedded_points : undefined,
      quality_snapshot: r?.quality_snapshot ? r.quality_snapshot : undefined,
      config_snapshot: r?.config_snapshot,
      cycles_snapshot: r?.cycles_snapshot,
      economics_snapshot: r?.economics_snapshot,
      profit_snapshot: r?.profit_snapshot,
    };
    const artifacts = Array.isArray(r?.artifacts) ? r.artifacts : [];
    const decoded: LocalRunArtifact[] = artifacts
      .map((a: any) => {
        const kind = String(a?.kind ?? '').trim();
        const filename = String(a?.filename ?? 'artifact').trim() || 'artifact';
        const mime = String(a?.mime ?? 'application/octet-stream');
        const base64 = String(a?.base64 ?? '');
        if (!kind || !base64) return null;
        return { kind, filename, mime, blob: base64ToBlob(base64, mime) } as LocalRunArtifact;
      })
      .filter((x: any): x is LocalRunArtifact => x !== null);
    await upsertRunWithArtifacts(run, decoded);
  }
};

export const importProjectFromJson = async (jsonText: string): Promise<LocalProject> => {
  const parsed = JSON.parse(jsonText);
  const projectName = String(parsed?.project?.name ?? '').trim();
  if (!projectName) throw new Error('导入文件缺少项目名称');
  const newProject = await createProject(projectName);
  const datasets = Array.isArray(parsed?.datasets) ? parsed.datasets : [];
  for (const item of datasets) {
    const name = String(item?.name ?? '').trim();
    const points = Array.isArray(item?.points) ? item.points : [];
    if (!name || points.length === 0) continue;
    await saveDatasetFromAnalysis({
      projectId: newProject.id,
      name,
      sourceFilename: item?.source_filename ? String(item.source_filename) : undefined,
      points: points.map((p: any) => ({
        timestamp: String(p?.timestamp ?? ''),
        load_kwh: Number(p?.load_kwh ?? 0),
      })).filter((p: StoredLoadPoint) => !!p.timestamp),
      meta: item?.meta_json ?? null,
      report: item?.quality_report_json ?? null,
    });
  }
  const runs = Array.isArray(parsed?.runs) ? parsed.runs : [];
  for (const r of runs) {
    const name = String(r?.name ?? '').trim();
    if (!name) continue;
    const arts = Array.isArray(r?.artifacts) ? r.artifacts : [];
    const artifacts: LocalRunArtifact[] = [];
    for (const a of arts) {
      const kind = String(a?.kind ?? '').trim();
      const filename = String(a?.filename ?? 'artifact').trim() || 'artifact';
      const mime = String(a?.mime ?? 'application/octet-stream');
      const base64 = String(a?.base64 ?? '');
      if (!kind || !base64) continue;
      artifacts.push({ kind, filename, mime, blob: base64ToBlob(base64, mime) });
    }
    await saveRunSnapshot({
      projectId: newProject.id,
      name,
      datasetId: r?.dataset_id ? String(r.dataset_id) : undefined,
      embeddedPoints: Array.isArray(r?.embedded_points) ? r.embedded_points : undefined,
      qualitySnapshot: r?.quality_snapshot ? r.quality_snapshot : undefined,
      configSnapshot: r?.config_snapshot,
      cyclesSnapshot: r?.cycles_snapshot,
      economicsSnapshot: r?.economics_snapshot,
      profitSnapshot: r?.profit_snapshot,
      artifacts: artifacts.map(a => ({ kind: a.kind, filename: a.filename, mime: a.mime, blob: a.blob })),
    });
  }
  return newProject;
};
