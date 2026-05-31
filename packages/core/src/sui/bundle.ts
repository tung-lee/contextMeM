import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import * as cheerio from "cheerio";
import type { SuiTarget } from "../sui-types.js";
import { assertSafeUrl } from "./ssrf.js";

export type BundleScrapeOptions = {
  maxTotalBytes?: number;
  maxChunkBytes?: number;
  maxFollowDepth?: number;
  timeoutMs?: number;
  cacheDir?: string;
  allowLoopback?: boolean;
  fetchImpl?: typeof fetch;
};

export type BundleScrapeResult = {
  url: string;
  host: string;
  bundler: "vite" | "next" | "unknown";
  html: string;
  chunks: BundleChunk[];
  hasSourcemap: boolean;
  warnings: string[];
};

export type BundleChunk = {
  url: string;
  bytes: number;
  sha256: string;
  content: string;
};

const DEFAULT_MAX_TOTAL_BYTES = 50 * 1024 * 1024;
const DEFAULT_MAX_CHUNK_BYTES = 20 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 20_000;
const DEFAULT_MAX_FOLLOW_DEPTH = 1;
const CHUNK_CONCURRENCY = 6;

const USER_AGENT = "ContextMeM/0.1 (+https://github.com/contextmem/contextmem)";

type FetchResult = {
  status: number;
  contentType: string;
  bytes: number;
  text: string;
};

async function fetchWithGuards(
  rawUrl: string,
  opts: {
    maxBytes: number;
    timeoutMs: number;
    allowLoopback?: boolean;
    fetchImpl?: typeof fetch;
    ssrfCheck?: boolean;
  }
): Promise<FetchResult> {
  const fetchFn = opts.fetchImpl ?? fetch;

  // SSRF check
  if (opts.ssrfCheck !== false) {
    await assertSafeUrl(rawUrl, { allowLoopback: opts.allowLoopback });
  }

  let currentUrl = rawUrl;
  let response: Response | null = null;
  const maxRedirects = 10;

  for (let redirects = 0; redirects <= maxRedirects; redirects++) {
    response = await fetchFn(currentUrl, {
      redirect: "manual",
      signal: AbortSignal.timeout(opts.timeoutMs),
      headers: {
        "user-agent": USER_AGENT,
        accept: "*/*"
      }
    });

    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");
      if (!location) break;
      const next = new URL(location, currentUrl).toString();
      await assertSafeUrl(next, { allowLoopback: opts.allowLoopback });
      currentUrl = next;
      continue;
    }
    break;
  }

  if (!response) throw new Error(`No response from ${rawUrl}`);

  const contentType = response.headers.get("content-type") ?? "";
  const raw = await response.bytes();
  if (raw.length > opts.maxBytes) {
    throw new Error(`Response too large (${raw.length} > ${opts.maxBytes} bytes) for ${rawUrl}`);
  }

  const text = new TextDecoder("utf-8", { fatal: false }).decode(raw);
  return { status: response.status, contentType, bytes: raw.length, text };
}

function sha256Hex(content: string): string {
  return crypto.createHash("sha256").update(content, "utf8").digest("hex");
}

function detectBundler(html: string, scriptUrls: string[]): "vite" | "next" | "unknown" {
  if (scriptUrls.some((u) => u.includes("/_next/"))) return "next";
  if (html.includes("/_next/")) return "next";
  if (scriptUrls.some((u) => /\/assets\/[^/]+-[0-9a-f]{8,}\.js/.test(u))) return "vite";
  if (html.includes('type="module"') && scriptUrls.some((u) => u.includes("/assets/"))) return "vite";
  return "unknown";
}

function extractEntryUrls(html: string, baseUrl: string): string[] {
  const $ = cheerio.load(html);
  const urls: string[] = [];
  const base = new URL(baseUrl);

  const resolve = (src: string | undefined): string | null => {
    if (!src?.trim()) return null;
    try {
      return new URL(src, base).toString();
    } catch {
      return null;
    }
  };

  $("script[src]").each((_, el) => {
    const u = resolve($(el).attr("src"));
    if (u) urls.push(u);
  });
  $("link[rel='modulepreload'][href], link[rel='preload'][as='script'][href]").each((_, el) => {
    const u = resolve($(el).attr("href"));
    if (u) urls.push(u);
  });

  return [...new Set(urls)];
}

