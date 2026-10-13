import { test } from "node:test";
import assert from "node:assert/strict";
import { privateKeyToAccount } from "viem/accounts";
import {
  submitTerminalAction,
  parseTerminalResult,
  TerminalSubmissionError,
} from "./ownerTerminal";
import type { HlTerminalPacket } from "../../shared/hyperliquidTerminal";
const wallet = privateKeyToAccount(("0x" + "1".repeat(64)) as `0x${string}`);
let packetNumber = 0;
function packet(): HlTerminalPacket {
  const now = Date.now();
  return {
    id: "test-packet-" + ++packetNumber,
    seal: "sealed",
    network: "testnet",
    account: wallet.address.toLowerCase(),
    coin: "BTC",
    kind: "order",
    asset: 3,
    szDecimals: 5,
    mode: "unifiedAccount",
    positionBefore: "0",
    settingBefore: { leverage: 10, marginType: "cross" },
    ordersBefore: [],
    checkedAt: now,
    createdAt: now,
    expiresAfter: now + 60000,
    action: {
      type: "order",
      grouping: "normalTpsl",
      orders: [
        {
          a: 3,
          b: true,
          p: "100250",
          s: "0.01",
          r: false,
          c: ("0x" + "a".repeat(32)) as `0x${string}`,
          t: { limit: { tif: "Ioc" } },
        },
        {
          a: 3,
          b: false,
          p: "94762",
          s: "0.01",
          r: true,
          c: ("0x" + "b".repeat(32)) as `0x${string}`,
          t: { trigger: { isMarket: true, triggerPx: "95000", tpsl: "sl" } },
        },
      ],
    },
    summary: {
      quantity: "0.01",
      notionalUsd: "1000",
      marginUsdc: "100",
      referencePrice: "100000",
      leverage: 10,
      marginType: "cross",
    },
  };
}
const response = (statuses: unknown[]) => ({
  status: "ok",
  response: { type: "order", data: { statuses } },
});
test("Phantom canonical-domain incompatibility stops before wallet RPC or exchange send", async () => {
  let requests = 0, sends = 0;
  const original = globalThis.fetch;
  const provider = { isPhantom: true, request: async () => { requests++; throw Error("Unexpected wallet request"); } };
  globalThis.fetch = async () => { sends++; throw Error("Unexpected exchange request"); };
  try {
    await assert.rejects(() => submitTerminalAction(packet(), provider, async () => {}, () => true),
      e => e instanceof TerminalSubmissionError && !e.uncertain && /Phantom.*1337.*Testnet/.test(e.message));
    assert.equal(requests, 0);
    assert.equal(sends, 0);
  } finally { globalThis.fetch = original; }
});
test("mixed parent fill and rejected stop returns PARTIAL with protection REJECTED", () => {
  const result = parseTerminalResult(
    packet(),
    response([
      { filled: { oid: 123, totalSz: "0.01", avgPx: "100000" } },
      { error: "Invalid trigger" },
    ]),
  );
  assert.equal(result.kind, "PARTIAL");
  assert.equal(result.protection, "REJECTED");
  assert.equal(result.orders[0].kind, "FILLED");
  assert.equal(result.orders[1].kind, "REJECTED");
});
test("unknown/missing statuses never claim installed protection; resting is not filled", () => {
  assert.equal(
    parseTerminalResult(packet(), response([{ resting: { oid: 1 } }]))
      .protection,
    "UNKNOWN",
  );
  const r = parseTerminalResult(
    packet(),
    response([{ resting: { oid: 1 } }, "waitingForFill"]),
  );
  assert.equal(r.orders[0].kind, "RESTING");
  assert.equal(r.kind, "ACKNOWLEDGED");
  assert.equal(r.protection, "ACCEPTED");
});
test("offline owner SDK checks exact native payload and signature, fresh gates before and after signing, once only", async () => {
  const p = packet(),
    original = globalThis.fetch;
  let sends = 0,
    gates = 0,
    signs = 0;
  const provider = {
    request: async (i: { method: string; params?: unknown[] }) => {
      if (i.method === "eth_requestAccounts" || i.method === "eth_accounts")
        return [wallet.address];
      if (i.method === "eth_signTypedData_v4") {
        signs++;
        const typed = JSON.parse(String(i.params?.[1]));
        assert.equal(typed.domain.chainId, 1337);
        assert.equal(typed.message.source, "b");
        return wallet.signTypedData(typed);
      }
      throw Error(i.method);
    },
  };
  globalThis.fetch = async (_url, init) => {
    sends++;
    assert.equal(String(_url), "https://api.hyperliquid-testnet.xyz/exchange");
    const body = JSON.parse(String(init?.body));
    assert.deepEqual(body.action, p.action);
    assert.equal(body.expiresAfter, p.expiresAfter);
    assert.equal(body.nonce, Math.floor(body.nonce));
    return new Response(
      JSON.stringify(
        response([
          { filled: { oid: 123, totalSz: "0.01", avgPx: "100000" } },
          { resting: { oid: 124 } },
        ]),
      ),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  };
  try {
    const r = await submitTerminalAction(
      p,
      provider,
      async () => {
        gates++;
      },
      () => true,
    );
    assert.equal(r.kind, "CONFIRMED");
    assert.equal(r.protection, "ACCEPTED");
    assert.equal(sends, 1);
    assert.equal(signs, 1);
    assert.ok(gates >= 2);
    await assert.rejects(
      () =>
        submitTerminalAction(
          p,
          provider,
          async () => {},
          () => true,
        ),
      /already|once/i,
    );
    assert.equal(sends, 1);
  } finally {
    globalThis.fetch = original;
  }
});
test("mainnet/network selection and post-sign account change abort without sending; transport timeout remains uncertain", async () => {
  const p = packet();
  await assert.rejects(
    () =>
      submitTerminalAction(
        { ...p, network: "mainnet" },
        { request: async () => [] },
        async () => {},
        () => true,
      ),
    /mainnet/i,
  );
  await assert.rejects(
    () =>
      submitTerminalAction(
        p,
        { request: async () => [] },
        async () => {},
        () => false,
      ),
    /selection/i,
  );
  let signed = false,
    sends = 0;
  const provider = {
    request: async (i: { method: string; params?: unknown[] }) => {
      if (i.method === "eth_signTypedData_v4") {
        signed = true;
        return wallet.signTypedData(JSON.parse(String(i.params?.[1])));
      }
      return signed ? ["0x" + "2".repeat(40)] : [wallet.address];
    },
  };
  const original = globalThis.fetch;
  globalThis.fetch = async () => {
    sends++;
    throw Error("timeout");
  };
  try {
    await assert.rejects(
      () =>
        submitTerminalAction(
          p,
          provider,
          async () => {},
          () => true,
        ),
      (e) => e instanceof TerminalSubmissionError && !e.uncertain,
    );
    assert.equal(sends, 0);
    signed = false;
    const always = {
      request: async (i: { method: string; params?: unknown[] }) =>
        i.method === "eth_signTypedData_v4"
          ? wallet.signTypedData(JSON.parse(String(i.params?.[1])))
          : [wallet.address],
    };
    await assert.rejects(
      () =>
        submitTerminalAction(
          packet(),
          always,
          async () => {},
          () => true,
        ),
      (e) => e instanceof TerminalSubmissionError && e.uncertain,
    );
    assert.equal(sends, 1);
  } finally {
    globalThis.fetch = original;
  }
});
test("missing stop receipt retains known parent fill yet remains UNKNOWN; close partial fills stay PARTIAL", () => {
  const p = packet();
  const missing = parseTerminalResult(
    p,
    response([{ filled: { oid: 7, totalSz: "0.01", avgPx: "100000" } }]),
  );
  assert.equal(missing.kind, "UNKNOWN");
  assert.equal(missing.orders[0].kind, "FILLED");
  assert.equal(missing.protection, "UNKNOWN");
  const close = packet();
  close.kind = "close";
  close.positionBefore = "0.01";
  close.action = {
    type: "order",
    grouping: "na",
    orders: [
      {
        a: 3,
        b: false,
        p: "99750",
        s: "0.01",
        r: true,
        t: { limit: { tif: "Ioc" } },
        c: ("0x" + "d".repeat(32)) as `0x${string}`,
      },
    ],
  };
  assert.equal(
    parseTerminalResult(
      close,
      response([{ filled: { oid: 8, totalSz: "0.005", avgPx: "100000" } }]),
    ).kind,
    "PARTIAL",
  );
  assert.equal(
    parseTerminalResult(
      close,
      response([{ filled: { oid: 8, totalSz: "0.01", avgPx: "100000" } }]),
    ).kind,
    "CONFIRMED",
  );
  assert.equal(
    parseTerminalResult(
      close,
      response([
        { filled: { oid: 8, totalSz: "Infinity", avgPx: "Infinity" } },
      ]),
    ).kind,
    "UNKNOWN",
  );
});
test("SDK mixed per-order rejection preserves filled parent rather than throwing an all-rejected error", async () => {
  const p = packet(),
    original = globalThis.fetch;
  let sends = 0;
  const provider = {
    request: async (i: { method: string; params?: unknown[] }) =>
      i.method === "eth_signTypedData_v4"
        ? wallet.signTypedData(JSON.parse(String(i.params?.[1])))
        : [wallet.address],
  };
  globalThis.fetch = async () => {
    sends++;
    return new Response(
      JSON.stringify(
        response([
          { filled: { oid: 123, totalSz: "0.01", avgPx: "100000" } },
          { error: "Bad stop price" },
        ]),
      ),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  };
  try {
    const result = await submitTerminalAction(
      p,
      provider,
      async () => {},
      () => true,
    );
    assert.equal(result.kind, "PARTIAL");
    assert.equal(result.orders[0].kind, "FILLED");
    assert.equal(result.protection, "REJECTED");
    assert.equal(sends, 1);
  } finally {
    globalThis.fetch = original;
  }
});
