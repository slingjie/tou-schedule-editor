// Cloudflare Pages Function - OpenAPI endpoint for capability checks

const PATHS = {
  '/api/health': { get: { summary: 'Health check' } },
  '/api/config': { get: { summary: 'Config' } },
  '/api/load/analyze': { post: { summary: 'Load analyze' } },
  '/api/cleaning/analyze': { post: { summary: 'Cleaning analyze' } },
  '/api/cleaning/apply': { post: { summary: 'Cleaning apply' } },
  '/api/storage/cycles': { post: { summary: 'Storage cycles' } },
  '/api/storage/cycles/curves': { post: { summary: 'Storage curves' } },
  '/api/storage/economics': { post: { summary: 'Storage economics' } },
  '/api/storage/economics/export': { post: { summary: 'Economics export' } },
  '/api/local-sync/snapshot': {
    get: { summary: 'Local sync pull' },
    post: { summary: 'Local sync push' },
  },
  '/api/report/html': { post: { summary: 'Report HTML preview' } },
  '/api/report/pdf': { post: { summary: 'Report PDF export' } },
  '/api/deepseek/project-summary': { post: { summary: 'Project summary' } },
};

export async function onRequest() {
  return new Response(
    JSON.stringify({
      openapi: '3.0.0',
      info: {
        title: 'TOU Schedule Pages API',
        version: '1.0.0',
      },
      paths: PATHS,
    }),
    {
      status: 200,
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
      },
    },
  );
}
