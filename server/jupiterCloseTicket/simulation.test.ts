import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createServer } from 'node:http'
import { Transaction } from '@solana/web3.js'
import { fixture } from './testFixture.js'
import { JupiterReader, ReadOnlyRpc } from './reader.js'
import { CloseTicketBot } from './bot.js'
import { validateSignedPacket } from './builder.js'

test('arm and pre-intent trigger RPC bodies carry only unsigned identical nonce message; post-claim sender receives exact owner-signed bytes', async () => {
  const f = fixture(),
    tx = Transaction.from(Buffer.from(f.prepared.unsignedPacket, 'base64'))
  tx.sign(f.owner)
  const packet = tx.serialize(),
    receipt = validateSignedPacket(f.prepared, packet),
    requests: any[] = []
  let status = 'PREPARED',
    claim = false,
    sent = false
  const server = createServer((req, res) => {
    let body = ''
    req.on('data', (c) => {
      body += c
    })
    req.on('end', () => {
      requests.push({ body, state: status, claim })
      res.setHeader('Content-Type', 'application/json')
      res.end(
        JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          result: { value: { err: null } },
        }),
      )
    })
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  try {
    const reader = new JupiterReader(
      new ReadOnlyRpc(`http://127.0.0.1:${(server.address() as any).port}`),
    )
    reader.validateCurrent = async () => {}
    const ticket = () => ({
      id: 'test',
      prepared: f.prepared,
      status,
      ...receipt,
      intentAt: null,
      intentEvent: null,
      detail: null,
      ciphertext: 'external-test-only',
    })
    const store: any = {
      get: async () => ticket(),
      packet: () => Buffer.from(packet),
      arm: async () => {
        status = 'ARMED'
        return ticket()
      },
      claim: async () => {
        claim = true
        status = 'SUBMITTING'
        return ticket()
      },
    }
    const sender: any = {
      enabled: true,
      send: async (raw: Buffer) => {
        assert.equal(claim, true)
        assert.ok(raw.equals(packet))
        assert.ok(Transaction.from(raw).verifySignatures(true))
        sent = true
      },
    }
    const bot = new CloseTicketBot(store, reader, sender)
    await bot.arm('test', packet)
    await bot.trigger('test', f.prepared.binding.triggerEvent)
    assert.equal(requests.length, 2)
    assert.equal(requests[0].state, 'PREPARED')
    assert.equal(requests[1].state, 'ARMED')
    assert.equal(sent, true)
    for (const captured of requests) {
      const wire = JSON.parse(captured.body),
        sim = Transaction.from(Buffer.from(wire.params[0], 'base64'))
      assert.equal(captured.claim, false)
      assert.equal(wire.method, 'simulateTransaction')
      assert.equal(wire.params[1].sigVerify, false)
      assert.equal(wire.params[1].replaceRecentBlockhash, false)
      assert.ok(sim.serializeMessage().equals(tx.serializeMessage()))
      assert.equal(sim.recentBlockhash, f.prepared.binding.nonceValue)
      assert.ok(sim.signatures.every((s) => s.signature === null))
      assert.equal(sim.verifySignatures(true), false)
      assert.ok(!captured.body.includes(packet.toString('base64')))
      assert.ok(!Buffer.from(wire.params[0], 'base64').includes(tx.signature!))
    }
  } finally {
    server.close()
  }
})
