// Cloudflare Pages Function - 配置信息
export async function onRequest(context) {
  return new Response(
    JSON.stringify({
      supported_features: [
        "schedule_analysis",
        "profit_calculation",
        "peak_valley_analysis",
        "basic_statistics"
      ],
      max_upload_size_mb: 10,
      supported_formats: ["json"],
      version: "1.0.0",
      platform: "Cloudflare Pages Functions",
      endpoints: {
        "GET /api/health": "Health check",
        "POST /api/analyze": "Analyze schedule data",
        "POST /api/calculate-profit": "Calculate storage profit",
        "GET /api/config": "Get configuration"
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
}
