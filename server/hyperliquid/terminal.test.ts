import assert from "node:assert/strict";
import { test } from "node:test";
import {
  previewTerminalAction,
  validateTerminalAuthorization,
} from "./terminal";
import type {
  HlTerminalSnapshot,
  HlTerminalOrderInput,
} from "../../shared/hyperliquidTerminal";
const now = 1791800000000,
  account = "0x" + "1".repeat(40);
const snapshot = (
  changes: Partial<HlTerminalSnapshot> = {},
): HlTerminalSnapshot => ({
  network: "testnet",
  account,
  coin: "BTC",
  asset: 3,
  szDecimals: 5,
  maxLeverage: 40,
  mode: "unifiedAccount",
  masterRole: "user",
  checkedAt: now,
  markPx: "100000",
  bid: "99999",
  ask: "100000",
  leverage: 10,
  marginType: "cross",
  makerFeeRate: 0.00015,
  takerFeeRate: 0.00045,
  position: "0",
  activeAssetData: {
    user: account as `0x${string}`,
    coin: "BTC",
    leverage: { type: "cross", value: 10 },
    maxTradeSzs: ["0.09", "0.09"],
    availableToTrade: ["999", "999"],
    markPx: "100000",
  },
  clearinghouseState: {
    marginSummary: {
      accountValue: "0",
      totalNtlPos: "0",
      totalRawUsd: "0",
      totalMarginUsed: "0",
    },
    crossMarginSummary: {
      accountValue: "0",
      totalNtlPos: "0",
      totalRawUsd: "0",
      totalMarginUsed: "0",
    },
    crossMaintenanceMarginUsed: "0",
    withdrawable: "0",
    assetPositions: [],
    time: now,
  },
  spotClearinghouseState: {
    balances: [
      { coin: "USDC", token: 0, total: "999", hold: "0", entryNtl: "999" },
    ],
  },
  openOrders: [],
  ...changes,
});
const input: HlTerminalOrderInput = {
  side: "BUY",
  orderType: "MARKET",
  sizeMode: "COST",
  amount: "100",
  leverage: 10,
  marginType: "cross",
  maxSlippageBps: 25,
  stopLoss: "95000",
};
const ids = () => ("0x" + "a".repeat(32)) as `0x${string}`;
test("COST100 at actual10 uses1000notional, native max bounds, opposite reduce-only SL", () => {
  const p = previewTerminalAction(
    snapshot(),
    { network: "testnet", kind: "order", input },
    now,
    ids,
  );
  assert.equal(p.summary.notionalUsd, "1000");
  assert.equal(p.summary.marginUsdc, "100");
  assert.equal(p.action.type, "order");
  if (p.action.type === "order") {
    assert.equal(p.action.orders[0].s, "0.01");
    assert.equal(p.action.orders[0].p, "100250");
    assert.equal(p.action.grouping, "normalTpsl");
    assert.deepEqual(p.action.orders[1].t, {
      trigger: { isMarket: true, triggerPx: "95000", tpsl: "sl" },
    });
    assert.equal(p.action.orders[1].r, true);
    assert.equal(p.action.orders[1].b, false);
  }
});
test("VALUE100 keeps100notional; QUANTITY0.01 means1000", () => {
  for (const [mode, amount, want] of [
    ["VALUE", "100", "100"],
    ["QUANTITY", "0.01", "1000"],
  ] as const) {
    const p = previewTerminalAction(
      snapshot(),
      {
        network: "testnet",
        kind: "order",
        input: { ...input, sizeMode: mode, amount },
      },
      now,
      ids,
    );
    assert.equal(p.summary.notionalUsd, want);
  }
});
test("actual leverage mismatch never implicitly updates settings or opens entry", () =>
  assert.throws(
    () =>
      previewTerminalAction(
        snapshot({ leverage: 20 }),
        { network: "testnet", kind: "order", input },
        now,
        ids,
      ),
    /leverage/i,
  ));
