import type {
  ActionWorkflow,
  Ability,
  MoveObjectEntry,
  MoveObjectInventory,
  SuiAbi,
  SuiMoveNormalizedFunction,
  SuiMoveNormalizedModule,
  SuiMoveNormalizedStruct,
  SuiMoveNormalizedType,
  WorkflowActionSet
} from "../sui-types.js";
import type { ExamplesMap } from "./examples.js";
import { renderTypeTag } from "./abi.js";

export type RenderedFile = { path: string; content: string };

export type RenderedArtifacts = {
  files: RenderedFile[];
  indexPaths: {
    abi: string;
    workflows: string;
    summary: string;
    objects: string;
  };
};

export type RenderSuiInput = {
  host: string;
  scrapedAt: string;
  rpcEndpoint: string;
  abi: SuiAbi;
  workflows: WorkflowActionSet;
  objects: MoveObjectInventory;
  examples?: ExamplesMap;
};

function lowerAbility(a: Ability): string {
  return a.toLowerCase();
}

function renderAbilities(abs: Ability[]): string {
  if (!abs || abs.length === 0) return "(none)";
  return abs.map(lowerAbility).join(", ");
}

function getTypeParamNames(count: number): string[] {
  return Array.from({ length: count }, (_, i) => `T${i}`);
}

function renderTypeParamSignature(typeParams: Array<{ constraints?: { abilities: Ability[] }; isPhantom?: boolean }>, names: string[]): string {
  if (!typeParams || typeParams.length === 0) return "";
  const parts = typeParams.map((p, i) => {
    const n = names[i] ?? `T${i}`;
    const phantom = p.isPhantom ? "phantom " : "";
    const abilities = p.constraints?.abilities ?? [];
    const constraints = abilities.length > 0 ? `: ${abilities.map(lowerAbility).join(" + ")}` : "";
    return `${phantom}${n}${constraints}`;
  });
  return `<${parts.join(", ")}>`;
}


export function renderStruct(name: string, struct: SuiMoveNormalizedStruct, pkgId: string, mod: string): string {
  const typeParamNames = getTypeParamNames(struct.typeParameters?.length ?? 0);
  const tparamSig = renderTypeParamSignature(struct.typeParameters ?? [], typeParamNames);
  const lines: string[] = [];
  lines.push(`### ${name}${tparamSig}`);
  lines.push(`- **abilities**: ${renderAbilities(struct.abilities?.abilities ?? [])}`);
  if (struct.fields && struct.fields.length > 0) {
    lines.push("");
    lines.push("| field | type |");
    lines.push("| --- | --- |");
    for (const f of struct.fields) {
      lines.push(`| \`${f.name}\` | \`${renderTypeTag(f.type as SuiMoveNormalizedType, typeParamNames)}\` |`);
    }
  }
  return lines.join("\n");
}

export function renderEnum(name: string, enumDef: { typeParameters?: unknown[]; variants: Record<string, { fields: Array<{ name: string; type: SuiMoveNormalizedType }> }> }): string {
  const typeParamNames = getTypeParamNames(enumDef.typeParameters?.length ?? 0);
  const tparamSig = renderTypeParamSignature((enumDef.typeParameters ?? []) as Array<{ constraints?: { abilities: Ability[] }; isPhantom?: boolean }>, typeParamNames);
  const lines: string[] = [];
  lines.push(`### enum ${name}${tparamSig}`);
  for (const [variantName, variant] of Object.entries(enumDef.variants).sort(([a], [b]) => a.localeCompare(b))) {
    lines.push(`\n#### ${variantName}`);
    if (!variant.fields || variant.fields.length === 0) {
      lines.push("(no fields)");
    } else {
      lines.push("| field | type |");
      lines.push("| --- | --- |");
      for (const f of variant.fields) {
        lines.push(`| \`${f.name}\` | \`${renderTypeTag(f.type, typeParamNames)}\` |`);
      }
    }
  }
  return lines.join("\n");
}

