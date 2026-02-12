import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  BackendAnalysisMeta,
  BackendQualityReport,
  BackendStorageCyclesResponse,
  BackendStorageCurvesResponse,
  StorageEconomicsInput,
  StorageEconomicsResult,
  Schedule,
  DateRule,
  MonthlyTouPrices,
} from '../types';
import type { LoadDataPoint } from '../utils';
import {
  createProject,
  deleteRun,
  deleteDataset,
  deleteProject,
  exportProjectToJson,
  exportAllProjectsToJson,
  getLocalStoreBackend,
  getDatasetWithPoints,
  getRunWithArtifacts,
  importProjectFromJson,
  importAllProjectsFromJson,
  listDatasets,
  listProjects,
  listRuns,
  renameDataset,
  renameProject,
  saveDatasetFromAnalysis,
  saveRunSnapshot,
  type LocalDataset,
  type LocalProject,
  type LocalRun,
  type LocalRunWithArtifacts,
  type StoredLoadPoint,
} from '../localProjectStore';
import type { StorageParamsPayload } from '../storageApi';
import {
  exportEconomicsCashflowReport,
  exportStorageBusinessReport,
  exportStorageCyclesReport,
  BASE_URL as BACKEND_BASE_URL,
} from '../storageApi';
import { ensureBackendSupports } from '../backendCapabilities';

type Props = {
  currentLoad: {
    points: LoadDataPoint[];
    meta: BackendAnalysisMeta | null;
    report: BackendQualityReport | null;
    sourceFilename?: string | null;
  };
  currentDatasetId?: string | null;
  scheduleSnapshot: {
    monthlySchedule: Schedule;
    dateRules: DateRule[];
    prices: MonthlyTouPrices;
  };
  lastCyclesRun: { payload: StorageParamsPayload; response: BackendStorageCyclesResponse } | null;
  lastProfitRun: {
    payload: StorageParamsPayload | null;
    cyclesResult: BackendStorageCyclesResponse | null;
    curvesData: BackendStorageCurvesResponse | null;
    selectedDate: string | null;
  } | null;
  lastEconomicsRun: { input: StorageEconomicsInput; result: StorageEconomicsResult; userSharePercent: number } | null;
  onLoadToGlobal: (next: {
    points: LoadDataPoint[];
    meta: BackendAnalysisMeta | null;
    report: BackendQualityReport | null;
    sourceLabel: string;
    datasetId?: string | null;
  }) => void;
  onRestoreConfig: (next: Props['scheduleSnapshot']) => void;
  onRestoreRunPages: (snap: {
    cyclesRun: { payload: StorageParamsPayload; response: BackendStorageCyclesResponse } | null;
    profitRun: {
      payload: StorageParamsPayload | null;
      cyclesResult: BackendStorageCyclesResponse | null;
      curvesData: BackendStorageCurvesResponse | null;
      selectedDate: string | null;
    } | null;
    economicsRun: { input: StorageEconomicsInput; result: StorageEconomicsResult; userSharePercent: number } | null;
  }) => void;
};

const downloadTextFile = (filename: string, content: string, mime = 'application/json;charset=utf-8') => {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
};

const downloadBlobFile = (filename: string, blob: Blob) => {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
};

const normalizeOutputsPath = (rawPath: string): string => {
  const trimmed = String(rawPath || '').trim();
  if (!trimmed) return '/outputs/';
  if (/^https?:\/\//i.test(trimmed)) return trimmed;

  const normalized = trimmed.replace(/\\/g, '/');
  // 如果返回的是本地文件路径，截取 outputs/ 之后的部分
  const idx = normalized.toLowerCase().indexOf('outputs/');
  const fromOutputs = idx >= 0 ? normalized.slice(idx) : normalized.replace(/^\/+/, '');

  if (fromOutputs.startsWith('/outputs/')) return fromOutputs;
  if (fromOutputs.startsWith('outputs/')) return `/${fromOutputs}`;
  // economics/export 会返回仅文件名或相对路径：前端需要补 /outputs/
  return `/outputs/${fromOutputs}`;
};

const buildBackendFileUrl = (excelPath: string): string => {
  const base = (BACKEND_BASE_URL || '').replace(/\/$/, '');
  const normalized = normalizeOutputsPath(excelPath);
  if (/^https?:\/\//i.test(normalized)) return normalized;
  return `${base}${normalized}`;
};

const fetchBackendBlob = async (excelPath: string): Promise<Blob> => {
  const url = buildBackendFileUrl(excelPath);
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`下载失败：${resp.status} ${resp.statusText}`);
  return await resp.blob();
};

const toStoredPoints = (points: LoadDataPoint[]): StoredLoadPoint[] => {
  return points
    .slice()
    .sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime())
    .map((p) => ({ timestamp: p.timestamp.toISOString(), load_kwh: Number(p.load) || 0 }));
};

const toLoadDataPoints = (stored: StoredLoadPoint[]): LoadDataPoint[] => {
  return stored
    .map((p) => {
      const t = new Date(p.timestamp);
      if (Number.isNaN(t.getTime())) return null;
      const loadVal = Number(p.load_kwh);
      return { timestamp: t, load: Number.isFinite(loadVal) ? loadVal : 0 } as LoadDataPoint;
    })
    .filter((x): x is LoadDataPoint => x !== null)
    .sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());
};

