// 共享功率约束逻辑 — 对齐 Python build_step15_power_series (cycles.py:2233-2428)
//
// 约束层：
// 1. pMax 限制（储能最大功率）
// 2. 变压器容量封顶（transformer_capacity 模式）
// 3. 禁止余电上网（放电不使负荷变负）
// 4. 窗口目标约束（每窗口充放电能量上限）
// 5. SOC 跟踪（防止过充过放）

const EPS = 1e-9;

/**
 * 逐点计算带约束的电池功率，返回每点的 { pBatt, eIn, eOut, pGrid } 以及汇总
 *
 * @param {Object} params
 * @param {Array}  params.dayRows          - 当日负荷点 [{timestamp, load_kw}]
 * @param {Array}  params.schedule24       - 24h 调度 [{op, tou}]
 * @param {Object} params.monthPrices      - {尖,峰,平,谷,深} 电价
 * @param {number} params.intervalHours    - 采样间隔(小时)
 * @param {number} params.limitKw          - 功率上限 kW
 * @param {string} params.limitMode        - 'monthly_demand_max' | 'transformer_capacity'
 * @param {number} params.reserveChargeKw  - 充电预留 kW
 * @param {number} params.reserveDischargeKw - 放电预留 kW
 * @param {number} params.capacityKwh      - 电池容量 kWh
 * @param {number} params.cRate            - C 率
 * @param {number} params.eta              - 单侧效率
 * @param {number} params.dod              - 放电深度
 * @param {number} params.socMin           - SOC 下限 (0~1)
 * @param {number} params.socMax           - SOC 上限 (0~1)
 * @param {Object} [params.mask]           - 窗口 mask {c1:{charge_hours,discharge_hours}, c2:{...}}
 */
