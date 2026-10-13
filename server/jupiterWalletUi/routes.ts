import express, { type Request } from 'express'
import { z } from 'zod'
import { applicationDatabasePool } from '../postgres.js'
import {
  PacketVault,
  privateExternalFile,
} from '../jupiterCloseTicket/vault.js'
import { TicketStore } from '../jupiterCloseTicket/store.js'
import { WalletUiService, type UiConfiguration } from './service.js'
import type { Scope } from './ownership.js'
const configSchema = z
  .object({
    rpc: z.string().url(),
    genesis: z.string().min(32).max(44),
    trustedOrigin: z.string().url(),
    mode: z.enum(['native-rehearsal', 'live']),
    keyFile: z.string().min(1),
  })
  .strict()
let singleton: Promise<WalletUiService> | undefined
export function walletUiService() {
  singleton ??= (async () => {
    const configPath = process.env.JUPITER_UI_CONFIG
    if (!configPath)
      throw Object.assign(
        new Error(
          'Jupiter wallet integration is not configured on this server',
        ),
        { status: 503 },
      )
    const config = configSchema.parse(
      JSON.parse(privateExternalFile(configPath, process.cwd()).toString()),
    ) as UiConfiguration
    // The mode and RPC are server configuration; never accepted from HTTP.
    if (
      config.mode === 'live' &&
      config.genesis !== '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d'
    )
      throw new Error('Live UI requires mainnet genesis')
    const pool = await applicationDatabasePool(),
      store = new TicketStore(
        pool,
        new PacketVault(config.keyFile, process.cwd()),
      )
    return new WalletUiService(pool, store, config)
  })()
  return singleton
}
const uuid = z.string().uuid(),
  consent = z.literal(true),
  packet = z
    .string()
    .min(1)
    .max(1644)
    .regex(/^[A-Za-z0-9+/]+={0,2}$/)
const prepare = z
  .object({
    clientRequestId: uuid,
    position: z.string().min(32).max(44),
    floorUsd: z.string().max(32),
    maxFeeSol: z.string().max(32),
    maxRentSol: z.string().max(32),
    expiresMinutes: z.number().int().min(1).max(60),
  })
  .strict()
