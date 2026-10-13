import type {
  ActiveAssetDataResponse,
  ClearinghouseStateResponse,
  FrontendOpenOrdersResponse,
  SpotClearinghouseStateResponse,
  UserFillsResponse,
  HistoricalOrdersResponse,
} from "@nktkas/hyperliquid/api/info";
import type { HlTerminalAgentExecution } from "./hyperliquidTerminalAgent";
export const HL_TERMINAL_API = "/api/hyperliquid-terminal";
export type HlTerminalNetwork = "testnet" | "mainnet";
export type HlTerminalKind =
  | "order"
  | "settings"
  | "close"
  | "cancel"
  | "amend"
  | "protection";
export type HlTerminalProtectionInput =
  | string
  | { triggerPrice: string; execution: "MARKET" | "LIMIT"; price?: string };
export type HlTerminalOrder = {
  a: number;
  b: boolean;
  p: string;
  s: string;
  r: boolean;
  c: `0x${string}`;
  t:
    | { limit: { tif: "Gtc" | "Alo" | "Ioc" } }
    | { trigger: { isMarket: boolean; triggerPx: string; tpsl: "sl" | "tp" } };
};
export type HlTerminalAction =
  | {
      type: "order";
      orders: HlTerminalOrder[];
      grouping: "na" | "normalTpsl" | "positionTpsl";
    }
  | {
      type: "updateLeverage";
      asset: number;
      isCross: boolean;
      leverage: number;
    }
  | { type: "cancel"; cancels: { a: number; o: number }[] }
  | {
      type: "batchModify";
      modifies: { oid: number; order: HlTerminalOrder }[];
    };
export interface HlTerminalSnapshot {
  network: HlTerminalNetwork;
  account: string;
  coin: "BTC";
  asset: number;
  szDecimals: number;
  maxLeverage: number;
  mode: string;
  masterRole: string;
  checkedAt: number;
  markPx: string;
  bid: string | null;
  ask: string | null;
  leverage: number;
  marginType: "cross" | "isolated";
  position: string;
  makerFeeRate: number;
  takerFeeRate: number;
  activeAssetData: ActiveAssetDataResponse;
  clearinghouseState: ClearinghouseStateResponse;
  spotClearinghouseState: SpotClearinghouseStateResponse;
  openOrders: FrontendOpenOrdersResponse;
}
export interface HlTerminalStatus {
  network: HlTerminalNetwork;
  writesEnabled: boolean;
  snapshot: HlTerminalSnapshot | null;
}
export interface HlTerminalOrderInput {
  side: "BUY" | "SELL";
  orderType: "MARKET" | "LIMIT";
  sizeMode: "COST" | "VALUE" | "QUANTITY";
  amount: string;
  leverage: number;
  marginType: "cross" | "isolated";
  limitPrice?: string;
  tif?: "Gtc" | "Alo" | "Ioc";
  maxSlippageBps?: number;
  stopLoss?: HlTerminalProtectionInput;
  takeProfit?: HlTerminalProtectionInput;
  triggerSource?: "MARK_PRICE";
  reduceOnly?: boolean;
}
export type HlTerminalInput =
  | HlTerminalOrderInput
  | { leverage: number; marginType: "cross" | "isolated" }
  | { size?: string; maxSlippageBps?: number }
  | { oid: string }
  | { oid: string; price: string; size?: string; triggerPrice?: string }
  | {
      stopLoss?: HlTerminalProtectionInput;
      takeProfit?: HlTerminalProtectionInput;
      triggerSource?: "MARK_PRICE";
      maxSlippageBps?: number;
    };
export interface HlTerminalPreviewRequest {
  network: HlTerminalNetwork;
  coin?: "BTC";
  kind: HlTerminalKind;
  input: HlTerminalInput;
}
export interface HlTerminalPacket {
  id: string;
  seal: string;
  network: HlTerminalNetwork;
  account: string;
  coin: "BTC";
  kind: HlTerminalKind;
  asset: number;
  szDecimals: number;
  mode: string;
  positionBefore: string;
  settingBefore: { leverage: number; marginType: "cross" | "isolated" };
  ordersBefore: FrontendOpenOrdersResponse;
  checkedAt: number;
  createdAt: number;
  expiresAfter: number;
  action: HlTerminalAction;
  summary: {
    quantity: string | null;
    notionalUsd: string | null;
    marginUsdc: string | null;
    referencePrice: string;
    leverage: number;
    marginType: "cross" | "isolated";
    sizeMode?: "COST" | "VALUE" | "QUANTITY";
    requestedAmount?: string;
  };
}
export interface HlTerminalValidation {
  network: HlTerminalNetwork;
  valid: true;
  snapshot: HlTerminalSnapshot;
}
export interface HlTerminalReconcile {
  network: HlTerminalNetwork;
  snapshot: HlTerminalSnapshot;
  orders: { id: string; status: string; oid?: string }[];
  settingsConfirmed?: boolean;
  agentExecution?: HlTerminalAgentExecution | null;
}
export interface HlTerminalHistory {
  network: HlTerminalNetwork;
  account: string;
  checkedAt: number;
  fills: UserFillsResponse;
  orders: HistoricalOrdersResponse;
}
export type HlTerminalOrderResult = {
  index: number;
  role: "parent" | "sl" | "tp" | "order";
  cloid?: string;
  kind: "FILLED" | "RESTING" | "ACCEPTED" | "REJECTED" | "UNKNOWN";
  oid?: string;
  filledSize?: string;
  averagePrice?: string;
  reason?: string;
};
export interface HlTerminalResult {
  kind: "CONFIRMED" | "ACKNOWLEDGED" | "REJECTED" | "PARTIAL" | "UNKNOWN";
  orders: HlTerminalOrderResult[];
  protection: "NONE" | "ACCEPTED" | "REJECTED" | "UNKNOWN";
  reason?: string;
}

