import { describe, expect, it } from "vitest";
import type {
  ActionWorkflow,
  MoveObjectInventory,
  SuiAbi,
  SuiMoveNormalizedModule,
  WorkflowActionSet
} from "../sui-types.js";
import { renderModule, renderAction, renderObjects, renderSummary, renderSuiArtifacts, serializeAbi, serializeWorkflows } from "./render.js";

const PKG = "0x" + "a".repeat(64);

const POOL_MODULE: SuiMoveNormalizedModule = {
  fileFormatVersion: 6,
  address: PKG,
  name: "pool",
  friends: [],
  structs: {
    Pool: {
      abilities: { abilities: ["Key", "Store"] },
      typeParameters: [],
      fields: [{ name: "fee_rate", type: "U64" }]
    }
  },
  enums: {},
  exposedFunctions: {
    swap: {
      visibility: "Public",
      isEntry: true,
      typeParameters: [],
      parameters: ["U64"],
      return: []
    }
  }
};

const MINIMAL_ABI: SuiAbi = {
  scrapedAt: "2026-01-01T00:00:00.000Z",
  rpcEndpoint: "https://fullnode.mainnet.sui.io",
  packages: { [PKG]: { modules: { pool: POOL_MODULE } } },
  mvrNames: {}
};

const SWAP_ACTION: ActionWorkflow = {
  name: "swapA2B",
  entry: "main.js",
  steps: [
    { kind: "moveCall", target: `${PKG}::pool::swap`, typeArgs: [], args: [{ kind: "input", ref: "pool" }, { kind: "gas" }] }
  ],
  inputCoins: [],
  outputs: [],
  touchedObjects: [{ objectId: "0xpool", type: `${PKG}::pool::Pool`, kindGuess: "shared" }]
};

const WORKFLOW_SET: WorkflowActionSet = {
  scrapedAt: "2026-01-01T00:00:00.000Z",
  host: "app.example.com",
  actions: [SWAP_ACTION]
};

const EMPTY_INVENTORY: MoveObjectInventory = {
  scrapedAt: "2026-01-01T00:00:00.000Z",
  entries: []
};

const INVENTORY_WITH_ENTRIES: MoveObjectInventory = {
  scrapedAt: "2026-01-01T00:00:00.000Z",
  entries: [
    {
      objectId: "0xpool",
      type: `${PKG}::pool::Pool`,
      packageId: PKG,
      module: "pool",
      fields: [],
      abilities: [],
      kindGuess: "shared",
      readBy: ["swap"],
      mutatedBy: ["add_liquidity"]
    }
  ]
};

describe("renderModule", () => {
  it("includes package id and module name in header", () => {
    const output = renderModule(PKG, "pool", POOL_MODULE);
    expect(output).toContain(`# ${PKG}::pool`);
  });

  it("includes struct section", () => {
    const output = renderModule(PKG, "pool", POOL_MODULE);
    expect(output).toContain("## Structs");
    expect(output).toContain("### Pool");
  });

  it("includes function section", () => {
    const output = renderModule(PKG, "pool", POOL_MODULE);
    expect(output).toContain("## Functions");
    expect(output).toContain("swap");
  });

  it("sorts functions alphabetically for determinism", () => {
    const mod = { ...POOL_MODULE, exposedFunctions: { z_fn: POOL_MODULE.exposedFunctions.swap, a_fn: POOL_MODULE.exposedFunctions.swap } };
    const output = renderModule(PKG, "pool", mod as SuiMoveNormalizedModule);
    expect(output.indexOf("a_fn")).toBeLessThan(output.indexOf("z_fn"));
  });
});

describe("renderAction", () => {
  it("includes action name as heading", () => {
    const output = renderAction(SWAP_ACTION, MINIMAL_ABI);
    expect(output).toContain("# swapA2B");
  });

  it("shows step-by-step flow with moveCall heading", () => {
    const output = renderAction(SWAP_ACTION, MINIMAL_ABI);
    expect(output).toContain("## Steps");
    expect(output).toContain("moveCall");
    expect(output).not.toContain("```mermaid");
  });

  it("includes moveCall target in steps", () => {
    const output = renderAction(SWAP_ACTION, MINIMAL_ABI);
    expect(output).toContain("pool::swap");
  });

  it("shows argument table with ABI types", () => {
    const output = renderAction(SWAP_ACTION, MINIMAL_ABI);
    expect(output).toContain("| # | Argument | ABI type |");
    expect(output).toContain("pool");
  });
});

