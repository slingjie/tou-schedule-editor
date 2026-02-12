// Cloudflare Pages Function - 数据清洗分析
// 端点: /api/cleaning/analyze
// 支持 FormData (含文件或 payload JSON) 和 application/json 两种请求格式

export async function onRequestPost(context) {
  try {
    const { request } = context;
    const contentType = request.headers.get('content-type') || '';

    let points = [];

    if (contentType.includes('multipart/form-data')) {
      // 前端 storageApi.ts 使用 FormData 发送
      const formData = await request.formData();
      const payloadStr = formData.get('payload');
      const file = formData.get('file');

      if (payloadStr) {
        try {
          const payload = JSON.parse(payloadStr);
          points = payload.points || [];
        } catch { /* ignore */ }
      }

      // 如果有文件，解析 CSV 提取数据点
      if (file && points.length === 0) {
        const fileBuffer = await file.arrayBuffer();
        let fileContent = new TextDecoder('utf-8').decode(fileBuffer);
        // 尝试 GBK
        if (fileContent.includes('����')) {
          try {
            fileContent = new TextDecoder('gbk').decode(fileBuffer);
          } catch { /* keep utf-8 */ }
        }
        const lines = fileContent.split('\n').filter(l => l.trim());
        for (let i = 1; i < lines.length; i++) {
          const items = lines[i].split(',').map(s => s.trim().replace(/^"|"$/g, ''));
          if (items.length < 2) continue;
          let timestamp, loadValue;
          if (items.length >= 3) {
            const col0 = items[0];
            const col0IsTimestamp = (col0.includes('-') || col0.includes('/')) && col0.includes(':');
            if (col0IsTimestamp && !isNaN(parseFloat(items[1]))) {
              timestamp = col0;
              loadValue = parseFloat(items[1]);
            } else {
              timestamp = `${col0} ${items[1]}`;
              loadValue = parseFloat(items[2]);
            }
          } else {
            timestamp = items[0];
            loadValue = parseFloat(items[1]);
          }
          points.push({ timestamp, load_kwh: isNaN(loadValue) ? null : loadValue });
        }
      }
    } else {
      // 直接 JSON 请求
      const data = await request.json();
      points = data.points || [];
    }

    // 分析数据质量
    let nullCount = 0;
    let zeroCount = 0;
    let negativeCount = 0;
    const zeroSpans = [];
    const negativeSpans = [];

    let currentZeroStart = null;
    let currentZeroCount = 0;

    for (let i = 0; i < points.length; i++) {
      const p = points[i];
      const load = p.load_kwh ?? p.load_kw;

      if (load == null || isNaN(load)) {
        nullCount++;
        // 结束零值段
        if (currentZeroStart !== null && currentZeroCount >= 4) {
          zeroSpans.push({
            id: `zero_${zeroSpans.length + 1}`,
            start_time: currentZeroStart,
            end_time: points[i - 1]?.timestamp || currentZeroStart,
            duration_hours: currentZeroCount * 0.25,
            point_count: currentZeroCount,
            weekday: '',
            month: 0,
            prev_day_avg_load: null,
            next_day_avg_load: null,
            prev_month_same_day_load: null,
            next_month_same_day_load: null,
          });
        }
        currentZeroStart = null;
        currentZeroCount = 0;
        continue;
      }
      if (load < 0) {
        negativeCount++;
      }
      if (load === 0) {
        zeroCount++;
        if (currentZeroStart === null) {
          currentZeroStart = p.timestamp;
        }
        currentZeroCount++;
      } else {
        // 结束零值段
        if (currentZeroStart !== null && currentZeroCount >= 4) {
          zeroSpans.push({
            id: `zero_${zeroSpans.length + 1}`,
            start_time: currentZeroStart,
            end_time: points[i - 1]?.timestamp || currentZeroStart,
            duration_hours: currentZeroCount * 0.25,
            point_count: currentZeroCount,
            weekday: '',
            month: 0,
            prev_day_avg_load: null,
            next_day_avg_load: null,
            prev_month_same_day_load: null,
            next_month_same_day_load: null,
          });
        }
        currentZeroStart = null;
        currentZeroCount = 0;
      }
    }
    // 处理末尾的零值段
    if (currentZeroStart !== null && currentZeroCount >= 4) {
      zeroSpans.push({
        id: `zero_${zeroSpans.length + 1}`,
        start_time: currentZeroStart,
        end_time: points[points.length - 1]?.timestamp || currentZeroStart,
        duration_hours: currentZeroCount * 0.25,
        point_count: currentZeroCount,
        weekday: '',
        month: 0,
        prev_day_avg_load: null,
        next_day_avg_load: null,
        prev_month_same_day_load: null,
        next_month_same_day_load: null,
      });
    }

    // 返回符合 CleaningAnalysisResponse 接口的响应
    return new Response(
      JSON.stringify({
        null_point_count: nullCount,
        null_hours: nullCount * 0.25,
        null_spans: [],
        zero_spans: zeroSpans,
        total_zero_hours: zeroCount * 0.25,
        negative_spans: [],
        total_negative_points: negativeCount,
        total_expected_points: points.length,
        total_actual_points: points.length - nullCount,
        completeness_ratio: points.length > 0 ? (points.length - nullCount) / points.length : 1,
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
    console.error('Cleaning analysis error:', error);
    return new Response(
      JSON.stringify({ success: false, detail: `Cleaning analysis failed: ${error.message}` }),
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
