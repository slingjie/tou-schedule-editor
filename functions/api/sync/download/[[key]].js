/**
 * GET /api/sync/download/:key+
 * Download a file from R2 by its key.
 * The key is the full path after /api/sync/download/
 */
export async function onRequestGet(context) {
  const { request, env } = context;

  try {
    const url = new URL(request.url);
    // Extract everything after /api/sync/download/
    const prefix = '/api/sync/download/';
    const idx = url.pathname.indexOf(prefix);
    const r2Key = idx >= 0 ? decodeURIComponent(url.pathname.slice(idx + prefix.length)) : '';

    if (!r2Key) {
      return Response.json({ ok: false, error: 'missing key' }, { status: 400 });
    }

    const object = await env.R2.get(r2Key);
    if (!object) {
      return Response.json({ ok: false, error: 'not found' }, { status: 404 });
    }

    const headers = new Headers();
    headers.set('Content-Type', object.httpMetadata?.contentType || 'application/octet-stream');
    if (object.size != null) {
      headers.set('Content-Length', String(object.size));
    }
    headers.set('Cache-Control', 'private, max-age=3600');

    return new Response(object.body, { headers });
  } catch (err) {
    console.error('[download]', err);
    return Response.json({ ok: false, error: String(err.message || err) }, { status: 500 });
  }
}