function isTxContextParam(t: SuiMoveNormalizedType): boolean {
  if (typeof t !== "object") return false;
  if ("MutableReference" in t) {
    const inner = t.MutableReference;
    if (typeof inner === "object" && "Struct" in inner) {
      const s = inner.Struct;
      return s.address === "0x2" && s.module === "tx_context" && s.name === "TxContext";
    }
  }
  if ("Reference" in t) {
    const inner = t.Reference;
    if (typeof inner === "object" && "Struct" in inner) {
      const s = inner.Struct;
      return s.address === "0x2" && s.module === "tx_context" && s.name === "TxContext";
    }
  }
  return false;
}

export function renderFunction(name: string, fn: SuiMoveNormalizedFunction, _pkgId: string, _mod: string): string {
  const typeParamNames = getTypeParamNames(fn.typeParameters?.length ?? 0);
  const params = fn.parameters ?? [];
  const hasTxContext = params.length > 0 && isTxContextParam(params[params.length - 1]!);
  const visibleParams = hasTxContext ? params.slice(0, -1) : params;
  const returns = fn.return ?? [];

  const visibility = fn.visibility === "Public" ? "public" : fn.visibility === "Friend" ? "public(friend)" : "private";
  const entryMark = fn.isEntry ? " entry" : "";
  const tparamSig = renderTypeParamSignature((fn.typeParameters ?? []).map((p) => ({ constraints: { abilities: p.abilities }, isPhantom: false })), typeParamNames);
  const paramStr = visibleParams.map((p, i) => `param${i}: ${renderTypeTag(p as SuiMoveNormalizedType, typeParamNames)}`).join(", ");
  const returnStr = returns.length === 0 ? "" : ": " + (returns.length === 1 ? renderTypeTag(returns[0]! as SuiMoveNormalizedType, typeParamNames) : `(${returns.map((r) => renderTypeTag(r as SuiMoveNormalizedType, typeParamNames)).join(", ")})`);

  const lines: string[] = [];
  lines.push(`### \`${visibility}${entryMark} ${name}${tparamSig}(${paramStr})${returnStr}\``);
  lines.push(`- **visibility**: ${visibility}${fn.isEntry ? ", entry" : ""}`);

  if (typeParamNames.length > 0) {
    lines.push(`- **type params**: ${typeParamNames.join(", ")}`);
  }
  if (visibleParams.length > 0) {
    lines.push(`- **params**: ${visibleParams.map((p, i) => `param${i}: \`${renderTypeTag(p as SuiMoveNormalizedType, typeParamNames)}\``).join(", ")}`);
  }
  if (returns.length > 0) {
    lines.push(`- **returns**: ${returns.map((r) => `\`${renderTypeTag(r as SuiMoveNormalizedType, typeParamNames)}\``).join(", ")}`);
  }
  if (hasTxContext) {
    lines.push(`\n> implicit final \`&mut TxContext\` argument elided.`);
  }
  return lines.join("\n");
}

