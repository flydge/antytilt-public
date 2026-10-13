import React, { useEffect, useState } from "react";
import { HL_TERMINAL_API } from "../../shared/hyperliquidTerminal";
import {
  HL_LEGACY_RECOVERY_ACCOUNT,
  HL_LEGACY_RECOVERY_CLOID, parseExactCanonicalClientOnlyEvidence,
  type HlLegacyRecoveryReview,
  type HlLegacyRecoveryReceipt,
} from "../../shared/hyperliquidLegacyRecovery";
import type { TerminalPending } from "../hyperliquid/terminalPending";
export type HyperliquidLegacyRecoveryPanelProps = {
  pending: TerminalPending | null;
  review: HlLegacyRecoveryReview | null;
  receipt: HlLegacyRecoveryReceipt | null;
  busy: boolean;
  message: string;
  onReview: () => Promise<void>;
  onArchive: (ack: {
    uncertainty: boolean;
    stoppedPrompts: boolean;
  }) => Promise<void>;
};
// Validate formats as well as field names; malformed stored values are never echoed.
const safeInteger = (value: unknown, max = Number.MAX_SAFE_INTEGER): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= max;
const cloid = (value: unknown): value is string => typeof value === "string" && /^0x[0-9a-fA-F]{32}$/.test(value);
const orderId = (value: unknown): boolean => safeInteger(value) ||
  (typeof value === "string" && /^\d{1,20}$/.test(value) && BigInt(value) <= 18446744073709551615n);
const decimal = (value: unknown): boolean => typeof value === "string" && value.length <= 32 &&
  /^\d+(?:\.\d+)?$/.test(value) && Number(value) > 0 && Number(value) <= 1e18;
