import {
  ExchangeClient,
  HttpTransport,
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
import { createWalletClient, custom, recoverTypedDataAddress } from "viem";
import {
  validateTerminalPacket,
  type HlTerminalPacket,
  type HlTerminalResult,
} from "../../shared/hyperliquidTerminal";
export type OwnerWallet = {
  isPhantom?: boolean;
  request: (input: { method: string; params?: unknown[] }) => Promise<unknown>;
};
export function ownerSigningIssue(provider: OwnerWallet | undefined): string | null {
  return provider?.isPhantom === true
    ? "Phantom cannot sign Hyperliquid's chain 1337 trading domain. This is Testnet; direct signing is disabled until a separate Testnet API wallet is approved."
    : null;
}
export class TerminalSubmissionError extends Error {
  constructor(
    message: string,
    public readonly uncertain: boolean,
    cause?: unknown,
  ) {
    super(message, { cause });
  }
}
const usedPackets = new Set<string>();
export { parseTerminalResult } from "../../shared/hyperliquidTerminalResult";
import { parseTerminalResult } from "../../shared/hyperliquidTerminalResult";
const stable = (v: unknown): string =>
  JSON.stringify(v, (_k, value) =>
    value && typeof value === "object" && !Array.isArray(value)
      ? Object.fromEntries(
          Object.entries(value).sort(([a], [b]) => a.localeCompare(b)),
        )
      : value,
  );
/** Owner-only signing with an immutable packet, exact SDK hash/payload, fresh gates, and no retry. */
export async function submitTerminalAction(
  packet: HlTerminalPacket,
  provider: OwnerWallet,
  authorize: () => Promise<void>,
  selectionGuard: () => boolean,
): Promise<HlTerminalResult> {
  const p = structuredClone(packet);
  validateTerminalPacket(p, Date.now());
  const unsupported = ownerSigningIssue(provider);
  if (unsupported) throw new TerminalSubmissionError(unsupported, false);
  if (typeof authorize !== "function" || typeof selectionGuard !== "function")
    throw Error("Fresh authorization and selection guards required");
  const selected = () => {
    if (!selectionGuard())
      throw Error("Execution account/network selection changed");
  };
  selected();
  if (usedPackets.has(p.id))
    throw Error("Packet already used; submit once only");
  usedPackets.add(p.id);
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
    ) as unknown as Record<string, unknown>,
    nonce = Date.now();
  let submitted = false,
    signs = 0,
    lastAuthorizedAt = 0;
  const verifyMaster = async (method = "eth_accounts") => {
    selected();
    const accounts = await provider.request({ method });
    selected();
    if (
      !Array.isArray(accounts) ||
      typeof accounts[0] !== "string" ||
      accounts[0].toLowerCase() !== p.account.toLowerCase()
    )
      throw Error("Select linked master EOA in wallet");
  };
  const gate = async () => {
    selected();
    validateTerminalPacket(p, Date.now());
    await verifyMaster();
    const started = Date.now();
    await authorize();
    lastAuthorizedAt = started;
    selected();
    validateTerminalPacket(p, Date.now());
    await verifyMaster();
  };
  try {
    await verifyMaster("eth_requestAccounts");
    const guarded: OwnerWallet = {
      request: async (input) => {
        selected();
        if (input.method === "eth_signTypedData_v4") {
          if (++signs !== 1) throw Error("Only one owner signature allowed");
          await gate();
          const typed = JSON.parse(String(input.params?.[1]));
          const hash = createL1ActionHash({
            action: expected,
            nonce,
            expiresAfter: p.expiresAfter,
          });
          if (
            typed.domain?.name !== "Exchange" ||
            typed.domain?.version !== "1" ||
            Number(typed.domain?.chainId) !== 1337 ||
            typed.domain?.verifyingContract !==
              "0x0000000000000000000000000000000000000000" ||
            typed.primaryType !== "Agent" ||
            typed.message?.source !== "b" ||
            typed.message?.connectionId !== hash
          )
            throw Error("Unexpected native signing domain/source/action hash");
          const signature = await provider.request(input);
          if (typeof signature !== "string")
            throw Error("Owner signature unavailable");
          const recovered = await recoverTypedDataAddress({
            ...typed,
            signature: signature as `0x${string}`,
          });
          if (recovered.toLowerCase() !== p.account.toLowerCase())
            throw Error("Signature is not from linked master");
          await gate();
          return signature;
        }
        return provider.request(input);
      },
    };
    const wallet = createWalletClient({
        account: p.account as `0x${string}`,
        transport: custom(guarded, { retryCount: 0 }),
      }),
      http = new HttpTransport({ isTestnet: true, timeout: 8000 });
    const transport: IRequestTransport = {
      isTestnet: true,
      async request<T>(
        endpoint: "info" | "exchange",
        payload: unknown,
        signal?: AbortSignal,
      ): Promise<T> {
        selected();
        validateTerminalPacket(p, Date.now());
        await verifyMaster();
        if (Date.now() - lastAuthorizedAt > 3000) await gate();
        const body = payload as {
          action?: unknown;
          nonce?: number;
          expiresAfter?: number;
          vaultAddress?: unknown;
        };
        if (
          endpoint !== "exchange" ||
          submitted ||
          stable(body.action) !== stable(expected) ||
          body.nonce !== nonce ||
          body.expiresAfter !== p.expiresAfter ||
          body.vaultAddress
        )
          throw Error("Actual SDK native payload differs from prepared packet");
        submitted = true;
        return http.request<T>(endpoint, payload, signal);
      },
    };
    const sdk = new ExchangeClient({
      transport,
      wallet,
      nonceManager: () => nonce,
    });
    const opts = { expiresAfter: p.expiresAfter };
    let result: unknown;
    if (a.type === "order")
      result = await sdk.order(
        { orders: a.orders, grouping: a.grouping },
        opts,
      );
    else if (a.type === "updateLeverage")
      result = await sdk.updateLeverage(
        { asset: a.asset, isCross: a.isCross, leverage: a.leverage },
        opts,
      );
    else if (a.type === "cancel")
      result = await sdk.cancel({ cancels: a.cancels }, opts);
    else result = await sdk.batchModify({ modifies: a.modifies }, opts);
    return parseTerminalResult(p, result);
  } catch (error) {
    if (submitted && error instanceof ApiRequestError) {
      const result = parseTerminalResult(p, error.response);
      if (result.kind !== "UNKNOWN") return result;
    }
    throw new TerminalSubmissionError(
      submitted
        ? "Native action result unknown; reconcile public IDs/settings before another action"
        : error instanceof Error
          ? error.message
          : "Owner signing incomplete",
      submitted,
      error,
    );
  }
}
