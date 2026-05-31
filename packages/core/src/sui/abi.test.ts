import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PackageId, SuiMoveNormalizedModule, SuiMoveNormalizedType } from "../sui-types.js";
import { fetchSuiAbi, renderTypeTag } from "./abi.js";

let tmp: string;
beforeEach(async () => { tmp = await fs.mkdtemp(path.join(os.tmpdir(), "abi-test-")); });
afterEach(async () => { await fs.rm(tmp, { recursive: true, force: true }); vi.restoreAllMocks(); });

const FAKE_PKG = "0x" + "e".repeat(64) as PackageId;
const FAKE_MODULE: SuiMoveNormalizedModule = {
  fileFormatVersion: 6,
  address: FAKE_PKG,
  name: "pool",
  friends: [],
  structs: {},
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

function makeClientFactory(modules: Record<string, SuiMoveNormalizedModule> | null, errorMsg?: string) {
  return (_url: string) => ({
    getNormalizedMoveModulesByPackage: async (_args: { package: string }) => {
      if (errorMsg) throw new Error(errorMsg);
      if (modules === null) throw new Error("object is not a package");
      return modules;
    }
  }) as never;
}

describe("renderTypeTag", () => {
  it("renders primitive string types", () => {
    expect(renderTypeTag("U64")).toBe("u64");
    expect(renderTypeTag("Bool")).toBe("bool");
    expect(renderTypeTag("Address")).toBe("address");
  });

  it("renders Vector", () => {
    const t: SuiMoveNormalizedType = { Vector: "U8" };
    expect(renderTypeTag(t)).toBe("vector<u8>");
  });

  it("renders Struct", () => {
    const t: SuiMoveNormalizedType = {
      Struct: { address: "0x2", module: "coin", name: "Coin", typeArguments: ["U64"] }
    };
    expect(renderTypeTag(t)).toBe("0x2::coin::Coin<u64>");
  });

  it("renders Reference", () => {
    const t: SuiMoveNormalizedType = { Reference: "U64" };
    expect(renderTypeTag(t)).toBe("&u64");
  });

  it("renders MutableReference", () => {
    const t: SuiMoveNormalizedType = { MutableReference: "U64" };
    expect(renderTypeTag(t)).toBe("&mut u64");
  });

  it("renders TypeParameter by index", () => {
    const t: SuiMoveNormalizedType = { TypeParameter: 0 };
    expect(renderTypeTag(t, ["T0", "T1"])).toBe("T0");
    expect(renderTypeTag(t)).toBe("T0");
  });
});

describe("fetchSuiAbi", () => {
  it("fetches and stores modules from RPC", async () => {
    const result = await fetchSuiAbi([FAKE_PKG], {
      clientFactory: makeClientFactory({ pool: FAKE_MODULE })
    });
    expect(result.abi.packages[FAKE_PKG]).toBeDefined();
    expect(result.abi.packages[FAKE_PKG]!.modules.pool).toBeDefined();
    expect(result.failures).toHaveLength(0);
    expect(result.notPackages).toHaveLength(0);
  });

  it("marks object IDs that are not packages (classic message)", async () => {
    const result = await fetchSuiAbi([FAKE_PKG], {
      clientFactory: makeClientFactory(null)
    });
    expect(result.notPackages).toContain(FAKE_PKG);
    expect(result.abi.packages[FAKE_PKG]).toBeUndefined();
  });

  it("marks non-existent objects as notPackages (Suilend-style message)", async () => {
    const factory = (_url: string) => ({
      getNormalizedMoveModulesByPackage: async (_args: { package: string }) => {
        throw new Error(`Package object does not exist with ID ${FAKE_PKG}`);
      }
    }) as never;
    const result = await fetchSuiAbi([FAKE_PKG], { clientFactory: factory });
    expect(result.notPackages).toContain(FAKE_PKG);
    expect(result.failures).toHaveLength(0);
  });

  it("records failures for other RPC errors", async () => {
    const result = await fetchSuiAbi([FAKE_PKG], {
      clientFactory: makeClientFactory(null, "network timeout")
    });
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0]!.packageId).toBe(FAKE_PKG);
  });

  it("writes and reads cache", async () => {
    const callCount = { n: 0 };
    const factory = (_url: string) => ({
      getNormalizedMoveModulesByPackage: async (_args: { package: string }) => {
        callCount.n++;
        return { pool: FAKE_MODULE };
      }
    }) as never;

    // First call: cache miss
    await fetchSuiAbi([FAKE_PKG], { clientFactory: factory, cacheDir: tmp });
    expect(callCount.n).toBe(1);

    // Second call: cache hit, no new RPC call
    const result2 = await fetchSuiAbi([FAKE_PKG], { clientFactory: factory, cacheDir: tmp });
    expect(callCount.n).toBe(1);
    expect(result2.cacheStats.hits).toBe(1);
  });

  it("deduplicates package IDs", async () => {
    const callCount = { n: 0 };
    const factory = (_url: string) => ({
      getNormalizedMoveModulesByPackage: async () => { callCount.n++; return { pool: FAKE_MODULE }; }
    }) as never;

    await fetchSuiAbi([FAKE_PKG, FAKE_PKG, FAKE_PKG], { clientFactory: factory });
    expect(callCount.n).toBe(1);
  });

  it("returns empty abi for empty input", async () => {
    const result = await fetchSuiAbi([]);
    expect(Object.keys(result.abi.packages)).toHaveLength(0);
  });
});
