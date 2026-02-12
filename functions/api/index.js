// Cloudflare Pages Function - 主入口和服务信息
export async function onRequest(context) {
  const { request } = context;
  
  return new Response(
    JSON.stringify({
      service: "TOU Schedule Backend",
      version: "1.0.0",
      platform: "Cloudflare Pages Functions",
      status: "running",
      endpoints: [
        "/api/health",
        "/api/analyze",
        "/api/calculate-profit",
        "/api/config"
      ]
    }),
    {
      status: 200,
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type'
      }
    }
  );
}
