import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  MonthlyTouPrices,
  Schedule,
  DateRule,
  BackendStorageCyclesResponse,
  BackendTipDischargeSummary,
  CleaningAnalysisResponse,
  CleaningConfigRequest,
  ComparisonResult,
  CleaningResultResponse,
  DischargeStrategy,
} from '../types';
import type { LoadDataPoint } from '../utils';
import {
  computeStorageCycles,
  computeStorageCyclesWithProgress,
  analyzeDataForCleaning,
  applyDataCleaning,
  exportStorageCyclesReport,
  exportStorageBusinessReport,
  type StorageParamsPayload,
  BASE_URL as STORAGE_BACKEND_BASE_URL,
} from '../storageApi';
import UploadProgressRing from './UploadProgressRing';
import CleaningConfirmDialog from './CleaningConfirmDialog';
import { BatchCapacityChart } from './BatchCapacityChart';
import { STORAGE_PARAMS_TEMPLATES, type StorageParamsTemplate, DISCHARGE_STRATEGY_INFO } from '../constants';

const CONFIG_STORAGE_PREFIX = 'storageCyclesConfig:';
const USER_TEMPLATES_STORAGE_KEY = 'storageCyclesUserTemplates';
const SOLVE_CAPACITY_STEPS = 8; // 反推容量时默认预计算步数（可通过界面修改实际步数）

// 判断某天是否有有效的负荷数据
// 优先使用后端返回的 is_valid 字段，否则回退到前端判断逻辑
const hasValidDayData = (d: any): boolean => {
  if (!d) return false;
  
  // 优先使用后端的 is_valid 标记
  if (typeof d.is_valid === 'boolean') {
    return d.is_valid;
  }
  
  // 回退逻辑：cycles > 0 表示有效
  return Number(d.cycles ?? 0) > 0;
};

// 基于后端返回的日度 cycles 计算"全年合计等效循环数"
// 有效天数判断逻辑（由后端 is_valid 字段决定）：
// ✅ is_valid = true → 有效（该天有正负荷数据）
// ❌ is_valid = false → 无效（该天负荷数据为空或全为零）
// ❌ 完全没有日期记录 → 无效
const computeYearEquivalentCyclesFromDays = (
  days: BackendStorageCyclesResponse['days'] | undefined | null,
): number => {
  if (!days || !days.length) return 0;
  
  const validDaySet = new Set<string>();
  let totalCycles = 0;

  days.forEach(d => {
    if (!d?.date) return;
    const dateKey = String(d.date);
    const cyclesVal = Number(d.cycles ?? 0);
    
    // 使用后端的有效性判断
    if (hasValidDayData(d)) {
      validDaySet.add(dateKey);
    }
    totalCycles += cyclesVal;
  });

  const yearValidDays = validDaySet.size;
  
  // 全年等效循环数 = (总循环数 / 有效天数) × 365
  if (yearValidDays > 0) {
    return (totalCycles / yearValidDays) * 365;
  }
  return 0;
};

interface Props {
  scheduleData: {
    monthlySchedule: Schedule;
    dateRules: DateRule[];
    prices: MonthlyTouPrices;
  };
  externalCleanedData?: LoadDataPoint[] | null; // 来自“负荷分析”页的已上传点
  restoredCyclesRun?: { payload: StorageParamsPayload; response: BackendStorageCyclesResponse } | null;
  restoredVersion?: number;
  onNavigateProfit?: (date: string) => void;
  onLatestRunChange?: (payload: StorageParamsPayload, response: BackendStorageCyclesResponse) => void;
}

