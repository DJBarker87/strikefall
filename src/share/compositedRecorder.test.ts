import { describe, expect, it, vi } from 'vitest'
import { CompositedShareRecorder } from './compositedRecorder'
import type { CompositedShareRecorderEnvironment, ShareClipCanvasSurface } from './compositedRecorder'
import type {
  MediaRecorderLike,
  RollingRecorderEnvironment,
} from './recorder'
import type { ShareCardData } from './types'

class FakeMediaRecorder implements MediaRecorderLike {
  readonly mimeType = 'video/webm'
  state: 'inactive' | 'recording' | 'paused' = 'inactive'
  ondataavailable: MediaRecorderLike['ondataavailable'] = null
  onerror: MediaRecorderLike['onerror'] = null
  onstop: MediaRecorderLike['onstop'] = null
  requestData = vi.fn(() => {
    this.ondataavailable?.({ data: new Blob(['composited-frame'], { type: this.mimeType }) })
  })

  start(): void {
    this.state = 'recording'
  }

  stop(): void {
    this.state = 'inactive'
    this.onstop?.()
  }
}

const card: ShareCardData = {
  brand: 'STRIKEFALL',
  deckName: 'Pulse',
  deckKicker: 'Double pressure',
  deckHue: 315,
  botCount: 19,
  multiplier: 4.25,
  outcome: 'survived',
  headline: 'GREED FLAG. ICE-COLD HOLD.',
  kicker: 'MAX RISK',
  detail: 'Held through the full storm.',
  accent: 'success',
  stats: [
    { label: 'RANK', value: '#1' },
    { label: 'SCORE', value: '850' },
    { label: 'RISK', value: '4.25×' },
    { label: 'FIELD', value: '1 HELD' },
  ],
  chart: { points: [0.4, 0.7], flag: 0.8, final: 0.7, side: 'upper' },
  momentKind: 'greed-hold',
}

function context(text: string[]) {
  const gradient = { addColorStop: vi.fn() }
  const target: Record<PropertyKey, unknown> = {
    measureText: (value: string) => ({ width: value.length * 10 }),
    fillText: (value: string) => text.push(value),
    createLinearGradient: () => gradient,
    createRadialGradient: () => gradient,
  }
  return new Proxy(target, {
    get(object, property) {
      if (property in object) return object[property]
      return () => undefined
    },
    set(object, property, value) {
      object[property] = value
      return true
    },
  }) as unknown as CanvasRenderingContext2D
}

