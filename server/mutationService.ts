import { createHash } from 'node:crypto'
import {
  beginTradingMutation,
  completeTradingMutation,
  failTradingMutation,
  type TradingMutation,
} from './database'

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue)
  if (!value || typeof value !== 'object') return value
  return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, entry]) => [key, stableValue(entry)]))
}

function requestHash(value: unknown) {
  return createHash('sha256').update(JSON.stringify(stableValue(value))).digest('hex')
}

function persistedMutationError(mutation: TradingMutation) {
  const metadata = mutation.error ?? {}
  const uncertain = mutation.status === 'UNCERTAIN' || mutation.status === 'PENDING'
  const message = uncertain
    ? 'The previous trading request may already have reached the exchange. Automatic retry is blocked until reconciliation completes.'
    : typeof metadata.message === 'string' ? metadata.message : 'The previous trading request failed.'
  return Object.assign(new Error(message), {
    status: uncertain ? 409 : typeof metadata.status === 'number' ? metadata.status : 409,
    code: uncertain ? 'MUTATION_RECONCILIATION_REQUIRED' : metadata.code,
    details: {
      operation: mutation.operation,
      requestId: mutation.requestId,
      mutationStatus: mutation.status,
      originalError: metadata.message,
    },
  })
}

function serializedError(error: unknown) {
  const typed = error as Error & { status?: number; code?: string; details?: unknown }
  return {
    name: typed instanceof Error ? typed.name : 'Error',
    message: typed instanceof Error ? typed.message : 'Unknown trading mutation error',
    status: typeof typed.status === 'number' ? typed.status : undefined,
    code: typeof typed.code === 'string' ? typed.code : undefined,
    details: typed.details,
  }
}

function mayBeUncertain(error: unknown) {
  return error instanceof TypeError
    || (error instanceof Error && ['TimeoutError', 'AbortError'].includes(error.name))
}

export async function executeDurableTradingMutation<T>(input: {
  userId: string
  exchangeAccountId: string
  operation: string
  requestId: string
  requestPayload: unknown
  execute: () => Promise<T>
  exchangeOrderId?: (result: T) => string | undefined
}): Promise<{ result: T; replayed: boolean }> {
  const started = await beginTradingMutation({
    userId: input.userId,
    exchangeAccountId: input.exchangeAccountId,
    operation: input.operation,
    requestId: input.requestId,
    requestHash: requestHash(input.requestPayload),
  })
  if (!started.created) {
    if (started.mutation.status === 'SUCCEEDED') {
      return { result: started.mutation.response as T, replayed: true }
    }
    throw persistedMutationError(started.mutation)
  }

  let result: T
  try {
    result = await input.execute()
  } catch (error) {
    await failTradingMutation({
      userId: input.userId,
      exchangeAccountId: input.exchangeAccountId,
      operation: input.operation,
      requestId: input.requestId,
      error: serializedError(error),
      uncertain: mayBeUncertain(error),
    }).catch(() => undefined)
    throw error
  }

  const exchangeOrderId = input.exchangeOrderId?.(result)
  try {
    await completeTradingMutation({
      userId: input.userId,
      exchangeAccountId: input.exchangeAccountId,
      operation: input.operation,
      requestId: input.requestId,
      response: result,
      exchangeOrderId,
    })
  } catch (error) {
    await failTradingMutation({
      userId: input.userId,
      exchangeAccountId: input.exchangeAccountId,
      operation: input.operation,
      requestId: input.requestId,
      error: {
        ...serializedError(error),
        message: 'The exchange operation returned, but its result could not be persisted.',
      },
      uncertain: true,
      exchangeOrderId,
    }).catch(() => undefined)
    throw Object.assign(new Error('The exchange operation may have succeeded, but its result could not be persisted. Do not retry with a new request ID until account reconciliation completes.'), {
      status: 409,
      code: 'MUTATION_RESULT_NOT_PERSISTED',
    })
  }
  return { result, replayed: false }
}
