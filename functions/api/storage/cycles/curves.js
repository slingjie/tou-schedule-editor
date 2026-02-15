// Cloudflare Pages Function - 储能前后负荷曲线
// 端点: /api/storage/cycles/curves

import { computeConstrainedPower } from '../_power.js';

const jsonHeaders = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': '*',
};

const TIER_KEYS = ['尖', '峰', '平', '谷', '深'];

const round = (value, digits = 6) => {
  const factor = 10 ** digits;
  return Math.round((Number(value) || 0) * factor) / factor;
};

const parseDate = (value) => {
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
};

const ymd = (d) => {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
};

const resolveSchedule24 = (dateObj, strategySource) => {
  const monthlySchedule = Array.isArray(strategySource?.monthlySchedule) ? strategySource.monthlySchedule : [];
  const dateRules = Array.isArray(strategySource?.dateRules) ? strategySource.dateRules : [];

  for (const rule of dateRules) {
    const s = parseDate(`${rule?.startDate}T00:00:00`);
    const e = parseDate(`${rule?.endDate}T23:59:59`);
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

const inferIntervalHours = (rows) => {
  if (!Array.isArray(rows) || rows.length < 2) return 0.25;
  const diffs = [];
  for (let i = 1; i < rows.length; i += 1) {
    const sec = (rows[i].timestamp.getTime() - rows[i - 1].timestamp.getTime()) / 1000;
    if (sec > 0 && Number.isFinite(sec)) diffs.push(sec);
  }
  if (diffs.length === 0) return 0.25;
  diffs.sort((a, b) => a - b);
  return diffs[Math.floor(diffs.length / 2)] / 3600;
};

const pickMonthPrice = (monthlyTouPrices, monthIdx) => {
  const fallback = { 尖: 0.9, 峰: 0.7, 平: 0.5, 谷: 0.3, 深: 0.2 };
  const p = Array.isArray(monthlyTouPrices) ? monthlyTouPrices[monthIdx] : null;
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

const initTierMap = () => ({ 尖: 0, 峰: 0, 平: 0, 谷: 0, 深: 0 });

const getLimitKw = (allRows, dateObj, storage) => {
  const meteringMode = storage?.metering_mode || 'monthly_demand_max';
  if (meteringMode === 'transformer_capacity') {
    const kva = Number(storage?.transformer_capacity_kva);
    const pf = Number(storage?.transformer_power_factor);
    if (Number.isFinite(kva) && kva > 0) {
      return kva * (Number.isFinite(pf) && pf > 0 ? pf : 0.9);
    }
  }

  const y = dateObj.getFullYear();
  const m = dateObj.getMonth();
  let maxKw = 0;
  for (const row of allRows) {
    if (row.timestamp.getFullYear() === y && row.timestamp.getMonth() === m) {
      if (row.load_kw > maxKw) maxKw = row.load_kw;
    }
  }
  return maxKw;
};

/** 从 schedule24 构造单日窗口 mask（用于 curves 单日查询） */
const buildMaskFromSchedule = (schedule24) => {
  const c1 = { charge_hours: [], discharge_hours: [] };
  const c2 = { charge_hours: [], discharge_hours: [] };

  // 识别连续的充/放段
  const runs = [];
  let currentKind = null;
  let currentHours = [];
  for (let h = 0; h < 24; h++) {
    const op = schedule24?.[h]?.op;
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

  // 前 2 段归 c1，后续归 c2
  for (let i = 0; i < runs.length; i++) {
    const target = i < 2 ? c1 : c2;
    for (const h of runs[i].hours) {
      if (runs[i].kind === '充') target.charge_hours.push(h);
      if (runs[i].kind === '放') target.discharge_hours.push(h);
    }
  }

  return { c1, c2 };
};

export async function onRequestPost(context) {
  try {
    const { request } = context;
    const body = await request.json();

    const payload = body?.payload || {};
    const date = String(body?.date || '');
    if (!date || date.length !== 10) {
      return new Response(JSON.stringify({ detail: 'date must be YYYY-MM-DD' }), {
        status: 400,
        headers: jsonHeaders,
      });
    }

    const dateObj = parseDate(`${date}T00:00:00`);
    if (!dateObj) {
      return new Response(JSON.stringify({ detail: 'invalid date' }), {
        status: 400,
        headers: jsonHeaders,
      });
    }

    const points = Array.isArray(payload?.points) ? payload.points : [];
    const allRows = points
      .map((p) => {
        const t = parseDate(p?.timestamp);
        const l = Number(p?.load_kwh ?? p?.load);
        if (!t || !Number.isFinite(l)) return null;
        return { timestamp: t, load_kw: l };
      })
      .filter(Boolean)
      .sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());

    const dayRows = allRows.filter((r) => ymd(r.timestamp) === date);
    if (!dayRows.length) {
      return new Response(JSON.stringify({ detail: `no data for date=${date}` }), {
        status: 400,
        headers: jsonHeaders,
      });
    }

    const storage = payload?.storage || {};
    const strategySource = payload?.strategySource || {};
    const monthlyTouPrices = Array.isArray(payload?.monthlyTouPrices) ? payload.monthlyTouPrices : [];

    const schedule24 = resolveSchedule24(dateObj, strategySource);
    const intervalHours = inferIntervalHours(dayRows);
    const capacityKwh = Math.max(Number(storage?.capacity_kwh || 0), 0);
    const cRate = Math.max(Number(storage?.c_rate || 0), 0);
    const eta = Number(storage?.single_side_efficiency) > 0 ? Number(storage.single_side_efficiency) : 0.9;
    const dod = Number(storage?.depth_of_discharge) > 0 ? Number(storage.depth_of_discharge) : 1.0;
    const reserveChargeKw = Math.max(Number(storage?.reserve_charge_kw || 0), 0);
    const reserveDischargeKw = Math.max(Number(storage?.reserve_discharge_kw || 0), 0);
    const limitKw = getLimitKw(allRows, dateObj, storage);
    const limitMode = storage?.metering_mode || 'monthly_demand_max';

    const monthPrice = pickMonthPrice(monthlyTouPrices, dateObj.getMonth());
    const mask = buildMaskFromSchedule(schedule24);

    const result = computeConstrainedPower({
      dayRows, schedule24, monthPrices: monthPrice, intervalHours,
      limitKw, limitMode,
      reserveChargeKw, reserveDischargeKw,
      capacityKwh, cRate, eta, dod,
      socMin: 0, socMax: 1, mask,
    });

    // 从逐点结果重建 tier 聚合和曲线点
    const tierEnergyOriginal = initTierMap();
    const tierEnergyNew = initTierMap();
    const tierBillOriginal = initTierMap();
    const tierBillNew = initTierMap();
    const pointsOriginal = [];
    const pointsWithStorage = [];

    for (const pt of result.points) {
      const eOrigin = pt.loadKw * intervalHours;
      const eNew = pt.loadWithStorage * intervalHours;
      tierEnergyOriginal[pt.tier] += eOrigin;
      tierEnergyNew[pt.tier] += eNew;
      tierBillOriginal[pt.tier] += eOrigin * pt.price;
      tierBillNew[pt.tier] += eNew * pt.price;

      pointsOriginal.push({ timestamp: pt.timestamp.toISOString(), load_kw: round(pt.loadKw, 6) });
      pointsWithStorage.push({ timestamp: pt.timestamp.toISOString(), load_kw: round(pt.loadWithStorage, 6) });
    }

    const originalMax = Math.max(...dayRows.map((r) => r.load_kw));
    const newMax = Math.max(...pointsWithStorage.map((p) => p.load_kw));
    const reductionKw = originalMax - newMax;
    const reductionRatio = originalMax > 0 ? reductionKw / originalMax : 0;

    const s = result.summary;
    const responsePayload = {
      date,
      points_original: pointsOriginal,
      points_with_storage: pointsWithStorage,
      summary: {
        max_demand_original_kw: round(originalMax, 6),
        max_demand_new_kw: round(newMax, 6),
        max_demand_reduction_kw: round(reductionKw, 6),
        max_demand_reduction_ratio: round(reductionRatio, 6),
        energy_by_tier_original: Object.fromEntries(TIER_KEYS.map((k) => [k, round(tierEnergyOriginal[k], 6)])),
        energy_by_tier_new: Object.fromEntries(TIER_KEYS.map((k) => [k, round(tierEnergyNew[k], 6)])),
        bill_by_tier_original: Object.fromEntries(TIER_KEYS.map((k) => [k, round(tierBillOriginal[k], 6)])),
        bill_by_tier_new: Object.fromEntries(TIER_KEYS.map((k) => [k, round(tierBillNew[k], 6)])),
        profit_day_main: {
          revenue: round(s.revenue, 2),
          cost: round(s.cost, 2),
          profit: round(s.profit, 2),
          discharge_energy_kwh: round(s.discharge_energy_kwh, 2),
          charge_energy_kwh: round(s.charge_energy_kwh, 2),
          profit_per_kwh: s.discharge_energy_kwh > 0 ? round(s.profit / s.discharge_energy_kwh, 4) : 0,
        },
      },
    };

    return new Response(JSON.stringify(responsePayload), {
      status: 200,
      headers: jsonHeaders,
    });
  } catch (error) {
    return new Response(
      JSON.stringify({ detail: error?.message || 'storage curves compute failed' }),
      { status: 500, headers: jsonHeaders },
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
