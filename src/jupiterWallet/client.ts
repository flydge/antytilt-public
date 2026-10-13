export async function jupiterRequest<T>(
  path: string,
  csrf?: string,
  body?: unknown,
): Promise<T> {
  const response = await fetch('/api/jupiter' + path, {
    method: body === undefined ? 'GET' : 'POST',
    credentials: 'same-origin',
    cache: 'no-store',
    headers: {
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      ...(csrf ? { 'x-jupiter-csrf': csrf } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  })
  const value = await response
    .json()
    .catch(() => ({ error: 'Jupiter response unavailable' }))
  if (!response.ok)
    throw new Error(
      value.error ?? `Jupiter request failed (${response.status})`,
    )
  return value as T
}
