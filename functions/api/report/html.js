// Cloudflare Pages Function - 报告 HTML 预览
// 端点: /api/report/html

const htmlHeaders = {
  'Content-Type': 'text/html; charset=utf-8',
  'Access-Control-Allow-Origin': '*',
};

const jsonHeaders = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': '*',
};

const esc = (value) => String(value ?? '')
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;')
  .replace(/'/g, '&#39;');

const listHtml = (items) => {
  const arr = Array.isArray(items) ? items.filter((x) => String(x || '').trim()) : [];
  if (!arr.length) return '<li>暂无</li>';
  return arr.map((x) => `<li>${esc(x)}</li>`).join('');
};

const chartImg = (title, dataUrl) => {
  const src = String(dataUrl || '');
  if (!src.startsWith('data:image/')) {
    return `<div class="chart"><h4>${esc(title)}</h4><p class="muted">无图像数据</p></div>`;
  }
  return `<div class="chart"><h4>${esc(title)}</h4><img src="${src}" alt="${esc(title)}" /></div>`;
};

const buildHtml = (reportData) => {
  const meta = reportData?.meta || {};
  const narrative = reportData?.narrative || {};
  const completeness = reportData?.completeness || {};
  const storage = reportData?.storage || {};
  const charts = reportData?.charts || {};

  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${esc(meta.project_name || '项目评估报告')}</title>
  <style>
    body { font-family: -apple-system,BlinkMacSystemFont,'Segoe UI','PingFang SC','Hiragino Sans GB','Microsoft YaHei',sans-serif; margin: 24px; color:#0f172a; }
    h1,h2,h3,h4 { margin: 0 0 10px; }
    .muted { color:#475569; }
    .card { border:1px solid #e2e8f0; border-radius:12px; padding:16px; margin-bottom:16px; }
    .grid { display:grid; grid-template-columns:repeat(auto-fit,minmax(280px,1fr)); gap:12px; }
    .chart img { width:100%; border:1px solid #e2e8f0; border-radius:8px; }
    ul { margin: 8px 0 0 20px; }
    table { width:100%; border-collapse: collapse; }
    td,th { border:1px solid #e2e8f0; padding:8px; font-size:13px; }
    th { background:#f8fafc; text-align:left; }
  </style>
</head>
<body>
  <h1>${esc(meta.project_name || '项目评估报告')}</h1>
  <p class="muted">报告版本 ${esc(meta.report_version || 'v3.0')} · 生成时间 ${esc(meta.generated_at || '')}</p>

  <div class="card">
    <h3>项目信息</h3>
    <table>
      <tr><th>项目名称</th><td>${esc(meta.project_name || '')}</td><th>评估周期</th><td>${esc(meta.period_start || '')} ~ ${esc(meta.period_end || '')}</td></tr>
      <tr><th>业主</th><td>${esc(meta.owner_name || '')}</td><th>位置</th><td>${esc(meta.project_location || '')}</td></tr>
      <tr><th>作者机构</th><td>${esc(meta.author_org || '')}</td><th>总投资</th><td>${esc(meta.total_investment_wanyuan || '')} 万元</td></tr>
    </table>
  </div>

  <div class="card">
    <h3>完整性检查</h3>
    <p class="muted">缺失项将影响结论可靠性。</p>
    <ul>${listHtml(completeness.missing_items)}</ul>
  </div>

  <div class="card">
    <h3>储能测算摘要</h3>
    <table>
      <tr><th>首年净收益</th><td>${esc(storage?.kpis?.first_year_revenue_text || storage?.firstYearRevenue || '')}</td></tr>
      <tr><th>全年等效循环</th><td>${esc(storage?.kpis?.equivalent_cycles_text || storage?.dailyCycles || '')}</td></tr>
      <tr><th>利用小时</th><td>${esc(storage?.kpis?.utilization_hours_text || storage?.utilizationHoursRange || '')}</td></tr>
    </table>
  </div>

  <div class="card">
    <h3>分析结论</h3>
    <p>${esc(narrative.summary || '暂无摘要')}</p>
    <p><strong>结论：</strong>${esc(narrative.conclusion || '暂无结论')}</p>
    <div class="grid">
      <div>
        <h4>主要风险</h4>
        <ul>${listHtml(narrative.risks)}</ul>
      </div>
      <div>
        <h4>建议</h4>
        <ul>${listHtml(narrative.suggestions)}</ul>
      </div>
    </div>
  </div>

  <div class="card">
    <h3>图表</h3>
    <div class="grid">
      ${chartImg('电价 24h', charts.price_24h_png)}
      ${chartImg('策略 24h', charts.strategy_24h_png)}
      ${chartImg('典型日负荷', charts.load_typical_png)}
      ${chartImg('月度分布', charts.load_monthly_distribution_png)}
      ${chartImg('负荷电价叠加', charts.load_price_overlay_png)}
      ${chartImg('容量对比', charts.capacity_compare_png)}
      ${chartImg('现金流', charts.cashflow_png)}
      ${chartImg('最佳收益日曲线', charts.best_profit_day_overlay_png)}
      ${chartImg('最大负荷日曲线', charts.max_load_day_overlay_png)}
    </div>
  </div>
</body>
</html>`;
};

export async function onRequestPost(context) {
  try {
    const body = await context.request.json();
    const reportData = body?.report_data || {};
    const html = buildHtml(reportData);
    return new Response(html, { status: 200, headers: htmlHeaders });
  } catch (error) {
    return new Response(JSON.stringify({ detail: error?.message || 'report html failed' }), {
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
