import React from 'react';
import type { BackendQualityReport, BackendAnalysisMeta } from '../types';

export const QualityReportPanel: React.FC<{ report: BackendQualityReport; meta: BackendAnalysisMeta | null }> = ({ report, meta }) => {
  const missingDayCount = report.missing.missing_days.length;
  const totalMissingHours = report.missing.summary?.total_missing_hours ?? 0;
  const missingByMonth = report.missing.missing_hours_by_month || [];
  const partialMissingDays = report.missing.partial_missing_days || [];
  const dailyAnomalies = report.daily_anomalies || [];
  
  // 新增的完整性统计
  const expectedDays = report.missing.summary?.expected_days ?? 365;
  const actualDays = report.missing.summary?.actual_days ?? 0;
  const completenessRatio = report.missing.summary?.completeness_ratio ?? 0;
  const totalPartialMissingDays = report.missing.summary?.total_partial_missing_days ?? 0;

  const formatPercent = (value: number) => `${(value * 100).toFixed(2)}%`;
  const formatDateTime = (value: string | null | undefined) => (value ? new Date(value).toLocaleString() : '—');
  const anomalyLabel: Record<string, string> = {
    null: '空值',
    zero: '零值',
    negative: '负值',
  };

  return (
    <div className="p-6 bg-white rounded-xl shadow-lg">
      <h2 className="text-2xl font-bold text-slate-800 mb-4">数据完整性分析报告</h2>

      {/* 基础信息 */}
      <div id="section-quality-base" className="scroll-mt-24 grid gap-4 md:grid-cols-2 mb-6">
        <div className="p-4 bg-slate-50 rounded-lg border border-slate-200">
          <h3 className="text-sm font-semibold text-slate-600 mb-3">基础信息</h3>
          <p className="text-sm text-slate-700">时间范围：{formatDateTime(meta?.start)} 至 {formatDateTime(meta?.end)}</p>
          <p className="text-sm text-slate-700">原始记录数：{meta?.total_records ?? 0}</p>
          <p className="text-sm text-slate-700">采样间隔：{meta?.source_interval_minutes ? `${meta.source_interval_minutes} 分钟` : '自动推断'}</p>
        </div>

        <div id="section-quality-missing-summary" className="p-4 bg-slate-50 rounded-lg border border-slate-200">
          <h3 className="text-sm font-semibold text-slate-600 mb-3">数据完整度（基于365天标准）</h3>
          <p className="text-sm text-slate-700">期望天数：{expectedDays} 天（从最后一天往前推365天）</p>
          <p className="text-sm text-slate-700">实际覆盖天数：{actualDays} 天</p>
          <p className="text-sm text-slate-700">完全缺失天数：{missingDayCount} 天</p>
          <p className="text-sm text-slate-700">部分缺失天数：{totalPartialMissingDays} 天</p>
          <p className="text-sm text-slate-700">缺失小时数：{totalMissingHours} 小时</p>
          <p className="text-sm font-semibold text-slate-800 mt-2">
            完整度：
            <span className={completenessRatio >= 0.95 ? 'text-green-600' : completenessRatio >= 0.8 ? 'text-yellow-600' : 'text-red-600'}>
              {formatPercent(completenessRatio)}
            </span>
          </p>
        </div>
      </div>

      {/* 按月分类缺失分析 */}
      <div id="section-quality-missing-month" className="scroll-mt-24 mb-6">
        <h3 className="text-sm font-semibold text-slate-600 mb-3">按月分类缺失统计</h3>
        {missingByMonth.length === 0 ? (
          <p className="text-sm text-slate-700">无缺失数据，数据完整。</p>
        ) : (
          <div className="overflow-x-auto border border-slate-200 rounded-lg">
            <table className="min-w-full divide-y divide-slate-200">
              <thead className="bg-slate-50">
                <tr>
                  <th className="px-6 py-3 text-left text-xs font-medium text-slate-500 uppercase">月份</th>
                  <th className="px-6 py-3 text-left text-xs font-medium text-slate-500 uppercase">完全缺失天数</th>
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
        <div id="section-quality-missing-days" className="scroll-mt-24 mb-6">
          <h3 className="text-sm font-semibold text-slate-600 mb-3">完全缺失日期列表（共 {missingDayCount} 天）</h3>
          <div className="p-4 bg-slate-50 rounded-lg border border-slate-200 max-h-48 overflow-y-auto">
            <div className="text-sm text-slate-700 grid grid-cols-2 md:grid-cols-4 lg:grid-cols-6 gap-2">
              {report.missing.missing_days.map((date) => (
                <div key={date} className="bg-red-50 text-red-700 px-2 py-1 rounded text-center">{date}</div>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* 部分缺失日期列表 */}
      {partialMissingDays.length > 0 && (
        <div id="section-quality-partial-missing" className="scroll-mt-24 mb-6">
          <h3 className="text-sm font-semibold text-slate-600 mb-3">部分缺失日期（共 {partialMissingDays.length} 天）</h3>
          <div className="overflow-x-auto border border-slate-200 rounded-lg max-h-48 overflow-y-auto">
            <table className="min-w-full divide-y divide-slate-200">
              <thead className="bg-slate-50 sticky top-0">
                <tr>
                  <th className="px-4 py-2 text-left text-xs font-medium text-slate-500 uppercase">日期</th>
                  <th className="px-4 py-2 text-left text-xs font-medium text-slate-500 uppercase">已有小时</th>
                  <th className="px-4 py-2 text-left text-xs font-medium text-slate-500 uppercase">缺失小时</th>
                </tr>
              </thead>
              <tbody className="bg-white divide-y divide-slate-200">
                {partialMissingDays.map((item) => (
                  <tr key={item.date}>
                    <td className="px-4 py-2 whitespace-nowrap text-sm text-slate-700">{item.date}</td>
                    <td className="px-4 py-2 whitespace-nowrap text-sm text-slate-700">{item.present_hours}/24</td>
                    <td className="px-4 py-2 whitespace-nowrap text-sm text-orange-600">{item.missing_hours}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* 异常值统计 */}
      <div id="section-quality-anomaly" className="scroll-mt-24 mb-6">
        <h3 className="text-sm font-semibold text-slate-600 mb-3">异常值统计（总体）</h3>
        <div className="grid gap-4 md:grid-cols-3">
          {report.anomalies.map((item) => (
            <div key={item.kind} className={`p-4 rounded-lg border ${
              item.count > 0 
                ? (item.kind === 'negative' ? 'bg-red-50 border-red-200' : item.kind === 'null' ? 'bg-orange-50 border-orange-200' : 'bg-yellow-50 border-yellow-200')
                : 'bg-slate-50 border-slate-200'
            }`}>
              <p className="text-base font-semibold text-slate-800">{anomalyLabel[item.kind] ?? item.kind}</p>
              <p className="text-sm text-slate-700 mt-1">数量：{item.count}</p>
              <p className="text-sm text-slate-700">占比：{formatPercent(item.ratio)}</p>
              {item.samples.length > 0 && (
                <div className="mt-2">
                  <p className="text-xs text-slate-500">示例时间点：</p>
                  <p className="text-xs text-slate-400">{item.samples.slice(0, 3).join(', ')}</p>
                  {item.samples.length > 3 && (
                    <p className="text-xs text-slate-400 mt-1">等 {item.count} 个记录</p>
                  )}
                </div>
              )}
            </div>
          ))}
        </div>
      </div>

      {/* 按天异常统计 */}
      {dailyAnomalies.length > 0 && (
        <div id="section-quality-daily-anomaly" className="scroll-mt-24 mb-6">
          <h3 className="text-sm font-semibold text-slate-600 mb-3">按天异常值详情（共 {dailyAnomalies.length} 天存在异常）</h3>
          <div className="overflow-x-auto border border-slate-200 rounded-lg max-h-64 overflow-y-auto">
            <table className="min-w-full divide-y divide-slate-200">
              <thead className="bg-slate-50 sticky top-0">
                <tr>
                  <th className="px-4 py-2 text-left text-xs font-medium text-slate-500 uppercase">日期</th>
                  <th className="px-4 py-2 text-left text-xs font-medium text-slate-500 uppercase">零值数</th>
                  <th className="px-4 py-2 text-left text-xs font-medium text-slate-500 uppercase">负值数</th>
                  <th className="px-4 py-2 text-left text-xs font-medium text-slate-500 uppercase">空值数</th>
                  <th className="px-4 py-2 text-left text-xs font-medium text-slate-500 uppercase">说明</th>
                </tr>
              </thead>
              <tbody className="bg-white divide-y divide-slate-200">
                {dailyAnomalies.map((item) => {
                  const notes: string[] = [];
                  if (item.zero_count > 0) notes.push(`零值${item.zero_count}条`);
                  if (item.negative_count > 0) notes.push(`负值${item.negative_count}条`);
                  if (item.null_count > 0) notes.push(`空值${item.null_count}条`);
                  return (
                    <tr key={item.date}>
                      <td className="px-4 py-2 whitespace-nowrap text-sm text-slate-700">{item.date}</td>
                      <td className={`px-4 py-2 whitespace-nowrap text-sm ${item.zero_count > 0 ? 'text-yellow-600 font-medium' : 'text-slate-400'}`}>
                        {item.zero_count || '-'}
                      </td>
                      <td className={`px-4 py-2 whitespace-nowrap text-sm ${item.negative_count > 0 ? 'text-red-600 font-medium' : 'text-slate-400'}`}>
                        {item.negative_count || '-'}
                      </td>
                      <td className={`px-4 py-2 whitespace-nowrap text-sm ${item.null_count > 0 ? 'text-orange-600 font-medium' : 'text-slate-400'}`}>
                        {item.null_count || '-'}
                      </td>
                      <td className="px-4 py-2 whitespace-nowrap text-xs text-slate-500">
                        {notes.join('，') || '—'}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* 连续零值区间功能已弃用，后端不再计算 */}
    </div>
  );
};

export default QualityReportPanel;