export function renderModule(pkgId: string, modName: string, mod: SuiMoveNormalizedModule): string {
  const lines: string[] = [];
  lines.push(`# ${pkgId}::${modName}`);
  lines.push("");
  lines.push(`**Package**: \`${pkgId}\``);
  if (mod.friends && mod.friends.length > 0) {
    lines.push(`**Friends**: ${mod.friends.map((f) => `\`${f.address}::${f.name}\``).join(", ")}`);
  }

  // Structs
  const structEntries = Object.entries(mod.structs ?? {}).sort(([a], [b]) => a.localeCompare(b));
  if (structEntries.length > 0) {
    lines.push("\n## Structs");
    for (const [name, struct] of structEntries) {
      lines.push("");
      lines.push(renderStruct(name, struct as SuiMoveNormalizedStruct, pkgId, modName));
    }
  }

  // Enums (Move 2024)
  const enumEntries = Object.entries((mod as unknown as { enums?: Record<string, unknown> }).enums ?? {}).sort(([a], [b]) => a.localeCompare(b));
  if (enumEntries.length > 0) {
    lines.push("\n## Enums");
    for (const [name, enumDef] of enumEntries) {
      lines.push("");
      lines.push(renderEnum(name, enumDef as { typeParameters?: unknown[]; variants: Record<string, { fields: Array<{ name: string; type: SuiMoveNormalizedType }> }> }));
    }
  }

  // Functions
  const fnEntries = Object.entries(mod.exposedFunctions ?? {}).sort(([a], [b]) => a.localeCompare(b));
  if (fnEntries.length > 0) {
    lines.push("\n## Functions");
    for (const [name, fn] of fnEntries) {
      lines.push("");
      lines.push(renderFunction(name, fn as SuiMoveNormalizedFunction, pkgId, modName));
    }
  }

  return lines.join("\n");
}

function renderArgRef(a: import("../sui-types.js").ValueRef): string {
  if (a.kind === "gas") return "gas";
  if (a.kind === "pure") return ("ref" in a && a.ref) ? `pure(${a.ref})` : "pure(…)";
  if (a.kind === "input") return ("ref" in a && a.ref) ? a.ref : "<input>";
  if (a.kind === "result") return ("ref" in a && a.ref) ? `result(${a.ref})` : "result";
  if (a.kind === "literal") return ("value" in a) ? String(a.value).slice(0, 40) : "<literal>";
  return "<expr>";
}

export function renderAction(action: ActionWorkflow, abi: SuiAbi, examples?: import("./examples.js").ExamplesMap): string {
  const lines: string[] = [];
  lines.push(`# ${action.name}`);
  lines.push("");
  if (action.entry) lines.push(`**Source**: \`${action.entry}\``);
  lines.push("");
  lines.push("## Steps");

  action.steps.forEach((step, i) => {
    lines.push("");
    const n = i + 1;

    if (step.kind === "moveCall") {
      const parts = step.target.split("::");
      const pkg = parts[0] ?? "";
      const mod = parts[1] ?? "";
      const fn = parts[2] ?? "";
      const isResolved = pkg.startsWith("0x") && !pkg.startsWith("<");

      lines.push(`### Step ${n} — moveCall`);
      if (isResolved) {
        lines.push(`**Target**: \`${step.target}\``);
      } else {
        // partially unresolved: show whatever we have
        const displayMod = mod && !mod.startsWith("<") ? mod : "?";
        const displayFn = fn && !fn.startsWith("<") ? fn : "?";
        lines.push(`**Target**: \`${displayMod}::${displayFn}\` _(package ID unresolved at build time)_`);
      }

      if (step.typeArgs?.length) {
        lines.push(`**Type args**: ${step.typeArgs.map((t) => `\`${t}\``).join(", ")}`);
      }

      // Look up ABI parameter types for this function
      let abiParams: import("../sui-types.js").SuiMoveNormalizedType[] | undefined;
      const typeParams: string[] = [];
      if (isResolved && pkg && mod && fn) {
        const funcDef = abi.packages[pkg]?.modules[mod]?.exposedFunctions[fn] as SuiMoveNormalizedFunction | undefined;
        if (funcDef) {
          abiParams = funcDef.parameters as import("../sui-types.js").SuiMoveNormalizedType[];
          for (let ti = 0; ti < (funcDef.typeParameters?.length ?? 0); ti++) {
            typeParams.push(`T${ti}`);
          }
        }
      }

      // Find a real transaction example for this target
      const exampleArgs = isResolved ? (examples?.get(step.target)?.[0]?.args ?? []) : [];

      const args = step.args ?? [];
      if (args.length > 0) {
        lines.push("");
        const hasExamples = exampleArgs.length > 0;
        if (hasExamples) {
          lines.push("| # | Argument | ABI type | Example value |");
          lines.push("| - | -------- | -------- | ------------- |");
        } else {
          lines.push("| # | Argument | ABI type |");
          lines.push("| - | -------- | -------- |");
        }
        args.forEach((a, ai) => {
          const argLabel = renderArgRef(a);
          const typeLabel = abiParams?.[ai] != null ? `\`${renderTypeTag(abiParams[ai]!, typeParams)}\`` : "—";
          if (hasExamples) {
            const ex = exampleArgs[ai];
            let exLabel = "—";
            if (ex) {
              if (ex.kind === "object") {
                const typeSuffix = ex.objectTypeName ? ` (${ex.objectTypeName.split("::").slice(-1)[0]})` : "";
                const mutSuffix = ex.objectType === "sharedObject" ? (ex.mutable ? " shared-mut" : " shared-ro") : " owned";
                exLabel = `\`${ex.objectId?.slice(0, 12)}…\`${typeSuffix}${mutSuffix}`;
              } else if (ex.kind === "pure") {
                exLabel = ex.value != null ? `\`${String(ex.value).slice(0, 30)}\`` : "—";
              } else if (ex.kind === "gas") {
                exLabel = "_gas coin_";
              }
            }
            lines.push(`| ${ai + 1} | \`${argLabel}\` | ${typeLabel} | ${exLabel} |`);
          } else {
            lines.push(`| ${ai + 1} | \`${argLabel}\` | ${typeLabel} |`);
          }
        });
      } else {
        lines.push("_(no arguments detected)_");
      }
    } else if (step.kind === "splitCoins") {
      const coinRef = renderArgRef(step.coin);
      const amounts = (step.amounts ?? []).map(renderArgRef).join(", ");
      lines.push(`### Step ${n} — splitCoins`);
      lines.push(`Split \`${coinRef}\` into amounts: [${amounts || "…"}]`);
    } else if (step.kind === "mergeCoins") {
      const dest = renderArgRef(step.destination);
      const srcs = (step.sources ?? []).map(renderArgRef).join(", ");
      lines.push(`### Step ${n} — mergeCoins`);
      lines.push(`Merge [${srcs || "…"}] into \`${dest}\``);
    } else if (step.kind === "transferObjects") {
      const objs = (step.objects ?? []).map(renderArgRef).join(", ");
      const addr = renderArgRef(step.address);
      lines.push(`### Step ${n} — transferObjects`);
      lines.push(`Transfer [${objs || "…"}] to \`${addr}\``);
    } else if (step.kind === "makeMoveVec") {
      lines.push(`### Step ${n} — makeMoveVec`);
      lines.push(`Build Move vector from ${(step.elements ?? []).length} element(s)`);
    }
  });

  return lines.join("\n");
}

