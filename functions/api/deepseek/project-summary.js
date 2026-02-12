// Cloudflare Pages Function - 项目评估摘要
// 端点: /api/deepseek/project-summary

const jsonHeaders = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': '*',
};

const esc = (value) => String(value ?? '').trim();

const buildMarkdown = (req) => {
  const title = esc(req?.project_name || '项目评估报告');
  const location = esc(req?.project_location || '未提供');
  const period = `${esc(req?.period_start || '')} ~ ${esc(req?.period_end || '')}`;
  const quality = req?.quality_report || {};
  const storage = req?.storage_results || {};

  const sections = [
    `# ${title}`,
    '',
    `- 项目位置：${location}`,
    `- 评估周期：${period}`,
    '',
    '## 结论摘要',
    esc(storage?.overallConclusion || '当前结果可用于初步评估，建议结合实际运行数据复核。'),
    '',
    '## 关键指标',
    `- 首年收益：${esc(storage?.firstYearRevenueDetail || '未提供')}`,
    `- 日均循环：${esc(storage?.dailyCycles || '未提供')}`,
    `- 利用小时：${esc(storage?.utilizationHoursRangeDetail || '未提供')}`,
    `- 数据完整度：${esc(quality?.loadMissingRateDescription || '未提供')}`,
    '',
    '## 建议',
    '- 建议持续采集完整负荷数据，并按季度复算收益与回收期。',
    '- 建议联动电价策略与储能调度策略，定期优化充放电时段。',
  ];

  return sections.join('\n');
};

export async function onRequestPost(context) {
  try {
    const req = await context.request.json();
    const projectName = esc(req?.project_name);
    const periodStart = esc(req?.period_start);
    const periodEnd = esc(req?.period_end);

    if (!projectName) {
      return new Response(JSON.stringify({ detail: 'project_name is required' }), {
        status: 400,
        headers: jsonHeaders,
      });
    }
    if (!periodStart || !periodEnd) {
      return new Response(JSON.stringify({ detail: 'period_start and period_end are required' }), {
        status: 400,
        headers: jsonHeaders,
      });
    }

    const markdown = buildMarkdown(req);
    const now = new Date().toISOString();
    const summary = {
      firstYearRevenue: esc(req?.storage_results?.firstYearRevenueDetail || ''),
      dailyCycles: esc(req?.storage_results?.dailyCycles || ''),
      utilizationHoursRange: esc(req?.storage_results?.utilizationHoursRangeDetail || ''),
      loadDataCompleteness: esc(req?.quality_report?.loadMissingRateDescription || ''),
      overallConclusion: esc(req?.storage_results?.overallConclusion || '请参考报告正文'),
    };

    return new Response(
      JSON.stringify({
        report_id: `report_${now.replace(/[-:.TZ]/g, '').slice(0, 14)}`,
        project_name: projectName,
        period_start: periodStart,
        period_end: periodEnd,
        generated_at: now,
        markdown,
        summary,
      }),
      { status: 200, headers: jsonHeaders },
    );
  } catch (error) {
    return new Response(JSON.stringify({ detail: `生成报告失败: ${error?.message || 'unknown error'}` }), {
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
