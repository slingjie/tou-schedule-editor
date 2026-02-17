/**
 * POST /api/sync/upload
 * Upload a blob to R2.
 * Headers: X-Device-Id, X-R2-Key
 * Body: raw binary
 */
import { checkSyncAuth } from './_auth.js';

export async function onRequestPost(context) {
  const { request, env } = context;

  // 安全审计 P0 #2：鉴权检查
  const authErr = checkSyncAuth(request, env);
  if (authErr) return authErr;

  try {
    const deviceId = request.headers.get('X-Device-Id');
    const r2Key = request.headers.get('X-R2-Key');

    if (!deviceId || !r2Key) {
      return Response.json(
        { ok: false, error: 'missing X-Device-Id or X-R2-Key header' },
        { status: 400 }
      );
    }

    // Ensure the key is scoped to the device
    const scopedKey = r2Key.startsWith(`${deviceId}/`) ? r2Key : `${deviceId}/${r2Key}`;

    const body = await request.arrayBuffer();
    const contentType = request.headers.get('Content-Type') || 'application/octet-stream';

    await env.R2.put(scopedKey, body, {
      httpMetadata: { contentType },
      customMetadata: { device_id: deviceId },
    });

    return Response.json({
      ok: true,
      r2_key: scopedKey,
      size_bytes: body.byteLength,
    });
  } catch (err) {
    console.error('[upload]', err);
    return Response.json({ ok: false, error: String(err.message || err) }, { status: 500 });
  }
}
