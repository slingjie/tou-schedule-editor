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
      const line = lines[i].trim();
      if (!line) continue;
      
      // 分割 CSV 字段（处理逗号分隔）
      const parts = line.split(',');
      if (parts.length < 3) continue;
      
      const dateStr = parts[0]?.trim();
      const timeStr = parts[1]?.trim();
      const loadValue = parseFloat(parts[2]?.trim());
      
      // 构建时间戳
      const timestamp = `${dateStr} ${timeStr}`;
      
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