export function renderObjects(inventory: MoveObjectInventory): string {
  const lines: string[] = [];
  lines.push("# Objects");
  lines.push("");
  lines.push("Shared and touched objects detected via bundle analysis.");
  lines.push("");

  if (!inventory.entries || inventory.entries.length === 0) {
    lines.push("_(no objects detected)_");
    return lines.join("\n");
  }

  // Group by type
  const byType = new Map<string, MoveObjectEntry[]>();
  for (const entry of inventory.entries) {
    const key = entry.type;
    if (!byType.has(key)) byType.set(key, []);
    byType.get(key)!.push(entry);
  }

  for (const [type, entries] of [...byType.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    lines.push(`## \`${type}\``);
    lines.push(`- **kind**: ${entries[0]?.kindGuess ?? "unknown"}`);
    const pkg = type.split("::")[0];
    if (pkg) lines.push(`- **package**: \`${pkg}\``);
    if (entries[0]?.readBy?.length) lines.push(`- **read by**: ${entries[0].readBy.map((f) => `\`${f}\``).join(", ")}`);
    if (entries[0]?.mutatedBy?.length) lines.push(`- **mutated by**: ${entries[0].mutatedBy.map((f) => `\`${f}\``).join(", ")}`);
    if (entries.length > 1) {
      lines.push("");
      lines.push("| object id | kind |");
      lines.push("| --- | --- |");
      for (const e of entries) {
        lines.push(`| \`${e.objectId}\` | ${e.kindGuess} |`);
      }
    }
    lines.push("");
  }

  return lines.join("\n");
}

