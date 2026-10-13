import assert from 'node:assert/strict'
import bs58 from 'bs58'
import { test } from 'node:test'
const bot: any = await import('./bot.js').catch(() => ({}))
test('failed simulation and wrong trigger cannot persist intent or invoke send', async () => {
  assert.equal(typeof bot.CloseTicketBot, 'function', 'trigger bot missing')
  let intents = 0,
    sends = 0
  const ticket = {
    status: 'ARMED',
    id: 'a',
    prepared: { binding: { triggerEvent: 'event' } },
  }
  const store = {
    get: async () => ticket,
    packet: () => Buffer.from('test'),
    claim: async () => {
      intents++
      return ticket
    },
  }
  const reader = {
    validateCurrent: async () => {},
    simulate: async () => {
      throw new Error('Simulation failed')
    },
  }
  const sender = {
    send: async () => {
      sends++
      throw new Error('unreachable')
    },
  }
  const b = new bot.CloseTicketBot(store, reader, sender)
  await assert.rejects(() => b.trigger('a', 'wrong'), /trigger/i)
  await assert.rejects(() => b.trigger('a', 'event'), /Simulation/)
  assert.equal(intents, 0)
  assert.equal(sends, 0)
})
test('persisted pending/unknown/consumed/disabled state never resends after restart', async () => {
  assert.equal(typeof bot.CloseTicketBot, 'function', 'trigger bot missing')
  let sends = 0
  for (const status of [
    'SUBMITTING',
    'UNKNOWN',
    'REQUEST_PENDING',
    'FAILED_CONSUMED',
    'DISABLED',
    'REVOKED',
    'INVALIDATED',
    'CLOSED',
  ]) {
    const store = {
      get: async () => ({ status }),
      packet: () => {
        throw new Error('must not read packet')
      },
    }
    await assert.rejects(
      () =>
        new bot.CloseTicketBot(
          store,
          {},
          {
            send: async () => {
              sends++
            },
          },
        ).trigger('a', 'event'),
      /armed/i,
    )
  }
  assert.equal(sends, 0)
})
test('disabled sender rejects before persisted intent and leaves armed state', async () => {
  let intents = 0
  const store = {
    get: async () => ({
      status: 'ARMED',
      prepared: { binding: { triggerEvent: 'event' } },
    }),
    packet: () => Buffer.from('test'),
    claim: async () => {
      intents++
      return { signature: 'fake' }
    },
  }
  const reader = { validateCurrent: async () => {}, simulate: async () => {} }
  await assert.rejects(
    () =>
      new bot.CloseTicketBot(
        store,
        reader,
        new bot.LocalOnlySender('http://127.0.0.1:18999'),
      ).trigger('a', 'event'),
    /disabled/i,
  )
  assert.equal(intents, 0)
})
test('protected public sender rejects missing/mismatched/expired envelope before transport and allows exact synthetic transport', async () => {
  assert.equal(
    typeof bot.ProtectedPublicSender,
    'function',
    'protected public sender missing',
  )
  const { fixture } = await import('./testFixture.js'),
    { Transaction } = await import('@solana/web3.js'),
    { validateSignedPacket } = await import('./builder.js')
  const f = fixture(),
    tx = Transaction.from(Buffer.from(f.prepared.unsignedPacket, 'base64'))
  tx.sign(f.owner)
  const packet = tx.serialize(),
    r = validateSignedPacket(f.prepared, packet)
  const ticket = { id: 'ticket-a', prepared: f.prepared, ...r },
    endpoint = 'https://api.mainnet-beta.solana.com'
  const e = {
    version: 1,
    kind: 'EXACT_REVIEWED_LIVE_CLOSE_TICKET',
    ticketId: ticket.id,
    messageHash: f.prepared.messageHash,
    packetHash: r.packetHash,
    signature: r.signature,
    endpoint,
    genesis: f.prepared.binding.genesis,
    triggerEvent: 'event',
    maxFeeLamports: '5000',
    maxRentLamports: '8000000',
    expiresAt: new Date(Date.now() + 60000).toISOString(),
    ownerApprovalReference: 'synthetic-test-only',
  }
  let calls = 0
  const transport = async (url: string, method: string, params: any[]) => {
    calls++
    assert.equal(url, endpoint)
    assert.equal(method, 'sendTransaction')
    assert.equal(params[0], packet.toString('base64'))
    assert.deepEqual(params[1], {
      encoding: 'base64',
      skipPreflight: false,
      preflightCommitment: 'finalized',
      maxRetries: 0,
    })
    return r.signature
  }
  for (const bad of [
    null,
    { ...e, packetHash: 'bad' },
    { ...e, maxFeeLamports: '9000' },
    { ...e, expiresAt: '2020-01-01T00:00:00Z' },
    { ...e, triggerEvent: 'other' },
  ]) {
    await assert.rejects(async () =>
      new bot.ProtectedPublicSender(endpoint, bad, transport).authorize(ticket),
    )
  }
  assert.equal(calls, 0)
  const sender = new bot.ProtectedPublicSender(endpoint, e, transport)
  sender.authorize(ticket)
  await sender.send(packet, r.signature)
  assert.equal(calls, 1)
})
test('definitive target change persists invalidation while transport uncertainty leaves armed', async () => {
  const { BindingInvalidation } = await import('./reader.js')
  assert.equal(
    typeof BindingInvalidation,
    'function',
    'typed binding invalidation missing',
  )
  for (const definitive of [true, false]) {
    let status = 'ARMED'
    const store = {
      get: async () => ({
        status,
        id: 'a',
        prepared: { binding: { triggerEvent: 'event' } },
      }),
      packet: () => Buffer.from('test'),
      transition: async (_id: string, to: string) => {
        status = to
        return { status }
      },
    }
    const r = {
      validateCurrent: async () => {
        throw definitive
          ? new BindingInvalidation('TARGET_CHANGED')
          : new Error('Transport unavailable')
      },
    }
    await assert.rejects(() =>
      new bot.CloseTicketBot(store, r, {
        enabled: true,
        send: async () => {
          throw new Error('must not send')
        },
      }).trigger('a', 'event'),
    )
    assert.equal(status, definitive ? 'INVALIDATED' : 'ARMED')
  }
})
test('keeper cancel and close-before-decrease instruction appearance cannot prove closure', async () => {
  const { fixture } = await import('./testFixture.js'),
    { Transaction, TransactionInstruction, PublicKey } =
      await import('@solana/web3.js'),
    { idl, PROGRAM, discriminator } = await import('./builder.js')
  const f = fixture(),
    b = f.prepared.binding,
    t = { prepared: f.prepared }
  const key = (n: number) => new PublicKey(Buffer.alloc(32, n)),
    keeper = key(15)
  function instruction(name: string) {
    const d = idl.instructions.find((i: any) => i.name === name)
    const vals: any = {
      keeper: keeper.toBase58(),
      owner: b.owner,
      pool: b.pool,
      position: b.position,
      positionRequest: f.prepared.request,
      positionRequestAta: f.prepared.requestAta,
      custody: b.custody,
      collateralCustody: b.collateralCustody,
      mint: b.mint,
      ownerAta: b.recipient,
      tokenProgram: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
    }
    return new TransactionInstruction({
      programId: PROGRAM,
      keys: d.accounts.map((a: any) => ({
        pubkey: new PublicKey(vals[a.name] ?? key(16).toBase58()),
        isSigner: a.isSigner,
        isWritable: a.isMut,
      })),
      data: discriminator(
        'global',
        name.replace(/[A-Z]/g, (s: string) => '_' + s.toLowerCase()),
      ),
    })
  }
  const tx = new Transaction({
    feePayer: keeper,
    recentBlockhash: b.nonceValue,
  })
  tx.add(instruction('closePositionRequest2'))
  let wire = tx
      .serialize({ requireAllSignatures: false, verifySignatures: false })
      .toString('base64'),
    index = tx
      .compileMessage()
      .accountKeys.findIndex((k) => k.toBase58() === b.recipient)
  const balances = (amount: string) => [
    {
      accountIndex: index,
      mint: b.mint,
      owner: b.owner,
      uiTokenAmount: { amount },
    },
  ]
  const meta = {
    err: null,
    preTokenBalances: balances('0'),
    postTokenBalances: balances('5000'),
  }
  assert.equal(
    bot.keeperProof(t, { transaction: [wire, 'base64'], meta }),
    false,
  )
  tx.add(instruction('decreasePosition4'))
  wire = tx
    .serialize({ requireAllSignatures: false, verifySignatures: false })
    .toString('base64')
  index = tx
    .compileMessage()
    .accountKeys.findIndex((k) => k.toBase58() === b.recipient)
  assert.equal(
    bot.keeperProof(t, {
      transaction: [wire, 'base64'],
      meta: {
        err: null,
        preTokenBalances: balances('0'),
        postTokenBalances: balances('5000'),
        innerInstructions: [
          {
            index: 0,
            instructions: [
              {
                programIdIndex: tx
                  .compileMessage()
                  .accountKeys.findIndex(
                    (k) =>
                      k.toBase58() ===
                      'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
                  ),
                accounts: [
                  f.prepared.requestAta,
                  b.recipient,
                  f.prepared.request,
                ].map((k) =>
                  tx
                    .compileMessage()
                    .accountKeys.findIndex((p) => p.toBase58() === k),
                ),
                data: bs58.encode(Buffer.from('038813000000000000', 'hex')),
              },
            ],
          },
        ],
      },
    }),
    false,
  )
  const ix = tx.instructions[1],
    def = idl.instructions.find((i: any) => i.name === 'decreasePosition4')
  ix.keys[
    def.accounts.findIndex((a: any) => a.name === 'positionRequest')
  ].pubkey = key(17)
  const wrong = tx
    .serialize({ requireAllSignatures: false, verifySignatures: false })
    .toString('base64')
  assert.equal(
    bot.keeperProof(t, { transaction: [wrong, 'base64'], meta }),
    false,
  )
})
test('arm validates owner signature and immutable message before sending packet to simulation RPC', async () => {
  const { fixture } = await import('./testFixture.js'),
    f = fixture()
  let reads = 0
  const store = {
      get: async () => ({ id: 'a', status: 'PREPARED', prepared: f.prepared }),
    },
    reader = {
      validateCurrent: async () => {
        reads++
      },
      simulate: async () => {
        reads++
      },
    }
  await assert.rejects(
    () =>
      new bot.CloseTicketBot(store, reader).arm(
        'a',
        Buffer.from(f.prepared.unsignedPacket, 'base64'),
      ),
    /signature/i,
  )
  assert.equal(reads, 0)
})
