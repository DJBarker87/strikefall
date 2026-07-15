declare const rankedReplayIdBrand: unique symbol

/** Canonical lower-case UUID v4 issued by the ranked round service. */
export type RankedReplayId = string & { readonly [rankedReplayIdBrand]: true }

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

export class InvalidRankedReplayIdError extends TypeError {
  override readonly name = 'InvalidRankedReplayIdError'

  constructor() {
    super('Replay ID must be a canonical lower-case UUID v4.')
  }
}

export function isRankedReplayId(value: unknown): value is RankedReplayId {
  return typeof value === 'string' && UUID_V4.test(value)
}

export function parseRankedReplayId(value: unknown): RankedReplayId {
  if (!isRankedReplayId(value)) throw new InvalidRankedReplayIdError()
  return value
}