export function renderSummary(input: RenderSuiInput & { bundles?: { count: number; totalBytes: number }; mvrNames?: Record<string, string> }): string {
  const pkgCount = Object.keys(input.abi.packages).length;
  const actionList = input.workflows.actions ?? [];
  const mvrNames = input.mvrNames ?? {};
  const mvrCoverage = Object.keys(mvrNames).length;

  const lines: string[] = [];
  lines.push(`# Sui Context: ${input.host}`);
  lines.push(`\n> Generated: ${input.scrapedAt}`);
  lines.push(`> RPC: ${input.rpcEndpoint}`);
  lines.push(`> MVR coverage: ${mvrCoverage}/${pkgCount} packages (${mvrCoverage === 0 ? "deferred to v2" : "partial"})`);
  lines.push("\n## Packages");
  lines.push(`Discovered **${pkgCount}** packages.`);
  lines.push("");
  for (const [pkgId, pkg] of Object.entries(input.abi.packages).sort(([a], [b]) => a.localeCompare(b))) {
    const modCount = Object.keys(pkg.modules).length;
    const mvrName = mvrNames[pkgId] ? ` (${mvrNames[pkgId]})` : "";
    lines.push(`- \`${pkgId}\`${mvrName} — ${modCount} module${modCount !== 1 ? "s" : ""}`);
  }

  lines.push("\n## Actions");
  lines.push(`Detected **${actionList.length}** transaction builder actions.`);
  lines.push("");
  for (const a of actionList) {
    const moveCalls = a.steps.filter((s) => s.kind === "moveCall").length;
    lines.push(`- **${a.name}** — ${moveCalls} moveCall${moveCalls !== 1 ? "s" : ""}, ${a.touchedObjects?.length ?? 0} touched object${(a.touchedObjects?.length ?? 0) !== 1 ? "s" : ""}`);
  }

  lines.push("\n## Limitations");
  lines.push("- Normalized-module RPC does not expose Move `const` declarations; constants are omitted from ABI docs.");
  lines.push("- Shared-vs-owned inference is heuristic — objects tagged `unknown` may be shared or owned; see `objects.md`.");
  lines.push("- MVR friendly names deferred to v2; all packages shown by address only.");
  if (input.bundles) {
    lines.push(`- Bundle: ${input.bundles.count} chunk${input.bundles.count !== 1 ? "s" : ""} fetched, ${(input.bundles.totalBytes / 1024 / 1024).toFixed(1)} MB total.`);
  }

  return lines.join("\n");
}

function sortKeysDeep(obj: unknown): unknown {
  if (Array.isArray(obj)) return obj.map(sortKeysDeep);
  if (obj && typeof obj === "object") {
    return Object.fromEntries(
      Object.entries(obj as Record<string, unknown>)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => [k, sortKeysDeep(v)])
    );
  }
  return obj;
}

export function serializeAbi(abi: SuiAbi): string {
  return JSON.stringify(sortKeysDeep(abi), null, 2);
}

export function serializeWorkflows(workflows: WorkflowActionSet): string {
  return JSON.stringify(sortKeysDeep(workflows), null, 2);
}

function slugifyAction(name: string, seen: Map<string, number>): string {
  const slug = name
    .replace(/[/\\:]/g, "_")
    .slice(0, 80);
  const count = seen.get(slug) ?? 0;
  seen.set(slug, count + 1);
  return count === 0 ? slug : `${slug}-${count + 1}`;
}