test("rejects mainnet writes, wrong role/mode/network, stale data, invalid stops and provider margin", () => {
  for (const s of [
    snapshot({ network: "mainnet" }),
    snapshot({ masterRole: "agent" }),
    snapshot({ mode: "portfolioMargin" }),
    snapshot({ checkedAt: now - 4000 }),
    snapshot({ position: "0.01" }),
  ])
    assert.throws(() =>
      previewTerminalAction(
        s,
        { network: s.network, kind: "order", input },
        now,
        ids,
      ),
    );
  assert.throws(
    () =>
      previewTerminalAction(
        snapshot(),
        {
          network: "testnet",
          kind: "order",
          input: { ...input, stopLoss: "105000" },
        },
        now,
        ids,
      ),
    /stop/i,
  );
  assert.throws(
    () =>
      previewTerminalAction(
        snapshot(),
        {
          network: "testnet",
          kind: "order",
          input: { ...input, amount: "1000" },
        },
        now,
        ids,
      ),
    /available|maximum/i,
  );
});
test("fresh authorization rejects changed position/settings and expired sealed packet", () => {
  const p = previewTerminalAction(
    snapshot(),
    { network: "testnet", kind: "order", input },
    now,
    ids,
  );
  for (const s of [
    snapshot({ position: "0.001" }),
    snapshot({ leverage: 20 }),
    snapshot({ marginType: "isolated" }),
    snapshot({ asset: 0 }),
  ])
    assert.throws(() => validateTerminalAuthorization(p, s, now));
  assert.throws(
    () => validateTerminalAuthorization(p, snapshot(), now + 60001),
    /expired|stale/i,
  );
});
test("native settings support independent10x update; close larger-than20 is full reduce-only", () => {
  const p = previewTerminalAction(
    snapshot({ leverage: 20 }),
    {
      network: "testnet",
      kind: "settings",
      input: { leverage: 10, marginType: "cross" },
    },
    now,
    ids,
  );
  assert.deepEqual(p.action, {
    type: "updateLeverage",
    asset: 3,
    isCross: true,
    leverage: 10,
  });
  const close = previewTerminalAction(
    snapshot({ position: "0.01" }),
    { network: "testnet", kind: "close", input: {} },
    now,
    ids,
  );
  if (close.action.type === "order") {
    assert.equal(close.action.orders[0].s, "0.01");
    assert.equal(close.action.orders[0].r, true);
    assert.equal(close.action.orders[0].b, false);
  }
});
test("partial close accepts0.005 of0.01, rejects excess/native imprecision; reduceOnly side never flips", () => {
  const s = snapshot({ position: "0.01" }),
    p = previewTerminalAction(
      s,
      { network: "testnet", kind: "close", input: { size: "0.005" } as never },
      now,
      ids,
    );
  if (p.action.type === "order") assert.equal(p.action.orders[0].s, "0.005");
  for (const size of ["0.02", "0.000001"])
    assert.throws(() =>
      previewTerminalAction(
        s,
        { network: "testnet", kind: "close", input: { size } as never },
        now,
        ids,
      ),
    );
  const reduced = previewTerminalAction(
    s,
    {
      network: "testnet",
      kind: "order",
      input: {
        ...input,
        side: "SELL",
        sizeMode: "QUANTITY",
        amount: "0.005",
        reduceOnly: true,
        stopLoss: undefined,
      } as never,
    },
    now,
    ids,
  );
  if (reduced.action.type === "order") {
    assert.equal(reduced.action.orders[0].r, true);
    assert.equal(reduced.action.orders[0].b, false);
  }
  assert.throws(
    () =>
      previewTerminalAction(
        s,
        {
          network: "testnet",
          kind: "order",
          input: { ...input, reduceOnly: true } as never,
        },
        now,
        ids,
      ),
    /reduce/i,
  );
});
test("native taker fee is included when checking available trade margin", () => {
  const s = snapshot();
  s.activeAssetData.availableToTrade = ["100.3", "100.3"];
  (s as unknown as { takerFeeRate: number }).takerFeeRate = 0.001;
  assert.throws(
    () =>
      previewTerminalAction(
        s,
        {
          network: "testnet",
          kind: "order",
          input: { ...input, stopLoss: undefined },
        },
        now,
        ids,
      ),
    /available/i,
  );
});
test("standalone short-position TP/SL uses buy reduce-only positionTpsl and correct triggers", () => {
  const p = previewTerminalAction(
    snapshot({ position: "-0.01" }),
    {
      network: "testnet",
      kind: "protection",
      input: {
        stopLoss: "105000",
        takeProfit: "95000",
        triggerSource: "MARK_PRICE",
      },
    },
    now,
    ids,
  );
  if (p.action.type === "order") {
    assert.equal(p.action.grouping, "positionTpsl");
    assert.equal(p.action.orders.length, 2);
    assert.equal(p.action.orders[0].b, true);
    assert.equal(p.action.orders[0].r, true);
    assert.equal(p.action.orders[0].s, "0.01");
    assert.equal(p.action.orders[0].p, "105260");
    assert.deepEqual(p.action.orders[1].t, {
      trigger: { isMarket: true, triggerPx: "95000", tpsl: "tp" },
    });
  }
});
test("cancel/amend preserve target and native flags while using a fresh replacement client ID", () => {
  const order = {
    coin: "BTC",
    side: "A" as const,
    limitPx: "105000",
    sz: "0.01",
    oid: 42,
    timestamp: now,
    origSz: "0.01",
    triggerCondition: "N/A",
    isTrigger: false,
    triggerPx: "0",
    children: [],
    isPositionTpsl: false,
    reduceOnly: true,
    orderType: "Limit" as const,
    tif: "Alo" as const,
    cloid: ("0x" + "c".repeat(32)) as `0x${string}`,
  };
  const s = snapshot({ position: "0.01", openOrders: [order] });
  assert.deepEqual(
    previewTerminalAction(
      s,
      { network: "testnet", kind: "cancel", input: { oid: "42" } },
      now,
      ids,
    ).action,
    { type: "cancel", cancels: [{ a: 3, o: 42 }] },
  );
  const a = previewTerminalAction(
    s,
    {
      network: "testnet",
      kind: "amend",
      input: { oid: "42", price: "106000", size: "0.005" },
    },
    now,
    ids,
  ).action;
  if (a.type === "batchModify") {
    assert.equal(a.modifies[0].oid, 42);
    assert.deepEqual(a.modifies[0].order, {
      a: 3,
      b: false,
      p: "106000",
      s: "0.005",
      r: true,
      t: { limit: { tif: "Alo" } },
      c: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    });
    assert.notEqual(a.modifies[0].order.c, order.cloid);
  }
  assert.throws(
    () =>
      previewTerminalAction(
        s,
        { network: "testnet", kind: "cancel", input: { oid: "43" } },
        now,
        ids,
      ),
    /snapshot/,
  );
  assert.throws(
    () =>
      previewTerminalAction(
        s,
        {
          network: "testnet",
          kind: "amend",
          input: { oid: "42", price: "NaN" },
        },
        now,
        ids,
      ),
    /decimal/,
  );
});
test("attached Stop Limit sends explicit trigger95000/limit94000 and never silently becomes Market", () => {
  const p = previewTerminalAction(
    snapshot(),
    {
      network: "testnet",
      kind: "order",
      input: {
        ...input,
        stopLoss: { triggerPrice: "95000", execution: "LIMIT", price: "94000" },
      } as never,
    },
    now,
    ids,
  );
  if (p.action.type === "order") {
    assert.equal(p.action.orders[1].p, "94000");
    assert.deepEqual(p.action.orders[1].t, {
      trigger: { isMarket: false, triggerPx: "95000", tpsl: "sl" },
    });
  }
  assert.throws(
    () =>
      previewTerminalAction(
        snapshot(),
        {
          network: "testnet",
          kind: "order",
          input: {
            ...input,
            stopLoss: { triggerPrice: "95000", execution: "LIMIT" },
          } as never,
        },
        now,
        ids,
      ),
    /decimal|price/,
  );
  assert.throws(
    () =>
      previewTerminalAction(
        snapshot(),
        {
          network: "testnet",
          kind: "order",
          input: {
            ...input,
            stopLoss: { triggerPrice: "95000", execution: "FOK" },
          } as never,
        },
        now,
        ids,
      ),
    /execution/,
  );
});
test("fresh validation rechecks decreased native available margin; reduced amend cannot exceed fresh residual", () => {
  const p = previewTerminalAction(
    snapshot(),
    { network: "testnet", kind: "order", input },
    now,
    ids,
  );
  const s = snapshot();
  s.activeAssetData.availableToTrade = ["1", "1"];
  assert.throws(() => validateTerminalAuthorization(p, s, now), /available/i);
  const old = {
    coin: "BTC",
    side: "A" as const,
    limitPx: "105000",
    sz: "0.01",
    oid: 42,
    timestamp: now,
    origSz: "0.01",
    triggerCondition: "N/A",
    isTrigger: false,
    triggerPx: "0",
    children: [],
    isPositionTpsl: false,
    reduceOnly: true,
    orderType: "Limit" as const,
    tif: "Alo" as const,
    cloid: ("0x" + "c".repeat(32)) as `0x${string}`,
  };
  assert.throws(
    () =>
      previewTerminalAction(
        snapshot({ position: "0.01", openOrders: [old] }),
        {
          network: "testnet",
          kind: "amend",
          input: { oid: "42", price: "105000", size: "0.02" },
        },
        now,
        ids,
      ),
    /residual/i,
  );
});
test("LIMIT preview uses signed entry price for stop PnL, while MARKET reference remains the mark estimate", () => {
  const p = previewTerminalAction(
    snapshot(),
    {
      network: "testnet",
      kind: "order",
      input: {
        ...input,
        orderType: "LIMIT",
        limitPrice: "80000",
        stopLoss: "79000",
      },
    },
    now,
    ids,
  );
  assert.equal(p.summary.referencePrice, "80000");
  assert.equal(p.summary.quantity, "0.0125");
  assert.equal(p.summary.notionalUsd, "1000");
  assert.equal(p.summary.marginUsdc, "100");
  assert.equal(
    (79000 - Number(p.summary.referencePrice)) * Number(p.summary.quantity),
    -12.5,
  );
  if (p.action.type === "order") {
    assert.equal(p.action.orders[0].p, "80000");
    assert.equal(p.action.orders[0].s, "0.0125");
    assert.deepEqual(p.action.orders[1].t, {
      trigger: { isMarket: true, triggerPx: "79000", tpsl: "sl" },
    });
  }
  const rounded = previewTerminalAction(
    snapshot(),
    {
      network: "testnet",
      kind: "order",
      input: {
        ...input,
        orderType: "LIMIT",
        limitPrice: "80000.123",
        stopLoss: "79000",
      },
    },
    now,
    ids,
  );
  assert.equal(rounded.summary.referencePrice, "80000");
  const market = previewTerminalAction(
    snapshot(),
    { network: "testnet", kind: "order", input },
    now,
    ids,
  );
  assert.equal(market.summary.referencePrice, "100000");
  if (market.action.type === "order")
    assert.equal(market.action.orders[0].p, "100250");
});
test("partially filled parent with nested reduce-only SL prevents duplicate position protection", () => {
  const child = {
    coin: "BTC",
    side: "A" as const,
    limitPx: "94762",
    sz: "0.005",
    oid: 43,
    timestamp: now,
    origSz: "0.01",
    triggerCondition: "Price below 95000",
    isTrigger: true,
    triggerPx: "95000",
    children: [],
    isPositionTpsl: false,
    reduceOnly: true,
    orderType: "Stop Market" as const,
    tif: null,
    cloid: ("0x" + "c".repeat(32)) as `0x${string}`,
  };
  const parent = {
    ...child,
    side: "B" as const,
    limitPx: "100000",
    sz: "0.005",
    oid: 42,
    triggerCondition: "N/A",
    isTrigger: false,
    triggerPx: "0",
    children: [child],
    reduceOnly: false,
    orderType: "Limit" as const,
    tif: "Gtc" as const,
  };
  for (const openOrders of [
    [parent],
    [{ ...parent, children: [{ ...parent, oid: 44 }] }],
  ]) {
    assert.throws(
      () =>
        previewTerminalAction(
          snapshot({ position: "0.005", openOrders }),
          {
            network: "testnet",
            kind: "protection",
            input: { stopLoss: "94000" },
          },
          now,
          ids,
        ),
      /existing protection/i,
    );
  }
});
