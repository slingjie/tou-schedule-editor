import { getApiBaseUrl, isTauriDesktop } from './desktopBackend';

type OpenApiDoc = {
  paths?: Record<string, unknown>;
};

type OpenApiCacheEntry = {
  paths: Set<string>;
};

const openApiCache = new Map<string, OpenApiCacheEntry>();

const trimTrailingSlash = (value: string): string => value.replace(/\/$/, '');

const buildOpenApiUrl = (baseUrl: string): string => {
  if (!baseUrl) return '/openapi.json';
  return `${trimTrailingSlash(baseUrl)}/openapi.json`;
};

const getBaseUrlLabel = (baseUrl: string): string => {
  return baseUrl ? trimTrailingSlash(baseUrl) : '同源地址(/api + /openapi.json 代理)';
};

const fetchOpenApiPaths = async (baseUrl: string): Promise<Set<string>> => {
  const openApiUrl = buildOpenApiUrl(baseUrl);
  const response = await fetch(openApiUrl, { method: 'GET' });

  if (!response.ok) {
    throw new Error(`无法访问 ${openApiUrl}（HTTP ${response.status}）`);
  }

  const contentType = response.headers.get('content-type') || '';
  let doc: OpenApiDoc | null = null;

  if (contentType.includes('application/json')) {
    doc = (await response.json().catch(() => null)) as OpenApiDoc | null;
  } else {
    const raw = await response.text().catch(() => '');
    try {
      doc = JSON.parse(raw) as OpenApiDoc;
    } catch {
      throw new Error(`后端未返回 OpenAPI JSON（URL: ${openApiUrl}）`);
    }
  }

  const paths = doc?.paths && typeof doc.paths === 'object' ? Object.keys(doc.paths) : [];
  if (!paths.length) {
    throw new Error(`OpenAPI 文档为空或缺少 paths（URL: ${openApiUrl}）`);
  }

  return new Set(paths);
};

/**
 * 校验当前连接的后端是否是“完整计算后端”（FastAPI），并且包含指定接口。
 *
 * - 桌面版（Tauri sidecar）直接放行；
 * - Web 版通过 /openapi.json 校验后端接口覆盖，避免误连到不完整服务。
 */
export const ensureBackendSupports = async (
  featureName: string,
  requiredPaths: string[],
): Promise<void> => {
  if (isTauriDesktop()) {
    return;
  }

  const baseUrl = trimTrailingSlash(getApiBaseUrl());
  // Web 同源模式（baseUrl 为空）也允许：
  // - 本地开发：依赖 Vite /openapi.json 代理；
  // - Cloudflare Pages：依赖 Functions 提供 /openapi.json。
  // 只有当同源 /openapi.json 不可用时，才在后续给出明确错误提示。

  const cacheKey = baseUrl || '__same_origin__';
  let entry = openApiCache.get(cacheKey);

  if (!entry) {
    try {
      const paths = await fetchOpenApiPaths(baseUrl);
      entry = { paths };
      openApiCache.set(cacheKey, entry);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const label = getBaseUrlLabel(baseUrl);
      throw new Error(
        `${featureName} 需要完整后端服务，但当前后端不可用或接口规范不匹配（base: ${label}，原因: ${message}）。`,
      );
    }
  }

  const missing = requiredPaths.filter((path) => !entry.paths.has(path));
  if (missing.length > 0) {
    const label = getBaseUrlLabel(baseUrl);
    throw new Error(
      `${featureName} 需要接口 ${missing.join(', ')}，但当前后端未提供（base: ${label}）。`,
    );
  }
};
