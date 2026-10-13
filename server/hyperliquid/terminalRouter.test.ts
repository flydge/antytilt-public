import { test } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { createTerminalRouter } from "./terminalRouter";
import type { TerminalProvider } from "./terminal";
import type { HlTerminalSnapshot } from "../../shared/hyperliquidTerminal";
const account = "0x" + "1".repeat(40);
const snapshot = (): HlTerminalSnapshot => ({
  network: "testnet",
  account,
  coin: "BTC",
  asset: 3,
  szDecimals: 5,
  maxLeverage: 40,
  mode: "unifiedAccount",
  masterRole: "user",
  checkedAt: Date.now(),
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
    availableToTrade: ["999", "999"],
    maxTradeSzs: [".09", ".09"],
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
    time: Date.now(),
  },
  spotClearinghouseState: { balances: [] },
  openOrders: [],
});
test("authenticated sealed prepare cannot be changed, replayed by another user, or prepared mainnet/cross-origin", async () => {
  let user = "00000000-0000-4000-8000-000000000001";
  const provider: TerminalProvider = {
    read: async () => snapshot(),
    order: async () => ({ status: "unknownOid" }),
    history: async () => ({
      network: "testnet",
      account,
      checkedAt: Date.now(),
      fills: [],
      orders: [],
    }),
  };
  const app = express();
  app.use(express.json());
  const routerOptions = {
    requireUser: async () => {
      if (user === "expired")
        throw Object.assign(Error("Sign in"), { status: 401 });
      return { id: user };
    },
    testDependencies: {
      providers: { testnet: provider, mainnet: provider },
      getConnection: async () => ({ account }),
      actionsEnabled: () => true,
    },
  };
  app.use(
    createTerminalRouter({
      ...routerOptions,
      allowedOrigins: new Set(["http://localhost:15173"]),
    }),
  );
  app.use("/strict", createTerminalRouter(routerOptions));
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((r) => server.on("listening", r));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const post = async (path: string, body: unknown, origin = base) =>
    fetch(base + path, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: origin },
      body: JSON.stringify(body),
    });
  try {
    const request = {
      network: "testnet",
      kind: "settings",
      input: { leverage: 10, marginType: "cross" },
    };
    const response = await post("/preview", request);
    assert.equal(response.status, 200);
    const packet = await response.json();
    assert.ok(packet.seal);
    assert.equal((await post("/validate", { packet })).status, 200);
    assert.equal(
      (
        await post("/validate", {
          packet: { ...packet, action: { ...packet.action, leverage: 40 } },
        })
      ).status,
      409,
    );
    user = "00000000-0000-4000-8000-000000000002";
    assert.equal((await post("/validate", { packet })).status, 409);
    user = "00000000-0000-4000-8000-000000000001";
    assert.equal(
      (await post("/preview", { ...request, network: "mainnet" })).status,
      403,
    );
    assert.equal(
      (await post("/preview", request, "https://evil.example")).status,
      403,
    );
    assert.equal(
      (await post("/preview", request, "http://localhost:15173")).status,
      200,
    );
    assert.equal(
      (await post("/strict/preview", request, "http://localhost:15173")).status,
      403,
    );
    assert.equal(
      (
        await fetch(base + "/preview", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(request),
        })
      ).status,
      403,
    );
    assert.equal(
      (
        await fetch(base + "/preview", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Origin: "https://evil.example",
            "X-Forwarded-Host": "evil.example",
          },
          body: JSON.stringify(request),
        })
      ).status,
      403,
    );
    const reconciliation = await fetch(
      base + "/reconcile?network=testnet&ids=0x" + "a".repeat(32),
    );
    assert.equal((await reconciliation.json()).orders[0].status, "unknownOid");
    assert.equal(
      (
        await fetch(
          base +
            "/reconcile?network=testnet&packetId=missing-after-server-restart",
        )
      ).status,
      200,
    );
    user = "expired";
    assert.equal((await fetch(base + "/status?network=testnet")).status, 401);
  } finally {
    await new Promise<void>((r, e) => server.close((x) => (x ? e(x) : r())));
  }
});
test("dependency injection cannot replace production provider", () => {
  const before = process.env.NODE_ENV;
  process.env.NODE_ENV = "production";
  try {
    assert.throws(
      () =>
        createTerminalRouter({
          requireUser: async () => ({ id: "x" }),
          testDependencies: {} as never,
        }),
      /test-only/,
    );
  } finally {
    process.env.NODE_ENV = before;
  }
});
test("terminal agent routes preserve owner/CSRF/mainnet gates and public durable reconcile across router restart", async () => {
  const { randomUUID } = await import("node:crypto");
  const { queryDatabase, closeDatabase } = await import("../postgres");
  const id = randomUUID();
  await queryDatabase(
    "INSERT INTO users(id,email,password_hash,created_at) VALUES ($1,$2,$3,$4)",
    [id, `${id}@fixture.invalid`, "inert", Date.now()],
  );
  let user = id,
    grants: any[] = [],
    leverage = 10,
    sends = 0;
  const provider: TerminalProvider = {
    read: async () => ({ ...snapshot(), leverage }),
    order: async () => ({ status: "unknownOid" }),
    history: async () => ({
      network: "testnet",
      account,
      checkedAt: Date.now(),
      fills: [],
      orders: [],
    }),
  };
  const opts = {
    requireUser: async () => ({ id: user }),
    testDependencies: {
      providers: { testnet: provider, mainnet: provider },
      getConnection: async () => ({ account }),
      actionsEnabled: () => true,
      agentDependencies: {
        encryptionKey: Buffer.alloc(32, 4),
        grants: async () => grants,
        transport: {
          isTestnet: true,
          request: async <T>(): Promise<T> => {
            sends++;
            throw Error("timeout");
          },
        },
      },
    },
  };
  const app = express();
  app.use(express.json());
  app.use("/one", createTerminalRouter(opts));
  app.use("/restart", createTerminalRouter(opts));
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((r) => server.on("listening", r));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const post = (path: string, body: unknown, origin = base) =>
    fetch(base + path, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: origin },
      body: JSON.stringify(body),
    });
  try {
    for (const route of [
      "prepare",
      "validate",
      "confirm",
      "disable",
      "execute",
    ])
      assert.equal(
        (await post("/one/agent/" + route, { network: "mainnet" })).status,
        403,
      );
    assert.equal(
      (
        await post(
          "/one/agent/prepare",
          { network: "testnet" },
          "https://evil.invalid",
        )
      ).status,
      403,
    );
    const response = await post("/one/agent/prepare", { network: "testnet" });
    assert.equal(response.status, 200);
    const approval = await response.json();
    assert.equal(
      (await (await fetch(base + "/one/agent/status?network=testnet")).json())
        .phase,
      "PREPARED",
    );
    assert.equal(
      (await post("/one/agent/confirm", { network: "testnet", approval }))
        .status,
      409,
    );
    user = randomUUID();
    assert.equal(
      (await post("/one/agent/validate", { network: "testnet", approval }))
        .status,
      409,
    );
    user = id;
    grants = [
      {
        address: approval.agentAddress,
        name: approval.agentName,
        validUntil: approval.expiresAt,
      },
    ];
    assert.equal(
      (await post("/one/agent/confirm", { network: "testnet", approval }))
        .status,
      200,
    );
    const p = await (
      await post("/one/preview", {
        network: "testnet",
        kind: "settings",
        input: { leverage: 12, marginType: "cross" },
      })
    ).json();
    assert.equal(
      (
        await post("/one/agent/execute", {
          network: "testnet",
          packet: { ...p, action: { ...p.action, leverage: 30 } },
        })
      ).status,
      409,
    );
    assert.equal(
      (
        await (
          await post("/one/agent/execute", { network: "testnet", packet: p })
        ).json()
      ).state,
      "UNKNOWN",
    );
    assert.equal(sends, 1);
    assert.equal(
      (
        await (
          await fetch(
            base + `/restart/reconcile?network=testnet&packetId=${p.id}`,
          )
        ).json()
      ).agentExecution.state,
      "UNKNOWN",
    );
    leverage = 12;
    const reconciled = await (
      await fetch(base + `/restart/reconcile?network=testnet&packetId=${p.id}`)
    ).json();
    assert.equal(reconciled.settingsConfirmed, true);
    assert.equal(reconciled.agentExecution.state, "ACKNOWLEDGED");
    assert.equal(
      (
        await (
          await fetch(base + "/restart/agent/status?network=testnet")
        ).json()
      ).phase,
      "ACTIVE",
    );
    assert.equal(sends, 1);
  } finally {
    await new Promise<void>((r, e) => server.close((x) => (x ? e(x) : r())));
    await closeDatabase();
  }
});
test("exact legacy recovery routes require auth/Origin/Testnet and preserve sealed review", async () => {
  const { randomUUID } = await import("node:crypto"),
    { queryDatabase } = await import("../postgres");
  const userId = randomUUID();
  await queryDatabase(
    "INSERT INTO users(id,email,password_hash,created_at) VALUES ($1,$2,$3,$4)",
    [userId, `${userId}@fixture.invalid`, "inert", Date.now()],
  );
  const master = "0x00000000000000000000000000000000000a11ce",
    cloid = "0x0123456789abcdef0123456789abcdef";
  let signedIn = true;
  const provider: TerminalProvider = {
    read: async () => ({ ...snapshot(), account: master }),
    order: async () => ({ status: "unknownOid" }),
    history: async () => ({
      network: "testnet",
      account: master,
      checkedAt: Date.now(),
      fills: [],
      orders: [],
    }),
  };
  const app = express();
  app.use(express.json());
  app.use(
    createTerminalRouter({
      requireUser: async () => {
        if (!signedIn) throw Object.assign(Error("Sign in"), { status: 401 });
        return { id: userId };
      },
      testDependencies: {
        providers: { testnet: provider, mainnet: provider },
        getConnection: async () => ({ account: master }),
        actionsEnabled: () => true,
        recoveryDependencies: {
          scopeEnabled: () => true,
          observe: async () => ({
            network: "testnet",
            account: master,
            checkedAt: Date.now(),
            orderStatus: "unknownOid",
            nonzeroPositions: 0,
            openOrders: 0,
            fillCount: 0,
            historicalOrderCount: 0,
            matchingFills: 0,
            matchingOrders: 0,
            historyCompleteness: false,
          }),
        },
      },
    }),
  );
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((r) => server.on("listening", r));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`,
    input = {
      network: "testnet",
      storageKey: `antytilt:hl:manual-pending:testnet:${master}`,
      raw: JSON.stringify({ cloid, message: "Unknown", unknown: true }),
    };
  const post = (path: string, body: unknown, origin = base) =>
    fetch(base + path, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: origin },
      body: JSON.stringify(body),
    });
  try {
    assert.equal(
      (await post("/legacy-recovery/preview", { ...input, network: "mainnet" }))
        .status,
      403,
    );
    assert.equal(
      (await post("/legacy-recovery/preview", input, "https://evil.invalid"))
        .status,
      403,
    );
    signedIn = false;
    assert.equal((await post("/legacy-recovery/preview", input)).status, 401);
    signedIn = true;
    const response = await post("/legacy-recovery/preview", input);
    assert.equal(response.status, 200);
    const review = await response.json();
    assert.equal(
      (
        await post("/legacy-recovery/confirm", {
          network: "testnet",
          review: { ...review, raw: review.raw + " " },
          acknowledgments: { uncertainty: true, stoppedPrompts: true },
        })
      ).status,
      409,
    );
    const confirmed = await post("/legacy-recovery/confirm", {
      network: "testnet",
      review,
      acknowledgments: { uncertainty: true, stoppedPrompts: true },
    });
    assert.equal(confirmed.status, 200);
    const receipt = await confirmed.json();
    assert.equal(receipt.outcome, "UNKNOWN");
    assert.deepEqual(
      (
        await (
          await fetch(base + "/legacy-recovery/journal?network=testnet")
        ).json()
      ).receipts,
      [receipt],
    );
  } finally {
    await new Promise<void>((r, e) => server.close((x) => (x ? e(x) : r())));
  }
});
