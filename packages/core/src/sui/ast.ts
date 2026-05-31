import crypto from "node:crypto";
import { parse as acornParse } from "acorn";
import * as walk from "acorn-walk";
import type { ActionWorkflow, ValueRef, WorkflowStep } from "../sui-types.js";
import type { BundleChunk } from "./bundle.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AstNode = any;

const BUILDERS = new Set(["moveCall", "transferObjects", "splitCoins", "mergeCoins", "makeMoveVec"]);

export type DetectedActions = {
  actions: ActionWorkflow[];
  unresolvedRefs: Array<{ ident: string; chunkUrl: string; context: "target" | "package" }>;
  parseErrors: Array<{ chunkUrl: string; error: string }>;
};

type TargetResolution = { kind: "resolved"; value: string } | { kind: "unresolved"; ident: string; tail?: string };

type ConstStringTable = {
  global: Map<string, string>;
  scopes: Map<AstNode, Map<string, string>>;
  resolve(name: string, ancestors: AstNode[]): string | undefined;
};

function createConstStringTable(): ConstStringTable {
  return {
    global: new Map(),
    scopes: new Map(),
    resolve(name, ancestors) {
      // Walk ancestors innermost-first
      for (let i = ancestors.length - 1; i >= 0; i--) {
        const node = ancestors[i];
        if (node.type === "FunctionDeclaration" || node.type === "ArrowFunctionExpression" || node.type === "FunctionExpression") {
          const scope = this.scopes.get(node);
          if (scope?.has(name)) return scope.get(name);
        }
      }
      return this.global.get(name);
    }
  };
}

function parseChunk(chunk: BundleChunk): { ast: AstNode | null; error?: string } {
  try {
    const ast = acornParse(chunk.content, {
      ecmaVersion: "latest",
      sourceType: "module",
      allowReturnOutsideFunction: true,
      allowImportExportEverywhere: true
    });
    return { ast };
  } catch (e) {
    // fallback: try as script
    try {
      const ast = acornParse(chunk.content, {
        ecmaVersion: "latest",
        sourceType: "script",
        allowReturnOutsideFunction: true
      });
      return { ast };
    } catch (e2) {
      return { ast: null, error: String(e) };
    }
  }
}

function isScopeNode(node: AstNode): boolean {
  return (
    node.type === "FunctionDeclaration" ||
    node.type === "ArrowFunctionExpression" ||
    node.type === "FunctionExpression"
  );
}

function collectConstStrings(ast: AstNode): ConstStringTable {
  const table = createConstStringTable();
  const reassigned = new Set<string>();

  // First collect all const string declarations
  walk.ancestor(ast, {
    VariableDeclarator(node: AstNode, _state: unknown, ancestors: AstNode[]) {
      if (
        node.id?.type === "Identifier" &&
        node.init?.type === "Literal" &&
        typeof node.init.value === "string"
      ) {
        const name = node.id.name as string;
        const value = node.init.value as string;
        // Find nearest enclosing scope
        let inserted = false;
        for (let i = ancestors.length - 1; i >= 0; i--) {
          const a = ancestors[i];
          if (isScopeNode(a)) {
            if (!table.scopes.has(a)) table.scopes.set(a, new Map());
            table.scopes.get(a)!.set(name, value);
            inserted = true;
            break;
          }
        }
        if (!inserted) {
          table.global.set(name, value);
        }
      }
    },
    AssignmentExpression(node: AstNode) {
      if (node.left?.type === "Identifier") {
        reassigned.add(node.left.name as string);
      }
    }
  });

  // Remove reassigned globals (conservative)
  for (const name of reassigned) {
    table.global.delete(name);
  }

  return table;
}

