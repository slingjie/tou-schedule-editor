import React, { useState, useCallback, useMemo } from 'react';
import type { 
  BackendAnalysisMeta, 
  BackendQualityReport, 
  BackendStorageCyclesResponse 
} from '../types';
import type { StorageParamsPayload } from '../storageApi';
import { generateProjectSummary } from '../summaryApi';
import type { ProjectSummaryRequest, ProjectSummaryResponse } from '../summaryApi';

interface ProjectSummaryPageProps {
  loadMeta: BackendAnalysisMeta | null;
  loadQuality: BackendQualityReport | null;
  storageCyclesResult: BackendStorageCyclesResponse | null;
  storageCyclesPayload: StorageParamsPayload | null;
}

export const ProjectSummaryPage: React.FC<ProjectSummaryPageProps> = ({
  loadMeta,
  loadQuality,
  storageCyclesResult,
  storageCyclesPayload,
}) => {
  const [projectName, setProjectName] = useState<string>('');
  const [projectLocation, setProjectLocation] = useState<string>('');
  const [periodStart, setPeriodStart] = useState<string>('');
  const [periodEnd, setPeriodEnd] = useState<string>('');
  const [isGenerating, setIsGenerating] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);
  const [reportResult, setReportResult] = useState<ProjectSummaryResponse | null>(null);

  // 自动填充周期范围（从 loadMeta）
  useMemo(() => {
    if (loadMeta && !periodStart && !periodEnd) {
      if (loadMeta.start_date) setPeriodStart(loadMeta.start_date);
      if (loadMeta.end_date) setPeriodEnd(loadMeta.end_date);
    }
  }, [loadMeta, periodStart, periodEnd]);

  // 构建负荷特征摘要
  const buildLoadProfile = useCallback((): Record<string, any> | undefined => {
    console.log('🔍 [buildLoadProfile] 开始构建负荷数据');
    console.log('🔍 [buildLoadProfile] loadMeta:', loadMeta);
    
    if (!loadMeta) {
      console.warn('⚠️ [buildLoadProfile] loadMeta 为空，返回 undefined');
      return undefined;
    }
    
    const avgLoad = Number(loadMeta.avg_load_kw) || 0;
    const maxLoad = Number(loadMeta.max_load_kw) || 0;
    const minLoad = Number(loadMeta.min_load_kw) || 0;
    
    console.log('🔍 [buildLoadProfile] 解析后的值:', { avgLoad, maxLoad, minLoad });
    
    const result = {
      avgLoad: `约 ${avgLoad.toFixed(2)} kW`,
      peakLoad: `约 ${maxLoad.toFixed(2)} kW`,
      valleyLoad: `约 ${minLoad.toFixed(2)} kW`,
      peakValleyDifferenceDescription: `峰谷差约 ${(maxLoad - minLoad).toFixed(2)} kW`,
      workdayWeekendPattern: '（待补充工作日/周末对比）',
      dayNightPattern: '（待补充昼夜变化特征）',
      seasonalPattern: `评估周期：${loadMeta.start || ''} 至 ${loadMeta.end || ''}`,
      peakPeriods: '（待补充尖峰时段）',
      valleyPeriods: '（待补充低谷时段）',
      storageOpportunityWindows: '（待补充适合充放电时间窗）',
    };
    
    console.log('✅ [buildLoadProfile] 构建完成:', result);
    return result;
  }, [loadMeta]);

  // 构建数据质量报告摘要
  const buildQualityReport = useCallback((): Record<string, any> | undefined => {
    if (!loadQuality) return undefined;
    
    const totalMissingDays = loadQuality.missing?.summary?.total_missing_days || 0;
    const totalMissingHours = loadQuality.missing?.summary?.total_missing_hours || 0;
    
    return {
      loadMissingRateDescription: `缺失 ${totalMissingDays} 天，共 ${totalMissingHours} 小时`,
      loadCleaningSummary: '已进行数据清洗与插补',
      impactOnConclusion: totalMissingDays > 10 ? '数据缺失较多，建议谨慎解读结论' : '数据质量对结论影响较小',
    };
  }, [loadQuality]);

  // 构建储能配置摘要
  const buildStorageConfig = useCallback((): Record<string, any> | undefined => {
    console.log('🔍 [buildStorageConfig] 开始构建储能配置');
    console.log('🔍 [buildStorageConfig] storageCyclesPayload:', storageCyclesPayload);
    
    if (!storageCyclesPayload) {
      console.warn('⚠️ [buildStorageConfig] storageCyclesPayload 为空，返回 undefined');
      return undefined;
    }
    
    const storage = storageCyclesPayload.storage;
    if (!storage) {
      console.warn('⚠️ [buildStorageConfig] storageCyclesPayload.storage 为空');
      return undefined;
    }
    
    const capacityKwh = Number(storage.capacity_kwh) || 0;
    const cRate = Number(storage.c_rate) || 0.5;
    const powerKw = capacityKwh * cRate;
    const singleSideEff = Number(storage.single_side_efficiency) || 0.9;
    const socMin = Number(storage.soc_min) || 0.1;
    const socMax = Number(storage.soc_max) || 0.9;
    const chargeReserve = storage.reserve_charge_kw ? (storage.reserve_charge_kw / powerKw) : 0;
    const dischargeReserve = storage.reserve_discharge_kw ? (storage.reserve_discharge_kw / powerKw) : 0;
    
    const result = {
      capacityMWh: (capacityKwh / 1000).toFixed(2),
      powerMW: (powerKw / 1000).toFixed(2),
      configPerspective: '按容配置',
      efficiencyDescription: `往返效率约 ${(singleSideEff * singleSideEff * 100).toFixed(0)}%`,
      socRangeDescription: `SOC 范围 ${(socMin * 100).toFixed(0)}%-${(socMax * 100).toFixed(0)}%`,
      reserveMarginDescription: `充电余量 ${(chargeReserve * 100).toFixed(1)}%，放电余量 ${(dischargeReserve * 100).toFixed(1)}%`,
      operationObjectives: '削峰填谷、需量控制',
      constraintsImpact: 'SOC 和功率约束对结果有一定影响',
    };
    
    console.log('🔍 [buildStorageConfig] 提取的数据:', { capacityKwh, powerKw, singleSideEff, socMin, socMax });
    
    console.log('✅ [buildStorageConfig] 构建完成:', result);
    return result;
  }, [storageCyclesPayload]);

  // 构建储能测算结果摘要
  const buildStorageResults = useCallback((): Record<string, any> | undefined => {
    console.log('🔍 [buildStorageResults] 开始构建储能结果');
    console.log('🔍 [buildStorageResults] storageCyclesResult:', storageCyclesResult);
    
    if (!storageCyclesResult) {
      console.warn('⚠️ [buildStorageResults] storageCyclesResult 为空，返回 undefined');
      return undefined;
    }
    
    const yearData = storageCyclesResult.year;
    if (!yearData) {
      console.warn('⚠️ [buildStorageResults] yearData 为空');
      return undefined;
    }
    
    console.log('🔍 [buildStorageResults] yearData:', yearData);
    console.log('🔍 [buildStorageResults] yearData.profit:', yearData.profit);
    
    const equivalentCycles = Number(yearData.cycles) || 0;
    const totalRevenue = Number(yearData.profit?.main?.profit) || 0;
    
    console.log('🔍 [buildStorageResults] 提取的数据:', { equivalentCycles, totalRevenue });
    console.log('🔍 [buildStorageResults] totalRevenue计算: profit?.main?.profit =', yearData.profit?.main?.profit);
    
    const result = {
      effectiveAnnualCycles: `约 ${equivalentCycles.toFixed(1)} 次/年`,
      dailyCycles: `日均约 ${(equivalentCycles / 365).toFixed(2)} 次`,
      cyclePatternWorkdayWeekend: '（工作日与周末循环特征待细化）',
      utilizationHoursRangeDetail: `年度约 ${(equivalentCycles * 2).toFixed(0)} 小时`,
      energyUtilizationRatio: '（待补充能量利用比例）',
      utilizationIssues: '（待分析是否存在闲置或电量不足现象）',
      firstYearRevenueDetail: `约 ${(totalRevenue / 10000).toFixed(2)} 万元`,
      revenueComponents: '（待拆分削峰、需量、套利收益）',
      revenuePerUnitJudgement: totalRevenue > 0 ? '收益水平中等偏上' : '收益较低',
      paybackPeriodDescription: '（待补充回收期估算）',
      sensitivitySummary: '对电价变化和利用小时数较为敏感',
    };
    
    console.log('✅ [buildStorageResults] 构建完成:', result);
    return result;
  }, [storageCyclesResult]);

  // 生成报告
  const handleGenerate = useCallback(async () => {
    if (!projectName.trim()) {
      setError('请输入项目名称');
      return;
    }
    if (!periodStart || !periodEnd) {
      setError('请输入评估周期');
      return;
    }

    // 数据完整性检查和警告
    const loadProfile = buildLoadProfile();
    const storageConfig = buildStorageConfig();
    const storageResults = buildStorageResults();
    const qualityReport = buildQualityReport();

    const missingData = [];
    if (!loadProfile) missingData.push('负荷数据');
    if (!storageConfig) missingData.push('储能配置');
    if (!storageResults) missingData.push('储能测算结果');

    if (missingData.length > 0) {
      const confirmMsg = `警告：以下数据未准备完整：${missingData.join('、')}。\n\n报告中这些部分的内容会显示为"当前数据暂不足以给出可靠结论"。\n\n是否继续生成？`;
      if (!window.confirm(confirmMsg)) {
        return;
      }
    }

    setIsGenerating(true);
    setError(null);
    setReportResult(null);

    try {
      const request: ProjectSummaryRequest = {
        project_name: projectName,
        project_location: projectLocation,
        period_start: periodStart,
        period_end: periodEnd,
        load_profile: loadProfile,
        tou_config: undefined, // TODO: 可从 scheduleData 构建
        storage_config: storageConfig,
        storage_results: storageResults,
        quality_report: qualityReport,
      };

      console.log('📤 [handleGenerate] 准备发送请求到后端');
      console.log('📤 [handleGenerate] 完整请求数据:', JSON.stringify(request, null, 2));

      const response = await generateProjectSummary(request);
      
      console.log('📥 [handleGenerate] 收到后端响应:', response);
      setReportResult(response);
    } catch (err: any) {
      console.error('生成报告失败:', err);
      setError(err.message || '生成报告时发生未知错误');
    } finally {
      setIsGenerating(false);
    }
  }, [
    projectName,
    projectLocation,
    periodStart,
    periodEnd,
    buildLoadProfile,
    buildStorageConfig,
    buildStorageResults,
    buildQualityReport,
  ]);

  // 复制 Markdown
  const handleCopyMarkdown = useCallback(() => {
    if (!reportResult) return;
    navigator.clipboard.writeText(reportResult.markdown).then(
      () => alert('已复制 Markdown 到剪贴板'),
      (err) => console.error('复制失败:', err)
    );
  }, [reportResult]);

  // 下载 Markdown
  const handleDownloadMarkdown = useCallback(() => {
    if (!reportResult) return;
    const blob = new Blob([reportResult.markdown], { type: 'text/markdown;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${reportResult.project_name}_评估报告_${reportResult.report_id}.md`;
    a.click();
    URL.revokeObjectURL(url);
  }, [reportResult]);

  return (
    <div className="max-w-6xl mx-auto p-6 space-y-6">
      <div className="bg-white rounded-lg shadow-md p-6">
        <h1 className="text-2xl font-bold text-slate-800 mb-4">项目评估报告生成</h1>
        <p className="text-slate-600 mb-6">
          基于 DeepSeek 大模型，自动生成项目评估报告（面向业主方）。请先完成负荷数据上传和储能测算，然后填写项目信息并点击生成。
        </p>

        {/* 参数输入 */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-6">
          <div>
            <label className="block text-sm font-semibold text-slate-700 mb-2">
              项目名称 <span className="text-red-500">*</span>
            </label>
            <input
              type="text"
              value={projectName}
              onChange={(e) => setProjectName(e.target.value)}
              className="w-full px-3 py-2 border border-slate-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
              placeholder="例如：某某医院储能项目"
            />
          </div>
          <div>
            <label className="block text-sm font-semibold text-slate-700 mb-2">项目地点</label>
            <input
              type="text"
              value={projectLocation}
              onChange={(e) => setProjectLocation(e.target.value)}
              className="w-full px-3 py-2 border border-slate-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
              placeholder="例如：安徽省某市"
            />
          </div>
          <div>
            <label className="block text-sm font-semibold text-slate-700 mb-2">
              评估周期开始 <span className="text-red-500">*</span>
            </label>
            <input
              type="date"
              value={periodStart}
              onChange={(e) => setPeriodStart(e.target.value)}
              className="w-full px-3 py-2 border border-slate-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
          </div>
          <div>
            <label className="block text-sm font-semibold text-slate-700 mb-2">
              评估周期结束 <span className="text-red-500">*</span>
            </label>
            <input
              type="date"
              value={periodEnd}
              onChange={(e) => setPeriodEnd(e.target.value)}
              className="w-full px-3 py-2 border border-slate-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
          </div>
        </div>

        {/* 数据状态提示 */}
        <div className="bg-slate-50 rounded-md p-4 mb-6 space-y-2">
          <h3 className="font-semibold text-slate-700 mb-2">数据状态检查</h3>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-2 text-sm">
            <div className={loadMeta ? 'text-green-600' : 'text-slate-400'}>
              {loadMeta ? '✓ 负荷数据已上传' : '○ 负荷数据未上传'}
            </div>
            <div className={loadQuality ? 'text-green-600' : 'text-slate-400'}>
              {loadQuality ? '✓ 质量报告已生成' : '○ 质量报告未生成'}
            </div>
            <div className={storageCyclesResult ? 'text-green-600' : 'text-slate-400'}>
              {storageCyclesResult ? '✓ 储能测算已完成' : '○ 储能测算未完成'}
            </div>
          </div>
          {!loadMeta && (
            <p className="text-sm text-amber-600 mt-2">
              提示：建议先完成负荷数据上传和储能测算，报告内容会更加完整。
            </p>
          )}
        </div>

        {/* 生成按钮 */}
        <div className="flex gap-4">
          <button
            onClick={handleGenerate}
            disabled={isGenerating || !projectName.trim() || !periodStart || !periodEnd}
            className={`px-6 py-3 rounded-md font-semibold text-white transition-colors ${
              isGenerating || !projectName.trim() || !periodStart || !periodEnd
                ? 'bg-slate-400 cursor-not-allowed'
                : 'bg-blue-600 hover:bg-blue-700'
            }`}
          >
            {isGenerating ? '生成中...' : '生成项目评估报告'}
          </button>
          {isGenerating && (
            <div className="flex items-center text-slate-600">
              <svg className="animate-spin h-5 w-5 mr-2" viewBox="0 0 24 24">
                <circle
                  className="opacity-25"
                  cx="12"
                  cy="12"
                  r="10"
                  stroke="currentColor"
                  strokeWidth="4"
                  fill="none"
                />
                <path
                  className="opacity-75"
                  fill="currentColor"
                  d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
                />
              </svg>
              <span>正在调用 DeepSeek 生成报告，预计 10-30 秒...</span>
            </div>
          )}
        </div>

        {/* 错误提示 */}
        {error && (
          <div className="mt-4 p-4 bg-red-50 border border-red-200 rounded-md text-red-700">
            <strong>错误：</strong> {error}
          </div>
        )}
      </div>

      {/* 报告结果 */}
      {reportResult && (
        <div className="bg-white rounded-lg shadow-md p-6">
          <div className="flex justify-between items-center mb-4">
            <div>
              <h2 className="text-xl font-bold text-slate-800">
                {reportResult.project_name} - 评估报告
              </h2>
              <p className="text-sm text-slate-500">
                生成时间：{new Date(reportResult.generated_at).toLocaleString('zh-CN')} | 
                报告 ID：{reportResult.report_id}
              </p>
            </div>
            <div className="flex gap-2">
              <button
                onClick={handleCopyMarkdown}
                className="px-4 py-2 bg-slate-600 hover:bg-slate-700 text-white rounded-md font-semibold text-sm transition-colors"
              >
                复制 Markdown
              </button>
              <button
                onClick={handleDownloadMarkdown}
                className="px-4 py-2 bg-green-600 hover:bg-green-700 text-white rounded-md font-semibold text-sm transition-colors"
              >
                下载 Markdown
              </button>
            </div>
          </div>

          {/* 关键摘要 */}
          {reportResult.summary && Object.keys(reportResult.summary).length > 0 && (
            <div className="mb-6 p-4 bg-blue-50 border border-blue-200 rounded-md">
              <h3 className="font-semibold text-blue-900 mb-2">关键摘要</h3>
              <ul className="space-y-1 text-sm text-blue-800">
                {reportResult.summary.firstYearRevenue && (
                  <li>• 首年总收益：{reportResult.summary.firstYearRevenue}</li>
                )}
                {reportResult.summary.dailyCycles && (
                  <li>• 日均循环次数：{reportResult.summary.dailyCycles}</li>
                )}
                {reportResult.summary.utilizationHoursRange && (
                  <li>• 利用小时数：{reportResult.summary.utilizationHoursRange}</li>
                )}
                {reportResult.summary.loadDataCompleteness && (
                  <li>• 数据完整性：{reportResult.summary.loadDataCompleteness}</li>
                )}
              </ul>
            </div>
          )}

          {/* Markdown 预览 */}
          <div className="prose prose-slate max-w-none">
            <div className="p-4 bg-slate-50 rounded-md border border-slate-200 max-h-[600px] overflow-y-auto">
              <pre className="whitespace-pre-wrap text-sm font-mono">{reportResult.markdown}</pre>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
