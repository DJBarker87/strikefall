export interface SeededRng {
  next: () => number
  range: (min: number, max: number) => number
  int: (min: number, max: number) => number
  pick: <T>(items: readonly T[]) => T
  chance: (probability: number) => boolean
  normal: () => number
}

export function hashSeed(value: string): number {
  let hash = 2166136261
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index)
    hash = Math.imul(hash, 16777619)
  }
  hash += hash << 13
  hash ^= hash >>> 7
  hash += hash << 3
  hash ^= hash >>> 17
  hash += hash << 5
  return hash >>> 0
}

/**
 * Creates an explicit seed domain. Path generation and bot decisions use
 * different domains so a bot policy never needs the future-path stream.
 */
export function deriveSeed(seed: string, domain: string): string {
  return `${domain}:${hashSeed(`${domain}\u0000${seed}`).toString(36)}:${seed}`
}

export function createRng(seed: string): SeededRng {
  let state = hashSeed(seed)
  let spareNormal: number | null = null

  const next = () => {
    state += 0x6d2b79f5
    let value = state
    value = Math.imul(value ^ (value >>> 15), value | 1)
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61)
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296
  }

  const normal = () => {
    if (spareNormal !== null) {
      const value = spareNormal
      spareNormal = null
      return value
    }

    const first = Math.max(next(), Number.EPSILON)
    const second = next()
    const magnitude = Math.sqrt(-2 * Math.log(first))
    const angle = Math.PI * 2 * second
    spareNormal = magnitude * Math.sin(angle)
    return magnitude * Math.cos(angle)
  }

  return {
    next,
    range: (min, max) => min + (max - min) * next(),
    int: (min, max) => Math.floor(min + next() * (max - min + 1)),
    pick: <T,>(items: readonly T[]) => {
      if (items.length === 0) {
        throw new RangeError('Cannot pick from an empty collection')
      }
      return items[Math.floor(next() * items.length)] as T
    },
    chance: (probability) => next() < Math.max(0, Math.min(1, probability)),
    normal,
  }
}

export function shuffleWithRng<T>(items: readonly T[], rng: SeededRng): T[] {
  const shuffled = [...items]
  for (let index = shuffled.length - 1; index > 0; index -= 1) {
    const other = rng.int(0, index)
    ;[shuffled[index], shuffled[other]] = [shuffled[other] as T, shuffled[index] as T]
  }
  return shuffled
}

export function makeRoundSeed(): string {
  const bytes = new Uint32Array(3)
  if (typeof crypto !== 'undefined' && crypto.getRandomValues) {
    crypto.getRandomValues(bytes)
    return Array.from(bytes, (value) => value.toString(36)).join('-')
  }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`
}
