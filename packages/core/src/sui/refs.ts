import type { PackageId } from "../sui-types.js";
import type { BundleChunk } from "./bundle.js";

export const RE_TARGET = /"(0x[0-9a-fA-F]{1,64})::([A-Za-z_]\w*)::([A-Za-z_]\w*)"/g;
export const RE_ADDR = /\b(0x[0-9a-fA-F]{1,64})\b/g;

export type SuiRefTarget = {
  pkg: PackageId;
  module: string;
  fn: string;
  source: { chunkUrl: string; segment: "target" | "type" };
};

export type SuiRefTypeRef = {
  pkg: PackageId;
  module: string;
  name: string;
  source: { chunkUrl: string };
};

export type SuiRefIndex = {
  packageIds: Set<PackageId>;
  targets: SuiRefTarget[];
  typeRefs: SuiRefTypeRef[];
};

// These framework packages are canonical in short form
const KNOWN_SHORT_PACKAGES = new Set<string>(["0x1", "0x2", "0x3", "0x5", "0x6", "0x7", "0x8"]);

export function normalizeAddress(raw: string): PackageId {
  const lower = raw.toLowerCase();
  const hex = lower.startsWith("0x") ? lower.slice(2) : lower;
  // keep canonical short forms for known framework packages
  const withPrefix = `0x${hex}` as PackageId;
  if (KNOWN_SHORT_PACKAGES.has(withPrefix)) return withPrefix;
  // pad to 64 chars for app packages
  if (hex.length <= 64) {
    return `0x${hex.padStart(64, "0")}` as PackageId;
  }
  return withPrefix;
}

function isPascalCase(s: string): boolean {
  return s.length > 0 && s[0] === s[0]!.toUpperCase() && !s.includes("_");
}

export function extractSuiRefs(chunks: BundleChunk[]): SuiRefIndex {
  const packageIds = new Set<PackageId>();
  const targetsMap = new Map<string, SuiRefTarget>();
  const typeRefsMap = new Map<string, SuiRefTypeRef>();

  for (const chunk of chunks) {
    // reset regex lastIndex since they have /g flag
    RE_TARGET.lastIndex = 0;
    RE_ADDR.lastIndex = 0;

    // First pass: full `pkg::mod::fn` target literals
    for (const m of chunk.content.matchAll(new RegExp(RE_TARGET.source, "g"))) {
      const pkg = normalizeAddress(m[1]!);
      const mod = m[2]!;
      const name = m[3]!;
      packageIds.add(pkg);

      if (isPascalCase(name)) {
        const key = `${pkg}::${mod}::${name}`;
        if (!typeRefsMap.has(key)) {
          typeRefsMap.set(key, { pkg, module: mod, name, source: { chunkUrl: chunk.url } });
        }
      } else {
        const key = `${pkg}::${mod}::${name}`;
        if (!targetsMap.has(key)) {
          targetsMap.set(key, { pkg, module: mod, fn: name, source: { chunkUrl: chunk.url, segment: "target" } });
        }
      }
    }

    // Second pass: bare hex addresses — only include if already full-length in source
    // (normalizeAddress pads short addresses, so we must gate on RAW length first)
    for (const m of chunk.content.matchAll(new RegExp(RE_ADDR.source, "g"))) {
      const raw = m[1]!;
      const rawHex = raw.startsWith("0x") ? raw.slice(2) : raw;
      const rawLower = raw.toLowerCase();
      if (rawHex.length === 64) {
        packageIds.add(normalizeAddress(raw));
      } else if (KNOWN_SHORT_PACKAGES.has(rawLower)) {
        packageIds.add(normalizeAddress(raw));
      }
      // else: short non-framework hex constants (0x16, 0x1000000, …) are skipped
    }
  }

  return {
    packageIds,
    targets: [...targetsMap.values()],
    typeRefs: [...typeRefsMap.values()]
  };
}
