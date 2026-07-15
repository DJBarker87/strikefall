import { sha256Hex } from './crypto'

function encodeCanonical(value: unknown, seen: WeakSet<object>): string | undefined {
  if (value === null) return 'null'

  switch (typeof value) {
    case 'boolean':
      return value ? 'true' : 'false'
    case 'string':
      return JSON.stringify(value)
    case 'number':
      if (!Number.isFinite(value)) throw new TypeError('Canonical JSON rejects non-finite numbers')
      return Object.is(value, -0) ? '0' : JSON.stringify(value)
    case 'undefined':
    case 'function':
    case 'symbol':
      return undefined
    case 'bigint':
      throw new TypeError('Canonical JSON rejects bigint values')
    case 'object':
      break
  }

  const object = value as object
  if (seen.has(object)) throw new TypeError('Canonical JSON rejects circular values')
  seen.add(object)

  try {
    if (Array.isArray(value)) {
      return `[${value
        .map((entry) => encodeCanonical(entry, seen) ?? 'null')
        .join(',')}]`
    }

    const record = value as Record<string, unknown>
    const fields = Object.keys(record)
      .sort()
      .flatMap((key) => {
        const encoded = encodeCanonical(record[key], seen)
        return encoded === undefined ? [] : [`${JSON.stringify(key)}:${encoded}`]
      })
    return `{${fields.join(',')}}`
  } finally {
    seen.delete(object)
  }
}

/** Stable, key-sorted JSON used as the only digest input representation. */
export function canonicalStringify(value: unknown): string {
  const encoded = encodeCanonical(value, new WeakSet())
  if (encoded === undefined) throw new TypeError('Value has no canonical JSON representation')
  return encoded
}

export async function canonicalDigest(value: unknown): Promise<string> {
  return sha256Hex(canonicalStringify(value))
}
