import { describe, expect, it } from "vitest";
import type { BundleChunk } from "./bundle.js";
import { extractSuiRefs, normalizeAddress, RE_ADDR, RE_TARGET } from "./refs.js";

function chunk(content: string, url = "https://app.example.com/assets/main.js"): BundleChunk {
  return { url, bytes: content.length, sha256: "test", content };
}

describe("normalizeAddress", () => {
  it("pads 64-hex address", () => {
    const short = "0xabc";
    expect(normalizeAddress(short)).toBe("0x" + "abc".padStart(64, "0"));
  });

  it("keeps canonical short framework addresses", () => {
    expect(normalizeAddress("0x1")).toBe("0x1");
    expect(normalizeAddress("0x2")).toBe("0x2");
    expect(normalizeAddress("0x6")).toBe("0x6");
  });

  it("normalizes uppercase hex to lowercase", () => {
    const upper = "0xABCDEF";
    const result = normalizeAddress(upper);
    expect(result).toBe("0x" + "abcdef".padStart(64, "0"));
  });

  it("handles already-64-char address", () => {
    const full = "0x" + "a".repeat(64);
    expect(normalizeAddress(full)).toBe(full);
  });
});

describe("RE_TARGET regex", () => {
  it("matches pkg::mod::fn pattern in double quotes", () => {
    const s = `"0x${"b".repeat(64)}::pool::swap"`;
    const matches = [...s.matchAll(new RegExp(RE_TARGET.source, "g"))];
    expect(matches).toHaveLength(1);
    expect(matches[0]![1]).toBe("0x" + "b".repeat(64));
    expect(matches[0]![2]).toBe("pool");
    expect(matches[0]![3]).toBe("swap");
  });

  it("does not match without double quotes", () => {
    const s = `0x${"c".repeat(64)}::pool::swap`;
    const matches = [...s.matchAll(new RegExp(RE_TARGET.source, "g"))];
    expect(matches).toHaveLength(0);
  });
});

describe("RE_ADDR regex", () => {
  it("matches bare hex address", () => {
    const s = `const PKG = "0x${"d".repeat(64)}"`;
    const matches = [...s.matchAll(new RegExp(RE_ADDR.source, "g"))];
    expect(matches.some((m) => m[1]!.length > 4)).toBe(true);
  });
});

describe("extractSuiRefs", () => {
  it("extracts package IDs from target literals", () => {
    const pkg = "0x" + "1".repeat(64);
    const c = chunk(`"${pkg}::clmm_pool::swap"`);
    const result = extractSuiRefs([c]);
    expect(result.packageIds.has(pkg as never)).toBe(true);
    expect(result.targets).toHaveLength(1);
    expect(result.targets[0]!.fn).toBe("swap");
  });

  it("classifies PascalCase name as typeRef not target", () => {
    const pkg = "0x" + "2".repeat(64);
    const c = chunk(`"${pkg}::pool::Pool"`);
    const result = extractSuiRefs([c]);
    expect(result.typeRefs).toHaveLength(1);
    expect(result.typeRefs[0]!.name).toBe("Pool");
    expect(result.targets).toHaveLength(0);
  });

  it("deduplicates targets across chunks", () => {
    const pkg = "0x" + "3".repeat(64);
    const content = `"${pkg}::pool::swap"`;
    const result = extractSuiRefs([chunk(content, "chunk1.js"), chunk(content, "chunk2.js")]);
    expect(result.targets).toHaveLength(1);
  });

  it("picks up bare 64-hex addresses", () => {
    const addr = "0x" + "4".repeat(64);
    const c = chunk(`const PKG = "${addr}";`);
    const result = extractSuiRefs([c]);
    expect(result.packageIds.has(addr as never)).toBe(true);
  });

  it("ignores short non-framework addresses in bare scan", () => {
    const c = chunk(`const x = "0xdeadbeef";`);
    const result = extractSuiRefs([c]);
    expect(result.packageIds.has("0xdeadbeef" as never)).toBe(false);
  });

  it("does not treat short numeric constants as package IDs (suilend regression)", () => {
    // 0x16 and 0x1000000 appear in Suilend bundle as constants, not package IDs
    const c = chunk(`const FEE = 0x16; const LIMIT = 0x1000000;`);
    const result = extractSuiRefs([c]);
    const padded16 = "0x" + "16".padStart(64, "0");
    const paddedMillion = "0x" + "1000000".padStart(64, "0");
    expect(result.packageIds.has(padded16 as never)).toBe(false);
    expect(result.packageIds.has(paddedMillion as never)).toBe(false);
  });

  it("works on a Cetus-like snippet", () => {
    const cetusClmm = "0x" + "a".repeat(64);
    const c = chunk(`
      e.moveCall({target:"${cetusClmm}::clmm_pool::swap_a2b"});
      e.moveCall({target:"${cetusClmm}::clmm_pool::open_position"});
      const T = "${cetusClmm}::pool::Pool";
    `);
    const result = extractSuiRefs([c]);
    expect(result.packageIds.has(cetusClmm as never)).toBe(true);
    expect(result.targets.map((t) => t.fn)).toContain("swap_a2b");
    expect(result.targets.map((t) => t.fn)).toContain("open_position");
  });
});