const uuid = (value: unknown): value is string => typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
const enums: Record<string, readonly string[]> = {
  type: ["order", "updateLeverage", "cancel", "batchModify"],
  grouping: ["na", "normalTpsl", "positionTpsl"], tif: ["Alo", "Ioc", "Gtc"], tpsl: ["tp", "sl"],
};
const publicFields = (value: unknown, keys: string[]) => {
  const source = value && typeof value === "object" ? value as Record<string, unknown> : {};
  return Object.fromEntries(keys.map(key => {
    const v = source[key];
    const valid = enums[key] ? typeof v === "string" && enums[key].includes(v)
      : ["a", "asset"].includes(key) ? safeInteger(v, 100000)
      : ["b", "r", "isCross", "isMarket"].includes(key) ? typeof v === "boolean"
      : ["p", "s", "triggerPx"].includes(key) ? decimal(v)
      : key === "c" ? cloid(v)
      : ["o", "oid"].includes(key) ? orderId(v)
      : key === "leverage" ? safeInteger(v, 250) && v > 0 : false;
    return [key, valid ? v : null];
  }));
};
function publicPendingAction(action: TerminalPending["action"]) {
  if (!action) return null;
  const order = (value: unknown) => {
    const source = value && typeof value === "object" ? value as Record<string, unknown> : {};
    const t = source.t && typeof source.t === "object" ? source.t as Record<string, unknown> : {};
    return { ...publicFields(source, ["a", "b", "p", "s", "r", "c"]),
      t: t.limit ? { limit: publicFields(t.limit, ["tif"]) } : t.trigger ? { trigger: publicFields(t.trigger, ["isMarket", "triggerPx", "tpsl"]) } : null };
  };
  if (action.type === "order") return { ...publicFields(action, ["type", "grouping"]), orders: Array.isArray(action.orders) ? action.orders.slice(0, 8).map(order) : [] };
  if (action.type === "updateLeverage") return publicFields(action, ["type", "asset", "isCross", "leverage"]);
  if (action.type === "cancel") return { type: action.type, cancels: Array.isArray(action.cancels) ? action.cancels.slice(0, 8).map(c => publicFields(c, ["a", "o"])) : [] };
  if (action.type === "batchModify") return { type: action.type, modifies: Array.isArray(action.modifies) ? action.modifies.slice(0, 8).map(m => ({ ...publicFields(m, ["oid"]), order: order(m?.order) })) : [] };
  return null;
}
function exactSavedCanonical(p: TerminalPending | null) {
  if (!p) return false
  try {
    const { recoveryInDoubt, ...saved } = p
    // Derived marker state can offer an explicit retry, but still blocks all writes.
    if (recoveryInDoubt) saved.invalid = false
    parseExactCanonicalClientOnlyEvidence(
      JSON.stringify(saved),
      `antytilt:hl:terminal-pending:testnet:${p.account}`,
      JSON.stringify({
        cloid: HL_LEGACY_RECOVERY_CLOID,
        message: '',
        unknown: true,
        terminalPacketId: p.packetId,
      }),
      `antytilt:hl:manual-pending:testnet:${p.account}`,
      p.network,
      p.account,
    )
    return true
  } catch {
    return false
  }
}
export function HyperliquidLegacyRecoveryPanel({
  pending,
  review,
  receipt,
  busy,
  message,
  onReview,
  onArchive,
}: HyperliquidLegacyRecoveryPanelProps) {
  const [now, setNow] = useState(Date.now),
    [uncertainty, setUncertainty] = useState(false),
    [stoppedPrompts, setStoppedPrompts] = useState(false),
    [error, setError] = useState("");
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);
  useEffect(() => {
    setUncertainty(false);
    setStoppedPrompts(false);
    setError("");
  }, [review?.id]);
  const diagnostic = Boolean(
    pending?.network === "testnet" &&
      pending.account.toLowerCase() === HL_LEGACY_RECOVERY_ACCOUNT &&
      pending.ids.includes(HL_LEGACY_RECOVERY_CLOID),
  );
  const canonicalExact=exactSavedCanonical(pending);
  const exact = canonicalExact || Boolean(
    pending?.legacy &&
      !pending.packetId &&
      pending.action === null &&
      !pending.invalid &&
      pending.network === "testnet" &&
      pending.account === HL_LEGACY_RECOVERY_ACCOUNT &&
      pending.ids.length === 1 &&
      pending.ids[0] === HL_LEGACY_RECOVERY_CLOID,
  );
  const archived =
    receipt?.network === "testnet" &&
    receipt.account === HL_LEGACY_RECOVERY_ACCOUNT &&
    receipt.cloid === HL_LEGACY_RECOVERY_CLOID &&
    receipt.outcome === "UNKNOWN"
      ? receipt
      : null;
  const current =
    exact &&
    review &&
    review.account === pending?.account &&
    review.cloid === HL_LEGACY_RECOVERY_CLOID &&
    review.network === "testnet" &&
    (canonicalExact ? review.format === "CANONICAL_CLIENT_ONLY" && review.packetId === pending?.packetId : review.format !== "CANONICAL_CLIENT_ONLY")
      ? review
      : null;
  const expired = Boolean(current && current.expiresAfter <= now);
  const attempt = (fn: () => Promise<void>) => {
    setError("");
    void fn().catch((e) =>
      setError(
        e instanceof Error ? e.message : "Old request recovery unavailable",
      ),
    );
  };
  if (!diagnostic && !archived) return null;
  return (
    <section
      className="execution-network hl-grant"
      aria-label={diagnostic && !exact ? "Saved pending Testnet request" : "Old Testnet request recovery"}
      aria-busy={busy}
    >
      <strong>{diagnostic && !exact ? "Saved Pending Request" : "Old Testnet request · UNKNOWN"}</strong>
      <dl className="hl-facts">
        <div>
          <dt>Master EOA</dt>
          <dd>{HL_LEGACY_RECOVERY_ACCOUNT}</dd>
        </div>
        <div>
          <dt>Old client order ID</dt>
          <dd>{HL_LEGACY_RECOVERY_CLOID}</dd>
        </div>
      </dl>
      {diagnostic && pending && (
        <>
          {!exact && <p>This saved request is not eligible for the legacy archive. Its pending reconciliation lock stays in place.</p>}
          <details>
            <summary>Saved pending request details</summary>
            <pre aria-label="Saved pending request public fields" style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere", fontSize: 11 }}>
              {JSON.stringify({
                version: pending.version === 1 ? 1 : null,
                legacy: typeof pending.legacy === "boolean" ? pending.legacy : null,
                invalid: pending.invalid === undefined ? false : typeof pending.invalid === "boolean" ? pending.invalid : null,
                network: pending.network === "testnet" || pending.network === "mainnet" ? pending.network : null,
                account: typeof pending.account === "string" && /^0x[0-9a-fA-F]{40}$/.test(pending.account) ? pending.account : null,
                packetId: uuid(pending.packetId) ? pending.packetId : null,
                ids: Array.isArray(pending.ids) ? pending.ids.slice(0, 8).filter(id => typeof id === "string" && (cloid(id) || orderId(id))) : [],
                createdAt: safeInteger(pending.createdAt) ? pending.createdAt : null,
                expiresAfter: safeInteger(pending.expiresAfter) ? pending.expiresAfter : null,
                action: publicPendingAction(pending.action),
              }, null, 2)}
            </pre>
          </details>
        </>
      )}
      {exact && (
        <>
          <p>
            The old result is unknown and blocks new reviews. Archiving keeps
            its evidence and retires this one blocker. It does not prove
            cancellation, rejection or expiry; the signed old action may still
            cause an effect.
          </p>
          {canonicalExact ? <>
            <p>Saved old request: BUY 0.00944 BTC at saved limit 82923 USD, IOC · saved notional approximately 782.79 USD. This is the saved old request, separate from any new independently reviewed demo action.</p>
            <p>Action and timestamps are unverified saved metadata. Saved creation: {pending?.createdAt}; saved expiry: {pending?.expiresAfter}. These values do not prove native expiry or that the request was never sent. The original signing nonce is missing. No retry will be sent.</p>
            {pending?.recoveryInDoubt && <p role="alert">Local archive retirement is in doubt. New signatures remain blocked. Review again to validate the saved receipt and restore only missing original records.</p>}
          </> : <p>
            The original action, signing nonce, creation time and expiry were
            not recorded. No retry will be sent.
          </p>}
          {current && (
            <>
              <p>
                Native account observed at{" "}
                <time
                  dateTime={new Date(
                    current.observation.checkedAt,
                  ).toISOString()}
                >
                  {new Date(current.observation.checkedAt).toLocaleTimeString()}
                </time>
                : unknown order ID, no active positions or orders. Returned
                history is bounded and does not prove historical absence.
              </p>
              <p role="status">
                {expired
                  ? "Review expired. Review the current evidence again."
                  : `Local archive review expires in ${Math.max(0, Math.ceil((current.expiresAfter - now) / 1000))}s. Confirmation checks the native account again.`}
              </p>
              <label className="hl-check">
                <input
                  type="checkbox"
                  checked={uncertainty}
                  disabled={busy || expired}
                  onChange={(e) => setUncertainty(e.target.checked)}
                />
                I accept that the old result stays UNKNOWN, including its
                remaining uncertainty, and want only new independently reviewed
                Testnet actions.
              </label>
              <label className="hl-check">
                <input
                  type="checkbox"
                  checked={stoppedPrompts}
                  disabled={busy || expired}
                  onChange={(e) => setStoppedPrompts(e.target.checked)}
                />
                All old wallet prompts and old operations have stopped.
              </label>
              <details>
                <summary>Review evidence</summary>
                <pre
                  style={{
                    whiteSpace: "pre-wrap",
                    overflowWrap: "anywhere",
                    fontSize: 11,
                  }}
                >
                  {JSON.stringify(
                    {
                      missingFields: current.missingFields,
                      observation: current.observation,
                      rawHash: current.rawHash,
                      ...(current.format === "CANONICAL_CLIENT_ONLY" ? {format:current.format, packetId:current.packetId, savedAction:publicPendingAction(pending?.action??null), savedCreatedAt:pending?.createdAt, savedExpiresAfter:pending?.expiresAfter, mirrorStorageKey:current.mirrorStorageKey, mirrorHash:current.mirrorHash, evidenceHash:current.evidenceHash} : {raw:current.raw}),
                    },
                    null,
                    2,
                  )}
                </pre>
              </details>
            </>
          )}
          <div className="hl-actions">
            <button
              type="button"
              disabled={busy}
              onClick={() => attempt(onReview)}
            >
              Review Old Testnet Request
            </button>
            {current && (
              <button
                type="button"
                disabled={busy || expired || !uncertainty || !stoppedPrompts}
                onClick={() =>
                  attempt(() => onArchive({ uncertainty, stoppedPrompts }))
                }
              >
                Archive Old Request
              </button>
            )}
          </div>
        </>
      )}
      {archived && (
        <>
          <p role="status">
            Archive saved. The historic result remains UNKNOWN. No retry was
            sent.
          </p>
          <details>
            <summary>Archived UNKNOWN receipt</summary>
            <dl className="hl-facts">
              <div>
                <dt>Archived at</dt>
                <dd>{new Date(archived.retiredAt).toLocaleString()}</dd>
              </div>
              <div>
                <dt>Evidence hash</dt>
                <dd>{archived.evidenceHash??archived.rawHash}</dd>
              </div>
              <div>
                <dt>Receipt</dt>
                <dd>{archived.id}</dd>
              </div>
            </dl>
            <p>{archived.reason}</p>
            <a
              href={`${HL_TERMINAL_API}/legacy-recovery/journal?network=testnet`}
              target="_blank"
              rel="noreferrer"
            >
              View durable archive journal
            </a>
          </details>
        </>
      )}
      {busy && (
        <p role="status">Checking and preserving old request evidence…</p>
      )}
      {message && <p role="status">{message}</p>}
      {error && (
        <p className="exchange-error" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}