export function renderEntryFunctionAction(
  pkgId: string,
  modName: string,
  fnName: string,
  fn: SuiMoveNormalizedFunction,
  examples?: import("./examples.js").FunctionExample[]
): string {
  const lines: string[] = [];
  lines.push(`# ${modName}::${fnName}`);
  lines.push("");
  lines.push(`**Package**: \`${pkgId}\``);
  lines.push(`**Visibility**: ${fn.visibility?.toLowerCase() ?? "public"} | **Entry**: ${fn.isEntry ? "yes" : "no"}`);
  lines.push("");

  const typeParams = getTypeParamNames(fn.typeParameters?.length ?? 0);
  const params = (fn.parameters ?? []) as SuiMoveNormalizedType[];

  if (params.length > 0) {
    lines.push("## Parameters");
    lines.push("");

    const exArgs = examples?.[0]?.args ?? [];
    const hasExamples = exArgs.length > 0;

    if (hasExamples) {
      lines.push("| # | Move type | Example value |");
      lines.push("| - | --------- | ------------- |");
    } else {
      lines.push("| # | Move type |");
      lines.push("| - | --------- |");
    }

    params.forEach((p, i) => {
      const typeStr = `\`${renderTypeTag(p, typeParams)}\``;
      if (hasExamples) {
        const ex = exArgs[i];
        let exLabel = "—";
        if (ex) {
          if (ex.kind === "object") {
            const typeSuffix = ex.objectTypeName
              ? ` — \`${ex.objectTypeName.split("::").pop()}\``
              : "";
            const mutLabel = ex.objectType === "sharedObject"
              ? (ex.mutable ? "shared-mut" : "shared-ro")
              : "owned";
            exLabel = `\`${(ex.objectId ?? "").slice(0, 12)}…\` (${mutLabel})${typeSuffix}`;
          } else if (ex.kind === "pure") {
            exLabel = ex.value != null ? `\`${String(ex.value).slice(0, 40)}\`` : "—";
          } else if (ex.kind === "gas") {
            exLabel = "_gas coin_";
          } else if (ex.kind === "result") {
            exLabel = "_prior step result_";
          }
        }
        lines.push(`| ${i + 1} | ${typeStr} | ${exLabel} |`);
      } else {
        lines.push(`| ${i + 1} | ${typeStr} |`);
      }
    });
    lines.push("");
  }

  const returns = (fn.return ?? []) as SuiMoveNormalizedType[];
  if (returns.length > 0) {
    lines.push("## Returns");
    lines.push("");
    for (const r of returns) {
      lines.push(`- \`${renderTypeTag(r, typeParams)}\``);
    }
    lines.push("");
  }

  if (examples && examples.length > 0) {
    lines.push("## Recent transactions");
    lines.push("");
    for (const ex of examples.slice(0, 3)) {
      lines.push(`- \`${ex.digest}\``);
    }
  }

  return lines.join("\n");
}

export function renderSuiArtifacts(input: RenderSuiInput & { bundles?: { count: number; totalBytes: number }; mvrNames?: Record<string, string> }): RenderedArtifacts {
  const files: RenderedFile[] = [];
  const actionSlugsSeen = new Map<string, number>();

  // Per-module markdown
  for (const [pkgId, pkg] of Object.entries(input.abi.packages).sort(([a], [b]) => a.localeCompare(b))) {
    for (const [modName, mod] of Object.entries(pkg.modules).sort(([a], [b]) => a.localeCompare(b))) {
      files.push({
        path: `packages/${pkgId}/${modName}.md`,
        content: renderModule(pkgId, modName, mod)
      });
    }
  }

  // Per-entry-function action docs (ABI + on-chain tx examples — primary source)
  for (const [pkgId, pkg] of Object.entries(input.abi.packages).sort(([a], [b]) => a.localeCompare(b))) {
    for (const [modName, mod] of Object.entries(pkg.modules).sort(([a], [b]) => a.localeCompare(b))) {
      for (const [fnName, fn] of Object.entries((mod.exposedFunctions ?? {}) as Record<string, SuiMoveNormalizedFunction>).sort(([a], [b]) => a.localeCompare(b))) {
        if (!(fn as SuiMoveNormalizedFunction).isEntry) continue;
        const target = `${pkgId}::${modName}::${fnName}`;
        const fnExamples = input.examples?.get(target);
        const slug = slugifyAction(`${modName}_${fnName}`, actionSlugsSeen);
        files.push({
          path: `actions/${slug}.md`,
          content: renderEntryFunctionAction(pkgId, modName, fnName, fn as SuiMoveNormalizedFunction, fnExamples)
        });
      }
    }
  }

  // objects.md
  files.push({ path: "objects.md", content: renderObjects(input.objects) });

  // abi.json
  files.push({ path: "abi.json", content: serializeAbi(input.abi) });

  // workflows.json
  files.push({
    path: "workflows.json",
    content: serializeWorkflows(input.workflows)
  });

  // summary.md
  files.push({ path: "summary.md", content: renderSummary(input) });

  return {
    files,
    indexPaths: {
      abi: "abi.json",
      workflows: "workflows.json",
      summary: "summary.md",
      objects: "objects.md"
    }
  };
}
