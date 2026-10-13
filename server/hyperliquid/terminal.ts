import { HttpTransport, InfoClient } from "@nktkas/hyperliquid";
import Decimal from "decimal.js";
import { randomBytes, randomUUID } from "node:crypto";
import type {
  HlTerminalSnapshot,
  HlTerminalPreviewRequest,
  HlTerminalPacket,
  HlTerminalAction,
  HlTerminalOrder,
  HlTerminalOrderInput,
  HlTerminalNetwork,
  HlTerminalHistory,
} from "../../shared/hyperliquidTerminal";
import { validateTerminalPacket } from "../../shared/hyperliquidTerminal";
import { canonicalAccount } from "./client";
const decimal = (value: unknown, positive = true) => {
  if (typeof value !== "string" || !/^-?\d+(\.\d+)?$/.test(value))
    throw Error("Invalid decimal input");
  const d = new Decimal(value);
  if (!d.isFinite() || (positive && d.lte(0)))
    throw Error("Invalid decimal bounds");
  return d;
};
const price = (value: Decimal, decimals: number, rounding: Decimal.Rounding) =>
  value
    .toSignificantDigits(5, rounding)
    .toDecimalPlaces(6 - decimals, rounding)
    .toFixed();
function fresh(s: HlTerminalSnapshot, now: number) {
  if (s.network !== "testnet") throw Error("Mainnet writes are disabled");
  if (
    s.coin !== "BTC" ||
    s.masterRole !== "user" ||
    !["disabled", "unifiedAccount"].includes(s.mode)
  )
    throw Error("Unsupported direct master role or account mode");
  canonicalAccount(s.account);
  if (
    !Number.isFinite(s.checkedAt) ||
    now - s.checkedAt > 3000 ||
    s.checkedAt > now + 5000
  )
    throw Error("Provider snapshot stale");
  if (
    !Number.isInteger(s.asset) ||
    s.asset < 0 ||
    !Number.isInteger(s.szDecimals) ||
    s.szDecimals < 0 ||
    s.szDecimals > 6 ||
    !Number.isInteger(s.leverage) ||
    s.leverage < 1 ||
    s.leverage > s.maxLeverage
  )
    throw Error("Native metadata or leverage unavailable");
  if (
    !Number.isFinite(s.makerFeeRate) ||
    !Number.isFinite(s.takerFeeRate) ||
    s.makerFeeRate < 0 ||
    s.takerFeeRate < 0 ||
    s.takerFeeRate > 0.01
  )
    throw Error("Native fees unavailable");
  decimal(s.position, false);
  decimal(s.markPx);
}
export const validateTerminalSnapshot = fresh;

