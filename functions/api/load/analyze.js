// Cloudflare Pages Function - 负荷分析 (修复版)
// 端点: /api/load/analyze
// 支持 GB2312/UTF-8 编码的 CSV 文件

export async function onRequestPost(context) {
  try {
    const { request } = context;
    const formData = await request.formData();
    const file = formData.get('file');

    if (!file) {
      return new Response(
        JSON.stringify({
          success: false,
          detail: "No file provided"
        }),
        {
          status: 400,
          headers: {
            'Content-Type': 'application/json',
            'Access-Control-Allow-Origin': '*'
          }
        }
      );
    }

    // 读取文件内容
    const fileBuffer = await file.arrayBuffer();
    const fileContent = new TextDecoder('utf-8').decode(fileBuffer);

    // 尝试检测并处理编码（如果 UTF-8 失败，尝试 GBK）
    let lines = fileContent.split('\n').filter(line => line.trim());

    // 如果第一行乱码，尝试 GBK 解码
    if (lines[0] && lines[0].includes('����')) {
      try {
        const gbkDecoder = new TextDecoder('gbk');
        const gbkContent = gbkDecoder.decode(fileBuffer);
        lines = gbkContent.split('\n').filter(line => line.trim());
      } catch (e) {
        // GBK 解码失败，继续使用 UTF-8
      }
    }

    // 解析 CSV
    const points = [];
    let nullCount = 0;
    let negativeCount = 0;
    let zeroCount = 0;

    // 跳过标题行，从第2行开始解析
    for (let i = 1; i < lines.length; i++) {
      let line = lines[i].trim();
      if (!line) continue;

      // 简单的 CSV 解析（处理引号内的逗号）
      // 注意：这只是一个简单的正则处理，对于极复杂的 CSV (如引号内有换行) 可能不够，但在 Serverless 环境够用
      const parts = line.match(/(".*?"|[^",\s]+)(?=\s*,|\s*$)/g);

      // Fallback: 如果正则失败（例如无引号简单 CSV），直接 split
      const items = parts ? parts.map(s => s.replace(/^"|"$/g, '').trim()) : line.split(',').map(s => s.trim());

      if (items.length < 2) continue;

      let timestamp;
      let loadValue;

      // 尝试推断列结构
      if (items.length >= 3) {
        // 假设: Date, Time, Load (原有格式)
        // 或者是: ID, Timestamp, Load? 
        // 优先尝试最后两列或第一二列合并?
        // 安全起见，保持原有 Date, Time 逻辑，但也尝试检测 Timestamp 在第一列的情况

        const col0 = items[0];
        const col1 = items[1];
        const col2 = items[2];

        // 检查 col0 是否看起来像完整时间 (包含 : 和 -/DoS)
        const col0IsTimestamp = (col0.includes('-') || col0.includes('/')) && col0.includes(':');

        if (col0IsTimestamp && !isNaN(parseFloat(col1))) {
          // 格式: Timestamp, Load, Other...
          timestamp = col0;
          loadValue = parseFloat(col1);
        } else {
          // 格式: Date, Time, Load...
          timestamp = `${col0} ${col1}`;
          loadValue = parseFloat(col2);
        }
      } else {
        // 2 列: Timestamp, Load
        timestamp = items[0];
        loadValue = parseFloat(items[1]);
      }

      // 统计质量问题
      if (isNaN(loadValue)) {
        nullCount++;
        continue;
      }
      if (loadValue < 0) negativeCount++;
      if (loadValue === 0) zeroCount++;

      points.push({
        timestamp: timestamp,
        load_kw: loadValue
      });
    }

    // 计算统计数据
    const loads = points.map(p => p.load_kw);
    const avgLoad = loads.length > 0 ? loads.reduce((a, b) => a + b, 0) / loads.length : 0;
    const maxLoad = loads.length > 0 ? Math.max(...loads) : 0;
    const minLoad = loads.length > 0 ? Math.min(...loads) : 0;
    const totalKwh = avgLoad * 24; // 假设一天的数据

    // 返回前端期望的格式
    return new Response(
      JSON.stringify({
        success: true,
        meta: {
          filename: file.name,
          total_rows: lines.length - 1,
          parsed_rows: points.length,
          encoding: lines[0]?.includes('����') ? 'gbk' : 'utf-8'
        },
        quality_report: {
          null_count: nullCount,
          negative_count: negativeCount,
          zero_count: zeroCount,
          completeness_rate: points.length / (lines.length - 1)
        },
        points: points.slice(0, 1000), // 限制返回数量
        statistics: {
          avg_load: Math.round(avgLoad * 100) / 100,
          max_load: Math.round(maxLoad * 100) / 100,
          min_load: Math.round(minLoad * 100) / 100,
          total_kwh: Math.round(totalKwh * 100) / 100
        }
      }),
      {
        status: 200,
        headers: {
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*'
        }
      }
    );
  } catch (error) {
    console.error('Load analysis error:', error);
    return new Response(
      JSON.stringify({
        success: false,
        detail: `Load analysis failed: ${error.message}`
      }),
      {
        status: 500,
        headers: {
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*'
        }
      }
    );
  }
}

export async function onRequestOptions() {
  return new Response(null, {
    status: 204,
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type'
    }
  });
}