function resolveTarget(node: AstNode, table: ConstStringTable, ancestors: AstNode[]): TargetResolution {
  if (!node) return { kind: "unresolved", ident: "<undefined>" };

  if (node.type === "Literal" && typeof node.value === "string") {
    return { kind: "resolved", value: node.value as string }; // Shape A/B
  }

  if (node.type === "TemplateLiteral" && node.expressions?.length === 1) {
    const expr = node.expressions[0];
    if (expr.type === "Identifier") {
      const pkg = table.resolve(expr.name as string, ancestors);
      const tail = (node.quasis as AstNode[]).map((q: AstNode) => q.value?.cooked ?? "").join("");
      if (pkg && /^0x[0-9a-f]+$/i.test(pkg) && /^::[A-Za-z_]\w*::[A-Za-z_]\w*$/.test(tail)) {
        return { kind: "resolved", value: `${pkg}${tail}` }; // Shape C
      }
      return { kind: "unresolved", ident: expr.name as string, tail };
    }
  }

  if (node.type === "Identifier") { // Shape D
    const resolved = table.resolve(node.name as string, ancestors);
    if (resolved && /^0x[0-9a-f]+::[A-Za-z_]\w*::[A-Za-z_]\w*$/.test(resolved)) {
      return { kind: "resolved", value: resolved };
    }
    return { kind: "unresolved", ident: node.name as string };
  }

  return { kind: "unresolved", ident: "<expr>" };
}

function getSourceSlice(content: string, node: AstNode): string {
  if (node.start != null && node.end != null) {
    return content.slice(node.start as number, Math.min((node.end as number), (node.start as number) + 60));
  }
  return "<expr>";
}

function renderValueRef(arg: AstNode, content: string): ValueRef {
  if (!arg) return { kind: "literal", value: "<undefined>" };

  if (arg.type === "MemberExpression") {
    const prop = arg.property?.name as string | undefined;
    if (prop === "gas") return { kind: "gas" };
    if (prop === "pure" || prop === "object") return { kind: "input", ref: prop };
  }

  if (arg.type === "CallExpression") {
    const calleeProp = arg.callee?.property?.name as string | undefined;
    if (calleeProp === "gas") return { kind: "gas" };
    if (calleeProp === "pure") return { kind: "pure" };
    if (calleeProp === "object") return { kind: "input", ref: calleeProp };
    if (calleeProp === "splitCoins" || calleeProp === "mergeCoins" || calleeProp === "transferObjects" || calleeProp === "moveCall") {
      return { kind: "result", ref: calleeProp };
    }
  }

  if (arg.type === "Identifier") {
    return { kind: "input", ref: arg.name as string };
  }

  return { kind: "literal", value: getSourceSlice(content, arg) };
}

function resolveShapeE(objExpr: AstNode, table: ConstStringTable, ancestors: AstNode[], unresolvedRefs: Array<{ ident: string; chunkUrl: string; context: "target" | "package" }>, chunkUrl: string): { target?: string; mvrMarker?: boolean } {
  let pkg: string | undefined;
  let mod: string | undefined;
  let fn: string | undefined;
  let mvrMarker = false;

  for (const prop of objExpr.properties ?? []) {
    const key = prop.key?.name ?? prop.key?.value;
    if (key === "package") {
      if (prop.value?.type === "MemberExpression" && prop.value?.property?.name === "published_at") {
        mvrMarker = true;
        const objName = prop.value?.object?.name;
        if (objName) {
          const resolved = table.resolve(objName as string, ancestors);
          pkg = resolved;
          if (!resolved) unresolvedRefs.push({ ident: `${String(objName)}.published_at`, chunkUrl, context: "package" });
        }
      } else {
        const res = resolveTarget(prop.value, table, ancestors);
        if (res.kind === "resolved") pkg = res.value;
        else unresolvedRefs.push({ ident: res.ident, chunkUrl, context: "package" });
      }
    } else if (key === "module" && prop.value?.type === "Literal") {
      mod = prop.value.value as string;
    } else if (key === "function" && prop.value?.type === "Literal") {
      fn = prop.value.value as string;
    }
  }

  if (pkg && mod && fn) return { target: `${pkg}::${mod}::${fn}`, mvrMarker };
  return { mvrMarker };
}

