import fs from "node:fs/promises";
import path from "node:path";
import type { BuildProfile, RunProgress } from "../types.js";
import type { ActionWorkflow, SuiArtifacts, SuiTarget, WorkflowActionSet } from "../sui-types.js";
import type { BundleScrapeOptions } from "./bundle.js";
import { scrapeSuiBundle, extractRouteLabels } from "./bundle.js";
import { assertSafeUrl } from "./ssrf.js";
import { extractSuiRefs } from "./refs.js";
import { detectActions, applyRouteHints } from "./ast.js";
import { fetchSuiAbi } from "./abi.js";
import { inferObjectInventory } from "./inventory.js";
import { renderSuiArtifacts } from "./render.js";
import { fetchAbiExamples } from "./examples.js";
import { buildSuiChunks } from "./snapshot.js";
import { extractApiCalls } from "../api-calls.js";

export type MemWalLike = {
  rememberSnapshot(s: unknown): Promise<unknown>;
  rememberSnapshotDelta?: (s: unknown) => Promise<unknown>;
};

export type ExtractSuiOptions = {
  runDir: string;
  cacheDir?: string;
  rpcUrl?: string;
  network?: "mainnet" | "testnet";
  memwal?: { client: MemWalLike; transport: "sdk" | "mcp" | "auto" };
  buildProfile?: BuildProfile;
  bundle?: BundleScrapeOptions;
  onProgress?: (progress: RunProgress) => void;
  signal?: AbortSignal;
};

export type SuiExtractionResult = {
  artifacts: SuiArtifacts;
  cacheStats: { hits: number; misses: number; writes: number };
  runId: string;
  namespace: string;
  warnings: string[];
  errors: string[];
};

function emitProgress(opts: ExtractSuiOptions, phase: RunProgress["phase"], label?: string): void {
  opts.onProgress?.({ phase, label, updatedAt: new Date().toISOString() });
}

async function writeAtomic(filePath: string, content: string): Promise<void> {
  const tmp = `${filePath}.tmp`;
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(tmp, content, "utf8");
  await fs.rename(tmp, filePath);
}