/** Defence in depth; the authenticated server also verifies the immutable seal and fresh account. */
export function validateTerminalPacket(p: HlTerminalPacket, now: number) {
  if (
    !p ||
    p.network !== "testnet" ||
    p.coin !== "BTC" ||
    !/^0x[0-9a-fA-F]{40}$/.test(p.account) ||
    !["disabled", "unifiedAccount"].includes(p.mode)
  )
    throw Error("Unsupported owner/network/mode; mainnet writes disabled");
  if (
    !Number.isFinite(p.createdAt) ||
    !Number.isFinite(p.checkedAt) ||
    !Number.isFinite(p.expiresAfter) ||
    p.expiresAfter <= now ||
    p.createdAt > now + 5000 ||
    p.checkedAt > now + 5000 ||
    p.createdAt - p.checkedAt > 3000 ||
    now - p.createdAt > 60000 ||
    p.expiresAfter > p.createdAt + 60000
  )
    throw Error("Packet expired or stale");
  if (
    !Number.isInteger(p.asset) ||
    p.asset < 0 ||
    !Number.isInteger(p.szDecimals) ||
    p.szDecimals < 0 ||
    p.szDecimals > 6
  )
    throw Error("Invalid native metadata");
  const action = p.action;
  if (action.type === "order" || action.type === "batchModify") {
    const orders =
      action.type === "order"
        ? action.orders
        : action.modifies.map((m) => m.order);
    if (!orders.length || orders.length > 3) throw Error("Invalid order count");
    for (const o of orders) {
      if (
        o.a !== p.asset ||
        typeof o.b !== "boolean" ||
        typeof o.r !== "boolean" ||
        !/^0x[0-9a-f]{32}$/.test(o.c) ||
        !validNativeDecimal(o.s, p.szDecimals, false) ||
        !validNativeDecimal(o.p, 6 - p.szDecimals, true)
      )
        throw Error("Invalid native order bounds/precision");
      if ("trigger" in o.t) {
        if (
          !o.r ||
          !["sl", "tp"].includes(o.t.trigger.tpsl) ||
          !validNativeDecimal(o.t.trigger.triggerPx, 6 - p.szDecimals, true)
        )
          throw Error("Invalid native reduce-only trigger");
      } else if (!["Gtc", "Alo", "Ioc"].includes(o.t.limit.tif))
        throw Error("Unsupported native TIF");
    }
    if (p.kind === "close" && orders.some((o) => !o.r))
      throw Error("Close must be reduce-only");
  } else if (action.type === "updateLeverage") {
    if (
      p.kind !== "settings" ||
      action.asset !== p.asset ||
      !Number.isInteger(action.leverage) ||
      action.leverage < 1 ||
      typeof action.isCross !== "boolean"
    )
      throw Error("Invalid native settings");
  } else if (action.type === "cancel") {
    if (
      p.kind !== "cancel" ||
      action.cancels.length !== 1 ||
      action.cancels.some(
        (c) => c.a !== p.asset || !Number.isSafeInteger(c.o) || c.o < 0,
      )
    )
      throw Error("Invalid cancellation");
  } else throw Error("Unsupported native action");
}
function validNativeDecimal(v: string, decimals: number, price: boolean) {
  if (
    typeof v !== "string" ||
    !/^\d+(\.\d+)?$/.test(v) ||
    !Number.isFinite(Number(v)) ||
    Number(v) <= 0
  )
    return false;
  const [whole, fraction = ""] = v.split(".");
  if (fraction.length > decimals) return false;
  return (
    !price ||
    fraction.length === 0 ||
    (whole + fraction).replace(/^0+/, "").length <= 5
  );
}
