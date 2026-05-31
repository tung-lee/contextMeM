import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildPublishReadiness, diffRunSnapshots, listArtifactFiles, listRuns, resolveArtifactFile } from "./runs.js";
import type { RunManifest, WalrusPackageManifest } from "./types.js";

let tmp: string;

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), "contextmem-runs-"));
});

afterEach(async () => {
  await fs.rm(tmp, { recursive: true, force: true });
});

describe("run history and artifacts", () => {
  it("ignores invalid run folders and lists valid runs newest first", async () => {
    await fs.mkdir(path.join(tmp, "invalid"), { recursive: true });
    await writeRun("older", "2026-01-01T00:00:00.000Z", "hash-a");
    await writeRun("newer", "2026-01-02T00:00:00.000Z", "hash-b");

    const runs = await listRuns(tmp);

    expect(runs.map((run) => run.runId)).toEqual(["newer", "older"]);
    expect(runs[0]?.pages).toBe(1);
  });

  it("blocks artifact path traversal", async () => {
    await writeRun("safe", "2026-01-01T00:00:00.000Z", "hash");

    await expect(resolveArtifactFile(path.join(tmp, "safe"), "/../secret.txt")).rejects.toThrow(/escapes/);
  });

  it("groups package artifacts and reports publish readiness", async () => {
    await writeRun("ready", "2026-01-01T00:00:00.000Z", "hash");
    await fs.writeFile(path.join(tmp, "ready", "index.html"), "<!doctype html>");
    await fs.writeFile(path.join(tmp, "ready", "llms.txt"), "# Context");
    await fs.writeFile(path.join(tmp, "ready", "ws-resources.json"), "{}");

    const files = await listArtifactFiles(path.join(tmp, "ready"));
    const readiness = await buildPublishReadiness(path.join(tmp, "ready"), "ready");

    expect(files.some((file) => file.path === "/context/manifest.json" && file.group === "core")).toBe(true);
    expect(readiness.ready).toBe(true);
    expect(readiness.commands.publish).toContain("site-builder publish");
  });
});

describe("sui mode artifact classification and readiness", () => {
  it("classifies /context/sui/ files as group 'sui'", async () => {
    const runDir = path.join(tmp, "sui-run");
    await fs.mkdir(path.join(runDir, "context", "sui", "app.cetus.zone"), { recursive: true });
    await fs.writeFile(path.join(runDir, "context", "sui", "app.cetus.zone", "abi.json"), "{}");

    const files = await listArtifactFiles(runDir);

    const abiFile = files.find((f) => f.path === "/context/sui/app.cetus.zone/abi.json");
    expect(abiFile).toBeDefined();
    expect(abiFile?.group).toBe("sui");
  });

  it("buildPublishReadiness: sui mode requires sui-specific paths and not web paths", async () => {
    const runDir = path.join(tmp, "sui-ready");
    const host = "app.cetus.zone";
    await fs.mkdir(path.join(runDir, "context", "sui", host), { recursive: true });
    const manifest: RunManifest = {
      runId: "sui-ready",
      target: `https://${host}/swap`,
      normalizedTarget: `https://${host}/swap`,
      targetKind: "url",
      mode: "sui",
      status: "completed",
      createdAt: "2026-05-31T00:00:00.000Z",
      updatedAt: "2026-05-31T00:00:00.000Z",
      namespace: `sui:${host}`,
      outputs: ["abi"],
      errors: [],
      artifactDir: runDir
    };
    await fs.writeFile(path.join(runDir, "manifest.json"), JSON.stringify(manifest));
    await fs.writeFile(path.join(runDir, "context", "manifest.json"), "{}");
    await fs.writeFile(path.join(runDir, "context", "sui", host, "abi.json"), "{}");
    await fs.writeFile(path.join(runDir, "context", "sui", host, "workflows.json"), "{}");
    await fs.writeFile(path.join(runDir, "context", "sui", host, "summary.md"), "# summary");

    const readiness = await buildPublishReadiness(runDir, "sui-ready");

    expect(readiness.ready).toBe(true);
    // sui mode must not require web-only paths
    expect(readiness.required.map((r) => r.path)).not.toContain("/index.html");
    expect(readiness.required.map((r) => r.path)).not.toContain("/llms.txt");
    // must require the sui-specific paths
    expect(readiness.required.map((r) => r.path)).toContain(`/context/sui/${host}/abi.json`);
    expect(readiness.required.map((r) => r.path)).toContain(`/context/sui/${host}/workflows.json`);
    expect(readiness.required.map((r) => r.path)).toContain(`/context/sui/${host}/summary.md`);
  });
});

