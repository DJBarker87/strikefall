export const ALPHA_TOKEN_STORAGE_KEY = 'strikefall.alpha.token.v1'

const TOKEN_PATTERN = /^sf_alpha_[A-Za-z0-9_-]{24,220}$/

export interface AlphaTokenStorage {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem(key: string): void
}

function browserStorage(): AlphaTokenStorage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage
  } catch {
    return null
  }
}

export function validAlphaToken(value: unknown): value is string {
  return typeof value === 'string' && TOKEN_PATTERN.test(value)
}

export function readAlphaToken(storage: AlphaTokenStorage | null = browserStorage()): string | null {
  try {
    const token = storage?.getItem(ALPHA_TOKEN_STORAGE_KEY)
    return validAlphaToken(token) ? token : null
  } catch {
    return null
  }
}

export function writeAlphaToken(
  token: string,
  storage: AlphaTokenStorage | null = browserStorage(),
): boolean {
  if (!validAlphaToken(token)) throw new TypeError('Alpha token format is invalid')
  try {
    storage?.setItem(ALPHA_TOKEN_STORAGE_KEY, token)
    return storage !== null
  } catch {
    return false
  }
}

export function clearAlphaToken(storage: AlphaTokenStorage | null = browserStorage()): void {
  try {
    storage?.removeItem(ALPHA_TOKEN_STORAGE_KEY)
  } catch {
    // An unavailable storage surface is equivalent to a signed-out browser.
  }
}
