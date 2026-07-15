import { describe, expect, it, vi } from 'vitest'
import { createShareFile, shareStrikefallFile } from './webShare'
import type { ShareCardData } from './types'
import type { WebShareEnvironment } from './webShare'
import { createRankedReplayShareUrl } from '../replay/shareUrl'

const data: ShareCardData = {
  brand: 'STRIKEFALL',
  deckName: 'Pulse',
  deckKicker: 'Double pressure',
  deckHue: 315,
  botCount: 19,
  multiplier: 5.5,
  outcome: 'survived',
  headline: 'MAX RISK. ZERO FLINCH.',
  kicker: 'GREED HOLD',
  detail: '5.5× risk survived the full path.',
  accent: 'success',
  stats: [
    { label: 'RANK', value: '#1' },
    { label: 'SCORE', value: '900' },
    { label: 'RISK', value: '5.5×' },
    { label: 'FIELD', value: '2 HELD' },
  ],
  chart: { points: [0.5, 0.7], flag: 0.9, final: 0.7, side: 'upper' },
  momentKind: 'greed-hold',
}

function fakeFile(parts: readonly BlobPart[], name: string, options: FilePropertyBag): File {
  return Object.assign(new Blob([...parts], options), {
    name,
    lastModified: options.lastModified ?? 0,
    webkitRelativePath: '',
  }) as File
}

describe('Web Share helpers', () => {
  it('creates a stable public file and shares only public copy', async () => {
    const share = vi.fn(async (_payload: ShareData) => undefined)
    const environment: WebShareEnvironment = {
      createFile: fakeFile,
      canShare: () => true,
      share,
    }
    const prepared = createShareFile(new Blob(['png'], { type: 'image/png' }), data, environment)
    expect(prepared.status).toBe('ready')
    if (prepared.status !== 'ready') return
    expect(prepared.file.name).toBe('strikefall-pulse.png')
    await expect(shareStrikefallFile(prepared.file, data, environment)).resolves.toEqual({ status: 'shared' })
    const payload = share.mock.calls[0]?.[0]
    expect(JSON.stringify(payload)).not.toMatch(/seed|roundId|debug/i)
  })

  it('can attach the validated tokenless public replay URL to ranked media', async () => {
    const share = vi.fn(async (_payload: ShareData) => undefined)
    const environment: WebShareEnvironment = {
      createFile: fakeFile,
      canShare: () => true,
      share,
    }
    const prepared = createShareFile(new Blob(['clip'], { type: 'video/webm' }), data, environment)
    expect(prepared.status).toBe('ready')
    if (prepared.status !== 'ready') return
    const publicReplayUrl = createRankedReplayShareUrl(
      '53af8a60-edc5-4fbc-a372-85fa1a0a7fdf',
      'https://strikefall.gg/private?token=never-share#debug',
    )
    await expect(shareStrikefallFile(prepared.file, data, environment, { publicReplayUrl }))
      .resolves.toEqual({ status: 'shared' })
    expect(share.mock.calls[0]?.[0]).toMatchObject({
      url: 'https://strikefall.gg/replay/53af8a60-edc5-4fbc-a372-85fa1a0a7fdf',
    })
    expect(JSON.stringify(share.mock.calls[0]?.[0])).not.toMatch(/token=|private|debug/i)
  })

  it('reports unsupported file sharing without invoking share', async () => {
    const share = vi.fn(async (_payload: ShareData) => undefined)
    const environment: WebShareEnvironment = { canShare: () => false, share }
    const file = fakeFile(['x'], 'strikefall.png', { type: 'image/png' })
    await expect(shareStrikefallFile(file, data, environment)).resolves.toEqual({
      status: 'unsupported',
      reason: 'file-sharing-unavailable',
      fallback: 'download',
    })
    expect(share).not.toHaveBeenCalled()
    expect(createShareFile(new Blob(['x']), data, environment)).toEqual({
      status: 'unsupported',
      reason: 'file-api-unavailable',
    })
  })

  it('treats user cancellation separately from a share failure', async () => {
    const cancelled = new Error('cancelled')
    cancelled.name = 'AbortError'
    const cancelEnvironment: WebShareEnvironment = {
      canShare: () => true,
      share: async () => { throw cancelled },
    }
    const file = fakeFile(['x'], 'strikefall.png', { type: 'image/png' })
    await expect(shareStrikefallFile(file, data, cancelEnvironment)).resolves.toEqual({ status: 'cancelled' })

    const failureEnvironment: WebShareEnvironment = {
      canShare: () => true,
      share: async () => { throw new Error('transport failed') },
    }
    await expect(shareStrikefallFile(file, data, failureEnvironment)).resolves.toMatchObject({
      status: 'error',
      fallback: 'download',
    })
  })

  it('keeps the download fallback when capability probing throws', async () => {
    const share = vi.fn(async (_payload: ShareData) => undefined)
    const file = fakeFile(['x'], 'strikefall.png', { type: 'image/png' })
    await expect(shareStrikefallFile(file, data, {
      canShare: () => { throw new Error('broken capability probe') },
      share,
    })).resolves.toMatchObject({
      status: 'error',
      fallback: 'download',
    })
    expect(share).not.toHaveBeenCalled()
  })
})