export function walletUiRouter(
  requireScope: (request: Request, origin: string) => Promise<Scope>,
) {
  const router = express.Router()
  router.use((_req, res, next) => {
    res.set('Cache-Control', 'no-store')
    next()
  })
  const handle =
    (
      mutating: boolean,
      fn: (s: WalletUiService, scope: Scope, req: Request) => Promise<unknown>,
    ) =>
    async (req: Request, res: express.Response) => {
      try {
        const service = await walletUiService()
        const scope = await requireScope(req, service.config.trustedOrigin)
        if (mutating) {
          if (req.get('origin') !== service.config.trustedOrigin)
            throw Object.assign(new Error('Exact request origin required'), {
              status: 403,
            })
          await service.ownership.requireMutation(
            scope,
            req.get('x-jupiter-csrf') ?? '',
          )
        }
        res.json(await fn(service, scope, req))
      } catch (error) {
        const e = error as { status?: number; code?: string; message?: string },
          status = error instanceof z.ZodError ? 400 : (e.status ?? 409)
        const message =
          e.code === '23505'
            ? 'This position or nonce already has a reserved ticket. Refresh saved tickets; revoke an unused nonce before preparing its replacement.'
            : /encrypted|authenticate data|integrity mismatch/i.test(
                  e.message ?? '',
                )
              ? 'Saved authority could not be verified. Signing and submission are blocked; preserve the existing state.'
              : (e.message ?? 'Jupiter action refused')
        // Do not attach causes, packet bodies, DB parameters or RPC payloads.
        res.status(status).json({
          error:
            error instanceof z.ZodError
              ? 'Invalid Jupiter request'
              : status >= 500
                ? 'Jupiter integration unavailable'
                : message,
          code: e.code,
        })
      }
    }
  router.get(
    '/wallet/session',
    handle(false, (s, c) => s.session(c)),
  )
  router.post(
    '/wallet/challenge',
    handle(true, (s, c, r) =>
      s.ownership.challenge(
        c,
        z
          .object({ owner: z.string().min(32).max(44) })
          .strict()
          .parse(r.body).owner,
      ),
    ),
  )
  router.post(
    '/wallet/verify',
    handle(true, async (s, c, r) => {
      const b = z
        .object({ id: uuid, signature: z.string().max(88) })
        .strict()
        .parse(r.body)
      await s.ownership.verify(c, b.id, b.signature)
      return s.session(c)
    }),
  )
  router.post(
    '/wallet/disconnect',
    handle(true, async (s, c, r) => {
      z.object({}).strict().parse(r.body)
      await s.ownership.disconnect(c)
      return s.session(c)
    }),
  )
  router.get(
    '/positions',
    handle(false, (s, c) => s.positions(c)),
  )
  router.get(
    '/budget',
    handle(false, (s, c) => s.budget(c)),
  )
  router.get(
    '/setup',
    handle(false, (s, c) => s.setup(c)),
  )
  router.post(
    '/setup/prepare',
    handle(true, (s, c, r) => {
      z.object({}).strict().parse(r.body)
      return s.prepareAction(c, 'SETUP')
    }),
  )
  router.post(
    '/actions/:id/submit',
    handle(true, (s, c, r) => {
      const b = z
          .object({ packet, reviewHash: z.string().length(64), consent })
          .strict()
          .parse(r.body),
        bytes = Buffer.from(b.packet, 'base64')
      if (bytes.toString('base64') !== b.packet)
        throw new Error('Canonical packet required')
      return s.submitAction(c, uuid.parse(r.params.id), bytes, b.reviewHash)
    }),
  )
  router.get(
    '/actions/:id',
    handle(false, (s, c, r) => s.actionStatus(c, uuid.parse(r.params.id))),
  )
  router.get(
    '/tickets',
    handle(false, (s, c) => s.list(c)),
  )
  router.post(
    '/tickets/prepare',
    handle(true, (s, c, r) => s.prepare(c, prepare.parse(r.body))),
  )
  router.get(
    '/tickets/:id',
    handle(false, (s, c, r) => s.detail(c, uuid.parse(r.params.id))),
  )
  router.get(
    '/tickets/:id/signing-message',
    handle(false, (s, c, r) => s.signingMessage(c, uuid.parse(r.params.id))),
  )
  router.post(
    '/tickets/:id/arm',
    handle(true, (s, c, r) => {
      const b = z
        .object({ packet, reviewHash: z.string().length(64), consent })
        .strict()
        .parse(r.body)
      return s.arm(
        c,
        uuid.parse(r.params.id),
        Buffer.from(b.packet, 'base64'),
        b.reviewHash,
      )
    }),
  )
  router.post(
    '/tickets/:id/trigger',
    handle(true, (s, c, r) => {
      const b = z
        .object({ reviewHash: z.string().length(64), consent })
        .strict()
        .parse(r.body)
      return s.trigger(c, uuid.parse(r.params.id), b.reviewHash)
    }),
  )
  for (const name of ['reconcile', 'disable', 'confirm-revoke'] as const)
    router.post(
      '/tickets/:id/' + name,
      handle(true, (s, c, r) => {
        z.object({ consent }).strict().parse(r.body)
        const id = uuid.parse(r.params.id)
        return name === 'reconcile'
          ? s.reconcile(c, id)
          : name === 'disable'
            ? s.disable(c, id)
            : s.confirmRevoke(c, id)
      }),
    )
  router.post(
    '/tickets/:id/revoke/prepare',
    handle(true, (s, c, r) => {
      z.object({}).strict().parse(r.body)
      return s.prepareAction(c, 'REVOKE', uuid.parse(r.params.id))
    }),
  )
  return router
}
