import { randomBytes } from 'node:crypto'
import { realpathSync, statSync, writeFileSync } from 'node:fs'
import { dirname, relative, resolve } from 'node:path'
import { Pool } from 'pg'
import {
  PacketVault,
  privateExternalFile,
} from '../server/jupiterCloseTicket/vault.js'
import { TicketStore } from '../server/jupiterCloseTicket/store.js'
import {
  JupiterReader,
  ReadOnlyRpc,
} from '../server/jupiterCloseTicket/reader.js'
import { PROGRAM, IDL_SHA } from '../server/jupiterCloseTicket/builder.js'
import { OperatorError } from '../server/jupiterCloseTicket/types.js'
import { BindingInvalidation } from '../server/jupiterCloseTicket/reader.js'
import {
  CloseTicketBot,
  LocalOnlySender,
  ProtectedPublicSender,
} from '../server/jupiterCloseTicket/bot.js'
const usage =
  'jupiter:ticket <init-key|prepare|arm|status|trigger|reconcile|disable|confirm-revoke> --config PRIVATE_FILE [--binding FILE --unsigned FILE | --id ID --packet PRIVATE_FILE | --id ID --event EVENT --local-test | --id ID --event EVENT --live-envelope PRIVATE_FILE | --id ID --keeper-signature SIGNATURE --payout-signature SIGNATURE]'
