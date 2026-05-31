import { SuiJsonRpcClient, getJsonRpcFullnodeUrl } from "@mysten/sui/jsonRpc";
import type { SuiCallArg, SuiArgument } from "@mysten/sui/jsonRpc";
import type { SuiAbi, SuiNetwork } from "../sui-types.js";

export type ResolvedArgKind = "gas" | "object" | "pure" | "result";

export type ResolvedArg = {
  kind: ResolvedArgKind;
  /** For object args: on-chain object ID */
  objectId?: string;
  /** shared / immOrOwned / receiving */
  objectType?: string;
  /** true for shared mutable objects (e.g. pools) */
  mutable?: boolean;
  /** Concrete Move type resolved from on-chain, e.g. "0xPKG::pool::Pool<...>" */
  objectTypeName?: string;
  /** For pure args: the Move type string, e.g. "u64", "address" */
  valueType?: string;
  /** For pure args: the actual encoded value */
  value?: string;
};

export type FunctionExample = {
  digest: string;
  args: ResolvedArg[];
};

/** Map from "0xPKG::module::function" → up to N recent real examples */
export type ExamplesMap = Map<string, FunctionExample[]>;

export type FetchExamplesOptions = {
  network?: SuiNetwork;
  rpcUrl?: string;
  maxPerFn?: number;
  enrichObjects?: boolean;
  clientFactory?: (url: string) => SuiJsonRpcClient;
  signal?: AbortSignal;
};

function makeClient(opts: FetchExamplesOptions): SuiJsonRpcClient {
  const url = resolveRpc(opts);
  if (opts.clientFactory) return opts.clientFactory(url);
  return new SuiJsonRpcClient({ url, network: opts.network ?? "mainnet" });
}

function resolveRpc(opts: FetchExamplesOptions): string {
  return opts.rpcUrl ?? process.env.SUI_RPC_URL ?? getJsonRpcFullnodeUrl(opts.network ?? "mainnet");
}

function resolveCallArg(arg: SuiArgument, inputs: SuiCallArg[]): ResolvedArg {
  if (arg === "GasCoin") return { kind: "gas" };
  if (typeof arg === "object" && "Result" in arg) return { kind: "result" };
  if (typeof arg === "object" && "NestedResult" in arg) return { kind: "result" };
  if (typeof arg === "object" && "Input" in arg) {
    const input = inputs[(arg as { Input: number }).Input];
    if (!input) return { kind: "result" };
    if (input.type === "object") {
      return {
        kind: "object",
        objectId: input.objectId,
        objectType: input.objectType,
        mutable: "mutable" in input ? input.mutable : undefined
      };
    }
    if (input.type === "pure") {
      return {
        kind: "pure",
        valueType: (input as { type: "pure"; valueType?: string | null; value: unknown }).valueType ?? undefined,
        value: JSON.stringify((input as { type: "pure"; value: unknown }).value)
      };
    }
  }
  return { kind: "result" };
}

/**
 * For each fully-resolved moveCall target (0xPKG::mod::fn), fetch up to `maxPerFn` recent
 * transactions from the Sui RPC, parse the PTB inputs, and return concrete argument values.
 *
 * Object type names are enriched via a batched `multiGetObjects` call when `enrichObjects: true`.
 */
