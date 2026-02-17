/**
 * POST /api/sync/register
 * Register or update a device heartbeat.
 * Body: { device_id: string, device_name?: string }
 */
export async function onRequestPost(context) {
  const { request, env } = context;

  try {
    const body = await request.json();
    const { device_id, device_name } = body;

    if (!device_id || typeof device_id !== 'string') {
      return Response.json({ ok: false, error: 'missing device_id' }, { status: 400 });
    }

    await env.DB.prepare(
      `INSERT INTO devices (device_id, device_name, created_at, last_seen_at)
       VALUES (?1, ?2, datetime('now'), datetime('now'))
       ON CONFLICT(device_id) DO UPDATE SET
         device_name = COALESCE(?2, device_name),
         last_seen_at = datetime('now')`
    ).bind(device_id, device_name || null).run();

    return Response.json({ ok: true, device_id });
  } catch (err) {
    console.error('[register]', err);
    return Response.json({ ok: false, error: String(err.message || err) }, { status: 500 });
  }
}