async function extractNextBuildManifestUrls(html: string, baseUrl: string, opts: { maxBytes: number; timeoutMs: number; allowLoopback?: boolean; fetchImpl?: typeof fetch }): Promise<{ urls: string[]; warning?: string }> {
  const base = new URL(baseUrl);
  // find buildId from _ssgManifest or _buildManifest script tag
  const match = html.match(/\/_next\/static\/([^/]+)\/_(?:ssg|build)Manifest\.js/);
  if (!match) return { urls: [], warning: "next: could not find buildId in HTML" };
  const buildId = match[1]!;
  const manifestUrl = new URL(`/_next/static/${buildId}/_buildManifest.js`, base).toString();
  try {
    const result = await fetchWithGuards(manifestUrl, { ...opts, ssrfCheck: false });
    if (!result.contentType.includes("javascript") && !result.contentType.includes("text")) {
      return { urls: [], warning: `next: _buildManifest content-type unexpected: ${result.contentType}` };
    }
    // extract string chunk paths via regex (no eval)
    const chunkRe = /"(\/_next\/static\/chunks\/[^"]+\.js)"/g;
    const chunkUrls: string[] = [];
    for (const m of result.text.matchAll(chunkRe)) {
      try {
        chunkUrls.push(new URL(m[1]!, base).toString());
      } catch {
        // ignore malformed
      }
    }
    return { urls: chunkUrls };
  } catch (e) {
    return { urls: [], warning: `next: _buildManifest fetch failed: ${String(e)}` };
  }
}

async function fetchChunks(
  urls: string[],
  opts: {
    maxChunkBytes: number;
    timeoutMs: number;
    allowLoopback?: boolean;
    fetchImpl?: typeof fetch;
    cacheDir?: string;
  },
  totalBytesRef: { value: number },
  maxTotalBytes: number,
  warnings: string[]
): Promise<BundleChunk[]> {
  const results: BundleChunk[] = [];
  const batches: string[][] = [];
  for (let i = 0; i < urls.length; i += CHUNK_CONCURRENCY) {
    batches.push(urls.slice(i, i + CHUNK_CONCURRENCY));
  }

  for (const batch of batches) {
    const batchResults = await Promise.all(
      batch.map(async (url): Promise<BundleChunk | null> => {
        if (totalBytesRef.value >= maxTotalBytes) {
          warnings.push(`max-bytes reached, skipping: ${url}`);
          return null;
        }

        // try cache
        const cacheFile = opts.cacheDir ? path.join(opts.cacheDir, sha256Hex(url) + ".bin") : null;
        if (cacheFile) {
          try {
            const cached = await fs.readFile(cacheFile, "utf8");
            const hash = sha256Hex(cached);
            totalBytesRef.value += cached.length;
            return { url, bytes: cached.length, sha256: hash, content: cached };
          } catch {
            // cache miss
          }
        }

        try {
          const result = await fetchWithGuards(url, {
            maxBytes: opts.maxChunkBytes,
            timeoutMs: opts.timeoutMs,
            allowLoopback: opts.allowLoopback,
            fetchImpl: opts.fetchImpl,
            ssrfCheck: false // already checked base URL
          });
          totalBytesRef.value += result.bytes;
          const hash = sha256Hex(result.text);
          if (cacheFile) {
            await fs.mkdir(path.dirname(cacheFile), { recursive: true });
            await fs.writeFile(cacheFile, result.text, "utf8").catch(() => undefined);
          }
          return { url, bytes: result.bytes, sha256: hash, content: result.text };
        } catch (e) {
          warnings.push(`chunk fetch failed: ${url}: ${String(e)}`);
          return null;
        }
      })
    );
    for (const r of batchResults) {
      if (r) results.push(r);
    }
  }
  return results;
}

async function followLazyChunks(
  chunks: BundleChunk[],
  depth: number,
  seenUrls: Set<string>,
  baseOrigin: string,
  opts: {
    maxChunkBytes: number;
    timeoutMs: number;
    allowLoopback?: boolean;
    fetchImpl?: typeof fetch;
    cacheDir?: string;
  },
  totalBytesRef: { value: number },
  maxTotalBytes: number,
  warnings: string[]
): Promise<BundleChunk[]> {
  if (depth <= 0) {
    // count remaining import() literals and warn if any
    let remaining = 0;
    for (const c of chunks) {
      const re = /import\(\s*["']([^"']+\.js)["']\s*\)/g;
      for (const m of c.content.matchAll(re)) {
        try {
          const u = new URL(m[1]!, baseOrigin).toString();
          if (!seenUrls.has(u)) remaining++;
        } catch {
          // ignore
        }
      }
    }
    if (remaining > 0) {
      warnings.push(`depth exhausted with ${remaining} import() literals unresolved; use maxFollowDepth > 1 to follow deeper`);
    }
    return [];
  }

  const newUrls = new Set<string>();
  const re = /import\(\s*["']([^"']+\.js)["']\s*\)/g;
  for (const chunk of chunks) {
    for (const m of chunk.content.matchAll(re)) {
      try {
        const u = new URL(m[1]!, baseOrigin).toString();
        if (!seenUrls.has(u) && (u.includes("/assets/") || u.includes("/_next/"))) {
          newUrls.add(u);
        }
      } catch {
        // ignore
      }
    }
  }

  if (newUrls.size === 0) return [];

  for (const u of newUrls) seenUrls.add(u);

  const fetched = await fetchChunks([...newUrls], opts, totalBytesRef, maxTotalBytes, warnings);
  const deeper = await followLazyChunks(fetched, depth - 1, seenUrls, baseOrigin, opts, totalBytesRef, maxTotalBytes, warnings);
  return [...fetched, ...deeper];
}

