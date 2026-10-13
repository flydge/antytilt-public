import { randomUUID } from "node:crypto";
import {
  ExchangeClient,
  HttpTransport,
  InfoClient,
  type IRequestTransport,
} from "@nktkas/hyperliquid";
import {
  ApiRequestError,
  OrderRequest,
  UpdateLeverageRequest,
  CancelRequest,
  BatchModifyRequest,
} from "@nktkas/hyperliquid/api/exchange";
import { canonicalize, createL1ActionHash } from "@nktkas/hyperliquid/signing";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import type {
  HlTerminalPacket,
  HlTerminalSnapshot,
} from "../../shared/hyperliquidTerminal";
import type {
  HlTerminalAgentApproval,
  HlTerminalAgentStatus,
} from "../../shared/hyperliquidTerminalAgent";
import { parseTerminalResult } from "../../shared/hyperliquidTerminalResult";
import {
  canonicalAccount,
  agentNameBase,
  realActionsEnabled,
  type Grant,
} from "./client";
import { encryptAgent, decryptAgent } from "./store";
import {
  validateTerminalSnapshot,
  validateTerminalAuthorization,
} from "./terminal";
import * as ledger from "./terminalAgentStore";
const NAME = "AntyTILT-Trade";
const TTL = 30 * 60 * 1000;
export interface TerminalAgentTestDependencies {
  actionsEnabled?: () => boolean;
  encryptionKey: Buffer;
  grants: (account: string) => Promise<Grant[]>;
  transport?: IRequestTransport;
}
const stable = (v: unknown) =>
  JSON.stringify(v, (_k, x) =>
    x && typeof x === "object" && !Array.isArray(x)
      ? Object.fromEntries(
          Object.entries(x).sort(([a], [b]) => a.localeCompare(b)),
        )
      : x,
  );
