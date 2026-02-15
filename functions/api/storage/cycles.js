// Cloudflare Pages Function - 储能周期计算
// 端点: /api/storage/cycles

import { computeConstrainedPower } from './_power.js';

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
 * 解析某日的 24h 调度（与 curves.js 的 resolveSchedule24 一致）
 */
const resolveSchedule24 = (dateObj, strategySource) => {
  const monthlySchedule = Array.isArray(strategySource?.monthlySchedule) ? strategySource.monthlySchedule : [];
  const dateRules = Array.isArray(strategySource?.dateRules) ? strategySource.dateRules : [];

  for (const rule of dateRules) {
    const s = toDate(`${rule?.startDate}T00:00:00`);
    const e = toDate(`${rule?.endDate}T23:59:59`);
    if (!s || !e) continue;
    if (dateObj.getTime() >= s.getTime() && dateObj.getTime() <= e.getTime()) {
      if (Array.isArray(rule?.schedule) && rule.schedule.length >= 24) {
        return rule.schedule;
      }
    }
  }

  const monthIdx = dateObj.getMonth();
  const monthSchedule = Array.isArray(monthlySchedule[monthIdx]) ? monthlySchedule[monthIdx] : [];
  if (monthSchedule.length >= 24) return monthSchedule;

  return Array.from({ length: 24 }, () => ({ op: '待机', tou: '平' }));
};

/** 获取某小时的 TOU 档位 */
const getTier = (schedule24, hour) => {
  const raw = schedule24?.[hour]?.tou;
  return TIER_KEYS.includes(raw) ? raw : '平';
};

/** 获取某小时的运行逻辑 */
const getOp = (schedule24, hour) => {
  const op = schedule24?.[hour]?.op;
  if (op === '充' || op === '放' || op === '待机') return op;
  return '待机';
};

/**
 * 逐 15 分钟点分时电价收益计算（与 Python compute_profit_summary_step15 对齐）
 * 使用 computeConstrainedPower 实现 4 层功率约束
 */
const calcProfitStep15 = (
  dayRows, schedule24, monthPrices, intervalHours,
  limitKw, limitMode, reserveChargeKw, reserveDischargeKw,
  capacityKwh, cRate, eta, dod, socMin, socMax, mask
) => {
  const result = computeConstrainedPower({
    dayRows, schedule24, monthPrices, intervalHours,
    limitKw, limitMode,
    reserveChargeKw, reserveDischargeKw,
    capacityKwh, cRate, eta, dod,
    socMin, socMax, mask,
  });
  const s = result.summary;
  return {
    revenue: round(s.revenue, 2),
    cost: round(s.cost, 2),
    profit: round(s.profit, 2),
    discharge_energy_kwh: round(s.discharge_energy_kwh, 2),
    charge_energy_kwh: round(s.charge_energy_kwh, 2),
    profit_per_kwh: s.discharge_energy_kwh > EPS ? round(s.profit / s.discharge_energy_kwh, 4) : 0,
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
    const cRate = Number(storage.c_rate) > 0 ? Number(storage.c_rate) : 0.5;
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
    let yearRevenue = 0;
    let yearCost = 0;
    let yearChargeKwh = 0;
    let yearDischargeKwh = 0;

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

          // 与 Python _cycle_contrib 完全对齐
          const E_in_grid = ch.baseKwh * dod / Math.max(eta, EPS);
          const E_out_grid = dis.baseKwh * dod * eta;
          const fc = capacityKwh > EPS ? Math.min(E_in_grid / capacityKwh, 1) : 0;
          const fd = capacityKwh > EPS ? Math.min(E_out_grid / capacityKwh, 1) : 0;
          const cyc = Math.min(fc, fd);
          dayCycles += cyc;
          dayChargeKwh += E_in_grid;
          dayDischargeKwh += E_out_grid;
        }
      }

      // 逐点分时电价收益（与 Python compute_profit_summary_step15 对齐）
      const schedule24 = resolveSchedule24(d, strategySource);
      const monthPrices = getMonthPrices(monthlyTouPrices, monthIdx);
      const dayProfit = calcProfitStep15(
        dayRows, schedule24, monthPrices, intervalHours,
        limitKw, 'monthly_demand_max', reserveChargeKw, reserveDischargeKw,
        capacityKwh, cRate, eta, dod, 0, 1, mask
      );

      yearChargeKwh += Number(dayProfit.charge_energy_kwh) || 0;
      yearDischargeKwh += Number(dayProfit.discharge_energy_kwh) || 0;
      yearRevenue += Number(dayProfit.revenue) || 0;
      yearCost += Number(dayProfit.cost) || 0;

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
          revenue: 0,
          cost: 0,
        });
      }
      const agg = monthAgg.get(ym);
      agg.cycles += dayCycles;
      agg.charge_kwh += Number(dayProfit.charge_energy_kwh) || 0;
      agg.discharge_kwh += Number(dayProfit.discharge_energy_kwh) || 0;
      agg.revenue += Number(dayProfit.revenue) || 0;
      agg.cost += Number(dayProfit.cost) || 0;
      if (isValid) agg.valid_days += 1;
    }

    const months = [...monthAgg.entries()]
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([ym, agg]) => {
        const monthProfit = agg.revenue - agg.cost;
        return {
          year_month: ym,
          cycles: round(agg.cycles, 6),
          valid_days: agg.valid_days,
          profit: {
            main: {
              revenue: round(agg.revenue, 2),
              cost: round(agg.cost, 2),
              profit: round(monthProfit, 2),
              discharge_energy_kwh: round(agg.discharge_kwh, 2),
              charge_energy_kwh: round(agg.charge_kwh, 2),
              profit_per_kwh: agg.discharge_kwh > EPS ? round(monthProfit / agg.discharge_kwh, 4) : 0,
            },
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

    // 年度收益 = 所有日度收益之和（与 Python 一致）
    const yearlyProfit = yearRevenue - yearCost;
    const yearProfitMain = {
      revenue: round(yearRevenue, 2),
      cost: round(yearCost, 2),
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
