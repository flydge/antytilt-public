import { test, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { queryDatabase, closeDatabase } from "../postgres";
const mod = (await import("./legacyRecovery").catch(
  () => ({}),
)) as typeof import("./legacyRecovery");
after(closeDatabase);
const account = "0x00000000000000000000000000000000000a11ce",
  cloid = "0x0123456789abcdef0123456789abcdef",
  storageKey = `antytilt:hl:manual-pending:testnet:${account}`;
const raw = JSON.stringify({
  cloid,
  message: "Unknown result; no automatic retry.",
  unknown: true,
});
const observation = () => ({
  network: "testnet" as const,
  account,
  checkedAt: Date.now(),
  orderStatus: "unknownOid",
  nonzeroPositions: 0,
  openOrders: 0,
  fillCount: 0,
  historicalOrderCount: 0,
  matchingFills: 0,
  matchingOrders: 0,
  historyCompleteness: false as const,
});
async function user() {
  const id = randomUUID();
  await queryDatabase(
    "INSERT INTO users(id,email,password_hash,created_at) VALUES ($1,$2,$3,$4)",
    [id, `${id}@fixture.invalid`, "inert", Date.now()],
  );
  return id;
}
test("exact legacy UNKNOWN review creates an immutable idempotent user-scoped durable journal only after fresh confirmation", async () => {
  assert.equal(typeof mod.createLegacyRecovery, "function");
  const id = await user();
  let obs = observation();
  const r = mod.createLegacyRecovery({
    getAccount: async () => account,
    preparedPacketExists: () => false,
    testDependencies: {
      scopeEnabled: () => true,
      observe: async () => ({ ...obs, checkedAt: Date.now() }),
    },
  });
  const review = await r.preview(id, { network: "testnet", storageKey, raw });
  assert.equal(review.cloid, cloid);
  assert.equal(review.outcome, "UNKNOWN");
  assert.deepEqual(review.missingFields, [
    "action",
    "nonce",
    "createdAt",
    "expiresAfter",
  ]);
  assert.equal((await r.journal(id, "testnet")).receipts.length, 0);
  await assert.rejects(
    r.confirm(id, {
      network: "testnet",
      review,
      acknowledgments: { uncertainty: true, stoppedPrompts: false },
    }),
  );
  const receipt = await r.confirm(id, {
    network: "testnet",
    review,
    acknowledgments: { uncertainty: true, stoppedPrompts: true },
  });
  assert.equal(receipt.raw, raw);
  assert.equal(receipt.outcome, "UNKNOWN");
  assert.equal(receipt.rawHash, review.rawHash);
  assert.deepEqual(
    await r.confirm(id, {
      network: "testnet",
      review,
      acknowledgments: { uncertainty: true, stoppedPrompts: true },
    }),
    receipt,
  );
  assert.deepEqual((await r.journal(id, "testnet")).receipts, [receipt]);
  assert.equal((await r.journal(await user(), "testnet")).receipts.length, 0);
  const restart = mod.createLegacyRecovery({
    getAccount: async () => account,
    preparedPacketExists: () => false,
    testDependencies: {
      scopeEnabled: () => true,
      observe: async () => observation(),
    },
  });
  assert.deepEqual((await restart.journal(id, "testnet")).receipts, [receipt]);
  const persisted = (
    await queryDatabase(
      "SELECT data FROM hl_legacy_recovery_journal WHERE id=$1",
      [receipt.id],
    )
  ).rows[0].data;
  assert.deepEqual(persisted, receipt);
});
test("scope/shape/mainnet/user/seal/expiry/native active evidence and durable broker locks fail closed", async () => {
  assert.equal(typeof mod.createLegacyRecovery, "function");
  const id = await user();
  let enabled = true,
    master = account,
    obs = observation();
  const r = mod.createLegacyRecovery({
    getAccount: async () => master,
    preparedPacketExists: () => false,
    testDependencies: { scopeEnabled: () => enabled, observe: async () => obs },
  });
  const input = { network: "testnet", storageKey, raw };
  enabled = false;
  await assert.rejects(r.preview(id, input), /disabled/);
  enabled = true;
  for (const invalid of [
    { ...input, network: "mainnet" },
    { ...input, storageKey: storageKey.replace("testnet", "mainnet") },
    {
      ...input,
      raw: JSON.stringify({
        cloid,
        message: "x",
        unknown: true,
        terminalPacketId: "p",
      }),
    },
    { ...input, raw: JSON.stringify({ cloid, message: "x", unknown: false }) },
    { ...input, raw: "x".repeat(4097) },
    { ...input, raw: "{broken" },
  ])
    await assert.rejects(r.preview(id, invalid));
  master = "0x" + "1".repeat(40);
  await assert.rejects(r.preview(id, input));
  master = account;
  const review = await r.preview(id, input);
  await assert.rejects(
    r.confirm(await user(), {
      network: "testnet",
      review,
      acknowledgments: { uncertainty: true, stoppedPrompts: true },
    }),
    /review/,
  );
  await assert.rejects(
    r.confirm(id, {
      network: "testnet",
      review: { ...review, raw: raw + " " },
      acknowledgments: { uncertainty: true, stoppedPrompts: true },
    }),
    /review/,
  );
  for (const patch of [
    { orderStatus: "filled" },
    { nonzeroPositions: 1 },
    { openOrders: 1 },
    { matchingFills: 1 },
    { checkedAt: Date.now() - 4000 },
    { network: "mainnet" },
    { account: "0x" + "2".repeat(40) },
  ]) {
    obs = { ...observation(), ...patch } as any;
    await assert.rejects(
      r.confirm(id, {
        network: "testnet",
        review,
        acknowledgments: { uncertainty: true, stoppedPrompts: true },
      }),
    );
  }
  obs = observation();
  const agentId = randomUUID();
  await queryDatabase(
    "INSERT INTO hl_terminal_agents(id,user_id,network,account,agent_address,agent_name,expires_at,approval,busy_packet) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)",
    [
      agentId,
      id,
      "testnet",
      account,
      "0x" + "3".repeat(40),
      "fixture",
      Date.now() + 10000,
      {},
      "old-broker-packet",
    ],
  );
  await assert.rejects(
    r.confirm(id, {
      network: "testnet",
      review,
      acknowledgments: { uncertainty: true, stoppedPrompts: true },
    }),
    /broker|unresolved/,
  );
  assert.equal(
    (
      await queryDatabase(
        "SELECT busy_packet FROM hl_terminal_agents WHERE id=$1",
        [agentId],
      )
    ).rows[0].busy_packet,
    "old-broker-packet",
  );
  assert.equal((await r.journal(id, "testnet")).receipts.length, 0);
});
test("five-minute review expires without journal write; unknown executions block even when signer busy flag is absent", async () => {
  const id = await user(),
    r = mod.createLegacyRecovery({
      getAccount: async () => account,
      preparedPacketExists: () => false,
      testDependencies: {
        scopeEnabled: () => true,
        observe: async () => observation(),
      },
    }),
    review = await r.preview(id, { network: "testnet", storageKey, raw });
  const actualNow = Date.now;
  Date.now = () => review.expiresAfter + 1;
  try {
    await assert.rejects(
      r.confirm(id, {
        network: "testnet",
        review,
        acknowledgments: { uncertainty: true, stoppedPrompts: true },
      }),
      /expired/,
    );
  } finally {
    Date.now = actualNow;
  }
  assert.equal((await r.journal(id, "testnet")).receipts.length, 0);
  const agentId = randomUUID();
  await queryDatabase(
    "INSERT INTO hl_terminal_agents(id,user_id,network,account,agent_address,agent_name,expires_at,approval) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)",
    [
      agentId,
      id,
      "testnet",
      account,
      "0x" + "5".repeat(40),
      "fixture",
      Date.now() + 10000,
      {},
    ],
  );
  await queryDatabase(
    "INSERT INTO hl_terminal_executions(packet_id,agent_id,user_id,account,packet,payload_hash,nonce,state,created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)",
    [
      randomUUID(),
      agentId,
      id,
      account,
      {},
      "fixture",
      1,
      "UNKNOWN",
      Date.now(),
    ],
  );
  await assert.rejects(
    r.confirm(id, {
      network: "testnet",
      review,
      acknowledgments: { uncertainty: true, stoppedPrompts: true },
    }),
    /broker/,
  );
  assert.equal(
    (
      await queryDatabase(
        "SELECT busy_packet FROM hl_terminal_agents WHERE id=$1",
        [agentId],
      )
    ).rows[0].busy_packet,
    null,
  );
  assert.equal((await r.journal(id, "testnet")).receipts.length, 0);
});
test("lost HTTP receipt keeps browser blocker; durable idempotent recovery safely retires exact bytes after re-review", async () => {
  const { confirmLegacyRecoveryRequest } = await import(
    "../../src/hooks/useHyperliquidAccount"
  );
  const id = await user(),
    r = mod.createLegacyRecovery({
      getAccount: async () => account,
      preparedPacketExists: () => false,
      testDependencies: {
        scopeEnabled: () => true,
        observe: async () => observation(),
      },
    }),
    review = await r.preview(id, { network: "testnet", storageKey, raw }),
    values = new Map([[storageKey, raw]]),
    s = {
      getItem: (k: string) => values.get(k) ?? null,
      setItem: (k: string, v: string) => {
        values.set(k, v);
      },
      removeItem: (k: string) => {
        values.delete(k);
      },
    };
  await assert.rejects(
    confirmLegacyRecoveryRequest(
      s,
      review,
      { uncertainty: true, stoppedPrompts: true },
      async () => {
        await r.confirm(id, {
          network: "testnet",
          review,
          acknowledgments: { uncertainty: true, stoppedPrompts: true },
        });
        throw Error("lost HTTP response");
      },
      () => true,
    ),
    /lost HTTP/,
  );
  assert.equal(values.get(storageKey), raw);
  const [original] = (await r.journal(id, "testnet")).receipts;
  assert.ok(original);
  const fresh = await r.preview(id, { network: "testnet", storageKey, raw });
  const recovered = await confirmLegacyRecoveryRequest(
    s,
    fresh,
    { uncertainty: true, stoppedPrompts: true },
    async () =>
      r.confirm(id, {
        network: "testnet",
        review: fresh,
        acknowledgments: { uncertainty: true, stoppedPrompts: true },
      }),
    () => true,
  );
  assert.deepEqual(recovered, original);
  assert.equal(values.get(storageKey), undefined);
  assert.equal((await r.journal(id, "testnet")).receipts.length, 1);
});
test("offline production Info client observes the whole account and never uses exchange", async () => {
  const id = await user();
  let active = "none";
  const original = globalThis.fetch;
  const types = new Set<string>();
  globalThis.fetch = async (url, opts) => {
    assert.equal(String(url), "https://api.hyperliquid-testnet.xyz/info");
    const b = JSON.parse(String(opts?.body));
    types.add(b.type);
    assert.equal(b.user, account);
    const value =
      b.type === "orderStatus"
        ? { status: "unknownOid" }
        : b.type === "clearinghouseState"
          ? {
              assetPositions:
                active === "position"
                  ? [{ position: { coin: "ETH", szi: "0.01" } }]
                  : [],
            }
          : b.type === "frontendOpenOrders"
            ? active === "order"
              ? [{ coin: "ETH" }]
              : []
            : b.type === "userFills"
              ? [{ cloid: "0x" + "f".repeat(32) }]
              : b.type === "historicalOrders"
                ? []
                : null;
    if (value === null) throw Error("Unexpected native request");
    return new Response(JSON.stringify(value), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  try {
    const r = mod.createLegacyRecovery({
      getAccount: async () => account,
      preparedPacketExists: () => false,
      testDependencies: { scopeEnabled: () => true, observe: undefined },
    });
    const review = await r.preview(id, { network: "testnet", storageKey, raw });
    assert.equal(review.observation.fillCount, 1);
    assert.equal(review.observation.historyCompleteness, false);
    assert.deepEqual([...types].sort(), [
      "clearinghouseState",
      "frontendOpenOrders",
      "historicalOrders",
      "orderStatus",
      "userFills",
    ]);
    active = "position";
    await assert.rejects(
      r.preview(id, { network: "testnet", storageKey, raw }),
      /active positions/,
    );
    active = "order";
    await assert.rejects(
      r.preview(id, { network: "testnet", storageKey, raw }),
      /active positions or orders/,
    );
  } finally {
    globalThis.fetch = original;
  }
});
test("production scope is disabled unless both server-only settings exactly match and test injection cannot override production", async () => {
  const keyA = "HL_TESTNET_LEGACY_RECOVERY_ACCOUNT",
    keyC = "HL_TESTNET_LEGACY_RECOVERY_CLOID",
    beforeA = process.env[keyA],
    beforeC = process.env[keyC],
    mode = process.env.NODE_ENV;
  const r = mod.createLegacyRecovery({
    getAccount: async () => account,
    preparedPacketExists: () => false,
  });
  try {
    delete process.env[keyA];
    delete process.env[keyC];
    await assert.rejects(r.journal(randomUUID(), "testnet"), /disabled/);
    process.env[keyA] = account;
    await assert.rejects(r.journal(randomUUID(), "testnet"), /disabled/);
    process.env[keyC] = cloid;
    const allowed = await user();
    assert.equal((await r.journal(allowed, "testnet")).account, account);
    process.env[keyA] = "0x" + "4".repeat(40);
    await assert.rejects(r.journal(randomUUID(), "testnet"), /disabled/);
    process.env.NODE_ENV = "production";
    assert.throws(
      () =>
        mod.createLegacyRecovery({
          getAccount: async () => account,
          preparedPacketExists: () => false,
          testDependencies: {
            scopeEnabled: () => true,
            observe: async () => observation(),
          },
        }),
      /test-only/,
    );
  } finally {
    process.env.NODE_ENV = mode;
    if (beforeA === undefined) delete process.env[keyA];
    else process.env[keyA] = beforeA;
    if (beforeC === undefined) delete process.env[keyC];
    else process.env[keyC] = beforeC;
  }
});
function exactCanonicalEvidence(message = "Unresolved action: unknownOid") {
  const packetId = "aed43368-803b-4dce-bf7b-aa2a629b3c51",
    p = {
      version: 1,
      network: "testnet",
      account,
      packetId,
      action: {
        type: "order",
        grouping: "na",
        orders: [
          {
            a: 3,
            b: true,
            p: "82923",
            s: "0.00944",
            r: false,
            c: cloid,
            t: { limit: { tif: "Ioc" } },
          },
        ],
      },
      ids: [cloid],
      createdAt: 1791838268932,
      expiresAfter: 1791838328932,
      message,
      legacy: false,
    };
  return {
    network: "testnet",
    storageKey: `antytilt:hl:terminal-pending:testnet:${account}`,
    raw: JSON.stringify(p),
    mirrorStorageKey: storageKey,
    mirrorRaw: JSON.stringify({
      cloid,
      message: "Native result unresolved",
      unknown: true,
      terminalPacketId: packetId,
    }),
  };
}
test("exact observed canonical client-only record binds both records, has joint idempotency and keeps UNKNOWN", async () => {
  const id = await user(),
    r = mod.createLegacyRecovery({
      getAccount: async () => account,
      preparedPacketExists: () => false,
      testDependencies: {
        scopeEnabled: () => true,
        observe: async () => observation(),
      },
    });
  const input = exactCanonicalEvidence(),
    review = await r.preview(id, input);
  assert.equal(review.format, "CANONICAL_CLIENT_ONLY");
  assert.equal(review.packetId, "aed43368-803b-4dce-bf7b-aa2a629b3c51");
  assert.equal(review.mirrorRaw, input.mirrorRaw);
  assert.ok(review.evidenceHash);
  assert.deepEqual(review.missingFields, ["nonce"]);
  const first = await r.confirm(id, {
    network: "testnet",
    review,
    acknowledgments: { uncertainty: true, stoppedPrompts: true },
  });
  assert.equal(first.outcome, "UNKNOWN");
  assert.equal(first.mirrorRaw, input.mirrorRaw);
  assert.deepEqual(
    await r.confirm(id, {
      network: "testnet",
      review,
      acknowledgments: { uncertainty: true, stoppedPrompts: true },
    }),
    first,
  );
  const changed = {
      ...input,
      mirrorRaw: JSON.stringify({
        ...JSON.parse(input.mirrorRaw),
        message: "Fresh readonly observation: unknownOid",
      }),
    },
    secondReview = await r.preview(id, changed);
  assert.notEqual(secondReview.evidenceHash, review.evidenceHash);
  const second = await r.confirm(id, {
    network: "testnet",
    review: secondReview,
    acknowledgments: { uncertainty: true, stoppedPrompts: true },
  });
  assert.notEqual(second.id, first.id);
  assert.equal((await r.journal(id, "testnet")).receipts.length, 2);
  const restart = mod.createLegacyRecovery({
      getAccount: async () => account,
      preparedPacketExists: () => false,
      testDependencies: {
        scopeEnabled: () => true,
        observe: async () => observation(),
      },
    }),
    third = await restart.preview(id, input);
  assert.deepEqual(
    await restart.confirm(id, {
      network: "testnet",
      review: third,
      acknowledgments: { uncertainty: true, stoppedPrompts: true },
    }),
    first,
  );
});
test("client-only branch rejects any target execution state and prepared cache before append and receipt reuse", async () => {
  const id = await user();
  let cached = false,
    observed = () => {};
  const r = mod.createLegacyRecovery({
      getAccount: async () => account,
      preparedPacketExists: () => cached,
      testDependencies: {
        scopeEnabled: () => true,
        observe: async () => {
          observed();
          return observation();
        },
      },
    }),
    input = exactCanonicalEvidence(),
    review = await r.preview(id, input);
  cached = true;
  await assert.rejects(
    r.confirm(id, {
      network: "testnet",
      review,
      acknowledgments: { uncertainty: true, stoppedPrompts: true },
    }),
    /prepared|cache/,
  );
  cached = false;
  observed = () => {
    cached = true;
  };
  await assert.rejects(
    r.confirm(id, {
      network: "testnet",
      review,
      acknowledgments: { uncertainty: true, stoppedPrompts: true },
    }),
    /prepared|cache/,
  );
  observed = () => {};
  cached = false;
  const receipt = await r.confirm(id, {
    network: "testnet",
    review,
    acknowledgments: { uncertainty: true, stoppedPrompts: true },
  });
  cached = true;
  await assert.rejects(
    r.confirm(id, {
      network: "testnet",
      review,
      acknowledgments: { uncertainty: true, stoppedPrompts: true },
    }),
    /prepared|cache/,
  );
  cached = false;
  const agentId = randomUUID();
  await queryDatabase(
    "INSERT INTO hl_terminal_agents(id,user_id,network,account,agent_address,agent_name,expires_at,approval) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)",
    [
      agentId,
      id,
      "testnet",
      account,
      "0x" + "8".repeat(40),
      "fixture",
      Date.now() + 10000,
      {},
    ],
  );
  for (const state of [
    "CONFIRMED",
    "REJECTED",
    "ACKNOWLEDGED",
    "UNKNOWN",
    "SUBMITTING",
    "PARTIAL",
  ]) {
    await queryDatabase(
      "INSERT INTO hl_terminal_executions(packet_id,agent_id,user_id,account,packet,payload_hash,nonce,state,created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)",
      [
        review.packetId,
        agentId,
        id,
        account,
        {},
        "fixture",
        1,
        state,
        Date.now(),
      ],
    );
    await assert.rejects(
      r.confirm(id, {
        network: "testnet",
        review,
        acknowledgments: { uncertainty: true, stoppedPrompts: true },
      }),
      /execution|broker/,
    );
    await queryDatabase(
      "DELETE FROM hl_terminal_executions WHERE packet_id=$1",
      [review.packetId],
    );
  }
  assert.equal((await r.journal(id, "testnet")).receipts[0].id, receipt.id);
});
test("a foreign settled target execution appearing during fresh observation refuses both append and receipt reuse without exposing its data", async () => {
  const id = await user(),
    foreign = await user(),
    agentId = randomUUID(),
    packetId = "aed43368-803b-4dce-bf7b-aa2a629b3c51";
  let race = false;
  await queryDatabase(
    "INSERT INTO hl_terminal_agents(id,user_id,network,account,agent_address,agent_name,expires_at,approval) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)",
    [
      agentId,
      foreign,
      "testnet",
      "0x" + "4".repeat(40),
      "0x" + "9".repeat(40),
      "foreign-private",
      Date.now() + 10000,
      {},
    ],
  );
  const r = mod.createLegacyRecovery({
      getAccount: async () => account,
      preparedPacketExists: () => false,
      testDependencies: {
        scopeEnabled: () => true,
        observe: async () => {
          if (race)
            await queryDatabase(
              "INSERT INTO hl_terminal_executions(packet_id,agent_id,user_id,account,packet,payload_hash,nonce,state,created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)",
              [
                packetId,
                agentId,
                foreign,
                "0x" + "4".repeat(40),
                { private: "CANARY" },
                "fixture",
                1,
                "CONFIRMED",
                Date.now(),
              ],
            );
          return observation();
        },
      },
    }),
    review = await r.preview(id, exactCanonicalEvidence()),
    acknowledgments = { uncertainty: true, stoppedPrompts: true };
  race = true;
  await assert.rejects(
    r.confirm(id, { network: "testnet", review, acknowledgments }),
    (e) =>
      e instanceof Error &&
      /execution row/.test(e.message) &&
      !/CANARY|foreign-private/.test(e.message),
  );
  assert.equal((await r.journal(id, "testnet")).receipts.length, 0);
  await queryDatabase("DELETE FROM hl_terminal_executions WHERE packet_id=$1", [
    packetId,
  ]);
  race = false;
  const receipt = await r.confirm(id, {
    network: "testnet",
    review,
    acknowledgments,
  });
  race = true;
  await assert.rejects(
    r.confirm(id, { network: "testnet", review, acknowledgments }),
    /execution row/,
  );
  await queryDatabase("DELETE FROM hl_terminal_executions WHERE packet_id=$1", [
    packetId,
  ]);
  assert.equal((await r.journal(id, "testnet")).receipts[0].id, receipt.id);
});
