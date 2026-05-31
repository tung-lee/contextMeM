import crypto from "node:crypto";
import type { ContextChunk } from "../chunks.js";
import type { ActionWorkflow, MoveObjectEntry, MoveObjectInventory, NormalizedPackage, SuiAbi, SuiChunkMeta, WorkflowActionSet } from "../sui-types.js";

function sha256Hex(s: string): string {
  return crypto.createHash("sha256").update(s, "utf8").digest("hex");
}

function makeSuiChunk(
  chunkId: string,
  routePath: string,
  text: string,
  meta: SuiChunkMeta
): ContextChunk & { metadata?: { sui: SuiChunkMeta } } {
  const contentHash = sha256Hex(text).slice(0, 16);
  const metaJson = JSON.stringify(meta);
  const textWithHeader = `[ctxm-chunk] ${metaJson}\n\n${text}`;
  return {
    chunkId,
    routePath,
    contentHash,
    text: textWithHeader,
    metadata: { sui: meta }
  };
}

export function moduleChunks(
  perModuleDocs: Array<{ packageId: string; module: string; content: string }>,
  host: string
): ContextChunk[] {
  return perModuleDocs.map(({ packageId, module: modName, content }) => {
    const id = sha256Hex(`${host}|sui_module|${packageId}|${modName}`).slice(0, 32);
    const meta: SuiChunkMeta = {
      kind: "sui_module",
      packageId,
      module: modName,
      contentHash: sha256Hex(content).slice(0, 16)
    };
    return makeSuiChunk(id, `/context/sui/${host}/packages/${packageId}/${modName}.md`, content, meta);
  });
}

export function actionChunks(
  perActionDocs: Array<{ name: string; content: string; packages: string[]; objects: string[] }>,
  host: string
): ContextChunk[] {
  return perActionDocs.map(({ name, content, packages, objects }) => {
    const id = sha256Hex(`${host}|sui_action|${name}`).slice(0, 32);
    const meta: SuiChunkMeta = {
      kind: "sui_action",
      action: name,
      packages,
      objects,
      contentHash: sha256Hex(content).slice(0, 16)
    };
    return makeSuiChunk(id, `/context/sui/${host}/actions/${name}.md`, content, meta);
  });
}

export function objectChunks(inventory: MoveObjectInventory, host: string): ContextChunk[] {
  const content = inventory.entries.map((e) => `${e.type}\t${e.objectId}\t${e.kindGuess}`).join("\n");
  const chunks: ContextChunk[] = [];
  for (const entry of inventory.entries) {
    const id = sha256Hex(`${host}|sui_object|${entry.type}|${entry.objectId}`).slice(0, 32);
    const objContent = `type: ${entry.type}\nobjectId: ${entry.objectId}\nkind: ${entry.kindGuess}`;
    const meta: SuiChunkMeta = {
      kind: "sui_object",
      type: entry.type,
      packageId: entry.packageId,
      module: entry.module,
      mutators: entry.mutatedBy,
      readers: entry.readBy,
      contentHash: sha256Hex(objContent).slice(0, 16)
    };
    chunks.push(makeSuiChunk(id, `/context/sui/${host}/objects.md#${entry.type}`, objContent, meta));
  }
  void content; // suppress unused
  return chunks;
}

export function abiIndexChunk(abi: SuiAbi, host: string): ContextChunk {
  for (const [pkgId, pkg] of Object.entries(abi.packages)) {
    const id = sha256Hex(`${host}|sui_abi_index|${pkgId}`).slice(0, 32);
    const moduleCount = Object.keys(pkg.modules).length;
    const structCount = Object.values(pkg.modules).reduce((acc, m) => acc + Object.keys(m.structs ?? {}).length, 0);
    const functionCount = Object.values(pkg.modules).reduce((acc, m) => acc + Object.keys(m.exposedFunctions ?? {}).length, 0);
    const meta: SuiChunkMeta = { kind: "sui_abi_index", packageId: pkgId, moduleCount, structCount, functionCount };
    const content = `ABI index: ${pkgId} (${moduleCount} modules, ${structCount} structs, ${functionCount} functions)`;
    return makeSuiChunk(id, `/context/sui/${host}/abi.json`, content, meta);
  }
  const id = sha256Hex(`${host}|sui_abi_index|empty`).slice(0, 32);
  const meta: SuiChunkMeta = { kind: "sui_abi_index", packageId: "empty", moduleCount: 0, structCount: 0, functionCount: 0 };
  return makeSuiChunk(id, `/context/sui/${host}/abi.json`, "ABI index: empty", meta);
}

export function workflowIndexChunk(workflows: WorkflowActionSet, host: string): ContextChunk {
  const id = sha256Hex(`${host}|sui_workflow_index`).slice(0, 32);
  const meta: SuiChunkMeta = {
    kind: "sui_workflow_index",
    host,
    actionCount: workflows.actions?.length ?? 0,
    bundleCount: 0
  };
  const content = `Workflow index: ${host} (${workflows.actions?.length ?? 0} actions)`;
  return makeSuiChunk(id, `/context/sui/${host}/workflows.json`, content, meta);
}

export function buildSuiChunks(
  host: string,
  perModuleDocs: Array<{ packageId: string; module: string; content: string }>,
  perActionDocs: Array<{ name: string; content: string; packages: string[]; objects: string[] }>,
  inventory: MoveObjectInventory,
  abi: SuiAbi,
  workflows: WorkflowActionSet
): ContextChunk[] {
  return [
    ...moduleChunks(perModuleDocs, host),
    ...actionChunks(perActionDocs, host),
    ...objectChunks(inventory, host),
    abiIndexChunk(abi, host),
    workflowIndexChunk(workflows, host)
  ];
}
