import { RankedClientError } from './errors'

export type BearerTokenProvider = () => string | Promise<string>
export type BearerTokenSource = string | BearerTokenProvider

export async function resolveBearerToken(source: BearerTokenSource): Promise<string> {
  let token: string
  try {
    token = typeof source === 'function' ? await source() : source
  } catch (error) {
    throw new RankedClientError(
      'authentication_unavailable',
      'Ranked authentication token is unavailable.',
      { cause: error },
    )
  }
  if (typeof token !== 'string' || token.length === 0 || /[\s\r\n]/.test(token)) {
    throw new RankedClientError(
      'authentication_unavailable',
      'Ranked authentication token is unavailable.',
    )
  }
  return token
}
