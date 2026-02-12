// Cloudflare Pages Function - 负荷分析 (修复版)
// 端点: /api/load/analyze
// 支持 GB2312/UTF-8 编码的 CSV 文件

const jsonHeaders = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': '*',
}

const toDayKey = (d) => {
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

const toMonthKey = (d) => {
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  return `${y}-${m}`
}

const toHourKey = (d) => {
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  const h = String(d.getHours()).padStart(2, '0')
  return `${y}-${m}-${day} ${h}`
}

const startOfDay = (d) => {
  const x = new Date(d)
  x.setHours(0, 0, 0, 0)
  return x
}

const startOfHour = (d) => {
  const x = new Date(d)
  x.setMinutes(0, 0, 0)
  return x
}

const addDays = (d, n) => {
  const x = new Date(d)
  x.setDate(x.getDate() + n)
  return x
}

const parseTimestamp = (value) => {
  if (value == null) return null
  let s = String(value).trim()
  if (!s) return null
  if (s.includes('/')) s = s.replace(/\//g, '-')
  if (/^\d{4}-\d{1,2}-\d{1,2}$/.test(s)) {
    s = `${s}T00:00:00`
  } else if (/^\d{4}-\d{1,2}-\d{1,2}\s+\d{1,2}:\d{1,2}(:\d{1,2})?$/.test(s)) {
    s = s.replace(' ', 'T')
  }
  const d = new Date(s)
  return Number.isNaN(d.getTime()) ? null : d
}

const inferIntervalMinutes = (dates) => {
  if (!Array.isArray(dates) || dates.length < 2) return 0
  const sorted = dates.slice().sort((a, b) => a.getTime() - b.getTime())
  const diffs = []
  for (let i = 1; i < sorted.length; i += 1) {
    const mins = (sorted[i].getTime() - sorted[i - 1].getTime()) / 60000
    if (mins > 0 && Number.isFinite(mins) && mins <= 24 * 60) {
      diffs.push(mins)
    }
  }
  if (diffs.length === 0) return 0
  diffs.sort((a, b) => a - b)
  return Math.round(diffs[Math.floor(diffs.length / 2)])
}

const buildMissingReport = (dates) => {
  if (!Array.isArray(dates) || dates.length === 0) {
    return {
      missing_days: [],
      missing_hours_by_month: [],
      partial_missing_days: [],
      summary: {
        total_missing_days: 0,
        total_missing_hours: 0,
        total_partial_missing_days: 0,
        expected_days: 365,
        actual_days: 0,
        completeness_ratio: 0,
      },
    }
  }

  const hourMap = new Map()
  for (const d of dates) {
    const h = startOfHour(d)
    hourMap.set(toHourKey(h), h)
  }
  const hourDates = [...hourMap.values()].sort((a, b) => a.getTime() - b.getTime())
  if (hourDates.length === 0) {
    return {
      missing_days: [],
      missing_hours_by_month: [],
      partial_missing_days: [],
      summary: {
        total_missing_days: 0,
        total_missing_hours: 0,
        total_partial_missing_days: 0,
        expected_days: 365,
        actual_days: 0,
        completeness_ratio: 0,
      },
    }
  }

  const presentHoursSet = new Set(hourMap.keys())
  const presentDaysSet = new Set(hourDates.map((d) => toDayKey(startOfDay(d))))

  const endDay = startOfDay(hourDates[hourDates.length - 1])
  const startDay = addDays(endDay, -364)

  const missingDays = []
  const partialMissingDays = []
  const monthStats = new Map()
  let totalMissingHours = 0
  let actualDays = 0

  for (let i = 0; i < 365; i += 1) {
    const day = addDays(startDay, i)
    const dayKey = toDayKey(day)
    const monthKey = toMonthKey(day)
    if (!monthStats.has(monthKey)) {
      monthStats.set(monthKey, { missing_days: 0, missing_hours: 0 })
    }

    if (presentDaysSet.has(dayKey)) actualDays += 1

    let presentCount = 0
    for (let h = 0; h < 24; h += 1) {
      const hour = new Date(day)
      hour.setHours(h, 0, 0, 0)
      if (presentHoursSet.has(toHourKey(hour))) {
        presentCount += 1
      }
    }

    const missingCount = 24 - presentCount
    if (presentCount === 0) {
      missingDays.push(dayKey)
      monthStats.get(monthKey).missing_days += 1
    } else if (missingCount > 0) {
      partialMissingDays.push({
        date: dayKey,
        present_hours: presentCount,
        missing_hours: missingCount,
      })
    }

    monthStats.get(monthKey).missing_hours += missingCount
    totalMissingHours += missingCount
  }

  const missingHoursByMonth = [...monthStats.entries()]
    .filter(([, stat]) => stat.missing_hours > 0)
    .map(([month, stat]) => ({
      month,
      missing_days: stat.missing_days,
      missing_hours: stat.missing_hours,
    }))

  return {
    missing_days: missingDays,
    missing_hours_by_month: missingHoursByMonth,
    partial_missing_days: partialMissingDays,
    summary: {
      total_missing_days: missingDays.length,
      total_missing_hours: totalMissingHours,
      total_partial_missing_days: partialMissingDays.length,
      expected_days: 365,
      actual_days: actualDays,
      completeness_ratio: Number((actualDays / 365).toFixed(4)),
    },
  }
}

export async function onRequestPost(context) {
  try {
    const { request } = context;
    const formData = await request.formData();
    const file = formData.get('file');

    if (!file) {
      return new Response(
        JSON.stringify({
          success: false,
          detail: 'No file provided',
        }),
        {
          status: 400,
          headers: jsonHeaders,
        },
      )
    }

    // 读取文件内容
    const fileBuffer = await file.arrayBuffer();
    const fileContent = new TextDecoder('utf-8').decode(fileBuffer);

    // 尝试检测并处理编码（如果 UTF-8 失败，尝试 GBK）
    let encoding = 'utf-8'
    let lines = fileContent.split('\n').filter(line => line.trim());

    // 如果第一行乱码，尝试 GBK 解码
    if (lines[0] && lines[0].includes('����')) {
      try {
        const gbkDecoder = new TextDecoder('gbk');
        const gbkContent = gbkDecoder.decode(fileBuffer);
        lines = gbkContent.split('\n').filter(line => line.trim());
        encoding = 'gbk'
      } catch (e) {
        // GBK 解码失败，继续使用 UTF-8
      }
    }

    // 解析 CSV
    const points = [];
    let nullCount = 0;
    let negativeCount = 0;
    let zeroCount = 0;
    const parsedDates = []

    // 跳过标题行，从第2行开始解析
    for (let i = 1; i < lines.length; i++) {
      let line = lines[i].trim();
      if (!line) continue;

      // CSV 解析：直接按逗号分割，然后去除引号和空白
      // 使用 split(',') 作为主要解析方式，简单可靠，能正确保留时间戳中的空格
      const items = line.split(',').map(s => s.trim().replace(/^"|"$/g, ''));

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

      const parsedDate = parseTimestamp(timestamp)

      // 统计质量问题
      if (isNaN(loadValue) || !parsedDate) {
        nullCount++;
        continue;
      }
      if (loadValue < 0) negativeCount++;
      if (loadValue === 0) zeroCount++;


      parsedDates.push(parsedDate)
      points.push({
        timestamp: parsedDate.toISOString(),
        load_kwh: loadValue,
        __ts: parsedDate.getTime(),
      })
    }

    points.sort((a, b) => a.__ts - b.__ts)
    const cleanedPoints = points.map((p) => ({
      timestamp: p.timestamp,
      load_kwh: p.load_kwh,
    }))

    const missingReport = buildMissingReport(parsedDates)
    const sourceIntervalMinutes = inferIntervalMinutes(parsedDates)

    // 计算统计数据
    const loads = cleanedPoints.map(p => p.load_kwh);
    const avgLoad = loads.length > 0 ? loads.reduce((a, b) => a + b, 0) / loads.length : 0;
    const maxLoad = loads.length > 0 ? Math.max(...loads) : 0;
    const minLoad = loads.length > 0 ? Math.min(...loads) : 0;
    const intervalMinutes = sourceIntervalMinutes > 0 ? sourceIntervalMinutes : 15
    const totalKwh = loads.reduce((sum, x) => sum + x * (intervalMinutes / 60), 0)

    // 返回前端期望的格式
    return new Response(
      JSON.stringify({
        success: true,
        meta: {
          filename: file.name,
          total_rows: lines.length - 1,
          parsed_rows: cleanedPoints.length,
          encoding,
          // 补充 frontend 需要的字段
          source_interval_minutes: sourceIntervalMinutes,
          total_records: cleanedPoints.length,
          start: cleanedPoints[0]?.timestamp || null,
          end: cleanedPoints[cleanedPoints.length - 1]?.timestamp || null,
        },
        report: {
          missing: missingReport,
          anomalies: [
            { kind: 'null', count: nullCount, ratio: nullCount / (lines.length - 1 || 1), samples: [] },
            { kind: 'negative', count: negativeCount, ratio: negativeCount / (lines.length - 1 || 1), samples: [] },
            { kind: 'zero', count: zeroCount, ratio: zeroCount / (lines.length - 1 || 1), samples: [] }
          ],
          continuous_zero_spans: []
        },
        cleaned_points: cleanedPoints,
        statistics: {
          avg_load: Math.round(avgLoad * 100) / 100,
          max_load: Math.round(maxLoad * 100) / 100,
          min_load: Math.round(minLoad * 100) / 100,
          total_kwh: Math.round(totalKwh * 100) / 100
        }
      }),
      {
        status: 200,
        headers: jsonHeaders,
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
        headers: jsonHeaders,
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
