import assert from "node:assert/strict";
import { test, after } from "node:test";
import { randomUUID } from "node:crypto";
import { queryDatabase, closeDatabase } from "../postgres";
import { previewTerminalAction } from "./terminal";
import type { HlTerminalSnapshot } from "../../shared/hyperliquidTerminal";
import type { Grant } from "./client";
const mod = (await import("./terminalAgent").catch(
  () => ({}),
)) as typeof import("./terminalAgent");
after(closeDatabase);
const master = "0x" + "1".repeat(40);
function snapshot(): HlTerminalSnapshot {
  return {
    network: "testnet",
    account: master,
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
      user: master as `0x${string}`,
      coin: "BTC",
      leverage: { type: "cross", value: 10 },
      availableToTrade: ["999", "999"],
      maxTradeSzs: ["0.09", "0.09"],
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
  };
}
async function user() {
  const id = randomUUID();
  await queryDatabase(
    "INSERT INTO users(id,email,password_hash,created_at) VALUES ($1,$2,$3,$4)",
    [id, `${id}@fixture.invalid`, "inert", Date.now()],
  );
  return id;
}
test("prepared encrypted terminal signer activates only on fresh exact grant; collisions and owner changes fail closed", async () => {
  assert.equal(typeof mod.createTerminalAgent, "function");
  const id = await user();
  let grants: Grant[] = [];
  const a = mod.createTerminalAgent({
    read: async () => snapshot(),
    testDependencies: {
      encryptionKey: Buffer.alloc(32, 7),
      grants: async () => grants,
    },
  });
  const approval = await a.prepare(id, master);
  assert.equal(
    approval.agentName,
    `AntyTILT-Trade valid_until ${approval.expiresAt}`,
  );
  assert.ok(approval.expiresAt - Date.now() <= 1800000);
  assert.equal((await a.status(id, master)).phase, "PREPARED");
  assert.equal(
    (await a.prepare(id, master)).agentAddress,
    approval.agentAddress,
  );
  assert.equal(JSON.stringify(approval).includes("ciphertext"), false);
  const stored = (
    await queryDatabase<{ signer_ciphertext: string }>(
      "SELECT signer_ciphertext FROM hl_terminal_agents WHERE user_id=$1",
      [id],
    )
  ).rows[0];
  assert.ok(stored.signer_ciphertext.includes("."));
  await assert.rejects(a.confirm(id, master, approval), /grant/);
  grants = [
    {
      address: approval.agentAddress,
      name: approval.agentName,
      validUntil: approval.expiresAt,
    },
  ];
  assert.equal((await a.confirm(id, master, approval)).phase, "ACTIVE");
  await assert.rejects(
    a.validate(randomUUID(), master, approval),
    /approval|candidate/,
  );
  await assert.rejects(
    a.validate(id, "0x" + "2".repeat(40), approval),
    /approval|candidate|master/,
  );
  grants = [];
  assert.equal((await a.status(id, master)).phase, "REVOKED");
  grants = [
    {
      address: "0x" + "3".repeat(40),
      name: "AntyTILT-Trade",
      validUntil: Date.now() + 9999,
    },
  ];
  await assert.rejects(a.validate(id, master, approval), /collision/);
  const disabled = await a.disable(id, master, approval.id);
  assert.equal(disabled.phase, "DISABLED");
  assert.match(disabled.reason, /not revoked/);
  assert.equal(
    (
      await queryDatabase(
        "SELECT signer_ciphertext FROM hl_terminal_agents WHERE user_id=$1",
        [id],
      )
    ).rows[0].signer_ciphertext,
    null,
  );
});
test("offline SDK sends exact Testnet action with durable nonce once; timeout remains locked across service restart", async () => {
  assert.equal(typeof mod.createTerminalAgent, "function");
  const id = await user();
  let grants: Grant[] = [];
  let wire: any;
  let sends = 0;
  let timeout = false;
  const deps = {
    encryptionKey: Buffer.alloc(32, 8),
    grants: async () => grants,
    transport: {
      isTestnet: true,
      request: async <T>(_endpoint: string, payload: unknown): Promise<T> => {
        sends++;
        wire = JSON.parse(JSON.stringify(payload));
        if (timeout) throw Error("timeout");
        return { status: "ok", response: { type: "default" } } as T;
      },
    },
  };
  const create = () =>
    mod.createTerminalAgent({
      read: async () => snapshot(),
      testDependencies: deps,
    });
  const a = create();
  const approval = await a.prepare(id, master);
  grants = [
    {
      address: approval.agentAddress,
      name: approval.agentName,
      validUntil: approval.expiresAt,
    },
  ];
  await a.confirm(id, master, approval);
  const packet = () =>
    previewTerminalAction(
      snapshot(),
      {
        network: "testnet",
        kind: "settings",
        input: { leverage: 12, marginType: "cross" },
      },
      Date.now(),
    );
  const p = packet();
  const result = await a.execute(id, master, p);
  assert.equal(result.state, "ACKNOWLEDGED");
  assert.equal(sends, 1);
  assert.deepEqual(wire.action, {
    type: "updateLeverage",
    asset: 3,
    isCross: true,
    leverage: 12,
  });
  assert.equal(wire.expiresAfter, p.expiresAfter);
  assert.ok(Number.isSafeInteger(wire.nonce));
  assert.ok(wire.signature);
  assert.deepEqual(Object.keys(wire).sort(), [
    "action",
    "expiresAfter",
    "nonce",
    "signature",
  ]);
  assert.equal((await a.execute(id, master, p)).state, "ACKNOWLEDGED");
  assert.equal(sends, 1);
  timeout = true;
  const second = packet();
  assert.equal((await a.execute(id, master, second)).state, "UNKNOWN");
  assert.ok(wire.nonce > 0);
  const restart = create();
  assert.equal((await restart.execute(id, master, second)).state, "UNKNOWN");
  assert.equal(sends, 2);
  await assert.rejects(restart.execute(id, master, packet()), /unresolved/);
  await assert.rejects(restart.prepare(id, master), /unresolved/);
});
test("public reconciliation unlocks durable unknown only with verified exact settings or every packet leg known", async () => {
  assert.equal(typeof mod.createTerminalAgent, "function");
  const id = await user();
  let grants: Grant[] = [];
  const deps = {
    encryptionKey: Buffer.alloc(32, 9),
    grants: async () => grants,
    transport: {
      isTestnet: true,
      request: async <T>(): Promise<T> => {
        throw Error("timeout");
      },
    },
  };
  const a = mod.createTerminalAgent({
    read: async () => snapshot(),
    testDependencies: deps,
  });
  const approval = await a.prepare(id, master);
  grants = [
    {
      address: approval.agentAddress,
      name: approval.agentName,
      validUntil: approval.expiresAt,
    },
  ];
  await a.confirm(id, master, approval);
  const p = previewTerminalAction(
    snapshot(),
    {
      network: "testnet",
      kind: "settings",
      input: { leverage: 12, marginType: "cross" },
    },
    Date.now(),
  );
  await a.execute(id, master, p);
  assert.equal((await a.status(id, master)).phase, "UNAVAILABLE");
  assert.equal(
    (await a.reconcile(id, master, p.id, snapshot(), []))?.state,
    "UNKNOWN",
  );
  const wrong = { ...snapshot(), account: "0x" + "2".repeat(40), leverage: 12 };
  await assert.rejects(a.reconcile(id, master, p.id, wrong, []), /scope/);
  assert.equal(
    (await a.reconcile(id, master, p.id, { ...snapshot(), leverage: 12 }, []))
      ?.state,
    "ACKNOWLEDGED",
  );
  assert.equal((await a.status(id, master)).phase, "ACTIVE");
});
test("final runtime write gate is rechecked after durable claim and blocks the SDK send", async () => {
  const id = await user();
  let grants: Grant[] = [];
  let enabled = true;
  let grantReads = 0;
  let sends = 0;
  const deps = {
    encryptionKey: Buffer.alloc(32, 10),
    actionsEnabled: () => enabled,
    grants: async () => {
      grantReads++;
      if (grantReads === 5) enabled = false;
      return grants;
    },
    transport: {
      isTestnet: true,
      request: async <T>(): Promise<T> => {
        sends++;
        return { status: "ok", response: { type: "default" } } as T;
      },
    },
  };
  const a = mod.createTerminalAgent({
    read: async () => snapshot(),
    testDependencies: deps,
  });
  const approval = await a.prepare(id, master);
  grants = [
    {
      address: approval.agentAddress,
      name: approval.agentName,
      validUntil: approval.expiresAt,
    },
  ];
  await a.confirm(id, master, approval);
  const p = previewTerminalAction(
    snapshot(),
    {
      network: "testnet",
      kind: "settings",
      input: { leverage: 12, marginType: "cross" },
    },
    Date.now(),
  );
  const result = await a.execute(id, master, p);
  assert.equal(result.state, "REJECTED");
  assert.equal(sends, 0);
});
test("native grant recovery after the review deadline activates without asking for another signature", async () => {
  const id = await user();
  let grants: Grant[] = [];
  const a = mod.createTerminalAgent({
    read: async () => snapshot(),
    testDependencies: {
      encryptionKey: Buffer.alloc(32, 11),
      grants: async () => grants,
    },
  });
  const approval = await a.prepare(id, master);
  const expiredReview = { ...approval, reviewExpiresAt: Date.now() - 1 };
  await queryDatabase("UPDATE hl_terminal_agents SET approval=$2 WHERE id=$1", [
    approval.id,
    expiredReview,
  ]);
  grants = [
    {
      address: approval.agentAddress,
      name: approval.agentName,
      validUntil: approval.expiresAt,
    },
  ];
  await assert.rejects(a.validate(id, master, expiredReview), /expired/);
  assert.equal((await a.confirm(id, master, expiredReview)).phase, "ACTIVE");
});
test("explicit native top-level rejection is durable REJECTED and does not retain unknown submission lock", async () => {
  const id = await user();
  let grants: Grant[] = [];
  const a = mod.createTerminalAgent({
    read: async () => snapshot(),
    testDependencies: {
      encryptionKey: Buffer.alloc(32, 12),
      grants: async () => grants,
      transport: {
        isTestnet: true,
        request: async <T>(): Promise<T> =>
          ({ status: "err", response: "Invalid nonce" }) as T,
      },
    },
  });
  const approval = await a.prepare(id, master);
  grants = [
    {
      address: approval.agentAddress,
      name: approval.agentName,
      validUntil: approval.expiresAt,
    },
  ];
  await a.confirm(id, master, approval);
  const p = previewTerminalAction(
    snapshot(),
    {
      network: "testnet",
      kind: "settings",
      input: { leverage: 12, marginType: "cross" },
    },
    Date.now(),
  );
  assert.equal((await a.execute(id, master, p)).state, "REJECTED");
  assert.equal((await a.status(id, master)).phase, "ACTIVE");
});
test("separate terminal key can close a non-flat BTC position without inheriting or modifying protection consent", async () => {
  const { linkConnection, encryptAgent } = await import("./store");
  const id = await user(),
    protection = await linkConnection(id, master),
    oldCipher = encryptAgent(
      "0x" + "4".repeat(64),
      protection.id,
      Buffer.alloc(32, 13),
    );
  await queryDatabase(
    "UPDATE hl_connections SET signer_ciphertext=$2 WHERE id=$1",
    [protection.id, oldCipher],
  );
  let position = "0";
  let grants: Grant[] = [];
  let sends = 0;
  const a = mod.createTerminalAgent({
    read: async () => ({ ...snapshot(), position }),
    testDependencies: {
      encryptionKey: Buffer.alloc(32, 13),
      grants: async () => grants,
      transport: {
        isTestnet: true,
        request: async <T>(_endpoint: string, payload: unknown): Promise<T> => {
          sends++;
          const action = (payload as any).action;
          const statuses = action.orders[0].t.trigger
            ? action.orders.map((_: unknown, i: number) => ({
                resting: { oid: 710 + i },
              }))
            : [{ filled: { oid: 700, totalSz: "0.001", avgPx: "100000" } }];
          return {
            status: "ok",
            response: { type: "order", data: { statuses } },
          } as T;
        },
      },
    },
  });
  const approval = await a.prepare(id, master);
  assert.notEqual(approval.agentAddress, "0x" + "4".repeat(40));
  grants = [
    {
      address: approval.agentAddress,
      name: approval.agentName,
      validUntil: approval.expiresAt,
    },
  ];
  await a.confirm(id, master, approval);
  position = "0.001";
  const p = previewTerminalAction(
    { ...snapshot(), position },
    { network: "testnet", kind: "close", input: {} },
    Date.now(),
  );
  assert.equal((await a.execute(id, master, p)).state, "CONFIRMED");
  assert.equal(sends, 1);
  assert.equal((await a.status(id, master)).phase, "ACTIVE");
  const protectionPacket = previewTerminalAction(
    { ...snapshot(), position },
    {
      network: "testnet",
      kind: "protection",
      input: { stopLoss: "95000", takeProfit: "105000" },
    },
    Date.now(),
  );
  assert.equal(
    (await a.execute(id, master, protectionPacket)).state,
    "ACKNOWLEDGED",
  );
  assert.equal(sends, 2);
  const row = (
    await queryDatabase<{ data: typeof protection; signer_ciphertext: string }>(
      "SELECT data,signer_ciphertext FROM hl_connections WHERE id=$1",
      [protection.id],
    )
  ).rows[0];
  assert.equal(row.data.policy.maxCloseNotionalUsd, "20");
  assert.equal(row.signer_ciphertext, oldCipher);
  assert.equal(row.data.enabled, false);
});
test("real offline HttpTransport wire uses Testnet URL and separate signer for all four allowlisted SDK actions", async () => {
  const { createL1ActionHash } = await import("@nktkas/hyperliquid/signing");
  const { recoverTypedDataAddress, serializeSignature } = await import("viem");
  const id = await user();
  let grants: Grant[] = [],
    view = snapshot();
  const wires: any[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, opts) => {
    assert.equal(String(url), "https://api.hyperliquid-testnet.xyz/exchange");
    const wire = JSON.parse(String(opts?.body));
    wires.push(wire);
    const a = wire.action;
    const body =
      a.type === "updateLeverage"
        ? { status: "ok", response: { type: "default" } }
        : a.type === "cancel"
          ? {
              status: "ok",
              response: { type: "cancel", data: { statuses: ["success"] } },
            }
          : {
              status: "ok",
              response: {
                type: "order",
                data: {
                  statuses: (a.type === "order" ? a.orders : a.modifies).map(
                    (_: unknown, i: number) => ({ resting: { oid: 900 + i } }),
                  ),
                },
              },
            };
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  try {
    const a = mod.createTerminalAgent({
      read: async () => ({ ...view, checkedAt: Date.now() }),
      testDependencies: {
        encryptionKey: Buffer.alloc(32, 14),
        grants: async () => grants,
      },
    });
    const approval = await a.prepare(id, master);
    grants = [
      {
        address: approval.agentAddress,
        name: approval.agentName,
        validUntil: approval.expiresAt,
      },
    ];
    await a.confirm(id, master, approval);
    const settings = previewTerminalAction(
      view,
      {
        network: "testnet",
        kind: "settings",
        input: { leverage: 12, marginType: "cross" },
      },
      Date.now(),
    );
    await a.execute(id, master, settings);
    const order = previewTerminalAction(
      { ...view, checkedAt: Date.now() },
      {
        network: "testnet",
        kind: "order",
        input: {
          side: "BUY",
          orderType: "LIMIT",
          limitPrice: "99000",
          sizeMode: "QUANTITY",
          amount: "0.001",
          leverage: 10,
          marginType: "cross",
        },
      },
      Date.now(),
    );
    await a.execute(id, master, order);
    view = {
      ...snapshot(),
      position: "0.01",
      openOrders: [
        {
          coin: "BTC",
          side: "A",
          limitPx: "105000",
          sz: "0.01",
          oid: 42,
          timestamp: Date.now(),
          origSz: "0.01",
          triggerCondition: "N/A",
          isTrigger: false,
          triggerPx: "0",
          children: [],
          isPositionTpsl: false,
          reduceOnly: true,
          orderType: "Limit",
          tif: "Alo",
          cloid: ("0x" + "c".repeat(32)) as `0x${string}`,
        },
      ],
    };
    const cancel = previewTerminalAction(
      view,
      { network: "testnet", kind: "cancel", input: { oid: "42" } },
      Date.now(),
    );
    await a.execute(id, master, cancel);
    const amend = previewTerminalAction(
      { ...view, checkedAt: Date.now() },
      {
        network: "testnet",
        kind: "amend",
        input: { oid: "42", price: "106000", size: "0.005" },
      },
      Date.now(),
    );
    await a.execute(id, master, amend);
    assert.equal(wires.length, 4);
    for (const [i, p] of [settings, order, cancel, amend].entries()) {
      const w = wires[i],
        r = (
          await queryDatabase(
            "SELECT nonce,state FROM hl_terminal_executions WHERE packet_id=$1",
            [p.id],
          )
        ).rows[0];
      assert.deepEqual(w.action, p.action);
      assert.equal(w.nonce, Number(r.nonce));
      assert.equal(w.expiresAfter, p.expiresAfter);
      if (i) assert.ok(w.nonce > wires[i - 1].nonce);
      const recovered = await recoverTypedDataAddress({
        domain: {
          name: "Exchange",
          version: "1",
          chainId: 1337,
          verifyingContract: "0x0000000000000000000000000000000000000000",
        },
        types: {
          Agent: [
            { name: "source", type: "string" },
            { name: "connectionId", type: "bytes32" },
          ],
        },
        primaryType: "Agent",
        message: {
          source: "b",
          connectionId: createL1ActionHash({
            action: w.action,
            nonce: w.nonce,
            expiresAfter: w.expiresAfter,
          }),
        },
        signature: serializeSignature({
          ...w.signature,
          v: BigInt(w.signature.v),
        }),
      });
      assert.equal(recovered.toLowerCase(), approval.agentAddress);
      assert.notEqual(recovered.toLowerCase(), master);
    }
  } finally {
    globalThis.fetch = original;
  }
});
test("late timeout cannot regress already observed durable public reconciliation into an unlocked UNKNOWN", async () => {
  const id = await user();
  let grants: Grant[] = [],
    leverage = 10;
  let release!: () => void, entered!: () => void;
  const ready = new Promise<void>((r) => (entered = r)),
    gate = new Promise<void>((r) => (release = r));
  const a = mod.createTerminalAgent({
    read: async () => ({ ...snapshot(), leverage }),
    testDependencies: {
      encryptionKey: Buffer.alloc(32, 15),
      grants: async () => grants,
      transport: {
        isTestnet: true,
        request: async <T>(): Promise<T> => {
          entered();
          await gate;
          throw Error("late timeout");
        },
      },
    },
  });
  const approval = await a.prepare(id, master);
  grants = [
    {
      address: approval.agentAddress,
      name: approval.agentName,
      validUntil: approval.expiresAt,
    },
  ];
  await a.confirm(id, master, approval);
  const p = previewTerminalAction(
    snapshot(),
    {
      network: "testnet",
      kind: "settings",
      input: { leverage: 12, marginType: "cross" },
    },
    Date.now(),
  );
  const pending = a.execute(id, master, p);
  await ready;
  leverage = 12;
  assert.equal(
    (await a.reconcile(id, master, p.id, { ...snapshot(), leverage }, []))
      ?.state,
    "ACKNOWLEDGED",
  );
  release();
  assert.equal((await pending).state, "ACKNOWLEDGED");
  assert.equal((await a.getExecution(id, master, p.id))?.state, "ACKNOWLEDGED");
});
test("revocation, changed master role/mode, metadata and expired signer block before an SDK send", async () => {
  for (const change of [
    "revoked",
    "role",
    "mode",
    "metadata",
    "expired",
  ] as const) {
    const id = await user();
    let grants: Grant[] = [],
      phase = "setup";
    let sends = 0;
    let reads = 0;
    const a = mod.createTerminalAgent({
      read: async () => {
        reads++;
        const s = snapshot();
        if (phase === "mutate" && change === "role") s.masterRole = "agent";
        if (phase === "mutate" && change === "mode") s.mode = "portfolioMargin";
        if (phase === "mutate" && change === "metadata") s.asset = 4;
        return s;
      },
      testDependencies: {
        encryptionKey: Buffer.alloc(32, 16),
        grants: async () => grants,
        transport: {
          isTestnet: true,
          request: async <T>(): Promise<T> => {
            sends++;
            return { status: "ok", response: { type: "default" } } as T;
          },
        },
      },
    });
    const approval = await a.prepare(id, master);
    grants = [
      {
        address: approval.agentAddress,
        name: approval.agentName,
        validUntil: approval.expiresAt,
      },
    ];
    await a.confirm(id, master, approval);
    const p = previewTerminalAction(
      snapshot(),
      {
        network: "testnet",
        kind: "settings",
        input: { leverage: 12, marginType: "cross" },
      },
      Date.now(),
    );
    phase = "mutate";
    if (change === "revoked") grants = [];
    if (change === "expired")
      await queryDatabase(
        "UPDATE hl_terminal_agents SET expires_at=$2 WHERE id=$1",
        [approval.id, Date.now() - 1],
      );
    await assert.rejects(a.execute(id, master, p));
    assert.equal(sends, 0);
    if (change === "expired")
      assert.equal((await a.status(id, master)).phase, "EXPIRED");
  }
});
test("concurrent duplicate and different packets cannot create two SDK submissions for the same signer", async () => {
  const id = await user();
  let grants: Grant[] = [];
  let release!: () => void,
    entered!: () => void,
    sends = 0;
  const ready = new Promise<void>((r) => (entered = r)),
    gate = new Promise<void>((r) => (release = r));
  const a = mod.createTerminalAgent({
    read: async () => snapshot(),
    testDependencies: {
      encryptionKey: Buffer.alloc(32, 17),
      grants: async () => grants,
      transport: {
        isTestnet: true,
        request: async <T>(): Promise<T> => {
          sends++;
          entered();
          await gate;
          return { status: "ok", response: { type: "default" } } as T;
        },
      },
    },
  });
  const approval = await a.prepare(id, master);
  grants = [
    {
      address: approval.agentAddress,
      name: approval.agentName,
      validUntil: approval.expiresAt,
    },
  ];
  await a.confirm(id, master, approval);
  const p = previewTerminalAction(
      snapshot(),
      {
        network: "testnet",
        kind: "settings",
        input: { leverage: 12, marginType: "cross" },
      },
      Date.now(),
    ),
    other = { ...p, id: randomUUID() };
  const pending = a.execute(id, master, p);
  await ready;
  assert.equal((await a.execute(id, master, p)).state, "SUBMITTING");
  await assert.rejects(a.execute(id, master, other), /unresolved/);
  assert.equal(sends, 1);
  release();
  assert.equal((await pending).state, "ACKNOWLEDGED");
});
test("unknown order legs retain broker lock; exact rejected stop receipt plus observed parent can resolve partial", async () => {
  for (const rejectedStop of [false, true]) {
    const id = await user();
    let grants: Grant[] = [];
    const statuses: any[] = [
      { filled: { oid: 990, totalSz: "0.001", avgPx: "100000" } },
    ];
    if (rejectedStop) statuses.push({ error: "Bad trigger" });
    const a = mod.createTerminalAgent({
      read: async () => snapshot(),
      testDependencies: {
        encryptionKey: Buffer.alloc(32, 18),
        grants: async () => grants,
        transport: {
          isTestnet: true,
          request: async <T>(): Promise<T> =>
            ({
              status: "ok",
              response: { type: "order", data: { statuses } },
            }) as T,
        },
      },
    });
    const approval = await a.prepare(id, master);
    grants = [
      {
        address: approval.agentAddress,
        name: approval.agentName,
        validUntil: approval.expiresAt,
      },
    ];
    await a.confirm(id, master, approval);
    const p = previewTerminalAction(
      snapshot(),
      {
        network: "testnet",
        kind: "order",
        input: {
          side: "BUY",
          orderType: "MARKET",
          sizeMode: "QUANTITY",
          amount: "0.001",
          leverage: 10,
          marginType: "cross",
          stopLoss: "95000",
        },
      },
      Date.now(),
    );
    const r = await a.execute(id, master, p);
    assert.equal(r.state, rejectedStop ? "PARTIAL" : "UNKNOWN");
    assert.equal(
      (await a.reconcile(id, master, p.id, snapshot(), []))?.state,
      r.state,
    );
    const ids = mod.terminalExecutionIds(p),
      observed = [
        { id: ids[0], status: "filled" },
        { id: ids[1], status: "unknownOid" },
      ];
    assert.equal(
      (
        await a.reconcile(
          id,
          master,
          p.id,
          { ...snapshot(), position: "0.001" },
          observed,
        )
      )?.state,
      rejectedStop ? "ACKNOWLEDGED" : "UNKNOWN",
    );
    if (rejectedStop)
      assert.equal(
        (await a.getExecution(id, master, p.id))?.result?.protection,
        "REJECTED",
      );
  }
});
