import { test } from "node:test";
import assert from "node:assert/strict";
import * as pending from "./terminalPending";
import type {
  HlLegacyRecoveryReview,
  HlLegacyRecoveryReceipt,
} from "../../shared/hyperliquidLegacyRecovery";
const account = "0x00000000000000000000000000000000000a11ce",
  cloid = "0x0123456789abcdef0123456789abcdef",
  key = pending.manualPendingStorageKey(account, "testnet"),
  raw = JSON.stringify({ cloid, message: "Unknown", unknown: true });
const storage = () => {
  const values = new Map<string, string>([[key, raw]]);
  return {
    values,
    getItem: (k: string) => values.get(k) ?? null,
    setItem: (k: string, v: string) => {
      values.set(k, v);
    },
    removeItem: (k: string) => {
      values.delete(k);
    },
  };
};
async function receipts() {
  const hash = Buffer.from(
      await crypto.subtle.digest("SHA-256", new TextEncoder().encode(raw)),
    ).toString("hex"),
    obs = {
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
    };
  const review: HlLegacyRecoveryReview = {
    id: "review",
    network: "testnet",
    account,
    cloid,
    storageKey: key,
    raw,
    rawHash: hash,
    outcome: "UNKNOWN",
    missingFields: ["action", "nonce", "createdAt", "expiresAfter"],
    observation: obs,
    createdAt: Date.now(),
    expiresAfter: Date.now() + 300000,
    seal: "1".repeat(64),
  };
  const receipt: HlLegacyRecoveryReceipt = {
    id: "receipt",
    network: "testnet",
    account,
    cloid,
    storageKey: key,
    raw,
    rawHash: hash,
    outcome: "UNKNOWN",
    review,
    observation: obs,
    acknowledgments: { uncertainty: true, stoppedPrompts: true },
    retiredAt: Date.now(),
    reason: "UNKNOWN retirement",
  };
  return { review, receipt };
}
test("exact successful local retirement preserves readable archive receipt before removing only old manual bytes", async () => {
  assert.equal(typeof pending.readLegacyRecoveryEvidence, "function");
  assert.equal(typeof pending.retireLegacyPending, "function");
  const s = storage(),
    { review, receipt } = await receipts();
  assert.equal(
    pending.readLegacyRecoveryEvidence(s, "testnet", account).raw,
    raw,
  );
  let archiveSeen = false;
  const remove = s.removeItem;
  s.removeItem = (k) => {
    archiveSeen = Boolean(
      [...s.values.keys()].some((k) =>
        k.startsWith("antytilt:hl:legacy-archive:"),
      ),
    );
    remove(k);
  };
  await pending.retireLegacyPending(s, review, receipt, () => true);
  assert.equal(archiveSeen, true);
  assert.equal(s.getItem(key), null);
  assert.deepEqual(JSON.parse([...s.values.values()][0]), receipt);
});
test("canonical/mirror/changedraw/bad receipt/hash/storage failure/stale context never retire active blocker", async () => {
  assert.equal(typeof pending.retireLegacyPending, "function");
  const { review, receipt } = await receipts();
  for (const mode of [
    "canonical",
    "mirror",
    "unreadable",
    "remove",
    "changed",
    "hash",
    "network",
    "missing",
    "write",
    "readback",
    "late-context",
    "archive-race",
  ] as const) {
    const s = storage();
    let selected = true;
    let returned = receipt;
    if (mode === "canonical")
      s.values.set(
        pending.terminalPendingStorageKey(account, "testnet"),
        "{corrupt",
      );
    if (mode === "mirror")
      s.values.set(
        key,
        JSON.stringify({
          cloid,
          unknown: true,
          message: "mirror",
          terminalPacketId: "new",
        }),
      );
    if (mode === "changed") s.values.set(key, raw + " ");
    if (mode === "hash") returned = { ...receipt, rawHash: "0".repeat(64) };
    if (mode === "network")
      returned = { ...receipt, account: "0x" + "2".repeat(40) };
    if (mode === "missing") returned = null as never;
    if (mode === "unreadable") s.values.set(key, "{broken");
    if (mode === "remove")
      s.removeItem = () => {
        throw Error("storage remove denied");
      };
    if (mode === "write")
      s.setItem = () => {
        throw Error("quota");
      };
    if (mode === "readback") {
      const read = s.getItem;
      s.getItem = (k) =>
        k.startsWith("antytilt:hl:legacy-archive:") ? null : read(k);
    }
    if (mode === "late-context") selected = false;
    if (mode === "archive-race") {
      const set = s.setItem;
      s.setItem = (k, v) => {
        set(k, v);
        s.values.set(
          pending.terminalPendingStorageKey(account, "testnet"),
          "new packet",
        );
      };
    }
    await assert.rejects(
      pending.retireLegacyPending(s, review, returned, () => selected),
    );
    assert.ok(s.values.has(key), mode);
  }
});
test("selection changed by archive storage or changed manual bytes during hashing preserves blocker", async () => {
  const { review, receipt } = await receipts();
  const s = storage();
  let selected = true;
  const write = s.setItem;
  s.setItem = (key, value) => {
    write(key, value);
    selected = false;
  };
  await assert.rejects(
    pending.retireLegacyPending(s, review, receipt, () => selected),
    /selection/,
  );
  assert.equal(s.getItem(key), raw);
  const other = storage();
  const promise = pending.retireLegacyPending(
    other,
    review,
    receipt,
    () => true,
  );
  other.values.set(key, raw + " ");
  await assert.rejects(promise, /changed/);
  assert.equal(other.getItem(key), raw + " ");
});
const exactCanonical = () => ({
  version: 1,
  network: 'testnet',
  account,
  packetId: 'aed43368-803b-4dce-bf7b-aa2a629b3c51',
  action: {
    type: 'order',
    grouping: 'na',
    orders: [
      {
        a: 3,
        b: true,
        p: '82923',
        s: '0.00944',
        r: false,
        c: cloid,
        t: { limit: { tif: 'Ioc' } },
      },
    ],
  },
  ids: [cloid],
  createdAt: 1791838268932,
  expiresAfter: 1791838328932,
  message: 'Unresolved',
  legacy: false,
})
const mirror = () => ({
  cloid,
  message: 'Unknown native outcome',
  unknown: true,
  terminalPacketId: 'aed43368-803b-4dce-bf7b-aa2a629b3c51',
})
test('exact canonical capture is separate from legacy; all scope/action/time/mirror substitutions fail closed', async () => {
  const shared = await import('../../shared/hyperliquidLegacyRecovery')
  assert.equal(typeof shared.parseExactCanonicalClientOnlyEvidence, 'function')
  assert.equal(typeof pending.readExactRecoveryEvidence, 'function')
  const s = storage(),
    canonicalKey = pending.terminalPendingStorageKey(account, 'testnet')
  s.values.set(canonicalKey, JSON.stringify(exactCanonical()))
  s.values.set(key, JSON.stringify(mirror()))
  const e = pending.readExactRecoveryEvidence(s, 'testnet', account)
  assert.equal(e.format, 'CANONICAL_CLIENT_ONLY')
  assert.equal(e.mirrorRaw, s.values.get(key))
  const changes = [
    { packetId: '00000000-0000-4000-8000-000000000001' },
    { createdAt: 1791838268933 },
    { expiresAfter: 1791838328933 },
    { legacy: true },
    { invalid: true },
    { knownIds: [cloid] },
    { ids: [cloid, cloid] },
    { action: { ...exactCanonical().action, grouping: 'normalTpsl' } },
    {
      action: {
        ...exactCanonical().action,
        orders: [{ ...exactCanonical().action.orders[0], r: true }],
      },
    },
    { secret: 'not-public' },
  ]
  for (const change of changes) {
    s.values.set(
      canonicalKey,
      JSON.stringify({ ...exactCanonical(), ...change }),
    )
    assert.throws(() =>
      pending.readExactRecoveryEvidence(s, 'testnet', account),
    )
  }
  for (const change of [
    { a: 4 },
    { b: false },
    { p: '82924' },
    { s: '0.00018' },
    { c: '0x' + 'a'.repeat(32) },
    { t: { limit: { tif: 'Gtc' } } },
    { t: { limit: { tif: 'Ioc', extra: true } } },
    { extra: true },
  ]) {
    s.values.set(
      canonicalKey,
      JSON.stringify({
        ...exactCanonical(),
        action: {
          ...exactCanonical().action,
          orders: [{ ...exactCanonical().action.orders[0], ...change }],
        },
      }),
    )
    assert.throws(() =>
      pending.readExactRecoveryEvidence(s, 'testnet', account),
    )
  }
  for (const change of [
    { network: 'mainnet' },
    { account: '0x' + '1'.repeat(40) },
    { message: 'x'.repeat(2001) },
    {
      action: {
        ...exactCanonical().action,
        orders: [
          ...exactCanonical().action.orders,
          ...exactCanonical().action.orders,
        ],
      },
    },
  ]) {
    s.values.set(
      canonicalKey,
      JSON.stringify({ ...exactCanonical(), ...change }),
    )
    assert.throws(() =>
      pending.readExactRecoveryEvidence(s, 'testnet', account),
    )
  }
  assert.throws(() =>
    shared.parseExactCanonicalClientOnlyEvidence(
      JSON.stringify(exactCanonical()),
      canonicalKey,
      JSON.stringify(mirror()),
      key,
      'testnet',
      account,
      1791838328932,
    ),
  )
  s.values.set(canonicalKey, JSON.stringify(exactCanonical()))
  s.values.delete(key)
  assert.throws(() => pending.readExactRecoveryEvidence(s, 'testnet', account))
  s.values.set(key, JSON.stringify({ ...mirror(), terminalPacketId: 'other' }))
  assert.throws(() => pending.readExactRecoveryEvidence(s, 'testnet', account))
})
async function canonicalReceipts() {
  const { review, receipt } = await receipts(),
    shared = await import('../../shared/hyperliquidLegacyRecovery'),
    raw = JSON.stringify(exactCanonical()),
    mirrorRaw = JSON.stringify(mirror()),
    storageKey = pending.terminalPendingStorageKey(account, 'testnet')
  const sha = async (s: string) =>
    Buffer.from(
      await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s)),
    ).toString('hex')
  const fields = {
    format: 'CANONICAL_CLIENT_ONLY' as const,
    packetId: exactCanonical().packetId,
    storageKey,
    raw,
    rawHash: await sha(raw),
    mirrorStorageKey: key,
    mirrorRaw,
    mirrorHash: await sha(mirrorRaw),
    missingFields: ['nonce'] as const,
  }
  const r = { ...review, ...fields, evidenceHash: '' }
  r.evidenceHash = await sha(shared.canonicalRecoveryIdentityText(r))
  return {
    review: r,
    receipt: { ...receipt, ...fields, evidenceHash: r.evidenceHash, review: r },
  }
}
test('canonical two-key retirement writes readable marker before removals and clears it only after both readbacks', async () => {
  const s = storage(),
    { review, receipt } = await canonicalReceipts()
  s.values.set(review.storageKey, review.raw)
  s.values.set(key, review.mirrorRaw!)
  const marker = pending.canonicalRecoveryInDoubtStorageKey(account, 'testnet'),
    remove = s.removeItem,
    removed: string[] = []
  s.removeItem = (k) => {
    if (k !== marker) assert.ok(s.values.get(marker))
    removed.push(k)
    remove(k)
  }
  await pending.retireLegacyPending(s, review, receipt, () => true)
  assert.deepEqual(removed, [review.storageKey, key, marker])
  assert.equal(pending.readTerminalPending(s, 'testnet', account), null)
  assert.equal(
    s.getItem(pending.legacyArchiveStorageKey(receipt)),
    JSON.stringify(receipt),
  )
})
test('two-key partial failure and failed rollback remain blocked after reload; explicit retry never overwrites changed evidence', async () => {
  for (const rollbackFails of [false, true]) {
    const s = storage(),
      { review, receipt } = await canonicalReceipts()
    s.values.set(review.storageKey, review.raw)
    s.values.set(key, review.mirrorRaw!)
    const remove = s.removeItem,
      set = s.setItem
    s.removeItem = (k) => {
      if (k === key) throw Error('second removal denied')
      remove(k)
    }
    s.setItem = (k, v) => {
      if (rollbackFails && k === review.storageKey)
        throw Error('rollback denied')
      set(k, v)
    }
    await assert.rejects(
      pending.retireLegacyPending(s, review, receipt, () => true),
      /in doubt/i,
    )
    assert.equal(
      pending.readTerminalPending(s, 'testnet', account)?.recoveryInDoubt,
      true,
    )
    s.setItem = set
    await pending.restoreExactCanonicalRecoveryInDoubt(
      s,
      'testnet',
      account,
      () => true,
    )
    assert.equal(s.getItem(review.storageKey), review.raw)
    assert.ok(pending.readTerminalPending(s, 'testnet', account)?.invalid)
    s.values.set(review.storageKey, 'new packet')
    await assert.rejects(
      pending.restoreExactCanonicalRecoveryInDoubt(
        s,
        'testnet',
        account,
        () => true,
      ),
    )
    assert.equal(s.getItem(review.storageKey), 'new packet')
  }
})
test('malformed marker, marker-write/readback failure, receipt mismatch and changed context block without retiring', async () => {
  const { review, receipt } = await canonicalReceipts(),
    marker = pending.canonicalRecoveryInDoubtStorageKey(account, 'testnet')
  for (const mode of [
    'malformed',
    'write',
    'readback',
    'receipt',
    'context',
    'changed-mirror',
    'remove-noop',
  ]) {
    const s = storage()
    s.values.set(review.storageKey, review.raw)
    s.values.set(key, review.mirrorRaw!)
    let selected = true
    const set = s.setItem,
      read = s.getItem
    if (mode === 'malformed') {
      s.values.set(marker, 'bad')
      assert.ok(pending.readTerminalPending(s, 'testnet', account)?.invalid)
      await assert.rejects(
        pending.restoreExactCanonicalRecoveryInDoubt(
          s,
          'testnet',
          account,
          () => true,
        ),
      )
      continue
    }
    if (mode === 'write')
      s.setItem = (k, v) => {
        if (k === marker) throw Error('quota')
        set(k, v)
      }
    if (mode === 'readback') s.getItem = (k) => (k === marker ? null : read(k))
    if (mode === 'context')
      s.setItem = (k, v) => {
        set(k, v)
        if (k === marker) selected = false
      }
    if (mode === 'changed-mirror')
      s.setItem = (k, v) => {
        set(k, v)
        if (k === marker) s.values.set(key, 'new mirror')
      }
    if (mode === 'remove-noop') s.removeItem = () => {}
    await assert.rejects(
      pending.retireLegacyPending(
        s,
        review,
        mode === 'receipt' ? { ...receipt, mirrorRaw: 'other' } : receipt,
        () => selected,
      ),
    )
    assert.ok(s.values.has(review.storageKey))
    assert.ok(s.values.has(key))
    if (mode === 'changed-mirror') assert.equal(s.getItem(key), 'new mirror')
  }
})
test('new sealed review after lost response retires with the original idempotent receipt only when joint evidence is identical', async () => {
  const s = storage(),
    { review, receipt } = await canonicalReceipts()
  s.values.set(review.storageKey, review.raw)
  s.values.set(key, review.mirrorRaw!)
  const fresh = {
    ...review,
    id: 'new-review',
    seal: '2'.repeat(64),
    createdAt: Date.now(),
    expiresAfter: Date.now() + 300000,
  }
  await pending.retireLegacyPending(s, fresh, receipt, () => true)
  assert.equal(pending.readTerminalPending(s, 'testnet', account), null)
})
test('replacement mirror during first removal is preserved; marker cleanup failure remains blocked and can retry exactly', async () => {
  for (const mode of ['replace', 'cleanup']) {
    const s = storage(),
      { review, receipt } = await canonicalReceipts(),
      marker = pending.canonicalRecoveryInDoubtStorageKey(account, 'testnet')
    s.values.set(review.storageKey, review.raw)
    s.values.set(key, review.mirrorRaw!)
    const remove = s.removeItem
    s.removeItem = (k) => {
      if (mode === 'cleanup' && k === marker) throw Error('cleanup denied')
      remove(k)
      if (mode === 'replace' && k === review.storageKey)
        s.values.set(key, 'replacement mirror')
    }
    await assert.rejects(
      pending.retireLegacyPending(s, review, receipt, () => true),
      /in doubt/,
    )
    assert.ok(pending.readTerminalPending(s, 'testnet', account)?.invalid)
    if (mode === 'replace') assert.equal(s.getItem(key), 'replacement mirror')
  }
})
test('late canonical confirmation after selection or mirror change never retires either captured key', async () => {
  const hook = await import('../hooks/useHyperliquidAccount'),
    { review, receipt } = await canonicalReceipts()
  for (const mode of ['selection', 'mirror']) {
    const s = storage()
    s.values.set(review.storageKey, review.raw)
    s.values.set(key, review.mirrorRaw!)
    let selected = true
    await assert.rejects(
      hook.confirmLegacyRecoveryRequest(
        s,
        review,
        { uncertainty: true, stoppedPrompts: true },
        async () => {
          if (mode === 'selection') selected = false
          else s.values.set(key, 'new mirror')
          return receipt
        },
        () => selected,
      ),
    )
    assert.equal(s.getItem(review.storageKey), review.raw)
    assert.ok(s.getItem(key))
  }
})
test('stored canonical data cannot impersonate the derived in-doubt recovery state',()=>{
 const s=storage(),k=pending.terminalPendingStorageKey(account,'testnet');s.values.set(k,JSON.stringify({...exactCanonical(),invalid:true,recoveryInDoubt:true}));s.values.set(key,JSON.stringify(mirror()));const p=pending.readTerminalPending(s,'testnet',account);assert.equal(p?.invalid,true);assert.equal(p?.recoveryInDoubt,undefined);assert.equal(p?.action,null)
})
