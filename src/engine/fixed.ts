const SCALE_DIGITS = 12
export const FIXED_SCALE = 1_000_000_000_000n
const UNSIGNED_FIXED = /^(0|[1-9][0-9]*)$/
const SIGNED_FIXED = /^(0|-?[1-9][0-9]*)$/

function assertFinite(value: number, field: string): void {
  if (!Number.isFinite(value)) throw new TypeError(`${field} must be finite`)
}

export function canonicalUnsignedFixed(value: string, field = 'value'): string {
  if (!UNSIGNED_FIXED.test(value)) throw new TypeError(`${field} is not canonical fixed text`)
  return value
}

/**
 * The one audited Number → fixed boundary. It never multiplies a Number by
 * 1e12: decimal rounding happens as text, then integer assembly uses BigInt.
 */
export function displayNumberToFixed(value: number, field = 'value'): string {
  assertFinite(value, field)
  if (value < 0) throw new RangeError(`${field} must be non-negative`)
  const [whole = '0', fraction = ''] = value.toFixed(SCALE_DIGITS).split('.')
  return (
    BigInt(whole) * FIXED_SCALE +
    BigInt(fraction.padEnd(SCALE_DIGITS, '0'))
  ).toString()
}

export function probabilityNumberToFixed(value: number, field = 'probability'): string {
  if (value < 0 || value > 1) throw new RangeError(`${field} must be between zero and one`)
  return displayNumberToFixed(value, field)
}

export function fixedToDisplayNumber(value: string, field = 'value'): number {
  if (!SIGNED_FIXED.test(value)) throw new TypeError(`${field} is not canonical fixed text`)
  const fixed = BigInt(value)
  const negative = fixed < 0n
  const absolute = negative ? -fixed : fixed
  const whole = absolute / FIXED_SCALE
  const fraction = absolute % FIXED_SCALE
  const decoded = Number(whole) + Number(fraction) / Number(FIXED_SCALE)
  return negative ? -decoded : decoded
}

export function fixedToRoundedPoints(value: string, field = 'points'): number {
  if (!UNSIGNED_FIXED.test(value)) throw new TypeError(`${field} is not canonical fixed text`)
  const fixed = BigInt(value)
  const rounded = (fixed + FIXED_SCALE / 2n) / FIXED_SCALE
  const decoded = Number(rounded)
  if (!Number.isSafeInteger(decoded)) throw new RangeError(`${field} exceeds safe display range`)
  return decoded
}

/**
 * Exact unsigned SCALE=1e12 multiply, matching `solmath::fp_mul` truncation.
 * This is used only to combine fixed values already produced by SolMath; the
 * rounded Number is a final UI projection and never feeds another calculation.
 */
export function multiplyUnsignedFixed(
  left: string,
  right: string,
  field = 'product',
): string {
  if (!UNSIGNED_FIXED.test(left)) throw new TypeError(`${field}.left is not canonical fixed text`)
  if (!UNSIGNED_FIXED.test(right)) throw new TypeError(`${field}.right is not canonical fixed text`)
  return ((BigInt(left) * BigInt(right)) / FIXED_SCALE).toString()
}

export function addUnsignedFixed(
  left: string,
  right: string,
  field = 'sum',
): string {
  canonicalUnsignedFixed(left, `${field}.left`)
  canonicalUnsignedFixed(right, `${field}.right`)
  return (BigInt(left) + BigInt(right)).toString()
}

export function subtractUnsignedFixed(
  left: string,
  right: string,
  field = 'difference',
): string {
  canonicalUnsignedFixed(left, `${field}.left`)
  canonicalUnsignedFixed(right, `${field}.right`)
  const result = BigInt(left) - BigInt(right)
  if (result < 0n) throw new RangeError(`${field} cannot be negative`)
  return result.toString()
}