export async function fetchFunctionExamples(
  targets: string[],
  opts: FetchExamplesOptions = {}
): Promise<ExamplesMap> {
  const result: ExamplesMap = new Map();
  const maxPerFn = opts.maxPerFn ?? 2;

  // Only process fully-resolved targets (start with 0x and have 3 parts)
  const resolved = [...new Set(targets)].filter((t) => {
    const parts = t.split("::");
    return parts.length === 3 && parts[0]!.startsWith("0x") && !parts[0]!.startsWith("<");
  });

  if (resolved.length === 0) return result;

  const client = makeClient(opts);

  // Fetch digests for each function (parallel, capped at 6 at once)
  const CONCURRENCY = 6;
  const chunks: string[][] = [];
  for (let i = 0; i < resolved.length; i += CONCURRENCY) {
    chunks.push(resolved.slice(i, i + CONCURRENCY));
  }

  const allObjectIds = new Set<string>();
  const pendingExamples: Map<string, Array<{ digest: string; args: ResolvedArg[] }>> = new Map();

  for (const chunk of chunks) {
    opts.signal?.throwIfAborted();

    await Promise.all(chunk.map(async (target) => {
      const parts = target.split("::");
      const pkg = parts[0]!;
      const mod = parts[1]!;
      const fn = parts[2]!;

      try {
        const page = await client.queryTransactionBlocks({
          filter: { MoveFunction: { package: pkg, module: mod, function: fn } },
          limit: maxPerFn,
          order: "descending",
          options: { showInput: true },
          signal: opts.signal
        });

        const examples: Array<{ digest: string; args: ResolvedArg[] }> = [];

        for (const txSummary of page.data) {
          const digest = txSummary.digest;
          const tx = txSummary.transaction?.data?.transaction;
          if (!tx || tx.kind !== "ProgrammableTransaction") continue;

          const inputs = tx.inputs as SuiCallArg[];
          const ptbSteps = tx.transactions as Array<{ MoveCall?: { package: string; module: string; function: string; arguments?: SuiArgument[] } }>;

          // Find the matching MoveCall step
          const callStep = ptbSteps.find(
            (s) => s.MoveCall?.package === pkg && s.MoveCall?.module === mod && s.MoveCall?.function === fn
          );
          if (!callStep?.MoveCall?.arguments) continue;

          const resolvedArgs = callStep.MoveCall.arguments.map((arg) => resolveCallArg(arg, inputs));

          // Collect object IDs for enrichment
          if (opts.enrichObjects !== false) {
            for (const a of resolvedArgs) {
              if (a.kind === "object" && a.objectId) allObjectIds.add(a.objectId);
            }
          }

          examples.push({ digest, args: resolvedArgs });
        }

        if (examples.length > 0) pendingExamples.set(target, examples);
      } catch {
        // best-effort: skip failed targets
      }
    }));
  }

  // Batch enrich object type names
  if (opts.enrichObjects !== false && allObjectIds.size > 0) {
    try {
      const idList = [...allObjectIds].slice(0, 50); // cap at 50 objects
      const objects = await client.multiGetObjects({
        ids: idList,
        options: { showType: true },
        signal: opts.signal
      });

      const typeMap = new Map<string, string>();
      for (let i = 0; i < idList.length; i++) {
        const obj = objects[i];
        const typeName = obj?.data?.type;
        if (typeName && idList[i]) typeMap.set(idList[i]!, typeName);
      }

      // Apply type names to pending examples
      for (const [target, examples] of pendingExamples) {
        for (const ex of examples) {
          for (const arg of ex.args) {
            if (arg.kind === "object" && arg.objectId) {
              arg.objectTypeName = typeMap.get(arg.objectId);
            }
          }
        }
        result.set(target, examples);
      }
    } catch {
      // enrichment failed — still return unenriched examples
      for (const [target, examples] of pendingExamples) {
        result.set(target, examples);
      }
    }
  } else {
    for (const [target, examples] of pendingExamples) {
      result.set(target, examples);
    }
  }

  return result;
}

/**
 * Fetch transaction examples for all entry functions found in the ABI.
 * This is the primary source for action documentation in the flipped pipeline.
 */
export async function fetchAbiExamples(
  abi: SuiAbi,
  opts: FetchExamplesOptions & { maxFunctions?: number } = {}
): Promise<ExamplesMap> {
  const targets: string[] = [];
  for (const [pkgId, pkg] of Object.entries(abi.packages)) {
    for (const [modName, mod] of Object.entries(pkg.modules)) {
      for (const [fnName, fn] of Object.entries((mod as Record<string, unknown>).exposedFunctions as Record<string, { isEntry?: boolean }> ?? {})) {
        if (fn.isEntry) {
          targets.push(`${pkgId}::${modName}::${fnName}`);
        }
      }
    }
  }
  const maxFns = opts.maxFunctions ?? 80;
  return fetchFunctionExamples(targets.slice(0, maxFns), opts);
}
