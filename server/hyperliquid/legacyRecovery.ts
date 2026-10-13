import {
  createHash,
  createHmac,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";
import { HttpTransport, InfoClient } from "@nktkas/hyperliquid";
import Decimal from "decimal.js";
import {
  HL_LEGACY_RECOVERY_ACCOUNT,
  HL_LEGACY_RECOVERY_CLOID,
  HL_LEGACY_REVIEW_TTL,
  LEGACY_MISSING_FIELDS,
  CANONICAL_MISSING_FIELDS,
  HL_CANONICAL_RECOVERY_PACKET,
  canonicalRecoveryIdentityText,
  parseExactCanonicalClientOnlyEvidence,
  parseExactLegacyRaw,
  type HlLegacyObservation,
  type HlLegacyRecoveryReview,
  type HlLegacyRecoveryReceipt,
} from "../../shared/hyperliquidLegacyRecovery";
import { canonicalAccount } from "./client";
import * as archive from "./legacyRecoveryStore";
export interface LegacyRecoveryTestDependencies {
  scopeEnabled: () => boolean;
  observe?: (account: string, cloid: string) => Promise<HlLegacyObservation>;
}
const configured = () =>
  HL_LEGACY_RECOVERY_ACCOUNT !== "" &&
  HL_LEGACY_RECOVERY_CLOID !== "" &&
  process.env.HL_TESTNET_LEGACY_RECOVERY_ACCOUNT?.trim().toLowerCase() ===
    HL_LEGACY_RECOVERY_ACCOUNT &&
  process.env.HL_TESTNET_LEGACY_RECOVERY_CLOID?.trim().toLowerCase() ===
    HL_LEGACY_RECOVERY_CLOID;
export const legacyRawHash = (raw: string) =>
  createHash("sha256").update(raw).digest("hex");
function assertObservation(o: HlLegacyObservation, account: string) {
  if (
    !o ||
    o.network !== "testnet" ||
    o.account !== account ||
    !Number.isFinite(o.checkedAt) ||
    Date.now() - o.checkedAt > 3000 ||
    o.checkedAt > Date.now() + 5000 ||
    o.historyCompleteness !== false
  )
    throw Error("Fresh linked-master Testnet recovery observation required");
  if (
    [
      o.nonzeroPositions,
      o.openOrders,
      o.fillCount,
      o.historicalOrderCount,
      o.matchingFills,
      o.matchingOrders,
    ].some((n) => !Number.isSafeInteger(n) || n < 0 || n > 10000)
  )
    throw Error("Bounded native recovery evidence unavailable");
  if (o.orderStatus !== "unknownOid" || o.matchingFills || o.matchingOrders)
    throw Error(
      "Known native old-request evidence requires reconciliation; cannot archive as unresolved",
    );
  if (o.nonzeroPositions || o.openOrders)
    throw Error(
      "Native account has active positions or orders; legacy recovery blocked",
    );
}
export function createLegacyRecovery(options: {
  getAccount: (user: string) => Promise<string>;
  preparedPacketExists: (packetId: string) => boolean;
  testDependencies?: LegacyRecoveryTestDependencies;
}) {
  if (options.testDependencies && process.env.NODE_ENV !== "test")
    throw Error("Legacy recovery dependency injection is test-only");
  const secret = randomBytes(32),
    deps = options.testDependencies,
    info = new InfoClient({
      transport: new HttpTransport({ isTestnet: true, timeout: 8000 }),
    });
  const seal = (user: string, r: HlLegacyRecoveryReview) =>
    createHmac("sha256", secret)
      .update(user)
      .update("\0")
      .update(JSON.stringify({ ...r, seal: "" }))
      .digest("hex");
  async function scope(user: string, network: unknown) {
    if (network !== "testnet") throw Error("Mainnet legacy recovery disabled");
    if (!(deps?.scopeEnabled ?? configured)())
      throw Error("Exact owner-approved legacy recovery is disabled");
    const account = canonicalAccount(await options.getAccount(user));
    if (account !== HL_LEGACY_RECOVERY_ACCOUNT)
      throw Error("Linked master differs from exact approved legacy scope");
    return account;
  }
  async function native(user: string, account: string) {
    let o: HlLegacyObservation;
    if (deps?.observe)
      o = await deps.observe(account, HL_LEGACY_RECOVERY_CLOID);
    else {
      const userAddress = account as `0x${string}`,
        checkedAt = Date.now();
      const [status, state, orders, fills, history] = await Promise.all([
        info.orderStatus({ user: userAddress, oid: HL_LEGACY_RECOVERY_CLOID }),
        info.clearinghouseState({ user: userAddress }),
        info.frontendOpenOrders({ user: userAddress }),
        info.userFills({ user: userAddress }),
        info.historicalOrders({ user: userAddress }),
      ]);
      if (
        !Array.isArray(state.assetPositions) ||
        !Array.isArray(orders) ||
        !Array.isArray(fills) ||
        !Array.isArray(history)
      )
        throw Error("Native recovery arrays unavailable");
      const positions = state.assetPositions.filter((p) => {
        const size = new Decimal(p.position.szi);
        if (!size.isFinite()) throw Error("Native position unavailable");
        return !size.isZero();
      });
      o = {
        network: "testnet",
        account,
        checkedAt,
        orderStatus:
          status.status === "unknownOid"
            ? "unknownOid"
            : status.status === "order"
              ? status.order.status
              : "unavailable",
        nonzeroPositions: positions.length,
        openOrders: orders.length,
        fillCount: fills.length,
        historicalOrderCount: history.length,
        matchingFills: fills.filter(
          (f) => f.cloid?.toLowerCase() === HL_LEGACY_RECOVERY_CLOID,
        ).length,
        matchingOrders: history.filter(
          (h) => h.order.cloid?.toLowerCase() === HL_LEGACY_RECOVERY_CLOID,
        ).length,
        historyCompleteness: false,
      };
    }
    if ((await scope(user, "testnet")) !== account)
      throw Error("Linked master changed during recovery observation");
    assertObservation(o, account);
    return o;
  }
  function preparedGuard(
    r: Pick<HlLegacyRecoveryReview, "format" | "packetId">,
  ) {
    if (
      r.format === "CANONICAL_CLIENT_ONLY" &&
      options.preparedPacketExists(HL_CANONICAL_RECOVERY_PACKET)
    )
      throw Error(
        "Exact packet is in prepared cache; client-only recovery refused",
      );
  }
  async function exclusions(user: string, r: HlLegacyRecoveryReview) {
    await archive.assertNoLegacyBrokerLock(user, r.account);
    await archive.assertCanonicalClientOnlyAbsent(r);
    preparedGuard(r);
  }
  function validateEvidence(r: HlLegacyRecoveryReview) {
    const canonical = r.format === "CANONICAL_CLIENT_ONLY";
    if (canonical) {
      parseExactCanonicalClientOnlyEvidence(
        r.raw,
        r.storageKey,
        r.mirrorRaw,
        r.mirrorStorageKey,
        r.network,
        r.account,
      );
      if (
        r.packetId !== HL_CANONICAL_RECOVERY_PACKET ||
        r.mirrorHash !== legacyRawHash(r.mirrorRaw!) ||
        r.evidenceHash !== legacyRawHash(canonicalRecoveryIdentityText(r))
      )
        throw Error("Joint canonical evidence mismatch");
    } else {
      if (
        (r.format !== undefined && r.format !== "LEGACY") ||
        r.packetId !== undefined ||
        r.mirrorRaw !== undefined ||
        r.mirrorStorageKey !== undefined ||
        r.mirrorHash !== undefined ||
        r.evidenceHash !== undefined
      )
        throw Error("Strict legacy evidence required");
      parseExactLegacyRaw(r.raw, r.storageKey, r.network, r.account);
    }
    if (
      r.rawHash !== legacyRawHash(r.raw) ||
      r.outcome !== "UNKNOWN" ||
      JSON.stringify(r.missingFields) !==
        JSON.stringify(
          canonical ? CANONICAL_MISSING_FIELDS : LEGACY_MISSING_FIELDS,
        )
    )
      throw Error("Recovery review evidence mismatch");
  }
  function bound(user: string, value: unknown): HlLegacyRecoveryReview {
    if (!value || typeof value !== "object")
      throw Error("Exact sealed recovery review required");
    const r = value as HlLegacyRecoveryReview;
    if (
      typeof r.seal !== "string" ||
      !/^[0-9a-f]{64}$/.test(r.seal) ||
      !timingSafeEqual(Buffer.from(r.seal), Buffer.from(seal(user, r)))
    )
      throw Error("Recovery review changed, foreign or no longer available");
    validateEvidence(r);
    return structuredClone(r);
  }
  async function preview(
    user: string,
    input: {
      network: unknown;
      storageKey: unknown;
      raw: unknown;
      mirrorStorageKey?: unknown;
      mirrorRaw?: unknown;
    },
  ) {
    const account = await scope(user, input.network);
    const canonical =
      input.storageKey === `antytilt:hl:terminal-pending:testnet:${account}`;
    if (canonical)
      parseExactCanonicalClientOnlyEvidence(
        input.raw,
        input.storageKey,
        input.mirrorRaw,
        input.mirrorStorageKey,
        input.network,
        account,
      );
    else {
      if (input.mirrorRaw !== undefined || input.mirrorStorageKey !== undefined)
        throw Error("Strict legacy branch does not accept mirror evidence");
      parseExactLegacyRaw(input.raw, input.storageKey, input.network, account);
    }
    const identity = {
      format: canonical ? "CANONICAL_CLIENT_ONLY" : "LEGACY",
      packetId: canonical ? HL_CANONICAL_RECOVERY_PACKET : undefined,
      account,
    } as HlLegacyRecoveryReview;
    await exclusions(user, identity);
    const observation = await native(user, account);
    await exclusions(user, identity);
    assertObservation(observation, account);
    const createdAt = Date.now();
    const review: HlLegacyRecoveryReview = {
      id: randomUUID(),
      network: "testnet",
      account,
      cloid: HL_LEGACY_RECOVERY_CLOID,
      storageKey: input.storageKey as string,
      raw: input.raw as string,
      rawHash: legacyRawHash(input.raw as string),
      outcome: "UNKNOWN",
      missingFields: canonical
        ? CANONICAL_MISSING_FIELDS
        : LEGACY_MISSING_FIELDS,
      observation,
      createdAt,
      expiresAfter: createdAt + HL_LEGACY_REVIEW_TTL,
      seal: "",
    };
    if (canonical) {
      Object.assign(review, {
        format: "CANONICAL_CLIENT_ONLY",
        packetId: HL_CANONICAL_RECOVERY_PACKET,
        mirrorStorageKey: input.mirrorStorageKey,
        mirrorRaw: input.mirrorRaw,
        mirrorHash: legacyRawHash(input.mirrorRaw as string),
      });
      review.evidenceHash = legacyRawHash(
        canonicalRecoveryIdentityText(review),
      );
    }
    review.seal = seal(user, review);
    return review;
  }
  async function confirm(
    user: string,
    input: { network: unknown; review: unknown; acknowledgments: unknown },
  ) {
    const account = await scope(user, input.network),
      r = bound(user, input.review),
      ack = input.acknowledgments as {
        uncertainty?: unknown;
        stoppedPrompts?: unknown;
      };
    if (
      r.account !== account ||
      !ack ||
      ack.uncertainty !== true ||
      ack.stoppedPrompts !== true ||
      Object.keys(ack).sort().join(",") !== "stoppedPrompts,uncertainty"
    )
      throw Error(
        "Explicit uncertainty and stopped-prompts acknowledgments required",
      );
    await exclusions(user, r);
    const existing = await archive.findLegacyReceipt(
      user,
      account,
      r.cloid,
      r.evidenceHash ?? r.rawHash,
    );
    if (
      !existing &&
      (!Number.isFinite(r.createdAt) ||
        r.createdAt > Date.now() + 5000 ||
        !Number.isFinite(r.expiresAfter) ||
        r.expiresAfter <= Date.now() ||
        r.expiresAfter > r.createdAt + HL_LEGACY_REVIEW_TTL)
    )
      throw Error("Recovery review expired; review the current evidence again");
    const observation = await native(user, account);
    await exclusions(user, r);
    if (existing) {
      assertObservation(observation, account);
      return archive.recoverLegacyReceipt(user, r, () => {
        assertObservation(observation, account);
        preparedGuard(r);
      });
    }
    if (r.expiresAfter <= Date.now())
      throw Error("Recovery review expired during observation");
    const receipt: HlLegacyRecoveryReceipt = {
      ...(r.format === "CANONICAL_CLIENT_ONLY"
        ? {
            format: r.format,
            packetId: r.packetId,
            mirrorStorageKey: r.mirrorStorageKey,
            mirrorRaw: r.mirrorRaw,
            mirrorHash: r.mirrorHash,
            evidenceHash: r.evidenceHash,
          }
        : {}),
      id: randomUUID(),
      network: "testnet",
      account,
      cloid: r.cloid,
      storageKey: r.storageKey,
      raw: r.raw,
      rawHash: r.rawHash,
      outcome: "UNKNOWN",
      review: r,
      observation,
      acknowledgments: { uncertainty: true, stoppedPrompts: true },
      retiredAt: Date.now(),
      reason: `Owner-reviewed retirement of one ${r.format === "CANONICAL_CLIENT_ONLY" ? "exact canonical client-only" : "legacy"} Testnet UI blocker; historic outcome remains UNKNOWN; no cancellation, rejection, expiry or no-send proof and no retry`,
    };
    return archive.appendLegacyReceipt(user, receipt, () => {
      assertObservation(observation, account);
      preparedGuard(r);
    });
  }
  async function journal(user: string, network: unknown) {
    const account = await scope(user, network);
    return {
      network: "testnet" as const,
      account,
      receipts: await archive.legacyJournal(user, account),
    };
  }
  return { preview, confirm, journal };
}