function buildStep(
  callNode: AstNode,
  table: ConstStringTable,
  ancestors: AstNode[],
  content: string,
  unresolvedRefs: Array<{ ident: string; chunkUrl: string; context: "target" | "package" }>,
  chunkUrl: string
): WorkflowStep {
  const methodName = callNode.callee?.property?.name as string;
  const args = (callNode.arguments ?? []) as AstNode[];

  if (methodName === "moveCall") {
    const arg0 = args[0];
    // Check if it's an object with target property (Shape A/B/C/D) or {package, module, function} (Shape E)
    if (arg0?.type === "ObjectExpression") {
      const targetProp = (arg0.properties ?? []).find((p: AstNode) => (p.key?.name ?? p.key?.value) === "target");
      if (targetProp) {
        const res = resolveTarget(targetProp.value, table, ancestors);
        let target = "";
        if (res.kind === "resolved") {
          target = res.value;
        } else {
          unresolvedRefs.push({ ident: res.ident, chunkUrl, context: "target" });
          target = `<unresolved:${res.ident}>${res.tail ?? ""}`;
        }
        const typeArgsProp = (arg0.properties ?? []).find((p: AstNode) => (p.key?.name ?? p.key?.value) === "typeArguments");
        const argsProp = (arg0.properties ?? []).find((p: AstNode) => (p.key?.name ?? p.key?.value) === "arguments");
        const typeArgsArr: string[] = typeArgsProp?.value?.elements?.map((e: AstNode) => (e?.type === "Literal" ? String(e.value) : "<expr>")) ?? [];
        const argsArr = (argsProp?.value?.elements ?? []).map((e: AstNode) => renderValueRef(e, content));
        return { kind: "moveCall", target, typeArgs: typeArgsArr, args: argsArr };
      } else {
        // Shape E
        const { target, mvrMarker } = resolveShapeE(arg0, table, ancestors, unresolvedRefs, chunkUrl);
        return {
          kind: "moveCall",
          target: target ?? "<unresolved>",
          typeArgs: [],
          args: [],
          mvrMarker
        };
      }
    } else if (arg0?.type === "Literal" && typeof arg0.value === "string") {
      // moveCall("0x...::mod::fn", [...], [...]) – positional form
      return {
        kind: "moveCall",
        target: arg0.value as string,
        typeArgs: [],
        args: (args[2] as AstNode)?.elements?.map((e: AstNode) => renderValueRef(e, content)) ?? []
      };
    }
  }

  if (methodName === "splitCoins") {
    return {
      kind: "splitCoins",
      coin: renderValueRef(args[0], content),
      amounts: ((args[1] as AstNode)?.elements ?? []).map((e: AstNode) => renderValueRef(e, content))
    };
  }

  if (methodName === "mergeCoins") {
    return {
      kind: "mergeCoins",
      destination: renderValueRef(args[0], content),
      sources: ((args[1] as AstNode)?.elements ?? []).map((e: AstNode) => renderValueRef(e, content))
    };
  }

  if (methodName === "transferObjects") {
    return {
      kind: "transferObjects",
      objects: ((args[0] as AstNode)?.elements ?? []).map((e: AstNode) => renderValueRef(e, content)),
      address: renderValueRef(args[1], content)
    };
  }

  if (methodName === "makeMoveVec") {
    return {
      kind: "makeMoveVec",
      elements: ((args[1] as AstNode)?.elements ?? []).map((e: AstNode) => renderValueRef(e, content))
    };
  }

  return { kind: "moveCall", target: `<${methodName}>`, typeArgs: [], args: [] };
}

