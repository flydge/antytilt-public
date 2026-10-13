import type { Candle } from '../types'

export async function fetchJson<T>(url: string, signal: AbortSignal, headers?: HeadersInit): Promise<T> {
  const response = await fetch(url, { signal, headers })
  if (!response.ok) throw new Error(`Market data request failed (${response.status})`)
  return response.json() as Promise<T>
}

export function sortedCandles(rows: Array<Candle | null>, descending = false) {
  const candles = rows.filter((row): row is Candle => Boolean(row))
  if (descending) candles.reverse()
  return candles.sort((left, right) => left.time - right.time)
}

export function safeRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

export async function decodeWebSocketData(data: unknown) {
  if (typeof data === 'string') return data
  let buffer: ArrayBuffer | null = null
  if (data instanceof Blob) buffer = await data.arrayBuffer()
  else if (data instanceof ArrayBuffer) buffer = data
  else if (ArrayBuffer.isView(data)) {
    const bytes = new Uint8Array(data.byteLength)
    bytes.set(new Uint8Array(data.buffer, data.byteOffset, data.byteLength))
    buffer = bytes.buffer
  }
  if (!buffer) return ''
  try {
    const stream = new Blob([buffer]).stream().pipeThrough(new DecompressionStream('gzip'))
    return await new Response(stream).text()
  } catch {
    return new TextDecoder().decode(buffer)
  }
}

export function createSubscriptionId() {
  return typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `antytilt-${Date.now()}-${Math.random().toString(16).slice(2)}`
}
