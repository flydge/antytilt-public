import assert from 'node:assert/strict'
import bs58 from 'bs58'
import { test } from 'node:test'
import {
  PublicKey,
  Transaction,
  TransactionInstruction,
  AddressLookupTableAccount,
  TransactionMessage,
  VersionedTransaction,
} from '@solana/web3.js'
import { fixture } from './testFixture.js'
import { idl, PROGRAM, TOKEN, discriminator, encode } from './builder.js'
import { keeperProof } from './bot.js'
function receipt(
  f: ReturnType<typeof fixture>,
  name: string,
  slot: number,
  alt = true,
  payoutProof = true,
) {
  const b = f.prepared.binding,
    key = (n: number) => new PublicKey(Buffer.alloc(32, n)),
    keeper = key(15),
    d = idl.instructions.find((i: any) => i.name === name)
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
    tokenProgram: TOKEN.toBase58(),
    eventAuthority: PublicKey.findProgramAddressSync(
      [Buffer.from('__event_authority')],
      PROGRAM,
    )[0].toBase58(),
  }
  const ix = new TransactionInstruction({
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
  const addresses = [
      ...new Set(
        ix.keys.filter((k) => !k.isSigner).map((k) => k.pubkey.toBase58()),
      ),
    ].map((k) => new PublicKey(k)),
    table = new AddressLookupTableAccount({
      key: key(30),
      state: {
        deactivationSlot: 0xffffffffffffffffn,
        lastExtendedSlot: 0,
        lastExtendedSlotStartIndex: 0,
        authority: undefined,
        addresses,
      },
    })
  const message = new TransactionMessage({
      payerKey: keeper,
      recentBlockhash: b.nonceValue,
      instructions: [ix],
    }).compileToV0Message(alt ? [table] : []),
    loaded = { writable: [] as string[], readonly: [] as string[] }
  for (const l of message.addressTableLookups) {
    loaded.writable.push(
      ...l.writableIndexes.map((i) => addresses[i].toBase58()),
    )
    loaded.readonly.push(
      ...l.readonlyIndexes.map((i) => addresses[i].toBase58()),
    )
  }
  const keys = [
      ...message.staticAccountKeys.map((k) => k.toBase58()),
      ...loaded.writable,
      ...loaded.readonly,
    ],
    index = keys.indexOf(b.recipient),
    balances = (amount: string) => [
      {
        accountIndex: index,
        mint: b.mint,
        owner: b.owner,
        uiTokenAmount: { amount },
      },
    ]
  return {
    slot,
    transaction: [
      Buffer.from(new VersionedTransaction(message).serialize()).toString(
        'base64',
      ),
      'base64',
    ],
    meta: {
      err: null,
      loadedAddresses: loaded,
      preTokenBalances: balances('0'),
      postTokenBalances: balances('5000'),
      innerInstructions: payoutProof
        ? [
            {
              index: 0,
              instructions: [
                {
                  programIdIndex: keys.indexOf(TOKEN.toBase58()),
                  accounts: [
                    keys.indexOf(f.prepared.requestAta),
                    keys.indexOf(b.recipient),
                    keys.indexOf(f.prepared.request),
                  ],
                  data: bs58.encode(Buffer.from('038813000000000000', 'hex')),
                },
              ],
            },
          ]
        : [],
    },
  }
}
function withEvent(
  f: ReturnType<typeof fixture>,
  tx: ReturnType<typeof receipt>,
  name: 'DecreasePositionEvent' | 'ClosePositionRequestEvent',
  overrides: any = {},
) {
  const b = f.prepared.binding,
    fields = idl.events.find((e: any) => e.name === name).fields,
    defaults: any = {}
  for (const field of fields) {
    const type = field.type
    defaults[field.name] =
      typeof type === 'string'
        ? type === 'bool'
          ? false
          : type === 'publicKey'
            ? '11111111111111111111111111111111'
            : type === 'u8'
              ? 0
              : '0'
        : null
  }
  const common = { owner: b.owner, positionRequestKey: f.prepared.request },
    specific =
      name === 'DecreasePositionEvent'
        ? {
            positionKey: b.position,
            positionSide: 1,
            positionCustody: b.custody,
            positionCollateralCustody: b.collateralCustody,
            positionMint: b.mint,
            positionRequestMint: b.mint,
            positionRequestChange: 2,
            positionRequestType: 0,
            pool: b.pool,
            sizeUsdDelta: b.sizeUsd,
            positionOpenTime: b.openTime,
            priceSlippage: b.absolutePriceBound,
          }
        : {
            entirePosition: true,
            executed: true,
            requestChange: 2,
            requestType: 0,
            side: 1,
            mint: b.mint,
            amount: '5000',
          }
  const value = { ...defaults, ...common, ...specific, ...overrides },
    bytes = Buffer.concat([
      Buffer.from('e445a52e51cb9a1d', 'hex'),
      Buffer.from(
        name === 'DecreasePositionEvent'
          ? '409c2b4a6d83107f'
          : '15225c9ee01db4f3',
        'hex',
      ),
      ...fields.map((field: any) => encode(field.type, value[field.name])),
    ])
  const msg = VersionedTransaction.deserialize(
      Buffer.from(tx.transaction[0], 'base64'),
    ).message,
    keys = [
      ...msg.staticAccountKeys.map((k) => k.toBase58()),
      ...tx.meta.loadedAddresses.writable,
      ...tx.meta.loadedAddresses.readonly,
    ],
    authority = PublicKey.findProgramAddressSync(
      [Buffer.from('__event_authority')],
      PROGRAM,
    )[0].toBase58()
  const group = tx.meta.innerInstructions.find((g) => g.index === 0)
  const event = {
    programIdIndex: keys.indexOf(PROGRAM.toBase58()),
    accounts: [keys.indexOf(authority)],
    stackHeight: 2,
    data: bs58.encode(bytes),
  }
  if (group) group.instructions.push(event as any)
  else
    tx.meta.innerInstructions.push({ index: 0, instructions: [event as any] })
  return tx
}
test('separate v0/ALT reduction and payout receipts prove only their exact request and recipient', () => {
  const f = fixture(),
    t = { prepared: f.prepared } as any,
    reduce = withEvent(
      f,
      receipt(f, 'decreasePosition4', 21),
      'DecreasePositionEvent',
    ),
    pay = withEvent(
      f,
      receipt(f, 'closePositionRequest2', 22),
      'ClosePositionRequestEvent',
    )
  assert.equal(keeperProof(t, reduce, pay), true)
  assert.equal(keeperProof(t, pay, pay), false)
  assert.equal(keeperProof(t, reduce, { ...pay, slot: 20 }), false)
  assert.equal(
    keeperProof(t, reduce, {
      ...pay,
      meta: { ...pay.meta, err: { InstructionError: [0, 'Custom'] } },
    }),
    false,
  )
  assert.equal(
    keeperProof(t, reduce, {
      ...pay,
      meta: { ...pay.meta, loadedAddresses: { writable: [], readonly: [] } },
    }),
    false,
  )
  const wrong = fixture()
  assert.equal(
    keeperProof(t, reduce, receipt(wrong, 'closePositionRequest2', 22)),
    false,
  )
  assert.equal(
    keeperProof(t, reduce, {
      ...pay,
      meta: {
        ...pay.meta,
        postTokenBalances: pay.meta.postTokenBalances.map((p) => ({
          ...p,
          mint: '11111111111111111111111111111111',
        })),
      },
    }),
    false,
  )
})
test('same-slot split receipts require exact finalized block order and reject swapped or missing order', () => {
  const f=fixture(),t={prepared:f.prepared} as any
  const reduce=withEvent(f,receipt(f,'decreasePosition4',21),'DecreasePositionEvent'),pay=withEvent(f,receipt(f,'closePositionRequest2',21),'ClosePositionRequestEvent')
  // Synthetic event/ALT shape fixtures.
  for(const [tx,byte] of [[reduce,1],[pay,2]] as const){const packet=VersionedTransaction.deserialize(Buffer.from(tx.transaction[0],'base64'));packet.signatures[0].fill(byte);tx.transaction[0]=Buffer.from(packet.serialize()).toString('base64')}
  const signature=(tx:any)=>bs58.encode(VersionedTransaction.deserialize(Buffer.from(tx.transaction[0],'base64')).signatures[0])
  const ordering={slot:21,executionSignature:signature(reduce),payoutSignature:signature(pay),executionIndex:4,payoutIndex:5}
  assert.equal(keeperProof(t,reduce,pay),false)
  assert.equal(keeperProof(t,reduce,pay,ordering),true)
  for(const bad of [{...ordering,payoutIndex:3},{...ordering,executionIndex:-1},{...ordering,slot:22},{...ordering,payoutSignature:ordering.executionSignature},{...ordering,executionSignature:ordering.payoutSignature}])
    assert.equal(keeperProof(t,reduce,pay,bad),false)
})
test('positive recipient balance from unrelated transfers is not request payout evidence', () => {
  const f = fixture(),
    t = { prepared: f.prepared } as any,
    reduce = receipt(f, 'decreasePosition4', 21),
    pay = receipt(f, 'closePositionRequest2', 22, true, false)
  assert.equal(keeperProof(t, reduce, pay), false)
})
test('instruction presence and request ATA payout without actual reduction and executed-close events never prove closure', () => {
  const f = fixture(),
    t = { prepared: f.prepared } as any
  assert.equal(
    keeperProof(
      t,
      receipt(f, 'decreasePosition4', 21),
      receipt(f, 'closePositionRequest2', 22),
    ),
    false,
  )
})

test('actual Jupiter event evidence rejects zero/partial reduction, wrong lifecycle/request, unexecuted close and spoofed origin', () => {
  const f = fixture(),
    t = { prepared: f.prepared } as any
  const make = (decrease: any = {}, close: any = {}) => [
    withEvent(
      f,
      receipt(f, 'decreasePosition4', 21),
      'DecreasePositionEvent',
      decrease,
    ),
    withEvent(
      f,
      receipt(f, 'closePositionRequest2', 22),
      'ClosePositionRequestEvent',
      close,
    ),
  ]
  const [positiveDecrease, positiveClose] = make()
  assert.equal(keeperProof(t, positiveDecrease, positiveClose), true)
  for (const bad of [
    { sizeUsdDelta: '0' },
    { sizeUsdDelta: '1' },
    { positionOpenTime: '124' },
    { positionRequestKey: '11111111111111111111111111111111' },
    { owner: '11111111111111111111111111111111' },
    { positionRequestChange: 1 },
    { priceSlippage: '1' },
  ]) {
    const [d, c] = make(bad)
    assert.equal(keeperProof(t, d, c), false)
  }
  for (const bad of [
    { executed: false },
    { entirePosition: false },
    { amount: '0' },
    { amount: '4999' },
    { requestChange: 1 },
    { mint: '11111111111111111111111111111111' },
  ]) {
    const [d, c] = make({}, bad)
    assert.equal(keeperProof(t, d, c), false)
  }
  for (const field of ['programIdIndex', 'accounts', 'stackHeight']) {
    const [d, c] = make(),
      ix = d.meta.innerInstructions[0].instructions.at(-1)! as any
    ix[field] = field === 'accounts' ? [0] : field === 'stackHeight' ? 3 : 0
    assert.equal(keeperProof(t, d, c), false)
  }
  const [d, c] = make()
  c.meta.innerInstructions[0].index = 1
  assert.equal(keeperProof(t, d, c), false)
})

test('same transaction requires reduction before executed whole-position payout, with instruction-bound events', () => {
  const f = fixture(),
    b = f.prepared.binding,
    t = { prepared: f.prepared } as any
  function combined(reverse = false) {
    const receipts = [
      withEvent(
        f,
        receipt(f, 'decreasePosition4', 21),
        'DecreasePositionEvent',
      ),
      withEvent(
        f,
        receipt(f, 'closePositionRequest2', 21),
        'ClosePositionRequestEvent',
      ),
    ]
    if (reverse) receipts.reverse()
    const resolved = receipts.map((r) => {
      const m = VersionedTransaction.deserialize(
        Buffer.from(r.transaction[0], 'base64'),
      ).message
      return {
        receipt: r,
        m,
        keys: [
          ...m.staticAccountKeys.map((k) => k.toBase58()),
          ...r.meta.loadedAddresses.writable,
          ...r.meta.loadedAddresses.readonly,
        ],
      }
    })
    const tx = new Transaction({
      feePayer: new PublicKey(Buffer.alloc(32, 15)),
      recentBlockhash: b.nonceValue,
    })
    for (const r of resolved) {
      const ix = r.m.compiledInstructions[0]
      tx.add(
        new TransactionInstruction({
          programId: new PublicKey(r.keys[ix.programIdIndex]),
          keys: ix.accountKeyIndexes.map((i) => ({
            pubkey: new PublicKey(r.keys[i]),
            isSigner: r.m.isAccountSigner(i),
            isWritable: r.m.isAccountWritable(i),
          })),
          data: Buffer.from(ix.data),
        }),
      )
    }
    const keys = tx.compileMessage().accountKeys.map((k) => k.toBase58()),
      index = keys.indexOf(b.recipient),
      balance = (amount: string) => [
        {
          accountIndex: index,
          mint: b.mint,
          owner: b.owner,
          uiTokenAmount: { amount },
        },
      ]
    const groups = resolved.map((r, index) => ({
      index,
      instructions: r.receipt.meta.innerInstructions
        .flatMap((g) => g.instructions)
        .map((ix) => ({
          ...ix,
          programIdIndex: keys.indexOf(r.keys[ix.programIdIndex]),
          accounts: ix.accounts.map((i) => keys.indexOf(r.keys[i])),
        })),
    }))
    return {
      slot: 21,
      transaction: [
        tx
          .serialize({ requireAllSignatures: false, verifySignatures: false })
          .toString('base64'),
        'base64',
      ],
      meta: {
        err: null,
        preTokenBalances: balance('0'),
        postTokenBalances: balance('5000'),
        innerInstructions: groups,
      },
    }
  }
  assert.equal(keeperProof(t, combined()), true)
  assert.equal(keeperProof(t, combined(true)), false)
})
