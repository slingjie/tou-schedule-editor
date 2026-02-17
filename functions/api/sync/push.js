/**
 * POST /api/sync/push
 * Batch upsert/delete entities to D1.
 * Body: { device_id: string, entities: Array<{ type, id, action, data? }> }
 */
import { checkSyncAuth } from './_auth.js';

export async function onRequestPost(context) {
  const { request, env } = context;

  // 安全审计 P0 #2：鉴权检查
  const authErr = checkSyncAuth(request, env);
  if (authErr) return authErr;

  try {
    const body = await request.json();
    const { device_id, entities } = body;

    if (!device_id || !Array.isArray(entities)) {
      return Response.json({ ok: false, error: 'invalid payload' }, { status: 400 });
    }

    const stmts = [];

    for (const entity of entities) {
      const { type, id, action, data } = entity;
      if (!type || !id || !action) continue;

      if (action === 'delete') {
        stmts.push(...buildDeleteStmts(env, type, id, device_id));
      } else if (action === 'upsert') {
        stmts.push(...buildUpsertStmts(env, type, id, device_id, data || {}));
      }
    }

    if (stmts.length > 0) {
      await env.DB.batch(stmts);
    }

    return Response.json({ ok: true, synced: entities.length });
  } catch (err) {
    console.error('[push]', err);
    return Response.json({ ok: false, error: String(err.message || err) }, { status: 500 });
  }
}

function buildDeleteStmts(env, type, id, device_id) {
  const now = new Date().toISOString();
  switch (type) {
    case 'project':
      return [
        env.DB.prepare(
          `UPDATE projects SET deleted_at = ?1 WHERE id = ?2 AND device_id = ?3`
        ).bind(now, id, device_id),
      ];
    case 'dataset':
      return [
        env.DB.prepare(
          `UPDATE datasets SET deleted_at = ?1 WHERE id = ?2 AND device_id = ?3`
        ).bind(now, id, device_id),
      ];
    case 'run':
      return [
        env.DB.prepare(
          `UPDATE runs SET deleted_at = ?1 WHERE id = ?2 AND device_id = ?3`
        ).bind(now, id, device_id),
      ];
    case 'tou_config':
      return [
        env.DB.prepare(
          `UPDATE tou_configs SET deleted_at = ?1 WHERE id = ?2 AND device_id = ?3`
        ).bind(now, id, device_id),
      ];
    default:
      return [];
  }
}

function buildUpsertStmts(env, type, id, device_id, data) {
  switch (type) {
    case 'project':
      return [
        env.DB.prepare(
          `INSERT INTO projects (id, device_id, name, created_at, updated_at)
           VALUES (?1, ?2, ?3, ?4, ?5)
           ON CONFLICT(id) DO UPDATE SET
             name = ?3, updated_at = ?5`
        ).bind(id, device_id, data.name || '', data.created_at || new Date().toISOString(), data.updated_at || new Date().toISOString()),
      ];

    case 'dataset':
      return [
        env.DB.prepare(
          `INSERT INTO datasets (id, device_id, project_id, name, source_filename, fingerprint,
             start_time, end_time, interval_minutes, points_count, meta_json,
             quality_report_json, r2_points_key, created_at, updated_at)
           VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15)
           ON CONFLICT(id) DO UPDATE SET
             name = ?4, source_filename = ?5, fingerprint = ?6,
             start_time = ?7, end_time = ?8, interval_minutes = ?9,
             points_count = ?10, meta_json = ?11, quality_report_json = ?12,
             r2_points_key = ?13, updated_at = ?15`
        ).bind(
          id, device_id, data.project_id || '', data.name || '',
          data.source_filename || null, data.fingerprint || null,
          data.start_time || null, data.end_time || null,
          data.interval_minutes ?? null, data.points_count ?? 0,
          data.meta_json ? JSON.stringify(data.meta_json) : null,
          data.quality_report_json ? JSON.stringify(data.quality_report_json) : null,
          data.r2_points_key || null,
          data.created_at || new Date().toISOString(),
          data.updated_at || new Date().toISOString()
        ),
      ];

    case 'run':
      return [
        env.DB.prepare(
          `INSERT INTO runs (id, device_id, project_id, name, dataset_id,
             config_snapshot, cycles_snapshot, economics_snapshot,
             profit_snapshot, quality_snapshot, r2_embedded_points_key,
             created_at, updated_at)
           VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)
           ON CONFLICT(id) DO UPDATE SET
             name = ?4, dataset_id = ?5, config_snapshot = ?6,
             cycles_snapshot = ?7, economics_snapshot = ?8,
             profit_snapshot = ?9, quality_snapshot = ?10,
             r2_embedded_points_key = ?11, updated_at = ?13`
        ).bind(
          id, device_id, data.project_id || '', data.name || '',
          data.dataset_id || null,
          data.config_snapshot ? JSON.stringify(data.config_snapshot) : null,
          data.cycles_snapshot ? JSON.stringify(data.cycles_snapshot) : null,
          data.economics_snapshot ? JSON.stringify(data.economics_snapshot) : null,
          data.profit_snapshot ? JSON.stringify(data.profit_snapshot) : null,
          data.quality_snapshot ? JSON.stringify(data.quality_snapshot) : null,
          data.r2_embedded_points_key || null,
          data.created_at || new Date().toISOString(),
          data.updated_at || new Date().toISOString()
        ),
      ];

    case 'run_artifact':
      return [
        env.DB.prepare(
          `INSERT INTO run_artifacts (artifact_id, run_id, device_id, kind, filename, mime, size_bytes, r2_blob_key, created_at)
           VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
           ON CONFLICT(artifact_id) DO NOTHING`
        ).bind(
          id, data.run_id || '', device_id,
          data.kind || '', data.filename || '', data.mime || '',
          data.size_bytes ?? null, data.r2_blob_key || '',
          data.created_at || new Date().toISOString()
        ),
      ];

    case 'tou_config':
      return [
        env.DB.prepare(
          `INSERT INTO tou_configs (id, device_id, name, schedule_data, created_at, updated_at)
           VALUES (?1, ?2, ?3, ?4, ?5, ?6)
           ON CONFLICT(id) DO UPDATE SET
             name = ?3, schedule_data = ?4, updated_at = ?6`
        ).bind(
          id, device_id, data.name || '',
          data.schedule_data ? JSON.stringify(data.schedule_data) : '{}',
          data.created_at || new Date().toISOString(),
          data.updated_at || new Date().toISOString()
        ),
      ];

    default:
      return [];
  }
}
