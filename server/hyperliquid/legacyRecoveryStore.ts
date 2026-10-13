import type { PoolClient } from "pg";
import { queryDatabase, withDatabaseTransaction } from "../postgres";
import type {
  HlLegacyRecoveryReceipt,
  HlLegacyRecoveryReview,
} from "../../shared/hyperliquidLegacyRecovery";
export async function findLegacyReceipt(
  user: string,
  account: string,
  cloid: string,
  hash: string,
  tx?: PoolClient,
) {
  return (
    (
      await queryDatabase<{ data: HlLegacyRecoveryReceipt }>(
        "SELECT data FROM hl_legacy_recovery_journal WHERE user_id=$1 AND network='testnet' AND account=$2 AND cloid=$3 AND raw_hash=$4",
        [user, account, cloid, hash],
        tx,
      )
    ).rows[0]?.data ?? null
  );
}
export async function assertNoLegacyBrokerLock(
  user: string,
  account: string,
  tx?: PoolClient,
) {
  const agents = await queryDatabase<{ busy_packet: string | null }>(
    "SELECT busy_packet FROM hl_terminal_agents WHERE user_id=$1 AND account=$2 FOR UPDATE",
    [user, account],
    tx,
  );
  const executions = await queryDatabase(
    "SELECT packet_id FROM hl_terminal_executions WHERE user_id=$1 AND account=$2 AND state IN ('UNKNOWN','SUBMITTING','PARTIAL') LIMIT 1",
    [user, account],
    tx,
  );
  if (agents.rows.some((r) => r.busy_packet) || executions.rowCount)
    throw Error(
      "Terminal broker execution unresolved; legacy recovery cannot release or modify its lock",
    );
}
export async function appendLegacyReceipt(
  user: string,
  receipt: HlLegacyRecoveryReceipt,
  guard: () => void = () => {},
) {
  return withDatabaseTransaction(async (tx) => {
    await assertNoLegacyBrokerLock(user, receipt.account, tx);
    await assertCanonicalClientOnlyAbsent(receipt.review, tx);
    guard();
    if (
      Date.now() - receipt.observation.checkedAt > 3000 ||
      receipt.observation.checkedAt > Date.now() + 5000
    )
      throw Error("Native recovery observation stale before durable archive");
    await queryDatabase(
      "INSERT INTO hl_legacy_recovery_journal(id,user_id,network,account,cloid,raw_hash,data,retired_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT(user_id,network,account,cloid,raw_hash) DO NOTHING",
      [
        receipt.id,
        user,
        "testnet",
        receipt.account,
        receipt.cloid,
        receipt.evidenceHash ?? receipt.rawHash,
        receipt,
        receipt.retiredAt,
      ],
      tx,
    );
    const stored = await findLegacyReceipt(
      user,
      receipt.account,
      receipt.cloid,
      receipt.evidenceHash ?? receipt.rawHash,
      tx,
    );
    if (!stored) throw Error("Durable legacy archive readback failed");
    await assertCanonicalClientOnlyAbsent(receipt.review, tx);
    guard();
    return stored;
  });
}
export async function legacyJournal(user: string, account: string) {
  return (
    await queryDatabase<{ data: HlLegacyRecoveryReceipt }>(
      "SELECT data FROM hl_legacy_recovery_journal WHERE user_id=$1 AND network='testnet' AND account=$2 ORDER BY retired_at DESC LIMIT 20",
      [user, account],
    )
  ).rows.map((r) => r.data);
}

export async function assertCanonicalClientOnlyAbsent(
  r: HlLegacyRecoveryReview,
  tx?: PoolClient,
) {
  if (r.format !== "CANONICAL_CLIENT_ONLY") return;
  const found = await queryDatabase(
    "SELECT packet_id FROM hl_terminal_executions WHERE packet_id=$1 LIMIT 1",
    [r.packetId],
    tx,
  );
  if (found.rowCount)
    throw Error(
      "Exact packet has a durable execution row; client-only recovery refused",
    );
}
export async function recoverLegacyReceipt(
  user: string,
  r: HlLegacyRecoveryReview,
  guard: () => void,
) {
  return withDatabaseTransaction(async (tx) => {
    await assertNoLegacyBrokerLock(user, r.account, tx);
    await assertCanonicalClientOnlyAbsent(r, tx);
    guard();
    const stored = await findLegacyReceipt(
      user,
      r.account,
      r.cloid,
      r.evidenceHash ?? r.rawHash,
      tx,
    );
    if (!stored) throw Error("Durable archive readback failed");
    await assertCanonicalClientOnlyAbsent(r, tx);
    guard();
    return stored;
  });
}
