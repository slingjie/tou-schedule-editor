import React, { useCallback, useEffect, useMemo, useState } from 'react';
import type { ReportDataV3 } from '../types';
import { BASE_URL, fetchStorageCurves } from '../storageApi';
import { ensureBackendSupports } from '../backendCapabilities';
import type { StorageParamsPayload } from '../storageApi';
import {
  getDatasetWithPoints,
  getRunWithArtifacts,
  addRunArtifacts,
  listProjects,
  listRuns,
  type LocalDatasetWithPoints,
  type LocalProject,
  type LocalRun,
  type LocalRunWithArtifacts,
} from '../localProjectStore';
import { buildReportDataV3 } from '../utils/reportDataBuilder';
import { buildReportChartsV3 } from '../utils/reportChartExport';

const downloadBlobFile = (filename: string, blob: Blob) => {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
};

const readFileAsDataUrl = (file: File): Promise<string> => {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('读取文件失败'));
    reader.onload = () => resolve(String(reader.result || ''));
    reader.readAsDataURL(file);
  });
};

const postReport = async (path: '/api/report/pdf' | '/api/report/html', reportData: ReportDataV3): Promise<Response> => {
  const featureName = path === '/api/report/pdf' ? 'PDF 报告导出' : 'HTML 报告预览';
  await ensureBackendSupports(featureName, [path]);

  const url = `${BASE_URL}${path}`;
  const resp = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ report_data: reportData }),
  });
  return resp;
};

const readBackendErrorDetail = async (resp: Response): Promise<string> => {
  const contentType = resp.headers.get('content-type') || '';
  try {
    if (contentType.includes('application/json')) {
      const json = await resp.json().catch(() => null);
      return String(json?.detail || json?.message || `${resp.status} ${resp.statusText}`);
    }
    const text = await resp.text().catch(() => '');
    return text || `${resp.status} ${resp.statusText}`;
  } catch {
    return `${resp.status} ${resp.statusText}`;
  }
};

const formatLocalTime = (d: Date): string => {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
};