const [command, ...args] = process.argv.slice(2)
if (!command || command === 'help' || command === '--help') {
  console.log(usage)
  process.exit(0)
}
let pool: Pool | undefined
function outputPath(value: string) {
  const path = resolve(value),
    parent = realpathSync(dirname(path)),
    root = realpathSync(process.cwd()),
    rel = relative(root, parent)
  if (
    rel === '' ||
    (rel !== '..' && !rel.startsWith('../') && !rel.startsWith('/')) ||
    (statSync(parent).mode & 0o777) !== 0o700
  )
    throw new Error('Output requires private external directory')
  return path
}
try {
  const flags: Record<string, string> = {}
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--local-test') {
      flags['local-test'] = 'true'
      continue
    }
    if (
      !/^--[a-z-]+$/.test(args[i]) ||
      !args[i + 1] ||
      args[i + 1].startsWith('--') ||
      flags[args[i].slice(2)]
    )
      throw new Error('Invalid operator arguments')
    flags[args[i].slice(2)] = args[++i]
  }
  const known = [
    'config',
    'binding',
    'unsigned',
    'id',
    'packet',
    'event',
    'local-test',
    'live-envelope',
    'keeper-signature',
    'payout-signature',
    'key-file',
  ]
  if (Object.keys(flags).some((f) => !known.includes(f)))
    throw new Error('Unknown argument')
  if (command === 'init-key') {
    const path = outputPath(flags['key-file'])
    writeFileSync(path, randomBytes(32), { mode: 0o600, flag: 'wx' })
    console.log(JSON.stringify({ keyCreated: true }))
    process.exit(0)
  }
  if (
    ![
      'prepare',
      'arm',
      'status',
      'trigger',
      'reconcile',
      'disable',
      'confirm-revoke',
    ].includes(command) ||
    !flags.config
  )
    throw new Error('Command and config required')
  const config = JSON.parse(
    privateExternalFile(flags.config, process.cwd()).toString(),
  )
  if (
    Object.keys(config).some(
      (k) => !['rpc', 'database', 'keyFile'].includes(k),
    ) ||
    !config.rpc ||
    !config.database ||
    !config.keyFile
  )
    throw new Error(
      'RPC, isolated/selected PostgreSQL config and external vault key required',
    )
  // No dotenv, environment secrets, private owner keys or existing runtime config are read.
  if (
    !config.database.host ||
    !Number.isInteger(config.database.port) ||
    !config.database.user ||
    !config.database.database
  )
    throw new OperatorError(
      'DATABASE_CONFIG_REQUIRED',
      'Explicit selected database host, port, user and database required',
    )
  pool = new Pool({
    ...config.database,
    password: config.database.password ?? '',
    max: 4,
    connectionTimeoutMillis: 5000,
    application_name: 'antytilt-jupiter-close-ticket',
  })
  const store = new TicketStore(
    pool,
    new PacketVault(config.keyFile, process.cwd()),
  )
  await store.migrate()
  const reader = new JupiterReader(new ReadOnlyRpc(config.rpc))
  if (flags['local-test'] && flags['live-envelope'])
    throw new Error('Select one reviewed sender')
  const sender = flags['local-test']
    ? new LocalOnlySender(config.rpc, true)
    : flags['live-envelope']
      ? new ProtectedPublicSender(
          config.rpc,
          JSON.parse(
            privateExternalFile(
              flags['live-envelope'],
              process.cwd(),
            ).toString(),
          ),
        )
      : undefined
  const bot = new CloseTicketBot(store, reader, sender)
  let ticket
  if (command === 'prepare') {
    if (!flags.binding || !flags.unsigned)
      throw new Error('Binding and unsigned output required')
    const input = JSON.parse(
      privateExternalFile(flags.binding, process.cwd()).toString(),
    )
    const allowed = [
      'genesis',
      'owner',
      'position',
      'pool',
      'custody',
      'collateralCustody',
      'side',
      'mint',
      'recipient',
      'nonce',
      'nonceAuthority',
      'nonceValue',
      'counter',
      'absolutePriceBound',
      'maxFeeLamports',
      'maxRentLamports',
      'triggerEvent',
      'programDeployment',
    ]
    if (
      Object.keys(input).some((f) => !allowed.includes(f)) ||
      allowed.some((f) => input[f] === undefined)
    )
      throw new Error(
        'Exact public binding fields required; private keys forbidden',
      )
    const unsignedPath = outputPath(flags.unsigned),
      prepared = await reader.prepare(input)
    ticket = await store.create(prepared)
    writeFileSync(
      unsignedPath,
      Buffer.from(prepared.unsignedPacket, 'base64'),
      { mode: 0o600, flag: 'wx' },
    )
  } else {
    if (!flags.id) throw new Error('Ticket ID required')
    if (command === 'status') ticket = await store.get(flags.id)
    if (command === 'arm') {
      if (!flags.packet) throw new Error('Signed packet private file required')
      ticket = await bot.arm(
        flags.id,
        privateExternalFile(flags.packet, process.cwd(), 1232),
      )
    }
    if (command === 'trigger') {
      if (!flags.event) throw new Error('Exact approved trigger event required')
      ticket = await bot.trigger(flags.id, flags.event)
    }
    if (command === 'reconcile')
      ticket = await bot.reconcile(
        flags.id,
        flags['keeper-signature'],
        flags['payout-signature'],
      )
    if (command === 'disable') ticket = await bot.disable(flags.id)
    if (command === 'confirm-revoke') ticket = await bot.confirmRevoke(flags.id)
  }
  if (ticket)
    console.log(
      JSON.stringify({
        id: ticket.id,
        status: ticket.status,
        messageHash: ticket.prepared.messageHash,
        binding: ticket.prepared.binding,
        program: PROGRAM.toBase58(),
        idlSha256: IDL_SHA,
        packetHash: ticket.packetHash || null,
        signature: ticket.signature || null,
        request: ticket.prepared.request,
        intentAt: ticket.intentAt,
        detail: ticket.detail,
        publicSenderDefaultDisabled: true,
      }),
    )
} catch (error) {
  const code =
    error instanceof BindingInvalidation
      ? error.reason
      : error instanceof OperatorError
        ? error.code
        : command === 'arm'
          ? 'ARM_REFUSED'
          : command === 'prepare'
            ? 'PREPARE_REFUSED'
            : command === 'reconcile'
              ? 'RECONCILIATION_UNAVAILABLE'
              : 'COMMAND_REFUSED'
  const reason =
    error instanceof OperatorError
      ? error.message
      : error instanceof BindingInvalidation
        ? 'Finalized binding changed; ticket invalidated'
        : 'Check command, private files, current RPC coverage and exact approved bindings; no blind retry after send intent'
  console.error(JSON.stringify({ code, reason, signedPacketLogged: false }))
  process.exitCode = 1
} finally {
  await pool?.end()
}
