export type SuiNetwork = "mainnet" | "testnet";
export type PackageId = `0x${string}`;
export type SuiTarget = { url: string; host: string; network: SuiNetwork };

export type Ability = "Copy" | "Drop" | "Store" | "Key";

export type SuiMoveNormalizedType =
  | "Bool"
  | "U8"
  | "U16"
  | "U32"
  | "U64"
  | "U128"
  | "U256"
  | "Address"
  | "Signer"
  | { Vector: SuiMoveNormalizedType }
  | { Struct: { address: string; module: string; name: string; typeArguments: SuiMoveNormalizedType[] } }
  | { Reference: SuiMoveNormalizedType }
  | { MutableReference: SuiMoveNormalizedType }
  | { TypeParameter: number };

export type SuiMoveNormalizedStruct = {
  abilities: { abilities: Ability[] };
  typeParameters: Array<{ constraints: { abilities: Ability[] }; isPhantom: boolean }>;
  fields: Array<{ name: string; type: SuiMoveNormalizedType }>;
};

export type SuiMoveNormalizedEnum = {
  abilities: { abilities: Ability[] };
  typeParameters: Array<{ constraints: { abilities: Ability[] }; isPhantom: boolean }>;
  variants: Record<string, Array<{ name: string; type: SuiMoveNormalizedType }>>;
  variantDeclarationOrder: string[];
};

export type SuiMoveNormalizedFunction = {
  visibility: "Public" | "Private" | "Friend";
  isEntry: boolean;
  typeParameters: Array<{ abilities: Ability[] }>;
  parameters: SuiMoveNormalizedType[];
  return: SuiMoveNormalizedType[];
};

export type SuiMoveNormalizedModule = {
  fileFormatVersion: number;
  address: string;
  name: string;
  friends: Array<{ address: string; name: string }>;
  structs: Record<string, SuiMoveNormalizedStruct>;
  enums?: Record<string, SuiMoveNormalizedEnum>;
  exposedFunctions: Record<string, SuiMoveNormalizedFunction>;
};

export type NormalizedPackage = { modules: Record<string, SuiMoveNormalizedModule> };

export type SuiAbi = {
  scrapedAt: string;
  rpcEndpoint: string;
  packages: Record<string, NormalizedPackage>;
  mvrNames: Record<string, string>;
};

export type ValueRef =
  | { kind: "input"; ref?: string }
  | { kind: "result"; ref?: string }
  | { kind: "gas" }
  | { kind: "pure"; ref?: string }
  | { kind: "literal"; value: string };

export type WorkflowStep =
  | { kind: "splitCoins"; coin: ValueRef; amounts: ValueRef[] }
  | { kind: "mergeCoins"; destination: ValueRef; sources: ValueRef[] }
  | { kind: "transferObjects"; objects: ValueRef[]; address: ValueRef }
  | { kind: "makeMoveVec"; elemType?: string; elements: ValueRef[] }
  | { kind: "moveCall"; target: string; typeArgs: string[]; args: ValueRef[]; mvrMarker?: boolean };

export type TouchedObjectRef = {
  objectId: string;
  type: string;
  kindGuess: "shared" | "unknown";
};

export type ActionWorkflow = {
  name: string;
  entry: string;
  sourceFile?: string;
  steps: WorkflowStep[];
  touchedObjects: TouchedObjectRef[];
  inputCoins: WorkflowStep[];
  outputs: WorkflowStep[];
};

export type WorkflowActionSet = {
  scrapedAt: string;
  host: string;
  actions: ActionWorkflow[];
};

export type MoveObjectEntry = {
  type: string;
  objectId: string;
  packageId: string;
  module: string;
  fields: Array<{ name: string; type: string }>;
  abilities: Ability[];
  kindGuess: "shared" | "unknown";
  readBy: string[];
  mutatedBy: string[];
};

export type MoveObjectInventory = {
  scrapedAt: string;
  entries: MoveObjectEntry[];
};

export type SuiArtifacts = {
  host: string;
  scrapedAt: string;
  rpcEndpoint: string;
  mvrEndpoint?: string;
  abi: SuiAbi;
  workflows: WorkflowActionSet;
  objects: MoveObjectInventory;
  perModuleDocs: Array<{ packageId: string; module: string; path: string }>;
  perActionDocs: Array<{ name: string; path: string }>;
  summaryPath: string;
};

export type SuiChunkMeta =
  | { kind: "sui_module"; packageId: string; module: string; mvrName?: string; contentHash: string }
  | { kind: "sui_action"; action: string; packages: string[]; objects: string[]; contentHash: string }
  | { kind: "sui_object"; type: string; packageId: string; module: string; mutators: string[]; readers: string[]; contentHash: string }
  | { kind: "sui_abi_index"; packageId: string; moduleCount: number; structCount: number; functionCount: number }
  | { kind: "sui_workflow_index"; host: string; actionCount: number; bundleCount: number };
