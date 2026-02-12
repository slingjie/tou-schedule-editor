// Cloudflare Pages Function - 储能经济性测算
// 端点: /api/storage/economics

const jsonHeaders = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': '*',
};

const round = (value, digits = 2) => {
  const factor = 10 ** digits;
  return Math.round((Number(value) || 0) * factor) / factor;
};

const buildCashflows = ({
  firstYearRevenue,
  projectYears,
  annualOmCost,
  firstYearDecayRate,
  subsequentDecayRate,
  cellReplacementYear,
  cellReplacementCost,
  secondPhaseFirstYearRevenue,
}) => {
  const secondPhaseRevenue =
    Number.isFinite(Number(secondPhaseFirstYearRevenue)) && Number(secondPhaseFirstYearRevenue) > 0
      ? Number(secondPhaseFirstYearRevenue)
      : firstYearRevenue;

  const cashflows = [];
  let cumulative = 0;
  let currentBaseRevenue = firstYearRevenue;
  let phaseStartYear = 1;

  for (let year = 1; year <= projectYears; year += 1) {
    let replacement = 0;
    if (cellReplacementYear && year === cellReplacementYear) {
      currentBaseRevenue = secondPhaseRevenue;
      phaseStartYear = year;
      replacement = cellReplacementCost || 0;
    }

    const yearsInPhase = year - phaseStartYear;
    const yearRevenue =
      currentBaseRevenue * (1 - firstYearDecayRate) * ((1 - subsequentDecayRate) ** yearsInPhase);
    const netCashflow = yearRevenue - annualOmCost - replacement;
    cumulative += netCashflow;

    cashflows.push({
      year_index: year,
      year_revenue: round(yearRevenue, 2),
      annual_om_cost: round(annualOmCost, 2),
      cell_replacement_cost: round(replacement, 2),
      net_cashflow: round(netCashflow, 2),
      cumulative_net_cashflow: round(cumulative, 2),
    });
  }

  return cashflows;
};

const computeStaticPayback = (cashflows, capexTotal) => {
  if (capexTotal <= 0) return 0;

  let cumulative = 0;
  let prev = 0;
  for (const cf of cashflows) {
    prev = cumulative;
    cumulative += Number(cf.net_cashflow || 0);
    if (cumulative >= capexTotal) {
      const yearIndex = Number(cf.year_index || 0);
      const net = Number(cf.net_cashflow || 0);
      if (net > 0) {
        const shortfall = capexTotal - prev;
        return round(yearIndex - 1 + shortfall / net, 2);
      }
      return yearIndex;
    }
  }
  return null;
};

const irrByNewton = (values, maxIterations = 100, tolerance = 1e-6) => {
  let r = 0.1;

  const npv = (rate) => values.reduce((sum, cf, t) => sum + cf / ((1 + rate) ** t), 0);
  const der = (rate) => values.reduce((sum, cf, t) => {
    if (t === 0) return sum;
    return sum - (t * cf) / ((1 + rate) ** (t + 1));
  }, 0);

  for (let i = 0; i < maxIterations; i += 1) {
    const f = npv(r);
    if (Math.abs(f) < tolerance) return round(r, 6);
    const d = der(r);
    if (Math.abs(d) < 1e-12) break;
    let nr = r - (f / d);
    if (nr < -0.99) nr = -0.99;
    if (nr > 10) nr = 10;
    if (Math.abs(nr - r) < tolerance) return round(nr, 6);
    r = nr;
  }

  return null;
};

const irrByBisection = (values, maxIterations = 100, tolerance = 1e-6) => {
  const npv = (rate) => values.reduce((sum, cf, t) => sum + cf / ((1 + rate) ** t), 0);
  let low = -0.99;
  let high = 2.0;
  let fLow = npv(low);
  const fHighInit = npv(high);
  if (fLow * fHighInit > 0) return null;

  for (let i = 0; i < maxIterations; i += 1) {
    const mid = (low + high) / 2;
    const fMid = npv(mid);
    if (Math.abs(fMid) < tolerance) return round(mid, 6);
    if (fMid * fLow < 0) {
      high = mid;
    } else {
      low = mid;
      fLow = fMid;
    }
    if (Math.abs(high - low) < tolerance) return round((high + low) / 2, 6);
  }

  return null;
};

const computeIrr = (cashflows, capexTotal) => {
  if (!cashflows.length || capexTotal <= 0) return null;
  const values = [-capexTotal, ...cashflows.map((c) => Number(c.net_cashflow || 0))];
  return irrByNewton(values) ?? irrByBisection(values);
};

