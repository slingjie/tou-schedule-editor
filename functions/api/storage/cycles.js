// Cloudflare Pages Function - 储能周期计算
// 端点: /api/storage/cycles

const jsonHeaders = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': '*',
};

const EPS = 1e-9;

const round = (value, digits = 6) => {
  const factor = 10 ** digits;
  return Math.round((Number(value) || 0) * factor) / factor;
};

const toCsvCell = (value) => {
  const raw = String(value ?? '');
  const escaped = raw.replace(/"/g, '""');
  if (/[",\n\r]/.test(escaped)) return `"${escaped}"`;
  return escaped;
};

const toCsv = (rows) => rows.map((row) => row.map(toCsvCell).join(',')).join('\n');

const toBase64 = (text) => {
  const bytes = new TextEncoder().encode(text);
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
};

const toDate = (value) => {
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
};

const ymd = (d) => {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
};

const monthKey = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;

// 分时电价档位顺序（从高到低）
const TIER_KEYS = ['尖', '峰', '平', '谷', '深'];

// 兜底电价
const FALLBACK_PRICES = { 尖: 0.9, 峰: 0.7, 平: 0.5, 谷: 0.3, 深: 0.2 };

/**
 * 获取指定月份的 TOU 电价
 * @param {Array} monthlyTouPrices - 月度电价数组
 * @param {number} monthIndex - 月份索引（0-11）
 * @returns {Object} 该月的电价对象 {尖, 峰, 平, 谷, 深}
 */
const getMonthPrices = (monthlyTouPrices, monthIndex) => {
  const fallback = { ...FALLBACK_PRICES };
  const p = Array.isArray(monthlyTouPrices) ? monthlyTouPrices[monthIndex] : null;
  if (!p || typeof p !== 'object') return fallback;
  const out = { ...fallback };
  for (const k of TIER_KEYS) {
    const n = Number(p[k]);
    if (Number.isFinite(n) && n > 0) {
      out[k] = n;
    }
  }
  return out;
};

/**
 * 简易 SOC 模拟器 - 按日追踪电池状态
 * @param {number} socKwh - 当前 SOC (kWh)
 * @param {number} capacityKwh - 电池容量 (kWh)
 * @param {number} chargeKwh - 充电量 (kWh)
 * @param {number} dischargeKwh - 放电量 (kWh)
 * @param {number} eta - 单向效率
 * @param {number} socMin - SOC 下限比例
 * @param {number} socMax - SOC 上限比例
 * @returns {Object} { actualChargeKwh, actualDischargeKwh, finalSocKwh }
 */
const simulateSOC = (
  socKwh,
  capacityKwh,
  chargeKwh,
  dischargeKwh,
  eta,
  socMin,
  socMax
) => {
  const minSoc = capacityKwh * socMin;
  const maxSoc = capacityKwh * socMax;

  // 限制充电不超过可用空间
  const maxCharge = Math.max(0, maxSoc - socKwh);
  const actualCharge = Math.min(chargeKwh, maxCharge);

  // 限制放电不超过可用能量
  const maxDischarge = Math.max(0, socKwh - minSoc);
  const actualDischarge = Math.min(dischargeKwh, maxDischarge);

  // 计算最终 SOC（考虑充放电效率）
  // 充电: SOC += charge * eta, 放电: SOC -= discharge / eta
  const newSoc = socKwh + actualCharge * eta - actualDischarge / eta;

  // 最终 SOC 也需要限制在范围内
  const finalSoc = Math.max(minSoc, Math.min(maxSoc, newSoc));

  return {
    actualChargeKwh: actualCharge,
    actualDischargeKwh: actualDischarge,
    finalSocKwh: finalSoc,
  };
};

const getDaysInMonth = (year, monthOneBased) => {
  return new Date(year, monthOneBased, 0).getDate();
};

const parseCsvRows = (text) => {
  const lines = String(text || '').split(/\r?\n/).filter((line) => line.trim().length > 0);
  if (lines.length <= 1) return [];

  const rows = [];
  for (let i = 1; i < lines.length; i += 1) {
    const items = lines[i].split(',').map((s) => s.trim().replace(/^"|"$/g, ''));
    if (items.length < 2) continue;

    let timestamp = null;
    let load = null;

    if (items.length >= 3) {
      const col0 = items[0];
      const col1 = items[1];
      const col2 = items[2];
      const col0IsTimestamp = (col0.includes('-') || col0.includes('/')) && col0.includes(':');
      if (col0IsTimestamp && Number.isFinite(Number(col1))) {
        timestamp = col0;
        load = Number(col1);
      } else {
        timestamp = `${col0} ${col1}`;
        load = Number(col2);
      }
    } else {
      timestamp = items[0];
      load = Number(items[1]);
    }

    const t = toDate(timestamp);
    if (!t || !Number.isFinite(load)) continue;
    rows.push({ timestamp: t, load_kw: load });
  }

  rows.sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());
  return rows;
};

const parseInputPoints = async (formData, payload) => {
  const points = Array.isArray(payload?.points) ? payload.points : [];
  if (points.length > 0) {
    const normalized = points
      .map((p) => {
        const t = toDate(p?.timestamp);
        const v = Number(p?.load_kwh ?? p?.load);
        if (!t || !Number.isFinite(v)) return null;
        return { timestamp: t, load_kw: v };
      })
      .filter(Boolean);
    normalized.sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());
    return normalized;
  }

  const file = formData.get('file');
  if (!file) {
    return [];
  }

  const fileName = String(file.name || '').toLowerCase();
  if (!fileName.endsWith('.csv')) {
    throw new Error('当前 Web 端储能测算仅支持 CSV 文件直传。若为 XLSX，请先在“负荷分析”页导入并勾选“使用负荷分析已上传数据”。');
  }

  const fileBuffer = await file.arrayBuffer();
  let text = new TextDecoder('utf-8').decode(fileBuffer);
  if (text.includes('����')) {
    try {
      text = new TextDecoder('gbk').decode(fileBuffer);
    } catch {
      // keep utf-8
    }
  }

  return parseCsvRows(text);
};

const inferIntervalHours = (rows) => {
  if (!rows || rows.length < 2) return 0.25;
  const diffs = [];
  for (let i = 1; i < rows.length; i += 1) {
    const dt = (rows[i].timestamp.getTime() - rows[i - 1].timestamp.getTime()) / 1000;
    if (dt > 0 && Number.isFinite(dt)) diffs.push(dt);
  }
  if (diffs.length === 0) return 0.25;
  diffs.sort((a, b) => a - b);
  const median = diffs[Math.floor(diffs.length / 2)];
  const h = median / 3600;
  if (!Number.isFinite(h) || h <= 0) return 0.25;
  return h;
};

const buildDailyLoads = (rows) => {
  const map = new Map();
  for (const row of rows) {
    const key = ymd(row.timestamp);
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(row);
  }
  return map;
};

const findRuleSchedule = (date, dateRules) => {
  if (!Array.isArray(dateRules)) return null;
  for (const rule of dateRules) {
    const s = toDate(`${rule?.startDate}T00:00:00`);
    const e = toDate(`${rule?.endDate}T23:59:59`);
    if (!s || !e) continue;
    if (date.getTime() >= s.getTime() && date.getTime() <= e.getTime()) {
      if (Array.isArray(rule?.schedule) && rule.schedule.length >= 24) {
        return rule.schedule;
      }
    }
  }
  return null;
};

const extractOps = (schedule24) => {
  const ops = new Array(24).fill('待机');
  for (let h = 0; h < 24; h += 1) {
    const op = schedule24?.[h]?.op;
    ops[h] = op === '充' || op === '放' ? op : '待机';
  }
  return ops;
};

const buildDailyOps = (dailyLoads, strategySource) => {
  const monthlySchedule = Array.isArray(strategySource?.monthlySchedule) ? strategySource.monthlySchedule : [];
  const dateRules = Array.isArray(strategySource?.dateRules) ? strategySource.dateRules : [];
  const map = new Map();

  for (const key of dailyLoads.keys()) {
    const d = toDate(`${key}T00:00:00`);
    if (!d) continue;

    const ruleSchedule = findRuleSchedule(d, dateRules);
    if (ruleSchedule) {
      map.set(key, extractOps(ruleSchedule));
      continue;
    }

    const mIdx = d.getMonth();
    const monthSchedule = Array.isArray(monthlySchedule[mIdx]) ? monthlySchedule[mIdx] : [];
    map.set(key, extractOps(monthSchedule));
  }

  return map;
};

const buildRuns = (ops) => {
  const runs = [];
  let currentKind = null;
  let currentHours = [];

  for (let h = 0; h < 24; h += 1) {
    const op = ops[h];
    if (op !== '充' && op !== '放') {
      if (currentKind) {
        runs.push({ kind: currentKind, hours: currentHours.slice() });
        currentKind = null;
        currentHours = [];
      }
      continue;
    }

    if (currentKind === op) {
      currentHours.push(h);
    } else {
      if (currentKind) runs.push({ kind: currentKind, hours: currentHours.slice() });
      currentKind = op;
      currentHours = [h];
    }
  }

  if (currentKind) runs.push({ kind: currentKind, hours: currentHours.slice() });
  return runs;
};

const buildDailyMasks = (dailyOps, mergeThresholdMinutes) => {
  const masks = new Map();
  let mergedSegments = 0;

  for (const [date, ops] of dailyOps.entries()) {
    const runs = buildRuns(ops).filter((run) => run.hours.length * 60 >= mergeThresholdMinutes);

    const c1 = { charge_hours: new Set(), discharge_hours: new Set() };
    const c2 = { charge_hours: new Set(), discharge_hours: new Set() };

    for (let i = 0; i < runs.length; i += 1) {
      const run = runs[i];
      const target = i < 2 ? c1 : c2;
      if (i >= 4) mergedSegments += 1;

      for (const h of run.hours) {
        if (run.kind === '充') target.charge_hours.add(h);
        if (run.kind === '放') target.discharge_hours.add(h);
      }
    }

    masks.set(date, {
      c1: {
        charge_hours: [...c1.charge_hours].sort((a, b) => a - b),
        discharge_hours: [...c1.discharge_hours].sort((a, b) => a - b),
      },
      c2: {
        charge_hours: [...c2.charge_hours].sort((a, b) => a - b),
        discharge_hours: [...c2.discharge_hours].sort((a, b) => a - b),
      },
    });
  }

  return { masks, mergedSegments };
};

const buildMonthlyDemandMax = (rows) => {
  const maxMap = new Map();
  for (const row of rows) {
    const key = monthKey(row.timestamp);
    const prev = maxMap.get(key);
    if (prev == null || row.load_kw > prev) {
      maxMap.set(key, row.load_kw);
    }
  }
  const entries = [...maxMap.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  return entries.map(([year_month, max_kw]) => ({ year_month, max_kw: round(max_kw, 6) }));
};

const windowEnergy = (dayRows, hourList, intervalHours, isCharge, limitKw, reserveChargeKw, reserveDischargeKw) => {
  if (!Array.isArray(hourList) || hourList.length === 0) {
    return { baseKwh: 0, eGridKwh: 0, fullRatio: 0, avgLoad: 0, points: 0 };
  }
  const hourSet = new Set(hourList.map((h) => Number(h)));
  const selected = dayRows.filter((r) => hourSet.has(r.timestamp.getHours()));
  if (selected.length === 0) {
    return { baseKwh: 0, eGridKwh: 0, fullRatio: 0, avgLoad: 0, points: 0 };
  }

  const avgLoad = selected.reduce((s, r) => s + r.load_kw, 0) / selected.length;
  const hours = selected.length * intervalHours;
  const allowKw = isCharge
    ? Math.max(limitKw - reserveChargeKw - avgLoad, 0)
    : Math.max(avgLoad - reserveDischargeKw, 0);
  const baseKwh = allowKw * hours;

  return {
    baseKwh,
    avgLoad,
    points: selected.length,
  };
};

/**
 * 计算收益 - 使用月度分时电价
 * @param {number} chargeKwh - 充电量 (kWh)
 * @param {number} dischargeKwh - 放电量 (kWh)
 * @param {Array} monthlyTouPrices - 月度电价数组
 * @param {number} monthIndex - 月份索引（0-11），用于获取对应月电价
 * @returns {Object} 收益明细
 */
const calcProfit = (chargeKwh, dischargeKwh, monthlyTouPrices, monthIndex = 0) => {
  // 使用对应月份的电价，而非全局 min/max
  const monthPrices = getMonthPrices(monthlyTouPrices, monthIndex);

  // 谷/深段电价作为购电价（充电）
  const buyPrice = Math.min(monthPrices.谷, monthPrices.深);
  // 尖/峰段电价作为售电价（放电）
  const sellPrice = Math.max(monthPrices.尖, monthPrices.峰);

  const revenue = dischargeKwh * sellPrice;
  const cost = chargeKwh * buyPrice;
  const profit = revenue - cost;

  return {
    revenue: round(revenue, 2),
    cost: round(cost, 2),
    profit: round(profit, 2),
    discharge_energy_kwh: round(dischargeKwh, 2),
    charge_energy_kwh: round(chargeKwh, 2),
    profit_per_kwh: dischargeKwh > EPS ? round(profit / dischargeKwh, 4) : 0,
  };
};

export async function onRequestPost(context) {
  try {
    const { request } = context;
    const formData = await request.formData();
    const payloadStr = formData.get('payload');
    const exportExcel = String(formData.get('export_excel') || '').toLowerCase() === 'true';
    const exportMode = String(formData.get('export_mode') || 'debug').toLowerCase();
    const payload = payloadStr ? JSON.parse(payloadStr) : {};

    const rows = await parseInputPoints(formData, payload);
    if (rows.length === 0) {
      throw new Error('没有可用于测算的负荷点数据，请先上传 CSV 或使用“负荷分析”页面已处理数据。');
    }

    const storage = payload?.storage || {};
    const strategySource = payload?.strategySource || {};
    const monthlyTouPrices = Array.isArray(payload?.monthlyTouPrices) ? payload.monthlyTouPrices : [];

    const capacityKwh = Number(storage.capacity_kwh) > 0 ? Number(storage.capacity_kwh) : 0;
    const eta = Number(storage.single_side_efficiency) > 0 ? Number(storage.single_side_efficiency) : 0.9;
    const dod = Number(storage.depth_of_discharge) > 0 ? Number(storage.depth_of_discharge) : 1.0;
    const reserveChargeKw = Number(storage.reserve_charge_kw) || 0;
    const reserveDischargeKw = Number(storage.reserve_discharge_kw) || 0;
    const mergeThresholdMinutes = Number(storage.merge_threshold_minutes) > 0 ? Number(storage.merge_threshold_minutes) : 30;

    const intervalHours = inferIntervalHours(rows);
    const dailyLoads = buildDailyLoads(rows);
    const dailyOps = buildDailyOps(dailyLoads, strategySource);
    const { masks: dailyMasks, mergedSegments } = buildDailyMasks(dailyOps, mergeThresholdMinutes);
    const monthlyDemandMax = buildMonthlyDemandMax(rows);
    const monthlyMaxMap = new Map(monthlyDemandMax.map((m) => [m.year_month, Number(m.max_kw) || 0]));

    const days = [];
    const monthAgg = new Map();
    const yearSet = new Set();
    let yearChargeKwh = 0;
    let yearDischargeKwh = 0;

    // SOC 参数
    const socMin = Number(storage.soc_min) > 0 ? Number(storage.soc_min) : 0.05;
    const socMax = Number(storage.soc_max) > 0 ? Number(storage.soc_max) : 0.95;
    // 初始 SOC（默认 50%）
    const initialSoc = capacityKwh * 0.5;
    // 每日 SOC 状态（跨天传递）
    let currentSoc = initialSoc;

    for (const [dateKey, dayRows] of [...dailyLoads.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
      const d = toDate(`${dateKey}T00:00:00`);
      if (!d) continue;
      yearSet.add(d.getFullYear());

      const ym = monthKey(d);
      const monthIdx = d.getMonth(); // 0-11
      const limitKw = Number(monthlyMaxMap.get(ym) || 0);
      const mask = dailyMasks.get(dateKey) || {
        c1: { charge_hours: [], discharge_hours: [] },
        c2: { charge_hours: [], discharge_hours: [] },
      };

      const isValid = dayRows.length > 0 && dayRows.some((r) => Number(r.load_kw) > 0);

      let dayCycles = 0;
      let dayChargeKwh = 0;
      let dayDischargeKwh = 0;

      if (limitKw > EPS && capacityKwh > EPS) {
        const windows = [
          { key: 'c1', data: mask.c1 },
          { key: 'c2', data: mask.c2 },
        ];

        for (const win of windows) {
          const ch = windowEnergy(
            dayRows,
            win.data.charge_hours,
            intervalHours,
            true,
            limitKw,
            reserveChargeKw,
            reserveDischargeKw,
          );
          const dis = windowEnergy(
            dayRows,
            win.data.discharge_hours,
            intervalHours,
            false,
            limitKw,
            reserveChargeKw,
            reserveDischargeKw,
          );

          // 原始充放电量
          let rawChargeKwh = ch.baseKwh * dod / Math.max(eta, EPS);
          let rawDischargeKwh = dis.baseKwh * dod * eta;

          // 按电池容量封顶（日循环不超过 2 次）
          const maxDailyEnergy = capacityKwh * 2;
          rawChargeKwh = Math.min(rawChargeKwh, maxDailyEnergy);
          rawDischargeKwh = Math.min(rawDischargeKwh, maxDailyEnergy);

          // SOC 模拟 - 获取实际可充放电量
          const socResult = simulateSOC(
            currentSoc,
            capacityKwh,
            rawChargeKwh,
            rawDischargeKwh,
            eta,
            socMin,
            socMax
          );

          const actualChargeKwh = socResult.actualChargeKwh;
          const actualDischargeKwh = socResult.actualDischargeKwh;
          currentSoc = socResult.finalSocKwh;

          // 计算等效循环次数：与 Python 后端逻辑一致
          // fc = min(charge/capacity, 1), fd = min(discharge/capacity, 1)
          // cycles = min(fc, fd)
          // 每个窗口最多贡献 1 次循环（一天最多 2 个窗口 = 2 次循环）
          const fc = capacityKwh > EPS ? Math.min(actualChargeKwh / capacityKwh, 1) : 0;
          const fd = capacityKwh > EPS ? Math.min(actualDischargeKwh / capacityKwh, 1) : 0;
          const cyc = Math.min(fc, fd);

          dayCycles += cyc;
          dayChargeKwh += actualChargeKwh;
          dayDischargeKwh += actualDischargeKwh;
        }
      }

      yearChargeKwh += dayChargeKwh;
      yearDischargeKwh += dayDischargeKwh;

      // 使用月度电价计算收益
      const dayProfit = calcProfit(dayChargeKwh, dayDischargeKwh, monthlyTouPrices, monthIdx);

      days.push({
        date: dateKey,
        cycles: round(dayCycles, 6),
        is_valid: isValid,
        point_count: dayRows.length,
        profit: { main: dayProfit },
      });

      if (!monthAgg.has(ym)) {
        monthAgg.set(ym, {
          cycles: 0,
          valid_days: 0,
          charge_kwh: 0,
          discharge_kwh: 0,
        });
      }
      const agg = monthAgg.get(ym);
      agg.cycles += dayCycles;
      agg.charge_kwh += dayChargeKwh;
      agg.discharge_kwh += dayDischargeKwh;
      if (isValid) agg.valid_days += 1;
    }

    const months = [...monthAgg.entries()]
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([ym, agg]) => {
        // 解析 year_month 获取月份索引
        const monthNum = Number.parseInt(ym.length >= 7 ? ym.slice(5, 7) : '1', 10);
        const mIdx = Number.isFinite(monthNum) && monthNum >= 1 && monthNum <= 12 ? monthNum - 1 : 0;
        return {
          year_month: ym,
          cycles: round(agg.cycles, 6),
          valid_days: agg.valid_days,
          profit: {
            main: calcProfit(agg.charge_kwh, agg.discharge_kwh, monthlyTouPrices, mIdx),
          },
        };
      });

    const yearCycles = round(days.reduce((s, d) => s + (Number(d.cycles) || 0), 0), 6);
    const yearValidDays = days.filter((d) => d.is_valid).length;
    const year = yearSet.size === 1 ? [...yearSet][0] : 0;

    // 月度窗口汇总：直接将月份总循环次数作为充放电次数（简化版）
    const windowMonthSummary = months.map((m) => {
      const c = Number(m.cycles) || 0;
      return {
        year_month: m.year_month,
        first_charge_cycles: round(c, 6),
        first_discharge_cycles: round(c, 6),
        second_charge_cycles: 0,
        second_discharge_cycles: 0,
      };
    });

    // 年度收益使用年均电价（所有月份电价的平均值）
    const yearlyAvgPrices = (() => {
      const all = { 尖: [], 峰: [], 平: [], 谷: [], 深: [] };
      for (let i = 0; i < 12; i++) {
        const mp = getMonthPrices(monthlyTouPrices, i);
        for (const k of TIER_KEYS) all[k].push(mp[k]);
      }
      const avg = (arr) => arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0;
      return {
        尖: avg(all.尖), 峰: avg(all.峰), 平: avg(all.平), 谷: avg(all.谷), 深: avg(all.深)
      };
    })();
    const yearlyBuyPrice = Math.min(yearlyAvgPrices.谷, yearlyAvgPrices.深);
    const yearlySellPrice = Math.max(yearlyAvgPrices.尖, yearlyAvgPrices.峰);
    const yearlyRevenue = yearDischargeKwh * yearlySellPrice;
    const yearlyCost = yearChargeKwh * yearlyBuyPrice;
    const yearlyProfit = yearlyRevenue - yearlyCost;
    const yearProfitMain = {
      revenue: round(yearlyRevenue, 2),
      cost: round(yearlyCost, 2),
      profit: round(yearlyProfit, 2),
      discharge_energy_kwh: round(yearDischargeKwh, 2),
      charge_energy_kwh: round(yearChargeKwh, 2),
      profit_per_kwh: yearDischargeKwh > EPS ? round(yearlyProfit / yearDischargeKwh, 4) : 0,
    };

    const responsePayload = {
      year: {
        year,
        cycles: yearCycles,
        valid_days: yearValidDays,
        profit: {
          main: yearProfitMain,
        },
      },
      months,
      days,
      qc: {
        notes: ['采用窗口平均法（简化版）计算 cycles，结果随容量与策略变化。'],
        missing_prices: 0,
        missing_points: 0,
        merged_segments: mergedSegments,
        limit_mode: 'monthly_demand_max',
        transformer_limit_kw: null,
        monthly_demand_max: monthlyDemandMax,
      },
      excel_path: null,
      window_month_summary: windowMonthSummary,
      tip_discharge_summary: {
        avg_tip_load_kw: 0,
        tip_hours: 0,
        discharge_count: 0,
        capacity_kwh: capacityKwh,
        energy_need_kwh: 0,
        ratio: 0,
        note: 'Pages Functions 端未启用尖段占比分析',
      },
    };

    if (exportExcel) {
      const nowTag = new Date().toISOString().replace(/[:.]/g, '').slice(0, 15);
      if (exportMode === 'business') {
        const rowsBusiness = [
          ['date', 'cycles', 'valid', 'charge_kwh', 'discharge_kwh', 'profit_yuan'],
          ...days.map((d) => [
            d.date,
            d.cycles,
            d.is_valid ? 1 : 0,
            d.profit?.main?.charge_energy_kwh ?? 0,
            d.profit?.main?.discharge_energy_kwh ?? 0,
            d.profit?.main?.profit ?? 0,
          ]),
        ];
        const csvBusiness = toCsv(rowsBusiness);
        const filename = `storage_business_${nowTag}.csv`;
        responsePayload.excel_path = filename;
        responsePayload.file_name = filename;
        responsePayload.mime_type = 'text/csv;charset=utf-8';
        responsePayload.file_content_base64 = toBase64(`\uFEFF${csvBusiness}`);
      } else {
        const rowsSummary = [
          ['year', 'year_cycles', 'valid_days', 'profit_yuan'],
          [year, yearCycles, yearValidDays, responsePayload.year?.profit?.main?.profit ?? 0],
          [],
          ['year_month', 'month_cycles', 'valid_days', 'profit_yuan'],
          ...months.map((m) => [m.year_month, m.cycles, m.valid_days ?? 0, m.profit?.main?.profit ?? 0]),
          [],
          ['date', 'day_cycles', 'is_valid', 'point_count', 'profit_yuan'],
          ...days.map((d) => [d.date, d.cycles, d.is_valid ? 1 : 0, d.point_count ?? 0, d.profit?.main?.profit ?? 0]),
        ];
        const csvSummary = toCsv(rowsSummary);
        const filename = `storage_cycles_${nowTag}.csv`;
        responsePayload.excel_path = filename;
        responsePayload.file_name = filename;
        responsePayload.mime_type = 'text/csv;charset=utf-8';
        responsePayload.file_content_base64 = toBase64(`\uFEFF${csvSummary}`);
      }
    }

    return new Response(JSON.stringify(responsePayload), {
      status: 200,
      headers: jsonHeaders,
    });
  } catch (error) {
    return new Response(
      JSON.stringify({ success: false, detail: error?.message || 'Storage cycles compute failed' }),
      {
        status: 500,
        headers: jsonHeaders,
      },
    );
  }
}

export async function onRequestOptions() {
  return new Response(null, {
    status: 204,
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    },
  });
}
