// Cloudflare Pages Function - 数据清洗应用
// 端点: /api/cleaning/apply
// 根据用户选择的清洗配置，对数据点进行清洗处理并返回清洗后的数据

export async function onRequestPost(context) {
    try {
        const { request } = context;
        const contentType = request.headers.get('content-type') || '';

        let points = [];
        let config = {};

        if (contentType.includes('multipart/form-data')) {
            const formData = await request.formData();
            const payloadStr = formData.get('payload');
            const file = formData.get('file');

            if (payloadStr) {
                try {
                    const payload = JSON.parse(payloadStr);
                    points = payload.points || [];
                    config = payload.config || {};
                } catch { /* ignore */ }
            }

            // 如果有文件，解析 CSV 提取数据点
            if (file && points.length === 0) {
                const fileBuffer = await file.arrayBuffer();
                let fileContent = new TextDecoder('utf-8').decode(fileBuffer);
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
            const data = await request.json();
            points = data.points || [];
            config = data.config || {};
        }

        const nullStrategy = config.null_strategy || 'interpolate';
        const negativeStrategy = config.negative_strategy || 'keep';
        const zeroDecisions = config.zero_decisions || {};

        let nullInterpolated = 0;
        let zeroKept = 0;
        let zeroInterpolated = 0;
        let negativeKept = 0;
        let negativeModified = 0;
        let interpolatedCount = 0;

        // 处理数据点
        const cleaned = points.map((p, idx) => {
            let load = p.load_kwh ?? p.load_kw;

            // 空值处理
            if (load == null || isNaN(load)) {
                if (nullStrategy === 'interpolate') {
                    // 简单线性插值：取前后最近非空值的平均
                    let prev = null, next = null;
                    for (let j = idx - 1; j >= 0; j--) {
                        const v = points[j].load_kwh ?? points[j].load_kw;
                        if (v != null && !isNaN(v)) { prev = v; break; }
                    }
                    for (let j = idx + 1; j < points.length; j++) {
                        const v = points[j].load_kwh ?? points[j].load_kw;
                        if (v != null && !isNaN(v)) { next = v; break; }
                    }
                    if (prev !== null && next !== null) {
                        load = (prev + next) / 2;
                    } else if (prev !== null) {
                        load = prev;
                    } else if (next !== null) {
                        load = next;
                    } else {
                        load = 0;
                    }
                    nullInterpolated++;
                    interpolatedCount++;
                } else if (nullStrategy === 'delete') {
                    return null; // 标记删除
                } else {
                    load = 0; // keep: 保留为 0
                }
            }

            // 负值处理
            if (load < 0) {
                if (negativeStrategy === 'abs') {
                    load = Math.abs(load);
                    negativeModified++;
                } else if (negativeStrategy === 'zero') {
                    load = 0;
                    negativeModified++;
                } else {
                    negativeKept++;
                }
            }

            return { timestamp: p.timestamp, load_kwh: load };
        }).filter(p => p !== null);

        // 返回符合 CleaningResultResponse 接口的响应
        return new Response(
            JSON.stringify({
                cleaned_points: cleaned,
                null_points_interpolated: nullInterpolated,
                zero_spans_kept: zeroKept,
                zero_spans_interpolated: zeroInterpolated,
                negative_points_kept: negativeKept,
                negative_points_modified: negativeModified,
                interpolated_count: interpolatedCount,
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
        console.error('Cleaning apply error:', error);
        return new Response(
            JSON.stringify({ success: false, detail: `Cleaning apply failed: ${error.message}` }),
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