async function detectSourcemap(chunks: BundleChunk[], opts: { maxBytes: number; timeoutMs: number; allowLoopback?: boolean; fetchImpl?: typeof fetch }): Promise<boolean> {
  for (const chunk of chunks) {
    const match = chunk.content.match(/\/\/[#@]\s*sourceMappingURL=([^\s]+)/);
    if (!match) continue;
    const mapPath = match[1]!;
    if (mapPath.startsWith("data:")) continue;
    try {
      const mapUrl = new URL(mapPath, chunk.url).toString();
      const result = await fetchWithGuards(mapUrl, { ...opts, ssrfCheck: false });
      if (result.contentType.includes("json") && !result.text.startsWith("<!")) return true;
    } catch {
      continue;
    }
  }
  return false;
}

export async function scrapeSuiBundle(target: SuiTarget, options: BundleScrapeOptions = {}): Promise<BundleScrapeResult> {
  const maxTotalBytes = options.maxTotalBytes ?? DEFAULT_MAX_TOTAL_BYTES;
  const maxChunkBytes = options.maxChunkBytes ?? DEFAULT_MAX_CHUNK_BYTES;
  const maxFollowDepth = options.maxFollowDepth ?? DEFAULT_MAX_FOLLOW_DEPTH;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const warnings: string[] = [];
  const totalBytesRef = { value: 0 };

  // Always fetch root URL (dApps resolve routes client-side)
  const parsed = await assertSafeUrl(target.url, { allowLoopback: options.allowLoopback });
  const rootUrl = `${parsed.protocol}//${parsed.host}/`;

  const htmlResult = await fetchWithGuards(rootUrl, {
    maxBytes: maxChunkBytes,
    timeoutMs,
    allowLoopback: options.allowLoopback,
    fetchImpl: options.fetchImpl,
    ssrfCheck: false // already checked above
  });
  const html = htmlResult.text;
  totalBytesRef.value += htmlResult.bytes;

  const entryUrls = extractEntryUrls(html, rootUrl);
  const bundler = detectBundler(html, entryUrls);

  let allEntryUrls = entryUrls;

  if (bundler === "next") {
    const { urls: manifestUrls, warning } = await extractNextBuildManifestUrls(html, rootUrl, {
      maxBytes: maxChunkBytes,
      timeoutMs,
      allowLoopback: options.allowLoopback,
      fetchImpl: options.fetchImpl
    });
    if (warning) warnings.push(warning);
    allEntryUrls = [...new Set([...entryUrls, ...manifestUrls])];
  }

  const seenUrls = new Set(allEntryUrls);
  seenUrls.add(rootUrl);

  const chunkFetchOpts = {
    maxChunkBytes,
    timeoutMs,
    allowLoopback: options.allowLoopback,
    fetchImpl: options.fetchImpl,
    cacheDir: options.cacheDir
  };

  const entryChunks = await fetchChunks(allEntryUrls, chunkFetchOpts, totalBytesRef, maxTotalBytes, warnings);
  const lazyChunks = await followLazyChunks(
    entryChunks,
    maxFollowDepth,
    seenUrls,
    `${parsed.protocol}//${parsed.host}`,
    chunkFetchOpts,
    totalBytesRef,
    maxTotalBytes,
    warnings
  );

  const allChunks = [...entryChunks, ...lazyChunks];

  const hasSourcemap = await detectSourcemap(allChunks.slice(0, 3), {
    maxBytes: 10 * 1024 * 1024,
    timeoutMs,
    allowLoopback: options.allowLoopback,
    fetchImpl: options.fetchImpl
  });

  return {
    url: rootUrl,
    host: parsed.host,
    bundler,
    html,
    chunks: allChunks,
    hasSourcemap,
    warnings
  };
}

/**
 * Extract human-readable route/feature labels from the dApp's HTML.
 * Used to name transaction-builder actions when bundle symbols are minified.
 */
export function extractRouteLabels(html: string): string[] {
  const $ = cheerio.load(html);
  const labels = new Set<string>();

  // Nav/menu link text
  $("nav a, header a, [class*='nav'] a, [class*='menu'] a, [role='navigation'] a").each((_, el) => {
    const text = $(el).text().trim().toLowerCase();
    if (text.length > 1 && text.length < 30 && /^[a-z]/.test(text)) {
      labels.add(text.replace(/\s+/g, "_"));
    }
  });

  // href path segments from all links
  $("a[href]").each((_, el) => {
    const href = $(el).attr("href") ?? "";
    if (href.startsWith("/")) {
      const seg = href.split("/").filter(Boolean)[0];
      if (seg && seg.length > 1 && /^[a-z]/i.test(seg) && !seg.includes(".") && !seg.includes("?")) {
        labels.add(seg.toLowerCase());
      }
    }
  });

  return [...labels];
}
