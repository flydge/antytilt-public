// The recovery target is deployment configuration, never source: the server reads
// HL_TESTNET_LEGACY_RECOVERY_*, the browser bundle reads VITE_HL_TESTNET_LEGACY_RECOVERY_*.
// Without both values the recovery flow stays disabled.
const recoveryEnv: Record<string, string | undefined> =
  typeof process !== "undefined" && process.env
    ? process.env
    : ((import.meta as { env?: Record<string, string | undefined> }).env ?? {});
const recoverySetting = (name: string) =>
  (recoveryEnv[name] ?? recoveryEnv[`VITE_${name}`] ?? "").trim().toLowerCase();
export const HL_LEGACY_RECOVERY_ACCOUNT = recoverySetting(
  "HL_TESTNET_LEGACY_RECOVERY_ACCOUNT",
);
export const HL_LEGACY_RECOVERY_CLOID = recoverySetting(
  "HL_TESTNET_LEGACY_RECOVERY_CLOID",
);
export const HL_LEGACY_REVIEW_TTL = 300000;
export const LEGACY_MISSING_FIELDS = [
  "action",
  "nonce",
  "createdAt",
  "expiresAfter",
] as const;
export interface HlLegacyObservation {
  network: "testnet";
  account: string;
  checkedAt: number;
  orderStatus: string;
  nonzeroPositions: number;
  openOrders: number;
  fillCount: number;
  historicalOrderCount: number;
  matchingFills: number;
  matchingOrders: number;
  historyCompleteness: false;
}
export interface HlLegacyRecoveryReview {
  format?: "LEGACY" | "CANONICAL_CLIENT_ONLY";
  packetId?: string;
  mirrorStorageKey?: string;
  mirrorRaw?: string;
  mirrorHash?: string;
  evidenceHash?: string;
  id: string;
  network: "testnet";
  account: string;
  cloid: string;
  storageKey: string;
  raw: string;
  rawHash: string;
  outcome: "UNKNOWN";
  missingFields: readonly ("action" | "nonce" | "createdAt" | "expiresAfter")[];
  observation: HlLegacyObservation;
  createdAt: number;
  expiresAfter: number;
  seal: string;
}
export interface HlLegacyRecoveryReceipt {
  format?: "LEGACY" | "CANONICAL_CLIENT_ONLY";
  packetId?: string;
  mirrorStorageKey?: string;
  mirrorRaw?: string;
  mirrorHash?: string;
  evidenceHash?: string;
  id: string;
  network: "testnet";
  account: string;
  cloid: string;
  storageKey: string;
  raw: string;
  rawHash: string;
  outcome: "UNKNOWN";
  review: HlLegacyRecoveryReview;
  observation: HlLegacyObservation;
  acknowledgments: { uncertainty: true; stoppedPrompts: true };
  retiredAt: number;
  reason: string;
}
export interface HlLegacyRecoveryJournal {
  network: "testnet";
  account: string;
  receipts: HlLegacyRecoveryReceipt[];
}
export function parseExactLegacyRaw(
  raw: unknown,
  storageKey: unknown,
  network: unknown,
  account: string,
) {
  if (
    network !== "testnet" ||
    account.toLowerCase() !== HL_LEGACY_RECOVERY_ACCOUNT ||
    storageKey !==
      `antytilt:hl:manual-pending:testnet:${HL_LEGACY_RECOVERY_ACCOUNT}`
  )
    throw Error("Exact approved Testnet legacy scope required");
  if (
    typeof raw !== "string" ||
    new TextEncoder().encode(raw).byteLength > 4096
  )
    throw Error("Legacy evidence exceeds bounded raw size");
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw Error("Legacy evidence is unreadable");
  }
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw Error("Strict old legacy record required");
  const p = value as Record<string, unknown>;
  if (
    Object.keys(p).sort().join(",") !== "cloid,message,unknown" ||
    p.cloid !== HL_LEGACY_RECOVERY_CLOID ||
    p.unknown !== true ||
    typeof p.message !== "string" ||
    p.message.length > 2000
  )
    throw Error(
      "Strict exact old UNKNOWN record required; canonical/mirror/new packets cannot be retired",
    );
  return {
    cloid: HL_LEGACY_RECOVERY_CLOID,
    message: p.message,
    unknown: true as const,
  };
}

export const HL_CANONICAL_RECOVERY_PACKET =
  "aed43368-803b-4dce-bf7b-aa2a629b3c51";