function validateActionBounds(s: HlTerminalSnapshot, action: HlTerminalAction) {
  if (action.type === "updateLeverage") {
    if (action.leverage > s.maxLeverage)
      throw Error("Target leverage exceeds fresh native maximum");
    return;
  }
  const orders =
    action.type === "order"
      ? action.orders
      : action.type === "batchModify"
        ? action.modifies.map((m) => m.order)
        : [];
  for (const o of orders) {
    const qty = decimal(o.s),
      position = decimal(s.position, false);
    if (o.r) {
      // Attached entry stops are reduce-only against the position created by the parent.
      const attached =
        action.type === "order" &&
        action.grouping === "normalTpsl" &&
        "trigger" in o.t;
      if (
        !attached &&
        (position.isZero() ||
          o.b !== position.isNegative() ||
          qty.gt(position.abs()))
      )
        throw Error(
          "Reduce-only action must oppose and not exceed fresh residual",
        );
    } else {
      const index = o.b ? 0 : 1;
      if (qty.gt(decimal(s.activeAssetData.maxTradeSzs[index], false)))
        throw Error("Quantity exceeds fresh native maximum trade size");
      const bound = Decimal.max(decimal(s.markPx), decimal(o.p)).mul(qty);
      if (
        bound
          .div(s.leverage)
          .plus(bound.mul(s.takerFeeRate))
          .gt(decimal(s.activeAssetData.availableToTrade[index], false))
      )
        throw Error("Order margin exceeds fresh native available to trade");
    }
  }
}
export function validateTerminalAuthorization(
  p: HlTerminalPacket,
  s: HlTerminalSnapshot,
  now: number,
) {
  validateTerminalPacket(p, now);
  fresh(s, now);
  validateActionBounds(s, p.action);
  if (
    s.account.toLowerCase() !== p.account.toLowerCase() ||
    s.network !== p.network ||
    s.coin !== p.coin ||
    s.asset !== p.asset ||
    s.szDecimals !== p.szDecimals ||
    s.mode !== p.mode
  )
    throw Error("Linked master/network/native metadata changed");
  if (
    !decimal(s.position, false).eq(p.positionBefore) ||
    s.leverage !== p.settingBefore.leverage ||
    s.marginType !== p.settingBefore.marginType
  )
    throw Error("Position or actual leverage/margin changed; discard preview");
  if (
    ["cancel", "amend", "protection", "order", "close"].includes(p.kind) &&
    JSON.stringify(s.openOrders) !== JSON.stringify(p.ordersBefore)
  )
    throw Error("Open orders changed; discard preview");
}
/** Native attached TP/SL can remain nested under a partially filled entry. */
function hasExistingProtection(
  orders: HlTerminalSnapshot["openOrders"],
): boolean {
  const maximumNodes = 10000;
  if (orders.length > maximumNodes)
    throw Error("Open-order hierarchy exceeds safe inspection bounds");
  const pending = [...orders];
  let scheduled = orders.length;
  while (pending.length) {
    const order = pending.pop()!;
    if (order.reduceOnly && order.isTrigger) return true;
    const children = order.children;
    if (children === undefined) continue;
    if (!Array.isArray(children))
      throw Error(
        "Open-order hierarchy unavailable; cannot certify protection absence",
      );
    scheduled += children.length;
    if (scheduled > maximumNodes)
      throw Error("Open-order hierarchy exceeds safe inspection bounds");
    for (const child of children) pending.push(child);
  }
  return false;
}
export function previewTerminalAction(
  s: HlTerminalSnapshot,
  r: HlTerminalPreviewRequest,
  now: number,
  cloid: () => `0x${string}` = () => `0x${randomBytes(16).toString("hex")}`,
): HlTerminalPacket {
  fresh(s, now);
  if (r.network !== s.network || (r.coin && r.coin !== "BTC"))
    throw Error("Network or coin mismatch");
  const i = r.input as Record<string, unknown>;
  if (!i || typeof i !== "object" || Array.isArray(i))
    throw Error("Input required");
  const mark = decimal(s.markPx),
    position = decimal(s.position, false);
  let action: HlTerminalAction;
  let quantity: string | null = null,
    notionalUsd: string | null = null,
    marginUsdc: string | null = null,
    referencePrice = s.markPx;
  const slippage = i.maxSlippageBps ?? 25;
  if (
    !Number.isInteger(slippage) ||
    Number(slippage) < 1 ||
    Number(slippage) > 100
  )
    throw Error("Maximum slippage must be1–100bps");
  const ioc = (
    buy: boolean,
    size: string,
    reference = mark,
  ): HlTerminalOrder => ({
    a: s.asset,
    b: buy,
    p: price(
      reference.mul(
        new Decimal(1).plus(
          new Decimal(Number(slippage)).div(10000).mul(buy ? 1 : -1),
        ),
      ),
      s.szDecimals,
      buy ? Decimal.ROUND_DOWN : Decimal.ROUND_UP,
    ),
    s: size,
    r: true,
    t: { limit: { tif: "Ioc" } },
    c: cloid(),
  });
  const protections = (
    buy: boolean,
    size: string,
    reference: Decimal,
  ): HlTerminalOrder[] => {
    if (i.triggerSource && i.triggerSource !== "MARK_PRICE")
      throw Error("Native trigger source is mark price only");
    return (["stopLoss", "takeProfit"] as const).flatMap((key) => {
      if (i[key] === undefined || i[key] === "") return [];
      const raw = i[key],
        config =
          typeof raw === "string"
            ? { triggerPrice: raw, execution: "MARKET" }
            : (raw as {
                triggerPrice: string;
                execution: string;
                price?: string;
              });
      if (!config || !["MARKET", "LIMIT"].includes(config.execution))
        throw Error("Unsupported protection execution");
      const trigger = decimal(config.triggerPrice);
      const sl = key === "stopLoss";
      if (
        buy
          ? sl
            ? trigger.gte(reference)
            : trigger.lte(reference)
          : sl
            ? trigger.lte(reference)
            : trigger.gte(reference)
      )
        throw Error(
          "Stop Loss/Take Profit must be on correct side of reference price",
        );
      const triggerPx = price(trigger, s.szDecimals, Decimal.ROUND_HALF_UP),
        rounded = decimal(triggerPx);
      if (
        buy
          ? sl
            ? rounded.gte(reference)
            : rounded.lte(reference)
          : sl
            ? rounded.lte(reference)
            : rounded.gte(reference)
      )
        throw Error("Rounded stop is on wrong side");
      const o = ioc(!buy, size, rounded);
      return [
        {
          ...o,
          p:
            config.execution === "LIMIT"
              ? price(
                  decimal(config.price),
                  s.szDecimals,
                  !buy ? Decimal.ROUND_DOWN : Decimal.ROUND_UP,
                )
              : o.p,
          t: {
            trigger: {
              isMarket: config.execution === "MARKET",
              triggerPx,
              tpsl: sl ? "sl" : "tp",
            },
          },
        },
      ];
    });
  };
  if (r.kind === "settings") {
    const lev = i.leverage;
    if (
      !Number.isInteger(lev) ||
      Number(lev) < 1 ||
      Number(lev) > s.maxLeverage ||
      !["cross", "isolated"].includes(String(i.marginType))
    )
      throw Error("Leverage or margin type outside native bounds");
    if (!position.isZero())
      throw Error("Settings changes require flat position in this terminal");
    action = {
      type: "updateLeverage",
      asset: s.asset,
      isCross: i.marginType === "cross",
      leverage: Number(lev),
    };
  } else if (r.kind === "order") {
    const input = r.input as HlTerminalOrderInput;
    if (input.reduceOnly !== undefined && typeof input.reduceOnly !== "boolean")
      throw Error("Invalid reduce-only flag");
    if (!input.reduceOnly && (!position.isZero() || s.openOrders.length > 0))
      throw Error(
        "Entry requires flat position and no existing BTC orders; scaling is unsupported",
      );
    if (input.leverage !== s.leverage || input.marginType !== s.marginType)
      throw Error(
        "Actual leverage/margin differs; update and reconcile settings first",
      );
    if (
      !["BUY", "SELL"].includes(input.side) ||
      !["MARKET", "LIMIT"].includes(input.orderType) ||
      !["COST", "VALUE", "QUANTITY"].includes(input.sizeMode)
    )
      throw Error("Unsupported order type/side/size mode");
    const buy = input.side === "BUY",
      reference =
        input.orderType === "LIMIT" ? decimal(input.limitPrice) : mark,
      amount = decimal(input.amount),
      qty = (
        input.sizeMode === "QUANTITY"
          ? amount
          : amount
              .mul(input.sizeMode === "COST" ? s.leverage : 1)
              .div(reference)
      ).toDecimalPlaces(s.szDecimals, Decimal.ROUND_DOWN);
    if (qty.lte(0)) throw Error("Quantity is dust at native precision");
    if (
      input.reduceOnly &&
      (position.isZero() ||
        buy !== position.isNegative() ||
        qty.gt(position.abs()) ||
        input.stopLoss ||
        input.takeProfit)
    )
      throw Error(
        "Reduce-only order must oppose and not exceed current residual; attached stops unsupported",
      );
    quantity = qty.toFixed();
    const o =
      input.orderType === "MARKET"
        ? { ...ioc(buy, quantity), r: input.reduceOnly === true }
        : ({
            a: s.asset,
            b: buy,
            p: price(
              reference,
              s.szDecimals,
              buy ? Decimal.ROUND_DOWN : Decimal.ROUND_UP,
            ),
            s: quantity,
            r: input.reduceOnly === true,
            t: { limit: { tif: input.tif ?? "Gtc" } },
            c: cloid(),
          } as HlTerminalOrder);
    if ("limit" in o.t && !["Gtc", "Alo", "Ioc"].includes(o.t.limit.tif))
      throw Error("Unsupported TIF; FOK is unavailable");
    if (qty.mul(decimal(o.p)).lt(10))
      throw Error("Rounded order below native10USD minimum");
    // LIMIT estimates use the exact signed entry price; MARKET keeps the mark
    // estimate distinct from its worst permitted IOC execution price.
    referencePrice = input.orderType === "LIMIT" ? o.p : s.markPx;
    notionalUsd = qty.mul(reference).toFixed();
    marginUsdc = qty.mul(reference).div(s.leverage).toFixed();
    const stops = protections(buy, quantity, reference);
    action = {
      type: "order",
      orders: [o, ...stops],
      grouping: stops.length ? "normalTpsl" : "na",
    };
  } else if (r.kind === "close") {
    if (position.isZero()) throw Error("No BTC position to close");
    if (position.abs().decimalPlaces() > s.szDecimals)
      throw Error("Full residual cannot be represented at native precision");
    const closeSize = i.size === undefined ? position.abs() : decimal(i.size);
    if (
      closeSize.gt(position.abs()) ||
      closeSize.decimalPlaces() > s.szDecimals
    )
      throw Error(
        "Close size must be representable and not exceed fresh residual",
      );
    quantity = closeSize.toFixed();
    notionalUsd = closeSize.mul(mark).toFixed();
    action = {
      type: "order",
      orders: [ioc(position.isNegative(), quantity)],
      grouping: "na",
    };
  } else if (r.kind === "protection") {
    if (position.isZero())
      throw Error("Position protection requires current position");
    quantity = position.abs().toFixed();
    const orders = protections(position.isPositive(), quantity, mark);
    if (!orders.length) throw Error("At least one protection price required");
    if (hasExistingProtection(s.openOrders))
      throw Error("Existing protection must be canceled or amended explicitly");
    action = { type: "order", orders, grouping: "positionTpsl" };
  } else if (r.kind === "cancel" || r.kind === "amend") {
    if (
      typeof i.oid !== "string" ||
      !/^\d+$/.test(i.oid) ||
      !Number.isSafeInteger(Number(i.oid))
    )
      throw Error("Invalid native order ID");
    const old = s.openOrders.find((o) => String(o.oid) === i.oid);
    if (!old) throw Error("Order is not in fresh account snapshot");
    if (r.kind === "cancel")
      action = { type: "cancel", cancels: [{ a: s.asset, o: old.oid }] };
    else {
      const qty = decimal(i.size ?? old.sz);
      if (qty.decimalPlaces() > s.szDecimals)
        throw Error("Amended size exceeds native precision");
      if (old.isTrigger || old.isPositionTpsl || old.children.length)
        throw Error(
          "Native trigger replacement may duplicate when cancellation fails; cancel explicitly, refresh, and review new protection",
        );
      const p = price(
        decimal(i.price),
        s.szDecimals,
        old.side === "B" ? Decimal.ROUND_DOWN : Decimal.ROUND_UP,
      );
      const t: HlTerminalOrder["t"] = old.isTrigger
        ? {
            trigger: {
              isMarket: old.orderType.endsWith("Market"),
              triggerPx: price(
                decimal(i.triggerPrice ?? old.triggerPx),
                s.szDecimals,
                Decimal.ROUND_HALF_UP,
              ),
              tpsl: old.orderType.startsWith("Stop") ? "sl" : "tp",
            },
          }
        : {
            limit: {
              tif:
                old.tif === "FrontendMarket"
                  ? "Ioc"
                  : (old.tif as "Gtc" | "Alo" | "Ioc"),
            },
          };
      if ("limit" in t && !["Gtc", "Alo", "Ioc"].includes(t.limit.tif))
        throw Error("Unsupported existing native TIF");
      if (!old.reduceOnly && qty.gt(decimal(old.sz)))
        throw Error(
          "Increasing an amended order is unsupported; prepare new entry",
        );
      action = {
        type: "batchModify",
        modifies: [
          {
            oid: old.oid,
            order: {
              a: s.asset,
              b: old.side === "B",
              p,
              s: qty.toFixed(),
              r: old.reduceOnly,
              t,
              // Reconciliation must identify the replacement, never the old
              // resting order if the amendment response is uncertain.
              c: cloid(),
            },
          },
        ],
      };
    }
  } else throw Error("Unsupported terminal action");
  validateActionBounds(s, action);
  const packet: HlTerminalPacket = {
    id: randomUUID(),
    seal: "",
    network: s.network,
    account: canonicalAccount(s.account),
    coin: "BTC",
    kind: r.kind,
    asset: s.asset,
    szDecimals: s.szDecimals,
    mode: s.mode,
    positionBefore: s.position,
    settingBefore: { leverage: s.leverage, marginType: s.marginType },
    ordersBefore: structuredClone(s.openOrders),
    checkedAt: s.checkedAt,
    createdAt: now,
    expiresAfter: now + 60000,
    action,
    summary: {
      quantity,
      notionalUsd,
      marginUsdc,
      referencePrice,
      leverage: r.kind === "settings" ? Number(i.leverage) : s.leverage,
      marginType:
        r.kind === "settings"
          ? (i.marginType as "cross" | "isolated")
          : s.marginType,
      ...(r.kind === "order"
        ? {
            sizeMode: (r.input as HlTerminalOrderInput).sizeMode,
            requestedAmount: (r.input as HlTerminalOrderInput).amount,
          }
        : {}),
    },
  };
  validateTerminalPacket(packet, now);
  return packet;
}
export interface TerminalProvider {
  read(
    account: string,
    freshAuthorization?: boolean,
  ): Promise<HlTerminalSnapshot>;
  order(account: string, id: string): Promise<{ status: string; oid?: string }>;
  history(account: string): Promise<HlTerminalHistory>;
}
/** Info-only provider. Fresh authorization bypasses role/mode/meta cache. */
export function createTerminalProvider(
  network: HlTerminalNetwork,
): TerminalProvider {
  if (!["testnet", "mainnet"].includes(network))
    throw Error("Unsupported network");
  const info = new InfoClient({
    transport: new HttpTransport({
      isTestnet: network === "testnet",
      timeout: 8000,
    }),
  });
  let metaCache:
    | { at: number; promise: ReturnType<InfoClient["meta"]> }
    | undefined;
  const feeCache = new Map<
    string,
    { at: number; promise: ReturnType<InfoClient["userFees"]> }
  >();
  const fees = (user: `0x${string}`) => {
    let c = feeCache.get(user);
    if (!c || Date.now() - c.at > 60000) {
      c = { at: Date.now(), promise: info.userFees({ user }) };
      feeCache.set(user, c);
    }
    return c.promise;
  };
  const identityCache = new Map<
    string,
    { at: number; promise: Promise<[string, { role: string }]> }
  >();
  const metadata = (force: boolean) => {
    if (force || !metaCache || Date.now() - metaCache.at > 60000)
      metaCache = { at: Date.now(), promise: info.meta() };
    return metaCache.promise;
  };
  const identity = (user: `0x${string}`, force: boolean) => {
    let c = identityCache.get(user);
    if (force || !c || Date.now() - c.at > 60000) {
      c = {
        at: Date.now(),
        promise: Promise.all([
          info.userAbstraction({ user }),
          info.userRole({ user }),
        ]),
      };
      identityCache.set(user, c);
    }
    return c.promise;
  };
  return {
    async read(account, force = false) {
      const user = canonicalAccount(account) as `0x${string}`,
        checkedAt = Date.now();
      const [meta, [mode, role], active, state, spot, orders, book, userFees] =
        await Promise.all([
          metadata(force),
          identity(user, force),
          info.activeAssetData({ user, coin: "BTC" }),
          info.clearinghouseState({ user }),
          info.spotClearinghouseState({ user }),
          info.frontendOpenOrders({ user }),
          info.l2Book({ coin: "BTC" }),
          fees(user),
        ]);
      const asset = meta.universe.findIndex((x) => x.name === "BTC");
      if (
        asset < 0 ||
        meta.universe[asset].isDelisted ||
        active.user.toLowerCase() !== user ||
        active.coin !== "BTC"
      )
        throw Error("Native BTC/account metadata unavailable");
      return {
        network,
        account: user,
        coin: "BTC",
        asset,
        szDecimals: meta.universe[asset].szDecimals,
        maxLeverage: meta.universe[asset].maxLeverage,
        mode,
        masterRole: role.role,
        checkedAt,
        markPx: active.markPx,
        bid: book?.levels[0][0]?.px ?? null,
        ask: book?.levels[1][0]?.px ?? null,
        makerFeeRate: Number(userFees.userAddRate),
        takerFeeRate: Number(userFees.userCrossRate),
        leverage: active.leverage.value,
        marginType: active.leverage.type,
        position:
          state.assetPositions.find((x) => x.position.coin === "BTC")?.position
            .szi ?? "0",
        activeAssetData: active,
        clearinghouseState: state,
        spotClearinghouseState: spot,
        openOrders: orders.filter((x) => x.coin === "BTC"),
      };
    },
    async order(account, id) {
      if (!/^0x[0-9a-f]{32}$/.test(id) && !/^\d+$/.test(id))
        throw Error("Invalid order identifier");
      const r = await info.orderStatus({
        user: canonicalAccount(account) as `0x${string}`,
        oid: id as `0x${string}`,
      });
      return r.status === "order"
        ? { status: r.order.status, oid: String(r.order.order.oid) }
        : { status: "unknownOid" };
    },
    async history(account) {
      const user = canonicalAccount(account) as `0x${string}`;
      const [fills, orders] = await Promise.all([
        info.userFills({ user }),
        info.historicalOrders({ user }),
      ]);
      return {
        network,
        account: user,
        checkedAt: Date.now(),
        fills: fills.filter((f) => f.coin === "BTC"),
        orders: orders.filter((o) => o.order.coin === "BTC"),
      };
    },
  };
}
