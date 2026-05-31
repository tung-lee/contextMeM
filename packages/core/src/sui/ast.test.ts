import { describe, expect, it } from "vitest";
import type { BundleChunk } from "./bundle.js";
import { detectActions } from "./ast.js";

function chunk(content: string, url = "https://app.example.com/assets/main.js"): BundleChunk {
  return { url, bytes: content.length, sha256: "test", content };
}

const PKG = "0x" + "a".repeat(64);
const PKG2 = "0x" + "b".repeat(64);

describe("detectActions", () => {
  it("returns empty actions for empty chunks", () => {
    const result = detectActions([]);
    expect(result.actions).toHaveLength(0);
    expect(result.parseErrors).toHaveLength(0);
  });

  it("returns empty actions for chunks with no tx builders", () => {
    const result = detectActions([chunk("const x = 1; function foo() { return x; }")]);
    expect(result.actions).toHaveLength(0);
  });

  it("shape A: literal string target in moveCall", () => {
    const code = `
      function swapTokens(tx) {
        tx.moveCall({ target: "${PKG}::pool::swap_a2b", arguments: [tx.object(poolId)] });
      }
    `;
    const result = detectActions([chunk(code)]);
    expect(result.actions.length).toBeGreaterThan(0);
    const action = result.actions[0]!;
    expect(action.steps.some((s) => s.kind === "moveCall" && s.target === `${PKG}::pool::swap_a2b`)).toBe(true);
  });

  it("shape C: template literal with pkg identifier", () => {
    const code = `
      const PACKAGE_ID = "${PKG}";
      function doSwap(tx) {
        tx.moveCall({ target: \`\${PACKAGE_ID}::pool::swap\`, arguments: [] });
      }
    `;
    const result = detectActions([chunk(code)]);
    expect(result.actions.length).toBeGreaterThan(0);
    const action = result.actions[0]!;
    expect(action.steps.some((s) => s.kind === "moveCall" && s.target === `${PKG}::pool::swap`)).toBe(true);
  });

  it("shape D: identifier constant resolving to full target", () => {
    const code = `
      const TARGET = "${PKG}::pool::swap";
      function doSwap(tx) {
        tx.moveCall({ target: TARGET, arguments: [] });
      }
    `;
    const result = detectActions([chunk(code)]);
    expect(result.actions.length).toBeGreaterThan(0);
    expect(result.actions[0]!.steps.some((s) => s.kind === "moveCall" && s.target === `${PKG}::pool::swap`)).toBe(true);
  });

  it("names action from function name", () => {
    const code = `
      function mySpecialAction(tx) {
        tx.moveCall({ target: "${PKG}::pool::swap_b2a", arguments: [] });
      }
    `;
    const result = detectActions([chunk(code)]);
    expect(result.actions.length).toBeGreaterThan(0);
    expect(result.actions[0]!.name).toBe("mySpecialAction");
  });

  it("groups multiple moveCall steps in one action", () => {
    const code = `
      function addLiquidity(tx, pool, coin) {
        const pos = tx.moveCall({ target: "${PKG}::pool::open_position", arguments: [tx.object(pool)] });
        tx.moveCall({ target: "${PKG}::pool::add_liquidity", arguments: [tx.object(pool), pos] });
      }
    `;
    const result = detectActions([chunk(code)]);
    expect(result.actions.length).toBeGreaterThan(0);
    expect(result.actions[0]!.steps).toHaveLength(2);
  });

  it("detects splitCoins step", () => {
    const code = `
      function splitAndSwap(tx) {
        const [coin] = tx.splitCoins(tx.gas, [100n]);
        tx.moveCall({ target: "${PKG}::pool::swap", arguments: [coin] });
      }
    `;
    const result = detectActions([chunk(code)]);
    expect(result.actions.length).toBeGreaterThan(0);
    expect(result.actions[0]!.inputCoins.some((s) => s.kind === "splitCoins")).toBe(true);
  });

  it("records parseErrors for unparseable chunks", () => {
    const bad = chunk("this is not valid javascript }{{{");
    const result = detectActions([bad]);
    expect(result.parseErrors.length).toBeGreaterThan(0);
  });

  it("records unresolvedRefs for unresolved identifiers", () => {
    const code = `
      function doSomething(tx) {
        tx.moveCall({ target: UNKNOWN_PKG_TARGET, arguments: [] });
      }
    `;
    const result = detectActions([chunk(code)]);
    expect(result.unresolvedRefs.length).toBeGreaterThan(0);
  });

  it("handles multiple functions in one chunk as separate actions", () => {
    const code = `
      function swap(tx) { tx.moveCall({ target: "${PKG}::pool::swap", arguments: [] }); }
      function addLiq(tx) { tx.moveCall({ target: "${PKG2}::pool::add", arguments: [] }); }
    `;
    const result = detectActions([chunk(code)]);
    expect(result.actions.length).toBeGreaterThanOrEqual(2);
  });
});