export function createTerminalAgent(options: {
  read: (user: string, account: string) => Promise<HlTerminalSnapshot>;
  testDependencies?: TerminalAgentTestDependencies;
}) {
  if (options.testDependencies && process.env.NODE_ENV !== "test")
    throw Error("Terminal agent dependency injection is test-only");
  const deps = options.testDependencies,
    info = new InfoClient({
      transport: new HttpTransport({ isTestnet: true, timeout: 8000 }),
    });
  const enabled = deps
    ? (deps.actionsEnabled ?? (() => true))
    : realActionsEnabled;
  const grants =
    deps?.grants ??
    (async (account: string) =>
      info.extraAgents({ user: canonicalAccount(account) as `0x${string}` }));
  async function native(user: string, account: string) {
    const snapshot = await options.read(user, account);
    if (
      snapshot.account.toLowerCase() !== account ||
      snapshot.network !== "testnet"
    )
      throw Error("Linked master/network changed");
    validateTerminalSnapshot(snapshot, Date.now());
    const started = Date.now();
    const g = await grants(account);
    if (Date.now() - started > 3000) throw Error("Native grant read stale");
    if (
      !Array.isArray(g) ||
      g.some(
        (x) =>
          !x ||
          typeof x.name !== "string" ||
          !/^0x[0-9a-fA-F]{40}$/.test(x.address) ||
          (x.validUntil !== null && !Number.isSafeInteger(x.validUntil)),
      )
    )
      throw Error("Native grant data unavailable");
    validateTerminalSnapshot(snapshot, Date.now());
    return { snapshot, grants: g };
  }
  const exact = (r: ledger.TerminalAgentRow, g: Grant) =>
    g.address.toLowerCase() === r.agent_address.toLowerCase() &&
    (g.name === r.agent_name || g.name === NAME) &&
    g.validUntil === Number(r.expires_at);
  function slot(r: ledger.TerminalAgentRow | null, g: Grant[]) {
    if (g.some((x) => agentNameBase(x.name) === NAME && (!r || !exact(r, x))))
      throw Error(
        "Native terminal agent name collision; never overwrite another grant",
      );
  }
  async function candidate(
    user: string,
    account: string,
    a: HlTerminalAgentApproval,
    forSignature = true,
  ) {
    const r = await ledger.getAgent(user, account);
    if (
      !r ||
      !a ||
      a.id !== r.id ||
      a.agentAddress !== r.agent_address ||
      a.agentName !== r.agent_name ||
      a.expiresAt !== Number(r.expires_at) ||
      (forSignature && stable(r.approval) !== stable(a)) ||
      a.account !== account ||
      a.network !== "testnet"
    )
      throw Error(
        "Prepared candidate/approval changed or linked master mismatch",
      );
    if (
      !r.signer_ciphertext ||
      Number(r.expires_at) <= Date.now() ||
      (forSignature && a.reviewExpiresAt <= Date.now())
    )
      throw Error("Candidate approval expired or disabled");
    if (r.busy_packet)
      throw Error("Previous terminal execution unresolved; reconcile first");
    return r;
  }
  async function status(
    user: string,
    raw: string,
  ): Promise<HlTerminalAgentStatus> {
    const account = canonicalAccount(raw),
      r = await ledger.getAgent(user, account);
    const base = {
      network: "testnet" as const,
      account,
      id: r?.id ?? null,
      agentAddress: r?.agent_address ?? null,
      agentName: r?.agent_name ?? null,
      expiresAt: r ? Number(r.expires_at) : null,
      checkedAt: Date.now(),
    };
    if (!r)
      return {
        ...base,
        phase: "MISSING",
        reason: "Separate Testnet terminal API wallet is not prepared",
      };
    if (r.busy_packet)
      return {
        ...base,
        phase: "UNAVAILABLE",
        reason: r.signer_ciphertext
          ? "Previous terminal execution unresolved; reconcile public packet before another action"
          : "Local terminal key destroyed; native grant not revoked. Previous execution unresolved; reconcile before another key",
      };
    if (!r.signer_ciphertext)
      return {
        ...base,
        phase: "DISABLED",
        reason: "Local terminal key destroyed; native grant not revoked",
      };
    if (Number(r.expires_at) <= Date.now())
      return {
        ...base,
        phase: "EXPIRED",
        reason: "Thirty-minute terminal approval expired",
      };
    try {
      const n = await native(user, account);
      slot(r, n.grants);
      if (!r.confirmed)
        return {
          ...base,
          checkedAt: Date.now(),
          phase: "PREPARED",
          reason:
            "Prepared key is inactive until exact native owner grant is freshly verified",
        };
      const active = n.grants.some((g) => exact(r, g));
      return {
        ...base,
        checkedAt: Date.now(),
        phase: active ? "ACTIVE" : "REVOKED",
        reason: active
          ? "Exact Testnet terminal grant verified; every action still requires owner confirmation"
          : "Native terminal grant absent or changed; sends blocked",
      };
    } catch {
      return {
        ...base,
        checkedAt: Date.now(),
        phase: "UNAVAILABLE",
        reason:
          "Fresh native role, mode, metadata or grant unavailable/colliding; sends blocked",
      };
    }
  }
  async function prepare(user: string, raw: string) {
    const account = canonicalAccount(raw),
      old = await ledger.getAgent(user, account);
    if (old?.busy_packet)
      throw Error("Previous terminal execution unresolved; reconcile first");
    const n = await native(user, account);
    const reusable =
      old?.signer_ciphertext && Number(old.expires_at) > Date.now()
        ? old
        : null;
    slot(reusable, n.grants);
    if (reusable) {
      if (reusable.approval.reviewExpiresAt > Date.now())
        return reusable.approval;
      const now = Date.now(),
        a = {
          ...reusable.approval,
          nonce: Math.max(now, reusable.approval.nonce + 1),
          reviewExpiresAt: now + 60000,
          checkedAt: now,
        };
      return (await ledger.updateApproval(reusable, a)).approval;
    }
    const key = generatePrivateKey(),
      now = Date.now(),
      id = old?.id ?? randomUUID(),
      expiresAt = now + TTL;
    const approval: HlTerminalAgentApproval = {
      network: "testnet",
      account,
      id,
      agentAddress: privateKeyToAccount(key).address.toLowerCase(),
      agentName: `${NAME} valid_until ${expiresAt}`,
      expiresAt,
      nonce: now,
      reviewExpiresAt: now + 60000,
      checkedAt: now,
    };
    const row = await ledger.prepareAgent(
      user,
      account,
      approval,
      encryptAgent(key, `terminal:${id}`, deps?.encryptionKey),
    );
    return row.approval;
  }
  async function validate(
    user: string,
    raw: string,
    a: HlTerminalAgentApproval,
  ) {
    const account = canonicalAccount(raw),
      r = await candidate(user, account, a),
      n = await native(user, account);
    slot(r, n.grants);
    return { valid: true as const, approval: r.approval };
  }
  async function confirm(
    user: string,
    raw: string,
    a: HlTerminalAgentApproval,
  ) {
    const account = canonicalAccount(raw),
      r = await candidate(user, account, a, false),
      n = await native(user, account);
    slot(r, n.grants);
    if (!n.grants.some((g) => exact(r, g)))
      throw Error(
        "Exact native grant is not verified; approval response is not evidence",
      );
    await ledger.confirmAgent(r);
    return status(user, account);
  }
  async function disable(user: string, raw: string, id: string) {
    const account = canonicalAccount(raw),
      r = await ledger.getAgent(user, account);
    if (!r || r.id !== id) throw Error("Terminal candidate unavailable");
    await ledger.disableAgent(r);
    return status(user, account);
  }
  async function authorize(
    user: string,
    account: string,
    p: HlTerminalPacket,
    expected?: ledger.TerminalAgentRow,
  ) {
    if (!enabled()) throw Error("Owner runtime actions disabled");
    const r = await ledger.getAgent(user, account);
    if (
      !r ||
      !r.confirmed ||
      !r.signer_ciphertext ||
      Number(r.expires_at) <= Date.now() ||
      (expected && expected.agent_address !== r.agent_address)
    )
      throw Error("Terminal agent expired, disabled or changed");
    const n = await native(user, account);
    slot(r, n.grants);
    const final = await ledger.getAgent(user, account);
    if (
      !final ||
      !final.confirmed ||
      !final.signer_ciphertext ||
      final.agent_address !== r.agent_address ||
      Number(final.expires_at) <= Date.now()
    )
      throw Error("Terminal signer disabled or changed during native read");
    if (!enabled()) throw Error("Owner runtime actions disabled");
    validateTerminalAuthorization(p, n.snapshot, Date.now());
    if (!n.grants.some((g) => exact(r, g)))
      throw Error("Exact native terminal grant revoked or unavailable");
    return final;
  }
  async function execute(user: string, raw: string, packet: HlTerminalPacket) {
    const account = canonicalAccount(raw),
      p = structuredClone(packet);
    if (p.account !== account || p.network !== "testnet")
      throw Error("Linked master mismatch or Mainnet writes disabled");
    const prior = await ledger.getExecution(user, account, p.id);
    if (prior) return ledger.publicExecution(prior);
    const r = await authorize(user, account, p);
    const claim = await ledger.claimExecution(r, p);
    if (!claim.claimed) return ledger.publicExecution(claim.row);
    const e = claim.row;
    let sent = false;
    try {
      const a = p.action,
        schema =
          a.type === "order"
            ? OrderRequest.entries.action
            : a.type === "updateLeverage"
              ? UpdateLeverageRequest.entries.action
              : a.type === "cancel"
                ? CancelRequest.entries.action
                : BatchModifyRequest.entries.action;
      const expected = canonicalize(
        schema as never,
        a as never,
      ) as unknown as Record<string, unknown>;
      if (
        stable(expected) !== stable(a) ||
        e.payload_hash !== ledger.payloadHash(p, e.nonce)
      )
        throw Error("Prepared native payload/hash changed");
      const key = decryptAgent(
          r.signer_ciphertext!,
          `terminal:${r.id}`,
          deps?.encryptionKey,
        ),
        accountWallet = privateKeyToAccount(key);
      if (accountWallet.address.toLowerCase() !== r.agent_address)
        throw Error("Encrypted terminal signer identity mismatch");
      const hash = createL1ActionHash({
        action: expected,
        nonce: e.nonce,
        expiresAfter: p.expiresAfter,
      });
      let signs = 0;
      const wallet = {
        ...accountWallet,
        async signTypedData(
          parameters: Parameters<typeof accountWallet.signTypedData>[0],
        ) {
          const typed = parameters as unknown as {
            domain: {
              name: string;
              version: string;
              chainId: number;
              verifyingContract: string;
            };
            primaryType: string;
            message: { source: string; connectionId: string };
          };
          if (
            ++signs !== 1 ||
            typed.domain.name !== "Exchange" ||
            typed.domain.version !== "1" ||
            Number(typed.domain.chainId) !== 1337 ||
            typed.domain.verifyingContract !==
              "0x0000000000000000000000000000000000000000" ||
            typed.primaryType !== "Agent" ||
            typed.message.source !== "b" ||
            typed.message.connectionId !== hash
          )
            throw Error("SDK signing domain/source/action hash differs");
          return accountWallet.signTypedData(parameters);
        },
      };
      const http =
        deps?.transport ??
        new HttpTransport({ isTestnet: true, timeout: 8000 });
      const transport: IRequestTransport = {
        isTestnet: true,
        async request<T>(
          endpoint: "info" | "exchange",
          payload: unknown,
          signal?: AbortSignal,
        ): Promise<T> {
          const body = payload as {
            action: unknown;
            nonce: number;
            expiresAfter: number;
            vaultAddress?: unknown;
          };
          if (
            endpoint !== "exchange" ||
            sent ||
            stable(body.action) !== stable(expected) ||
            body.nonce !== e.nonce ||
            body.expiresAfter !== p.expiresAfter ||
            body.vaultAddress ||
            signs !== 1
          )
            throw Error("SDK payload differs from prepared packet");
          const durable = await ledger.getExecution(user, account, p.id),
            fresh = await authorize(user, account, p, r);
          if (
            fresh.busy_packet !== p.id ||
            durable?.state !== "SUBMITTING" ||
            durable.payload_hash !== e.payload_hash ||
            durable.nonce !== e.nonce
          )
            throw Error("Durable packet claim changed");
          sent = true;
          return http.request<T>(endpoint, payload, signal);
        },
      };
      const sdk = new ExchangeClient({
          transport,
          wallet,
          nonceManager: () => e.nonce,
        }),
        opts = {
          expiresAfter: p.expiresAfter,
          signal: AbortSignal.timeout(8000),
        };
      const response =
        a.type === "order"
          ? await sdk.order({ orders: a.orders, grouping: a.grouping }, opts)
          : a.type === "updateLeverage"
            ? await sdk.updateLeverage(
                { asset: a.asset, isCross: a.isCross, leverage: a.leverage },
                opts,
              )
            : a.type === "cancel"
              ? await sdk.cancel({ cancels: a.cancels }, opts)
              : await sdk.batchModify({ modifies: a.modifies }, opts);
      const result = parseTerminalResult(p, response);
      return ledger.finishExecution(e, result.kind, result);
    } catch (error) {
      if (sent && error instanceof ApiRequestError) {
        const result = parseTerminalResult(p, error.response);
        if (result.kind !== "UNKNOWN")
          return ledger.finishExecution(e, result.kind, result);
      }
      const state = sent ? "UNKNOWN" : "REJECTED";
      const output = await ledger.finishExecution(e, state, null);
      return {
        ...output,
        ...(output.state === "UNKNOWN"
          ? {
              reason:
                "Native result unknown; durable packet remains locked until public reconciliation",
            }
          : output.state === "REJECTED"
            ? {
                reason:
                  "Fresh terminal authorization or SDK validation failed before network; preview again",
              }
            : {}),
      };
    }
  }
  async function getExecution(user: string, raw: string, id: string) {
    return ledger.getExecution(user, canonicalAccount(raw), id);
  }

  async function reconcile(
    user: string,
    raw: string,
    id: string,
    s: HlTerminalSnapshot,
    orders: { id: string; status: string; oid?: string }[],
  ) {
    const account = canonicalAccount(raw),
      e = await ledger.getExecution(user, account, id);
    if (!e) return null;
    if (
      s.network !== "testnet" ||
      s.account.toLowerCase() !== account ||
      s.coin !== "BTC" ||
      Date.now() - s.checkedAt > 3000 ||
      s.checkedAt > Date.now() + 5000
    )
      throw Error("Reconciliation scope/freshness mismatch");
    if (!["UNKNOWN", "SUBMITTING", "PARTIAL"].includes(e.state))
      return ledger.publicExecution(e);
    const a = e.packet.action;
    if (a.type === "updateLeverage") {
      if (
        s.leverage !== a.leverage ||
        s.marginType !== (a.isCross ? "cross" : "isolated")
      )
        return ledger.publicExecution(e);
      return ledger.finishExecution(e, "ACKNOWLEDGED", {
        kind: "ACKNOWLEDGED",
        orders: [],
        protection: "NONE",
        reason: "Fresh public settings match exact durable target",
      });
    }
    const ids = terminalExecutionIds(e.packet);
    const known = (status: string) =>
      ["open", "filled", "triggered", "canceled", "rejected"].includes(
        status,
      ) || /Rejected$|Canceled$/.test(status);
    const complete = ids.every((orderId, index) => {
      const receipt = e.result?.orders[index];
      if (receipt?.kind === "REJECTED") return true;
      const observed = orders.find((o) => o.id === orderId);
      return (
        observed &&
        known(observed.status) &&
        (a.type !== "cancel" || observed.status !== "open")
      );
    });
    if (!complete) return ledger.publicExecution(e);
    return ledger.finishExecution(
      e,
      "ACKNOWLEDGED",
      e.result
        ? {
            ...e.result,
            kind: "ACKNOWLEDGED",
            reason:
              "Fresh public packet IDs and exact persisted receipts account for every leg",
          }
        : {
            kind: "ACKNOWLEDGED",
            orders: [],
            protection: e.packet.kind === "protection" ? "UNKNOWN" : "NONE",
            reason:
              "Every packet ID was acknowledged by Hyperliquid; fills and protection are confirmed separately",
          },
    );
  }
  return {
    status,
    prepare,
    validate,
    confirm,
    disable,
    execute,
    getExecution,
    reconcile,
  };
}

export function terminalExecutionIds(p: HlTerminalPacket): string[] {
  const a = p.action;
  return a.type === "order"
    ? a.orders.map((o) => o.c)
    : a.type === "batchModify"
      ? a.modifies.map((m) => m.order.c)
      : a.type === "cancel"
        ? a.cancels.map((c) => String(c.o))
        : [];
}
