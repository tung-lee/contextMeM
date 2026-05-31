import type { ActionWorkflow, MoveObjectEntry, MoveObjectInventory, SuiAbi, SuiMoveNormalizedType } from "../sui-types.js";
import { renderTypeTag } from "./abi.js";

function isMutableRefTo(t: SuiMoveNormalizedType, pkgId: string, mod: string, name: string): boolean {
  if (typeof t !== "object") return false;
  if (!("MutableReference" in t)) return false;
  const inner = t.MutableReference;
  if (typeof inner !== "object") return false;
  if (!("Struct" in inner)) return false;
  const s = inner.Struct;
  return s.address === pkgId && s.module === mod && s.name === name;
}

function isRefTo(t: SuiMoveNormalizedType, pkgId: string, mod: string, name: string): boolean {
  if (typeof t !== "object") return false;
  if (!("Reference" in t)) return false;
  const inner = t.Reference;
  if (typeof inner !== "object") return false;
  if (!("Struct" in inner)) return false;
  const s = inner.Struct;
  return s.address === pkgId && s.module === mod && s.name === name;
}

function parseObjectType(type: string): { pkgId: string; mod: string; name: string } | null {
  const parts = type.split("::");
  if (parts.length < 3) return null;
  const pkgId = parts[0]!;
  const mod = parts[1]!;
  const name = parts[2]!.split("<")[0]!; // strip type args
  return { pkgId, mod, name };
}

export function inferObjectInventory(actions: ActionWorkflow[], abi: SuiAbi): MoveObjectInventory {
  const scrapedAt = new Date().toISOString();
  const seen = new Map<string, MoveObjectEntry>();

  for (const action of actions) {
    for (const touched of action.touchedObjects) {
      if (!touched.type || touched.type === "unknown") continue;
      const parsed = parseObjectType(touched.type);
      if (!parsed) continue;

      const key = touched.type;
      if (seen.has(key)) continue;

      const { pkgId, mod, name } = parsed;
      const pkg = abi.packages[pkgId];
      const module = pkg?.modules?.[mod];
      const struct = module?.structs?.[name];

      const fields = struct?.fields?.map((f) => ({
        name: f.name,
        type: renderTypeTag(f.type)
      })) ?? [];

      const abilities = struct?.abilities?.abilities ?? [];

      // Find readBy / mutatedBy from all exposed functions across all packages
      const readBy: string[] = [];
      const mutatedBy: string[] = [];

      for (const [_pId, p] of Object.entries(abi.packages)) {
        for (const [mName, m] of Object.entries(p.modules)) {
          for (const [fnName, fn] of Object.entries(m.exposedFunctions)) {
            const params = fn.parameters ?? [];
            const qual = `${_pId}::${mName}::${fnName}`;
            if (params.some((param) => isMutableRefTo(param, pkgId, mod, name))) {
              mutatedBy.push(qual);
            } else if (params.some((param) => isRefTo(param, pkgId, mod, name))) {
              readBy.push(qual);
            }
          }
        }
      }

      seen.set(key, {
        type: touched.type,
        objectId: touched.objectId,
        packageId: pkgId,
        module: mod,
        fields,
        abilities,
        kindGuess: touched.kindGuess === "shared" ? "shared" : "unknown",
        readBy,
        mutatedBy
      });
    }
  }

  return { scrapedAt, entries: [...seen.values()] };
}
