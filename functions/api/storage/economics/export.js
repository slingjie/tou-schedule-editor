// Cloudflare Pages Function - 储能经济性报表导出
// 端点: /api/storage/economics/export

import { computeEconomics } from '../economics.js';

const jsonHeaders = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': '*',
};

const toCsvCell = (value) => {
  const raw = String(value ?? '');
  const escaped = raw.replace(/"/g, '""');
  if (/[",\n\r]/.test(escaped)) return `"${escaped}"`;
  return escaped;
};

const makeCsv = (rows) => rows.map((row) => row.map(toCsvCell).join(',')).join('\n');

const toBase64 = (text) => {
  const bytes = new TextEncoder().encode(text);
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
};

const buildEnergySeries = (
  firstYearEnergyKwh,
  projectYears,
  firstYearDecayRate,
  subsequentDecayRate,
  cellReplacementYear,
) => {
  if (!Number.isFinite(Number(firstYearEnergyKwh)) || Number(firstYearEnergyKwh) <= 0) return [];
  const out = [];
  let baseEnergy = Number(firstYearEnergyKwh);
  let phaseStartYear = 1;
  for (let year = 1; year <= projectYears; year += 1) {
    if (cellReplacementYear && year === cellReplacementYear) {
      baseEnergy = Number(firstYearEnergyKwh);
      phaseStartYear = year;
    }
    const yearsInPhase = year - phaseStartYear;
    const val = baseEnergy * (1 - firstYearDecayRate) * ((1 - subsequentDecayRate) ** yearsInPhase);
    out.push(val);
  }
  return out;
};

export async function onRequestPost(context) {
  try {
    const body = await context.request.json();
    const userSharePercent = Math.min(Math.max(Number(body?.user_share_percent || 0), 0), 100);
    const payload = { ...(body || {}) };
    delete payload.user_share_percent;

    const result = computeEconomics(payload);

    const shareRatio = userSharePercent / 100;
    const projectYears = Number(payload.project_years || 0);
    const firstYearDecayRate = Number(payload.first_year_decay_rate || 0);
    const subsequentDecayRate = Number(payload.subsequent_decay_rate || 0);
    const cellReplacementYear = Number.isFinite(Number(payload.cell_replacement_year))
      ? Number(payload.cell_replacement_year)
      : null;

    const energySeries = buildEnergySeries(
      payload.first_year_energy_kwh,
      projectYears,
      firstYearDecayRate,
      subsequentDecayRate,
      cellReplacementYear,
    );

    const cashflowRows = [
      ['年份', '原年度总收益(元)', '用户方年度收益(元)', '项目方年度收益(元)', '储能放电量(kWh)', '运维成本(元)', '电芯更换成本(元)', '年度净现金流(元)', '累计净现金流(元)'],
    ];

    for (let i = 0; i < result.yearly_cashflows.length; i += 1) {
      const item = result.yearly_cashflows[i];
      const projectRevenue = Number(item.year_revenue || 0);
      const totalRevenue = shareRatio < 1 ? projectRevenue / (1 - shareRatio) : projectRevenue;
      const userRevenue = totalRevenue * shareRatio;
      const dischargeKwh = energySeries[i] || 0;
      cashflowRows.push([
        item.year_index,
        totalRevenue.toFixed(2),
        userRevenue.toFixed(2),
        projectRevenue.toFixed(2),
        dischargeKwh.toFixed(2),
        Number(item.annual_om_cost || 0).toFixed(2),
        Number(item.cell_replacement_cost || 0).toFixed(2),
        Number(item.net_cashflow || 0).toFixed(2),
        Number(item.cumulative_net_cashflow || 0).toFixed(2),
      ]);
    }

    const summaryRows = [
      ['指标名称', '数值', '单位'],
      ['总投资(CAPEX)', Number(result.capex_total || 0).toFixed(2), '元'],
      ['内部收益率(IRR)', result.irr == null ? '无法收敛' : `${(Number(result.irr) * 100).toFixed(2)}%`, '-'],
      ['静态回收期', result.static_payback_years == null ? '超出项目周期' : `${Number(result.static_payback_years).toFixed(2)}年`, '-'],
      ['项目末累计净现金流', Number(result.final_cumulative_net_cashflow || 0).toFixed(2), '元'],
      ['静态平均度电成本(LCOE)', Number(result.static_metrics?.static_lcoe || 0).toFixed(4), '元/kWh'],
      ['年均发电能量', Number(result.static_metrics?.annual_energy_kwh || 0).toFixed(2), 'kWh'],
      ['年均收益', Number(result.static_metrics?.annual_revenue_yuan || 0).toFixed(2), '元'],
      ['度电平均收益', Number(result.static_metrics?.revenue_per_kwh || 0).toFixed(4), '元/kWh'],
      ['经济可行性比值', Number(result.static_metrics?.lcoe_ratio || 0).toFixed(4), '-'],
      ['筛选结论', String(result.static_metrics?.screening_result || ''), '-'],
    ];

    const csvContent = `${makeCsv(cashflowRows)}\n\n${makeCsv(summaryRows)}\n`;
    const fileName = `economics_cashflow_${new Date().toISOString().replace(/[:.]/g, '').slice(0, 15)}.csv`;

    return new Response(
      JSON.stringify({
        excel_path: fileName,
        message: '报表生成成功（CSV）',
        file_name: fileName,
        mime_type: 'text/csv;charset=utf-8',
        file_content_base64: toBase64(`\uFEFF${csvContent}`),
      }),
      {
        status: 200,
        headers: jsonHeaders,
      },
    );
  } catch (error) {
    return new Response(
      JSON.stringify({ detail: `报表生成失败: ${error?.message || 'unknown error'}` }),
      {
        status: 400,
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
