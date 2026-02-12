// Cloudflare Pages Function - 收益计算
export async function onRequestPost(context) {
  try {
    const { request } = context;
    const data = await request.json();
    
    // 简化的收益计算逻辑
    const capacity = data.capacity_mwh || 10;
    const efficiency = data.efficiency || 0.85;
    const cycles = data.cycles_per_day || 2;
    
    // 模拟计算
    const dailyProfit = capacity * efficiency * cycles * 125;
    const monthlyProfit = dailyProfit * 30;
    const annualProfit = dailyProfit * 365;
    
    return new Response(
      JSON.stringify({
        success: true,
        message: "Profit calculation completed",
        results: {
          estimated_daily_profit: Math.round(dailyProfit * 100) / 100,
          estimated_monthly_profit: Math.round(monthlyProfit * 100) / 100,
          estimated_annual_profit: Math.round(annualProfit * 100) / 100,
          capacity_utilization: efficiency,
          parameters: {
            capacity_mwh: capacity,
            efficiency: efficiency,
            cycles_per_day: cycles
          },
          note: "This is a simplified calculation for demo purposes"
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
        message: `Calculation failed: ${error.message}`
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
