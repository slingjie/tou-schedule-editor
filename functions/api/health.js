// Cloudflare Pages Function - 健康检查
export async function onRequest(context) {
  return new Response(
    JSON.stringify({
      status: 'healthy',
      service: 'tou-schedule-backend',
      version: '1.0.0',
      platform: 'Cloudflare Pages Functions'
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
