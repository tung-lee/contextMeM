import fs from "node:fs/promises";
import path from "node:path";
import { SuiJsonRpcClient, getJsonRpcFullnodeUrl } from "@mysten/sui/jsonRpc";
import type { PackageId, SuiAbi, SuiMoveNormalizedModule, SuiMoveNormalizedType, SuiNetwork } from "../sui-types.js";

export type AbiFetchOptions = {
  network?: SuiNetwork;
  rpcUrl?: string;
  cacheDir?: string;
  concurrency?: number;
  clientFactory?: (url: string) => SuiJsonRpcClient;
};

export type AbiFetchResult = {
  abi: SuiAbi;
  notPackages: PackageId[];
  failures: Array<{ packageId: PackageId; error: string }>;
  cacheStats: { hits: number; misses: number; writes: number };
};

const DEFAULT_CONCURRENCY = 6;

function resolveRpcUrl(opts: AbiFetchOptions): string {
  return opts.rpcUrl ?? process.env.SUI_RPC_URL ?? getJsonRpcFullnodeUrl(opts.network ?? "mainnet");
}

function safeCachePath(cacheDir: string, network: string, packageId: string): string {
  // packageId is a hex string — safe to use as filename
  const safe = packageId.replace(/[^0-9a-fA-Fx]/g, "_");
  return path.join(cacheDir, network, `${safe}.json`);
}

async function readCache(cacheDir: string, network: string, packageId: string): Promise<Record<string, unknown> | null> {
  const p = safeCachePath(cacheDir, network, packageId);
  try {
    const text = await fs.readFile(p, "utf8");
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    return null;
  }
}

async function writeCache(cacheDir: string, network: string, packageId: string, data: unknown): Promise<void> {
  const p = safeCachePath(cacheDir, network, packageId);
  await fs.mkdir(path.dirname(p), { recursive: true });
  await fs.writeFile(p, JSON.stringify(data), "utf8");
}

export function renderTypeTag(t: SuiMoveNormalizedType, typeParamNames?: string[]): string {
  if (typeof t === "string") return t.toLowerCase();
  if ("Vector" in t) return `vector<${renderTypeTag(t.Vector, typeParamNames)}>`;
  if ("Struct" in t) {
    const { address, module, name, typeArguments } = t.Struct;
    const base = `${address}::${module}::${name}`;
    if (typeArguments && typeArguments.length > 0) {
      return `${base}<${typeArguments.map((a) => renderTypeTag(a, typeParamNames)).join(", ")}>`;
    }
    return base;
  }
  if ("Reference" in t) return `&${renderTypeTag(t.Reference, typeParamNames)}`;
  if ("MutableReference" in t) return `&mut ${renderTypeTag(t.MutableReference, typeParamNames)}`;
  if ("TypeParameter" in t) {
    const i = t.TypeParameter;
    return typeParamNames?.[i] ?? `T${i}`;
  }
  return String(t);
}

async function fetchOnePackage(
  packageId: PackageId,
  client: SuiJsonRpcClient,
  opts: { cacheDir?: string; network: string; cacheStats: { hits: number; misses: number; writes: number } }
): Promise<{ modules: Record<string, SuiMoveNormalizedModule> | null; notAPackage: boolean; error?: string }> {
  if (opts.cacheDir) {
    const cached = await readCache(opts.cacheDir, opts.network, packageId);
    if (cached) {
      opts.cacheStats.hits++;
      return { modules: cached as Record<string, SuiMoveNormalizedModule>, notAPackage: false };
    }
  }

  opts.cacheStats.misses++;
  try {
    const raw = await (client.getNormalizedMoveModulesByPackage as unknown as (args: { package: string }) => Promise<Record<string, SuiMoveNormalizedModule>>)({ package: packageId });
    if (opts.cacheDir) {
      await writeCache(opts.cacheDir, opts.network, packageId, raw);
      opts.cacheStats.writes++;
    }
    return { modules: raw, notAPackage: false };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (/object is not a package|does not exist with id|object.*not.*found/i.test(msg)) {
      return { modules: null, notAPackage: true };
    }
    return { modules: null, notAPackage: false, error: msg };
  }
}

export async function fetchSuiAbi(packageIds: PackageId[], opts: AbiFetchOptions = {}): Promise<AbiFetchResult> {
  const network = opts.network ?? "mainnet";
  const rpcUrl = resolveRpcUrl(opts);
  const concurrency = opts.concurrency ?? DEFAULT_CONCURRENCY;
  const resolvedNetwork = (opts.network ?? "mainnet") as "mainnet" | "testnet";
  const clientFactory = opts.clientFactory ?? ((url: string) => new SuiJsonRpcClient({ url, network: resolvedNetwork }));
  const client = clientFactory(rpcUrl);
  const cacheStats = { hits: 0, misses: 0, writes: 0 };

  const abi: SuiAbi = {
    scrapedAt: new Date().toISOString(),
    rpcEndpoint: rpcUrl,
    packages: {},
    mvrNames: {}
  };
  const notPackages: PackageId[] = [];
  const failures: Array<{ packageId: PackageId; error: string }> = [];

  const deduped = [...new Set(packageIds)];

  // Process in batches of `concurrency`
  for (let i = 0; i < deduped.length; i += concurrency) {
    const batch = deduped.slice(i, i + concurrency);
    const results = await Promise.all(
      batch.map((pkgId) => fetchOnePackage(pkgId, client, { cacheDir: opts.cacheDir, network, cacheStats }))
    );
    for (let j = 0; j < batch.length; j++) {
      const pkgId = batch[j]!;
      const result = results[j]!;
      if (result.notAPackage) {
        notPackages.push(pkgId);
      } else if (result.error) {
        failures.push({ packageId: pkgId, error: result.error });
      } else if (result.modules) {
        abi.packages[pkgId] = { modules: result.modules };
      }
    }
  }

  return { abi, notPackages, failures, cacheStats };
}