export const ReportCenterPage: React.FC = () => {
  const [pendingCount, setPendingCount] = useState(0);
  const loading = pendingCount > 0;
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const [projects, setProjects] = useState<LocalProject[]>([]);
  const [selectedProjectId, setSelectedProjectId] = useState('');
  const [runs, setRuns] = useState<LocalRun[]>([]);
  const [selectedRunId, setSelectedRunId] = useState('');

  const [runDetail, setRunDetail] = useState<LocalRunWithArtifacts | null>(null);
  const [dataset, setDataset] = useState<LocalDatasetWithPoints | null>(null);

  const [ownerName, setOwnerName] = useState('');
  const [projectLocation, setProjectLocation] = useState('');
  const [authorOrg, setAuthorOrg] = useState('');
  const [subtitle, setSubtitle] = useState('');
  const [logoDataUrl, setLogoDataUrl] = useState<string | null>(null);
  const [totalInvestmentWanyuanText, setTotalInvestmentWanyuanText] = useState('');
  const [tryFetchTypicalCurves, setTryFetchTypicalCurves] = useState(true);
  const [aiPolishEnabled, setAiPolishEnabled] = useState(false);
  const [bestProfitDayOverride, setBestProfitDayOverride] = useState<string>('');
  const [maxLoadDayOverride, setMaxLoadDayOverride] = useState<string>('');
  const [previewHtml, setPreviewHtml] = useState<string>('');
  const [previewScale, setPreviewScale] = useState(0.9);

  const selectedProject = useMemo(
    () => projects.find(p => p.id === selectedProjectId) ?? null,
    [projects, selectedProjectId],
  );

  const runWithLoading = useCallback(async <T,>(fn: () => Promise<T>): Promise<T> => {
    setPendingCount(c => c + 1);
    try {
      return await fn();
    } finally {
      setPendingCount(c => Math.max(0, c - 1));
    }
  }, []);

  const refreshRuns = useCallback(async (projectId: string) => {
    if (!projectId) {
      setRuns([]);
      setSelectedRunId('');
      return;
    }
    const list = await listRuns(projectId);
    setRuns(list);
    setSelectedRunId((prev) => {
      if (prev && list.some(r => r.id === prev)) return prev;
      return list[0]?.id ?? '';
    });
  }, []);

  useEffect(() => {
    let cancelled = false;
    setError(null);
    setNotice(null);
    runWithLoading(async () => {
      const list = await listProjects();
      if (cancelled) return;
      setProjects(list);
      setSelectedProjectId(prev => prev || (list[0]?.id ?? ''));
    }).catch((e) => {
      if (!cancelled) setError(e instanceof Error ? e.message : String(e));
    });
    return () => {
      cancelled = true;
    };
  }, [runWithLoading]);

  useEffect(() => {
    let cancelled = false;
    setRunDetail(null);
    setDataset(null);
    setSelectedRunId('');
    if (!selectedProjectId) {
      setRuns([]);
      return;
    }
    setError(null);
    setNotice(null);
    runWithLoading(async () => {
      const list = await listRuns(selectedProjectId);
      if (cancelled) return;
      setRuns(list);
      setSelectedRunId(() => list[0]?.id ?? '');
    }).catch((e) => {
      if (!cancelled) setError(e instanceof Error ? e.message : String(e));
    });
    return () => {
      cancelled = true;
    };
  }, [selectedProjectId, runWithLoading]);

  useEffect(() => {
    let cancelled = false;
    setRunDetail(null);
    setDataset(null);
    if (!selectedRunId) return;

    setError(null);
    setNotice(null);
    setPendingCount(c => c + 1);

    (async () => {
      const full = await getRunWithArtifacts(selectedRunId);
      if (cancelled) return;
      setRunDetail(full);
      if (full.dataset_id) {
        const ds = await getDatasetWithPoints(full.dataset_id);
        if (!cancelled) setDataset(ds);
      }
    })()
      .catch((e) => {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      })
      .finally(() => {
        setPendingCount(c => Math.max(0, c - 1));
      });

    return () => {
      cancelled = true;
    };
  }, [selectedRunId]);

  const totalInvestmentWanyuan = useMemo(() => {
    const n = Number(totalInvestmentWanyuanText);
    return Number.isFinite(n) && n > 0 ? n : null;
  }, [totalInvestmentWanyuanText]);

  const baseReportData: ReportDataV3 | null = useMemo(() => {
    if (!selectedProject?.name) return null;
    if (!runDetail) return null;
    if (totalInvestmentWanyuan == null) return null;

    return buildReportDataV3({
      projectName: selectedProject.name,
      run: runDetail,
      dataset,
      ownerName,
      projectLocation,
      authorOrg,
      subtitle,
      logoDataUrl,
      totalInvestmentWanyuan,
    });
  }, [
    selectedProject?.name,
    runDetail,
    dataset,
    ownerName,
    projectLocation,
    authorOrg,
    subtitle,
    logoDataUrl,
    totalInvestmentWanyuan,
  ]);

  const cycleDayOptions = useMemo(() => {
    const days = (runDetail as any)?.cycles_snapshot?.response?.days;
    if (!Array.isArray(days)) return [];
    const list = days.map((d: any) => String(d?.date || '')).filter(Boolean).sort();
    return Array.from(new Set(list));
  }, [runDetail]);

  const loadDayOptions = useMemo(() => {
    const points = dataset?.points?.length
      ? dataset.points
      : (Array.isArray(runDetail?.embedded_points) ? runDetail.embedded_points : []);
    const set = new Set<string>();
    for (const p of points) {
      const ts = String((p as any)?.timestamp ?? '');
      if (ts.length >= 10) set.add(ts.slice(0, 10));
    }
    return Array.from(set).sort();
  }, [dataset, runDetail]);

  const applyTypicalDayOverrides = useCallback((reportData: ReportDataV3): ReportDataV3 => {
    if (!bestProfitDayOverride && !maxLoadDayOverride) return reportData;
    const next: ReportDataV3 = JSON.parse(JSON.stringify(reportData));
    const missing = new Set(next.completeness.missing_items || []);

    if (!next.storage) (next as any).storage = {};
    if (!(next.storage as any).typical_days) (next.storage as any).typical_days = { best_profit_day: { date: null, curves: null }, max_load_day: { date: null, curves: null } };

    if (bestProfitDayOverride) {
      (next.storage as any).typical_days.best_profit_day.date = bestProfitDayOverride;
      missing.delete('缺少收益最高日：cycles 日度收益数据不足');
    }
    if (maxLoadDayOverride) {
      (next.storage as any).typical_days.max_load_day.date = maxLoadDayOverride;
      missing.delete('缺少最大负荷日：负荷点位数据不足');
    }
    next.completeness.missing_items = Array.from(missing);
    return next;
  }, [bestProfitDayOverride, maxLoadDayOverride]);

  const enrichTypicalDayCurves = useCallback(async (reportData: ReportDataV3): Promise<ReportDataV3> => {
    if (!tryFetchTypicalCurves) return reportData;
    const payload = reportData.storage?.cycles_payload as StorageParamsPayload | null;
    if (!payload) return reportData;

    const bestDate = reportData.storage?.typical_days?.best_profit_day?.date as string | null;
    const maxDate = reportData.storage?.typical_days?.max_load_day?.date as string | null;
    const same = Boolean(bestDate && maxDate && bestDate === maxDate);

    const next: ReportDataV3 = JSON.parse(JSON.stringify(reportData));
    const missing = new Set(next.completeness.missing_items || []);

    const tryFetch = async (date: string): Promise<any | null> => {
      try {
        return await fetchStorageCurves(payload, date);
      } catch (e) {
        return { __error: e instanceof Error ? e.message : String(e) };
      }
    };

    if (bestDate) {
      const res = await tryFetch(bestDate);
      if (res && !res.__error) {
        (next.storage as any).typical_days.best_profit_day.curves = res;
        next.completeness.has_profit_curves_for_best_profit_day = true;
        missing.delete('缺少收益最高日曲线：导出前可尝试拉取曲线');
      } else if (res?.__error) {
        missing.add(`收益最高日曲线获取失败：${res.__error}`);
      }
    } else {
      missing.add('缺少收益最高日：cycles 日度收益数据不足');
    }

    if (same && bestDate) {
      (next.storage as any).typical_days.max_load_day.curves = (next.storage as any).typical_days.best_profit_day.curves;
      next.completeness.has_profit_curves_for_max_load_day = next.completeness.has_profit_curves_for_best_profit_day;
    } else if (maxDate) {
      const res = await tryFetch(maxDate);
      if (res && !res.__error) {
        (next.storage as any).typical_days.max_load_day.curves = res;
        next.completeness.has_profit_curves_for_max_load_day = true;
        missing.delete('缺少最大负荷日曲线：导出前可尝试拉取曲线');
      } else if (res?.__error) {
        missing.add(`最大负荷日曲线获取失败：${res.__error}`);
      }
    } else {
      missing.add('缺少最大负荷日：负荷点位数据不足');
    }

    next.completeness.missing_items = Array.from(missing);
    return next;
  }, [tryFetchTypicalCurves]);

  const enrichCharts = useCallback(async (reportData: ReportDataV3): Promise<ReportDataV3> => {
    const points = dataset?.points?.length
      ? dataset.points
      : (Array.isArray(runDetail?.embedded_points) ? runDetail.embedded_points : []);
    const intervalMinutes = dataset?.interval_minutes ?? null;

    if (typeof document === 'undefined') return reportData;

    const { charts, warnings } = await buildReportChartsV3({ reportData, points, intervalMinutes });
    const next: ReportDataV3 = JSON.parse(JSON.stringify(reportData));
    next.charts = { ...(next.charts as any), ...(charts as any) };

    const missing = new Set(next.completeness.missing_items || []);
    for (const w of warnings) missing.add(`图表生成提示：${w}`);
    next.completeness.missing_items = Array.from(missing);
    return next;
  }, [dataset, runDetail]);

  const prepareReportData = useCallback(async (base: ReportDataV3): Promise<ReportDataV3> => {
    let reportData = applyTypicalDayOverrides(base);
    reportData = await enrichTypicalDayCurves(reportData);
    reportData = await enrichCharts(reportData);
    reportData = JSON.parse(JSON.stringify(reportData));
    reportData.ai_polish.enabled = aiPolishEnabled;
    return reportData;
  }, [applyTypicalDayOverrides, enrichTypicalDayCurves, enrichCharts, aiPolishEnabled]);

  const handlePreviewHtml = useCallback(async () => {
    if (!baseReportData) {
      setError('请先选择项目/快照，并填写总投资（万元）。');
      return;
    }
    setError(null);
    setNotice(null);
    setPendingCount(c => c + 1);
    try {
      const reportData = await prepareReportData(baseReportData);
      const resp = await postReport('/api/report/html', reportData);
      if (!resp.ok) throw new Error(await readBackendErrorDetail(resp));
      const htmlText = await resp.text();
      setPreviewHtml(htmlText);
      setNotice('已生成 A4 预览（内嵌）。');
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setPendingCount(c => Math.max(0, c - 1));
    }
  }, [baseReportData, prepareReportData]);

  const handleOpenPreviewWindow = useCallback(() => {
    if (!previewHtml) {
      setError('尚未生成预览，请先点击“生成预览”。');
      return;
    }
    const w = window.open('', '_blank');
    if (!w) {
      setError('浏览器阻止了弹窗，请允许打开新窗口后重试。');
      return;
    }
    w.document.open();
    w.document.write(previewHtml);
    w.document.close();
  }, [previewHtml]);

  const handleExportPdf = useCallback(async (saveToRunArtifacts: boolean) => {
    if (!selectedProjectId || !selectedProject?.name) {
      setError('请先选择项目。');
      return;
    }
    if (!runDetail) {
      setError('请先选择一个运行快照。');
      return;
    }
    if (!baseReportData) {
      setError('请先填写总投资（万元），并确保项目/周期信息可用。');
      return;
    }

    setError(null);
    setNotice(null);
    setPendingCount(c => c + 1);
    try {
      const reportData = await prepareReportData(baseReportData);

      const missing = reportData.completeness?.missing_items || [];
      if (missing.length > 0) {
        const ok = window.confirm(`当前存在缺失项（仍允许导出，但报告会占位提示）：\n\n- ${missing.join('\n- ')}\n\n是否继续导出？`);
        if (!ok) return;
      }

      const resp = await postReport('/api/report/pdf', reportData);
      if (!resp.ok) throw new Error(await readBackendErrorDetail(resp));
      const pdfBlob = await resp.blob();

      const cd = resp.headers.get('content-disposition') || '';
      const matchUtf8 = cd.match(/filename\*=UTF-8''([^;]+)/i);
      const matchAscii = cd.match(/filename=\"?([^\";]+)\"?/i);
      const filename =
        matchUtf8?.[1]
          ? decodeURIComponent(matchUtf8[1])
          : (matchAscii?.[1] ? String(matchAscii[1]) : `${selectedProject.name}_项目经济性评估报告.pdf`);
      downloadBlobFile(filename, pdfBlob);

      if (saveToRunArtifacts) {
        if (!selectedRunId) throw new Error('缺少运行快照：请先选择 Run');
        const now = new Date();
        const jsonBlob = new Blob([JSON.stringify(reportData, null, 2)], { type: 'application/json' });
        const stamp = formatLocalTime(now).replace(/[:\s]/g, '-');
        await addRunArtifacts(selectedRunId, [
          { kind: 'report_pdf', filename, mime: 'application/pdf', blob: pdfBlob },
          { kind: 'report_data_json', filename: `report_data_v3_${stamp}.json`, mime: 'application/json', blob: jsonBlob },
        ]);
        await refreshRuns(selectedProjectId);
        setNotice('PDF 已下载，并已写入当前 Run 附件（report_pdf + report_data_json）。');
      } else {
        setNotice('PDF 已开始下载。');
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setPendingCount(c => Math.max(0, c - 1));
    }
  }, [
    selectedProjectId,
    selectedProject?.name,
    runDetail,
    baseReportData,
    prepareReportData,
    selectedRunId,
    refreshRuns,
  ]);

  return (
    <div className="space-y-6">
      <div id="section-report-intro" className="scroll-mt-24 p-6 bg-white rounded-xl shadow-lg">
        <h2 className="text-2xl font-bold text-slate-800 mb-2">报告中心（图文 PDF v3.0）</h2>
        <div className="text-sm text-slate-600">
          说明：本页从“项目/数据集/运行快照”汇总数据，生成可交付的图文 PDF。若尚未保存运行快照，请先前往 <span className="font-semibold text-slate-800">Datasets</span> 页保存 cycles/economics/profit 快照。
        </div>
      </div>

      <div id="section-report-source" className="scroll-mt-24 p-6 bg-white rounded-xl shadow-lg">
        <h3 className="text-lg font-bold text-slate-800 mb-4">数据源选择</h3>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <label className="block">
            <div className="text-sm font-semibold text-slate-700 mb-1">项目</div>
            <select
              className="w-full border border-slate-300 rounded-md px-3 py-2 text-sm"
              value={selectedProjectId}
              onChange={(e) => setSelectedProjectId(e.target.value)}
              disabled={loading}
            >
              <option value="">请选择项目</option>
              {projects.map(p => (
                <option key={p.id} value={p.id}>{p.name}</option>
              ))}
            </select>
          </label>
          <label className="block">
            <div className="text-sm font-semibold text-slate-700 mb-1">运行快照（Run）</div>
            <select
              className="w-full border border-slate-300 rounded-md px-3 py-2 text-sm"
              value={selectedRunId}
              onChange={(e) => setSelectedRunId(e.target.value)}
              disabled={loading || !selectedProjectId}
            >
              <option value="">请选择快照</option>
              {runs.map(r => (
                <option key={r.id} value={r.id}>{r.name}</option>
              ))}
            </select>
          </label>
        </div>

        {runDetail && (
          <div className="mt-4 text-xs text-slate-600">
            <div>快照创建：<span className="font-semibold text-slate-800">{runDetail.created_at}</span></div>
            <div>数据集引用：<span className="font-semibold text-slate-800">{runDetail.dataset_id ? 'dataset_id=' + runDetail.dataset_id : 'embedded_points（兜底）'}</span></div>
          </div>
        )}
      </div>

      <div id="section-report-params" className="scroll-mt-24 p-6 bg-white rounded-xl shadow-lg">
        <h3 className="text-lg font-bold text-slate-800 mb-4">报告参数</h3>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <label className="block">
            <div className="text-sm font-semibold text-slate-700 mb-1">项目总投资（万元）<span className="text-red-600">*</span></div>
            <input
              className="w-full border border-slate-300 rounded-md px-3 py-2 text-sm"
              value={totalInvestmentWanyuanText}
              onChange={(e) => setTotalInvestmentWanyuanText(e.target.value)}
              placeholder="例如：1200"
              inputMode="decimal"
            />
            <div className="text-xs text-slate-500 mt-1">口径：报告固定以此输入为准（不自动用 economics 计算得到的 CAPEX）。</div>
          </label>
          <label className="block">
            <div className="text-sm font-semibold text-slate-700 mb-1">业主方名称（可选）</div>
            <input className="w-full border border-slate-300 rounded-md px-3 py-2 text-sm" value={ownerName} onChange={(e) => setOwnerName(e.target.value)} placeholder="例如：xx 工业园" />
          </label>
          <label className="block">
            <div className="text-sm font-semibold text-slate-700 mb-1">项目地点（可选）</div>
            <input className="w-full border border-slate-300 rounded-md px-3 py-2 text-sm" value={projectLocation} onChange={(e) => setProjectLocation(e.target.value)} placeholder="例如：江苏·苏州" />
          </label>
          <label className="block">
            <div className="text-sm font-semibold text-slate-700 mb-1">编制单位/作者（可选）</div>
            <input className="w-full border border-slate-300 rounded-md px-3 py-2 text-sm" value={authorOrg} onChange={(e) => setAuthorOrg(e.target.value)} placeholder="例如：xxx 能源科技有限公司" />
          </label>
          <label className="block md:col-span-2">
            <div className="text-sm font-semibold text-slate-700 mb-1">封面副标题（可选）</div>
            <input className="w-full border border-slate-300 rounded-md px-3 py-2 text-sm" value={subtitle} onChange={(e) => setSubtitle(e.target.value)} placeholder="例如：基于项目运行数据与分时电价配置的模拟分析" />
          </label>
          <label className="block md:col-span-2">
            <div className="text-sm font-semibold text-slate-700 mb-1">Logo（可选）</div>
            <div className="flex items-center gap-3">
              <input
                type="file"
                accept="image/*"
                onChange={async (e) => {
                  const file = e.target.files?.[0];
                  if (!file) return;
                  try {
                    const dataUrl = await readFileAsDataUrl(file);
                    setLogoDataUrl(dataUrl);
                  } catch (err) {
                    setError(err instanceof Error ? err.message : String(err));
                  }
                }}
              />
              {logoDataUrl && (
                <button
                  type="button"
                  onClick={() => setLogoDataUrl(null)}
                  className="text-xs px-3 py-1.5 rounded border border-slate-300 text-slate-700 hover:bg-slate-50"
                >清除</button>
              )}
            </div>
          </label>
        </div>

        <div className="mt-4 flex items-center gap-2 text-sm">
          <input
            id="tryFetchTypicalCurves"
            type="checkbox"
            className="accent-blue-600"
            checked={tryFetchTypicalCurves}
            onChange={(e) => setTryFetchTypicalCurves(e.target.checked)}
          />
          <label htmlFor="tryFetchTypicalCurves" className="select-none text-slate-700">
            导出前尝试拉取典型日曲线（收益最高日/最大负荷日）
          </label>
        </div>
        <div className="mt-3 flex items-center gap-2 text-sm">
          <input
            id="aiPolishEnabled"
            type="checkbox"
            className="accent-blue-600"
            checked={aiPolishEnabled}
            onChange={(e) => setAiPolishEnabled(e.target.checked)}
          />
          <label htmlFor="aiPolishEnabled" className="select-none text-slate-700">
            AI 文案润色（可选；失败自动降级；严禁编造/改写数值）
          </label>
        </div>

        <div className="mt-5 grid grid-cols-1 md:grid-cols-2 gap-4">
          <label className="block">
            <div className="text-sm font-semibold text-slate-700 mb-1">收益最高日（可手动选择覆盖默认）</div>
            <select
              className="w-full border border-slate-300 rounded-md px-3 py-2 text-sm"
              value={bestProfitDayOverride}
              onChange={(e) => setBestProfitDayOverride(e.target.value)}
              disabled={loading}
            >
              <option value="">自动（按 cycles 日收益最大）</option>
              {cycleDayOptions.map((d) => (
                <option key={d} value={d}>{d}</option>
              ))}
            </select>
            <div className="text-xs text-slate-500 mt-1">来源：cycles 日度结果 days[].date。</div>
          </label>
          <label className="block">
            <div className="text-sm font-semibold text-slate-700 mb-1">最大负荷日（可手动选择覆盖默认）</div>
            <select
              className="w-full border border-slate-300 rounded-md px-3 py-2 text-sm"
              value={maxLoadDayOverride}
              onChange={(e) => setMaxLoadDayOverride(e.target.value)}
              disabled={loading}
            >
              <option value="">自动（按负荷点位日最大负荷）</option>
              {loadDayOptions.map((d) => (
                <option key={d} value={d}>{d}</option>
              ))}
            </select>
            <div className="text-xs text-slate-500 mt-1">来源：数据集/快照点位 timestamp。</div>
          </label>
        </div>
      </div>

      <div id="section-report-actions" className="scroll-mt-24 p-6 bg-white rounded-xl shadow-lg">
        <h3 className="text-lg font-bold text-slate-800 mb-4">操作</h3>
        <div className="flex flex-wrap items-center gap-3">
          <button
            type="button"
            disabled={loading}
            onClick={handlePreviewHtml}
            className="px-4 py-2 rounded-md font-semibold text-sm bg-slate-800 text-white hover:bg-slate-900 disabled:opacity-50"
          >生成预览（A4）</button>
          <button
            type="button"
            disabled={loading || !previewHtml}
            onClick={handleOpenPreviewWindow}
            className="px-4 py-2 rounded-md font-semibold text-sm bg-slate-100 text-slate-800 border border-slate-300 hover:bg-slate-50 disabled:opacity-50"
          >在新窗口打开预览</button>
          <button
            type="button"
            disabled={loading || !previewHtml}
            onClick={() => setPreviewHtml('')}
            className="px-4 py-2 rounded-md font-semibold text-sm bg-slate-100 text-slate-800 border border-slate-300 hover:bg-slate-50 disabled:opacity-50"
          >清空预览</button>
          <button
            type="button"
            disabled={loading}
            onClick={() => handleExportPdf(false)}
            className="px-4 py-2 rounded-md font-semibold text-sm bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-50"
          >导出 PDF</button>
          <button
            type="button"
            disabled={loading}
            onClick={() => handleExportPdf(true)}
            className="px-4 py-2 rounded-md font-semibold text-sm bg-emerald-600 text-white hover:bg-emerald-700 disabled:opacity-50"
          >导出并写入当前 Run 附件</button>
        </div>
        <div className="mt-4 flex items-center gap-3">
          <div className="text-xs text-slate-600">预览缩放：</div>
          <input
            type="range"
            min={0.7}
            max={1.1}
            step={0.05}
            value={previewScale}
            onChange={(e) => setPreviewScale(Number(e.target.value))}
            disabled={!previewHtml}
          />
          <div className="text-xs text-slate-700 w-12">{Math.round(previewScale * 100)}%</div>
        </div>
        <div className="mt-3 text-xs text-slate-500">
          提示：PDF 导出依赖后端 Playwright（首次需执行 `python -m playwright install chromium`），若提示依赖缺失请按报错信息安装。
        </div>

        {error && (
          <div className="mt-4 p-3 bg-red-50 border border-red-200 rounded text-sm text-red-700">{error}</div>
        )}
        {notice && (
          <div className="mt-4 p-3 bg-emerald-50 border border-emerald-200 rounded text-sm text-emerald-700">{notice}</div>
        )}
        <div className="mt-4 text-sm text-slate-600 min-h-[1.25rem]">{loading ? '处理中…' : ''}</div>

        {baseReportData && (
          <div className="mt-5 text-xs text-slate-600">
            <div>将生成报告：<span className="font-semibold text-slate-800">{baseReportData.meta.project_name}</span>（{baseReportData.meta.period_start} ~ {baseReportData.meta.period_end}）</div>
            {baseReportData.completeness.missing_items.length > 0 && (
              <div className="mt-2">
                <div className="font-semibold text-amber-700">缺失项（允许导出但会占位提示）：</div>
                <ul className="list-disc pl-5 mt-1">
                  {baseReportData.completeness.missing_items.map((it) => (
                    <li key={it}>{it}</li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        )}
      </div>

      {previewHtml && (
        <div id="section-report-preview" className="scroll-mt-24 p-6 bg-white rounded-xl shadow-lg">
          <h3 className="text-lg font-bold text-slate-800 mb-4">A4 预览</h3>
          <div className="bg-slate-100 border border-slate-200 rounded-lg p-4 overflow-auto">
            <div
              style={{
                transform: `scale(${previewScale})`,
                transformOrigin: 'top left',
                width: '210mm',
                height: '297mm',
              }}
            >
              <iframe
                title="report-preview"
                style={{
                  width: '210mm',
                  height: '297mm',
                  border: '1px solid #cbd5e1',
                  borderRadius: 8,
                  background: '#fff',
                }}
                srcDoc={previewHtml}
              />
            </div>
          </div>
          <div className="mt-2 text-xs text-slate-500">说明：此预览用于快速检查分页与版式；最终 PDF 以 Playwright 渲染结果为准。</div>
        </div>
      )}
    </div>
  );
};
