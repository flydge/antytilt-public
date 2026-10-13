import { createHash } from "node:crypto";
import { queryDatabase, withDatabaseTransaction } from "../postgres";
import type { PoolClient } from "pg";
import type {
  HlTerminalPacket,
  HlTerminalResult,
} from "../../shared/hyperliquidTerminal";
import type {
  HlTerminalAgentApproval,
  HlTerminalAgentExecution,
} from "../../shared/hyperliquidTerminalAgent";
export interface TerminalAgentRow {
  id: string;
  user_id: string;
  account: string;
  agent_address: string;
  agent_name: string;
  expires_at: number;
  signer_ciphertext: string | null;
  confirmed: boolean;
  nonce: number;
  busy_packet: string | null;
  approval: HlTerminalAgentApproval;
}
export interface TerminalExecutionRow {
  packet_id: string;
  agent_id: string;
  user_id: string;
  account: string;
  packet: HlTerminalPacket;
  payload_hash: string;
  nonce: number;
  state: HlTerminalAgentExecution["state"];
  result: HlTerminalResult | null;
}
export async function getAgent(user: string, account: string, tx?: PoolClient) {
  return (
    (
      await queryDatabase<TerminalAgentRow>(
        "SELECT * FROM hl_terminal_agents WHERE user_id=$1 AND account=$2",
        [user, account],
        tx,
      )
    ).rows[0] ?? null
  );
}
export async function getExecution(
  user: string,
  account: string,
  id: string,
  tx?: PoolClient,
) {
  return (
    (
      await queryDatabase<TerminalExecutionRow>(
        "SELECT * FROM hl_terminal_executions WHERE user_id=$1 AND account=$2 AND packet_id=$3",
        [user, account, id],
        tx,
      )
    ).rows[0] ?? null
  );
}
export async function prepareAgent(
  user: string,
  account: string,
  a: HlTerminalAgentApproval,
  ciphertext: string,
) {
  return withDatabaseTransaction(async (tx) => {
    const old = await getAgent(user, account, tx);
    if (old?.busy_packet)
      throw Error(
        "Previous terminal execution unresolved; reconcile before another candidate",
      );
    if (old?.signer_ciphertext && old.expires_at > Date.now()) return old;
    // Reuse the durable identity row, preserving all old packet receipts. CAS prevents concurrent replacement.
    if (old) {
      const r = await queryDatabase<TerminalAgentRow>(
        "UPDATE hl_terminal_agents SET agent_address=$4,agent_name=$5,expires_at=$6,signer_ciphertext=$7,approval=$8,confirmed=FALSE WHERE id=$1 AND user_id=$2 AND account=$3 AND busy_packet IS NULL AND (signer_ciphertext IS NULL OR expires_at<=$9) RETURNING *",
        [
          old.id,
          user,
          account,
          a.agentAddress,
          a.agentName,
          a.expiresAt,
          ciphertext,
          { ...a, id: old.id },
          Date.now(),
        ],
        tx,
      );
      if (!r.rows[0]) throw Error("Candidate changed; prepare again");
      return r.rows[0];
    }
    await queryDatabase(
      "INSERT INTO hl_terminal_agents(id,user_id,network,account,agent_address,agent_name,expires_at,signer_ciphertext,approval) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT(user_id,network,account) DO NOTHING",
      [
        a.id,
        user,
        "testnet",
        account,
        a.agentAddress,
        a.agentName,
        a.expiresAt,
        ciphertext,
        a,
      ],
      tx,
    );
    const row = await getAgent(user, account, tx);
    if (!row) throw Error("Candidate unavailable");
    return row;
  });
}
export async function updateApproval(
  row: TerminalAgentRow,
  a: HlTerminalAgentApproval,
) {
  const r = await queryDatabase<TerminalAgentRow>(
    "UPDATE hl_terminal_agents SET approval=$3 WHERE id=$1 AND agent_address=$2 AND busy_packet IS NULL AND signer_ciphertext IS NOT NULL RETURNING *",
    [row.id, row.agent_address, a],
  );
  if (!r.rows[0]) throw Error("Candidate unavailable or unresolved");
  return r.rows[0];
}
export async function confirmAgent(row: TerminalAgentRow) {
  const r = await queryDatabase(
    "UPDATE hl_terminal_agents SET confirmed=TRUE WHERE id=$1 AND agent_address=$2 AND signer_ciphertext IS NOT NULL AND expires_at>$3",
    [row.id, row.agent_address, Date.now()],
  );
  if (!r.rowCount) throw Error("Candidate expired or disabled");
}
export async function disableAgent(row: TerminalAgentRow) {
  await queryDatabase(
    "UPDATE hl_terminal_agents SET signer_ciphertext=NULL,confirmed=FALSE WHERE id=$1 AND agent_address=$2",
    [row.id, row.agent_address],
  );
}
export function payloadHash(packet: HlTerminalPacket, nonce: number) {
  return createHash("sha256")
    .update(
      JSON.stringify({
        action: packet.action,
        nonce,
        expiresAfter: packet.expiresAfter,
      }),
    )
    .digest("hex");
}
export async function claimExecution(
  row: TerminalAgentRow,
  p: HlTerminalPacket,
) {
  return withDatabaseTransaction(async (tx) => {
    const old = await getExecution(row.user_id, row.account, p.id, tx);
    if (old) return { row: old, claimed: false };
    const fresh = await getAgent(row.user_id, row.account, tx);
    if (
      !fresh ||
      fresh.agent_address !== row.agent_address ||
      !fresh.confirmed ||
      !fresh.signer_ciphertext ||
      fresh.expires_at <= Date.now()
    )
      throw Error("Terminal signer changed or expired");
    const nonce = Math.max(Date.now(), Number(fresh.nonce) + 1);
    const r = await queryDatabase(
      "UPDATE hl_terminal_agents SET nonce=$3,busy_packet=$4 WHERE id=$1 AND nonce=$2 AND busy_packet IS NULL AND signer_ciphertext IS NOT NULL AND confirmed=TRUE RETURNING id",
      [row.id, fresh.nonce, nonce, p.id],
      tx,
    );
    if (!r.rowCount)
      throw Error("Previous terminal execution unresolved; reconcile first");
    const execution = (
      await queryDatabase<TerminalExecutionRow>(
        "INSERT INTO hl_terminal_executions(packet_id,agent_id,user_id,account,packet,payload_hash,nonce,state,created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *",
        [
          p.id,
          row.id,
          row.user_id,
          row.account,
          p,
          payloadHash(p, nonce),
          nonce,
          "SUBMITTING",
          Date.now(),
        ],
        tx,
      )
    ).rows[0];
    return { row: execution, claimed: true };
  });
}
export async function finishExecution(
  e: TerminalExecutionRow,
  state: HlTerminalAgentExecution["state"],
  result: HlTerminalResult | null,
) {
  return withDatabaseTransaction(async (tx) => {
    // A late HTTP timeout cannot overwrite newer, definitive public reconciliation.
    const updated = await queryDatabase<TerminalExecutionRow>(
      "UPDATE hl_terminal_executions SET state=$2,result=$3 WHERE packet_id=$1 AND state IN ('SUBMITTING','UNKNOWN','PARTIAL') RETURNING *",
      [e.packet_id, state, result],
      tx,
    );
    if (!updated.rows[0]) {
      const current = await getExecution(e.user_id, e.account, e.packet_id, tx);
      if (!current) throw Error("Durable execution receipt unavailable");
      return publicExecution(current);
    }
    if (!["SUBMITTING", "UNKNOWN", "PARTIAL"].includes(state))
      await queryDatabase(
        "UPDATE hl_terminal_agents SET busy_packet=NULL WHERE id=$1 AND busy_packet=$2",
        [e.agent_id, e.packet_id],
        tx,
      );
    return publicExecution(updated.rows[0]);
  });
}
export const publicExecution = (
  e: TerminalExecutionRow,
): HlTerminalAgentExecution => ({
  network: "testnet",
  packetId: e.packet_id,
  state: e.state,
  result: e.result,
});
