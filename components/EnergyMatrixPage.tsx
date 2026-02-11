import React, { useEffect, useMemo, useRef, useState } from 'react';
import type { Schedule, DateRule, BackendAnalysisMeta, BackendQualityReport } from '../types';
import type { LoadDataPoint } from '../utils';
import { analyzeLoadFile } from '../loadApi';
import { EnergyMatrixTable } from './EnergyMatrixTable';
import { MonthlySummaryTable } from './MonthlySummaryTable';

interface EnergyMatrixPageProps {
  scheduleData: {
    monthlySchedule: Schedule;
    dateRules: DateRule[];
  };
  externalCleanedData?: LoadDataPoint[];
  hideUploader?: boolean;
}

export const EnergyMatrixPage: React.FC<EnergyMatrixPageProps> = ({ scheduleData, externalCleanedData, hideUploader }) => {
  const [cleanedData, setCleanedData] = useState<LoadDataPoint[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [showSlowNotice, setShowSlowNotice] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    let timer: number | undefined;
    if (isLoading) {
      timer = window.setTimeout(() => setShowSlowNotice(true), 5000);
    } else {
      setShowSlowNotice(false);
    }
    return () => {
      if (timer) window.clearTimeout(timer);
    };
  }, [isLoading]);

  const handleFileChange = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;

    setIsLoading(true);
    setError(null);
    setCleanedData([]);

    try {
      const response = await analyzeLoadFile(file);
      const normalized: LoadDataPoint[] = (response.cleaned_points || [])
        .map((p) => {
          const t = p?.timestamp ? new Date(p.timestamp) : null;
          const loadValue = Number(p?.load_kwh ?? 0);
          if (!t || isNaN(t.getTime())) return null;
          return { timestamp: t, load: Number.isFinite(loadValue) ? loadValue : 0 } as LoadDataPoint;
        })
        .filter((x): x is LoadDataPoint => x !== null);

      if (normalized.length === 0) {
        throw new Error('后端未返回有效的小时级数据。');
      }

      setCleanedData(normalized);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setError(`上传文件失败：${message}`);
      setCleanedData([]);
    } finally {
      setIsLoading(false);
      setTimeout(() => {
        if (event.target) event.target.value = '';
      }, 0);
    }
  };

  const viewed = (externalCleanedData && externalCleanedData.length > 0) ? externalCleanedData : cleanedData;
  const shouldShowUploader = !hideUploader && (!externalCleanedData || externalCleanedData.length === 0);

  return (
    <div className="space-y-8">
      {error && (
        <div className="p-4 bg-red-100 border border-red-400 text-red-700 rounded-lg" role="alert">
          <p className="font-bold">处理失败</p>
          <p>{error}</p>
        </div>
      )}

      {shouldShowUploader && (
        <div id="section-matrix-upload" className="scroll-mt-24 p-6 bg-white rounded-xl shadow-lg">
          <h2 className="text-2xl font-bold text-slate-800 mb-2">上传负荷数据文件（用于矩阵展示）</h2>
          <p className="text-sm text-slate-600 mb-4">上传 Excel/CSV，后端清洗为小时级数据后展示为“日×时”矩阵。</p>
          <button
            onClick={() => fileInputRef.current?.click()}
            disabled={isLoading}
            className={`px-6 py-2 rounded-md font-semibold text-sm transition-colors focus:outline-none focus:ring-2 focus:ring-offset-2 ${isLoading ? 'opacity-50 cursor-not-allowed' : ''} bg-blue-600 text-white hover:bg-blue-700 focus:ring-blue-500`}
          >
            {isLoading ? '处理中...' : '上传负荷文件（Excel/CSV）'}
          </button>
          <input
            type="file"
            ref={fileInputRef}
            onChange={handleFileChange}
            className="sr-only"
            accept=".xlsx,.csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,text/csv"
          />
          {showSlowNotice && isLoading && (
            <p className="text-sm text-slate-500 mt-3">文件较大，正在清洗中，请耐心等待…</p>
          )}
        </div>
      )}

      {viewed.length > 0 && (
        <div id="section-matrix-table" className="scroll-mt-24">
          <EnergyMatrixTable data={viewed} scheduleData={scheduleData} height={720} />
        </div>
      )}

      {viewed.length > 0 && (
        <div id="section-monthly-summary" className="scroll-mt-24">
          <MonthlySummaryTable data={viewed} scheduleData={scheduleData} />
        </div>
      )}

      {/* 本页说明（固定显示在页面底部） */}
      <div id="section-matrix-note" className="scroll-mt-24 p-4 bg-slate-50 rounded-lg border border-slate-300 text-sm text-slate-600">
        本页说明：将小时级用电量转换为“日×时”矩阵，并叠加 TOU 分时与运行逻辑标签，便于定位异常日/异常时段与班次规律。
        可按年份与月份筛选；全年模式下单元格数量较多（约 365×24），渲染可能偏慢，建议优先按月查看。
      </div>
    </div>
  );
};

export default EnergyMatrixPage;
