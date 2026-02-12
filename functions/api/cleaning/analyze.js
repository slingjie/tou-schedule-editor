// Cloudflare Pages Function - 数据清洗分析
// 端点: /api/cleaning/analyze

export async function onRequestPost(context) {
  try {
    const { request } = context;
    const data = await request.json();
    
    const points = data.points || [];
    const config = data.config || {};
    
    // 简化的清洗分析
    const nullPoints = points.filter(p => p.load_kw == null);
    const negativePoints = points.filter(p => p.load_kw < 0);
    const zeroPoints = points.filter(p => p.load_kw === 0);
    
    return new Response(
      JSON.stringify({
        success: true,
        analysis: {
          total_points: points.length,
          null_count: nullPoints.length,
          negative_count: negativePoints.length,
          zero_count: zeroPoints.length,
          issues: [
            ...(nullPoints.length > 0 ? [{type: 'null', count: nullPoints.length}] : []),
            ...(negativePoints.length > 0 ? [{type: 'negative', count: negativePoints.length}] : []),
            ...(zeroPoints.length > 0 ? [{type: 'zero', count: zeroPoints.length}] : [])
          ]
        },
        suggestions: {
          interpolation: nullPoints.length > 0,
          negative_handling: negativePoints.length > 0,
          zero_handling: zeroPoints.length > 0
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
    return new Response(
      JSON.stringify({ success: false, detail: error.message }),
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