const computeStaticMetrics = ({
  cashflows,
  capexTotal,
  projectYears,
  firstYearEnergyKwh,
  firstYearDecayRate,
  subsequentDecayRate,
  passThreshold = 1.5,
}) => {
  if (!cashflows.length || capexTotal <= 0 || projectYears <= 0) {
    return {
      static_lcoe: 0,
      annual_energy_kwh: 0,
      annual_revenue_yuan: 0,
      revenue_per_kwh: 0,
      lcoe_ratio: 0,
      screening_result: 'fail',
      pass_threshold: passThreshold,
    };
  }

  const totalRevenue = cashflows.reduce((s, cf) => s + Number(cf.year_revenue || 0), 0);
  const annualRevenue = totalRevenue / projectYears;

  let annualEnergy = 0;
  if (Number.isFinite(Number(firstYearEnergyKwh)) && Number(firstYearEnergyKwh) > 0) {
    let current = Number(firstYearEnergyKwh);
    let totalEnergy = 0;
    for (let i = 1; i <= projectYears; i += 1) {
      totalEnergy += current;
      current *= i === 1 ? (1 - firstYearDecayRate) : (1 - subsequentDecayRate);
    }
    annualEnergy = totalEnergy / projectYears;
  } else {
    annualEnergy = annualRevenue;
  }

  const staticLcoe = annualEnergy > 0 ? capexTotal / (annualEnergy * projectYears) : 0;
  const revenuePerKwh = annualEnergy > 0 ? annualRevenue / annualEnergy : 0;
  const lcoeRatio = staticLcoe > 0 ? revenuePerKwh / staticLcoe : 0;

  return {
    static_lcoe: round(staticLcoe, 4),
    annual_energy_kwh: round(annualEnergy, 2),
    annual_revenue_yuan: round(annualRevenue, 2),
    revenue_per_kwh: round(revenuePerKwh, 4),
    lcoe_ratio: round(lcoeRatio, 4),
    screening_result: lcoeRatio >= passThreshold ? 'pass' : 'fail',
    pass_threshold: passThreshold,
  };
};

export const computeEconomics = (body) => {
  const firstYearRevenue = Number(body?.first_year_revenue);
  const projectYears = Number(body?.project_years);
  const annualOmCostUnit = Number(body?.annual_om_cost);
  const firstYearDecayRate = Number(body?.first_year_decay_rate);
  const subsequentDecayRate = Number(body?.subsequent_decay_rate);
  const capexPerWh = Number(body?.capex_per_wh);
  const installedCapacityKwh = Number(body?.installed_capacity_kwh);

  if (!Number.isFinite(firstYearRevenue) || firstYearRevenue <= 0) {
    throw new Error('first_year_revenue must be > 0');
  }
  if (!Number.isFinite(projectYears) || projectYears < 1 || projectYears > 50) {
    throw new Error('project_years must be in [1, 50]');
  }
  if (!Number.isFinite(capexPerWh) || capexPerWh <= 0) {
    throw new Error('capex_per_wh must be > 0');
  }
  if (!Number.isFinite(installedCapacityKwh) || installedCapacityKwh <= 0) {
    throw new Error('installed_capacity_kwh must be > 0');
  }

  const actualAnnualOmCost = (annualOmCostUnit * installedCapacityKwh) / 10;
  const actualCellReplacementCost =
    Number.isFinite(Number(body?.cell_replacement_cost)) && Number(body.cell_replacement_cost) > 0
      ? (Number(body.cell_replacement_cost) * installedCapacityKwh) / 10
      : null;

  const capexTotal = capexPerWh * installedCapacityKwh * 1000;

  const cashflows = buildCashflows({
    firstYearRevenue,
    projectYears,
    annualOmCost: actualAnnualOmCost,
    firstYearDecayRate,
    subsequentDecayRate,
    cellReplacementYear:
      Number.isFinite(Number(body?.cell_replacement_year)) && Number(body.cell_replacement_year) > 0
        ? Number(body.cell_replacement_year)
        : null,
    cellReplacementCost: actualCellReplacementCost,
    secondPhaseFirstYearRevenue:
      Number.isFinite(Number(body?.second_phase_first_year_revenue)) && Number(body.second_phase_first_year_revenue) > 0
        ? Number(body.second_phase_first_year_revenue)
        : null,
  });

  const irr = computeIrr(cashflows, capexTotal);
  const payback = computeStaticPayback(cashflows, capexTotal);
  const finalCumulative = cashflows.length ? Number(cashflows[cashflows.length - 1].cumulative_net_cashflow || 0) : 0;
  const staticMetrics = computeStaticMetrics({
    cashflows,
    capexTotal,
    projectYears,
    firstYearEnergyKwh: body?.first_year_energy_kwh,
    firstYearDecayRate,
    subsequentDecayRate,
  });

  return {
    capex_total: round(capexTotal, 2),
    irr,
    static_payback_years: payback,
    final_cumulative_net_cashflow: round(finalCumulative, 2),
    yearly_cashflows: cashflows,
    static_metrics: staticMetrics,
  };
};

export async function onRequestPost(context) {
  try {
    const body = await context.request.json();
    const result = computeEconomics(body || {});
    return new Response(JSON.stringify(result), {
      status: 200,
      headers: jsonHeaders,
    });
  } catch (error) {
    return new Response(JSON.stringify({ detail: `经济性计算失败: ${error?.message || 'unknown error'}` }), {
      status: 400,
      headers: jsonHeaders,
    });
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