describe("renderObjects", () => {
  it("shows no-objects message for empty inventory", () => {
    const output = renderObjects(EMPTY_INVENTORY);
    expect(output).toContain("no objects detected");
  });

  it("groups entries by type", () => {
    const output = renderObjects(INVENTORY_WITH_ENTRIES);
    expect(output).toContain(`${PKG}::pool::Pool`);
    expect(output).toContain("shared");
  });

  it("lists readBy and mutatedBy functions", () => {
    const output = renderObjects(INVENTORY_WITH_ENTRIES);
    expect(output).toContain("swap");
    expect(output).toContain("add_liquidity");
  });
});

describe("renderSummary", () => {
  it("includes host in heading", () => {
    const output = renderSummary({ host: "app.example.com", scrapedAt: "2026-01-01T00:00:00.000Z", rpcEndpoint: "https://rpc.example.com", abi: MINIMAL_ABI, workflows: WORKFLOW_SET, objects: EMPTY_INVENTORY });
    expect(output).toContain("app.example.com");
  });

  it("counts packages and actions", () => {
    const output = renderSummary({ host: "h", scrapedAt: "2026-01-01T00:00:00.000Z", rpcEndpoint: "https://rpc", abi: MINIMAL_ABI, workflows: WORKFLOW_SET, objects: EMPTY_INVENTORY });
    expect(output).toContain("1 package");
    expect(output).toContain("transaction builder actions");
  });

  it("includes limitations section", () => {
    const output = renderSummary({ host: "h", scrapedAt: "2026-01-01T00:00:00.000Z", rpcEndpoint: "https://rpc", abi: MINIMAL_ABI, workflows: WORKFLOW_SET, objects: EMPTY_INVENTORY });
    expect(output).toContain("## Limitations");
  });
});

describe("serializeAbi / serializeWorkflows", () => {
  it("serializeAbi produces valid JSON with sorted keys", () => {
    const output = serializeAbi(MINIMAL_ABI);
    const parsed = JSON.parse(output);
    expect(parsed).toHaveProperty("packages");
    expect(Object.keys(parsed)).toEqual([...Object.keys(parsed)].sort());
  });

  it("serializeWorkflows produces valid JSON", () => {
    const output = serializeWorkflows(WORKFLOW_SET);
    const parsed = JSON.parse(output);
    expect(parsed).toHaveProperty("actions");
    expect(parsed.actions).toHaveLength(1);
  });
});

describe("renderSuiArtifacts", () => {
  const input = { host: "app.example.com", scrapedAt: "2026-01-01T00:00:00.000Z", rpcEndpoint: "https://rpc", abi: MINIMAL_ABI, workflows: WORKFLOW_SET, objects: INVENTORY_WITH_ENTRIES };

  it("returns all required artifact paths", () => {
    const result = renderSuiArtifacts(input);
    const paths = result.files.map((f) => f.path);
    expect(paths).toContain("abi.json");
    expect(paths).toContain("workflows.json");
    expect(paths).toContain("summary.md");
    expect(paths).toContain("objects.md");
  });

  it("creates per-module markdown files", () => {
    const result = renderSuiArtifacts(input);
    const paths = result.files.map((f) => f.path);
    expect(paths.some((p) => p.includes("packages/") && p.endsWith("pool.md"))).toBe(true);
  });

  it("creates per-action markdown files", () => {
    const result = renderSuiArtifacts(input);
    const paths = result.files.map((f) => f.path);
    expect(paths.some((p) => p.startsWith("actions/") && p.endsWith(".md"))).toBe(true);
  });

  it("indexPaths reference existing files", () => {
    const result = renderSuiArtifacts(input);
    const paths = result.files.map((f) => f.path);
    expect(paths).toContain(result.indexPaths.abi);
    expect(paths).toContain(result.indexPaths.workflows);
    expect(paths).toContain(result.indexPaths.summary);
    expect(paths).toContain(result.indexPaths.objects);
  });

  it("deduplicates action slugs with suffix", () => {
    const dup = { ...WORKFLOW_SET, actions: [SWAP_ACTION, SWAP_ACTION] };
    const result = renderSuiArtifacts({ ...input, workflows: dup });
    const actionPaths = result.files.filter((f) => f.path.startsWith("actions/")).map((f) => f.path);
    expect(new Set(actionPaths).size).toBe(actionPaths.length);
  });
});
