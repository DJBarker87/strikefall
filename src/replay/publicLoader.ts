import { RankedClientError, RankedHttpError } from '../ranked/errors'
import type { RankedReplayId } from './id'
import type { RankedReplayLoadContext, RankedReplayLoadPayload, RankedReplayLoader } from './verify'

export interface PublicRankedReplayLoaderOptions {
  readonly baseUrl: string
  readonly fetch?: typeof globalThis.fetch
}

function normalizedBaseUrl(value: string): string {
  const trimmed = value.trim().replace(/\/+$/, '')
  if (!trimmed) throw new TypeError('A public replay API base URL is required.')
  if (/^https?:\/\//i.test(trimmed)) {
    const parsed = new URL(trimmed)
    if (parsed.username || parsed.password) {
      throw new TypeError('Public replay API URLs must not contain credentials.')
    }
    parsed.search = ''
    parsed.hash = ''
    return parsed.toString().replace(/\/+$/, '')
  }
  if (!trimmed.startsWith('/')) {
    throw new TypeError('Relative public replay API URLs must start with /.')
  }
  return trimmed.split(/[?#]/, 1)[0]!.replace(/\/+$/, '')
}

async function json(response: Response): Promise<unknown> {
  try {
    return await response.json() as unknown
  } catch (error) {
    throw new RankedClientError('malformed_response', 'Public replay response was not valid JSON.', {
      cause: error,
    })
  }
}

/**
 * Loads the server's identity-free public envelope. This request deliberately
 * omits bearer credentials: a replay is public only after its matching proof
 * receipt exists, and the separately named anchor is the publisher trust root.
 */
export function createPublicRankedReplayLoader(
  options: PublicRankedReplayLoaderOptions,
): RankedReplayLoader {
  const baseUrl = normalizedBaseUrl(options.baseUrl)
  const fetchImpl = options.fetch ?? globalThis.fetch
  if (typeof fetchImpl !== 'function') throw new TypeError('Fetch is required to load public replays.')

  return async (
    replayId: RankedReplayId,
    context: RankedReplayLoadContext,
  ): Promise<RankedReplayLoadPayload> => {
    let response: Response
    try {
      response = await fetchImpl(
        `${baseUrl}/v1/public-replays/${encodeURIComponent(replayId)}`,
        {
          method: 'GET',
          cache: 'no-store',
          credentials: 'omit',
          referrerPolicy: 'no-referrer',
          signal: context.signal,
        },
      )
    } catch (error) {
      if (context.signal.aborted) {
        throw new RankedClientError('aborted', 'Public replay loading was cancelled.', { cause: error })
      }
      throw new RankedClientError('network_error', 'The public replay service could not be reached.', {
        cause: error,
      })
    }
    if (!response.ok) {
      throw new RankedHttpError({
        status: response.status,
        apiCode: response.status === 404 ? 'replay_not_public' : null,
        message: response.status === 404
          ? 'This replay is not public or has not been verified yet.'
          : `Public replay service returned HTTP ${response.status}.`,
        retryAfterMs: null,
      })
    }
    const envelope = await json(response)
    if (!envelope || typeof envelope !== 'object' || Array.isArray(envelope)) {
      throw new RankedClientError('malformed_response', 'Public replay envelope must be an object.')
    }
    const source = envelope as Record<string, unknown>
    if (!('anchor' in source) || !('replay' in source)) {
      throw new RankedClientError(
        'malformed_response',
        'Public replay envelope is missing its trusted anchor or replay.',
      )
    }
    return { anchor: source.anchor, replay: source.replay }
  }
}