function nameAction(steps: WorkflowStep[], fnNode: AstNode, varName?: string, labelHints?: string[]): string {
  const name = fnNode.id?.name as string | undefined;
  if (name && name.length > 3 && !/^[a-zA-Z]{1,3}$/.test(name)) return name;
  if (varName && varName.length > 3 && !/^[a-zA-Z]{1,3}$/.test(varName)) return varName;

  // synthesize from dominant moveCall target
  const moveCalls = steps.filter((s) => s.kind === "moveCall") as Array<WorkflowStep & { kind: "moveCall" }>;
  if (moveCalls.length > 0) {
    const dominant = moveCalls[0]!.target;
    const parts = dominant.split("::");
    if (parts.length >= 3) {
      const mod = parts[parts.length - 2]!;
      const fn = parts[parts.length - 1]!;
      if (mod && fn && !fn.startsWith("<")) return `${mod}_${fn}`;
    }
  }

  // co-located UI label hints (e.g. button text found in same function scope)
  if (labelHints && labelHints.length > 0) {
    // Prefer shorter, title-case strings — these look most like button labels
    const sorted = [...labelHints].sort((a, b) => a.length - b.length);
    const best = sorted[0]!;
    const normalized = labelToName(best);
    if (normalized.length >= 3) return normalized;
  }

  // hash fallback
  const sig = steps.map((s) => s.kind + (s.kind === "moveCall" ? s.target : "")).join("|");
  return `action_${crypto.createHash("sha256").update(sig).digest("hex").slice(0, 8)}`;
}

/**
 * Post-process hash-named actions using UI route/navigation labels extracted from the dApp HTML.
 * Renames actions whose names start with "action_" if a route label keyword matches the
 * action's moveCall module or function names.
 */
export function applyRouteHints(actions: ActionWorkflow[], hints: string[]): ActionWorkflow[] {
  if (hints.length === 0) return actions;

  return actions.map((action) => {
    if (!action.name.startsWith("action_")) return action;

    // Collect module/function name parts from resolved moveCall targets
    const modFns: string[] = [];
    for (const step of action.steps) {
      if (step.kind !== "moveCall") continue;
      // Skip unresolved-only parts; take the last 2 segments (mod, fn)
      const parts = step.target.split("::").filter((p) => !p.startsWith("<"));
      modFns.push(...parts.slice(-2));
    }
    if (modFns.length === 0) return action;

    // Score each hint by keyword overlap with mod/fn names
    for (const hint of hints) {
      const words = hint.split(/[_\-\s]+/).filter((w) => w.length >= 3);
      for (const word of words) {
        for (const mf of modFns) {
          if (mf.includes(word) || word.includes(mf)) {
            return { ...action, name: hint };
          }
        }
      }
    }

    return action;
  });
}

/** Regex for strings that look like human-readable UI labels */
const RE_LABEL = /^[A-Za-z][A-Za-z0-9 _\-/]{1,28}[A-Za-z0-9]$|^[A-Z][a-z]{1,20}$/;

/**
 * Walk a function node and collect string literals that look like UI labels —
 * button text, headings, tooltip content co-located with the tx builder.
 */
function collectLabelHints(fnNode: AstNode): string[] {
  const candidates: string[] = [];
  walk.simple(fnNode, {
    Literal(node: AstNode) {
      if (typeof node.value !== "string") return;
      const s = node.value.trim();
      if (!RE_LABEL.test(s)) return;
      // exclude common non-label strings
      if (/^https?:\/\/|^0x|^\.|^\/|\.json$|\.svg$|\.png$/i.test(s)) return;
      if (/^[a-z_]+$/.test(s) && !s.includes(" ")) return; // skip snake_case identifiers
      candidates.push(s);
    }
  });
  return candidates;
}

/** Normalize a UI label string to snake_case action name */
function labelToName(label: string): string {
  return label
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_|_$/g, "");
}