export const StorageCyclesPage: React.FC<Props> = ({
  scheduleData,
  externalCleanedData,
  restoredCyclesRun,
  restoredVersion,
  onNavigateProfit,
  onLatestRunChange,
}) => {
  const fileRef = useRef<HTMLInputElement>(null);
  const [fileName, setFileName] = useState<string>('');
  const [useAnalyzedData, setUseAnalyzedData] = useState<boolean>(!!(externalCleanedData && externalCleanedData.length > 0));

  // 是否已存在外部清洗后的数据，便于展示统计范围
  const hasExternalData = !!(externalCleanedData && externalCleanedData.length > 0);
  const reusedStats = useMemo(() => {
    if (!externalCleanedData || !externalCleanedData.length) return null;
    const sorted = externalCleanedData
      .slice()
      .sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());
    const count = sorted.length;
    const start = sorted[0]?.timestamp;
    const end = sorted[sorted.length - 1]?.timestamp;
    return { count, start, end };
  }, [externalCleanedData]);

  // 当负荷分析数据变化时自动勾选/取消
  React.useEffect(() => {
    setUseAnalyzedData(!!(externalCleanedData && externalCleanedData.length > 0));
  }, [externalCleanedData]);

  useEffect(() => {
    if (!restoredVersion) return;
    if (!restoredCyclesRun?.response || !restoredCyclesRun?.payload) return;
    const storage = restoredCyclesRun.payload.storage;
    setError(null);
    setResult(restoredCyclesRun.response);
    lastPayloadRef.current = restoredCyclesRun.payload;
    lastFileRef.current = null;
    setFileName('');
    setUseAnalyzedData(true);
    setCyclePhase('done');
    setShowCycleRing(false);
    setCycleProgressPct(0);

    // 回填“基础配置”表单（params）与相关状态（如放电策略）
    setParams((p) => ({
      ...p,
      capacity_kwh: Number.isFinite(Number(storage?.capacity_kwh)) ? Number(storage.capacity_kwh) : p.capacity_kwh,
      c_rate: Number.isFinite(Number(storage?.c_rate)) ? Number(storage.c_rate) : p.c_rate,
      single_side_efficiency: Number.isFinite(Number(storage?.single_side_efficiency)) ? Number(storage.single_side_efficiency) : p.single_side_efficiency,
      depth_of_discharge: Number.isFinite(Number(storage?.depth_of_discharge)) ? Number(storage.depth_of_discharge) : p.depth_of_discharge,
      soc_min: Number.isFinite(Number(storage?.soc_min)) ? Number(storage.soc_min) : p.soc_min,
      soc_max: Number.isFinite(Number(storage?.soc_max)) ? Number(storage.soc_max) : p.soc_max,
      reserve_charge_kw: Number.isFinite(Number(storage?.reserve_charge_kw)) ? Number(storage.reserve_charge_kw) : p.reserve_charge_kw,
      reserve_discharge_kw: Number.isFinite(Number(storage?.reserve_discharge_kw)) ? Number(storage.reserve_discharge_kw) : p.reserve_discharge_kw,
      metering_mode: (storage?.metering_mode === 'transformer_capacity' ? 'transformer_capacity' : 'monthly_demand_max') as any,
      transformer_capacity_kva: Number.isFinite(Number(storage?.transformer_capacity_kva)) ? Number(storage.transformer_capacity_kva) : p.transformer_capacity_kva,
      transformer_power_factor: Number.isFinite(Number(storage?.transformer_power_factor)) ? Number(storage.transformer_power_factor) : p.transformer_power_factor,
      energy_formula: (storage?.energy_formula === 'sample' ? 'sample' : 'physics') as any,
      merge_threshold_minutes: Number.isFinite(Number(storage?.merge_threshold_minutes)) ? Number(storage.merge_threshold_minutes) : p.merge_threshold_minutes,
    }));

    const ds = (storage as any)?.discharge_strategy;
    if (ds === 'sequential' || ds === 'parallel' || ds === 'avg') {
      setDischargeStrategy(ds);
    }

    const rc = Number(storage?.reserve_charge_kw ?? 0);
    const rd = Number(storage?.reserve_discharge_kw ?? 0);
    if ((Number.isFinite(rc) && rc > 0) || (Number.isFinite(rd) && rd > 0)) {
      setPowerMode('fixed');
    } else {
      setPowerMode('c_rate');
    }

    // 恢复时默认切到“自定义”模板，避免模板自动覆盖快照参数
    setActiveTemplateId(null);
  }, [restoredVersion, restoredCyclesRun]);
  const [loading, setLoading] = useState(false);
  const [progress, setProgress] = useState<number>(0); // 保留给兼容但主要使用环形
  const [cyclePhase, setCyclePhase] = useState<'idle'|'uploading'|'computing'|'done'|'error'>('idle');
  const [cycleProgressPct, setCycleProgressPct] = useState(0);
  const [showCycleRing, setShowCycleRing] = useState(false);
  const [uploadBytesTotal, setUploadBytesTotal] = useState<number | null>(null);
  const [uploadEtaSeconds, setUploadEtaSeconds] = useState<number | null>(null);
  const cycleAbortRef = useRef<() => void>(() => {});
  const uploadSamplesRef = useRef<Array<{time:number;loaded:number}>>([]);
  // 步骤提示状态
  const [progressStep, setProgressStep] = useState<string>('');
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<BackendStorageCyclesResponse | null>(null);
  const [savedConfigName, setSavedConfigName] = useState('');
  const [availableConfigs, setAvailableConfigs] = useState<string[]>([]);
  const [selectedSavedConfig, setSelectedSavedConfig] = useState('');
  const [configNotice, setConfigNotice] = useState<string | null>(null);
  const importInputRef = useRef<HTMLInputElement>(null);
  const [targetYearEqCyclesInput, setTargetYearEqCyclesInput] = useState<string>('');
  const [solveStartCapacityKwh, setSolveStartCapacityKwh] = useState<number>(5000);
  const [solveStepCapacityKwh, setSolveStepCapacityKwh] = useState<number>(500);
  const [solveSteps, setSolveSteps] = useState<number>(SOLVE_CAPACITY_STEPS);
  
  // ================== 放电策略状态 ==================
  const [dischargeStrategy, setDischargeStrategy] = useState<DischargeStrategy>('sequential');
  const [solveSuggestion, setSolveSuggestion] = useState<{
    targetYearEq: number;
    bestCapacityKwh: number;
    bestYearEqCycles: number;
  } | null>(null);

  // ================== 测算模式状态 ==================
  // 测算模式：single=单次测算，batch=批量容量对比
  const [testMode, setTestMode] = useState<'single' | 'batch'>('single');

  // ================== 批量容量对比相关状态 ==================
  interface BatchCapacityItem {
    capacityKwh: number;
    yearEqCycles: number;
    firstYearProfit: number;
    response: BackendStorageCyclesResponse | null;
    status: 'pending' | 'computing' | 'done' | 'error';
    errorMsg?: string;
  }
  const [batchResults, setBatchResults] = useState<BatchCapacityItem[]>([]);
  const [selectedBatchIdx, setSelectedBatchIdx] = useState<number | null>(null);
  const [batchProgress, setBatchProgress] = useState<{ current: number; total: number } | null>(null);
  const [isBatchComputing, setIsBatchComputing] = useState(false);
  // 功率模式：fixed=固定功率（使用 reserve_charge_kw/reserve_discharge_kw），c_rate=倍率联动
  const [powerMode, setPowerMode] = useState<'fixed' | 'c_rate'>('c_rate');
  // 当前选中的模板 ID（null 表示自定义）
  const [activeTemplateId, setActiveTemplateId] = useState<string | null>('peak_shaving');
  const didAutoApplyDefaultRef = useRef(false);
  // 最近一次完整测算的参数与文件，用于按需导出 Excel 报表
  const lastPayloadRef = useRef<StorageParamsPayload | null>(null);
  const lastFileRef = useRef<File | null>(null);

  // ================== 用户自定义模板管理 ==================
  // 用户自定义模板列表
  const [userTemplates, setUserTemplates] = useState<StorageParamsTemplate[]>([]);
  // 模板编辑对话框状态
  const [templateEditVisible, setTemplateEditVisible] = useState(false);
  // 正在编辑的模板（null 表示新建）
  const [editingTemplate, setEditingTemplate] = useState<StorageParamsTemplate | null>(null);
  // 编辑表单数据
  const [templateForm, setTemplateForm] = useState<{
    name: string;
    icon: string;
    description: string;
    scheduleHint: string;
  }>({ name: '', icon: '⚡', description: '', scheduleHint: '' });

  // 加载用户模板
  const loadUserTemplates = useCallback(() => {
    if (typeof window === 'undefined') return;
    try {
      const raw = window.localStorage.getItem(USER_TEMPLATES_STORAGE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) {
          setUserTemplates(parsed);
        }
      }
    } catch (e) {
      console.error('加载用户模板失败:', e);
    }
  }, []);

  // 保存用户模板到 localStorage
  const saveUserTemplates = useCallback((templates: StorageParamsTemplate[]) => {
    if (typeof window === 'undefined') return;
    try {
      window.localStorage.setItem(USER_TEMPLATES_STORAGE_KEY, JSON.stringify(templates));
      setUserTemplates(templates);
    } catch (e) {
      console.error('保存用户模板失败:', e);
    }
  }, []);

  // 初始化加载用户模板
  useEffect(() => {
    loadUserTemplates();
  }, [loadUserTemplates]);

  // 合并系统模板和用户模板
  const allTemplates = useMemo(() => {
    return [...STORAGE_PARAMS_TEMPLATES, ...userTemplates];
  }, [userTemplates]);

  // 打开新建模板对话框
  const handleCreateTemplate = () => {
    setEditingTemplate(null);
    setTemplateForm({
      name: '',
      icon: '⚡',
      description: '',
      scheduleHint: '',
    });
    setTemplateEditVisible(true);
  };

  // 打开编辑模板对话框
  const handleEditTemplate = (template: StorageParamsTemplate) => {
    setEditingTemplate(template);
    setTemplateForm({
      name: template.name,
      icon: template.icon,
      description: template.description,
      scheduleHint: template.scheduleHint,
    });
    setTemplateEditVisible(true);
  };

  // 保存模板（新建或更新）
  const handleSaveTemplate = () => {
    if (!templateForm.name.trim()) {
      setConfigNotice('请输入模板名称');
      return;
    }
    
    const templateParams = {
      c_rate: params.c_rate,
      single_side_efficiency: params.single_side_efficiency,
      depth_of_discharge: params.depth_of_discharge,
      soc_min: params.soc_min,
      soc_max: params.soc_max,
      reserve_charge_kw: params.reserve_charge_kw,
      reserve_discharge_kw: params.reserve_discharge_kw,
      metering_mode: params.metering_mode,
      energy_formula: params.energy_formula,
      merge_threshold_minutes: params.merge_threshold_minutes,
    };

    if (editingTemplate) {
      // 更新现有模板
      const isSystemTemplate = STORAGE_PARAMS_TEMPLATES.some(t => t.id === editingTemplate.id);
      if (isSystemTemplate) {
        // 系统模板不能直接修改，创建一个用户副本
        const newId = `user_${Date.now()}`;
        const newTemplate: StorageParamsTemplate = {
          id: newId,
          name: templateForm.name.trim(),
          icon: templateForm.icon,
          description: templateForm.description.trim(),
          scheduleHint: templateForm.scheduleHint.trim(),
          params: templateParams,
        };
        saveUserTemplates([...userTemplates, newTemplate]);
        setActiveTemplateId(newId);
        setConfigNotice(`已基于"${editingTemplate.name}"创建新模板"${newTemplate.name}"`);
      } else {
        // 更新用户模板
        const updated = userTemplates.map(t =>
          t.id === editingTemplate.id
            ? {
                ...t,
                name: templateForm.name.trim(),
                icon: templateForm.icon,
                description: templateForm.description.trim(),
                scheduleHint: templateForm.scheduleHint.trim(),
                params: templateParams,
              }
            : t
        );
        saveUserTemplates(updated);
        setConfigNotice(`模板"${templateForm.name}"已更新`);
      }
    } else {
      // 新建模板
      const newId = `user_${Date.now()}`;
      const newTemplate: StorageParamsTemplate = {
        id: newId,
        name: templateForm.name.trim(),
        icon: templateForm.icon,
        description: templateForm.description.trim(),
        scheduleHint: templateForm.scheduleHint.trim(),
        params: templateParams,
      };
      saveUserTemplates([...userTemplates, newTemplate]);
      setActiveTemplateId(newId);
      setConfigNotice(`模板"${newTemplate.name}"已创建`);
    }
    setTemplateEditVisible(false);
  };

  // 删除用户模板
  const handleDeleteTemplate = (templateId: string) => {
    const isSystemTemplate = STORAGE_PARAMS_TEMPLATES.some(t => t.id === templateId);
    if (isSystemTemplate) {
      setConfigNotice('系统预设模板不能删除');
      return;
    }
    const template = userTemplates.find(t => t.id === templateId);
    if (!template) return;
    
    if (window.confirm(`确定删除模板"${template.name}"吗？`)) {
      const updated = userTemplates.filter(t => t.id !== templateId);
      saveUserTemplates(updated);
      if (activeTemplateId === templateId) {
        setActiveTemplateId(null);
      }
      setConfigNotice(`模板"${template.name}"已删除`);
    }
  };

  // ================== 数据清洗相关状态 ==================
  // 是否启用清洗流程（用户可关闭）
  const [enableCleaning, setEnableCleaning] = useState(true);
  // 清洗分析结果
  const [cleaningAnalysis, setCleaningAnalysis] = useState<CleaningAnalysisResponse | null>(null);
  // 清洗对话框可见性
  const [cleaningDialogVisible, setCleaningDialogVisible] = useState(false);
  // 清洗进行中
  const [cleaningLoading, setCleaningLoading] = useState(false);
  // 待处理的文件（用于对话框确认后继续）
  const pendingFileRef = useRef<File | null>(null);
  // 待处理的数据点（用于复用负荷分析页数据时）
  const pendingPointsRef = useRef<{ timestamp: string; load_kwh: number }[] | null>(null);
  // 标记当前清洗的数据来源
  const [cleaningDataSource, setCleaningDataSource] = useState<'file' | 'external'>('file');
  // 清洗后的数据点（用于后续计算）
  const cleanedPointsRef = useRef<{ timestamp: string; load_kwh: number }[] | null>(null);
  // 清洗结果统计（用于对比展示）
  const [cleaningResultStats, setCleaningResultStats] = useState<CleaningResultResponse | null>(null);

  // ================== 清洗前后对比相关状态 ==================
  // 对比视图是否展开
  const [showComparison, setShowComparison] = useState(false);
  // 对比数据
  const [comparisonData, setComparisonData] = useState<ComparisonResult | null>(null);
  // 原始数据计算结果（用于对比）
  const originalResultRef = useRef<BackendStorageCyclesResponse | null>(null);

  // 将 Date 转为“本地朴素时间”字符串（YYYY-MM-DD HH:mm:ss），避免 UTC 偏移与日界错位
  const toLocalNaiveString = (d: Date) => {
    const pad = (n: number) => String(n).padStart(2, '0');
    const y = d.getFullYear();
    const m = pad(d.getMonth() + 1);
    const day = pad(d.getDate());
    const hh = pad(d.getHours());
    const mm = pad(d.getMinutes());
    const ss = pad(d.getSeconds());
    return `${y}-${m}-${day} ${hh}:${mm}:${ss}`;
  };

  // 简化的默认参数（可在页面上编辑的表单项）
  const [params, setParams] = useState({
    capacity_kwh: 5000,
    c_rate: 0.5,
    single_side_efficiency: 0.92,
    depth_of_discharge: 0.9,
    soc_min: 0.05,
    soc_max: 0.95,
    reserve_charge_kw: 0,
    reserve_discharge_kw: 0,
    metering_mode: 'monthly_demand_max' as const,
    transformer_capacity_kva: 10000,
    transformer_power_factor: 0.9,
    energy_formula: 'physics' as const,
    merge_threshold_minutes: 30,
  });

  // 简单表单校验
  const validateParams = (): string | null => {
    const p = params;
    if (!(p.capacity_kwh > 0)) return '容量(capacity_kwh) 必须大于 0';
    if (!(p.c_rate > 0)) return '倍率(c_rate) 必须大于 0';
    if (!(p.single_side_efficiency > 0 && p.single_side_efficiency <= 1)) return '单边效率(η) 需在 (0, 1]';
    if (!(p.depth_of_discharge > 0 && p.depth_of_discharge <= 1)) return 'DOD 需在 (0, 1]';
    if (!(p.soc_min >= 0 && p.soc_min < 1)) return 'SOC 下限需在 [0, 1) 之间';
    if (!(p.soc_max > 0 && p.soc_max <= 1)) return 'SOC 上限需在 (0, 1] 之间';
    if (!(p.soc_min < p.soc_max)) return 'SOC 下限需小于 SOC 上限';
    if (!(p.merge_threshold_minutes >= 0)) return '合并阈值需为非负整数';
    if (p.metering_mode === 'transformer_capacity') {
      if (!(p.transformer_capacity_kva > 0)) return '变压器容量(kVA) 必须大于 0';
      if (!(p.transformer_power_factor > 0 && p.transformer_power_factor <= 1)) return '功率因数需在 (0, 1]';
    }
    return null;
  };

  const loadStoredConfigs = useCallback(() => {
    if (typeof window === 'undefined') return;
    const names = Object.keys(window.localStorage ?? {})
      .filter(key => key.startsWith(CONFIG_STORAGE_PREFIX))
      .map(key => key.slice(CONFIG_STORAGE_PREFIX.length));
    setAvailableConfigs(names);
    setSelectedSavedConfig(prev => (names.includes(prev) ? prev : ''));
  }, []);

  useEffect(() => {
    loadStoredConfigs();
  }, [loadStoredConfigs]);

  // 页面初次加载时自动加载“最近保存”的配置（按 savedAt 最大值选取）
  useEffect(() => {
    if (typeof window === 'undefined') return;
    if (didAutoApplyDefaultRef.current) return;

    try {
      const keys = Object.keys(window.localStorage ?? {}).filter(key =>
        key.startsWith(CONFIG_STORAGE_PREFIX),
      );
      if (!keys.length) return;

      let latestName: string | null = null;
      let latestPayload: any = null;
      let latestTs = 0;

      keys.forEach(fullKey => {
        const raw = window.localStorage.getItem(fullKey);
        if (!raw) return;
        try {
          const parsed = JSON.parse(raw);
          const savedAt = parsed?.savedAt;
          const ts = savedAt ? Date.parse(savedAt) : 0;
          if (Number.isFinite(ts) && ts >= latestTs) {
            latestTs = ts;
            latestPayload = parsed;
            latestName = fullKey.slice(CONFIG_STORAGE_PREFIX.length);
          }
        } catch {
          // 单个配置解析失败不影响整体
        }
      });

      if (!latestPayload || !latestName) return;

      // 应用最近保存的配置到基础参数与反推容量参数
      if (latestPayload.params) {
        setParams(p => ({ ...p, ...latestPayload.params }));
      }
      if (latestPayload.solveConfig) {
        const cfg = latestPayload.solveConfig as any;
        if (typeof cfg.solveStartCapacityKwh === 'number') {
          setSolveStartCapacityKwh(cfg.solveStartCapacityKwh);
        }
        if (typeof cfg.solveStepCapacityKwh === 'number') {
          setSolveStepCapacityKwh(cfg.solveStepCapacityKwh);
        }
        if (typeof cfg.solveSteps === 'number' && cfg.solveSteps > 0) {
          setSolveSteps(cfg.solveSteps);
        }
        if (cfg.targetYearEqCyclesInput != null) {
          setTargetYearEqCyclesInput(String(cfg.targetYearEqCyclesInput));
        }
      }

      setSavedConfigName(latestName);
      setSelectedSavedConfig(latestName);
      setConfigNotice(`已自动加载最近保存的配置“${latestName}”`);
      didAutoApplyDefaultRef.current = true;
    } catch {
      // 自动加载失败时静默降级，不影响手动选择
    }
  }, []);

  const handleUpload = async () => {
    setError(null);
    setResult(null);
    setSolveSuggestion(null);
    const input = fileRef.current;
    let file: File | null = null;
    if (input && input.files && input.files.length > 0) {
      file = input.files[0];
      setFileName(file.name);
    }
    if (!file && !useAnalyzedData) {
      setError('请选择待测算的负荷文件（CSV/XLSX）或勾选“使用负荷分析已上传数据”');
      return;
    }

    // 勾选了复用但没有可用数据，直接提示并中止
    if (useAnalyzedData && (!externalCleanedData || externalCleanedData.length === 0)) {
      setError('"负荷分析"页没有可用数据，请先在"负荷分析"页上传并处理，或在本页选择负荷文件。');
      return;
    }

    // ===== 新增：数据清洗流程 =====
    // 如果启用清洗，对上传文件或负荷分析页数据进行分析
    console.log('[StorageCycles] 清洗流程检查:', { enableCleaning, hasFile: !!file, useAnalyzedData });
    
    if (enableCleaning) {
      // 准备清洗的数据源
      let dataForCleaning: File | { timestamp: string; load_kwh: number }[] | null = null;
      let dataSource: 'file' | 'external' = 'file';
      
      if (file && !useAnalyzedData) {
        dataForCleaning = file;
        dataSource = 'file';
      } else if (useAnalyzedData && externalCleanedData && externalCleanedData.length > 0) {
        // 将负荷分析页数据转换为清洗 API 需要的格式
        dataForCleaning = externalCleanedData
          .slice()
          .sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime())
          .map(p => ({
            timestamp: toLocalNaiveString(p.timestamp),
            load_kwh: Number(p.load),
          }));
        dataSource = 'external';
      }
      
      if (dataForCleaning) {
        try {
          console.log('[StorageCycles] 开始数据清洗分析...', { dataSource });
          setLoading(true);
          setCyclePhase('uploading');
          setShowCycleRing(true);
          setCycleProgressPct(10);
          setProgressStep('正在分析数据质量...');
          
          // 调用后端分析接口
          console.log('[StorageCycles] 调用 analyzeDataForCleaning API...');
          const analysis = await analyzeDataForCleaning(dataForCleaning);
          console.log('[StorageCycles] 分析结果:', analysis);
          setCycleProgressPct(40);
          
          // 判断是否需要用户确认（有零值、负值时段或空值需要用户知晓）
          const needsConfirm = analysis.zero_spans.length > 0 || 
                              analysis.negative_spans.length > 0 ||
                              analysis.null_point_count > 0;
          
          console.log('[StorageCycles] needsConfirm:', needsConfirm, {
            zeroSpans: analysis.zero_spans.length,
            negativeSpans: analysis.negative_spans.length,
            nullPoints: analysis.null_point_count,
          });
          
          if (needsConfirm) {
            // 保存状态，等待用户确认
            console.log('[StorageCycles] 需要用户确认，显示清洗对话框');
            setCleaningAnalysis(analysis);
            setCleaningDataSource(dataSource);
            if (dataSource === 'file') {
              pendingFileRef.current = file;
              pendingPointsRef.current = null;
            } else {
              pendingFileRef.current = null;
              pendingPointsRef.current = dataForCleaning as { timestamp: string; load_kwh: number }[];
            }
            setCleaningDialogVisible(true);
            setLoading(false);
            setShowCycleRing(false);
            setCyclePhase('idle');
            setProgressStep('');
            return; // 等待用户在对话框中确认
          }
          
          // 无零值/负值异常，但仍需处理空值
          // 使用默认配置进行清洗（空值插值，无零值/负值处理）
          setCycleProgressPct(50);
          setProgressStep('正在处理数据...');
          const defaultConfig: CleaningConfigRequest = {
            null_strategy: 'interpolate',
            negative_strategy: 'keep',
            zero_decisions: {},
          };
          const cleanResult = await applyDataCleaning(dataForCleaning, defaultConfig);
          
          // 保存清洗后的数据点
          const cleanedPoints = cleanResult.cleaned_points.map(p => ({
            timestamp: p.timestamp,
            load_kwh: p.load_kwh,
          }));
          
          console.log('[StorageCycles] 自动清洗完成（无需用户确认）', {
            nullInterpolated: cleanResult.null_points_interpolated,
            totalPoints: cleanedPoints.length,
            dataSource,
          });
          
          setLoading(false);
          setShowCycleRing(false);
          setProgressStep('');
          
          // 使用清洗后的数据继续计算
          await proceedWithCalculation(file, false, cleanedPoints);
          return;
        } catch (e: any) {
          setLoading(false);
          setShowCycleRing(false);
          setCyclePhase('error');
          setProgressStep('');
          setError(`数据分析失败: ${e?.message || '未知错误'}`);
          return;
        }
      }
    }

    // 未启用清洗或使用已分析数据，继续原有的计算流程
    await proceedWithCalculation(file, useAnalyzedData);
  };

  // 清洗对话框确认后的回调
  const handleCleaningConfirm = async (config: CleaningConfigRequest) => {
    const file = pendingFileRef.current;
    const points = pendingPointsRef.current;
    
    // 需要有文件或数据点
    if (!file && !points) {
      setError('数据源丢失，请重新操作');
      setCleaningDialogVisible(false);
      return;
    }
    
    const dataForCleaning = file || points!;

    try {
      setCleaningLoading(true);
      setShowCycleRing(true);
      setCyclePhase('computing');
      setCycleProgressPct(10);
      setProgressStep('正在应用数据清洗...');
      
      // 调用后端应用清洗
      const cleanResult = await applyDataCleaning(dataForCleaning, config);
      
      // 保存清洗后的数据点
      cleanedPointsRef.current = cleanResult.cleaned_points.map(p => ({
        timestamp: p.timestamp,
        load_kwh: p.load_kwh,
      }));
      
      // 保存清洗统计（用于对比展示）
      setCleaningResultStats({
        cleaned_points: cleanResult.cleaned_points,
        null_points_interpolated: cleanResult.null_points_interpolated,
        zero_spans_kept: cleanResult.zero_spans_kept,
        zero_spans_interpolated: cleanResult.zero_spans_interpolated,
        negative_points_kept: cleanResult.negative_points_kept,
        negative_points_modified: cleanResult.negative_points_modified ?? 0,
        interpolated_count: cleanResult.interpolated_count ?? 0,
      });
      
      console.log('[StorageCycles] 清洗完成', {
        nullInterpolated: cleanResult.null_points_interpolated,
        zeroKept: cleanResult.zero_spans_kept,
        zeroInterpolated: cleanResult.zero_spans_interpolated,
        negativeKept: cleanResult.negative_points_kept,
        negativeModified: cleanResult.negative_points_modified,
      });
      
      setCleaningDialogVisible(false);
      setCleaningLoading(false);
      setCycleProgressPct(30);
      setProgressStep('正在计算原始数据基准...');
      
      // 先计算原始数据的结果（用于对比）
      // 根据数据来源选择传递文件还是数据点
      try {
        console.log('[StorageCycles] 开始计算原始数据结果（用于对比）', { dataSource: cleaningDataSource });
        let originalResult: BackendStorageCyclesResponse | null = null;
        if (cleaningDataSource === 'file' && file) {
          originalResult = await proceedWithCalculationInternal(file, false, undefined, true);
        } else if (cleaningDataSource === 'external' && points) {
          // 使用原始数据点（清洗前的）计算
          originalResult = await proceedWithCalculationInternal(null, false, points, true);
        }
        originalResultRef.current = originalResult;
        console.log('[StorageCycles] 原始数据结果', { cycles: originalResult?.year?.cycles });
      } catch (e) {
        console.warn('[StorageCycles] 原始数据计算失败，跳过对比', e);
        originalResultRef.current = null;
      }
      
      setCycleProgressPct(60);
      setProgressStep('正在计算清洗后数据...');
      
      // 使用清洗后的数据继续计算（会自动生成对比数据）
      // 注意：直接传递 cleanResult，因为 setCleaningResultStats 是异步的
      await proceedWithCalculation(null, false, cleanedPointsRef.current, cleanResult);
    } catch (e: any) {
      setCleaningLoading(false);
      setShowCycleRing(false);
      setCyclePhase('error');
      setProgressStep('');
      setError(`数据清洗失败: ${e?.message || '未知错误'}`);
    }
  };

  // 清洗对话框取消
  const handleCleaningCancel = () => {
    setCleaningDialogVisible(false);
    pendingFileRef.current = null;
    pendingPointsRef.current = null;
    setCleaningAnalysis(null);
  };

  // 生成对比数据
  const generateComparisonData = (
    originalResult: BackendStorageCyclesResponse,
    cleanedResult: BackendStorageCyclesResponse,
    cleanStats: CleaningResultResponse,
  ) => {
    // 从结果中提取指标
    const originalCycles = Number(originalResult.year?.cycles ?? 0);
    const cleanedCycles = Number(cleanedResult.year?.cycles ?? 0);
    
    // 计算有效天数
    const originalValidDays = originalResult.days?.filter(d => d.cycles > 0).length ?? 0;
    const cleanedValidDays = cleanedResult.days?.filter(d => d.cycles > 0).length ?? 0;
    
    // 计算等效循环数
    const originalEqCycles = computeYearEquivalentCyclesFromDays(originalResult.days);
    const cleanedEqCycles = computeYearEquivalentCyclesFromDays(cleanedResult.days);
    
    // 简化的收益估算（实际应从后端获取）
    const originalProfit = originalCycles * 500; // 假设每次循环500元收益
    const cleanedProfit = cleanedCycles * 500;
    
    const comparison: ComparisonResult = {
      original: {
        actual_cycles: originalCycles,
        equivalent_cycles: originalEqCycles,
        valid_days: originalValidDays,
        profit: originalProfit,
      },
      cleaned: {
        actual_cycles: cleanedCycles,
        equivalent_cycles: cleanedEqCycles,
        valid_days: cleanedValidDays,
        profit: cleanedProfit,
      },
      diff_actual_cycles: cleanedCycles - originalCycles,
      diff_actual_cycles_percent: originalCycles > 0 
        ? ((cleanedCycles - originalCycles) / originalCycles) * 100 
        : 0,
      diff_equivalent_cycles: cleanedEqCycles - originalEqCycles,
      diff_equivalent_cycles_percent: originalEqCycles > 0 
        ? ((cleanedEqCycles - originalEqCycles) / originalEqCycles) * 100 
        : 0,
      diff_valid_days: cleanedValidDays - originalValidDays,
      diff_profit: cleanedProfit - originalProfit,
      diff_profit_percent: originalProfit > 0 
        ? ((cleanedProfit - originalProfit) / originalProfit) * 100 
        : 0,
      recommendation: cleanedCycles >= originalCycles ? 'cleaned' : 'original',
      completeness_ratio: cleaningAnalysis?.completeness_ratio ?? 1,
      cleaning_actions: {
        null_points_interpolated: cleanStats.null_points_interpolated,
        zero_spans_kept: cleanStats.zero_spans_kept,
        zero_spans_interpolated: cleanStats.zero_spans_interpolated,
        negative_points_modified: cleanStats.negative_points_modified ?? 0,
      },
    };
    
    setComparisonData(comparison);
    setShowComparison(true);
    console.log('[StorageCycles] 对比数据生成完成', comparison);
  };

  // 内部计算函数（用于获取结果但不更新主状态）
  const proceedWithCalculationInternal = async (
    file: File | null,
    useExternal: boolean,
    cleanedPoints?: { timestamp: string; load_kwh: number }[],
    silent: boolean = false,
  ): Promise<BackendStorageCyclesResponse | null> => {
    // 仅在有有效数据时构造 points，并按时间排序
    let pointsPayload: { timestamp: string; load_kwh: number }[] | undefined;
    
    if (cleanedPoints && cleanedPoints.length > 0) {
      pointsPayload = cleanedPoints;
    } else if (useExternal && externalCleanedData && externalCleanedData.length > 0) {
      pointsPayload = externalCleanedData
        .slice()
        .sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime())
        .map(p => ({
          timestamp: toLocalNaiveString(p.timestamp),
          load_kwh: Number(p.load),
        }));
    }

    const payload: StorageParamsPayload = {
      storage: {
        capacity_kwh: params.capacity_kwh,
        c_rate: params.c_rate,
        single_side_efficiency: params.single_side_efficiency,
        depth_of_discharge: params.depth_of_discharge,
        soc_min: params.soc_min,
        soc_max: params.soc_max,
        reserve_charge_kw: params.reserve_charge_kw,
        reserve_discharge_kw: params.reserve_discharge_kw,
        metering_mode: params.metering_mode,
        transformer_capacity_kva: params.metering_mode === 'transformer_capacity' ? params.transformer_capacity_kva : undefined,
        transformer_power_factor: params.metering_mode === 'transformer_capacity' ? params.transformer_power_factor : undefined,
        calc_style: 'window_avg',
        energy_formula: params.energy_formula,
        merge_threshold_minutes: params.merge_threshold_minutes,
      },
      strategySource: {
        monthlySchedule: scheduleData.monthlySchedule,
        dateRules: scheduleData.dateRules,
      },
      monthlyTouPrices: scheduleData.prices,
      points: pointsPayload,
    };

    try {
      // 使用文件上传计算
      if (file) {
        const { promise } = computeStorageCyclesWithProgress(file, payload, () => {});
        return await promise;
      } else {
        return await computeStorageCycles(null, payload);
      }
    } catch (e: any) {
      if (!silent) {
        console.error('[StorageCycles] 内部计算失败', e);
      }
      return null;
    }
  };

  // 抽取计算流程为独立函数
  const proceedWithCalculation = async (
    file: File | null,
    useExternal: boolean,
    cleanedPoints?: { timestamp: string; load_kwh: number }[],
    cleanResultForComparison?: CleaningResultResponse,  // 直接传入清洗结果用于对比
  ) => {
    // 仅在有有效数据时构造 points，并按时间排序
    let pointsPayload: { timestamp: string; load_kwh: number }[] | undefined;
    
    if (cleanedPoints && cleanedPoints.length > 0) {
      // 使用清洗后的数据
      pointsPayload = cleanedPoints;
    } else if (useExternal && externalCleanedData && externalCleanedData.length > 0) {
      // 使用负荷分析页的数据
      pointsPayload = externalCleanedData
        .slice()
        .sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime())
        .map(p => ({
          timestamp: toLocalNaiveString(p.timestamp),
          load_kwh: Number(p.load),
        }));
    }

    const payload: StorageParamsPayload = {
      storage: {
        capacity_kwh: params.capacity_kwh,
        c_rate: params.c_rate,
        single_side_efficiency: params.single_side_efficiency,
        depth_of_discharge: params.depth_of_discharge,
        soc_min: params.soc_min,
        soc_max: params.soc_max,
        reserve_charge_kw: params.reserve_charge_kw,
        reserve_discharge_kw: params.reserve_discharge_kw,
        metering_mode: params.metering_mode,
        transformer_capacity_kva: params.metering_mode === 'transformer_capacity' ? params.transformer_capacity_kva : undefined,
        transformer_power_factor: params.metering_mode === 'transformer_capacity' ? params.transformer_power_factor : undefined,
        calc_style: 'window_avg',
        energy_formula: params.energy_formula,
        merge_threshold_minutes: params.merge_threshold_minutes,
        discharge_strategy: dischargeStrategy,  // 新增：放电策略
      },
      strategySource: {
        monthlySchedule: scheduleData.monthlySchedule,
        dateRules: scheduleData.dateRules,
      },
      monthlyTouPrices: scheduleData.prices,
      points: pointsPayload,
    };

    // 简单防呆：无放电窗口或尖价全空时阻止测算，避免算出 0
    const hasDischarge = Array.isArray(payload.strategySource?.monthlySchedule)
      && payload.strategySource.monthlySchedule.some((monthRow: any[]) =>
        Array.isArray(monthRow) && monthRow.some(cell => cell?.op === '放'));
    const hasAnyPrice = Array.isArray(payload.monthlyTouPrices)
      && payload.monthlyTouPrices.some(mp => mp && Object.values(mp).some(v => v != null));
    console.debug('[StorageCycles] payload preview', payload, { hasDischarge, hasAnyPrice });
    if (!hasDischarge) {
      setError('当前排程没有放电窗口，请先在排程/逻辑中设置“放”时段后再测算。');
      return;
    }
    if (!hasAnyPrice) {
      setError('当前电价配置全部为空，请先设置 TOU 电价（含尖/峰/平/谷）。');
      return;
    }

    try {
      const v = validateParams();
      if (v) { setError(v); return; }
      setLoading(true);
      // 如果有清洗后的数据，不需要上传文件
      const shouldUploadFile = file && !cleanedPoints;
      // 记录最近一次测算所使用的参数与文件，供后续“导出报表”复用
      lastPayloadRef.current = payload;
      lastFileRef.current = shouldUploadFile ? file : null;
      setCyclePhase(shouldUploadFile ? 'uploading' : 'computing');
      setCycleProgressPct(0);
      setShowCycleRing(true);
      setUploadEtaSeconds(null);
      uploadSamplesRef.current = [];

      if (shouldUploadFile) {
        const { promise, abort } = computeStorageCyclesWithProgress(file, payload, (loaded, total) => {
          setUploadBytesTotal(total);
          const pct = Math.round((loaded / total) * 100);
          setCycleProgressPct(pct);
          const now = performance.now();
          uploadSamplesRef.current.push({ time: now, loaded });
          if (uploadSamplesRef.current.length > 6) uploadSamplesRef.current.shift();
          if (loaded < total) {
            if (uploadSamplesRef.current.length >= 2) {
              const first = uploadSamplesRef.current[0];
              const last = uploadSamplesRef.current[uploadSamplesRef.current.length - 1];
              const bytesDelta = last.loaded - first.loaded;
              const timeDeltaSec = (last.time - first.time)/1000;
              if (bytesDelta > 0 && timeDeltaSec > 0) {
                const speed = bytesDelta / timeDeltaSec;
                const remaining = total - loaded;
                setUploadEtaSeconds(remaining / speed);
              }
            }
          } else {
            setCyclePhase('computing');
            setUploadEtaSeconds(null);
          }
        });
        cycleAbortRef.current = abort;
        const resp = await promise;
        setResult(resp);
        onLatestRunChange?.(payload, resp);
        setCyclePhase('done');
        setCycleProgressPct(100);
        
        // 如果有原始数据结果和清洗统计，生成对比数据
        const cleanStats = cleanResultForComparison || cleaningResultStats;
        if (originalResultRef.current && cleanStats) {
          console.log('[StorageCycles] 生成对比数据（上传文件分支）', { originalCycles: originalResultRef.current?.year?.cycles, cleanedCycles: resp?.year?.cycles });
          generateComparisonData(originalResultRef.current, resp, cleanStats);
        }
      } else {
        // 无文件：直接调用原始 fetch 并使用模拟进度
        setCyclePhase('computing');
        let fakePct = 0;
        const fakeTimer = window.setInterval(() => {
          fakePct = Math.min(95, fakePct + 5);
          setCycleProgressPct(fakePct);
        }, 400);
        try {
          const resp = await computeStorageCycles(null, payload);
          window.clearInterval(fakeTimer);
          setCycleProgressPct(100);
          setResult(resp);
          onLatestRunChange?.(payload, resp);
          setCyclePhase('done');
          
          // 如果有原始数据结果和清洗统计，生成对比数据
          const cleanStats = cleanResultForComparison || cleaningResultStats;
          console.log('[StorageCycles] 检查对比条件（无文件分支）', { 
            hasOriginalResult: !!originalResultRef.current, 
            hasCleanStats: !!cleanStats,
            cleanResultForComparison: !!cleanResultForComparison,
            cleaningResultStats: !!cleaningResultStats,
          });
          if (originalResultRef.current && cleanStats) {
            console.log('[StorageCycles] 生成对比数据（无文件分支）', { originalCycles: originalResultRef.current?.year?.cycles, cleanedCycles: resp?.year?.cycles });
            generateComparisonData(originalResultRef.current, resp, cleanStats);
          }
        } catch (err: any) {
          window.clearInterval(fakeTimer);
          throw err;
        }
      }
      setProgressStep('');
    } catch (e: any) {
      setCyclePhase('error');
      setProgressStep('');
      setError(e?.message || '计算失败');
    } finally {
      setLoading(false);
      setTimeout(() => { setShowCycleRing(false); setCyclePhase('idle'); setProgressStep(''); }, 2000);
    }
  };

  // 应用模板参数
  const handleApplyTemplate = (template: StorageParamsTemplate) => {
    setParams(p => ({
      ...p,
      c_rate: template.params.c_rate,
      single_side_efficiency: template.params.single_side_efficiency,
      depth_of_discharge: template.params.depth_of_discharge,
      soc_min: template.params.soc_min,
      soc_max: template.params.soc_max,
      reserve_charge_kw: template.params.reserve_charge_kw,
      reserve_discharge_kw: template.params.reserve_discharge_kw,
      metering_mode: template.params.metering_mode,
      energy_formula: template.params.energy_formula,
      merge_threshold_minutes: template.params.merge_threshold_minutes,
    }));
    setActiveTemplateId(template.id);
    setConfigNotice(`已应用模板"${template.name}"，排程建议：${template.scheduleHint}`);
  };

  // 修改模板关联参数时标记为自定义
  const handleTemplateParamChange = <K extends keyof typeof params>(key: K, value: typeof params[K]) => {
    setParams(p => ({ ...p, [key]: value }));
    // 只有模板关联的参数变化时才标记为自定义
    const templateKeys = ['c_rate', 'single_side_efficiency', 'depth_of_discharge', 'soc_min', 'soc_max', 'metering_mode', 'energy_formula', 'merge_threshold_minutes'];
    if (templateKeys.includes(key)) {
      setActiveTemplateId(null);
    }
  };

  const handleSaveConfig = () => {
    if (typeof window === 'undefined') return;
    const name = savedConfigName.trim();
    if (!name) {
      setConfigNotice('请输入配置名称以保存当前参数');
      return;
    }
    const solveConfig = {
      targetYearEqCyclesInput,
      solveStartCapacityKwh,
      solveStepCapacityKwh,
      solveSteps,
    };
    window.localStorage.setItem(
      `${CONFIG_STORAGE_PREFIX}${name}`,
      JSON.stringify({ params, solveConfig, savedAt: new Date().toISOString() }),
    );
    setConfigNotice(`配置“${name}”已保存`);
    loadStoredConfigs();
  };

  const handleLoadSavedConfig = () => {
    if (typeof window === 'undefined' || !selectedSavedConfig) return;
    const raw = window.localStorage.getItem(`${CONFIG_STORAGE_PREFIX}${selectedSavedConfig}`);
    if (!raw) {
      setConfigNotice(`配置“${selectedSavedConfig}”不存在`);
      loadStoredConfigs();
      return;
    }
    try {
      const parsed = JSON.parse(raw);
      if (parsed.params) {
        setParams(p => ({ ...p, ...parsed.params }));
        if (parsed.solveConfig) {
          const cfg = parsed.solveConfig as any;
          if (typeof cfg.solveStartCapacityKwh === 'number') {
            setSolveStartCapacityKwh(cfg.solveStartCapacityKwh);
          }
          if (typeof cfg.solveStepCapacityKwh === 'number') {
            setSolveStepCapacityKwh(cfg.solveStepCapacityKwh);
          }
          if (typeof cfg.solveSteps === 'number' && cfg.solveSteps > 0) {
            setSolveSteps(cfg.solveSteps);
          }
          if (cfg.targetYearEqCyclesInput != null) {
            setTargetYearEqCyclesInput(String(cfg.targetYearEqCyclesInput));
          }
        }
        // 加载保存配置后，标记为自定义（保存的配置可能已被修改，不一定匹配任何模板）
        setActiveTemplateId(null);
        setSavedConfigName(selectedSavedConfig);
        setConfigNotice(`已加载“${selectedSavedConfig}”`);
      } else {
        setConfigNotice('配置内容缺少参数');
      }
    } catch (err) {
      setConfigNotice('配置解析失败');
    }
  };

  const handleExportConfig = () => {
    if (typeof window === 'undefined') return;
    const candidateName =
      savedConfigName || selectedSavedConfig || `storage-config-${Date.now()}`;
    const safeName = candidateName.replace(/\s+/g, '-');
    const payload = {
      name: safeName,
      params,
      solveConfig: {
        targetYearEqCyclesInput,
        solveStartCapacityKwh,
        solveStepCapacityKwh,
        solveSteps,
      },
      exportedAt: new Date().toISOString(),
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `${safeName}.json`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    window.setTimeout(() => URL.revokeObjectURL(url), 2000);
    setConfigNotice(`已导出配置 ${safeName}`);
  };

  const handleImportClick = () => {
    importInputRef.current?.click();
  };

  const handleImportFile = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;
    try {
      const text = await file.text();
      const parsed = JSON.parse(text);
      if (parsed.params) {
        setParams(p => ({ ...p, ...parsed.params }));
        if (parsed.solveConfig) {
          const cfg = parsed.solveConfig as any;
          if (typeof cfg.solveStartCapacityKwh === 'number') {
            setSolveStartCapacityKwh(cfg.solveStartCapacityKwh);
          }
          if (typeof cfg.solveStepCapacityKwh === 'number') {
            setSolveStepCapacityKwh(cfg.solveStepCapacityKwh);
          }
          if (typeof cfg.solveSteps === 'number' && cfg.solveSteps > 0) {
            setSolveSteps(cfg.solveSteps);
          }
          if (cfg.targetYearEqCyclesInput != null) {
            setTargetYearEqCyclesInput(String(cfg.targetYearEqCyclesInput));
          }
        }
        const name = (parsed.name ?? file.name.replace(/\.[^.]+$/, '')).trim();
        if (name) setSavedConfigName(name);
        setConfigNotice(`已导入配置 ${name || file.name}`);
      } else {
        setConfigNotice('导入文件缺少 params 字段');
      }
    } catch (err) {
      setConfigNotice('导入失败，文件必须为 JSON');
    } finally {
      if (event.target) {
        event.target.value = '';
      }
      loadStoredConfigs();
    }
  };

  // 按目标“全年合计等效循环数”反推容量（基于预计算映射 + 线性插值）
  const handleSolveCapacityByTargetCycles = async () => {
    setError(null);
    setSolveSuggestion(null);

    const target = Number(targetYearEqCyclesInput);
    if (!Number.isFinite(target) || target <= 0) {
      setError('请先输入大于 0 的目标全年合计等效循环数');
      return;
    }
    if (!(solveStartCapacityKwh > 0)) {
      setError('请先输入大于 0 的起始容量');
      return;
    }
    if (!(solveStepCapacityKwh > 0)) {
      setError('请先输入大于 0 的容量步长');
      return;
    }
    if (!(solveSteps > 0)) {
      setError('请先输入大于 0 的预计算步数');
      return;
    }

    const input = fileRef.current;
    let file: File | null = null;
    if (input && input.files && input.files.length > 0) {
      file = input.files[0];
      setFileName(prev => prev || file.name);
    }
    if (!file && !useAnalyzedData) {
      setError('请选择待测算的负荷文件（CSV/XLSX）或勾选“使用负荷分析已上传数据”');
      return;
    }

    if (useAnalyzedData && (!externalCleanedData || externalCleanedData.length === 0)) {
      setError('“负荷分析”页没有可用数据，请先在“负荷分析”页上传并处理，或在本页选择负荷文件。');
      return;
    }

    const pointsPayload = (useAnalyzedData && externalCleanedData && externalCleanedData.length > 0)
      ? externalCleanedData
          .slice()
          .sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime())
          .map(p => ({
            timestamp: toLocalNaiveString(p.timestamp),
            load_kwh: Number(p.load),
          }))
      : undefined;

    const baseStorage = {
      c_rate: params.c_rate,
      single_side_efficiency: params.single_side_efficiency,
      depth_of_discharge: params.depth_of_discharge,
      soc_min: params.soc_min,
      soc_max: params.soc_max,
      reserve_charge_kw: params.reserve_charge_kw,
      reserve_discharge_kw: params.reserve_discharge_kw,
      metering_mode: params.metering_mode,
      transformer_capacity_kva: params.metering_mode === 'transformer_capacity' ? params.transformer_capacity_kva : undefined,
      transformer_power_factor: params.metering_mode === 'transformer_capacity' ? params.transformer_power_factor : undefined,
      calc_style: 'window_avg' as const,
      energy_formula: params.energy_formula,
      merge_threshold_minutes: params.merge_threshold_minutes,
    };

    const hasDischarge = Array.isArray(scheduleData.monthlySchedule)
      && scheduleData.monthlySchedule.some((monthRow: any[]) =>
        Array.isArray(monthRow) && monthRow.some(cell => cell?.op === '放'));
    const hasAnyPrice = Array.isArray(scheduleData.prices)
      && scheduleData.prices.some(mp => mp && Object.values(mp).some(v => v != null));
    if (!hasDischarge) {
      setError('当前排程没有放电窗口，请先在排程/逻辑中设置“放”时段后再测算。');
      return;
    }
    if (!hasAnyPrice) {
      setError('当前电价配置全部为空，请先设置 TOU 电价（含尖/峰/平/谷）。');
      return;
    }

    const v = validateParams();
    if (v) {
      setError(v);
      return;
    }

    const capacities: number[] = [];
    const yearEqCyclesList: number[] = [];
    const responses: BackendStorageCyclesResponse[] = [];

    setLoading(true);
    try {
      const steps = solveSteps > 0 ? solveSteps : SOLVE_CAPACITY_STEPS;
      for (let i = 0; i < steps; i++) {
        const cap = solveStartCapacityKwh + i * solveStepCapacityKwh;
        if (!(cap > 0)) continue;
        const payload: StorageParamsPayload = {
          storage: {
            ...baseStorage,
            capacity_kwh: cap,
          },
          strategySource: {
            monthlySchedule: scheduleData.monthlySchedule,
            dateRules: scheduleData.dateRules,
          },
          monthlyTouPrices: scheduleData.prices,
          points: pointsPayload,
        };
        const resp = await computeStorageCycles(file, payload);
        const yearEq = computeYearEquivalentCyclesFromDays(resp.days);
        capacities.push(cap);
        yearEqCyclesList.push(yearEq);
        responses.push(resp);
      }

      if (!capacities.length) {
        setError('容量搜索未产生有效结果，请检查起始容量与步长设置。');
        return;
      }

      let bestIdx = 0;
      let bestDiff = Math.abs(yearEqCyclesList[0] - target);
      for (let i = 1; i < yearEqCyclesList.length; i++) {
        const diff = Math.abs(yearEqCyclesList[i] - target);
        if (diff < bestDiff) {
          bestDiff = diff;
          bestIdx = i;
        }
      }

      let interpCapacity = capacities[bestIdx];
      const minCycles = Math.min(...yearEqCyclesList);
      const maxCycles = Math.max(...yearEqCyclesList);
      if (target >= minCycles && target <= maxCycles) {
        for (let i = 0; i < yearEqCyclesList.length - 1; i++) {
          const c1 = yearEqCyclesList[i];
          const c2 = yearEqCyclesList[i + 1];
          if ((target >= c1 && target <= c2) || (target >= c2 && target <= c1)) {
            const cap1 = capacities[i];
            const cap2 = capacities[i + 1];
            if (c1 !== c2) {
              interpCapacity = cap1 + (target - c1) * (cap2 - cap1) / (c2 - c1);
            } else {
              interpCapacity = (cap1 + cap2) / 2;
            }
            break;
          }
        }
      }

      let finalCapacity = interpCapacity;
      let finalResp: BackendStorageCyclesResponse | null = null;
      const existingIdx = capacities.findIndex(c => Math.abs(c - interpCapacity) < 1e-6);
      if (existingIdx >= 0) {
        finalResp = responses[existingIdx];
        finalCapacity = capacities[existingIdx];
      } else {
        const payload: StorageParamsPayload = {
          storage: {
            ...baseStorage,
            capacity_kwh: interpCapacity,
          },
          strategySource: {
            monthlySchedule: scheduleData.monthlySchedule,
            dateRules: scheduleData.dateRules,
          },
          monthlyTouPrices: scheduleData.prices,
          points: pointsPayload,
        };
        // 反推容量场景也更新最近一次测算参数，便于后续导出报表
        lastPayloadRef.current = payload;
        lastFileRef.current = file;
        finalResp = await computeStorageCycles(file, payload);
      }

      const finalYearEq = computeYearEquivalentCyclesFromDays(finalResp?.days ?? []);
      setParams(p => ({ ...p, capacity_kwh: finalCapacity }));
      setResult(finalResp);
      setSolveSuggestion({
        targetYearEq: target,
        bestCapacityKwh: finalCapacity,
        bestYearEqCycles: finalYearEq,
      });
    } catch (err: any) {
      setError(err?.message || '按目标全年等效循环数反推容量失败');
    } finally {
      setLoading(false);
    }
  };

  // 批量容量对比计算：逐个容量点计算，边算边更新表格
  const handleBatchCapacityCompute = async () => {
    setError(null);
    setSolveSuggestion(null);
    setBatchResults([]);
    setSelectedBatchIdx(null);
    setBatchProgress(null);

    if (!(solveStartCapacityKwh > 0)) {
      setError('请先输入大于 0 的起始容量');
      return;
    }
    if (!(solveStepCapacityKwh > 0)) {
      setError('请先输入大于 0 的容量步长');
      return;
    }
    if (!(solveSteps > 0)) {
      setError('请先输入大于 0 的预计算步数');
      return;
    }

    const input = fileRef.current;
    let file: File | null = null;
    if (input && input.files && input.files.length > 0) {
      file = input.files[0];
      setFileName(prev => prev || file.name);
    }
    if (!file && !useAnalyzedData) {
      setError('请选择待测算的负荷文件（CSV/XLSX）或勾选"使用负荷分析已上传数据"');
      return;
    }

    if (useAnalyzedData && (!externalCleanedData || externalCleanedData.length === 0)) {
      setError('"负荷分析"页没有可用数据，请先在"负荷分析"页上传并处理，或在本页选择负荷文件。');
      return;
    }

    // ===== 新增：批量计算也支持数据清洗 =====
    let pointsPayload: { timestamp: string; load_kwh: number }[] | undefined = undefined;

    if (enableCleaning) {
      console.log('[BatchCompute] 清洗流程检查:', { enableCleaning, hasFile: !!file, useAnalyzedData });
      
      // 优先使用已清洗过的数据
      if (cleanedPointsRef.current && cleanedPointsRef.current.length > 0) {
        console.log('[BatchCompute] 使用已清洗的数据:', cleanedPointsRef.current.length, '个点');
        pointsPayload = cleanedPointsRef.current;
      } else {
        // 需要先执行清洗
        let dataForCleaning: File | { timestamp: string; load_kwh: number }[] | null = null;
        let dataSource: 'file' | 'external' = 'file';
        
        if (file && !useAnalyzedData) {
          dataForCleaning = file;
          dataSource = 'file';
        } else if (useAnalyzedData && externalCleanedData && externalCleanedData.length > 0) {
          dataForCleaning = externalCleanedData
            .slice()
            .sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime())
            .map(p => ({
              timestamp: toLocalNaiveString(p.timestamp),
              load_kwh: Number(p.load),
            }));
          dataSource = 'external';
        }
        
        if (dataForCleaning) {
          try {
            console.log('[BatchCompute] 开始数据清洗分析...', { dataSource });
            setLoading(true);
            setCyclePhase('uploading');
            setShowCycleRing(true);
            setCycleProgressPct(10);
            setProgressStep('正在分析数据质量...');
            
            const analysis = await analyzeDataForCleaning(dataForCleaning);
            console.log('[BatchCompute] 分析结果:', analysis);
            setCycleProgressPct(40);
            
            const needsConfirm = analysis.zero_spans.length > 0 || 
                                analysis.negative_spans.length > 0 ||
                                analysis.null_point_count > 0;
            
            if (needsConfirm) {
              // 保存状态，等待用户确认后再批量计算
              console.log('[BatchCompute] 需要用户确认，显示清洗对话框');
              setCleaningAnalysis(analysis);
              setCleaningDataSource(dataSource);
              if (dataSource === 'file') {
                pendingFileRef.current = file;
                pendingPointsRef.current = null;
              } else {
                pendingFileRef.current = null;
                pendingPointsRef.current = dataForCleaning as { timestamp: string; load_kwh: number }[];
              }
              setCleaningDialogVisible(true);
              setLoading(false);
              setShowCycleRing(false);
              setCyclePhase('idle');
              setProgressStep('');
              setError('请先在弹出的对话框中完成数据清洗配置，然后重新点击"开始批量计算"');
              return;
            }
            
            // 无异常，使用默认配置清洗
            setCycleProgressPct(50);
            setProgressStep('正在处理数据...');
            const defaultConfig: CleaningConfigRequest = {
              null_strategy: 'interpolate',
              negative_strategy: 'keep',
              zero_decisions: {},
            };
            const cleanResult = await applyDataCleaning(dataForCleaning, defaultConfig);
            
            cleanedPointsRef.current = cleanResult.cleaned_points.map(p => ({
              timestamp: p.timestamp,
              load_kwh: p.load_kwh,
            }));
            
            console.log('[BatchCompute] 自动清洗完成', {
              nullInterpolated: cleanResult.null_points_interpolated,
              totalPoints: cleanedPointsRef.current.length,
            });
            
            pointsPayload = cleanedPointsRef.current;
            setLoading(false);
            setShowCycleRing(false);
            setProgressStep('');
          } catch (e: any) {
            setLoading(false);
            setShowCycleRing(false);
            setCyclePhase('error');
            setProgressStep('');
            setError(`数据分析失败: ${e?.message || '未知错误'}`);
            return;
          }
        }
      }
    } else {
      // 未启用清洗，使用原始数据
      pointsPayload = (useAnalyzedData && externalCleanedData && externalCleanedData.length > 0)
        ? externalCleanedData
            .slice()
            .sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime())
            .map(p => ({
              timestamp: toLocalNaiveString(p.timestamp),
              load_kwh: Number(p.load),
            }))
        : undefined;
    }

    const baseStorage = {
      c_rate: params.c_rate,
      single_side_efficiency: params.single_side_efficiency,
      depth_of_discharge: params.depth_of_discharge,
      soc_min: params.soc_min,
      soc_max: params.soc_max,
      reserve_charge_kw: params.reserve_charge_kw,
      reserve_discharge_kw: params.reserve_discharge_kw,
      metering_mode: params.metering_mode,
      transformer_capacity_kva: params.metering_mode === 'transformer_capacity' ? params.transformer_capacity_kva : undefined,
      transformer_power_factor: params.metering_mode === 'transformer_capacity' ? params.transformer_power_factor : undefined,
      calc_style: 'window_avg' as const,
      energy_formula: params.energy_formula,
      merge_threshold_minutes: params.merge_threshold_minutes,
    };

    const hasDischarge = Array.isArray(scheduleData.monthlySchedule)
      && scheduleData.monthlySchedule.some((monthRow: any[]) =>
        Array.isArray(monthRow) && monthRow.some(cell => cell?.op === '放'));
    const hasAnyPrice = Array.isArray(scheduleData.prices)
      && scheduleData.prices.some(mp => mp && Object.values(mp).some(v => v != null));
    if (!hasDischarge) {
      setError('当前排程没有放电窗口，请先在排程/逻辑中设置"放"时段后再测算。');
      return;
    }
    if (!hasAnyPrice) {
      setError('当前电价配置全部为空，请先设置 TOU 电价（含尖/峰/平/谷）。');
      return;
    }

    const v = validateParams();
    if (v) {
      setError(v);
      return;
    }

    const steps = solveSteps > 0 ? solveSteps : SOLVE_CAPACITY_STEPS;

    // 初始化批量结果（全部 pending）
    const initialItems: BatchCapacityItem[] = [];
    for (let i = 0; i < steps; i++) {
      const cap = solveStartCapacityKwh + i * solveStepCapacityKwh;
      if (cap > 0) {
        initialItems.push({
          capacityKwh: cap,
          yearEqCycles: 0,
          firstYearProfit: 0,
          response: null,
          status: 'pending',
        });
      }
    }
    setBatchResults(initialItems);
    setBatchProgress({ current: 0, total: initialItems.length });
    setIsBatchComputing(true);

    // 逐个计算，边算边更新
    for (let i = 0; i < initialItems.length; i++) {
      // 标记当前行为 computing
      setBatchResults(prev => prev.map((item, idx) =>
        idx === i ? { ...item, status: 'computing' } : item
      ));

      const cap = initialItems[i].capacityKwh;
      
      const payload: StorageParamsPayload = {
        storage: {
          ...baseStorage,
          capacity_kwh: cap,
          // 与“单次测算”保持一致：reserve_charge_kw / reserve_discharge_kw 始终代表“充/放电余量”（不是功率上限）
          // 批量对比只改变容量，其余参数保持不变，避免同容量结果不一致。
          discharge_strategy: dischargeStrategy,
        },
        strategySource: {
          monthlySchedule: scheduleData.monthlySchedule,
          dateRules: scheduleData.dateRules,
        },
        monthlyTouPrices: scheduleData.prices,
        points: pointsPayload,
      };

      try {
        const resp = await computeStorageCycles(file, payload);
        const yearEq = computeYearEquivalentCyclesFromDays(resp.days);
        const profit = resp.year?.profit?.main?.profit ?? 0;

        setBatchResults(prev => prev.map((item, idx) =>
          idx === i ? {
            ...item,
            yearEqCycles: yearEq,
            firstYearProfit: profit,
            response: resp,
            status: 'done',
          } : item
        ));
      } catch (err: any) {
        setBatchResults(prev => prev.map((item, idx) =>
          idx === i ? {
            ...item,
            status: 'error',
            errorMsg: err?.message || '计算失败',
          } : item
        ));
      }

      setBatchProgress({ current: i + 1, total: initialItems.length });
    }

    setIsBatchComputing(false);
  };

  // 选中批量对比表中的某行，展示其详细结果
  const handleSelectBatchRow = (idx: number) => {
    setSelectedBatchIdx(idx);
    const item = batchResults[idx];
    if (item && item.response) {
      setResult(item.response);
      setParams(p => ({ ...p, capacity_kwh: item.capacityKwh }));
      // 更新 lastPayloadRef 以支持导出
      const pointsPayload = (useAnalyzedData && externalCleanedData && externalCleanedData.length > 0)
        ? externalCleanedData
            .slice()
            .sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime())
            .map(p => ({
              timestamp: toLocalNaiveString(p.timestamp),
              load_kwh: Number(p.load),
            }))
        : undefined;
      lastPayloadRef.current = {
        storage: {
          capacity_kwh: item.capacityKwh,
          c_rate: params.c_rate,
          single_side_efficiency: params.single_side_efficiency,
          depth_of_discharge: params.depth_of_discharge,
          soc_min: params.soc_min,
          soc_max: params.soc_max,
          reserve_charge_kw: params.reserve_charge_kw,
          reserve_discharge_kw: params.reserve_discharge_kw,
          metering_mode: params.metering_mode,
          transformer_capacity_kva: params.metering_mode === 'transformer_capacity' ? params.transformer_capacity_kva : undefined,
          transformer_power_factor: params.metering_mode === 'transformer_capacity' ? params.transformer_power_factor : undefined,
          calc_style: 'window_avg' as const,
          energy_formula: params.energy_formula,
          merge_threshold_minutes: params.merge_threshold_minutes,
        },
        strategySource: {
          monthlySchedule: scheduleData.monthlySchedule,
          dateRules: scheduleData.dateRules,
        },
        monthlyTouPrices: scheduleData.prices,
        points: pointsPayload,
      };
    }
  };

  // 找到最接近目标循环数的行索引
  const closestBatchIdx = useMemo(() => {
    const target = Number(targetYearEqCyclesInput);
    if (!batchResults.length || !Number.isFinite(target) || target <= 0) return -1;
    let bestIdx = -1;
    let bestDiff = Infinity;
    batchResults.forEach((item, idx) => {
      if (item.status === 'done') {
        const diff = Math.abs(item.yearEqCycles - target);
        if (diff < bestDiff) {
          bestDiff = diff;
          bestIdx = idx;
        }
      }
    });
    return bestIdx;
  }, [batchResults, targetYearEqCyclesInput]);

  // 按需导出调试报表：复用最近一次测算的 payload 与文件，仅在用户点击时触发后端导出
  const handleExportDebugExcel = async () => {
    if (!result) {
      setError('请先完成一次储能次数测算，再导出 Excel 报表。');
      return;
    }
    const payload = lastPayloadRef.current;
    const file = lastFileRef.current;
    if (!payload) {
      setError('未找到最近一次测算参数，请重新测算后再导出报表。');
      return;
    }
    try {
      setLoading(true);
      setProgressStep('正在导出调试报表（详细结果）...');
      const resp = await exportStorageCyclesReport(file ?? null, payload);
      // 导出报表不影响当前主结果，仅用于获取 excel_path
      if (resp.excel_path) {
        // 构造完整的后端文件 URL：优先使用绝对 URL，其次拼接后端 BASE_URL
        const path = resp.excel_path;
        const url = path.startsWith('http')
          ? path
          : `${STORAGE_BACKEND_BASE_URL}${path.startsWith('/') ? '' : '/'}${path}`;
        window.open(url, '_blank', 'noopener,noreferrer');
      } else {
        setError('后端未返回报表下载地址，请稍后重试。');
      }
    } catch (e: any) {
      setError(e?.message || '导出 Excel 报表失败，请稍后重试。');
    } finally {
      setProgressStep('');
      setLoading(false);
    }
  };

  // 导出运行与收益业务报表：更贴近业务视角的多表 CSV（ZIP 打包）
  const handleExportBusinessExcel = async () => {
    if (!result) {
      setError('请先完成一次储能次数测算，再导出 Excel 报表。');
      return;
    }
    const payload = lastPayloadRef.current;
    const file = lastFileRef.current;
    if (!payload) {
      setError('未找到最近一次测算参数，请重新测算后再导出报表。');
      return;
    }
    try {
      setLoading(true);
      setProgressStep('正在导出运行与收益报表（CSV）...');
      const resp = await exportStorageBusinessReport(file ?? null, payload);
      if (resp.excel_path) {
        const path = resp.excel_path;
        const url = path.startsWith('http')
          ? path
          : `${STORAGE_BACKEND_BASE_URL}${path.startsWith('/') ? '' : '/'}${path}`;
        window.open(url, '_blank', 'noopener,noreferrer');
      } else {
        setError('后端未返回报表下载地址，请稍后重试。');
      }
    } catch (e: any) {
      setError(e?.message || '导出运行与收益报表失败，请稍后重试。');
    } finally {
      setProgressStep('');
      setLoading(false);
    }
  };

  // ========== 图表渲染（ECharts 动态加载） ==========
  const monthChartRef = useRef<HTMLDivElement>(null);
  const dayChartRef = useRef<HTMLDivElement>(null);
  const heatmapChartRef = useRef<HTMLDivElement>(null);
  const tipDayChartRef = useRef<HTMLDivElement>(null);
  const [selectedMonth, setSelectedMonth] = useState<string | null>(null);
  const [selectedDayForProfit, setSelectedDayForProfit] = useState<string | null>(null);
  const [monthlyViewMode, setMonthlyViewMode] = useState<'aggregate' | 'byYear'>('aggregate');

  const monthsData = useMemo(() => result?.months || [], [result]);
  const daysData = useMemo(() => result?.days || [], [result]);
  const tipSummary = useMemo(() => {
    const rawNullable =
      (result as any)?.tip_discharge_summary ??
      (result as any)?.tip_discharge ??
      (result as any)?.tip;
    if (!rawNullable) return null;
    const raw: BackendTipDischargeSummary = rawNullable;
    const avg = Number(
      raw.avg_tip_load_kw ??
      (raw as any)?.avg_kw ??
      (raw as any)?.avg_load_kw ??
      (raw as any)?.tip_avg_kw ??
      0,
    );
    const tipHours = Number(
      raw.tip_hours ??
      (raw as any)?.hours ??
      (raw as any)?.duration_hours ??
      0,
    );
    const dischargeCount = Number(
      raw.discharge_count ??
      (raw as any)?.cycles ??
      (raw as any)?.count ??
      0,
    );
    const capacity = Number(
      (raw.capacity_kwh ?? (raw as any)?.capacity ?? params.capacity_kwh) ?? 0,
    );
    const energyNeed = (() => {
      const v =
        raw.energy_need_kwh ??
        (raw as any)?.tip_energy_need_kwh ??
        (raw as any)?.energy_need;
      if (v != null) return Number(v);
      return avg * tipHours;
    })();
    const ratioFromBackend = (() => {
      const v =
        raw.tip_ratio ??
        raw.ratio_tip ??
        (raw as any)?.tip_ratio ??
        (raw as any)?.ratio_tip ??
        null;
      if (v == null) return null;
      const num = Number(v);
      if (!Number.isFinite(num)) return null;
      return Math.min(1, Math.max(0, num));
    })();
    const ratioCalculated =
      dischargeCount <= 0 || !capacity || tipHours <= 0
        ? 0
        : Math.min(1, (capacity * dischargeCount) > 0 ? energyNeed / (capacity * dischargeCount) : 0);
    return {
      ratio: ratioFromBackend ?? ratioCalculated,
      avgTipLoadKw: avg,
      tipHours,
      dischargeCount,
      capacityKwh: capacity,
      energyNeedKwh: energyNeed,
      note: raw.note,
      tipPoints: (raw as any)?.tip_points ?? (raw as any)?.points,
      dayStats: (raw as any)?.day_stats,
      monthStats: (raw as any)?.month_stats,
    };
  }, [params.capacity_kwh, result]);
  const tipMonthMap = useMemo(() => {
    const stats = tipSummary?.monthStats;
    if (!stats) return [];
    const arr: Array<number | null> = new Array(12).fill(null);
    stats.forEach((m) => {
      const idx = Number(m.month) - 1;
      if (idx >= 0 && idx < 12 && m.ratio != null) {
        arr[idx] = Number(m.ratio);
      }
    });
    return arr;
  }, [tipSummary?.monthStats]);

  // 月度曲线：按“月份维度”聚合不同年份（同一月份的 cycles 求和）
  const monthAxisLabels = useMemo(
    () => Array.from({ length: 12 }, (_, i) => `${i + 1}月`),
    [],
  );

  const aggregatedMonthlyCycles = useMemo(() => {
    const sums = new Array(12).fill(0);
    const hasData = new Array(12).fill(false);
    monthsData.forEach((m: any) => {
      if (!m?.year_month) return;
      const parts = String(m.year_month).split('-');
      if (parts.length !== 2) return;
      const month = parseInt(parts[1], 10);
      if (!month || month < 1 || month > 12) return;
      const idx = month - 1;
      sums[idx] += Number(m.cycles ?? 0);
      hasData[idx] = true;
    });
    // 对于完全没有数据的月份返回 null，使折线在该点断开
    return sums.map((v, idx) => (hasData[idx] ? v : null));
  }, [monthsData]);

  // 热力图维度：横轴为 1–31 日，纵轴为 1–12 月
  const heatmapXAxisDays = useMemo(
    () => Array.from({ length: 31 }, (_, i) => String(i + 1).padStart(2, '0')),
    [],
  );
  const heatmapYAxisMonths = useMemo(
    () => Array.from({ length: 12 }, (_, i) => `${i + 1}月`),
    [],
  );

  // 将日度数据转换为 12×31 的热力图矩阵
  const heatmapData = useMemo(() => {
    if (!daysData.length) return [] as number[][];
    const valueMap = new Map<string, number>();
    daysData.forEach((d: any) => {
      if (!d?.date) return;
      const parts = String(d.date).split('-');
      if (parts.length !== 3) return;
      const m = parseInt(parts[1], 10);
      const day = parseInt(parts[2], 10);
      if (!m || !day) return;
      const key = `${m}-${day}`;
      valueMap.set(key, Number(d.cycles ?? 0));
    });
    const data: number[][] = [];
    for (let m = 1; m <= 12; m++) {
      for (let d = 1; d <= 31; d++) {
        const v = valueMap.get(`${m}-${d}`) ?? 0;
        // x: 第几日（0-based），y: 第几月（0-based）
        data.push([d - 1, m - 1, v]);
      }
    }
    return data;
  }, [daysData]);

  // 按天数据统计：每月有效天数 / 有效循环数 / 等效循环数 + 年度汇总
  const {
    monthValidDays,
    monthTotalCycles,
    monthEquivalentCycles,
    yearValidDays,
    yearTotalCycles,
    yearEquivalentCycles,
    monthFirstChargeRatePct,
    monthFirstDischargeRatePct,
    monthSecondChargeRatePct,
    monthSecondDischargeRatePct,
  } = useMemo(() => {
    const monthDaySets: Array<Set<string>> = Array.from({ length: 12 }, () => new Set<string>());
    const monthTotal: number[] = new Array(12).fill(0);
    const monthYear: Array<number | null> = new Array(12).fill(null);
    const yearDaySet = new Set<string>();

    daysData.forEach((d: any) => {
      if (!d?.date) return;
      const parts = String(d.date).split('-');
      if (parts.length !== 3) return;
      const year = parseInt(parts[0], 10);
      const month = parseInt(parts[1], 10);
      if (!year || !month || month < 1 || month > 12) return;
      const idx = month - 1;
      const dateKey = String(d.date);
      const cyclesVal = Number(d.cycles ?? 0);
      // 有效天数判断：使用后端返回的 is_valid 标记
      // is_valid = true → 该天有正负荷数据
      // is_valid = false → 该天无负荷数据或负荷全为零
      if (hasValidDayData(d)) {
        monthDaySets[idx].add(dateKey);
        yearDaySet.add(dateKey);
      }
      monthTotal[idx] += cyclesVal;
      if (monthYear[idx] == null) {
        monthYear[idx] = year;
      }
    });

    const monthValidDaysArr: number[] = new Array(12).fill(0);
    const monthEqCyclesArr: Array<number | null> = new Array(12).fill(null);

    // 从后端 window_month_summary 中取 C1/C2 + charge/discharge 的月度循环数
    const firstChargeCycles: number[] = new Array(12).fill(0);
    const firstDischargeCycles: number[] = new Array(12).fill(0);
    const secondChargeCycles: number[] = new Array(12).fill(0);
    const secondDischargeCycles: number[] = new Array(12).fill(0);

    (result?.window_month_summary ?? []).forEach((m: any) => {
      if (!m?.year_month) return;
      const parts = String(m.year_month).split('-');
      if (parts.length !== 2) return;
      const month = parseInt(parts[1], 10);
      if (!month || month < 1 || month > 12) return;
      const idx = month - 1;
      firstChargeCycles[idx] += Number(m.first_charge_cycles ?? 0);
      firstDischargeCycles[idx] += Number(m.first_discharge_cycles ?? 0);
      secondChargeCycles[idx] += Number(m.second_charge_cycles ?? 0);
      secondDischargeCycles[idx] += Number(m.second_discharge_cycles ?? 0);
    });

    const firstChargeRatePct: Array<number | null> = new Array(12).fill(null);
    const firstDischargeRatePct: Array<number | null> = new Array(12).fill(null);
    const secondChargeRatePct: Array<number | null> = new Array(12).fill(null);
    const secondDischargeRatePct: Array<number | null> = new Array(12).fill(null);

    for (let i = 0; i < 12; i++) {
      const validDays = monthDaySets[i].size;
      monthValidDaysArr[i] = validDays;
      if (validDays > 0) {
        const y = monthYear[i] ?? new Date().getFullYear();
        // 计算该月自然天数（处理好 2 月闰年）
        const monthDaysCount = new Date(y, i + 1, 0).getDate();
        const total = monthTotal[i];
        monthEqCyclesArr[i] = (total / validDays) * monthDaysCount;

        // “满充率/满放率”= 日均次数 × 100%（单位 %）
        const d = validDays;
        const fCharge = firstChargeCycles[i];
        const fDischarge = firstDischargeCycles[i];
        const sCharge = secondChargeCycles[i];
        const sDischarge = secondDischargeCycles[i];
        firstChargeRatePct[i] = d > 0 ? fCharge / d : null;
        firstDischargeRatePct[i] = d > 0 ? fDischarge / d : null;
        secondChargeRatePct[i] = d > 0 ? sCharge / d : null;
        secondDischargeRatePct[i] = d > 0 ? sDischarge / d : null;
      }
    }

    const yearValidDaysCount = yearDaySet.size;
    const yearTotalCyclesVal = monthTotal.reduce((sum, v) => sum + v, 0);
    
    // 修复：全年等效循环数应基于全年有效天数的日均循环数 × 365
    // 而不是简单累加各月的等效值（会漏掉整月无数据的月份）
    const yearEqCyclesVal = yearValidDaysCount > 0
      ? (yearTotalCyclesVal / yearValidDaysCount) * 365
      : 0;

    return {
      monthValidDays: monthValidDaysArr,
      monthTotalCycles: monthTotal,
      monthEquivalentCycles: monthEqCyclesArr,
      yearValidDays: yearValidDaysCount,
      yearTotalCycles: yearTotalCyclesVal,
      yearEquivalentCycles: yearEqCyclesVal,
      monthFirstChargeRatePct: firstChargeRatePct,
      monthFirstDischargeRatePct: firstDischargeRatePct,
      monthSecondChargeRatePct: secondChargeRatePct,
      monthSecondDischargeRatePct: secondDischargeRatePct,
    };
  }, [daysData, result?.window_month_summary]);

  const avgOrNull = useMemo(
    () => (vals: Array<number | null>) => {
      const arr = vals.filter(v => v != null && !Number.isNaN(Number(v))) as number[];
      if (!arr.length) return null;
      return arr.reduce((s, v) => s + v, 0) / arr.length;
    },
    [],
  );
  const avgFirstChargeRate = useMemo(() => avgOrNull(monthFirstChargeRatePct), [avgOrNull, monthFirstChargeRatePct]);
  const avgFirstDischargeRate = useMemo(() => avgOrNull(monthFirstDischargeRatePct), [avgOrNull, monthFirstDischargeRatePct]);
  const avgSecondChargeRate = useMemo(() => avgOrNull(monthSecondChargeRatePct), [avgOrNull, monthSecondChargeRatePct]);
  const avgSecondDischargeRate = useMemo(() => avgOrNull(monthSecondDischargeRatePct), [avgOrNull, monthSecondDischargeRatePct]);
  const avgTipRatio = useMemo(() => avgOrNull(tipMonthMap), [avgOrNull, tipMonthMap]);

  // KPI 概览卡片：年累计、月均、最高月与最低月
  const kpiMetrics = useMemo(() => {
    if (!result) return null;
    const totalCycles = Number(result.year?.cycles ?? 0);

    const monthList = monthsData
      .map(m => ({
        yearMonth: m.year_month,
        cycles: Number((m as any)?.cycles ?? 0),
      }))
      .filter(m => Number.isFinite(m.cycles));

    if (!monthList.length) {
      return {
        totalCycles,
        avgCycles: 0,
        maxMonth: null as { yearMonth: string; cycles: number } | null,
        minMonth: null as { yearMonth: string; cycles: number } | null,
      };
    }

    let maxMonth = monthList[0];
    let minMonth = monthList[0];
    for (const m of monthList) {
      if (m.cycles > maxMonth.cycles) maxMonth = m;
      if (m.cycles < minMonth.cycles) minMonth = m;
    }
    const avgCycles = monthList.length ? totalCycles / monthList.length : 0;

    return {
      totalCycles,
      avgCycles,
      maxMonth,
      minMonth,
    };
  }, [result, monthsData]);

  useEffect(() => {
    if (!monthsData.length) { setSelectedMonth(null); return; }
    if (selectedMonth && monthsData.find(m => m.year_month === selectedMonth)) return;
    setSelectedMonth(monthsData[0]?.year_month || null);
  }, [monthsData, selectedMonth]);

  const daysInSelectedMonth = useMemo(() => {
    if (!selectedMonth) return [];
    return daysData
      .filter(d => d.date && d.date.startsWith(selectedMonth))
      .map(d => d.date)
      .sort();
  }, [daysData, selectedMonth]);

  useEffect(() => {
    if (!daysInSelectedMonth.length) {
      setSelectedDayForProfit(null);
      return;
    }
    setSelectedDayForProfit(prev =>
      prev && daysInSelectedMonth.includes(prev) ? prev : daysInSelectedMonth[0],
    );
  }, [daysInSelectedMonth]);

  // 动态加载 ECharts（复用其他组件做法）
  const loadECharts = (): Promise<any> => {
    return new Promise((resolve, reject) => {
      const w = window as any;
      if (w.echarts) return resolve(w.echarts);
      const script = document.createElement('script');
      script.src = 'https://cdn.jsdelivr.net/npm/echarts@5/dist/echarts.min.js';
      script.async = true;
      script.onload = () => resolve(w.echarts);
      script.onerror = (e) => reject(e);
      document.head.appendChild(script);
    });
  };

  useEffect(() => {
    let chart: any = null;
    let onResize: (() => void) | null = null;
    loadECharts().then((echarts: any) => {
      if (!monthChartRef.current) return;
      chart = echarts.init(monthChartRef.current);
      onResize = () => {
        try { chart && chart.resize && chart.resize(); } catch { /* ignore */ }
      };
      window.addEventListener('resize', onResize);
      const cats =
        monthlyViewMode === 'aggregate'
          ? monthAxisLabels
          : monthsData.map(m => m.year_month);
      const vals =
        monthlyViewMode === 'aggregate'
          ? aggregatedMonthlyCycles
          : monthsData.map(m => Number(m.cycles ?? 0));
      chart.setOption({
        tooltip: {
          trigger: 'axis',
          formatter: (params: any) => {
            const p = Array.isArray(params) ? params[0] : params;
            const label = p.axisValue;
            const value =
              p.data == null || Number.isNaN(Number(p.data))
                ? '-'
                : Number(p.data).toFixed(3);
            if (monthlyViewMode === 'aggregate') {
              // 按月合计视图：月份 + 合计次数
              return `${label}：合计 ${value} 次`;
            }
            // 按年拆分视图：直接显示对应 year_month 的次数
            return `${label}：${value} 次`;
          },
        },
        xAxis: {
          type: 'category',
          data: cats,
          name: '月份',
          axisLine: { lineStyle: { color: '#cbd5f5' } },
          splitLine: { show: false },
        },
        yAxis: {
          type: 'value',
          name: '次数',
          axisLine: { lineStyle: { color: '#cbd5f5' } },
          splitLine: { show: true, lineStyle: { color: '#e5e7eb', type: 'dashed' } },
        },
        toolbox: {
          feature: {
            saveAsImage: {
              name: 'storage-cycles-monthly',
            },
          },
          right: 10,
          top: 10,
        },
        series: [{
          name: '月度次数',
          type: 'line',
          data: vals,
          smooth: true,
          // 在“按月合计”模式下遇到 null 会断开；按年拆分模式下 monthsData 不会出现 null
          areaStyle: { color: 'rgba(96,165,250,0.15)' },
          itemStyle: { color: '#60a5fa' },
        }],
        grid: { left: 40, right: 20, bottom: 40, top: 30 },
      });
      setTimeout(() => { try { chart && chart.resize && chart.resize(); } catch { /* ignore */ } }, 0);
      setTimeout(() => { try { chart && chart.resize && chart.resize(); } catch { /* ignore */ } }, 200);
    }).catch(() => {/* ignore */});
    return () => {
      try { if (onResize) window.removeEventListener('resize', onResize); } catch { /* ignore */ }
      try { chart && chart.dispose && chart.dispose(); } catch { /* ignore */ }
    };
  }, [aggregatedMonthlyCycles, monthAxisLabels, monthsData, monthlyViewMode]);

  useEffect(() => {
    let chart: any = null;
    let onResize: (() => void) | null = null;
    loadECharts().then((echarts: any) => {
      if (!dayChartRef.current) return;
      chart = echarts.init(dayChartRef.current);
      onResize = () => {
        try { chart && chart.resize && chart.resize(); } catch { /* ignore */ }
      };
      window.addEventListener('resize', onResize);
      const days = daysData.filter(d => selectedMonth && d.date.startsWith(selectedMonth));
      const cats = days.map(d => d.date.slice(5));
      const vals = days.map(d => Number(d.cycles ?? 0));
      chart.setOption({
        tooltip: {
          trigger: 'axis',
          formatter: (params: any) => {
            const p = Array.isArray(params) ? params[0] : params;
            const label = p.axisValue;
            const value =
              p.data == null || Number.isNaN(Number(p.data))
                ? '-'
                : Number(p.data).toFixed(3);
            return `${label}：${value} 次`;
          },
        },
        xAxis: {
          type: 'category',
          data: cats,
          name: '日期',
          axisLine: { lineStyle: { color: '#cbd5f5' } },
          splitLine: { show: false },
        },
        yAxis: {
          type: 'value',
          name: '次数',
          axisLabel: {
            formatter: (value: number) =>
              Number.isNaN(Number(value)) ? '-' : Number(value).toFixed(3),
          },
          axisLine: { lineStyle: { color: '#cbd5f5' } },
          splitLine: { show: true, lineStyle: { color: '#e5e7eb', type: 'dashed' } },
        },
        toolbox: {
          feature: {
            saveAsImage: {
              name: 'storage-cycles-daily',
            },
          },
          right: 10,
          top: 10,
        },
        series: [{ name: '日度次数', type: 'line', data: vals, smooth: true, itemStyle: { color: '#34d399' } }],
        grid: { left: 40, right: 20, bottom: 40, top: 30 },
      });
      setTimeout(() => { try { chart && chart.resize && chart.resize(); } catch { /* ignore */ } }, 0);
      setTimeout(() => { try { chart && chart.resize && chart.resize(); } catch { /* ignore */ } }, 200);
    }).catch(() => {/* ignore */});
    return () => {
      try { if (onResize) window.removeEventListener('resize', onResize); } catch { /* ignore */ }
      try { chart && chart.dispose && chart.dispose(); } catch { /* ignore */ }
    };
  }, [daysData, selectedMonth]);

  // 全年每日充放次数热力图
  useEffect(() => {
    let chart: any = null;
    let onResize: (() => void) | null = null;
    loadECharts().then((echarts: any) => {
      if (!heatmapChartRef.current) return;
      chart = echarts.init(heatmapChartRef.current);
      onResize = () => {
        try { chart && chart.resize && chart.resize(); } catch { /* ignore */ }
      };
      window.addEventListener('resize', onResize);
      const maxVal = heatmapData.reduce((max, d) => (d[2] > max ? d[2] : max), 0) || 1;
      chart.setOption({
        tooltip: {
          position: 'top',
          formatter: (params: any) => {
            const xIdx = params.data[0];
            const yIdx = params.data[1];
            const v = params.data[2];
            const dayLabel = heatmapXAxisDays[xIdx] ?? '';
            const monthLabel = heatmapYAxisMonths[yIdx] ?? '';
            const value =
              v == null || Number.isNaN(Number(v))
                ? '-'
                : Number(v).toFixed(3);
            return `${monthLabel}${dayLabel}日<br/>充放次数：${value}`;
          },
        },
        grid: { left: 60, right: 40, top: 40, bottom: 40 },
        xAxis: {
          type: 'category',
          data: heatmapXAxisDays,
          name: '日',
          splitArea: { show: true },
        },
        yAxis: {
          type: 'category',
          data: heatmapYAxisMonths,
          name: '月',
          // 反向显示，使 1 月在上方、12 月在下方
          inverse: true,
          splitArea: { show: true },
        },
        toolbox: {
          feature: {
            saveAsImage: {
              name: 'storage-cycles-heatmap',
            },
          },
          right: 10,
          top: 10,
        },
        visualMap: {
          min: 0,
          max: maxVal,
          calculable: true,
          orient: 'vertical',
          right: 0,
          top: 'middle',
          inRange: {
            color: ['#eff6ff', '#3b82f6', '#1e40af'],
          },
        },
        series: [{
          name: '每日充放次数',
          type: 'heatmap',
          data: heatmapData,
        }],
      });
      setTimeout(() => { try { chart && chart.resize && chart.resize(); } catch { /* ignore */ } }, 0);
      setTimeout(() => { try { chart && chart.resize && chart.resize(); } catch { /* ignore */ } }, 200);
    }).catch(() => {/* ignore */});
    return () => {
      try { if (onResize) window.removeEventListener('resize', onResize); } catch { /* ignore */ }
      try { chart && chart.dispose && chart.dispose(); } catch { /* ignore */ }
    };
  }, [heatmapData, heatmapXAxisDays, heatmapYAxisMonths]);

  // 尖放电占比：日度折线
  useEffect(() => {
    let chart: any = null;
    let onResize: (() => void) | null = null;
    loadECharts().then((echarts: any) => {
      if (!tipDayChartRef.current || !tipSummary?.dayStats) return;
      const data = tipSummary.dayStats;
      chart = echarts.init(tipDayChartRef.current);
      onResize = () => {
        try { chart && chart.resize && chart.resize(); } catch { /* ignore */ }
      };
      window.addEventListener('resize', onResize);
      chart.setOption({
        tooltip: {
          trigger: 'axis',
          formatter: (params: any) => {
            const p = Array.isArray(params) ? params[0] : params;
            const val = p?.data?.value ?? p?.data ?? 0;
            return `${p?.axisValue || ''}<br/>尖占比：${(Number(val) * 100).toFixed(1)}%`;
          },
        },
        grid: { left: 40, right: 10, top: 20, bottom: 30 },
        xAxis: {
          type: 'category',
          data: data.map(d => d.date?.slice(5) || ''),
          axisLabel: { interval: 'auto', rotate: 45, fontSize: 10 },
          axisLine: { lineStyle: { color: '#cbd5f5' } },
          splitLine: { show: false },
        },
        yAxis: {
          type: 'value',
          min: 0,
          max: 1,
          axisLabel: { formatter: (v: number) => `${(v * 100).toFixed(0)}%` },
          axisLine: { lineStyle: { color: '#cbd5f5' } },
          splitLine: { show: true, lineStyle: { color: '#e5e7eb', type: 'dashed' } },
        },
        series: [{
          type: 'line',
          data: data.map(d => Number(d.ratio ?? 0)),
          smooth: true,
          itemStyle: { color: '#f97316' },
          areaStyle: { color: 'rgba(249,115,22,0.12)' },
        }],
      });
      setTimeout(() => { try { chart && chart.resize && chart.resize(); } catch { /* ignore */ } }, 0);
      setTimeout(() => { try { chart && chart.resize && chart.resize(); } catch { /* ignore */ } }, 200);
    }).catch(() => {/* ignore */});
    return () => {
      try { if (onResize) window.removeEventListener('resize', onResize); } catch { /* ignore */ }
      try { chart && chart.dispose && chart.dispose(); } catch { /* ignore */ }
    };
  }, [tipSummary?.dayStats, tipSummary?.ratio]);

  // 不再使用旧伪进度条逻辑，保留占位以防后续扩展


  return (
    <div className="space-y-8">
      <div id="section-cycles-upload" className="scroll-mt-24 p-6 bg-white rounded-xl shadow-lg space-y-4">
        <div className="flex items-center gap-3">
          <input ref={fileRef} type="file" accept=".csv,.xlsx,.xls" className="sr-only" onChange={() => setFileName(fileRef.current?.files?.[0]?.name || '')} />
          <button className="px-3 py-1.5 rounded bg-blue-600 text-white text-sm whitespace-nowrap w-[110px]" onClick={() => fileRef.current?.click()}>
            选择负荷文件
          </button>
          <span className="text-sm text-slate-600 whitespace-nowrap max-w-[160px] overflow-hidden text-ellipsis">{fileName || '未选择文件'}</span>
          <div className="flex items-center gap-2 w-full">
            {showCycleRing && (
              <div className="flex items-center gap-2">
                <UploadProgressRing
                  progress={cycleProgressPct}
                  status={cyclePhase === 'computing' ? 'computing' : cyclePhase === 'uploading' ? 'uploading' : cyclePhase === 'done' ? 'done' : cyclePhase === 'error' ? 'error' : 'idle'}
                  size={36}
                  stroke={4}
                  labelOverride={cyclePhase === 'computing' ? '计算' : undefined}
                />
                {/* 步骤提示文字 */}
                {progressStep && (
                  <span className="text-[12px] text-blue-600 font-medium animate-pulse">{progressStep}</span>
                )}
                {cyclePhase === 'uploading' && uploadEtaSeconds != null && (
                  <span className="text-[11px] text-slate-600 w-16">剩余≈{Math.max(1, Math.round(uploadEtaSeconds))}秒</span>
                )}
                {(cyclePhase === 'uploading' || cyclePhase === 'computing') && (
                  <button
                    type="button"
                    onClick={() => {
                      try { cycleAbortRef.current(); } catch { /* ignore */ }
                      setCyclePhase('error');
                      setError('已取消测算');
                      setShowCycleRing(false);
                      setLoading(false);
                      setProgressStep('');
                    }}
                    className="text-[11px] px-2 py-1 rounded border border-slate-300 text-slate-600 hover:bg-slate-50"
                  >取消</button>
                )}
              </div>
            )}
            {/* 跳转收益对比按钮移至主操作区最右侧 */}
            {onNavigateProfit && (
              <div className="flex-1 flex justify-end items-center">
                <button
                  type="button"
                  className="px-3 py-1.5 rounded bg-blue-600 text-white text-sm ml-4"
                  disabled={!selectedDayForProfit}
                  onClick={() => {
                    if (selectedDayForProfit) onNavigateProfit(selectedDayForProfit);
                  }}
                >跳转收益对比</button>
              </div>
            )}
          </div>
        </div>
        {/* 已替换为环形进度，不再显示旧线性条 */}

        <div className="grid grid-cols-1 md:grid-cols-2 gap-3 text-sm">
          <label className="flex items-center gap-2">
            <input type="checkbox" checked={useAnalyzedData} onChange={e => setUseAnalyzedData(e.target.checked)} />
            <span>使用“负荷分析”页已上传数据</span>
          </label>
          <div className="text-xs text-slate-500">
            {hasExternalData
              ? '勾选后将复用全局已清洗的小时级负荷数据，无需在本页重复上传。'
              : '当前暂无可复用的“负荷分析”页数据，仅支持通过本页上传负荷文件。'}
          </div>
        </div>


        {/* 数据清洗开关 */}
        <div className="flex items-center gap-3 text-sm bg-blue-50 p-3 rounded-lg">
          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={enableCleaning}
              onChange={e => setEnableCleaning(e.target.checked)}
            />
            <span className="font-medium">启用数据清洗</span>
          </label>
          <span className="text-xs text-slate-600">
            {enableCleaning
              ? '上传文件后将检测零值/负值/空值，由您确认后再计算'
              : '直接使用原始数据计算，不做任何清洗处理'}
          </span>
        </div>

        {/* 参数表单：模板选择 + 左右双栏布局（基础 + 高级） */}
        <div id="section-cycles-params" className="scroll-mt-24 space-y-4 text-sm">
          {/* 快速模板选择 */}
          <div className="bg-gradient-to-r from-slate-50 to-white border border-slate-200 rounded-lg p-3">
            <div className="flex items-center gap-2 mb-2">
              <span className="text-sm font-semibold text-slate-800">📋 快速模板</span>
              <span className="text-xs text-slate-500">选择场景模板快速配置参数</span>
              {activeTemplateId && (
                <span className="ml-auto px-2 py-0.5 bg-emerald-100 text-emerald-700 rounded text-xs">
                  当前: {allTemplates.find(t => t.id === activeTemplateId)?.name}
                </span>
              )}
              {activeTemplateId === null && (
                <span className="ml-auto px-2 py-0.5 bg-slate-200 text-slate-600 rounded text-xs">
                  已自定义
                </span>
              )}
            </div>
            <div className="flex flex-wrap gap-2">
              {/* 系统预设模板 */}
              {STORAGE_PARAMS_TEMPLATES.map(template => (
                <div key={template.id} className="relative group">
                  <button
                    type="button"
                    onClick={() => handleApplyTemplate(template)}
                    className={`px-3 py-1.5 rounded-lg text-sm font-medium transition-all flex items-center gap-1.5 ${
                      activeTemplateId === template.id
                        ? 'bg-emerald-600 text-white shadow-md'
                        : 'bg-white border border-slate-300 text-slate-700 hover:border-emerald-400 hover:bg-emerald-50'
                    }`}
                    title={template.description}
                  >
                    <span>{template.icon}</span>
                    <span>{template.name}</span>
                  </button>
                  {/* 系统模板编辑按钮（会创建副本） */}
                  <button
                    type="button"
                    onClick={(e) => { e.stopPropagation(); handleEditTemplate(template); }}
                    className="absolute -top-1 -right-1 w-5 h-5 rounded-full bg-slate-500 text-white text-xs opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center"
                    title="基于此模板创建新模板"
                  >
                    ✎
                  </button>
                </div>
              ))}
              {/* 用户自定义模板 */}
              {userTemplates.map(template => (
                <div key={template.id} className="relative group">
                  <button
                    type="button"
                    onClick={() => handleApplyTemplate(template)}
                    className={`px-3 py-1.5 rounded-lg text-sm font-medium transition-all flex items-center gap-1.5 ${
                      activeTemplateId === template.id
                        ? 'bg-blue-600 text-white shadow-md'
                        : 'bg-blue-50 border border-blue-300 text-blue-700 hover:border-blue-400 hover:bg-blue-100'
                    }`}
                    title={template.description}
                  >
                    <span>{template.icon}</span>
                    <span>{template.name}</span>
                  </button>
                  {/* 用户模板编辑按钮 */}
                  <button
                    type="button"
                    onClick={(e) => { e.stopPropagation(); handleEditTemplate(template); }}
                    className="absolute -top-1 -right-1 w-5 h-5 rounded-full bg-blue-500 text-white text-xs opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center"
                    title="编辑模板"
                  >
                    ✎
                  </button>
                  {/* 用户模板删除按钮 */}
                  <button
                    type="button"
                    onClick={(e) => { e.stopPropagation(); handleDeleteTemplate(template.id); }}
                    className="absolute -top-1 -left-1 w-5 h-5 rounded-full bg-red-500 text-white text-xs opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center"
                    title="删除模板"
                  >
                    ×
                  </button>
                </div>
              ))}
              {/* 新建模板按钮 */}
              <button
                type="button"
                onClick={handleCreateTemplate}
                className="px-3 py-1.5 rounded-lg text-sm font-medium transition-all bg-white border border-dashed border-slate-400 text-slate-600 hover:border-emerald-400 hover:bg-emerald-50 hover:text-emerald-700 flex items-center gap-1.5"
                title="将当前参数保存为新模板"
              >
                <span>➕</span>
                <span>保存为模板</span>
              </button>
              {/* 自定义按钮 */}
              <button
                type="button"
                onClick={() => setActiveTemplateId(null)}
                className={`px-3 py-1.5 rounded-lg text-sm font-medium transition-all ${
                  activeTemplateId === null
                    ? 'bg-slate-600 text-white shadow-md'
                    : 'bg-white border border-slate-300 text-slate-700 hover:border-slate-400'
                }`}
              >
                🔧 自定义
              </button>
            </div>
            {activeTemplateId && allTemplates.find(t => t.id === activeTemplateId) && (
              <div className="mt-2 text-xs text-slate-600 bg-slate-100 rounded px-2 py-1.5">
                <span className="font-medium">排程建议：</span>
                {allTemplates.find(t => t.id === activeTemplateId)?.scheduleHint}
              </div>
            )}
          </div>

          {/* 模板编辑对话框 */}
          {templateEditVisible && (
            <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
              <div className="bg-white rounded-lg shadow-xl w-full max-w-md mx-4">
                <div className="px-4 py-3 border-b flex items-center justify-between">
                  <h3 className="font-semibold text-slate-800">
                    {editingTemplate
                      ? STORAGE_PARAMS_TEMPLATES.some(t => t.id === editingTemplate.id)
                        ? `基于"${editingTemplate.name}"创建新模板`
                        : `编辑模板: ${editingTemplate.name}`
                      : '创建新模板'
                    }
                  </h3>
                  <button
                    type="button"
                    onClick={() => setTemplateEditVisible(false)}
                    className="text-slate-400 hover:text-slate-600 text-xl"
                  >
                    ×
                  </button>
                </div>
                <div className="p-4 space-y-4">
                  <div className="grid grid-cols-4 gap-3">
                    <label className="col-span-1 flex flex-col gap-1">
                      <span className="text-sm text-slate-700">图标</span>
                      <input
                        type="text"
                        value={templateForm.icon}
                        onChange={e => setTemplateForm(f => ({ ...f, icon: e.target.value }))}
                        className="border rounded px-2 py-1.5 text-center text-lg"
                        maxLength={2}
                      />
                    </label>
                    <label className="col-span-3 flex flex-col gap-1">
                      <span className="text-sm text-slate-700">模板名称 *</span>
                      <input
                        type="text"
                        value={templateForm.name}
                        onChange={e => setTemplateForm(f => ({ ...f, name: e.target.value }))}
                        className="border rounded px-2 py-1.5"
                        placeholder="输入模板名称"
                      />
                    </label>
                  </div>
                  <label className="flex flex-col gap-1">
                    <span className="text-sm text-slate-700">描述</span>
                    <input
                      type="text"
                      value={templateForm.description}
                      onChange={e => setTemplateForm(f => ({ ...f, description: e.target.value }))}
                      className="border rounded px-2 py-1.5"
                      placeholder="简要描述模板用途"
                    />
                  </label>
                  <label className="flex flex-col gap-1">
                    <span className="text-sm text-slate-700">排程建议</span>
                    <input
                      type="text"
                      value={templateForm.scheduleHint}
                      onChange={e => setTemplateForm(f => ({ ...f, scheduleHint: e.target.value }))}
                      className="border rounded px-2 py-1.5"
                      placeholder="建议的充放电时段安排"
                    />
                  </label>
                  <div className="bg-slate-50 rounded-lg p-3">
                    <div className="text-xs font-medium text-slate-700 mb-2">将保存的参数（使用当前配置）：</div>
                    <div className="grid grid-cols-3 gap-2 text-xs text-slate-600">
                      <div>倍率: {params.c_rate}C</div>
                      <div>效率: {(params.single_side_efficiency * 100).toFixed(0)}%</div>
                      <div>DOD: {(params.depth_of_discharge * 100).toFixed(0)}%</div>
                      <div>SOC: {(params.soc_min * 100).toFixed(0)}%~{(params.soc_max * 100).toFixed(0)}%</div>
                      <div>合并: {params.merge_threshold_minutes}分</div>
                      <div>公式: {params.energy_formula}</div>
                    </div>
                  </div>
                </div>
                <div className="px-4 py-3 border-t flex justify-end gap-2">
                  <button
                    type="button"
                    onClick={() => setTemplateEditVisible(false)}
                    className="px-4 py-1.5 rounded border border-slate-300 text-slate-600 hover:bg-slate-50"
                  >
                    取消
                  </button>
                  <button
                    type="button"
                    onClick={handleSaveTemplate}
                    className="px-4 py-1.5 rounded bg-emerald-600 text-white hover:bg-emerald-700"
                  >
                    保存模板
                  </button>
                </div>
              </div>
            </div>
          )}

          {/* 左右双栏布局：基础配置 | 高级配置 */}
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            {/* 左栏：基础配置 */}
            <div className="border border-slate-200 rounded-lg bg-white overflow-hidden">
              <div className="bg-slate-100 px-3 py-2 text-sm font-medium text-slate-700 border-b flex items-center gap-2">
                <span>⚙️</span>
                <span>基础配置</span>
              </div>
              <div className="p-3 space-y-3">
                <label className="flex flex-col gap-1">
                  <span className="text-slate-700">容量</span>
                  <div className="flex items-center gap-1">
                    <input
                      className="border rounded px-2 py-1.5 flex-1 text-sm"
                      type="number"
                      step="1"
                      min="1"
                      value={params.capacity_kwh}
                      onChange={e => setParams(p => ({ ...p, capacity_kwh: Number(e.target.value) }))}
                    />
                    <span className="text-xs text-slate-500 w-10">kWh</span>
                  </div>
                  <div className="text-[11px] text-slate-500">
                    储能额定容量，用于计算可参与调度的能量规模。
                  </div>
                </label>
                <div className="grid grid-cols-2 gap-3">
                  <label className="flex flex-col gap-1">
                    <span className="text-slate-700">充电余量</span>
                    <div className="flex items-center gap-1">
                      <input
                        className="border rounded px-2 py-1.5 flex-1 text-sm"
                        type="number"
                        step="1"
                        min="0"
                        value={params.reserve_charge_kw}
                        onChange={e => setParams(p => ({ ...p, reserve_charge_kw: Number(e.target.value) }))}
                      />
                      <span className="text-xs text-slate-500 w-6">kW</span>
                    </div>
                  </label>
                  <label className="flex flex-col gap-1">
                    <span className="text-slate-700">放电余量</span>
                    <div className="flex items-center gap-1">
                      <input
                        className="border rounded px-2 py-1.5 flex-1 text-sm"
                        type="number"
                        step="1"
                        min="0"
                        value={params.reserve_discharge_kw}
                        onChange={e => setParams(p => ({ ...p, reserve_discharge_kw: Number(e.target.value) }))}
                      />
                      <span className="text-xs text-slate-500 w-6">kW</span>
                    </div>
                  </label>
                </div>
                <label className="flex flex-col gap-1">
                  <span className="text-slate-700">计费口径</span>
                  <select
                    className="border rounded px-2 py-1.5 text-sm"
                    value={params.metering_mode}
                    onChange={e => handleTemplateParamChange('metering_mode', e.target.value as any)}
                  >
                    <option value="monthly_demand_max">月需量峰值</option>
                    <option value="transformer_capacity">变压器容量</option>
                  </select>
                  <div className="text-[11px] text-slate-500">
                    决定需量上限的计算方式，会影响尖峰削峰空间与收益测算。
                  </div>
                </label>
                <label className="flex flex-col gap-1">
                  <span className="text-slate-700">能量公式</span>
                  <select
                    className="border rounded px-2 py-1.5 text-sm"
                    value={params.energy_formula}
                    onChange={e => handleTemplateParamChange('energy_formula', e.target.value as any)}
                  >
                    <option value="physics">物理模型 (physics)</option>
                    <option value="sample">样本法 (sample)</option>
                  </select>
                  <div className="text-[11px] text-slate-500">
                    physics 为物理模型精算，sample 为样本法近似。
                  </div>
                </label>
                <label className="flex flex-col gap-1">
                  <span className="text-slate-700">放电策略</span>
                  <div className="space-y-2">
                    <label className="flex items-start cursor-pointer">
                      <input
                        type="radio"
                        name="discharge-strategy"
                        value="sequential"
                        checked={dischargeStrategy === 'sequential'}
                        onChange={(e) => setDischargeStrategy(e.target.value as DischargeStrategy)}
                        className="mt-1 mr-2"
                      />
                      <div className="flex-1">
                        <div className="text-sm font-medium text-slate-700">
                          {DISCHARGE_STRATEGY_INFO.sequential.icon} {DISCHARGE_STRATEGY_INFO.sequential.name}
                        </div>
                        <div className="text-[11px] text-slate-500">
                          {DISCHARGE_STRATEGY_INFO.sequential.description}
                        </div>
                      </div>
                    </label>
                    <label className="flex items-start cursor-pointer">
                      <input
                        type="radio"
                        name="discharge-strategy"
                        value="price-priority"
                        checked={dischargeStrategy === 'price-priority'}
                        onChange={(e) => setDischargeStrategy(e.target.value as DischargeStrategy)}
                        className="mt-1 mr-2"
                      />
                      <div className="flex-1">
                        <div className="text-sm font-medium text-slate-700">
                          {DISCHARGE_STRATEGY_INFO['price-priority'].icon} {DISCHARGE_STRATEGY_INFO['price-priority'].name}
                        </div>
                        <div className="text-[11px] text-slate-500">
                          {DISCHARGE_STRATEGY_INFO['price-priority'].description}
                        </div>
                      </div>
                    </label>
                  </div>
                  <div className="text-[11px] text-blue-600 bg-blue-50 border border-blue-200 rounded px-2 py-1.5 mt-2">
                    💡 尖段优先策略会在放电窗口内，优先向最高价格时段分配电量，通常可使收益提升 5-15%
                  </div>
                </label>
                {params.metering_mode === 'transformer_capacity' && (
                  <div className="grid grid-cols-2 gap-3 pt-2 border-t border-slate-100">
                    <label className="flex flex-col gap-1">
                      <span className="text-slate-700">变压器容量</span>
                      <div className="flex items-center gap-1">
                        <input
                          className="border rounded px-2 py-1.5 flex-1 text-sm"
                          type="number"
                          step="1"
                          min="1"
                          value={params.transformer_capacity_kva}
                          onChange={e => setParams(p => ({ ...p, transformer_capacity_kva: Number(e.target.value) }))}
                        />
                        <span className="text-xs text-slate-500 w-8">kVA</span>
                      </div>
                    </label>
                    <label className="flex flex-col gap-1">
                      <span className="text-slate-700">功率因数</span>
                      <div className="flex items-center gap-1">
                        <input
                          className="border rounded px-2 py-1.5 flex-1 text-sm"
                          type="number"
                          step="0.01"
                          min="0"
                          max="1"
                          value={params.transformer_power_factor}
                          onChange={e => setParams(p => ({ ...p, transformer_power_factor: Number(e.target.value) }))}
                        />
                        <span className="text-xs text-slate-500 w-8">cosφ</span>
                      </div>
                    </label>
                  </div>
                )}
              </div>
            </div>

            {/* 右栏：高级配置 */}
            <div className="border border-slate-200 rounded-lg bg-white overflow-hidden">
              <div className="bg-slate-100 px-3 py-2 text-sm font-medium text-slate-700 border-b flex items-center gap-2">
                <span>🔧</span>
                <span>高级配置</span>
                <span className="text-[11px] font-normal text-slate-500 ml-auto">影响循环次数与效率计算</span>
              </div>
              <div className="p-3 space-y-3">
                <div className="grid grid-cols-2 gap-3">
                  <label className="flex flex-col gap-1">
                    <span className="text-slate-700">倍率</span>
                    <div className="flex items-center gap-1">
                      <input
                        className="border rounded px-2 py-1.5 flex-1 text-sm"
                        type="number"
                        step="0.01"
                        min="0"
                        value={params.c_rate}
                        onChange={e => handleTemplateParamChange('c_rate', Number(e.target.value))}
                      />
                      <span className="text-xs text-slate-500 w-6">C</span>
                    </div>
                  </label>
                  <label className="flex flex-col gap-1">
                    <span className="text-slate-700">单边效率</span>
                    <div className="flex items-center gap-1">
                      <input
                        className="border rounded px-2 py-1.5 flex-1 text-sm"
                        type="number"
                        step="0.001"
                        min="0"
                        max="1"
                        value={params.single_side_efficiency}
                        onChange={e => handleTemplateParamChange('single_side_efficiency', Number(e.target.value))}
                      />
                      <span className="text-xs text-slate-500 w-6">η</span>
                    </div>
                  </label>
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <label className="flex flex-col gap-1">
                    <span className="text-slate-700">SOC 下限</span>
                    <div className="flex items-center gap-1">
                      <input
                        className="border rounded px-2 py-1.5 flex-1 text-sm"
                        type="number"
                        step="0.01"
                        min="0"
                        max="1"
                        value={params.soc_min}
                        onChange={e => handleTemplateParamChange('soc_min', Number(e.target.value))}
                      />
                      <span className="text-xs text-slate-500 w-6">%</span>
                    </div>
                  </label>
                  <label className="flex flex-col gap-1">
                    <span className="text-slate-700">SOC 上限</span>
                    <div className="flex items-center gap-1">
                      <input
                        className="border rounded px-2 py-1.5 flex-1 text-sm"
                        type="number"
                        step="0.01"
                        min="0"
                        max="1"
                        value={params.soc_max}
                        onChange={e => handleTemplateParamChange('soc_max', Number(e.target.value))}
                      />
                      <span className="text-xs text-slate-500 w-6">%</span>
                    </div>
                  </label>
                </div>
                <label className="flex flex-col gap-1">
                  <span className="text-slate-700">DOD (放电深度)</span>
                  <div className="flex items-center gap-1">
                    <input
                      className="border rounded px-2 py-1.5 flex-1 text-sm"
                      type="number"
                      step="0.01"
                      min="0"
                      max="1"
                      value={params.depth_of_discharge}
                      onChange={e => handleTemplateParamChange('depth_of_discharge', Number(e.target.value))}
                    />
                    <span className="text-xs text-slate-500 w-10">比例</span>
                  </div>
                </label>
                <label className="flex flex-col gap-1">
                  <span className="text-slate-700">合并阈值</span>
                  <div className="flex items-center gap-1">
                    <input
                      className="border rounded px-2 py-1.5 flex-1 text-sm"
                      type="number"
                      step="1"
                      min="0"
                      value={params.merge_threshold_minutes}
                      onChange={e => handleTemplateParamChange('merge_threshold_minutes', Number(e.target.value))}
                    />
                    <span className="text-xs text-slate-500 w-10">分钟</span>
                  </div>
                  <div className="text-[11px] text-slate-500">
                    相邻充/放时段合并的时间阈值
                  </div>
                </label>
              </div>
            </div>
          </div>

          {/* 测算模式选择标签 */}
          <div className="border border-slate-200 rounded-lg bg-white overflow-hidden">
            <div className="flex border-b">
              <button
                type="button"
                onClick={() => setTestMode('single')}
                className={`flex-1 px-4 py-2.5 text-sm font-medium transition-all flex items-center justify-center gap-2 ${
                  testMode === 'single'
                    ? 'bg-blue-600 text-white'
                    : 'bg-slate-50 text-slate-600 hover:bg-slate-100'
                }`}
              >
                <span>🎯</span>
                <span>单次测算</span>
                {testMode === 'single' && <span className="text-blue-200">●</span>}
              </button>
              <button
                type="button"
                onClick={() => setTestMode('batch')}
                className={`flex-1 px-4 py-2.5 text-sm font-medium transition-all flex items-center justify-center gap-2 ${
                  testMode === 'batch'
                    ? 'bg-emerald-600 text-white'
                    : 'bg-slate-50 text-slate-600 hover:bg-slate-100'
                }`}
              >
                <span>📊</span>
                <span>批量容量对比</span>
                {testMode === 'batch' && batchResults.length > 0 && batchResults.some(b => b.status === 'done') && (
                  <span className="px-1.5 py-0.5 bg-emerald-400 text-white rounded-full text-xs">
                    {batchResults.filter(b => b.status === 'done').length}
                  </span>
                )}
              </button>
            </div>

            {/* 单次测算模式 */}
            {testMode === 'single' && (
              <div className="p-4 space-y-3">
                <div className="flex items-center gap-4">
                  <div className="flex items-center gap-2">
                    <span className="text-sm text-slate-600">当前容量:</span>
                    <span className="font-mono text-lg font-semibold text-blue-700">{params.capacity_kwh.toLocaleString()}</span>
                    <span className="text-sm text-slate-500">kWh</span>
                  </div>
                  <div className="flex items-center gap-2 text-sm text-slate-500">
                    <span>功率 = {(params.capacity_kwh * params.c_rate).toLocaleString()} kW</span>
                    <span className="text-slate-300">|</span>
                    <span>效率 = {(params.single_side_efficiency * 100).toFixed(0)}%</span>
                  </div>
                </div>
                <div className="flex items-center gap-3">
                  <button
                    type="button"
                    onClick={handleUpload}
                    className="px-6 py-2 rounded-lg bg-blue-600 hover:bg-blue-700 text-white font-medium transition-colors flex items-center gap-2 disabled:opacity-60"
                    disabled={loading}
                  >
                    {loading ? (
                      <>
                        <span className="animate-spin">⏳</span>
                        计算中...
                      </>
                    ) : (
                      <>
                        <span>▶</span>
                        开始测算
                      </>
                    )}
                  </button>
                  <span className="text-xs text-slate-500">
                    使用当前配置的容量 {params.capacity_kwh} kWh 进行单次完整测算
                  </span>
                </div>
              </div>
            )}

            {/* 批量容量对比模式 */}
            {testMode === 'batch' && (
              <div className="p-4 space-y-4">
                {/* 配置状态摘要 */}
                <div className="bg-slate-50 border border-slate-200 rounded-lg p-3">
                  <div className="flex items-center gap-2 mb-2">
                    <span className="text-xs font-medium text-slate-700">配置状态检查</span>
                    {activeTemplateId && (
                      <span className="px-1.5 py-0.5 bg-emerald-100 text-emerald-700 rounded text-[10px]">
                        {STORAGE_PARAMS_TEMPLATES.find(t => t.id === activeTemplateId)?.name}
                      </span>
                    )}
                  </div>
                  <div className="grid grid-cols-2 md:grid-cols-4 gap-x-4 gap-y-1 text-xs">
                    <div className="flex items-center gap-1">
                      <span className={`${(fileName || (useAnalyzedData && externalCleanedData?.length)) ? 'text-green-600' : 'text-red-500'}`}>
                        {(fileName || (useAnalyzedData && externalCleanedData?.length)) ? '✓' : '✗'}
                      </span>
                      <span className="text-slate-600">数据源</span>
                      <span className="text-slate-400 truncate max-w-[100px]" title={fileName || '负荷分析数据'}>
                        {fileName ? fileName.slice(0, 15) : (useAnalyzedData && externalCleanedData?.length ? '负荷分析' : '未选择')}
                      </span>
                    </div>
                    <div className="flex items-center gap-1">
                      <span className="text-green-600">✓</span>
                      <span className="text-slate-600">倍率</span>
                      <span className="text-slate-700 font-mono">{params.c_rate}C</span>
                    </div>
                    <div className="flex items-center gap-1">
                      {(() => {
                        const hasDischarge = Array.isArray(scheduleData.monthlySchedule)
                          && scheduleData.monthlySchedule.some((monthRow: any[]) =>
                            Array.isArray(monthRow) && monthRow.some(cell => cell?.op === '放'));
                        return (
                          <>
                            <span className={hasDischarge ? 'text-green-600' : 'text-red-500'}>{hasDischarge ? '✓' : '✗'}</span>
                            <span className="text-slate-600">放电时段</span>
                            <span className="text-slate-400">{hasDischarge ? '已配置' : '必须设置'}</span>
                          </>
                        );
                      })()}
                    </div>
                    <div className="flex items-center gap-1">
                      {(() => {
                        const hasPrice = Array.isArray(scheduleData.prices)
                          && scheduleData.prices.some(mp => mp && Object.values(mp).some(v => v != null));
                        return (
                          <>
                            <span className={hasPrice ? 'text-green-600' : 'text-red-500'}>{hasPrice ? '✓' : '✗'}</span>
                            <span className="text-slate-600">电价</span>
                            <span className="text-slate-400">{hasPrice ? '已配置' : '必须设置'}</span>
                          </>
                        );
                      })()}
                    </div>
                  </div>
                </div>

                {/* 批量参数设置 */}
                <div className="flex flex-wrap items-end gap-x-4 gap-y-2 bg-slate-50 rounded-lg px-3 py-2.5 border border-slate-200">
                  <div className="flex items-center gap-2">
                    <span className="text-xs text-slate-600 whitespace-nowrap">容量范围:</span>
                    <input
                      className="border rounded px-2 py-1 w-20 text-sm"
                      type="number"
                      min="1"
                      step="1"
                      value={solveStartCapacityKwh}
                      onChange={e => setSolveStartCapacityKwh(Number(e.target.value) || 0)}
                    />
                    <span className="text-xs text-slate-500">~</span>
                    <span className="text-xs text-slate-600 font-mono">
                      {(solveStartCapacityKwh + (solveSteps - 1) * solveStepCapacityKwh).toLocaleString()} kWh
                    </span>
                  </div>
                  <div className="flex items-center gap-2">
                    <span className="text-xs text-slate-600 whitespace-nowrap">步长:</span>
                    <input
                      className="border rounded px-2 py-1 w-20 text-sm"
                      type="number"
                      min="1"
                      step="1"
                      value={solveStepCapacityKwh}
                      onChange={e => setSolveStepCapacityKwh(Number(e.target.value) || 0)}
                    />
                    <span className="text-xs text-slate-500">kWh</span>
                  </div>
                  <div className="flex items-center gap-2">
                    <span className="text-xs text-slate-600 whitespace-nowrap">档数:</span>
                    <input
                      className="border rounded px-2 py-1 w-16 text-sm"
                      type="number"
                      min="1"
                      step="1"
                      value={solveSteps}
                      onChange={e => setSolveSteps(Number(e.target.value) || 0)}
                    />
                  </div>
                  <div className="flex items-center gap-2">
                    <span className="text-xs text-slate-600 whitespace-nowrap">目标循环:</span>
                    <input
                      className="border rounded px-2 py-1 w-20 text-sm"
                      type="number"
                      min="0"
                      step="0.01"
                      value={targetYearEqCyclesInput}
                      onChange={e => setTargetYearEqCyclesInput(e.target.value)}
                      placeholder="640"
                    />
                    <span className="text-xs text-slate-500">次/年</span>
                  </div>
                </div>

                {/* 功率模式选择 */}
                <div className="flex flex-wrap items-center gap-x-4 gap-y-2 bg-blue-50 rounded-lg px-3 py-2 border border-blue-200">
                  <div className="flex items-center gap-3">
                    <span className="text-xs text-blue-700 font-medium whitespace-nowrap">⚡ 功率模式:</span>
                    <label className="flex items-center gap-1.5 cursor-pointer">
                      <input
                        type="radio"
                        name="powerModeBatch"
                        value="c_rate"
                        checked={powerMode === 'c_rate'}
                        onChange={() => setPowerMode('c_rate')}
                        className="accent-blue-600"
                      />
                      <span className="text-xs text-slate-700">倍率联动</span>
                    </label>
                    <label className="flex items-center gap-1.5 cursor-pointer">
                      <input
                        type="radio"
                        name="powerModeBatch"
                        value="fixed"
                        checked={powerMode === 'fixed'}
                        onChange={() => setPowerMode('fixed')}
                        className="accent-blue-600"
                      />
                      <span className="text-xs text-slate-700">固定功率</span>
                    </label>
                  </div>
                  {powerMode === 'c_rate' ? (
                    <div className="flex items-center gap-2 text-xs text-blue-600">
                      <span>倍率 {params.c_rate}C →</span>
                      <span className="font-mono bg-blue-100 px-1.5 py-0.5 rounded">
                        {(solveStartCapacityKwh * params.c_rate).toLocaleString()} ~ {((solveStartCapacityKwh + (solveSteps - 1) * solveStepCapacityKwh) * params.c_rate).toLocaleString()} kW
                      </span>
                    </div>
                  ) : (
                    <div className="flex items-center gap-2 text-xs text-slate-600">
                      <span>充电余量 {params.reserve_charge_kw} kW / 放电余量 {params.reserve_discharge_kw} kW</span>
                    </div>
                  )}
                  <div className="flex items-center gap-2 ml-auto">
                    <button
                      type="button"
                      className="px-4 py-1.5 rounded-lg bg-emerald-600 hover:bg-emerald-700 text-white text-sm font-medium disabled:opacity-60 transition-colors flex items-center gap-1.5"
                      onClick={handleBatchCapacityCompute}
                      disabled={loading || isBatchComputing}
                    >
                      {isBatchComputing ? (
                        <>
                          <span className="animate-spin">⏳</span>
                          计算中...
                        </>
                      ) : (
                        <>
                          <span>▶</span>
                          开始批量计算
                        </>
                      )}
                    </button>
                    {isBatchComputing && batchProgress && (
                      <div className="flex items-center gap-1">
                        <UploadProgressRing
                          progress={Math.round((batchProgress.current / batchProgress.total) * 100)}
                          status="computing"
                          size={28}
                          stroke={3}
                        />
                        <span className="text-xs text-slate-600 font-mono">
                          {batchProgress.current}/{batchProgress.total}
                        </span>
                      </div>
                    )}
                  </div>
                </div>

                {/* 批量结果：双列布局（表格 + 趋势图） */}
                {batchResults.length > 0 && (
                  <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
                    {/* 左侧：对比表格 */}
                    <div className="border border-slate-200 rounded-lg overflow-hidden bg-white">
                      <div className="bg-slate-100 px-3 py-2 text-xs font-medium text-slate-700 border-b">
                        容量对比表
                      </div>
                      <div className="overflow-x-auto max-h-[320px] overflow-y-auto">
                        <table className="min-w-full text-xs border-collapse">
                          <thead className="sticky top-0 bg-slate-50 z-10">
                            <tr>
                              <th className="border-b px-2 py-1.5 text-center w-8"></th>
                              <th className="border-b px-2 py-1.5 text-right">容量</th>
                              <th className="border-b px-2 py-1.5 text-right">循环数</th>
                              <th className="border-b px-2 py-1.5 text-right">首年收益</th>
                              <th className="border-b px-2 py-1.5 text-right">与目标差距</th>
                            </tr>
                          </thead>
                          <tbody>
                            {batchResults.map((item, idx) => {
                              const isClosest = idx === closestBatchIdx;
                              const isSelected = idx === selectedBatchIdx;
                              const targetVal = parseFloat(targetYearEqCyclesInput) || 0;
                              const diff = item.status === 'done' && targetVal > 0
                                ? item.yearEqCycles - targetVal
                                : null;
                              const diffPct = diff !== null && targetVal > 0
                                ? (diff / targetVal) * 100
                                : null;
                              return (
                                <tr
                                  key={idx}
                                  className={`cursor-pointer transition-all ${
                                    isSelected 
                                      ? 'bg-emerald-100 border-l-4 border-l-emerald-500' 
                                      : isClosest 
                                        ? 'bg-amber-50 border-l-4 border-l-amber-400' 
                                        : 'hover:bg-slate-50 border-l-4 border-l-transparent'
                                  }`}
                                  onClick={() => item.status === 'done' && handleSelectBatchRow(idx)}
                                >
                                  <td className="px-2 py-1.5 text-center">
                                    {item.status === 'done' ? (
                                      <input
                                        type="radio"
                                        name="batchCapacityNew"
                                        checked={isSelected}
                                        className="accent-emerald-600"
                                        onChange={() => handleSelectBatchRow(idx)}
                                      />
                                    ) : item.status === 'computing' ? (
                                      <span className="text-orange-500 animate-pulse">◌</span>
                                    ) : item.status === 'error' ? (
                                      <span className="text-red-500" title={item.errorMsg}>✗</span>
                                    ) : (
                                      <span className="text-slate-300">○</span>
                                    )}
                                  </td>
                                  <td className="px-2 py-1.5 text-right font-mono text-slate-700">
                                    {item.capacityKwh.toLocaleString()}
                                    <span className="text-slate-400 text-[10px] ml-0.5">kWh</span>
                                  </td>
                                  <td className="px-2 py-1.5 text-right font-mono">
                                    {item.status === 'done' ? (
                                      <span className={isClosest ? 'text-amber-700 font-semibold' : 'text-slate-700'}>
                                        {item.yearEqCycles.toFixed(1)}
                                      </span>
                                    ) : item.status === 'computing' ? (
                                      <span className="text-slate-400">...</span>
                                    ) : (
                                      <span className="text-slate-300">-</span>
                                    )}
                                  </td>
                                  <td className="px-2 py-1.5 text-right font-mono text-slate-700">
                                    {item.status === 'done' ? (
                                      <span>¥{(item.firstYearProfit / 10000).toFixed(2)}<span className="text-slate-400 text-[10px] ml-0.5">万</span></span>
                                    ) : (
                                      <span className="text-slate-300">-</span>
                                    )}
                                  </td>
                                  <td className="px-2 py-1.5 text-right font-mono text-xs">
                                    {item.status === 'done' && diff !== null ? (
                                      <span className={`${
                                        isClosest 
                                          ? 'inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-amber-100 text-amber-700 font-medium'
                                          : diff > 0 ? 'text-emerald-600' : 'text-slate-500'
                                      }`}>
                                        {diff > 0 ? '+' : ''}{diff.toFixed(1)}
                                        {diffPct !== null && (
                                          <span className="text-[10px] opacity-70">
                                            ({diffPct > 0 ? '+' : ''}{diffPct.toFixed(1)}%)
                                          </span>
                                        )}
                                        {isClosest && <span className="ml-1">★</span>}
                                      </span>
                                    ) : (
                                      <span className="text-slate-300">-</span>
                                    )}
                                  </td>
                                </tr>
                              );
                            })}
                          </tbody>
                        </table>
                      </div>
                    </div>

                    {/* 右侧：趋势图 */}
                    <div className="border border-slate-200 rounded-lg overflow-hidden bg-white">
                      <div className="bg-slate-100 px-3 py-2 text-xs font-medium text-slate-700 border-b flex items-center justify-between">
                        <span>趋势图</span>
                        <span className="text-[10px] text-slate-500 font-normal">
                          点击图表上的点可选中对应容量
                        </span>
                      </div>
                      <div className="p-2">
                        <BatchCapacityChart
                          data={batchResults}
                          targetCycles={parseFloat(targetYearEqCyclesInput) || undefined}
                          selectedCapacity={selectedBatchIdx !== null ? batchResults[selectedBatchIdx]?.capacityKwh : undefined}
                          onSelectCapacity={(cap) => {
                            const idx = batchResults.findIndex(b => b.capacityKwh === cap);
                            if (idx >= 0 && batchResults[idx].status === 'done') {
                              handleSelectBatchRow(idx);
                            }
                          }}
                          height={280}
                        />
                      </div>
                    </div>
                  </div>
                )}

                {/* 推荐提示 */}
                {batchResults.length > 0 && closestBatchIdx !== null && batchResults[closestBatchIdx]?.status === 'done' && (
                  <div className="flex items-center gap-2 px-3 py-2 bg-amber-50 border border-amber-200 rounded-lg text-sm">
                    <span className="text-amber-500 text-lg">💡</span>
                    <span className="text-amber-800">
                      <strong>推荐容量：</strong>
                      {batchResults[closestBatchIdx].capacityKwh.toLocaleString()} kWh
                      （循环数 {batchResults[closestBatchIdx].yearEqCycles.toFixed(1)}，
                      最接近目标 {targetYearEqCyclesInput}，
                      首年收益 ¥{(batchResults[closestBatchIdx].firstYearProfit / 10000).toFixed(2)} 万）
                    </span>
                    <button
                      type="button"
                      className="ml-auto px-2 py-1 text-xs bg-amber-200 hover:bg-amber-300 text-amber-800 rounded transition-colors"
                      onClick={() => handleSelectBatchRow(closestBatchIdx)}
                    >
                      查看详情
                    </button>
                  </div>
                )}

                {/* 选中容量的详细结果提示 */}
                {selectedBatchIdx !== null && batchResults[selectedBatchIdx]?.status === 'done' && (
                  <div className="bg-emerald-50 border border-emerald-200 rounded-lg p-3">
                    <div className="flex items-center gap-2 text-sm text-emerald-700">
                      <span className="text-emerald-500">✓</span>
                      <span className="font-medium">
                        已选容量 {batchResults[selectedBatchIdx].capacityKwh.toLocaleString()} kWh
                      </span>
                      <span className="text-slate-500">
                        （循环 {batchResults[selectedBatchIdx].yearEqCycles.toFixed(1)} 次 / 
                        收益 ¥{(batchResults[selectedBatchIdx].firstYearProfit / 10000).toFixed(2)} 万）
                      </span>
                    </div>
                    <div className="text-xs text-slate-500 mt-1">
                      详细结果已加载到下方结果区域，请向下滚动查看月度汇总、日度明细及图表。
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2 text-xs">
          <input
            type="text"
            value={savedConfigName}
            onChange={e => setSavedConfigName(e.target.value)}
            placeholder="保存配置名称"
            className="border rounded px-2 py-1 text-xs w-36"
          />
          <button
            onClick={handleSaveConfig}
            className="px-2 py-1 rounded bg-slate-900 text-white text-xs disabled:opacity-40"
            disabled={!savedConfigName.trim()}
          >
            保存配置
          </button>
          <select
            value={selectedSavedConfig}
            onChange={e => setSelectedSavedConfig(e.target.value)}
            className="border rounded px-2 py-1 text-xs"
          >
            <option value="">选择已保存配置</option>
            {availableConfigs.map(name => (
              <option key={name} value={name}>{name}</option>
            ))}
          </select>
          <button
            onClick={handleLoadSavedConfig}
            className="px-2 py-1 rounded bg-blue-500 text-white text-xs disabled:opacity-40"
            disabled={!selectedSavedConfig}
          >
            加载配置
          </button>
          <button
            onClick={handleExportConfig}
            className="px-2 py-1 rounded border border-slate-400 text-xs"
          >
            导出 JSON
          </button>
          <button
            onClick={handleImportClick}
            className="px-2 py-1 rounded border border-slate-400 text-xs"
          >
            导入 JSON
          </button>
          <input
            type="file"
            ref={importInputRef}
            className="sr-only"
            accept="application/json"
            onChange={handleImportFile}
          />
        </div>
        {configNotice && (
          <div className="text-[11px] text-slate-500">{configNotice}</div>
        )}

        {error && <div className="text-red-600 text-sm">{error}</div>}
      </div>

      {result && (
        <div className="mt-2 space-y-3">
          {/* 清洗前后对比视图 */}
          {comparisonData && (
            <div id="section-cycles-comparison" className="scroll-mt-24 p-4 border rounded-xl bg-gradient-to-r from-blue-50 to-indigo-50 shadow-sm">
              <div 
                className="flex items-center justify-between cursor-pointer"
                onClick={() => setShowComparison(!showComparison)}
              >
                <div className="flex items-center gap-2">
                  <span className="text-lg">📊</span>
                  <h3 className="text-sm font-semibold text-slate-800">清洗前后对比分析</h3>
                  <span className="text-xs px-2 py-0.5 bg-blue-100 text-blue-700 rounded-full">
                    {comparisonData.recommendation === 'cleaned' ? '推荐使用清洗后数据' : '原始数据表现更好'}
                  </span>
                </div>
                <button className="text-slate-500 hover:text-slate-700">
                  {showComparison ? '收起 ▲' : '展开 ▼'}
                </button>
              </div>
              
              {showComparison && (
                <div className="mt-4 space-y-4">
                  {/* 核心指标对比表格 */}
                  <div className="overflow-x-auto">
                    <table className="min-w-full text-xs border-collapse bg-white rounded-lg overflow-hidden">
                      <thead>
                        <tr className="bg-slate-100">
                          <th className="px-3 py-2 text-left font-medium text-slate-600">指标</th>
                          <th className="px-3 py-2 text-right font-medium text-slate-600">原始数据</th>
                          <th className="px-3 py-2 text-right font-medium text-slate-600">清洗后</th>
                          <th className="px-3 py-2 text-right font-medium text-slate-600">变化</th>
                          <th className="px-3 py-2 text-right font-medium text-slate-600">变化%</th>
                        </tr>
                      </thead>
                      <tbody>
                        <tr className="border-b border-slate-100">
                          <td className="px-3 py-2 text-slate-700">实际循环次数</td>
                          <td className="px-3 py-2 text-right tabular-nums">{comparisonData.original.actual_cycles.toFixed(2)}</td>
                          <td className="px-3 py-2 text-right tabular-nums font-semibold">{comparisonData.cleaned.actual_cycles.toFixed(2)}</td>
                          <td className={`px-3 py-2 text-right tabular-nums ${comparisonData.diff_actual_cycles >= 0 ? 'text-green-600' : 'text-red-600'}`}>
                            {comparisonData.diff_actual_cycles >= 0 ? '+' : ''}{comparisonData.diff_actual_cycles.toFixed(2)}
                          </td>
                          <td className={`px-3 py-2 text-right tabular-nums ${comparisonData.diff_actual_cycles_percent >= 0 ? 'text-green-600' : 'text-red-600'}`}>
                            {comparisonData.diff_actual_cycles_percent >= 0 ? '+' : ''}{comparisonData.diff_actual_cycles_percent.toFixed(2)}%
                          </td>
                        </tr>
                        <tr className="border-b border-slate-100 bg-slate-50/50">
                          <td className="px-3 py-2 text-slate-700">等效循环次数</td>
                          <td className="px-3 py-2 text-right tabular-nums">{comparisonData.original.equivalent_cycles.toFixed(2)}</td>
                          <td className="px-3 py-2 text-right tabular-nums font-semibold">{comparisonData.cleaned.equivalent_cycles.toFixed(2)}</td>
                          <td className={`px-3 py-2 text-right tabular-nums ${comparisonData.diff_equivalent_cycles >= 0 ? 'text-green-600' : 'text-red-600'}`}>
                            {comparisonData.diff_equivalent_cycles >= 0 ? '+' : ''}{comparisonData.diff_equivalent_cycles.toFixed(2)}
                          </td>
                          <td className={`px-3 py-2 text-right tabular-nums ${comparisonData.diff_equivalent_cycles_percent >= 0 ? 'text-green-600' : 'text-red-600'}`}>
                            {comparisonData.diff_equivalent_cycles_percent >= 0 ? '+' : ''}{comparisonData.diff_equivalent_cycles_percent.toFixed(2)}%
                          </td>
                        </tr>
                        <tr className="border-b border-slate-100">
                          <td className="px-3 py-2 text-slate-700">有效天数</td>
                          <td className="px-3 py-2 text-right tabular-nums">{comparisonData.original.valid_days}</td>
                          <td className="px-3 py-2 text-right tabular-nums font-semibold">{comparisonData.cleaned.valid_days}</td>
                          <td className={`px-3 py-2 text-right tabular-nums ${comparisonData.diff_valid_days >= 0 ? 'text-green-600' : 'text-red-600'}`}>
                            {comparisonData.diff_valid_days >= 0 ? '+' : ''}{comparisonData.diff_valid_days}
                          </td>
                          <td className="px-3 py-2 text-right text-slate-400">-</td>
                        </tr>
                      </tbody>
                    </table>
                  </div>
                  
                  {/* 清洗操作统计 */}
                  <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
                    <div className="p-2 bg-white rounded-lg border border-slate-200">
                      <div className="text-[10px] text-slate-500">空值插值</div>
                      <div className="text-sm font-semibold text-slate-800">{comparisonData.cleaning_actions.null_points_interpolated} 个点</div>
                    </div>
                    <div className="p-2 bg-white rounded-lg border border-slate-200">
                      <div className="text-[10px] text-slate-500">零值保留</div>
                      <div className="text-sm font-semibold text-slate-800">{comparisonData.cleaning_actions.zero_spans_kept} 段</div>
                    </div>
                    <div className="p-2 bg-white rounded-lg border border-slate-200">
                      <div className="text-[10px] text-slate-500">零值插值</div>
                      <div className="text-sm font-semibold text-slate-800">{comparisonData.cleaning_actions.zero_spans_interpolated} 段</div>
                    </div>
                    <div className="p-2 bg-white rounded-lg border border-slate-200">
                      <div className="text-[10px] text-slate-500">负值处理</div>
                      <div className="text-sm font-semibold text-slate-800">{comparisonData.cleaning_actions.negative_points_modified} 个点</div>
                    </div>
                  </div>
                  
                  {/* 数据完整度 */}
                  <div className="flex items-center gap-2 text-xs text-slate-600">
                    <span>数据完整度：</span>
                    <div className="flex-1 bg-slate-200 rounded-full h-2 max-w-xs">
                      <div 
                        className="bg-blue-500 h-2 rounded-full transition-all"
                        style={{ width: `${(comparisonData.completeness_ratio * 100).toFixed(0)}%` }}
                      />
                    </div>
                    <span className="font-medium">{(comparisonData.completeness_ratio * 100).toFixed(1)}%</span>
                  </div>
                </div>
              )}
            </div>
          )}

          {kpiMetrics && (
            <div id="section-cycles-kpi" className="scroll-mt-24 grid grid-cols-2 md:grid-cols-4 gap-2 text-xs">
              <div className="p-2.5 bg-white rounded-xl shadow-lg border border-slate-200 border-l-4 border-blue-500">
                <div className="flex items-center justify-between mb-1">
                  <div className="text-xs text-slate-500">年累计循环次数</div>
                  <span className="text-xs">🔄</span>
                </div>
                <div className="text-base md:text-xl font-semibold text-slate-900">
                  {kpiMetrics.totalCycles.toFixed(2)}
                </div>
                <div className="text-[11px] text-slate-500 mt-1">单位：次/年</div>
                <div className="text-[11px] text-slate-500 mt-2 text-right">
                  全年合计等效循环数：{yearEquivalentCycles === 0 ? '-' : Number(yearEquivalentCycles).toFixed(2)} 次
                </div>
                {solveSuggestion && (
                  <div className="text-[11px] text-emerald-600 mt-1 text-right">
                    目标 {solveSuggestion.targetYearEq.toFixed(2)} 次，推荐容量约{' '}
                    {solveSuggestion.bestCapacityKwh.toFixed(0)} kWh（等效 {solveSuggestion.bestYearEqCycles.toFixed(2)} 次）
                  </div>
                )}
              </div>
              <div className="p-2.5 bg-white rounded-xl shadow-lg border border-slate-200 border-l-4 border-emerald-500">
                <div className="flex items-center justify-between mb-1">
                  <div className="text-xs text-slate-500">月均循环次数</div>
                  <span className="text-xs">📊</span>
                </div>
                <div className="text-base md:text-xl font-semibold text-slate-900">
                  {kpiMetrics.avgCycles.toFixed(2)}
                </div>
                <div className="text-[11px] text-slate-500 mt-1">单位：次/月</div>
              </div>
              <div className="p-2.5 bg-white rounded-xl shadow-lg border border-slate-200 border-l-4 border-orange-500">
                <div className="flex items-center justify-between mb-1">
                  <div className="text-xs text-slate-500">最高月循环次数</div>
                  <span className="text-xs">📈</span>
                </div>
                <div className="text-base md:text-xl font-semibold text-slate-900">
                  {kpiMetrics.maxMonth ? kpiMetrics.maxMonth.cycles.toFixed(2) : '--'}
                </div>
                <div className="text-[11px] text-slate-500 mt-1">
                  {kpiMetrics.maxMonth?.yearMonth || '—'}（次/月）
                </div>
              </div>
              <div className="p-2.5 bg-white rounded-xl shadow-lg border border-slate-200 border-l-4 border-slate-400">
                <div className="flex items-center justify-between mb-1">
                  <div className="text-xs text-slate-500">最低月循环次数</div>
                  <span className="text-xs">📉</span>
                </div>
                <div className="text-base md:text-xl font-semibold text-slate-900">
                  {kpiMetrics.minMonth ? kpiMetrics.minMonth.cycles.toFixed(2) : '--'}
                </div>
                <div className="text-[11px] text-slate-500 mt-1">
                  {kpiMetrics.minMonth?.yearMonth || '—'}（次/月）
                </div>
              </div>
            </div>
          )}

          {/* 循环有效/等效统计表格（按月 + 年度汇总） */}
          <div id="section-cycles-stats" className="scroll-mt-24 p-3 border rounded-xl bg-white shadow-sm overflow-x-auto">
            <div className="flex items-center justify-between mb-2">
              <div className="text-sm font-semibold text-slate-800">
                循环有效/等效统计（按月）
              </div>
              <div className="text-[11px] md:text-xs text-slate-500">
                基于日度循环结果按自然月折算
              </div>
            </div>
            <div>
              <table className="min-w-full text-xs md:text-sm border-collapse">
                <thead className="bg-slate-50">
                  <tr className="border-b border-slate-200">
                    <th className="px-3 py-2 text-left font-medium text-slate-600">月份</th>
                    <th className="px-3 py-2 text-right font-medium text-slate-600">有效天数（天）</th>
                    <th className="px-3 py-2 text-right font-medium text-slate-600 bg-slate-50">月均有效天日循环数（次/天）</th>
                    <th className="px-3 py-2 text-right font-medium text-slate-600 bg-slate-50">有效循环数（次）</th>
                    <th className="px-3 py-2 text-right font-medium text-slate-600">等效循环数（次）</th>
                    <th className="px-3 py-2 text-right font-medium text-slate-600">第一次充电月均有效天次数（次/天）</th>
                    <th className="px-3 py-2 text-right font-medium text-slate-600">第一次放电月均有效天次数（次/天）</th>
                    <th className="px-3 py-2 text-right font-medium text-slate-600">第二次充电月均有效天次数（次/天）</th>
                    <th className="px-3 py-2 text-right font-medium text-slate-600">第二次放电月均有效天次数（次/天）</th>
                    <th className="px-3 py-2 text-right font-medium text-slate-600">平均尖占比（%）</th>
                  </tr>
                </thead>
                <tbody>
                {Array.from({ length: 12 }, (_, i) => {
                  const monthLabel = `${i + 1}月`;
                  const validDays = monthValidDays[i] ?? 0;
                  const totalCycles = monthTotalCycles[i] ?? 0;
                  const eqCycles = monthEquivalentCycles[i];
                  const fChargePct = monthFirstChargeRatePct[i];
                  const fDischargePct = monthFirstDischargeRatePct[i];
                  const sChargePct = monthSecondChargeRatePct[i];
                  const sDischargePct = monthSecondDischargeRatePct[i];
                  const avgDailyCycles =
                    validDays > 0 ? totalCycles / validDays : null;
                  const totalStr =
                    totalCycles === 0
                      ? '-'
                      : Number(totalCycles).toFixed(3);
                  const eqStr =
                    eqCycles == null || eqCycles === 0
                      ? '-'
                      : Number(eqCycles).toFixed(3);
                  const fChargeStr =
                    fChargePct == null
                      ? '-'
                      : Number(fChargePct).toFixed(3);
                  const fDischargeStr =
                    fDischargePct == null
                      ? '-'
                      : Number(fDischargePct).toFixed(3);
                  const sChargeStr =
                    sChargePct == null
                      ? '-'
                      : Number(sChargePct).toFixed(3);
                  const sDischargeStr =
                    sDischargePct == null
                      ? '-'
                      : Number(sDischargePct).toFixed(3);
                  const avgDailyStr =
                    avgDailyCycles == null || avgDailyCycles === 0
                      ? '-'
                      : Number(avgDailyCycles).toFixed(3);
                  const tipRatio = tipMonthMap[i];
                  const tipRatioStr =
                    tipRatio == null
                      ? '-'
                      : `${(tipRatio * 100).toFixed(1)}%`;
                  return (
                    <tr
                      key={monthLabel}
                      className="border-b border-slate-100 last:border-0 even:bg-slate-50/60 hover:bg-slate-100/70 transition-colors"
                    >
                      <td className="px-3 py-1.5 text-slate-700">{monthLabel}</td>
                      <td className="px-3 py-1.5 text-right tabular-nums text-slate-700">
                        {validDays || '-'}
                      </td>
                      <td className="px-3 py-1.5 text-right tabular-nums text-slate-700 bg-slate-50">
                        {avgDailyStr}
                      </td>
                      <td className="px-3 py-1.5 text-right tabular-nums text-slate-700 bg-slate-50 font-semibold">
                        {totalStr}
                      </td>
                      <td className="px-3 py-1.5 text-right tabular-nums text-slate-700">
                        {eqStr}
                      </td>
                      <td className="px-3 py-1.5 text-right tabular-nums text-slate-700">
                        {fChargeStr}
                      </td>
                      <td className="px-3 py-1.5 text-right tabular-nums text-slate-700">
                        {fDischargeStr}
                      </td>
                      <td className="px-3 py-1.5 text-right tabular-nums text-slate-700">
                        {sChargeStr}
                      </td>
                      <td className="px-3 py-1.5 text-right tabular-nums text-slate-700">
                        {sDischargeStr}
                      </td>
                      <td className="px-3 py-1.5 text-right tabular-nums text-slate-700">
                        {tipRatioStr}
                      </td>
                    </tr>
                  );
                })}
                <tr className="border-t border-slate-200 bg-slate-100/80">
                  <td className="px-3 py-1.5 font-semibold text-slate-800">全年合计</td>
                  <td className="px-3 py-1.5 text-right font-semibold tabular-nums text-slate-800">
                    {yearValidDays || '-'}
                  </td>
                  <td className="px-3 py-1.5 text-right font-semibold tabular-nums text-slate-800 bg-slate-100">
                    {yearValidDays && yearTotalCycles
                      ? Number(yearTotalCycles / yearValidDays).toFixed(3)
                      : '-'}
                  </td>
                  <td className="px-3 py-1.5 text-right font-semibold tabular-nums text-slate-800 bg-slate-100">
                    {yearTotalCycles === 0
                      ? '-'
                      : Number(yearTotalCycles).toFixed(3)}
                  </td>
                  <td className="px-3 py-1.5 text-right font-semibold tabular-nums text-slate-800">
                    {yearEquivalentCycles === 0
                      ? '-'
                      : Number(yearEquivalentCycles).toFixed(3)}
                  </td>
                  <td className="px-3 py-1.5 text-right font-semibold tabular-nums text-slate-800">
                    {avgFirstChargeRate == null ? '-' : avgFirstChargeRate.toFixed(3)}
                  </td>
                  <td className="px-3 py-1.5 text-right font-semibold tabular-nums text-slate-800">
                    {avgFirstDischargeRate == null ? '-' : avgFirstDischargeRate.toFixed(3)}
                  </td>
                  <td className="px-3 py-1.5 text-right font-semibold tabular-nums text-slate-800">
                    {avgSecondChargeRate == null ? '-' : avgSecondChargeRate.toFixed(3)}
                  </td>
                  <td className="px-3 py-1.5 text-right font-semibold tabular-nums text-slate-800">
                    {avgSecondDischargeRate == null ? '-' : avgSecondDischargeRate.toFixed(3)}
                  </td>
                  <td className="px-3 py-1.5 text-right font-semibold tabular-nums text-slate-800">
                    {avgTipRatio == null ? '-' : `${(avgTipRatio * 100).toFixed(1)}%`}
                  </td>
                </tr>
              </tbody>
              </table>
            </div>
          </div>

          {/* 图表区：四块图统一为 2×2 网格，尺寸协调 */}
          <div id="section-cycles-charts" className="scroll-mt-24 grid grid-cols-1 xl:grid-cols-2 gap-4">
            {/* 月度充放次数（曲线） */}
            <div className="p-3 border rounded bg-white flex flex-col">
              <div className="flex items-center justify-between mb-2">
                <div className="text-sm font-semibold">月度充放次数（曲线）</div>
                <div className="text-xs flex items-center gap-1">
                  <span>视图</span>
                  <select
                    className="border rounded px-2 py-0.5"
                    value={monthlyViewMode}
                    onChange={e => setMonthlyViewMode(e.target.value as 'aggregate' | 'byYear')}
                  >
                    <option value="aggregate">按月合计</option>
                    <option value="byYear">按年拆分</option>
                  </select>
                </div>
              </div>
              <div ref={monthChartRef} style={{ width: '100%', height: 280 }} />
            </div>

            {/* 单月日度次数曲线 */}
            <div className="p-3 border rounded bg-white flex flex-col">
              <div className="flex items-center justify-between mb-2">
                <div className="text-sm font-semibold mb-1">单月日度次数曲线</div>
                <div className="text-xs flex items-center gap-2 flex-wrap">
                  <div className="flex items-center gap-1">
                    <span>月份</span>
                    <select
                      className="border rounded px-2 py-0.5"
                      value={selectedMonth || ''}
                      onChange={e => setSelectedMonth(e.target.value)}
                    >
                      {monthsData.map(m => (
                        <option key={m.year_month} value={m.year_month}>{m.year_month}</option>
                      ))}
                    </select>
                  </div>
                  {onNavigateProfit && (
                    <div className="flex items-center gap-1">
                      <span>日期</span>
                      <select
                        className="border rounded px-2 py-0.5"
                        value={selectedDayForProfit || ''}
                        onChange={e => setSelectedDayForProfit(e.target.value || null)}
                      >
                        {daysInSelectedMonth.map(d => (
                          <option key={d} value={d}>{d}</option>
                        ))}
                      </select>
                    </div>
                  )}
                </div>
              </div>
              <div ref={dayChartRef} style={{ width: '100%', height: 280 }} />
            </div>

            {/* 全年每日充放次数热力图 */}
            <div className="p-3 border rounded bg-white flex flex-col">
              <div className="text-sm font-semibold mb-2">全年每日充放次数热力图</div>
              <div ref={heatmapChartRef} style={{ width: '100%', height: 280 }} />
              <div className="mt-1 text-xs text-slate-500">
                第一行对应 1 月、第二行对应 2 月，横轴为 1–31 日，每个格子表示当日的充放次数。
              </div>
            </div>

            {/* 尖放电占比 */}
            <div id="section-cycles-tip" className="scroll-mt-24 p-3 border rounded bg-white flex flex-col justify-between">
              <div>
                <div className="flex items-center justify-between mb-2">
                  <div className="text-sm font-semibold text-slate-800">尖放电占比</div>
                  {tipSummary && (
                    <div className="text-[11px] text-slate-500">
                      放电次数：{tipSummary.dischargeCount}
                    </div>
                  )}
                </div>
                {tipSummary ? (
                  <>
                    <div className="text-3xl font-semibold text-slate-900">
                      {(tipSummary.ratio * 100).toFixed(1)}%
                    </div>
                    <div className="text-xs text-slate-600 mt-2 leading-relaxed">
                      公式：{Number.isFinite(tipSummary.avgTipLoadKw) ? tipSummary.avgTipLoadKw.toFixed(1) : '--'} kW × {Number.isFinite(tipSummary.tipHours) ? tipSummary.tipHours.toFixed(2) : '--'}h ÷ ({Number.isFinite(tipSummary.capacityKwh) ? tipSummary.capacityKwh : '--'} kWh × {tipSummary.dischargeCount || 1})
                    </div>
                    <div className="text-xs text-slate-600 mt-1">
                      尖能量需求：{Number.isFinite(tipSummary.energyNeedKwh) ? tipSummary.energyNeedKwh.toFixed(1) : '--'} kWh
                    </div>
                    {tipSummary.dischargeCount === 0 && (
                      <div className="text-xs text-orange-600 mt-1">
                        放电次数为 0，按规则占比为 0%
                      </div>
                    )}
                    <div className="mt-3">
                      <div className="text-xs text-slate-600 mb-1">日尖占比</div>
                      <div ref={tipDayChartRef} style={{ width: '100%', height: 180 }} />
                    </div>
                    {tipSummary.note && (
                      <div className="mt-2 text-[11px] text-slate-500 leading-relaxed">
                        {tipSummary.note}
                      </div>
                    )}
                  </>
                ) : (
                  <div className="text-xs text-slate-500">
                    暂无尖放电占比数据，后端返回 tip_discharge_summary 后自动展示。
                  </div>
                )}
              </div>
            </div>
          </div>

          {result && (
            <div className="p-3 border rounded bg-white text-sm flex items-center justify-between gap-3">
              <div className="flex flex-col md:flex-row items-start md:items-center gap-2 md:gap-4">
                <div className="text-slate-700 whitespace-nowrap">报表导出：</div>
                <div className="flex flex-wrap gap-2">
                  <button
                    type="button"
                    onClick={handleExportBusinessExcel}
                    className="px-3 py-1.5 rounded bg-emerald-600 text-white text-xs md:text-sm hover:bg-emerald-700 disabled:opacity-60"
                    disabled={loading}
                  >
                    导出运行与收益报表（CSV，多表打包）
                  </button>
                  <button
                    type="button"
                    onClick={handleExportDebugExcel}
                    className="px-3 py-1.5 rounded bg-slate-600 text-white text-xs md:text-sm hover:bg-slate-700 disabled:opacity-60"
                    disabled={loading}
                  >
                    导出调试报表（详细结果）
                  </button>
                </div>
              </div>
            </div>
          )}

          {!!result.qc?.notes?.length && (
            <div className="p-3 border rounded bg-white">
              <details>
                <summary className="cursor-pointer text-slate-700 text-sm">QC 提示（展开查看）</summary>
                <ul className="list-disc ml-5 text-sm text-slate-600 mt-1">
                  {result.qc.notes.map((n, idx) => (<li key={idx}>{n}</li>))}
                </ul>
              </details>
            </div>
          )}
        </div>
      )}

      {/* 数据清洗确认对话框 */}
      <CleaningConfirmDialog
        visible={cleaningDialogVisible}
        analysis={cleaningAnalysis}
        onConfirm={handleCleaningConfirm}
        onCancel={handleCleaningCancel}
        loading={cleaningLoading}
      />
    </div>
  );
};
