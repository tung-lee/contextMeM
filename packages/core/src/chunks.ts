import fs from "node:fs/promises";
import path from "node:path";
import type { PageArtifact } from "./types.js";
import { sha256Hex } from "./utils.js";

export type ContextChunk = {
  chunkId: string;
  routePath: string;
  heading?: string;
  headingPath?: string;
  contentHash: string;
  text: string;
};

export type MemoryWritePlan = {
  added: ContextChunk[];
  changed: ContextChunk[];
  unchanged: ContextChunk[];
  removed: ContextChunk[];
};

export function planMemoryWrite(current: ContextChunk[], prior: ContextChunk[]): MemoryWritePlan {
  const priorMap = new Map(prior.map((c) => [c.chunkId, c]));
  const currentMap = new Map(current.map((c) => [c.chunkId, c]));
  const added: ContextChunk[] = [];
  const changed: ContextChunk[] = [];
  const unchanged: ContextChunk[] = [];
  const removed: ContextChunk[] = [];

  for (const chunk of current) {
    const prev = priorMap.get(chunk.chunkId);
    if (!prev) added.push(chunk);
    else if (prev.contentHash !== chunk.contentHash) changed.push(chunk);
    else unchanged.push(chunk);
  }
  for (const chunk of prior) {
    if (!currentMap.has(chunk.chunkId)) removed.push(chunk);
  }
  return { added, changed, unchanged, removed };
}

export function buildChunks(pages: PageArtifact[]): ContextChunk[] {
  const chunks: ContextChunk[] = [];
  for (const page of pages) {
    const routePath = page.routePath ?? new URL(page.url, "http://x").pathname;
    const markdown = page.markdown ?? "";
    const sections = splitByHeadings(markdown);
    for (const section of sections) {
      const chunkId = sha256Hex(`${routePath}|${section.headingPath ?? ""}`).slice(0, 32);
      chunks.push({
        chunkId,
        routePath,
        heading: section.heading,
        headingPath: section.headingPath,
        contentHash: sha256Hex(section.text).slice(0, 16),
        text: section.text
      });
    }
  }
  return chunks;
}

export function chunkGraphDigest(chunks: ContextChunk[]): string {
  const payload = chunks.map((c) => `${c.chunkId}:${c.contentHash}`).join("\n");
  return sha256Hex(payload).slice(0, 32);
}

export function renderChunksNdjson(chunks: ContextChunk[]): string {
  return chunks.map((c) => JSON.stringify(c)).join("\n") + (chunks.length ? "\n" : "");
}

export function parseChunksNdjson(text: string): ContextChunk[] {
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line) as ContextChunk);
}

export async function findPriorRunForNamespace(runsDir: string, currentRunId: string, namespace: string): Promise<string | undefined> {
  let entries: string[] = [];
  try {
    entries = await fs.readdir(runsDir);
  } catch {
    return undefined;
  }
  const candidates: { runId: string; updatedAt: string }[] = [];
  for (const entry of entries) {
    if (entry === currentRunId) continue;
    try {
      const manifestPath = path.join(runsDir, entry, "manifest.json");
      const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8")) as { namespace?: string; updatedAt?: string };
      if (manifest.namespace === namespace && manifest.updatedAt) {
        candidates.push({ runId: entry, updatedAt: manifest.updatedAt });
      }
    } catch {
      continue;
    }
  }
  if (!candidates.length) return undefined;
  candidates.sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
  return path.join(runsDir, candidates[0]!.runId);
}

type HeadingSection = { heading?: string; headingPath?: string; text: string };

function splitByHeadings(markdown: string): HeadingSection[] {
  const lines = markdown.split("\n");
  const sections: HeadingSection[] = [];
  let current: string[] = [];
  let currentHeading: string | undefined;
  let currentPath: string | undefined;
  const headingStack: string[] = [];

  const flush = () => {
    const text = current.join("\n").trim();
    if (text) sections.push({ heading: currentHeading, headingPath: currentPath, text });
    current = [];
  };

  for (const line of lines) {
    const h2 = line.match(/^##\s+(.+)/);
    const h3 = line.match(/^###\s+(.+)/);
    if (h2) {
      flush();
      headingStack.length = 0;
      headingStack.push(h2[1]!.trim());
      currentHeading = headingStack[headingStack.length - 1];
      currentPath = headingStack.join(" > ");
    } else if (h3) {
      flush();
      headingStack.splice(1);
      headingStack.push(h3[1]!.trim());
      currentHeading = headingStack[headingStack.length - 1];
      currentPath = headingStack.join(" > ");
    } else {
      current.push(line);
    }
  }
  flush();
  return sections;
}