function collectBuilderCalls(
  ast: AstNode,
  table: ConstStringTable,
  content: string,
  unresolvedRefs: Array<{ ident: string; chunkUrl: string; context: "target" | "package" }>,
  chunkUrl: string
): Array<{ enclosing: AstNode; enclosingVarName?: string; labelHints: string[]; step: WorkflowStep }> {
  const results: Array<{ enclosing: AstNode; enclosingVarName?: string; labelHints: string[]; step: WorkflowStep }> = [];

  walk.ancestor(ast, {
    CallExpression(node: AstNode, _state: unknown, ancestors: AstNode[]) {
      const callee = node.callee;
      if (callee?.type !== "MemberExpression") return;
      if (callee.property?.type !== "Identifier") return;
      if (!BUILDERS.has(callee.property.name as string)) return;

      // Find innermost enclosing function
      let enclosing: AstNode = ast;
      let enclosingVarName: string | undefined;
      for (let i = ancestors.length - 1; i >= 0; i--) {
        const a = ancestors[i];
        if (isScopeNode(a)) {
          enclosing = a;
          // check if this fn is assigned to a variable
          if (i + 1 < ancestors.length) {
            const parent = ancestors[i + 1];
            if (parent?.type === "VariableDeclarator" && parent.id?.type === "Identifier") {
              enclosingVarName = parent.id.name as string;
            }
          }
          break;
        }
      }

      const step = buildStep(node, table, ancestors, content, unresolvedRefs, chunkUrl);
      const labelHints = collectLabelHints(enclosing);
      results.push({ enclosing, enclosingVarName, labelHints, step });
    }
  });

  return results;
}

function dedupeActions(actions: ActionWorkflow[]): ActionWorkflow[] {
  const seen = new Set<string>();
  return actions.filter((a) => {
    const sig = `${a.entry}|${a.steps.map((s) => s.kind + (s.kind === "moveCall" ? s.target : "")).join(",")}`;
    if (seen.has(sig)) return false;
    seen.add(sig);
    return true;
  });
}

export function detectActions(chunks: BundleChunk[]): DetectedActions {
  const allActions: ActionWorkflow[] = [];
  const unresolvedRefs: Array<{ ident: string; chunkUrl: string; context: "target" | "package" }> = [];
  const parseErrors: Array<{ chunkUrl: string; error: string }> = [];

  for (const chunk of chunks) {
    const { ast, error } = parseChunk(chunk);
    if (!ast) {
      if (error) parseErrors.push({ chunkUrl: chunk.url, error });
      continue;
    }

    const table = collectConstStrings(ast);
    const calls = collectBuilderCalls(ast, table, chunk.content, unresolvedRefs, chunk.url);

    // Group by enclosing function node
    const byEnclosing = new Map<AstNode, { varName?: string; labelHints: string[]; steps: WorkflowStep[] }>();
    for (const { enclosing, enclosingVarName, labelHints, step } of calls) {
      if (!byEnclosing.has(enclosing)) {
        byEnclosing.set(enclosing, { varName: enclosingVarName, labelHints, steps: [] });
      }
      byEnclosing.get(enclosing)!.steps.push(step);
    }

    for (const [fnNode, { varName, labelHints, steps }] of byEnclosing) {
      // Only include if at least one moveCall
      if (!steps.some((s) => s.kind === "moveCall")) continue;

      // Split on transferObjects (end-of-builder marker)
      let current: WorkflowStep[] = [];
      const groups: WorkflowStep[][] = [];
      for (const step of steps) {
        current.push(step);
        if (step.kind === "transferObjects") {
          groups.push(current);
          current = [];
        }
      }
      if (current.length > 0 && current.some((s) => s.kind === "moveCall")) {
        groups.push(current);
      }

      for (const group of groups) {
        if (!group.some((s) => s.kind === "moveCall")) continue;
        const name = nameAction(group, fnNode, varName, labelHints);
        const touchedObjects = group
          .filter((s) => s.kind === "moveCall")
          .flatMap((s) => (s.kind === "moveCall" ? s.args : []))
          .filter((a): a is { kind: "input"; ref?: string } => a.kind === "input" && !!("ref" in a && a.ref))
          .map((a) => ({ type: "unknown", objectId: a.ref ?? "", kindGuess: "unknown" as const }));

        allActions.push({
          name,
          entry: fnNode.id?.name ?? varName ?? name,
          steps: group,
          touchedObjects,
          inputCoins: group.filter((s) => s.kind === "splitCoins"),
          outputs: group.filter((s) => s.kind === "transferObjects")
        });
      }
    }
  }

  return { actions: dedupeActions(allActions), unresolvedRefs, parseErrors };
}