async function updateContextManifest(runDir: string, suiIndex: { packages: string[]; actions: string[]; objects: string[] }): Promise<void> {
  const manifestPath = path.join(runDir, "context", "manifest.json");
  let manifest: Record<string, unknown> = {};
  try {
    manifest = JSON.parse(await fs.readFile(manifestPath, "utf8")) as Record<string, unknown>;
  } catch {
    // file may not exist yet — start fresh
  }
  manifest.sui = suiIndex;
  await writeAtomic(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
}

async function updateLlmsTxt(runDir: string, host: string, actions: ActionWorkflow[]): Promise<void> {
  const llmsPath = path.join(runDir, "llms.txt");
  let existing = "";
  try {
    existing = await fs.readFile(llmsPath, "utf8");
  } catch {
    existing = `# Context\n\n`;
  }

  const section = [
    `\n## Sui Mode (${host})`,
    ``,
    ...actions.map((a) => {
      const moveCalls = a.steps.filter((s) => s.kind === "moveCall").length;
      return `- **${a.name}**: ${moveCalls} moveCall${moveCalls !== 1 ? "s" : ""}`;
    }),
    ``
  ].join("\n");

  const marker = `\n## Sui Mode (${host})`;
  let updated: string;
  if (existing.includes(marker)) {
    const startIdx = existing.indexOf(marker);
    const endIdx = existing.indexOf("\n## ", startIdx + 1);
    updated = endIdx === -1 ? existing.slice(0, startIdx) + section : existing.slice(0, startIdx) + section + existing.slice(endIdx);
  } else {
    updated = existing + section;
  }

  await writeAtomic(llmsPath, updated);
}

export async function extractSuiDapp(target: SuiTarget, opts: ExtractSuiOptions): Promise<SuiExtractionResult> {
  const warnings: string[] = [];
  const errors: string[] = [];
  const network = target.network ?? opts.network ?? "mainnet";
  const namespace = `sui:${network}:${target.host}`;
  const runId = path.basename(opts.runDir);
  const cacheDir = opts.cacheDir ?? path.join(opts.runDir, ".cache", "sui-abi");

  // Step 0: validate + SSRF check
  emitProgress(opts, "resolving", `Checking ${target.url}`);
  await assertSafeUrl(target.url);

  // Check abort
  opts.signal?.throwIfAborted();

  // Step 1: bundle scrape
  emitProgress(opts, "listing_resources", `Fetching bundle from ${target.host}`);
  const bundleResult = await scrapeSuiBundle(target, {
    ...opts.bundle,
    allowLoopback: false,
    cacheDir: path.join(cacheDir, "bundle")
  });
  warnings.push(...bundleResult.warnings);

  opts.signal?.throwIfAborted();

  // Step 2: ref extraction + AST detection
  emitProgress(opts, "crawling_pages", "Extracting Sui refs and detecting tx builders");
  const refs = extractSuiRefs(bundleResult.chunks);
  const rawDetected = detectActions(bundleResult.chunks);
  for (const pe of rawDetected.parseErrors) {
    warnings.push(`AST parse error in ${pe.chunkUrl}: ${pe.error}`);
  }

  // Enrich hash-named actions using route/nav labels from the dApp HTML
  const routeHints = extractRouteLabels(bundleResult.html);
  const detected = {
    ...rawDetected,
    actions: applyRouteHints(rawDetected.actions, routeHints)
  };

  opts.signal?.throwIfAborted();

  // Step 3: ABI fetch
  const allPackageIds = [...new Set([...refs.packageIds, ...detected.actions.flatMap((a) => a.steps.filter((s) => s.kind === "moveCall").map((s) => (s.kind === "moveCall" ? s.target.split("::")[0] ?? "" : "")).filter(Boolean))])];

  emitProgress(opts, "extracting_metadata", `Fetching ABI for ${allPackageIds.length} candidate packages`);
  const { abi, notPackages, failures, cacheStats } = await fetchSuiAbi(
    allPackageIds.filter((id): id is `0x${string}` => id.startsWith("0x")),
    {
      network,
      rpcUrl: opts.rpcUrl,
      cacheDir: path.join(cacheDir, "abi")
    }
  );

  if (notPackages.length > 0) {
    warnings.push(`${notPackages.length} candidate IDs are not packages (filtered from ABI): ${notPackages.slice(0, 5).join(", ")}${notPackages.length > 5 ? "…" : ""}`);
  }
  for (const f of failures) {
    errors.push(`ABI fetch failed for ${f.packageId}: ${f.error}`);
  }

  opts.signal?.throwIfAborted();

  // Step 4: infer objects
  const objects = inferObjectInventory(detected.actions, abi);

  // Step 4b: fetch real transaction examples for all ABI entry functions
  emitProgress(opts, "building_artifacts", "Fetching on-chain transaction examples");
  const examples = await fetchAbiExamples(abi, {
    network,
    rpcUrl: opts.rpcUrl,
    maxFunctions: 80,
    maxPerFn: 2,
    enrichObjects: true,
    signal: opts.signal
  }).catch(() => new Map());

  // Step 5: render artifacts
  emitProgress(opts, "building_artifacts", "Rendering artifacts");
  const scrapedAt = new Date().toISOString();
  const workflows: WorkflowActionSet = {
    scrapedAt,
    host: target.host,
    actions: detected.actions
  };

  const rendered = renderSuiArtifacts({
    host: target.host,
    scrapedAt,
    rpcEndpoint: opts.rpcUrl ?? process.env.SUI_RPC_URL ?? `https://fullnode.${network}.sui.io`,
    abi,
    workflows,
    objects,
    examples,
    bundles: { count: bundleResult.chunks.length, totalBytes: bundleResult.chunks.reduce((acc, c) => acc + c.bytes, 0) }
  });

  // Step 6: write files
  const hostDir = path.join(opts.runDir, "context", "sui", target.host);
  for (const file of rendered.files) {
    await writeAtomic(path.join(hostDir, file.path), file.content);
  }

  // Step 6b: extract + cache API endpoint calls from bundle
  try {
    const { calls: apiCalls, authRequired, authHints, graphql } = extractApiCalls(bundleResult.chunks);
    const apiCallsPayload = { target: target.url, host: target.host, calls: apiCalls, authRequired, authHints, graphql, extractedAt: scrapedAt };
    await writeAtomic(path.join(opts.runDir, "context", "api-calls.json"), JSON.stringify(apiCallsPayload, null, 2));
  } catch { /* best-effort */ }

  // Step 7: update context manifest
  const pkgIds = Object.keys(abi.packages);
  const actionNames = detected.actions.map((a) => a.name);
  const objectTypes = objects.entries.map((e) => e.type);
  await updateContextManifest(opts.runDir, { packages: pkgIds, actions: actionNames, objects: objectTypes });

  // Step 8: update llms.txt
  await updateLlmsTxt(opts.runDir, target.host, detected.actions);

  // Step 9: MemWal snapshot
  if (opts.memwal) {
    const perModuleDocs: Array<{ packageId: string; module: string; content: string }> = [];
    for (const file of rendered.files) {
      const match = file.path.match(/^packages\/([^/]+)\/([^/]+)\.md$/);
      if (match) perModuleDocs.push({ packageId: match[1]!, module: match[2]!, content: file.content });
    }

    const perActionDocs: Array<{ name: string; content: string; packages: string[]; objects: string[] }> = [];
    for (const file of rendered.files) {
      const match = file.path.match(/^actions\/(.+)\.md$/);
      if (match) {
        const actionName = match[1]!;
        const action = detected.actions.find((a) => a.name === actionName);
        const actionPkgs = [...new Set(action?.steps.filter((s) => s.kind === "moveCall").map((s) => s.kind === "moveCall" ? s.target.split("::")[0] ?? "" : "").filter(Boolean) ?? [])];
        const actionObjs = action?.touchedObjects.map((o) => o.type) ?? [];
        perActionDocs.push({ name: actionName, content: file.content, packages: actionPkgs, objects: actionObjs });
      }
    }

    const chunks = buildSuiChunks(target.host, perModuleDocs, perActionDocs, objects, abi, workflows);

    try {
      const snapshotPayload = {
        namespace,
        target: target.url,
        createdAt: scrapedAt,
        summary: `Sui context for ${target.host}: ${pkgIds.length} packages, ${actionNames.length} actions`,
        chunks
      };
      if (chunks.length > 200 && opts.memwal.client.rememberSnapshotDelta) {
        await opts.memwal.client.rememberSnapshotDelta(snapshotPayload);
      } else {
        await opts.memwal.client.rememberSnapshot(snapshotPayload);
      }
    } catch (e) {
      warnings.push(`MemWal snapshot failed: ${String(e)}`);
    }
  }

  emitProgress(opts, "completed");

  const artifacts: SuiArtifacts = {
    host: target.host,
    scrapedAt,
    rpcEndpoint: opts.rpcUrl ?? `https://fullnode.${network}.sui.io`,
    abi,
    workflows,
    objects,
    perModuleDocs: rendered.files
      .filter((f) => f.path.startsWith("packages/"))
      .map((f) => { const m = f.path.match(/^packages\/([^/]+)\/([^/]+)\.md$/); return m ? { packageId: m[1]!, module: m[2]!, path: f.path } : null; })
      .filter((x): x is NonNullable<typeof x> => x !== null),
    perActionDocs: rendered.files
      .filter((f) => f.path.startsWith("actions/"))
      .map((f) => { const m = f.path.match(/^actions\/(.+)\.md$/); return m ? { name: m[1]!, path: f.path } : null; })
      .filter((x): x is NonNullable<typeof x> => x !== null),
    summaryPath: `context/sui/${target.host}/summary.md`
  };

  return { artifacts, cacheStats, runId, namespace, warnings, errors };
}

// Re-exports for consumers
export { scrapeSuiBundle } from "./bundle.js";
export { extractSuiRefs } from "./refs.js";
export { detectActions } from "./ast.js";
export { fetchSuiAbi, renderTypeTag } from "./abi.js";
export type { BundleScrapeResult, BundleScrapeOptions, BundleChunk } from "./bundle.js";
export type { SuiRefIndex } from "./refs.js";
export type { DetectedActions } from "./ast.js";
export type { AbiFetchOptions, AbiFetchResult } from "./abi.js";
export type { RenderedArtifacts } from "./render.js";