describe('three-format composited rolling recorder', () => {
  it('records every bounded surface and captures the selected real dimensions', async () => {
    const copy: string[] = []
    const tracks = [{ stop: vi.fn() }, { stop: vi.fn() }]
    const mediaRecorders: FakeMediaRecorder[] = []
    let surface = 0
    let now = 0
    let frameId = 0
    const frames = new Map<number, () => void>()
    const compositor: CompositedShareRecorderEnvironment = {
      createCanvas(width, height) {
        const index = surface++
        return {
          width,
          height,
          getContext: () => context(copy),
          captureStream: () => ({ getTracks: () => [tracks[index]!] }),
        } satisfies ShareClipCanvasSurface
      },
      now: () => now,
      requestFrame(callback) {
        const id = ++frameId
        frames.set(id, callback)
        return id
      },
      cancelFrame(handle) {
        frames.delete(handle as number)
      },
    }
    const rolling: RollingRecorderEnvironment = {
      createRecorder: () => {
        const recorder = new FakeMediaRecorder()
        mediaRecorders.push(recorder)
        return recorder
      },
      isTypeSupported: (mimeType) => mimeType.includes('webm'),
      prefersReducedMotion: () => false,
      now: () => now,
      setTimeout(callback, milliseconds) {
        if (milliseconds < 8_000) queueMicrotask(callback)
        return 1
      },
      clearTimeout: () => undefined,
      createBlob: (parts, options) => new Blob([...parts], options),
    }
    const recorder = new CompositedShareRecorder(
      { width: 1280, height: 720 },
      card,
      { environment: compositor, recorder: { environment: rolling, timesliceMs: 1_000 } },
    )

    expect(recorder.start()).toMatchObject({
      'portrait-9x16': { status: 'recording' },
      'square-1x1': { status: 'recording' },
      'landscape-16x9': { status: 'recording' },
    })
    expect(mediaRecorders).toHaveLength(3)
    expect(copy.join(' ')).toContain('19 BOTS')

    const copyBeforeUpdate = copy.length
    recorder.update({ ...card, headline: 'UPDATED FINAL MOMENT' })
    expect(copy).toHaveLength(copyBeforeUpdate)

    for (let second = 0; second <= 10; second += 1) {
      now = second * 1_000
      mediaRecorders.forEach((mediaRecorder) => mediaRecorder.requestData())
    }
    const pendingFrame = frames.entries().next().value as [number, () => void] | undefined
    if (pendingFrame) {
      frames.delete(pendingFrame[0])
      pendingFrame[1]()
    }
    expect(copy.join(' ')).toContain('UPDATED FINAL MOMENT')
    const retained = await recorder.retainMoment('cluster-wipe:4', {
      occurredAtMs: 4_000,
      tailMs: 0,
      priority: 94,
    })
    expect(retained['portrait-9x16']).toMatchObject({
      status: 'ready',
      durationMs: 10_000,
      alignment: {
        momentKey: 'cluster-wipe:4',
        eventOffsetMs: 4_000,
      },
    })
    await recorder.retainLatestMoment('held-near-miss', 'near-miss:held:16', {
      occurredAtMs: 4_000,
      tailMs: 0,
      priority: 84,
    })
    const closest = await recorder.retainLatestMoment(
      'held-near-miss',
      'near-miss:held:32',
      { occurredAtMs: 8_000, tailMs: 0, priority: 92 },
    )
    expect(closest['square-1x1']).toMatchObject({
      status: 'ready',
      alignment: { momentKey: 'near-miss:held:32', eventOffsetMs: 8_000 },
    })
    await recorder.freeze(0)
    expect(frames.size).toBe(0)
    expect(tracks.every((track) => track.stop.mock.calls.length === 1)).toBe(true)
    const clip = await recorder.captureMoment('square-1x1', 0)
    expect(clip).toMatchObject({
      status: 'ready',
      format: 'square-1x1',
      width: 720,
      height: 720,
      mimeType: 'video/webm;codecs=vp9',
    })

    const selected = await recorder.captureRetainedMoment('landscape-16x9', 'cluster-wipe:4')
    expect(selected).toMatchObject({
      status: 'ready',
      format: 'landscape-16x9',
      width: 1280,
      height: 720,
      durationMs: 10_000,
      alignment: {
        momentKey: 'cluster-wipe:4',
        eventOffsetMs: 4_000,
      },
    })
    await expect(
      recorder.captureRetainedMoment('portrait-9x16', 'near-miss:held:16'),
    ).resolves.toMatchObject({ status: 'fallback', reason: 'moment-not-retained' })
    await expect(
      recorder.captureRetainedMoment('portrait-9x16', 'near-miss:held:32'),
    ).resolves.toMatchObject({
      status: 'ready',
      alignment: { momentKey: 'near-miss:held:32', eventOffsetMs: 8_000 },
    })

    recorder.dispose()
    expect(tracks.every((track) => track.stop.mock.calls.length === 1)).toBe(true)
  })

  it('retains the static-card fallback when composition is unavailable', async () => {
    const recorder = new CompositedShareRecorder({ width: 10, height: 10 }, card, {
      environment: {
        createCanvas: (width, height) => ({ width, height, getContext: () => null }),
        now: () => 0,
        requestFrame: () => 1,
        cancelFrame: () => undefined,
      },
    })
    expect(recorder.start()['portrait-9x16']).toMatchObject({
      status: 'unsupported',
      reason: 'composition-unavailable',
    })
    await expect(recorder.captureMoment('portrait-9x16')).resolves.toMatchObject({
      status: 'fallback',
      fallback: 'static-card',
    })
  })
})
