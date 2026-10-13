import { Router, type Request, type Response } from "express";
import { createHmac, randomBytes } from "node:crypto";
import { z } from "zod";
import * as store from "./store";
import {
  createTerminalAgent,
  terminalExecutionIds,
  type TerminalAgentTestDependencies,
} from "./terminalAgent";
import {
  createLegacyRecovery,
  type LegacyRecoveryTestDependencies,
} from "./legacyRecovery";
import type { HlTerminalAgentApproval } from "../../shared/hyperliquidTerminalAgent";
import { canonicalAccount, realActionsEnabled } from "./client";
import {
  createTerminalProvider,
  previewTerminalAction,
  validateTerminalAuthorization,
  type TerminalProvider,
} from "./terminal";
import type {
  HlTerminalNetwork,
  HlTerminalPacket,
  HlTerminalSnapshot,
} from "../../shared/hyperliquidTerminal";
class TerminalHttpError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}
export interface TerminalTestDependencies {
  providers: Record<HlTerminalNetwork, TerminalProvider>;
  getConnection: (user: string) => Promise<{ account: string } | null>;
  actionsEnabled: () => boolean;
  agentDependencies?: TerminalAgentTestDependencies;
  recoveryDependencies?: LegacyRecoveryTestDependencies;
}
export function createTerminalRouter(options: {
  requireUser: (r: Request) => Promise<{ id: string }>;
  testDependencies?: TerminalTestDependencies;
  allowedOrigins?: ReadonlySet<string>;
}) {
  if (options.testDependencies && process.env.NODE_ENV !== "test")
    throw Error("Hyperliquid terminal dependency injection is test-only");
  const deps = options.testDependencies,
    providers = deps?.providers ?? {
      testnet: createTerminalProvider("testnet"),
      mainnet: createTerminalProvider("mainnet"),
    },
    getConnection = deps?.getConnection ?? store.getConnection,
    enabled = deps?.actionsEnabled ?? realActionsEnabled,
    router = Router(),
    secret = randomBytes(32),
    packets = new Map<string, { user: string; packet: HlTerminalPacket }>();
  const networkSchema = z.enum(["testnet", "mainnet"]);
  const seal = (user: string, p: HlTerminalPacket) =>
    createHmac("sha256", secret)
      .update(user)
      .update("\0")
      .update(JSON.stringify({ ...p, seal: "" }))
      .digest("hex");
  const bound = (user: string, value: unknown) => {
    if (!value || typeof value !== "object")
      throw new TerminalHttpError(400, "Packet required");
    const p = value as HlTerminalPacket,
      record = packets.get(p.id);
    if (
      !record ||
      record.user !== user ||
      p.seal !== record.packet.seal ||
      seal(user, p) !== p.seal
    )
      throw new TerminalHttpError(
        409,
        "Prepared packet changed or no longer available; request a new preview",
      );
    return record.packet;
  };
  const account = async (user: string) => {
    const c = await getConnection(user);
    if (!c)
      throw new TerminalHttpError(
        409,
        "Link and verify the master wallet first",
      );
    return canonicalAccount(c.account);
  };
  const read = async (
    user: string,
    network: HlTerminalNetwork,
    fresh = false,
  ): Promise<HlTerminalSnapshot> => {
    const master = await account(user),
      s = await providers[network].read(master, fresh);
    if (
      s.account.toLowerCase() !== master ||
      s.network !== network ||
      s.coin !== "BTC"
    )
      throw new TerminalHttpError(
        409,
        "Provider snapshot linked master/network mismatch",
      );
    return s;
  };
  const gate = (network: HlTerminalNetwork) => {
    if (network === "mainnet")
      throw new TerminalHttpError(
        403,
        "Mainnet writes disabled; account reads only",
      );
    if (!enabled())
      throw new TerminalHttpError(
        403,
        "Owner actions disabled pending approved runtime gate",
      );
  };
  const agent = createTerminalAgent({
    read: async (user, master) => {
      const snapshot = await read(user, "testnet", true);
      if (snapshot.account.toLowerCase() !== master)
        throw new TerminalHttpError(409, "Linked master changed");
      return snapshot;
    },
    testDependencies: deps?.agentDependencies
      ? { ...deps.agentDependencies, actionsEnabled: enabled }
      : undefined,
  });
  const legacyRecovery = createLegacyRecovery({
    getAccount: account,
    preparedPacketExists:(id)=>packets.has(id),
    testDependencies: deps?.recoveryDependencies,
  });
  const handler =
    (fn: (r: Request, s: Response, user: string) => Promise<void>) =>
    async (r: Request, s: Response) => {
      try {
        const user = await options.requireUser(r);
        const origin = r.get("origin");
        // Trusted configuration covers known proxies; forwarded request headers
        // never grant an additional origin permission.
        if (
          r.method === "POST" &&
          (!origin ||
            (origin !== `${r.protocol}://${r.get("host")}` &&
              !options.allowedOrigins?.has(origin)))
        )
          throw new TerminalHttpError(
            403,
            "Same-origin authenticated request required",
          );
        await fn(r, s, user.id);
      } catch (e) {
        const status =
          e instanceof TerminalHttpError
            ? e.status
            : e instanceof z.ZodError
              ? 400
              : (e as { status?: number })?.status === 401
                ? 401
                : 409;
        s.status(status).json({
          error:
            e instanceof Error ? e.message : "Terminal operation unavailable",
        });
      }
    };
  router.post(
    "/legacy-recovery/preview",
    handler(async (r, s, user) => {
      const input = z
        .object({
          network: networkSchema,
          storageKey: z.string().max(256),
          raw: z.string().max(4096),
          mirrorStorageKey:z.string().max(256).optional(),
          mirrorRaw:z.string().max(4096).optional(),
        })
        .strict()
        .parse(r.body);
      if (input.network !== "testnet")
        throw new TerminalHttpError(403, "Mainnet legacy recovery disabled");
      s.json(await legacyRecovery.preview(user, input));
    }),
  );
  router.post(
    "/legacy-recovery/confirm",
    handler(async (r, s, user) => {
      const input = z
        .object({
          network: networkSchema,
          review: z.unknown(),
          acknowledgments: z.unknown(),
        })
        .strict()
        .parse(r.body);
      if (input.network !== "testnet")
        throw new TerminalHttpError(403, "Mainnet legacy recovery disabled");
      s.json(
        await legacyRecovery.confirm(user, {
          ...input,
          review: input.review,
          acknowledgments: input.acknowledgments,
        }),
      );
    }),
  );
  router.get(
    "/legacy-recovery/journal",
    handler(async (r, s, user) => {
      const network = networkSchema.parse(r.query.network);
      if (network !== "testnet")
        throw new TerminalHttpError(403, "Mainnet legacy recovery disabled");
      s.json(await legacyRecovery.journal(user, network));
    }),
  );
  router.get(
    "/agent/status",
    handler(async (r, s, user) => {
      const network = networkSchema.parse(r.query.network);
      if (network !== "testnet")
        throw new TerminalHttpError(
          403,
          "Terminal agent supports Testnet only",
        );
      s.json(await agent.status(user, await account(user)));
    }),
  );
  for (const operation of [
    "prepare",
    "validate",
    "confirm",
    "disable",
    "execute",
  ] as const) {
    router.post(
      `/agent/${operation}`,
      handler(async (r, s, user) => {
        const network = networkSchema.parse(r.body?.network);
        if (operation === "disable") {
          if (network !== "testnet")
            throw new TerminalHttpError(403, "Mainnet writes disabled");
        } else gate(network);
        const master = await account(user);
        if (operation === "prepare") s.json(await agent.prepare(user, master));
        else if (operation === "validate")
          s.json(
            await agent.validate(
              user,
              master,
              r.body?.approval as HlTerminalAgentApproval,
            ),
          );
        else if (operation === "confirm")
          s.json(
            await agent.confirm(
              user,
              master,
              r.body?.approval as HlTerminalAgentApproval,
            ),
          );
        else if (operation === "disable")
          s.json(
            await agent.disable(
              user,
              master,
              z.string().uuid().parse(r.body?.id),
            ),
          );
        else {
          const packet = bound(user, r.body?.packet);
          gate(packet.network);
          s.json(await agent.execute(user, master, packet));
        }
      }),
    );
  }
  router.get(
    "/status",
    handler(async (r, s, user) => {
      const network = networkSchema.parse(r.query.network);
      if (r.query.coin && r.query.coin !== "BTC")
        throw new TerminalHttpError(400, "Only native BTC supported");
      const connection = await getConnection(user);
      s.json({
        network,
        writesEnabled: network === "testnet" && enabled(),
        snapshot: connection ? await read(user, network) : null,
      });
    }),
  );
  router.post(
    "/preview",
    handler(async (r, s, user) => {
      const network = networkSchema.parse(r.body?.network);
      gate(network);
      const kind = z
          .enum(["order", "settings", "close", "cancel", "amend", "protection"])
          .parse(r.body?.kind),
        snapshot = await read(user, network, true),
        p = previewTerminalAction(
          snapshot,
          { network, coin: r.body.coin, kind, input: r.body.input },
          Date.now(),
        );
      p.seal = seal(user, p);
      for (const [id, old] of packets)
        if (old.packet.createdAt < Date.now() - 1800000) packets.delete(id);
      if (packets.size >= 1000)
        throw new TerminalHttpError(
          429,
          "Prepared packet capacity exceeded; wait for expiry",
        );
      packets.set(p.id, { user, packet: structuredClone(p) });
      s.json(p);
    }),
  );
  router.post(
    "/validate",
    handler(async (r, s, user) => {
      const p = bound(user, r.body?.packet);
      gate(p.network);
      const snapshot = await read(user, p.network, true);
      validateTerminalAuthorization(p, snapshot, Date.now());
      s.json({ network: p.network, valid: true, snapshot });
    }),
  );
  router.get(
    "/reconcile",
    handler(async (r, s, user) => {
      const network = networkSchema.parse(r.query.network),
        master = await account(user);
      let ids =
        typeof r.query.ids === "string" && r.query.ids
          ? r.query.ids.split(",")
          : [];
      if (
        ids.length > 8 ||
        ids.some((id) => !/^0x[0-9a-f]{32}$/.test(id) && !/^\d+$/.test(id))
      )
        throw new TerminalHttpError(400, "Invalid bounded order identifiers");
      let record: { user: string; packet: HlTerminalPacket } | undefined;
      if (r.query.packetId) {
        record = packets.get(String(r.query.packetId));
        if (
          record &&
          (record.user !== user ||
            record.packet.account !== master ||
            record.packet.network !== network)
        )
          throw new TerminalHttpError(
            409,
            "Reconciliation packet scope unavailable",
          );
      }
      const durable = r.query.packetId
        ? await agent.getExecution(user, master, String(r.query.packetId))
        : null;
      if (durable) {
        if (network !== "testnet")
          throw new TerminalHttpError(409, "Durable packet network mismatch");
        record = { user, packet: durable.packet };
        ids = [...new Set([...ids, ...terminalExecutionIds(durable.packet)])];
        if (ids.length > 8)
          throw new TerminalHttpError(
            400,
            "Too many reconciliation identifiers",
          );
      }
      const [snapshot, orders] = await Promise.all([
        read(user, network, true),
        Promise.all(
          ids.map(async (id) => ({
            id,
            ...(await providers[network].order(master, id)),
          })),
        ),
      ]);
      s.json({
        network,
        snapshot,
        orders,
        ...(durable
          ? {
              agentExecution: await agent.reconcile(
                user,
                master,
                durable.packet_id,
                snapshot,
                orders,
              ),
            }
          : {}),
        ...(record?.packet.action.type === "updateLeverage"
          ? {
              settingsConfirmed:
                snapshot.leverage === record.packet.action.leverage &&
                snapshot.marginType ===
                  (record.packet.action.isCross ? "cross" : "isolated"),
            }
          : {}),
      });
    }),
  );
  router.get(
    "/history",
    handler(async (r, s, user) => {
      const network = networkSchema.parse(r.query.network),
        master = await account(user),
        history = await providers[network].history(master);
      if (
        history.network !== network ||
        history.account.toLowerCase() !== master
      )
        throw new TerminalHttpError(409, "Provider history scope mismatch");
      s.json(history);
    }),
  );
  return router;
}
