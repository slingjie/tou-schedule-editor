// Cloudflare Pages Function - 储能前后负荷曲线
// 端点: /api/storage/cycles/curves

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

const getTier = (schedule24, hour) => {
  const raw = schedule24?.[hour]?.tou;
  return TIER_KEYS.includes(raw) ? raw : '平';
};

const getOp = (schedule24, hour) => {
  const op = schedule24?.[hour]?.op;
  if (op === '充' || op === '放' || op === '待机') return op;
  return '待机';
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
    const pMax = Math.max(Number(storage?.capacity_kwh || 0) * Number(storage?.c_rate || 0), 0);
    const reserveChargeKw = Math.max(Number(storage?.reserve_charge_kw || 0), 0);
    const reserveDischargeKw = Math.max(Number(storage?.reserve_discharge_kw || 0), 0);
    const limitKw = getLimitKw(allRows, dateObj, storage);

    const monthPrice = pickMonthPrice(monthlyTouPrices, dateObj.getMonth());
    const tierEnergyOriginal = initTierMap();
    const tierEnergyNew = initTierMap();
    const tierBillOriginal = initTierMap();
    const tierBillNew = initTierMap();

    let chargeEnergyKwh = 0;
    let dischargeEnergyKwh = 0;

    const pointsOriginal = [];
    const pointsWithStorage = [];

    for (const row of dayRows) {
      const hour = row.timestamp.getHours();
      const op = getOp(schedule24, hour);

      let effectKw = 0;
      if (op === '充') {
        const allowByLimit = Math.max(limitKw - reserveChargeKw - row.load_kw, 0);
        effectKw = Math.max(Math.min(pMax, allowByLimit), 0);
        chargeEnergyKwh += effectKw * intervalHours;
      } else if (op === '放') {
        const allowByLoad = Math.max(row.load_kw - reserveDischargeKw, 0);
        effectKw = -Math.max(Math.min(pMax, allowByLoad), 0);
        dischargeEnergyKwh += Math.abs(effectKw) * intervalHours;
      }

      const loadWithStorage = row.load_kw + effectKw;
      const tier = getTier(schedule24, hour);
      const price = Number(monthPrice[tier] ?? 0) || 0;

      const eOrigin = row.load_kw * intervalHours;
      const eNew = loadWithStorage * intervalHours;
      tierEnergyOriginal[tier] += eOrigin;
      tierEnergyNew[tier] += eNew;
      tierBillOriginal[tier] += eOrigin * price;
      tierBillNew[tier] += eNew * price;

      pointsOriginal.push({ timestamp: row.timestamp.toISOString(), load_kw: round(row.load_kw, 6) });
      pointsWithStorage.push({ timestamp: row.timestamp.toISOString(), load_kw: round(loadWithStorage, 6) });
    }

    const originalMax = Math.max(...dayRows.map((r) => r.load_kw));
    const newMax = Math.max(...pointsWithStorage.map((p) => p.load_kw));
    const reductionKw = originalMax - newMax;
    const reductionRatio = originalMax > 0 ? reductionKw / originalMax : 0;

    // 使用分时电价：谷/深段电价作为购电价，尖/峰段电价作为售电价
    const buyPrice = Math.min(monthPrice.谷 ?? 0.3, monthPrice.深 ?? 0.2);
    const sellPrice = Math.max(monthPrice.尖 ?? 0.9, monthPrice.峰 ?? 0.7);
    const revenue = dischargeEnergyKwh * sellPrice;
    const cost = chargeEnergyKwh * buyPrice;
    const profit = revenue - cost;

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
          revenue: round(revenue, 2),
          cost: round(cost, 2),
          profit: round(profit, 2),
          discharge_energy_kwh: round(dischargeEnergyKwh, 2),
          charge_energy_kwh: round(chargeEnergyKwh, 2),
          profit_per_kwh: dischargeEnergyKwh > 0 ? round(profit / dischargeEnergyKwh, 4) : 0,
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
