/**
 * GET /api/sync/pull?device_id=xxx&since=ISO_TIMESTAMP
 * Pull changed entities from D1 since a given timestamp.
 * Returns projects, datasets, runs, tou_configs updated after `since`.
 */
import { checkSyncAuth } from './_auth.js';

export async function onRequestGet(context) {
  const { request, env } = context;

  // 安全审计 P0 #2：鉴权检查
  const authErr = checkSyncAuth(request, env);
  if (authErr) return authErr;

  try {
    const url = new URL(request.url);
    const deviceId = url.searchParams.get('device_id');
    const since = url.searchParams.get('since') || '1970-01-01T00:00:00Z';

    if (!deviceId) {
      return Response.json({ ok: false, error: 'missing device_id' }, { status: 400 });
    }

    // No user auth yet — return ALL devices' data so any browser can pull everything.
    // Phase 4 will scope by user_id after authentication is added.
    const [projects, datasets, runs, touConfigs] = await env.DB.batch([
      env.DB.prepare(
        `SELECT id, name, created_at, updated_at, deleted_at
         FROM projects WHERE updated_at > ?1
         ORDER BY updated_at ASC`
      ).bind(since),
      env.DB.prepare(
        `SELECT id, project_id, name, source_filename, fingerprint,
                start_time, end_time, interval_minutes, points_count,
                meta_json, quality_report_json, r2_points_key,
                created_at, updated_at, deleted_at
         FROM datasets WHERE updated_at > ?1
         ORDER BY updated_at ASC`
      ).bind(since),
      env.DB.prepare(
        `SELECT id, project_id, name, dataset_id,
                config_snapshot, cycles_snapshot, economics_snapshot,
                profit_snapshot, quality_snapshot, r2_embedded_points_key,
                created_at, updated_at, deleted_at
         FROM runs WHERE updated_at > ?1
         ORDER BY updated_at ASC`
      ).bind(since),
      env.DB.prepare(
        `SELECT id, name, schedule_data, created_at, updated_at, deleted_at
         FROM tou_configs WHERE updated_at > ?1
         ORDER BY updated_at ASC`
      ).bind(since),
    ]);

    // Parse JSON text columns back to objects for runs
    const parsedRuns = (runs.results || []).map(r => ({
      ...r,
      config_snapshot: tryParse(r.config_snapshot),
      cycles_snapshot: tryParse(r.cycles_snapshot),
      economics_snapshot: tryParse(r.economics_snapshot),
      profit_snapshot: tryParse(r.profit_snapshot),
      quality_snapshot: tryParse(r.quality_snapshot),
    }));

    const parsedDatasets = (datasets.results || []).map(d => ({
      ...d,
      meta_json: tryParse(d.meta_json),
      quality_report_json: tryParse(d.quality_report_json),
    }));

    const parsedConfigs = (touConfigs.results || []).map(c => ({
      ...c,
      schedule_data: tryParse(c.schedule_data),
    }));

    return Response.json({
      ok: true,
      since,
      projects: projects.results || [],
      datasets: parsedDatasets,
      runs: parsedRuns,
      tou_configs: parsedConfigs,
    });
  } catch (err) {
    console.error('[pull]', err);
    return Response.json({ ok: false, error: String(err.message || err) }, { status: 500 });
  }
}

function tryParse(val) {
  if (val == null) return null;
  if (typeof val === 'object') return val;
  try { return JSON.parse(val); } catch { return val; }
}
