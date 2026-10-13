import type { Ticket } from '../jupiterCloseTicket/types.js'
import type { ReadOnlyRpc } from '../jupiterCloseTicket/reader.js'
import { keeperProof } from '../jupiterCloseTicket/bot.js'
export async function discoverReceipts(
  ticket: Ticket,
  rpc: ReadOnlyRpc,
): Promise<{
  execution?: string
  payout?: string
  ordering?: Parameters<typeof keeperProof>[3]
}> {
  // No user-entered keeper signature. Strict proof decides; bounded gaps stay UNKNOWN.
  try {
    const [requests, atas] = await Promise.all(
      [ticket.prepared.request, ticket.prepared.requestAta].map((address) =>
        rpc.call('getSignaturesForAddress', [
          address,
          { limit: 12, commitment: 'finalized' },
        ]),
      ),
    )
    if (!Array.isArray(requests) || !Array.isArray(atas)) return {}
    const signatures = [
      ...new Set(
        [...requests, ...atas]
          .filter((r) => r.err === null && r.confirmationStatus === 'finalized')
          .map((r) => r.signature),
      ),
    ].slice(0, 16)
    const receipts = []
    for (const signature of signatures) {
      const tx = await rpc.call('getTransaction', [
        signature,
        {
          encoding: 'base64',
          commitment: 'finalized',
          maxSupportedTransactionVersion: 0,
        },
      ])
      if (tx) receipts.push({ signature, tx })
    }
    for (const execution of receipts)
      for (const payout of receipts) {
        let ordering: Parameters<typeof keeperProof>[3]
        if (execution !== payout && execution.tx.slot === payout.tx.slot) {
          const block = await rpc.call('getBlock', [
            execution.tx.slot,
            {
              commitment: 'finalized',
              transactionDetails: 'signatures',
              rewards: false,
              maxSupportedTransactionVersion: 0,
            },
          ])
          if (
            !Array.isArray(block?.signatures) ||
            block.signatures.length > 10000
          )
            continue
          const executionIndex = block.signatures.indexOf(execution.signature),
            payoutIndex = block.signatures.indexOf(payout.signature)
          if (executionIndex < 0 || payoutIndex <= executionIndex) continue
          ordering = {
            slot: execution.tx.slot,
            executionSignature: execution.signature,
            payoutSignature: payout.signature,
            executionIndex,
            payoutIndex,
          }
        }
        if (keeperProof(ticket, execution.tx, payout.tx, ordering))
          return {
            execution: execution.signature,
            ...(execution !== payout
              ? { payout: payout.signature, ordering }
              : {}),
          }
      }
  } catch {}
  return {}
}