describe("site snapshot diff", () => {
  it("detects changed pages, resources, images, and design tokens", async () => {
    await writeRun("before", "2026-01-01T00:00:00.000Z", "hash-a", "#111111");
    await writeRun("after", "2026-01-02T00:00:00.000Z", "hash-b", "#222222");

    const diff = await diffRunSnapshots(tmp, "after", "before");

    expect(diff.summary.pages.changed).toBe(1);
    expect(diff.summary.resources.changed).toBe(1);
    expect(diff.summary.images.unchanged).toBe(1);
    expect(diff.summary.designTokens.changed).toBe(1);
  });
});

async function writeRun(runId: string, updatedAt: string, contentHash: string, color = "#111111"): Promise<void> {
  const runDir = path.join(tmp, runId);
  await fs.mkdir(path.join(runDir, "context"), { recursive: true });
  const manifest: RunManifest = {
    runId,
    target: "https://example.com/",
    normalizedTarget: "https://example.com/",
    targetKind: "url",
    mode: "web",
    status: "completed",
    createdAt: updatedAt,
    updatedAt,
    namespace: "web:example.com",
    outputs: ["markdown"],
    errors: [],
    artifactDir: runDir
  };
  const context: WalrusPackageManifest = {
    runId,
    target: manifest.target,
    outputDir: runDir,
    contextDir: path.join(runDir, "context"),
    generatedAt: updatedAt,
    pages: [
      {
        url: "https://example.com/",
        routePath: "/",
        title: "Example",
        statusCode: 200,
        contentType: "text/html",
        markdown: "# Example",
        html: "<main>Example</main>",
        text: "Example",
        metadata: {},
        links: [],
        images: [],
        contentHash
      }
    ],
    images: [
      {
        src: "/logo.svg",
        absoluteUrl: "https://example.com/logo.svg",
        element: "img",
        type: "url",
        role: "logo"
      }
    ],
    designSystem: {
      generatedAt: updatedAt,
      identity: { confidence: 0.8 },
      tokens: {
        colors: [{ name: "color.brand.primary", value: color, role: "brand", aliases: [], usage: [] }],
        rawPalette: [color],
        cssVariables: {},
        typography: { fontFamilies: [], scale: [], headings: [] },
        spacing: [],
        radii: [],
        shadows: [],
        borders: [],
        layout: { breakpoints: [], maxWidths: [], zIndices: [] }
      },
      components: [],
      assets: [],
      motion: [],
      exports: {
        figmaTokens: "/context/figma.tokens.json",
        styleDictionary: "/context/style-dictionary.json",
        tailwindTheme: "/context/tailwind.theme.json",
        tokensCss: "/context/tokens.css",
        webBrandKit: "/context/web-brand-kit.json",
        videoBrandKit: "/context/video-brand-kit.json",
        markdown: "/context/design-system.md",
        rawJson: "/context/design-system.json"
      },
      provenance: { sourceRoutes: [], resourcePaths: [], walrusBlobIds: [] }
    },
    walrus: {
      site: {
        network: "mainnet",
        siteObjectId: `0x${"1".repeat(64)}`,
        sitePackage: "pkg",
        rpcUrl: "https://fullnode.mainnet.sui.io",
        aggregatorUrl: "https://aggregator.walrus-mainnet.walrus.space"
      },
      resources: [
        {
          path: "/index.html",
          headers: {},
          blobId: `blob-${contentHash}`,
          blobHash: contentHash,
          range: null
        }
      ]
    }
  };
  await fs.writeFile(path.join(runDir, "manifest.json"), `${JSON.stringify(manifest)}\n`);
  await fs.writeFile(path.join(runDir, "context", "manifest.json"), `${JSON.stringify(context)}\n`);
  await fs.writeFile(path.join(runDir, "context", "sitemap.json"), "{}");
  await fs.writeFile(path.join(runDir, "context", "site-structure.json"), "{}");
  await fs.writeFile(path.join(runDir, "context", "images.json"), "[]");
}
