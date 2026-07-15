export function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value))
}

export function lerp(start: number, end: number, amount: number): number {
  return start + (end - start) * amount
}

export function roundTo(value: number, places = 6): number {
  const scale = 10 ** places
  return Math.round(value * scale) / scale
}

/** Abramowitz and Stegun 7.1.26; ample precision for prototype display math. */
export function normalCdf(value: number): number {
  const sign = value < 0 ? -1 : 1
  const x = Math.abs(value) / Math.sqrt(2)
  const t = 1 / (1 + 0.3275911 * x)
  const a1 = 0.254829592
  const a2 = -0.284496736
  const a3 = 1.421413741
  const a4 = -1.453152027
  const a5 = 1.061405429
  const erf =
    1 -
    ((((a5 * t + a4) * t + a3) * t + a2) * t + a1) * t * Math.exp(-x * x)
  return 0.5 * (1 + sign * erf)
}

/** Stable monotone inverse used for probability-to-distance placement. */
export function inverseNormalCdf(probability: number): number {
  const target = clamp(probability, 1e-9, 1 - 1e-9)
  let low = -6.5
  let high = 6.5

  for (let iteration = 0; iteration < 64; iteration += 1) {
    const midpoint = (low + high) / 2
    if (normalCdf(midpoint) < target) {
      low = midpoint
    } else {
      high = midpoint
    }
  }

  return (low + high) / 2
}
