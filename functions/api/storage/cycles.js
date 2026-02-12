// Cloudflare Pages Function - 储能周期计算
// 端点: /api/storage/cycles

export async function onRequestPost(context) {
  try {
    const { request } = context;
    const formData = await request.formData();
    
    const payloadStr = formData.get('payload');
    const payload = payloadStr ? JSON.parse(payloadStr) : {};
    
    const storage = payload.storage || {};
    const capacity_kwh = storage.capacity_kwh || 10;
    const c_rate = storage.c_rate || 0.5;
    const efficiency = storage.single_side_efficiency || 0.85;
    
    // 简化的储能计算
    const dailyCycleCount = 1;
    const dailyChargeKwh = capacity_kwh * c_rate * 6;
    const dailyDischargeKwh = dailyChargeKwh * efficiency;
    
    return new Response(
      JSON.stringify({
        success: true,
        daily: {
          cycle_count: dailyCycleCount,
          charge_kwh: Math.round(dailyChargeKwh * 100) / 100,
          discharge_kwh: Math.round(dailyDischargeKwh * 100) / 100
        },
        monthly: Array(12).fill(null).map((_, i) => ({
          month: i + 1,
          cycle_count: 30,
          charge_kwh: Math.round(dailyChargeKwh * 30 * 100) / 100,
          discharge_kwh: Math.round(dailyDischargeKwh * 30 * 100) / 100
        })),
        yearly: {
          cycle_count: 365,
          charge_kwh: Math.round(dailyChargeKwh * 365 * 100) / 100,
          discharge_kwh: Math.round(dailyDischargeKwh * 365 * 100) / 100
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