export function computeConstrainedPower(params) {
  const {
    dayRows, schedule24, monthPrices, intervalHours,
    limitKw, limitMode = 'monthly_demand_max',
    reserveChargeKw = 0, reserveDischargeKw = 0,
    capacityKwh, cRate, eta, dod,
    socMin = 0, socMax = 1,
    mask,
  } = params;

  const TIER_KEYS = ['尖', '峰', '平', '谷', '深'];
  const pMax = capacityKwh * cRate;
  const effectiveDod = Math.max(0, Math.min(dod, socMax - socMin));
  const dt = intervalHours;

  // --- 构造窗口目标 ---
  const windowState = {};  // key -> { charged, discharged, chargeTarget, dischargeTarget }
  if (mask && capacityKwh > EPS && effectiveDod > EPS) {
    const usableBatt = capacityKwh * effectiveDod;
    for (const winKey of ['c1', 'c2']) {
      const w = mask[winKey];
      if (!w) continue;
      const hasCharge = w.charge_hours && w.charge_hours.length > 0;
      const hasDischarge = w.discharge_hours && w.discharge_hours.length > 0;
      if (hasCharge || hasDischarge) {
        windowState[winKey] = {
          charged: 0,
          discharged: 0,
          chargeTarget: usableBatt / Math.max(eta, EPS),   // 电网侧充电上限
          dischargeTarget: usableBatt * eta,                 // 电网侧放电上限
        };
      }
    }
  }

  // 构造 hour -> winKey 映射
  const hourToWin = {};
  if (mask) {
    for (const winKey of ['c1', 'c2']) {
      const w = mask[winKey];
      if (!w) continue;
      for (const h of (w.charge_hours || [])) hourToWin[h] = winKey;
      for (const h of (w.discharge_hours || [])) hourToWin[h] = winKey;
    }
  }

  // SOC 跟踪
  let currentSoc = socMin;  // 初始 SOC = socMin（空电池开始）

  // 汇总
  let totalRevenue = 0;
  let totalCost = 0;
  let totalChargeKwh = 0;
  let totalDischargeKwh = 0;

  // 逐点结果
  const pointResults = [];

  for (const row of dayRows) {
    const hour = row.timestamp.getHours();
    const rawOp = schedule24?.[hour]?.op;
    const op = (rawOp === '充' || rawOp === '放') ? rawOp : '待机';
    const rawTou = schedule24?.[hour]?.tou;
    const tier = TIER_KEYS.includes(rawTou) ? rawTou : '平';
    const price = Number(monthPrices[tier] ?? 0) || 0;
    const loadKw = row.load_kw;

    // --- 基础 pBatt ---
    let pBatt = 0;
    if (op === '充') {
      pBatt = Math.min(Math.max(limitKw - reserveChargeKw - loadKw, 0), pMax);
    } else if (op === '放') {
      pBatt = -Math.min(Math.max(loadKw - reserveDischargeKw, 0), pMax);
    }

    // --- physics 口径能量 ---
    let eInPhys = 0;   // 电网侧充电能量 (>0)
    let eOutPhys = 0;  // 电网侧放电能量 (>0)
    if (pBatt > 0) {
      eInPhys = pBatt * dt * effectiveDod / Math.max(eta, EPS);
    } else if (pBatt < 0) {
      eOutPhys = (-pBatt) * dt * effectiveDod * eta;
    }
    let pGridPhys = (eInPhys - eOutPhys) / Math.max(dt, EPS);

    // 缩放辅助函数
    const applyScale = (scale) => {
      const s = Math.max(0, Math.min(1, scale));
      pBatt *= s;
      eInPhys *= s;
      eOutPhys *= s;
      pGridPhys = (eInPhys - eOutPhys) / Math.max(dt, EPS);
    };

    // --- 约束 1: 变压器容量封顶 ---
    if (limitMode === 'transformer_capacity' && limitKw > 0 && loadKw < limitKw) {
      if (pGridPhys > 0) {  // 充电增加电网负荷
        const loadWith = loadKw + pGridPhys;
        if (loadWith > limitKw + 1e-6) {
          const allowedExtra = Math.max(limitKw - loadKw, 0);
          const scaleCap = allowedExtra > 0 ? allowedExtra / pGridPhys : 0;
          if (scaleCap < 1) {
            applyScale(scaleCap);
          }
        }
      }
    }

    // --- 约束 2: 禁止余电上网 ---
    if (loadKw > 0 && pGridPhys < 0) {
      const maxDischarge = -pGridPhys;
      const allowedDischarge = Math.max(loadKw - reserveDischargeKw, 0);
      if (maxDischarge > allowedDischarge + 1e-6) {
        const scaleDis = allowedDischarge > 0 ? allowedDischarge / maxDischarge : 0;
        if (scaleDis < 1) {
          applyScale(scaleDis);
        }
      }
    }

    // --- 约束 3: 窗口目标约束 ---
    const winKey = hourToWin[hour];
    if (winKey && windowState[winKey]) {
      const ws = windowState[winKey];
      if (op === '充' && ws.chargeTarget > 0) {
        const allowed = Math.max(ws.chargeTarget - ws.charged, 0);
        if (eInPhys > allowed + EPS) {
          applyScale(allowed / Math.max(eInPhys, EPS));
        }
      } else if (op === '放' && ws.dischargeTarget > 0) {
        const allowed = Math.max(ws.dischargeTarget - ws.discharged, 0);
        if (eOutPhys > allowed + EPS) {
          applyScale(allowed / Math.max(eOutPhys, EPS));
        }
      }
      ws.charged += eInPhys;
      ws.discharged += eOutPhys;
    }

    // --- 约束 4: SOC 跟踪 ---
    if (capacityKwh > EPS) {
      const eBattChange = pBatt * dt;  // 电池侧能量变化
      const newSoc = currentSoc + eBattChange / capacityKwh;
      if (newSoc > socMax + 1e-6 && pBatt > 0) {
        // 过充 → 缩放
        const room = Math.max(socMax - currentSoc, 0) * capacityKwh;
        const scaleSoc = room > EPS ? room / (pBatt * dt) : 0;
        if (scaleSoc < 1) applyScale(scaleSoc);
      } else if (newSoc < socMin - 1e-6 && pBatt < 0) {
        // 过放 → 缩放
        const room = Math.max(currentSoc - socMin, 0) * capacityKwh;
        const scaleSoc = room > EPS ? room / ((-pBatt) * dt) : 0;
        if (scaleSoc < 1) applyScale(scaleSoc);
      }
      currentSoc = Math.max(socMin, Math.min(socMax, currentSoc + pBatt * dt / capacityKwh));
    }

    // --- 收益计算 ---
    if (eInPhys > 0) {
      totalCost += eInPhys * price;
      totalChargeKwh += eInPhys;
    }
    if (eOutPhys > 0) {
      totalRevenue += eOutPhys * price;
      totalDischargeKwh += eOutPhys;
    }

    pointResults.push({
      timestamp: row.timestamp,
      loadKw,
      pBatt,
      eIn: eInPhys,
      eOut: eOutPhys,
      pGrid: pGridPhys,
      loadWithStorage: loadKw + pBatt,
      tier,
      price,
      soc: currentSoc,
    });
  }

  const profit = totalRevenue - totalCost;
  return {
    points: pointResults,
    summary: {
      revenue: totalRevenue,
      cost: totalCost,
      profit,
      charge_energy_kwh: totalChargeKwh,
      discharge_energy_kwh: totalDischargeKwh,
      profit_per_kwh: totalDischargeKwh > EPS ? profit / totalDischargeKwh : 0,
    },
  };
}
