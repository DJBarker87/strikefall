import { parseRankedReplayId, type RankedReplayId } from './id'

function safeWebOrigin(baseUrl: string | URL): URL {
  const parsed = new URL(baseUrl.toString())
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new TypeError('Replay share links require an HTTP or HTTPS origin.')
  }
  return parsed
}

/**
 * Builds a seedless, tokenless, same-origin public replay URL.
 *
 * Only the validated server-issued UUID is carried forward. Search params,
 * credentials, path state, and fragments from the current page are discarded.
 */
export function createRankedReplayShareUrl(
  replayId: string | RankedReplayId,
  baseUrl: string | URL,
): string {
  const id = parseRankedReplayId(replayId)
  const base = safeWebOrigin(baseUrl)
  const shareUrl = new URL(`/replay/${id}`, base.origin)
  return shareUrl.toString()
}