export const ProjectDatasetsPage: React.FC<Props> = ({
  currentLoad,
  currentDatasetId,
  scheduleSnapshot,
  lastCyclesRun,
  lastProfitRun,
  lastEconomicsRun,
  onLoadToGlobal,
  onRestoreConfig,
  onRestoreRunPages,
}) => {
  const [backend, setBackend] = useState<'indexeddb' | 'localstorage'>('indexeddb');
  const [projects, setProjects] = useState<LocalProject[]>([]);
  const [selectedProjectId, setSelectedProjectId] = useState<string>('');
  const [datasets, setDatasets] = useState<LocalDataset[]>([]);
  const [runs, setRuns] = useState<LocalRun[]>([]);
  const [loading, setLoading] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [newProjectName, setNewProjectName] = useState('');
  const [newDatasetName, setNewDatasetName] = useState('');
  const [newRunName, setNewRunName] = useState('');
  const [runDetail, setRunDetail] = useState<LocalRunWithArtifacts | null>(null);
  const [showRunDetail, setShowRunDetail] = useState(false);
  const [localSyncEnabled, setLocalSyncEnabled] = useState(false);
  const [localSyncStatus, setLocalSyncStatus] = useState<string>('');
  const [localSyncBaseUrl, setLocalSyncBaseUrl] = useState<string>('');
  const [localSyncPausedReason, setLocalSyncPausedReason] = useState<string>('');

  const importInputRef = useRef<HTMLInputElement>(null);
  const syncTimerRef = useRef<number | null>(null);

  const refreshProjects = useCallback(async () => {
    const list = await listProjects();
    setProjects(list);
    if (!selectedProjectId && list.length > 0) {
      setSelectedProjectId(list[0].id);
    }
  }, [selectedProjectId]);

  const refreshDatasets = useCallback(async (projectId: string) => {
    if (!projectId) {
      setDatasets([]);
      return;
    }
    const list = await listDatasets(projectId);
    setDatasets(list);
  }, []);

  const refreshRuns = useCallback(async (projectId: string) => {
    if (!projectId) {
      setRuns([]);
      return;
    }
    const list = await listRuns(projectId);
    setRuns(list);
  }, []);

  useEffect(() => {
    (async () => {
      try {
        const b = await getLocalStoreBackend();
        setBackend(b);
        await refreshProjects();
      } catch (e) {
        console.error(e);
        setError(e instanceof Error ? e.message : String(e));
      }
    })();
  }, [refreshProjects]);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const raw = window.localStorage.getItem('localSyncEnabled');
    setLocalSyncEnabled(raw === 'true');
  }, []);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    // 允许用户将“同步地址”清空：表示使用当前页面的同源 /api 代理（例如 Vite proxy）。
    // 注意：localStorage.getItem 返回 null 才代表“未设置”；空字符串代表“用户明确选择留空”。
    const rawItem = window.localStorage.getItem('localSyncBaseUrl');
    const fromLs = rawItem === null ? '' : String(rawItem).trim();
    const fromEnv = String((import.meta as any).env?.VITE_LOCAL_SYNC_BASE_URL || '').trim();
    // 默认优先同源代理模式：避免“前端配置端口”和“实际 FastAPI 端口”不一致时出现 404
    // 如需指定端口/地址，可填写输入框或通过 VITE_LOCAL_SYNC_BASE_URL 配置。
    setLocalSyncBaseUrl(rawItem === null ? (fromEnv || '') : fromLs);
  }, []);

  const getLocalSyncBaseUrl = useCallback(() => {
    // localSyncBaseUrl === ''：用户明确选择“同源代理模式”，返回空字符串让 fetch 走相对路径 /api/...
    if (localSyncBaseUrl === '') return '';
    const raw = (localSyncBaseUrl || BACKEND_BASE_URL || '').trim();
    return raw ? raw.replace(/\/$/, '') : '';
  }, [localSyncBaseUrl]);

  const pullFromLocalSync = useCallback(async (): Promise<boolean> => {
    try {
      await ensureBackendSupports('项目数据本地同步拉取', ['/api/local-sync/snapshot']);

      setLocalSyncStatus('正在拉取…');
      const resp = await fetch(`${getLocalSyncBaseUrl()}/api/local-sync/snapshot`);
      if (resp.status === 404) {
        const text = await resp.text().catch(() => '');
        setLocalSyncPausedReason(text || 'Not Found（后端未提供 /api/local-sync/snapshot）');
        throw new Error(text || 'Not Found（后端未提供 /api/local-sync/snapshot）');
      }
      if (!resp.ok) throw new Error(`${resp.status} ${resp.statusText}`);
      const data = await resp.json();
      const snap = data?.snapshot;
      if (!data?.exists || !snap) {
        setLocalSyncStatus('云端无快照（本机）');
        return true;
      }
      await importAllProjectsFromJson(JSON.stringify(snap));
      await refreshProjects();
      if (selectedProjectId) {
        await refreshDatasets(selectedProjectId);
        await refreshRuns(selectedProjectId);
      }
      setLocalSyncStatus('已从本机同步源拉取');
      return true;
    } catch (e) {
      const baseLabel = getLocalSyncBaseUrl() || '同源（/api 代理）';
      const msg = e instanceof Error ? e.message : String(e);
      if (localSyncPausedReason || msg.includes('/api/local-sync/snapshot')) {
        setLocalSyncStatus(`已暂停自动同步：${msg}（同步地址：${baseLabel}；请重启后端后手动点击“立即拉取/推送”恢复）`);
      } else {
        setLocalSyncStatus(
          `拉取失败：${msg}（同步地址：${baseLabel}；请确认后端已更新并重启，且该地址指向运行 FastAPI 的端口）`,
        );
      }
      return false;
    }
  }, [
    getLocalSyncBaseUrl,
    localSyncPausedReason,
    refreshDatasets,
    refreshProjects,
    refreshRuns,
    selectedProjectId,
  ]);

  const pushToLocalSync = useCallback(async (): Promise<boolean> => {
    try {
      await ensureBackendSupports('项目数据本地同步推送', ['/api/local-sync/snapshot']);

      setLocalSyncStatus('正在推送…');
      const json = await exportAllProjectsToJson();
      const snapshot = JSON.parse(json);
      const resp = await fetch(`${getLocalSyncBaseUrl()}/api/local-sync/snapshot`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ snapshot }),
      });
      if (resp.status === 404) {
        const text = await resp.text().catch(() => '');
        setLocalSyncPausedReason(text || 'Not Found（后端未提供 /api/local-sync/snapshot）');
        throw new Error(text || 'Not Found（后端未提供 /api/local-sync/snapshot）');
      }
      if (resp.status === 409) {
        // 冲突：以远端为准，先拉取
        const ok = await pullFromLocalSync();
        if (ok) setLocalSyncStatus('检测到冲突，已回退为拉取远端');
        return ok;
      }
      if (!resp.ok) {
        const text = await resp.text().catch(() => '');
        throw new Error(text || `${resp.status} ${resp.statusText}`);
      }
      setLocalSyncStatus('已推送到本机同步源');
      return true;
    } catch (e) {
      const baseLabel = getLocalSyncBaseUrl() || '同源（/api 代理）';
      const msg = e instanceof Error ? e.message : String(e);
      if (localSyncPausedReason || msg.includes('/api/local-sync/snapshot')) {
        setLocalSyncStatus(`已暂停自动同步：${msg}（同步地址：${baseLabel}；请重启后端后手动点击“立即拉取/推送”恢复）`);
      } else {
        setLocalSyncStatus(
          `推送失败：${msg}（同步地址：${baseLabel}；请确认后端已更新并重启，且该地址指向运行 FastAPI 的端口）`,
        );
      }
      return false;
    }
  }, [getLocalSyncBaseUrl, localSyncPausedReason, pullFromLocalSync]);

  const schedulePush = useCallback(() => {
    if (!localSyncEnabled) return;
    if (localSyncPausedReason) return;
    if (syncTimerRef.current) window.clearTimeout(syncTimerRef.current);
    syncTimerRef.current = window.setTimeout(() => {
      pushToLocalSync();
    }, 500);
  }, [localSyncEnabled, localSyncPausedReason, pushToLocalSync]);

  useEffect(() => {
    if (!localSyncEnabled) return;
    if (localSyncPausedReason) return;
    (async () => {
      const ok = await pullFromLocalSync();
      if (!ok) return;
      await pushToLocalSync();
    })();
  }, [localSyncEnabled, localSyncPausedReason, pullFromLocalSync, pushToLocalSync]);

  useEffect(() => {
    (async () => {
      try {
        await refreshDatasets(selectedProjectId);
        await refreshRuns(selectedProjectId);
      } catch (e) {
        console.error(e);
        setError(e instanceof Error ? e.message : String(e));
      }
    })();
  }, [selectedProjectId, refreshDatasets, refreshRuns]);

  const selectedProject = useMemo(
    () => projects.find(p => p.id === selectedProjectId) || null,
    [projects, selectedProjectId],
  );

  const currentLoadStats = useMemo(() => {
    const pts = currentLoad.points || [];
    if (!pts.length) return null;
    const sorted = pts.slice().sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());
    return {
      count: sorted.length,
      start: sorted[0].timestamp,
      end: sorted[sorted.length - 1].timestamp,
    };
  }, [currentLoad.points]);

  const snapshotReadiness = useMemo(() => {
    const hasCycles = !!lastCyclesRun?.response;
    const hasProfit = !!lastProfitRun?.cyclesResult;
    const hasEconomics = !!lastEconomicsRun?.result;
    const hasDataset = !!(currentDatasetId && String(currentDatasetId).trim());
    const hasLoadPoints = !!(currentLoad.points && currentLoad.points.length > 0);
    return {
      hasCycles,
      hasProfit,
      hasEconomics,
      hasDataset,
      hasLoadPoints,
    };
  }, [lastCyclesRun, lastProfitRun, lastEconomicsRun, currentDatasetId, currentLoad.points]);

  const handleCreateProject = useCallback(async () => {
    setError(null);
    setNotice(null);
    setLoading(true);
    try {
      const p = await createProject(newProjectName);
      setNewProjectName('');
      await refreshProjects();
      setSelectedProjectId(p.id);
      setNotice('项目创建成功');
      schedulePush();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [newProjectName, refreshProjects]);

  const handleRenameProject = useCallback(async () => {
    if (!selectedProject) return;
    const next = window.prompt('请输入新的项目名称', selectedProject.name);
    if (!next) return;
    setError(null);
    setNotice(null);
    setLoading(true);
    try {
      await renameProject(selectedProject.id, next);
      await refreshProjects();
      setNotice('项目已重命名');
      schedulePush();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [selectedProject, refreshProjects]);

  const handleDeleteProject = useCallback(async () => {
    if (!selectedProject) return;
    if (!window.confirm(`确认删除项目“${selectedProject.name}”及其全部数据集？此操作不可恢复。`)) return;
    setError(null);
    setNotice(null);
    setLoading(true);
    try {
      await deleteProject(selectedProject.id);
      setSelectedProjectId('');
      await refreshProjects();
      setNotice('项目已删除');
      schedulePush();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [selectedProject, refreshProjects]);

  const handleSaveCurrentLoad = useCallback(async () => {
    if (!selectedProjectId) {
      setError('请先选择项目');
      return;
    }
    if (!currentLoad.points || currentLoad.points.length === 0) {
      setError('当前没有可保存的负荷数据，请先上传或加载数据集');
      return;
    }
    const datasetName = newDatasetName.trim();
    if (!datasetName) {
      setError('请输入数据集名称');
      return;
    }

    setError(null);
    setNotice(null);
    setLoading(true);
    try {
      const storedPoints = toStoredPoints(currentLoad.points);
      const res = await saveDatasetFromAnalysis({
        projectId: selectedProjectId,
        name: datasetName,
        sourceFilename: currentLoad.sourceFilename || undefined,
        points: storedPoints,
        meta: currentLoad.meta,
        report: currentLoad.report,
      });
      await refreshDatasets(selectedProjectId);
      if (res.duplicated_of) {
        setNotice('检测到重复数据集，已复用已有记录（未重复保存）');
      } else {
        setNotice('数据集保存成功');
      }
      setNewDatasetName('');
      schedulePush();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [selectedProjectId, currentLoad, newDatasetName, refreshDatasets]);

  const handleLoadDataset = useCallback(async (datasetId: string) => {
    setError(null);
    setNotice(null);
    setLoading(true);
    try {
      const full = await getDatasetWithPoints(datasetId);
      const points = toLoadDataPoints(full.points);
      onLoadToGlobal({
        points,
        meta: full.meta_json ?? null,
        report: full.quality_report_json ?? null,
        sourceLabel: `数据集：${full.name}`,
        datasetId: full.id,
      });
      setNotice('已加载到全局负荷数据，可直接去测算页复算');
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [onLoadToGlobal]);

  const handleRenameDataset = useCallback(async (dataset: LocalDataset) => {
    const next = window.prompt('请输入新的数据集名称', dataset.name);
    if (!next) return;
    setError(null);
    setNotice(null);
    setLoading(true);
    try {
      await renameDataset(dataset.id, next);
      await refreshDatasets(selectedProjectId);
      setNotice('数据集已重命名');
      schedulePush();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [selectedProjectId, refreshDatasets]);

  const handleDeleteDataset = useCallback(async (dataset: LocalDataset) => {
    if (!window.confirm(`确认删除数据集“${dataset.name}”？此操作不可恢复。`)) return;
    setError(null);
    setNotice(null);
    setLoading(true);
    try {
      await deleteDataset(dataset.id);
      await refreshDatasets(selectedProjectId);
      setNotice('数据集已删除');
      schedulePush();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [selectedProjectId, refreshDatasets]);

  const handleExportProject = useCallback(async () => {
    if (!selectedProject) {
      setError('请先选择项目');
      return;
    }
    setError(null);
    setNotice(null);
    setLoading(true);
    try {
      const json = await exportProjectToJson(selectedProject.id);
      downloadTextFile(`${selectedProject.name}_export.json`, json);
      setNotice('项目已导出');
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [selectedProject]);

  const handleImportProjectClick = useCallback(() => {
    importInputRef.current?.click();
  }, []);

  const handleImportFile = useCallback(async (file: File) => {
    setError(null);
    setNotice(null);
    setLoading(true);
    try {
      const text = await file.text();
      const p = await importProjectFromJson(text);
      await refreshProjects();
      setSelectedProjectId(p.id);
      await refreshDatasets(p.id);
      await refreshRuns(p.id);
      setNotice('项目导入成功');
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [refreshProjects, refreshDatasets, refreshRuns]);

  const handleSaveRunSnapshot = useCallback(async () => {
    if (!selectedProjectId) {
      setError('请先选择项目');
      return;
    }
    const name = newRunName.trim();
    if (!name) {
      setError('请输入快照名称');
      return;
    }
    if (!snapshotReadiness.hasCycles) {
      setError('缺少 cycles 结果：请先在 Storage Cycles 完成一次测算');
      return;
    }
    if (!snapshotReadiness.hasProfit) {
      setError('缺少 profit 结果：请先进入 Storage Profit 并完成收益数据准备（至少应有 cyclesResult；建议同时获取 curves）');
      return;
    }
    if (!snapshotReadiness.hasEconomics) {
      setError('缺少 economics 结果：请先在 Economics 完成一次测算');
      return;
    }
    if (!snapshotReadiness.hasDataset && !snapshotReadiness.hasLoadPoints) {
      setError('缺少负荷数据：请先上传负荷或加载数据集');
      return;
    }

    setError(null);
    setNotice(null);
    setLoading(true);
    try {
      const warnings: string[] = [];
      const datasetId = snapshotReadiness.hasDataset ? String(currentDatasetId) : undefined;
      const embeddedPoints = !datasetId ? toStoredPoints(currentLoad.points) : undefined;

      const cyclesSnapshot = {
        payload: lastCyclesRun?.payload,
        response: lastCyclesRun?.response,
        saved_at: new Date().toISOString(),
      };
      const economicsSnapshot = lastEconomicsRun
        ? {
            input: lastEconomicsRun.input,
            result: lastEconomicsRun.result,
            user_share_percent: lastEconomicsRun.userSharePercent,
            saved_at: new Date().toISOString(),
          }
        : undefined;
      const profitSnapshot = lastProfitRun
        ? {
            payload: lastProfitRun.payload,
            cycles_result: lastProfitRun.cyclesResult,
            curves: lastProfitRun.curvesData,
            selected_date: lastProfitRun.selectedDate,
            saved_at: new Date().toISOString(),
          }
        : undefined;

      const artifacts: Array<{ kind: string; filename: string; mime: string; blob: Blob }> = [];

      if (lastCyclesRun?.payload) {
        try {
          const cyclesExport = await exportStorageCyclesReport(null, lastCyclesRun.payload);
          if (cyclesExport?.file_content_base64) {
            const bin = atob(cyclesExport.file_content_base64);
            const bytes = new Uint8Array(bin.length);
            for (let i = 0; i < bin.length; i += 1) bytes[i] = bin.charCodeAt(i);
            const blob = new Blob([bytes], { type: cyclesExport.mime_type || 'text/csv;charset=utf-8' });
            artifacts.push({
              kind: 'cycles_export',
              filename: cyclesExport.file_name || 'storage_cycles.csv',
              mime: blob.type || 'text/csv',
              blob,
            });
          } else if (cyclesExport?.excel_path) {
            const blob = await fetchBackendBlob(cyclesExport.excel_path);
            artifacts.push({
              kind: 'cycles_excel',
              filename: cyclesExport.excel_path.split('/').pop() || 'cycles.xlsx',
              mime: blob.type || 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
              blob,
            });
          }
        } catch (e) {
          warnings.push(`cycles Excel 导出/下载失败：${e instanceof Error ? e.message : String(e)}`);
        }
        
        try {
          const businessExport = await exportStorageBusinessReport(null, lastCyclesRun.payload);
          if (businessExport?.file_content_base64) {
            const bin = atob(businessExport.file_content_base64);
            const bytes = new Uint8Array(bin.length);
            for (let i = 0; i < bin.length; i += 1) bytes[i] = bin.charCodeAt(i);
            const blob = new Blob([bytes], { type: businessExport.mime_type || 'text/csv;charset=utf-8' });
            artifacts.push({
              kind: 'business_report',
              filename: businessExport.file_name || 'storage_business.csv',
              mime: blob.type || 'text/csv',
              blob,
            });
          } else if (businessExport?.excel_path) {
            const blob = await fetchBackendBlob(businessExport.excel_path);
            artifacts.push({
              kind: 'business_zip',
              filename: businessExport.excel_path.split('/').pop() || 'business.zip',
              mime: blob.type || 'application/zip',
              blob,
            });
          }
        } catch (e) {
          warnings.push(`business ZIP 导出/下载失败：${e instanceof Error ? e.message : String(e)}`);
        }
      }

      if (lastEconomicsRun?.input) {
        try {
          const econExport = await exportEconomicsCashflowReport(lastEconomicsRun.input, lastEconomicsRun.userSharePercent);
          if (econExport?.file_content_base64) {
            const bin = atob(econExport.file_content_base64);
            const bytes = new Uint8Array(bin.length);
            for (let i = 0; i < bin.length; i += 1) bytes[i] = bin.charCodeAt(i);
            const blob = new Blob([bytes], { type: econExport.mime_type || 'text/csv;charset=utf-8' });
            artifacts.push({
              kind: 'economics_cashflow_csv',
              filename: econExport.file_name || 'economics_cashflow.csv',
              mime: blob.type || 'text/csv',
              blob,
            });
          } else if (econExport?.excel_path) {
            const blob = await fetchBackendBlob(econExport.excel_path);
            artifacts.push({
              kind: 'economics_cashflow_csv',
              filename: String(econExport.excel_path).split('/').pop() || 'economics_cashflow.csv',
              mime: blob.type || 'text/csv',
              blob,
            });
          }
        } catch (e) {
          warnings.push(`economics 现金流导出/下载失败：${e instanceof Error ? e.message : String(e)}`);
        }
      }

      await saveRunSnapshot({
        projectId: selectedProjectId,
        name,
        datasetId,
        embeddedPoints,
        qualitySnapshot: { meta: currentLoad.meta ?? null, report: currentLoad.report ?? null },
        configSnapshot: scheduleSnapshot,
        cyclesSnapshot,
        economicsSnapshot,
        profitSnapshot,
        artifacts,
      });
      setNewRunName('');
      await refreshRuns(selectedProjectId);
      if (warnings.length > 0) {
        setNotice(`快照保存成功（部分附件失败：${warnings.join('；')}）`);
      } else {
        setNotice('快照保存成功（已包含 cycles/economics/profit 全量明细与导出文件）');
      }
      schedulePush();
    } catch (e) {
      console.error(e);
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [
    selectedProjectId,
    newRunName,
    snapshotReadiness,
    currentDatasetId,
    currentLoad.points,
    lastCyclesRun,
    lastEconomicsRun,
    lastProfitRun,
    scheduleSnapshot,
    refreshRuns,
    schedulePush,
  ]);

  const handleOpenRunDetail = useCallback(async (runId: string) => {
    setError(null);
    setNotice(null);
    setLoading(true);
    try {
      const full = await getRunWithArtifacts(runId);
      setRunDetail(full);
      setShowRunDetail(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  const handleDeleteRun = useCallback(async (runId: string) => {
    if (!window.confirm('确认删除该快照？此操作不可恢复。')) return;
    setError(null);
    setNotice(null);
    setLoading(true);
    try {
      await deleteRun(runId);
      await refreshRuns(selectedProjectId);
      setNotice('快照已删除');
      schedulePush();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [refreshRuns, selectedProjectId]);

  const handleLoadRun = useCallback(async (runId: string, restoreConfig: boolean) => {
    setError(null);
    setNotice(null);
    setLoading(true);
    try {
      const full = await getRunWithArtifacts(runId);

      let points: LoadDataPoint[] = [];
      let meta: BackendAnalysisMeta | null = null;
      let report: BackendQualityReport | null = null;
      let datasetId: string | null = null;

      if (full.dataset_id) {
        const ds = await getDatasetWithPoints(full.dataset_id);
        points = toLoadDataPoints(ds.points);
        meta = ds.meta_json ?? full.quality_snapshot?.meta ?? null;
        report = ds.quality_report_json ?? full.quality_snapshot?.report ?? null;
        datasetId = ds.id;
      } else if (Array.isArray(full.embedded_points) && full.embedded_points.length > 0) {
        points = toLoadDataPoints(full.embedded_points);
        meta = full.quality_snapshot?.meta ?? null;
        report = full.quality_snapshot?.report ?? null;
      } else {
        throw new Error('该快照缺少负荷数据引用，无法加载');
      }

      onLoadToGlobal({
        points,
        meta,
        report,
        sourceLabel: `快照：${full.name}`,
        datasetId,
      });

      const cyclesRun =
        full.cycles_snapshot?.payload && full.cycles_snapshot?.response
          ? { payload: full.cycles_snapshot.payload as StorageParamsPayload, response: full.cycles_snapshot.response as BackendStorageCyclesResponse }
          : null;
      const profitRun = full.profit_snapshot
        ? {
            payload: (full.profit_snapshot as any)?.payload ?? null,
            cyclesResult: (full.profit_snapshot as any)?.cycles_result ?? null,
            curvesData: (full.profit_snapshot as any)?.curves ?? null,
            selectedDate: (full.profit_snapshot as any)?.selected_date ?? null,
          }
        : null;
      const economicsRun = full.economics_snapshot
        ? {
            input: (full.economics_snapshot as any)?.input as StorageEconomicsInput,
            result: (full.economics_snapshot as any)?.result as StorageEconomicsResult,
            userSharePercent: Number((full.economics_snapshot as any)?.user_share_percent ?? 0),
          }
        : null;
      onRestoreRunPages({ cyclesRun, profitRun, economicsRun });

      if (restoreConfig) {
        onRestoreConfig(full.config_snapshot);
      }

      setNotice(restoreConfig ? '已加载快照并恢复配置，可直接复盘或复算' : '已加载快照到全局负荷数据，可用于查看与复盘');
    } catch (e) {
      console.error(e);
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [getDatasetWithPoints, onLoadToGlobal, onRestoreConfig]);

  const handleDownloadRunArtifacts = useCallback(async (runId: string) => {
    setError(null);
    setNotice(null);
    setLoading(true);
    try {
      const full = await getRunWithArtifacts(runId);
      if (!full.artifacts.length) {
        setNotice('该快照没有附件');
        return;
      }
      for (const a of full.artifacts) {
        downloadBlobFile(a.filename, a.blob);
      }
      setNotice('附件已开始下载');
    } catch (e) {
      console.error(e);
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  return (
    <div className="space-y-6">
      <div id="section-datasets-intro" className="scroll-mt-24 p-6 bg-white rounded-xl shadow-lg">
        <h2 className="text-2xl font-bold text-slate-800 mb-2">项目与数据集（本地保存）</h2>
        <div className="text-sm text-slate-600">
          当前存储后端：<span className="font-semibold text-slate-800">{backend === 'indexeddb' ? 'IndexedDB' : 'localStorage（降级）'}</span>
          {backend === 'localstorage' && (
            <span className="ml-2 text-amber-700">提示：localStorage 容量有限，建议使用 IndexedDB 环境。</span>
          )}
        </div>
        <div className="mt-3 flex flex-wrap items-center gap-3 text-sm">
          <label className="inline-flex items-center gap-2 select-none">
            <input
              type="checkbox"
              className="accent-slate-600"
              checked={localSyncEnabled}
              onChange={(e) => {
                const v = e.target.checked;
                setLocalSyncEnabled(v);
                if (typeof window !== 'undefined') window.localStorage.setItem('localSyncEnabled', v ? 'true' : 'false');
                setLocalSyncPausedReason('');
                setLocalSyncStatus(v ? '已启用（需要后端运行）' : '已关闭');
              }}
            />
            <span>启用本地跨浏览器自动同步（依赖后端）</span>
          </label>
          {localSyncEnabled && (
            <>
              <div className="flex items-center gap-2">
                <span className="text-slate-600">同步地址</span>
                <input
                  className="border border-slate-300 rounded-md px-2 py-1 text-sm w-[260px]"
                  value={localSyncBaseUrl}
                  onChange={(e) => {
                    const v = e.target.value;
                    setLocalSyncBaseUrl(v);
                    if (typeof window !== 'undefined') window.localStorage.setItem('localSyncBaseUrl', v);
                  }}
                  placeholder="留空=同源 /api 代理；或填 http://localhost:8000"
                />
              </div>
              <button
                className="px-3 py-1.5 rounded-md border border-slate-300 text-sm disabled:opacity-50"
                onClick={pullFromLocalSync}
                disabled={loading}
              >
                立即拉取
              </button>
              <button
                className="px-3 py-1.5 rounded-md border border-slate-300 text-sm disabled:opacity-50"
                onClick={pushToLocalSync}
                disabled={loading}
              >
                立即推送
              </button>
              {localSyncStatus && <span className="text-slate-600">{localSyncStatus}</span>}
              {localSyncPausedReason && (
                <span className="text-amber-700">
                  已暂停自动同步：{localSyncPausedReason}（重启后端后可手动点“立即拉取/推送”恢复）
                </span>
              )}
            </>
          )}
        </div>
      </div>

      {error && (
        <div className="p-4 bg-red-100 border border-red-400 text-red-700 rounded-lg" role="alert">
          <p className="font-bold">操作失败</p>
          <p>{error}</p>
        </div>
      )}
      {notice && (
        <div className="p-4 bg-green-100 border border-green-400 text-green-800 rounded-lg" role="status">
          <p className="font-semibold">{notice}</p>
        </div>
      )}

      <div id="section-projects" className="scroll-mt-24 p-6 bg-white rounded-xl shadow-lg">
        <h3 className="text-lg font-bold text-slate-800 mb-4">项目管理</h3>
        <div className="flex flex-col md:flex-row gap-3 md:items-center">
          <div className="flex items-center gap-2">
            <span className="text-sm text-slate-700">当前项目</span>
            <select
              className="border border-slate-300 rounded-md px-2 py-1 text-sm"
              value={selectedProjectId}
              onChange={(e) => setSelectedProjectId(e.target.value)}
            >
              <option value="">（请选择）</option>
              {projects.map((p) => (
                <option key={p.id} value={p.id}>{p.name}</option>
              ))}
            </select>
          </div>
          <div className="flex items-center gap-2">
            <input
              className="border border-slate-300 rounded-md px-3 py-1.5 text-sm w-64"
              placeholder="新建项目名称"
              value={newProjectName}
              onChange={(e) => setNewProjectName(e.target.value)}
              disabled={loading}
            />
            <button
              className="px-3 py-1.5 rounded-md bg-blue-600 text-white text-sm font-semibold disabled:opacity-50"
              onClick={handleCreateProject}
              disabled={loading || !newProjectName.trim()}
            >
              新建项目
            </button>
          </div>
          <div className="flex-1" />
          <div className="flex items-center gap-2">
            <button
              className="px-3 py-1.5 rounded-md border border-slate-300 text-sm disabled:opacity-50"
              onClick={handleExportProject}
              disabled={loading || !selectedProject}
            >
              导出项目(JSON)
            </button>
            <button
              className="px-3 py-1.5 rounded-md border border-slate-300 text-sm disabled:opacity-50"
              onClick={handleImportProjectClick}
              disabled={loading}
            >
              导入项目(JSON)
            </button>
            <button
              className="px-3 py-1.5 rounded-md border border-slate-300 text-sm disabled:opacity-50"
              onClick={handleRenameProject}
              disabled={loading || !selectedProject}
            >
              重命名
            </button>
            <button
              className="px-3 py-1.5 rounded-md border border-red-300 text-red-700 text-sm disabled:opacity-50"
              onClick={handleDeleteProject}
              disabled={loading || !selectedProject}
            >
              删除
            </button>
            <input
              ref={importInputRef}
              type="file"
              accept="application/json,.json"
              className="sr-only"
              onChange={async (e) => {
                const f = e.target.files?.[0];
                if (!f) return;
                await handleImportFile(f);
                e.target.value = '';
              }}
            />
          </div>
        </div>
      </div>

      <div id="section-save-current" className="scroll-mt-24 p-6 bg-white rounded-xl shadow-lg">
        <h3 className="text-lg font-bold text-slate-800 mb-4">保存当前负荷到数据集</h3>
        <div className="text-sm text-slate-600 mb-3">
          {currentLoadStats
            ? <>当前已加载 <span className="font-semibold text-slate-800">{currentLoadStats.count}</span> 点，范围：{currentLoadStats.start.toLocaleString()} ~ {currentLoadStats.end.toLocaleString()}</>
            : <>当前没有可保存的负荷数据（请先上传负荷文件或加载已有数据集）。</>
          }
          {currentLoad.sourceFilename ? <span className="ml-2">来源文件：{currentLoad.sourceFilename}</span> : null}
        </div>
        <div className="flex flex-col md:flex-row gap-3 md:items-center">
          <input
            className="border border-slate-300 rounded-md px-3 py-1.5 text-sm w-80"
            placeholder="数据集名称（例如：2025年样例_清洗后）"
            value={newDatasetName}
            onChange={(e) => setNewDatasetName(e.target.value)}
            disabled={loading}
          />
          <button
            className="px-4 py-1.5 rounded-md bg-emerald-600 text-white text-sm font-semibold disabled:opacity-50"
            onClick={handleSaveCurrentLoad}
            disabled={loading || !selectedProjectId || !newDatasetName.trim() || !(currentLoad.points && currentLoad.points.length > 0)}
          >
            保存到项目
          </button>
          {!selectedProjectId && <span className="text-sm text-amber-700">请先选择或新建项目</span>}
        </div>
      </div>

      <div id="section-datasets" className="scroll-mt-24 p-6 bg-white rounded-xl shadow-lg">
        <h3 className="text-lg font-bold text-slate-800 mb-4">数据集列表</h3>
        {!selectedProjectId ? (
          <div className="text-sm text-slate-600">请选择一个项目以查看数据集。</div>
        ) : datasets.length === 0 ? (
          <div className="text-sm text-slate-600">该项目下暂无数据集。</div>
        ) : (
          <div className="overflow-x-auto border border-slate-200 rounded-lg">
            <table className="min-w-full divide-y divide-slate-200 text-sm">
              <thead className="bg-slate-50">
                <tr>
                  <th className="px-4 py-3 text-left font-semibold text-slate-600">名称</th>
                  <th className="px-4 py-3 text-left font-semibold text-slate-600">点数</th>
                  <th className="px-4 py-3 text-left font-semibold text-slate-600">时间范围</th>
                  <th className="px-4 py-3 text-left font-semibold text-slate-600">创建时间</th>
                  <th className="px-4 py-3 text-right font-semibold text-slate-600">操作</th>
                </tr>
              </thead>
              <tbody className="bg-white divide-y divide-slate-200">
                {datasets.map((d) => (
                  <tr key={d.id}>
                    <td className="px-4 py-3 text-slate-800">{d.name}</td>
                    <td className="px-4 py-3 text-slate-700">{d.points_count}</td>
                    <td className="px-4 py-3 text-slate-700">
                      {d.start_time ? new Date(d.start_time).toLocaleString() : '—'} ~ {d.end_time ? new Date(d.end_time).toLocaleString() : '—'}
                    </td>
                    <td className="px-4 py-3 text-slate-700">{d.created_at ? new Date(d.created_at).toLocaleString() : '—'}</td>
                    <td className="px-4 py-3 text-right">
                      <div className="inline-flex items-center gap-2">
                        <button
                          className="px-3 py-1 rounded-md bg-blue-600 text-white text-xs font-semibold disabled:opacity-50"
                          onClick={() => handleLoadDataset(d.id)}
                          disabled={loading}
                        >
                          加载使用
                        </button>
                        <button
                          className="px-3 py-1 rounded-md border border-slate-300 text-xs disabled:opacity-50"
                          onClick={() => handleRenameDataset(d)}
                          disabled={loading}
                        >
                          重命名
                        </button>
                        <button
                          className="px-3 py-1 rounded-md border border-red-300 text-red-700 text-xs disabled:opacity-50"
                          onClick={() => handleDeleteDataset(d)}
                          disabled={loading}
                        >
                          删除
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div id="section-runs" className="scroll-mt-24 p-6 bg-white rounded-xl shadow-lg">
        <h3 className="text-lg font-bold text-slate-800 mb-4">测算快照（cycles + profit + economics + 配置 + 附件）</h3>
        <div className="text-sm text-slate-600 mb-3">
          保存快照前请确认：
          <span className={`ml-2 ${snapshotReadiness.hasCycles ? 'text-green-700' : 'text-red-700'}`}>cycles {snapshotReadiness.hasCycles ? '✓' : '✗'}</span>
          <span className={`ml-2 ${snapshotReadiness.hasProfit ? 'text-green-700' : 'text-red-700'}`}>profit {snapshotReadiness.hasProfit ? '✓' : '✗'}</span>
          <span className={`ml-2 ${snapshotReadiness.hasEconomics ? 'text-green-700' : 'text-red-700'}`}>economics {snapshotReadiness.hasEconomics ? '✓' : '✗'}</span>
          <span className={`ml-2 ${snapshotReadiness.hasDataset ? 'text-green-700' : 'text-amber-700'}`}>
            数据集引用 {snapshotReadiness.hasDataset ? '✓' : (snapshotReadiness.hasLoadPoints ? '（将嵌入点位兜底）' : '✗')}
          </span>
        </div>

        <div className="flex flex-col md:flex-row gap-3 md:items-center mb-4">
          <input
            className="border border-slate-300 rounded-md px-3 py-1.5 text-sm w-96"
            placeholder="快照名称（例如：2025-01-01_5000kWh_峰谷套利_含导出）"
            value={newRunName}
            onChange={(e) => setNewRunName(e.target.value)}
            disabled={loading}
          />
          <button
            className="px-4 py-1.5 rounded-md bg-indigo-600 text-white text-sm font-semibold disabled:opacity-50"
            onClick={handleSaveRunSnapshot}
            disabled={loading || !selectedProjectId || !newRunName.trim()}
          >
            保存本次测算为快照（含导出文件）
          </button>
          {!selectedProjectId && <span className="text-sm text-amber-700">请先选择或新建项目</span>}
        </div>

        {!selectedProjectId ? (
          <div className="text-sm text-slate-600">请选择一个项目以查看快照。</div>
        ) : runs.length === 0 ? (
          <div className="text-sm text-slate-600">该项目下暂无快照。</div>
        ) : (
          <div className="overflow-x-auto border border-slate-200 rounded-lg">
            <table className="min-w-full divide-y divide-slate-200 text-sm">
              <thead className="bg-slate-50">
                <tr>
                  <th className="px-4 py-3 text-left font-semibold text-slate-600">名称</th>
                  <th className="px-4 py-3 text-left font-semibold text-slate-600">创建时间</th>
                  <th className="px-4 py-3 text-left font-semibold text-slate-600">包含</th>
                  <th className="px-4 py-3 text-right font-semibold text-slate-600">操作</th>
                </tr>
              </thead>
              <tbody className="bg-white divide-y divide-slate-200">
                {runs.map((r) => (
                  <tr key={r.id}>
                    <td className="px-4 py-3 text-slate-800">{r.name}</td>
                    <td className="px-4 py-3 text-slate-700">{r.created_at ? new Date(r.created_at).toLocaleString() : '—'}</td>
                    <td className="px-4 py-3 text-slate-700">
                      <span className="mr-2">cycles</span>
                      <span className="mr-2">profit</span>
                      <span className={`${r.economics_snapshot ? '' : 'text-slate-400'}`}>economics</span>
                    </td>
                    <td className="px-4 py-3 text-right">
                      <div className="inline-flex items-center gap-2">
                        <button
                          className="px-3 py-1 rounded-md bg-blue-600 text-white text-xs font-semibold disabled:opacity-50"
                          onClick={() => handleLoadRun(r.id, false)}
                          disabled={loading}
                        >
                          加载
                        </button>
                        <button
                          className="px-3 py-1 rounded-md bg-emerald-600 text-white text-xs font-semibold disabled:opacity-50"
                          onClick={() => handleLoadRun(r.id, true)}
                          disabled={loading}
                        >
                          加载并恢复配置
                        </button>
                        <button
                          className="px-3 py-1 rounded-md border border-slate-300 text-xs disabled:opacity-50"
                          onClick={() => handleOpenRunDetail(r.id)}
                          disabled={loading}
                        >
                          查看
                        </button>
                        <button
                          className="px-3 py-1 rounded-md border border-slate-300 text-xs disabled:opacity-50"
                          onClick={() => handleDownloadRunArtifacts(r.id)}
                          disabled={loading}
                        >
                          下载附件
                        </button>
                        <button
                          className="px-3 py-1 rounded-md border border-red-300 text-red-700 text-xs disabled:opacity-50"
                          onClick={() => handleDeleteRun(r.id)}
                          disabled={loading}
                        >
                          删除
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div id="section-datasets-note" className="scroll-mt-24 p-4 bg-slate-50 rounded-lg border border-slate-300 text-sm text-slate-600">
        本页说明：本地保存的数据集会在刷新后保留；加载数据集后，“负荷分析/储能测算/经济性”等页面会复用同一份全局负荷数据，避免重复上传。
      </div>

      {showRunDetail && runDetail && (
        <div className="fixed inset-0 z-[60] bg-black/40 flex items-center justify-center p-4" role="dialog" aria-modal="true">
          <div className="w-full max-w-4xl bg-white rounded-xl shadow-xl border border-slate-200 overflow-hidden">
            <div className="px-4 py-3 border-b border-slate-200 flex items-center justify-between">
              <div className="font-bold text-slate-800">快照详情：{runDetail.name}</div>
              <button
                className="px-3 py-1 rounded-md border border-slate-300 text-sm"
                onClick={() => { setShowRunDetail(false); setRunDetail(null); }}
              >
                关闭
              </button>
            </div>
            <div className="p-4 space-y-3">
              <div className="text-sm text-slate-600">
                附件数量：<span className="font-semibold text-slate-800">{runDetail.artifacts.length}</span>
                {runDetail.artifacts.length > 0 && (
                  <button
                    className="ml-3 px-3 py-1 rounded-md border border-slate-300 text-xs"
                    onClick={() => {
                      for (const a of runDetail.artifacts) downloadBlobFile(a.filename, a.blob);
                    }}
                  >
                    下载全部附件
                  </button>
                )}
              </div>
              <pre className="text-xs bg-slate-50 border border-slate-200 rounded-lg p-3 overflow-auto max-h-[60vh]">
{JSON.stringify(
  {
    ...runDetail,
    artifacts: runDetail.artifacts.map(a => ({ kind: a.kind, filename: a.filename, mime: a.mime, size: a.blob.size })),
  },
  null,
  2,
)}
              </pre>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
