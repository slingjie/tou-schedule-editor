// Cloudflare Pages Function - 本地同步快照
// 端点: /api/local-sync/snapshot

const jsonHeaders = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': '*',
};

const CACHE_KEY = new Request('https://local-sync.internal/snapshot');

const readSnapshot = async () => {
  const cached = await caches.default.match(CACHE_KEY);
  if (!cached) {
    return {
      exists: false,
      snapshot: null,
      updated_at: null,
      note: 'Pages Cache 暂无快照',
    };
  }
  const data = await cached.json().catch(() => null);
  if (!data || typeof data !== 'object') {
    return {
      exists: false,
      snapshot: null,
      updated_at: null,
      note: 'Pages Cache 快照解析失败',
    };
  }
  return {
    exists: true,
    snapshot: data.snapshot ?? null,
    updated_at: data.updated_at ?? null,
    note: '来自 Pages Cache（轻量持久化）',
  };
};

export async function onRequestGet() {
  const payload = await readSnapshot();
  return new Response(JSON.stringify(payload), { status: 200, headers: jsonHeaders });
}

export async function onRequestPost(context) {
  try {
    const body = await context.request.json();
    if (!body || typeof body !== 'object') {
      return new Response(JSON.stringify({ detail: 'body must be an object' }), {
        status: 400,
        headers: jsonHeaders,
      });
    }

    if (!('snapshot' in body)) {
      return new Response(JSON.stringify({ detail: 'snapshot is required' }), {
        status: 400,
        headers: jsonHeaders,
      });
    }

    const updatedAt = new Date().toISOString();
    const cachePayload = {
      snapshot: body.snapshot,
      updated_at: updatedAt,
    };

    const cacheResp = new Response(JSON.stringify(cachePayload), {
      headers: {
        'Content-Type': 'application/json',
        'Cache-Control': 'public, max-age=86400',
      },
    });
    await caches.default.put(CACHE_KEY, cacheResp);

    return new Response(
      JSON.stringify({
        ok: true,
        updated_at: updatedAt,
        note: '已写入 Pages Cache',
      }),
      { status: 200, headers: jsonHeaders },
    );
  } catch (error) {
    return new Response(JSON.stringify({ detail: error?.message || 'invalid json body' }), {
      status: 400,
      headers: jsonHeaders,
    });
  }
}

export async function onRequestOptions() {
  return new Response(null, {
    status: 204,
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    },
  });
}
