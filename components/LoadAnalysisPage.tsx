import React, { useState, useRef, useEffect, useCallback, useMemo } from 'react';
import type { Schedule, DateRule, BackendQualityReport, BackendAnalysisMeta, MonthlyTouPrices } from '../types';
import type { LoadDataPoint } from '../utils';
import { analyzeLoadFile } from '../loadApi';
// 使用 ECharts 渲染时间轴折线图
// 使用 ECharts 渲染时间轴折线图
import { EChartTimeSeries } from './EChartTimeSeries';
import { MonthlyAverageStackedChart } from './MonthlyAverageStackedChart';
import { YearlyAverageStackedChart } from './YearlyAverageStackedChart';
import { MonthlyLoadPriceOverlayChart } from './MonthlyLoadPriceOverlayChart';

// 已移除“5. 储能策略计算”功能相关类型与逻辑

interface LoadAnalysisPageProps {
  scheduleData: {
    monthlySchedule: Schedule;
    dateRules: DateRule[];
    prices: MonthlyTouPrices;
  };
  externalCleanedData?: LoadDataPoint[];
  externalQualityReport?: BackendQualityReport | null;
  externalMetaInfo?: BackendAnalysisMeta | null;
  hideUploader?: boolean;
}

const DataTable: React.FC<{ data: LoadDataPoint[] }> = ({ data }) => {
  const [currentPage, setCurrentPage] = useState(1);
  const rowsPerPage = 10;
  const totalPages = Math.ceil(data.length / rowsPerPage);
  const paginatedData = data.slice((currentPage - 1) * rowsPerPage, currentPage * rowsPerPage);

  return (
    <div className="mt-4">
      <div className="overflow-x-auto border border-slate-200 rounded-lg">
        <table className="min-w-full divide-y divide-slate-200">
          <thead className="bg-slate-50">
            <tr>
              <th className="px-6 py-3 text-left text-xs font-medium text-slate-500 uppercase tracking-wider">时间戳</th>
              <th className="px-6 py-3 text-left text-xs font-medium text-slate-500 uppercase tracking-wider">负荷 (kW)</th>
            </tr>
          </thead>
          <tbody className="bg-white divide-y divide-slate-200">
            {paginatedData.map((row, index) => (
              <tr key={index}>
                <td className="px-6 py-4 whitespace-nowrap text-sm text-slate-700">{row.timestamp.toLocaleString()}</td>
                <td className="px-6 py-4 whitespace-nowrap text-sm text-slate-700">{row.load.toFixed(3)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {totalPages > 1 && (
        <div className="flex justify-between items-center mt-3 text-sm">
          <button
            onClick={() => setCurrentPage((p) => Math.max(1, p - 1))}
            disabled={currentPage === 1}
            className="px-3 py-1 border border-slate-300 rounded-md disabled:opacity-50"
          >
            上一页
          </button>
          <span>
            第 {currentPage} 页 / 共 {totalPages} 页
          </span>
          <button
            onClick={() => setCurrentPage((p) => Math.min(totalPages, p + 1))}
            disabled={currentPage === totalPages}
            className="px-3 py-1 border border-slate-300 rounded-md disabled:opacity-50"
          >
            下一页
          </button>
        </div>
      )}
    </div>
  );
};

const QualityReportPanelInternal: React.FC<{ report: BackendQualityReport; meta: BackendAnalysisMeta | null }> = ({ report, meta }) => {
  const missingDayCount = report.missing.missing_days.length;
  const totalMissingHours = report.missing.summary?.total_missing_hours ?? 0;
  const missingByMonth = report.missing.missing_hours_by_month || [];

  const formatPercent = (value: number) => `${(value * 100).toFixed(2)}%`;
  const formatDateTime = (value: string | null | undefined) => (value ? new Date(value).toLocaleString() : '—');
  const anomalyLabel: Record<string, string> = {
    null: '空值',
    zero: '零值',
    negative: '负值',
  };

  return (
    <div className="p-6 bg-white rounded-xl shadow-lg">
      <h2 className="text-2xl font-bold text-slate-800 mb-4">4. 数据完整性分析报告</h2>
      
      {/* 基础信息 */}
      <div className="grid gap-4 md:grid-cols-2 mb-6">
        <div className="p-4 bg-slate-50 rounded-lg border border-slate-200">
          <h3 className="text-sm font-semibold text-slate-600 mb-3">基础信息</h3>
          <p className="text-sm text-slate-700">时间范围：{formatDateTime(meta?.start)} 至 {formatDateTime(meta?.end)}</p>
          <p className="text-sm text-slate-700">原始记录数：{meta?.total_records ?? 0}</p>
          <p className="text-sm text-slate-700">采样间隔：{meta?.source_interval_minutes ?? '-'} 分钟</p>
        </div>
        
        <div className="p-4 bg-slate-50 rounded-lg border border-slate-200">
          <h3 className="text-sm font-semibold text-slate-600 mb-3">缺失总体情况</h3>
          <p className="text-sm text-slate-700">缺失天数：{missingDayCount} 天</p>
          <p className="text-sm text-slate-700">缺失小时数：{totalMissingHours} 小时</p>
          <p className="text-sm text-slate-700">
            完整度：
            {meta?.total_records ? (
              `${(100 - (totalMissingHours / ((meta.total_records / (meta.source_interval_minutes || 60)) || 1) * 100)).toFixed(2)}%`
            ) : (
              '-'
            )}
          </p>
        </div>
      </div>

      {/* 按月分类缺失分析 */}
      <div className="mb-6">
        <h3 className="text-sm font-semibold text-slate-600 mb-3">按月分类缺失统计</h3>
        {missingByMonth.length === 0 ? (
          <p className="text-sm text-slate-700">无缺失数据。</p>
        ) : (
          <div className="overflow-x-auto border border-slate-200 rounded-lg">
            <table className="min-w-full divide-y divide-slate-200">
              <thead className="bg-slate-50">
                <tr>
                  <th className="px-6 py-3 text-left text-xs font-medium text-slate-500 uppercase">月份</th>
                  <th className="px-6 py-3 text-left text-xs font-medium text-slate-500 uppercase">缺失天数</th>
                  <th className="px-6 py-3 text-left text-xs font-medium text-slate-500 uppercase">缺失小时数</th>
                </tr>
              </thead>
              <tbody className="bg-white divide-y divide-slate-200">
                {missingByMonth.map((item) => (
                  <tr key={item.month}>
                    <td className="px-6 py-3 whitespace-nowrap text-sm text-slate-700">{item.month}</td>
                    <td className="px-6 py-3 whitespace-nowrap text-sm text-slate-700">{item.missing_days}</td>
                    <td className="px-6 py-3 whitespace-nowrap text-sm text-slate-700">{item.missing_hours}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* 缺失日期列表 */}
      {report.missing.missing_days.length > 0 && (
        <div className="mb-6">
          <h3 className="text-sm font-semibold text-slate-600 mb-3">缺失日期详情</h3>
          <div className="p-4 bg-slate-50 rounded-lg border border-slate-200">
            <div className="text-sm text-slate-700 space-y-1">
              {report.missing.missing_days.map((date) => (
                <p key={date}>• {date}</p>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* 异常值统计 */}
      <div className="mb-6">
        <h3 className="text-sm font-semibold text-slate-600 mb-3">异常值统计</h3>
        <div className="grid gap-4 md:grid-cols-3">
          {report.anomalies.map((item) => (
            <div key={item.kind} className="p-4 bg-slate-50 rounded-lg border border-slate-200">
              <p className="text-base font-semibold text-slate-800">{anomalyLabel[item.kind] ?? item.kind}</p>
              <p className="text-sm text-slate-700 mt-1">数量：{item.count}</p>
              <p className="text-sm text-slate-700">占比：{formatPercent(item.ratio)}</p>
              {item.samples.length > 0 && (
                <div className="mt-2">
                  <p className="text-xs text-slate-500">
                    示例：{item.samples.join(', ')}
                  </p>
                  {item.samples.length > 3 && (
                    <p className="text-xs text-slate-400 mt-1">共 {item.samples.length} 个时间戳</p>
                  )}
                </div>
              )}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
};

export const LoadAnalysisPage: React.FC<LoadAnalysisPageProps> = ({ scheduleData, externalCleanedData, externalQualityReport, externalMetaInfo, hideUploader }) => {
  const [cleanedData, setCleanedData] = useState<LoadDataPoint[]>([]);
  const [qualityReport, setQualityReport] = useState<BackendQualityReport | null>(null);
  const [metaInfo, setMetaInfo] = useState<BackendAnalysisMeta | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [showSlowNotice, setShowSlowNotice] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showBreakLabels, setShowBreakLabels] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const chartRef = useRef<HTMLCanvasElement>(null);
  const chartInstanceRef = useRef<any>(null);
  const echartResetRef = useRef<() => void>(() => {});
  
  // 视图数据优先使用外部传入（全局上传）
  const viewedData: LoadDataPoint[] = (externalCleanedData && externalCleanedData.length > 0) ? externalCleanedData : cleanedData;
  const viewedQuality: BackendQualityReport | null = (externalQualityReport !== undefined ? externalQualityReport : qualityReport);
  const viewedMeta: BackendAnalysisMeta | null = (externalMetaInfo !== undefined ? externalMetaInfo : metaInfo);
  
  // 粒度切换：15分钟(kW) 与 1小时平均(kW)
  const [granularity, setGranularity] = useState<'15m' | '1h-avg'>(
    '15m'
  );
  
  // 根据粒度生成绘图序列
  const displaySeries = useMemo(() => {
    const sorted = [...viewedData].sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());
    if (granularity === '15m') {
      // 如实使用原始功率点（常见为15分钟）
      return sorted.map((d) => ({ x: d.timestamp, y: d.load }));
    }
    // 1小时平均(kW)：对同一小时内的kW样本求均值
    const buckets = new Map<number, { sum: number; count: number }>();
    for (const d of sorted) {
      if (!d || !(d.timestamp instanceof Date) || !Number.isFinite(d.load)) continue;
      const hKey = new Date(
        d.timestamp.getFullYear(),
        d.timestamp.getMonth(),
        d.timestamp.getDate(),
        d.timestamp.getHours(),
        0, 0, 0
      ).getTime();
      const cur = buckets.get(hKey) || { sum: 0, count: 0 };
      cur.sum += d.load;
      cur.count += 1;
      buckets.set(hKey, cur);
    }
    const result = Array.from(buckets.entries())
      .map(([ts, agg]) => ({ x: new Date(ts), y: agg.count > 0 ? agg.sum / agg.count : 0 }))
      .sort((a, b) => a.x.getTime() - b.x.getTime());
    return result;
  }, [viewedData, granularity]);
  const resetZoom = useCallback(() => {
    if (echartResetRef.current) echartResetRef.current();
  }, []);


  useEffect(() => {
    let timer: number | undefined;
    if (isLoading) {
      timer = window.setTimeout(() => setShowSlowNotice(true), 5000);
    } else {
      setShowSlowNotice(false);
    }
    return () => {
      if (timer) {
        window.clearTimeout(timer);
      }
    };
  }, [isLoading]);

  const handleFileChange = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;

    setIsLoading(true);
    setError(null);
    setCleanedData([]);
    setQualityReport(null);
    setMetaInfo(null);

    try {
      console.debug('[LoadAnalysis] 选中文件', { name: file.name, size: file.size, type: file.type });
      const response = await analyzeLoadFile(file);
      console.debug('[LoadAnalysis] 后端返回 meta/report 概览', {
        meta: response?.meta,
        reportKinds: response?.report?.anomalies?.map((a) => a.kind),
        cleaned: response?.cleaned_points?.length,
      });
      const normalized = response.cleaned_points
        .map(({ timestamp, load_kwh }) => {
          const parsed = new Date(timestamp);
          if (Number.isNaN(parsed.getTime())) {
            return null;
          }
          const loadValue = Number(load_kwh);
          return {
            timestamp: parsed,
            load: Number.isFinite(loadValue) ? loadValue : 0,
          } as LoadDataPoint;
        })
        .filter((item): item is LoadDataPoint => item !== null);

      if (normalized.length === 0) {
        throw new Error('后端未返回有效的小时级数据。');
      }

      console.debug('[LoadAnalysis] 规范化条数', normalized.length);
      setCleanedData(normalized);
      setQualityReport(response.report);
      setMetaInfo(response.meta);
    } catch (err) {
      console.error('[LoadAnalysis] 处理失败', err);
      const message = err instanceof Error ? err.message : String(err);
      setError(`上传文件失败：${message}`);
      setCleanedData([]);
      setQualityReport(null);
      setMetaInfo(null);
    } finally {
      setIsLoading(false);
      setTimeout(() => {
        if (event.target) {
          event.target.value = '';
        }
      }, 0);
    }
  };

  // 原“储能策略计算”按钮及计算逻辑已删除

  useEffect(() => {
    // 已切换为 ECharts 渲染，彻底移除 Chart.js 相关逻辑以避免类型检查错误
    return;
  }, [viewedData]);

  const buttonClasses =
    'px-6 py-2 rounded-md font-semibold text-sm transition-colors focus:outline-none focus:ring-2 focus:ring-offset-2 disabled:opacity-50 disabled:cursor-not-allowed';

  const shouldShowUploader = !hideUploader && (!externalCleanedData || externalCleanedData.length === 0);
  const prefixCurve = shouldShowUploader ? '2. ' : '1. ';
  const prefixMonthly = shouldShowUploader ? '3. ' : '2. ';
  const prefixYearly = shouldShowUploader ? '4. ' : '3. ';
  const prefixOverlay = shouldShowUploader ? '5. ' : '4. ';

  return (
    <div className="space-y-8">
      {error && (
        <div className="p-4 bg-red-100 border border-red-400 text-red-700 rounded-lg" role="alert">
          <p className="font-bold">处理失败</p>
          <p>{error}</p>
        </div>
      )}

      {shouldShowUploader && (
        <div id="section-load-upload" className="scroll-mt-24 p-6 bg-white rounded-xl shadow-lg">
          <h2 className="text-2xl font-bold text-slate-800 mb-2">1. 上传负荷数据文件</h2>
          <p className="text-sm text-slate-600 mb-4">
            上传包含时间戳（或日期+时间）与负荷列的 Excel/CSV 文件（.xlsx / .csv），后端会自动完成清洗与小时级聚合。
          </p>
          <button
            onClick={() => fileInputRef.current?.click()}
            disabled={isLoading}
            className={`${buttonClasses} bg-blue-600 text-white hover:bg-blue-700 focus:ring-blue-500`}
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
          {cleanedData.length > 0 && !isLoading && (
            <>
              <p className="text-green-600 font-semibold mt-4">数据清洗完成，已整理为小时级负荷序列。</p>
              <DataTable data={cleanedData} />
            </>
          )}
        </div>
      )}

      {viewedData.length > 0 && (
        <div id="section-load-hour-curve" className="scroll-mt-24 p-6 bg-white rounded-xl shadow-lg">
          <h2 className="text-2xl font-bold text-slate-800 mb-4">{prefixCurve}小时负荷曲线</h2>
        <div className="relative h-96">
          <EChartTimeSeries
            data={displaySeries}
            height={384}
            showArea={false}
            useAxisBreak={true}
            showBreakLabels={showBreakLabels}
            onReady={(api) => { echartResetRef.current = api.resetZoom; }}
          />
        </div>
        {/* 已使用 ECharts 自带 slider dataZoom，此处不再渲染自定义滑块 */}
          <div className="flex items-center justify-between mt-2 text-xs text-slate-600">
            <span>提示：底部滑块拖动双柄/选区调整范围；拖拽平移；滚轮缩放；双击放大</span>
            <div className="flex items-center gap-3">
              {/* 粒度切换控件 */}
              <div className="inline-flex items-center gap-2 select-none">
                <span className="text-slate-700">粒度</span>
                <label className="inline-flex items-center gap-1 cursor-pointer">
                  <input
                    type="radio"
                    name="granularity"
                    className="accent-slate-600"
                    checked={granularity === '15m'}
                    onChange={() => setGranularity('15m')}
                  />
                  <span>15m (kW)</span>
                </label>
                <label className="inline-flex items-center gap-1 cursor-pointer">
                  <input
                    type="radio"
                    name="granularity"
                    className="accent-slate-600"
                    checked={granularity === '1h-avg'}
                    onChange={() => setGranularity('1h-avg')}
                  />
                  <span>1h (kW平均)</span>
                </label>
              </div>
              <label className="inline-flex items-center gap-1 select-none cursor-pointer">
                <input
                  type="checkbox"
                  className="accent-slate-600"
                  checked={showBreakLabels}
                  onChange={(e) => setShowBreakLabels(e.target.checked)}
                />
                <span>显示断轴时间标签</span>
              </label>
              <button onClick={resetZoom} className="px-2 py-1 border border-slate-300 rounded-md hover:bg-slate-50">重置缩放</button>
            </div>
          </div>
        </div>
      )}

      {viewedData.length > 0 && (
        <div id="section-monthly-stacked" className="scroll-mt-24 p-6 bg-white rounded-xl shadow-lg">
          <h2 className="text-2xl font-bold text-slate-800 mb-4">{prefixMonthly}月度日平均负荷堆叠图（0–24点）</h2>
          <MonthlyAverageStackedChart data={viewedData} height={384} />
        </div>
      )}

      {viewedData.length > 0 && (
        <div id="section-yearly-stacked" className="scroll-mt-24 p-6 bg-white rounded-xl shadow-lg">
          <h2 className="text-2xl font-bold text-slate-800 mb-4">{prefixYearly}年度日平均负荷堆叠图（0–24点）</h2>
          <YearlyAverageStackedChart data={viewedData} height={360} />
        </div>
      )}

      {viewedData.length > 0 && (
        <div id="section-monthly-overlay" className="scroll-mt-24 p-6 bg-white rounded-xl shadow-lg">
          <h2 className="text-2xl font-bold text-slate-800 mb-4">{prefixOverlay}电价时段与月日平均负荷曲线（双 Y 轴）</h2>
          <MonthlyLoadPriceOverlayChart
            data={viewedData}
            monthlySchedule={scheduleData.monthlySchedule}
            dateRules={scheduleData.dateRules}
            prices={(scheduleData as any).prices}
            height={384}
          />
        </div>
      )}

      {/* 本页说明（固定显示在页面底部） */}
      <div id="section-analysis-note" className="scroll-mt-24 p-4 bg-slate-50 rounded-lg border border-slate-300 text-sm text-slate-600">
        本页说明：本页包含四类可视化——“小时负荷曲线”、“月度日平均负荷堆叠图(0–24点)”、“年度日平均负荷堆叠图(0–24点)”与“电价时段与月日平均负荷双轴图”。
        其中双轴图横轴为时间，左轴为负荷(kW)，右轴为电价(元/kWh)，支持“按月默认规则/按日期规则”切换并可开关 TOU 背景。
        如上传数据量较大，首次渲染可能稍慢，属正常现象。
      </div>
    </div>
  );
};
