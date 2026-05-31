export type ApiCallMethod = "GET" | "POST" | "PUT" | "DELETE" | "PATCH" | "HEAD" | "OPTIONS" | "UNKNOWN";

export type ApiCallEntry = {
  url: string;
  method: ApiCallMethod;
  kind: "fetch" | "axios" | "xhr" | "websocket" | "config";
  chunkUrl: string;
  count: number;
  /** Normalized pattern — path IDs replaced with placeholders */
  pattern: string;
  /** For kind=config: the variable name (e.g. "API_URL", "baseUrl") */
  configKey?: string;
};

export type ApiCallsResult = {
  target: string;
  host: string;
  calls: ApiCallEntry[];
  extractedAt: string;
  authRequired: boolean;
  authHints: string[];
  graphql: {
    endpoints: string[];
    queries: string[];
  };
};

// ── HTTP call patterns ──────────────────────────────────────────────────────
const FETCH_RE = /\bfetch\s*\(\s*["'`]([^"'`\s]{4,512})["'`]/g;
const FETCH_WITH_METHOD_RE = /\bfetch\s*\(\s*["'`]([^"'`\s]{4,512})["'`][^)]{0,200}?\bmethod\s*:\s*["'`](GET|POST|PUT|DELETE|PATCH|HEAD|OPTIONS)["'`]/gis;
const AXIOS_VERB_RE = /\baxios\s*\.\s*(get|post|put|delete|patch|head|options)\s*\(\s*["'`]([^"'`\s]{4,512})["'`]/gi;
const AXIOS_OBJ_URL_RE = /\baxios\s*\(\s*\{[^{}]{0,400}?\burl\s*:\s*["'`]([^"'`\s]{4,512})["'`]/gis;
const AXIOS_OBJ_METHOD_RE = /\bmethod\s*:\s*["'`](GET|POST|PUT|DELETE|PATCH)["'`]/i;
const XHR_RE = /\.open\s*\(\s*["'`](GET|POST|PUT|DELETE|PATCH)["'`]\s*,\s*["'`]([^"'`\s]{4,512})["'`]/gi;

// ── Base URL config constants ────────────────────────────────────────────────
const BASE_URL_RE = /\b(baseURL|BASE_URL|API_URL|apiUrl|apiEndpoint|API_ENDPOINT|API_BASE|apiBase|API_HOST|apiHost|endpoint)\s*[=:]\s*["'`]([^"'`\s]{4,512})["'`]/g;

// ── WebSocket URLs in string literals ───────────────────────────────────────
const WS_URL_RE = /["'`](wss?:\/\/[^"'`\s]{4,256})["'`]/g;

// ── GraphQL ─────────────────────────────────────────────────────────────────
const GRAPHQL_ENDPOINT_RE = /["'`]((?:https?:\/\/[^"'`\s]*)?\/graphql[^"'`\s?#]{0,100})["'`]/g;
const GRAPHQL_OP_RE = /\b(query|mutation|subscription)\s+([A-Z][a-zA-Z0-9_]*)/g;

// ── Auth detection ───────────────────────────────────────────────────────────
const AUTH_PATTERNS: Array<{ re: RegExp; hint: string }> = [
  { re: /Authorization[\s:]+Bearer/i, hint: "Bearer token (Authorization header)" },
  { re: /access_token|refresh_token|id_token/i, hint: "OAuth token fields" },
  { re: /localStorage\.getItem\s*\(\s*["'`][^"'`]*token[^"'`]*["'`]/i, hint: "localStorage token" },
  { re: /sessionStorage\.getItem\s*\(\s*["'`][^"'`]*token[^"'`]*["'`]/i, hint: "sessionStorage token" },
  { re: /\/oauth\/|\/auth\/callback|\/auth\/token/i, hint: "OAuth flow routes" },
  { re: /jwt_decode|atob\s*\(\s*\w+\.split/i, hint: "JWT decoding" },
  { re: /x-api-key|apikey|api[-_]key/i, hint: "API key header" },
];

// ── URL filtering ────────────────────────────────────────────────────────────
const ASSET_RE = /\.(jpg|jpeg|png|gif|svg|webp|ico|woff2?|ttf|otf|eot|css|js|mjs|map|json|xml|txt|html|htm)(\?|$)/i;
const SKIP_PREFIX_RE = /^(data:|blob:|javascript:|about:|#)/;

function looksLikeApiUrl(url: string): boolean {
  if (SKIP_PREFIX_RE.test(url)) return false;
  if (ASSET_RE.test(url.split("?")[0] ?? "")) return false;
  if (!url.startsWith("http://") && !url.startsWith("https://") && !url.startsWith("/")) return false;
  if (/\.(cloudfront\.net|fastly\.net|akamaized\.net|gstatic\.com|googleapis\.com\/fonts)/.test(url)) return false;
  return true;
}

function normalizeUrl(url: string): string {
  let n = url.replace(/\/[0-9a-fA-F]{32,}(\/|$)/g, "/{hash}$1");
  n = n.replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, "{uuid}");
  n = n.replace(/\/\d{3,}(\/|$)/g, "/{id}$1");
  n = n.split("?")[0] ?? n;
  return n;
}

const KNOWN_METHODS = ["GET", "POST", "PUT", "DELETE", "PATCH", "HEAD", "OPTIONS"] as const;
type KnownMethod = typeof KNOWN_METHODS[number];

function toMethod(raw: string): ApiCallMethod {
  const upper = raw.toUpperCase();
  return (KNOWN_METHODS as readonly string[]).includes(upper) ? (upper as KnownMethod) : "UNKNOWN";
}

export function extractApiCalls(chunks: ReadonlyArray<{ url: string; content: string }>): {
  calls: ApiCallEntry[];
  authRequired: boolean;
  authHints: string[];
  graphql: { endpoints: string[]; queries: string[] };
} {
  const seen = new Map<string, ApiCallEntry>();

  function add(url: string, method: ApiCallMethod, kind: ApiCallEntry["kind"], chunkUrl: string, configKey?: string) {
    const pattern = normalizeUrl(url);
    const key = configKey ? `config|${configKey}` : `${kind}|${method}|${pattern}`;
    const existing = seen.get(key);
    if (existing) {
      existing.count++;
    } else {
      const entry: ApiCallEntry = { url, method, kind, chunkUrl, count: 1, pattern };
      if (configKey) entry.configKey = configKey;
      seen.set(key, entry);
    }
  }

  const authHintsSet = new Set<string>();
  const graphqlEndpoints = new Set<string>();
  const graphqlQueries = new Set<string>();

  for (const chunk of chunks) {
    const { url: chunkUrl, content } = chunk;

    // fetch with explicit method (run before plain fetch to capture method)
    for (const m of content.matchAll(FETCH_WITH_METHOD_RE)) {
      add(m[1]!, toMethod(m[2] ?? ""), "fetch", chunkUrl);
    }

    // plain fetch (method unknown unless already captured)
    for (const m of content.matchAll(FETCH_RE)) {
      const u = m[1]!;
      if (looksLikeApiUrl(u)) {
        const pattern = normalizeUrl(u);
        const key = `fetch|GET|${pattern}`;
        const keyPost = `fetch|POST|${pattern}`;
        if (!seen.has(key) && !seen.has(keyPost)) {
          add(u, "UNKNOWN", "fetch", chunkUrl);
        }
      }
    }

    // axios verb methods
    for (const m of content.matchAll(AXIOS_VERB_RE)) {
      add(m[2]!, toMethod(m[1] ?? "GET"), "axios", chunkUrl);
    }

    // axios object form
    for (const m of content.matchAll(AXIOS_OBJ_URL_RE)) {
      const u = m[1]!;
      const ctxStart = m.index ?? 0;
      const ctx = content.slice(ctxStart, ctxStart + 400);
      const methodMatch = AXIOS_OBJ_METHOD_RE.exec(ctx);
      add(u, methodMatch ? toMethod(methodMatch[1] ?? "") : "UNKNOWN", "axios", chunkUrl);
    }

    // XHR
    for (const m of content.matchAll(XHR_RE)) {
      add(m[2]!, toMethod(m[1] ?? ""), "xhr", chunkUrl);
    }

    // Base URL config constants
    for (const m of content.matchAll(BASE_URL_RE)) {
      const u = m[2]!;
      if (u.startsWith("http") || u.startsWith("/")) {
        add(u, "UNKNOWN", "config", chunkUrl, m[1]);
      }
    }

    // WebSocket URLs
    for (const m of content.matchAll(WS_URL_RE)) {
      add(m[1]!, "UNKNOWN", "websocket", chunkUrl);
    }

    // Auth detection (scans the full chunk, not URL-specific)
    for (const { re, hint } of AUTH_PATTERNS) {
      if (re.test(content)) authHintsSet.add(hint);
    }

    // GraphQL endpoints
    for (const m of content.matchAll(GRAPHQL_ENDPOINT_RE)) {
      graphqlEndpoints.add(m[1]!);
    }

    // GraphQL named operations
    for (const m of content.matchAll(GRAPHQL_OP_RE)) {
      graphqlQueries.add(`${m[1]} ${m[2]}`);
    }
  }

  const kindOrder: Record<string, number> = { config: 0, websocket: 1, fetch: 2, axios: 3, xhr: 4 };
  const calls = [...seen.values()].sort((a, b) => {
    const ko = (kindOrder[a.kind] ?? 5) - (kindOrder[b.kind] ?? 5);
    if (ko !== 0) return ko;
    return a.pattern.localeCompare(b.pattern);
  });

  const authHints = [...authHintsSet];

  return {
    calls,
    authRequired: authHints.length > 0,
    authHints,
    graphql: {
      endpoints: [...graphqlEndpoints],
      queries: [...graphqlQueries].slice(0, 20),
    },
  };
}
