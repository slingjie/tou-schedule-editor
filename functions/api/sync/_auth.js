/**
 * Cloudflare Sync API 鉴权中间件
 * 安全审计 P0 #2：所有 sync API 需要 Bearer Token 或 X-API-Key 校验
 *
 * 使用方式：
 *   在 wrangler.toml 或 Cloudflare Dashboard 中设置环境变量 SYNC_API_KEY
 *   前端请求时携带 Header：Authorization: Bearer <key> 或 X-API-Key: <key>
 */

/**
 * 校验请求中的 API Key
 * @param {Request} request
 * @param {object} env - Cloudflare env bindings
 * @returns {Response|null} 如果鉴权失败返回 Response，成功返回 null
 */
export function checkSyncAuth(request, env) {
    const expectedKey = env.SYNC_API_KEY;

    // 如果未配置 SYNC_API_KEY，拒绝所有请求（安全默认）
    if (!expectedKey) {
        return Response.json(
            { ok: false, error: 'SYNC_API_KEY not configured on server' },
            { status: 503 }
        );
    }

    // 从 Authorization: Bearer <key> 或 X-API-Key: <key> 中提取
    const authHeader = request.headers.get('Authorization') || '';
    const xApiKey = request.headers.get('X-API-Key') || '';

    let providedKey = '';
    if (authHeader.startsWith('Bearer ')) {
        providedKey = authHeader.slice(7).trim();
    } else if (xApiKey) {
        providedKey = xApiKey.trim();
    }

    if (!providedKey || providedKey !== expectedKey) {
        return Response.json(
            { ok: false, error: 'Unauthorized: invalid or missing API key' },
            { status: 401 }
        );
    }

    return null; // 鉴权通过
}
