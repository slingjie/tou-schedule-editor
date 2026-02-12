// Cloudflare Pages Function - 数据分析
export async function onRequestPost(context) {
  try {
    const { request } = context;
    const data = await request.json();
    
    // 简化的数据分析逻辑
    const prices = data.prices || [];
    const timeSlots = data.time_slots || [];
    
    if (prices.length === 0) {
      return new Response(
        JSON.stringify({
          success: false,
          message: "No price data provided"
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
    
    // 基础统计计算
    const avgPrice = prices.reduce((a, b) => a + b, 0) / prices.length;
    const maxPrice = Math.max(...prices);
    const minPrice = Math.min(...prices);
    
    // 峰谷分析
    const peakHours = [];
    const valleyHours = [];
    prices.forEach((price, index) => {
      if (price > avgPrice * 1.2) {
        peakHours.push(index);
      } else if (price < avgPrice * 0.8) {
        valleyHours.push(index);
      }
    });
    
    return new Response(
      JSON.stringify({
        success: true,
        message: "Analysis completed successfully",
        results: {
          statistics: {
            average_price: Math.round(avgPrice * 10000) / 10000,
            max_price: maxPrice,
            min_price: minPrice,
            price_range: Math.round((maxPrice - minPrice) * 10000) / 10000
          },
          peak_valley_analysis: {
            peak_hours_count: peakHours.length,
            valley_hours_count: valleyHours.length,
            peak_hours: peakHours.slice(0, 10),
            valley_hours: valleyHours.slice(0, 10)
          },
          total_time_slots: timeSlots.length || prices.length
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
      JSON.stringify({
        success: false,
        message: `Analysis failed: ${error.message}`
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

// 支持 OPTIONS 请求（CORS 预检）
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
