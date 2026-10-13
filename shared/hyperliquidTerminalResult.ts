import type {
  HlTerminalPacket,
  HlTerminalResult,
  HlTerminalOrderResult,
} from "./hyperliquidTerminal";
/** Mixed SDK batches retain every result; acknowledgment never certifies installed protection. */
export function parseTerminalResult(
  p: HlTerminalPacket,
  value: unknown,
): HlTerminalResult {
  const r = value as {
    status?: string;
    response?: { type?: string; data?: { statuses?: unknown[] } };
  };
  const explicitReject =
    r?.status === "err" &&
    typeof (r.response as unknown) === "string" &&
    String(r.response).length > 0
      ? String(r.response)
      : null;
  const action = p.action;
  const nativeOrders =
    action.type === "order"
      ? action.orders
      : action.type === "batchModify"
        ? action.modifies.map((m) => m.order)
        : [];
  if (action.type === "updateLeverage")
    return explicitReject
      ? {
          kind: "REJECTED",
          orders: [],
          protection: "NONE",
          reason: explicitReject,
        }
      : r?.status === "ok" && r.response?.type === "default"
        ? { kind: "ACKNOWLEDGED", orders: [], protection: "NONE" }
        : { kind: "UNKNOWN", orders: [], protection: "NONE" };
  const count =
    action.type === "cancel" ? action.cancels.length : nativeOrders.length;
  const statuses = explicitReject
    ? Array.from({ length: count }, () => ({ error: explicitReject }))
    : r?.status === "ok" &&
        (r.response?.type === "order" || r.response?.type === "cancel") &&
        Array.isArray(r.response.data?.statuses)
      ? r.response.data.statuses
      : [];
  const malformed = statuses.length > count;
  const orders: HlTerminalOrderResult[] = Array.from(
    { length: count },
    (_, index) => {
      const o = nativeOrders[index],
        role =
          o && "trigger" in o.t
            ? o.t.trigger.tpsl
            : ["order", "close"].includes(p.kind) && index === 0
              ? "parent"
              : "order";
      const base = { index, role, cloid: o?.c } as Pick<
        HlTerminalOrderResult,
        "index" | "role" | "cloid"
      >;
      const s = statuses[index];
      if (malformed) return { ...base, kind: "UNKNOWN" };
      if (
        s === "success" ||
        s === "waitingForFill" ||
        s === "waitingForTrigger"
      )
        return { ...base, kind: "ACCEPTED" };
      if (s && typeof s === "object" && Object.keys(s).length === 1) {
        if ("error" in s && typeof s.error === "string" && s.error)
          return { ...base, kind: "REJECTED", reason: s.error };
        if (
          "resting" in s &&
          s.resting &&
          typeof s.resting === "object" &&
          "oid" in s.resting &&
          Number.isSafeInteger(s.resting.oid)
        )
          return { ...base, kind: "RESTING", oid: String(s.resting.oid) };
        if (
          "filled" in s &&
          s.filled &&
          typeof s.filled === "object" &&
          "oid" in s.filled &&
          "totalSz" in s.filled &&
          "avgPx" in s.filled &&
          Number.isSafeInteger(s.filled.oid) &&
          typeof s.filled.totalSz === "string" &&
          typeof s.filled.avgPx === "string" &&
          /^\d+(\.\d+)?$/.test(s.filled.totalSz) &&
          /^\d+(\.\d+)?$/.test(s.filled.avgPx) &&
          Number.isFinite(Number(s.filled.totalSz)) &&
          Number.isFinite(Number(s.filled.avgPx)) &&
          Number(s.filled.totalSz) > 0 &&
          Number(s.filled.totalSz) <= Number(o?.s) &&
          Number(s.filled.avgPx) > 0
        )
          return {
            ...base,
            kind: "FILLED",
            oid: String(s.filled.oid),
            filledSize: s.filled.totalSz,
            averagePrice: s.filled.avgPx,
          };
      }
      return { ...base, kind: "UNKNOWN" };
    },
  );
  const protectionOrders = orders.filter(
    (o) => o.role === "sl" || o.role === "tp",
  );
  const protection =
    protectionOrders.length === 0
      ? "NONE"
      : protectionOrders.some((o) => o.kind === "UNKNOWN")
        ? "UNKNOWN"
        : protectionOrders.some((o) => o.kind === "REJECTED")
          ? "REJECTED"
          : "ACCEPTED";
  const accepted = orders.some(
      (o) => o.kind !== "REJECTED" && o.kind !== "UNKNOWN",
    ),
    rejected = orders.some((o) => o.kind === "REJECTED"),
    unknown = orders.some((o) => o.kind === "UNKNOWN");
  const parent = orders.find((o) => o.role === "parent"),
    expectedParent = nativeOrders[0];
  const partialFill = Boolean(
    parent?.kind === "FILLED" &&
      expectedParent &&
      Number(parent.filledSize) < Number(expectedParent.s),
  );
  const kind = unknown
    ? "UNKNOWN"
    : rejected
      ? accepted
        ? "PARTIAL"
        : "REJECTED"
      : partialFill
        ? "PARTIAL"
        : parent?.kind === "FILLED"
          ? "CONFIRMED"
          : action.type === "cancel"
            ? "CONFIRMED"
            : "ACKNOWLEDGED";
  return { kind, orders, protection };
}
