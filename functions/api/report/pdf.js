// Cloudflare Pages Function - 报告 PDF 导出（轻量文本版）
// 端点: /api/report/pdf

const jsonHeaders = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': '*',
};

const toAscii = (value) => String(value ?? '').replace(/[^\x20-\x7E]/g, '?');

const escapePdfText = (value) => toAscii(value).replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');

const buildSimplePdf = (lines) => {
  const safeLines = Array.isArray(lines) ? lines.slice(0, 42) : [];
  const contentLines = [];
  contentLines.push('BT');
  contentLines.push('/F1 11 Tf');
  contentLines.push('50 790 Td');

  let first = true;
  for (const line of safeLines) {
    if (!first) contentLines.push('T*');
    contentLines.push(`(${escapePdfText(line)}) Tj`);
    first = false;
  }
  contentLines.push('ET');

  const stream = contentLines.join('\n');

  const objs = [];
  objs.push('1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj');
  objs.push('2 0 obj << /Type /Pages /Kids [3 0 R] /Count 1 >> endobj');
  objs.push('3 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >> endobj');
  objs.push('4 0 obj << /Type /Font /Subtype /Type1 /BaseFont /Courier >> endobj');
  objs.push(`5 0 obj << /Length ${stream.length} >> stream\n${stream}\nendstream endobj`);

  let pdf = '%PDF-1.4\n';
  const offsets = [0];
  for (const obj of objs) {
    offsets.push(pdf.length);
    pdf += `${obj}\n`;
  }
  const xrefStart = pdf.length;
  pdf += `xref\n0 ${objs.length + 1}\n`;
  pdf += '0000000000 65535 f \n';
  for (let i = 1; i <= objs.length; i += 1) {
    pdf += `${String(offsets[i]).padStart(10, '0')} 00000 n \n`;
  }
  pdf += `trailer << /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF`;

  return new Uint8Array([...pdf].map((ch) => ch.charCodeAt(0)));
};

const buildLines = (reportData) => {
  const meta = reportData?.meta || {};
  const narrative = reportData?.narrative || {};
  const completeness = reportData?.completeness || {};
  const missing = Array.isArray(completeness?.missing_items) ? completeness.missing_items : [];

  return [
    'TOU Schedule Project Report (Text PDF)',
    '--------------------------------------',
    `Project: ${meta.project_name || ''}`,
    `Period : ${meta.period_start || ''} ~ ${meta.period_end || ''}`,
    `Owner  : ${meta.owner_name || ''}`,
    `Place  : ${meta.project_location || ''}`,
    `Org    : ${meta.author_org || ''}`,
    `Generated: ${meta.generated_at || new Date().toISOString()}`,
    '',
    'Summary:',
    String(narrative.summary || ''),
    '',
    'Conclusion:',
    String(narrative.conclusion || ''),
    '',
    'Risks:',
    ...(Array.isArray(narrative.risks) && narrative.risks.length ? narrative.risks.map((x) => `- ${x}`) : ['- N/A']),
    '',
    'Suggestions:',
    ...(Array.isArray(narrative.suggestions) && narrative.suggestions.length
      ? narrative.suggestions.map((x) => `- ${x}`)
      : ['- N/A']),
    '',
    'Missing Items:',
    ...(missing.length ? missing.map((x) => `- ${x}`) : ['- None']),
  ];
};

export async function onRequestPost(context) {
  try {
    const body = await context.request.json();
    const reportData = body?.report_data || {};
    const lines = buildLines(reportData);
    const pdfBytes = buildSimplePdf(lines);

    const projectName = toAscii(reportData?.meta?.project_name || 'project');
    const filename = `${projectName}_report.pdf`.replace(/[^a-zA-Z0-9_.-]/g, '_');

    return new Response(pdfBytes, {
      status: 200,
      headers: {
        'Content-Type': 'application/pdf',
        'Content-Disposition': `attachment; filename="${filename}"`,
        'Access-Control-Allow-Origin': '*',
      },
    });
  } catch (error) {
    return new Response(JSON.stringify({ detail: error?.message || 'report pdf failed' }), {
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
