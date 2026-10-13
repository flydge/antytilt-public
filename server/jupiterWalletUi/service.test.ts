import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Transaction } from '@solana/web3.js'
import { fixture } from '../jupiterCloseTicket/testFixture.js'
const implementation: any = await import('./service.js').catch(() => ({}))
test('public ticket never contains encrypted authority or reusable signed bytes', () => {
  assert.equal(
    typeof implementation.publicTicket,
    'function',
    'safe ticket projection missing',
  )
  const { owner, prepared } = fixture(),
    tx = Transaction.from(Buffer.from(prepared.unsignedPacket, 'base64'))
  tx.sign(owner)
  const t = {
    id: 'test',
    prepared,
    ciphertext: 'private ciphertext',
    signature: 'public submission signature',
    packetHash: 'hash',
    status: 'ARMED',
    intentAt: null,
    intentEvent: null,
    detail: null,
  }
  const output = JSON.stringify(
    implementation.publicTicket(t, {
      expiresAt: '2026-10-13T00:00:00Z',
      reviewHash: 'review',
    }),
  )
  assert.ok(!output.includes('private ciphertext'))
  assert.ok(!output.includes(tx.serialize().toString('base64')))
  assert.ok(!output.includes(prepared.unsignedPacket))
  assert.equal(JSON.parse(output).status, 'ARMED')
  assert.equal(JSON.parse(output).recipient, prepared.binding.recipient)
})