export const HL_CANONICAL_RECOVERY_CREATED_AT = 1791838268932;
export const HL_CANONICAL_RECOVERY_EXPIRES_AFTER = 1791838328932;
export const CANONICAL_MISSING_FIELDS = ["nonce"] as const;
export const HL_CANONICAL_RECOVERY_ACTION = {
  type: "order",
  grouping: "na",
  orders: [
    {
      a: 3,
      b: true,
      p: "82923",
      s: "0.00944",
      r: false,
      c: HL_LEGACY_RECOVERY_CLOID,
      t: { limit: { tif: "Ioc" } },
    },
  ],
} as const;
const stableRecovery = (v: unknown): string =>
  JSON.stringify(v, (_key, value) =>
    value && typeof value === "object" && !Array.isArray(value)
      ? Object.fromEntries(
          Object.entries(value).sort(([a], [b]) => a.localeCompare(b)),
        )
      : value,
  );
function boundedRecoveryRecord(raw: unknown): Record<string, unknown> {
  if (
    typeof raw !== "string" ||
    new TextEncoder().encode(raw).byteLength > 4096
  )
    throw Error("Bounded saved recovery record required");
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw Error("Saved recovery record is unreadable");
  }
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw Error("Saved recovery object required");
  return value as Record<string, unknown>;
}
export function parseExactCanonicalClientOnlyEvidence(
  raw: unknown,
  storageKey: unknown,
  mirrorRaw: unknown,
  mirrorStorageKey: unknown,
  network: unknown,
  account: string,
  now = Date.now(),
) {
  if (
    network !== "testnet" ||
    account !== HL_LEGACY_RECOVERY_ACCOUNT ||
    storageKey !== `antytilt:hl:terminal-pending:testnet:${account}` ||
    mirrorStorageKey !== `antytilt:hl:manual-pending:testnet:${account}`
  )
    throw Error("Exact canonical client-only scope required");
  const p = boundedRecoveryRecord(raw),
    allowed = [
      "version",
      "network",
      "account",
      "packetId",
      "action",
      "ids",
      "createdAt",
      "expiresAfter",
      "message",
      "legacy",
      "invalid",
      "knownIds",
    ];
  if (
    Object.keys(p).some((k) => !allowed.includes(k)) ||
    p.version !== 1 ||
    p.network !== "testnet" ||
    p.account !== account ||
    p.packetId !== HL_CANONICAL_RECOVERY_PACKET ||
    p.createdAt !== HL_CANONICAL_RECOVERY_CREATED_AT ||
    p.expiresAfter !== HL_CANONICAL_RECOVERY_EXPIRES_AFTER ||
    now <= HL_CANONICAL_RECOVERY_EXPIRES_AFTER ||
    p.legacy !== false ||
    (p.invalid !== undefined && p.invalid !== false) ||
    (p.knownIds !== undefined &&
      (!Array.isArray(p.knownIds) || p.knownIds.length !== 0)) ||
    stableRecovery(p.ids) !== stableRecovery([HL_LEGACY_RECOVERY_CLOID]) ||
    stableRecovery(p.action) !== stableRecovery(HL_CANONICAL_RECOVERY_ACTION) ||
    typeof p.message !== "string" ||
    p.message.length > 2000
  )
    throw Error(
      "Saved canonical record is outside the one exact client-only exception",
    );
  const mirror = boundedRecoveryRecord(mirrorRaw);
  if (
    Object.keys(mirror).sort().join(",") !==
      "cloid,message,terminalPacketId,unknown" ||
    mirror.cloid !== HL_LEGACY_RECOVERY_CLOID ||
    mirror.terminalPacketId !== HL_CANONICAL_RECOVERY_PACKET ||
    mirror.unknown !== true ||
    typeof mirror.message !== "string" ||
    mirror.message.length > 2000
  )
    throw Error("Exact unchanged canonical mirror required");
  return p;
}
export function canonicalRecoveryIdentityText(
  r: Pick<
    HlLegacyRecoveryReview,
    | "network"
    | "account"
    | "cloid"
    | "storageKey"
    | "rawHash"
    | "packetId"
    | "mirrorStorageKey"
    | "mirrorHash"
  >,
) {
  return JSON.stringify({
    format: "CANONICAL_CLIENT_ONLY",
    network: r.network,
    account: r.account,
    cloid: r.cloid,
    packetId: r.packetId,
    storageKey: r.storageKey,
    rawHash: r.rawHash,
    mirrorStorageKey: r.mirrorStorageKey,
    mirrorHash: r.mirrorHash,
  });
}
