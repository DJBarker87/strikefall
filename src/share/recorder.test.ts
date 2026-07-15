import { describe, expect, it, vi } from 'vitest'
import { RollingArenaRecorder } from './recorder'
import type {
  MediaRecorderLike,
  MediaStreamLike,
  RollingRecorderEnvironment,
} from './recorder'

class FakeMediaRecorder implements MediaRecorderLike {
  readonly mimeType = 'video/webm'
  state: 'inactive' | 'recording' | 'paused' = 'inactive'
  ondataavailable: MediaRecorderLike['ondataavailable'] = null
  onerror: MediaRecorderLike['onerror'] = null
  onstop: MediaRecorderLike['onstop'] = null
  readonly stopSpy = vi.fn()
  readonly startSpy = vi.fn()
  requestData = vi.fn(() => {
    this.ondataavailable?.({ data: new Blob(['tail'], { type: this.mimeType }) })
  })

  start(timeslice?: number): void {
    this.startSpy(timeslice)
    this.state = 'recording'
  }

  stop(): void {
    this.stopSpy()
    this.state = 'inactive'
    this.onstop?.()
  }

  emit(blob: Blob, timecode?: number): void {
    this.ondataavailable?.({ data: blob, timecode })
  }

  fail(error: Error): void {
    this.onerror?.({ error })
  }
}

function harness(overrides: Partial<RollingRecorderEnvironment> = {}) {
  let now = 0
  let timerId = 0
  const timers = new Map<number, () => void>()
  const recorder = new FakeMediaRecorder()
  const track = { stop: vi.fn() }
  const stream: MediaStreamLike = { getTracks: () => [track] }
  const environment: RollingRecorderEnvironment = {
    createRecorder: () => recorder,
    isTypeSupported: (mimeType) => mimeType.startsWith('video/webm'),
    prefersReducedMotion: () => false,
    now: () => now,
    setTimeout(callback, milliseconds) {
      const id = ++timerId
      timers.set(id, callback)
      if (milliseconds < 8_000) {
        queueMicrotask(() => {
          if (!timers.has(id)) return
          timers.delete(id)
          callback()
        })
      }
      return id
    },
    clearTimeout(handle) {
      timers.delete(handle as number)
    },
    createBlob: (parts, options) => new Blob([...parts], options),
    ...overrides,
  }
  return {
    environment,
    recorder,
    stream,
    track,
    setNow(value: number) {
      now = value
    },
    flushTimers() {
      const pending = [...timers.entries()]
      timers.clear()
      for (const [, callback] of pending) callback()
    },
  }
}

describe('rolling arena recorder', () => {
  it('keeps an 8–12 second, byte-bounded buffer and exports a recent clip', async () => {
    const test = harness()
    const rolling = new RollingArenaRecorder(
      { captureStream: () => test.stream },
      { environment: test.environment, bufferDurationMs: 30_000, maxBytes: 1_048_576 },
    )
    expect(rolling.start()).toMatchObject({ status: 'recording' })
    expect(rolling.getStats().bufferDurationMs).toBe(12_000)

    const chunk = () => new Blob([new Uint8Array(300_000)], { type: 'video/webm' })
    test.recorder.emit(chunk())
    test.setNow(1_000)
    test.recorder.emit(chunk())
    test.setNow(2_000)
    test.recorder.emit(chunk())
    expect(rolling.getStats().bytes).toBeLessThanOrEqual(1_048_576)

    test.setNow(11_000)
    const clip = await rolling.captureMoment(0)
    expect(clip.status).toBe('ready')
    if (clip.status === 'ready') {
      expect(clip.mimeType).toBe('video/webm;codecs=vp9')
      expect(clip.blob.size).toBeLessThanOrEqual(1_048_576)
    }

    rolling.dispose()
    expect(test.track.stop).toHaveBeenCalled()
    expect(rolling.getStats()).toMatchObject({ status: 'disposed', bytes: 0, chunks: 0 })
  })

  it('uses a static card for reduced motion and unsupported APIs', () => {
    const reduced = harness({ prefersReducedMotion: () => true })
    const reducedRecorder = new RollingArenaRecorder(
      { captureStream: () => reduced.stream },
      { environment: reduced.environment },
    )
    expect(reducedRecorder.start()).toEqual({
      status: 'unsupported',
      reason: 'reduced-motion',
      fallback: 'static-card',
    })

    const unsupported = harness({ createRecorder: undefined })
    const unsupportedRecorder = new RollingArenaRecorder(
      { captureStream: () => unsupported.stream },
      { environment: unsupported.environment },
    )
    expect(unsupportedRecorder.start()).toMatchObject({
      status: 'unsupported',
      reason: 'media-recorder-unavailable',
    })
  })

  it('turns constructor and recorder failures into errors and releases tracks', () => {
    const construction = harness({ createRecorder: () => { throw new Error('codec failed') } })
    const failedStart = new RollingArenaRecorder(
      { captureStream: () => construction.stream },
      { environment: construction.environment },
    )
    expect(failedStart.start()).toMatchObject({ status: 'error', fallback: 'static-card' })
    expect(construction.track.stop).toHaveBeenCalledTimes(1)

    const runtime = harness()
    const failedRuntime = new RollingArenaRecorder(
      { captureStream: () => runtime.stream },
      { environment: runtime.environment },
    )
    failedRuntime.start()
    runtime.recorder.emit(new Blob(['video']))
    runtime.recorder.fail(new Error('encoder crashed'))
    expect(failedRuntime.getStats()).toMatchObject({ status: 'error', bytes: 0 })
    expect(runtime.track.stop).toHaveBeenCalledTimes(1)
  })

  it('freezes encoder work while retaining a delayed-share clip', async () => {
    const test = harness()
    const rolling = new RollingArenaRecorder(
      { captureStream: () => test.stream },
      { environment: test.environment, bufferDurationMs: 10_000 },
    )
    rolling.start()
    test.recorder.emit(new Blob(['history'], { type: 'video/webm' }))
    test.setNow(1_000)
    test.recorder.emit(new Blob(['middle'], { type: 'video/webm' }))
    test.setNow(9_000)

    await rolling.freeze(0)
    expect(rolling.getStats()).toMatchObject({ status: 'frozen' })
    expect(test.track.stop).toHaveBeenCalledTimes(1)
    const clip = await rolling.captureMoment()
    expect(clip).toMatchObject({ status: 'ready', alignment: null })
    if (clip.status === 'ready') {
      expect(clip.durationMs).toBeGreaterThanOrEqual(8_000)
      expect(clip.durationMs).toBeLessThanOrEqual(12_000)
    }
  })

  it('retains an 8–12 second event window after the live buffer rolls onward', async () => {
    const test = harness()
    const rolling = new RollingArenaRecorder(
      { captureStream: () => test.stream },
      { environment: test.environment, bufferDurationMs: 10_000, timesliceMs: 1_000 },
    )
    rolling.start()

    for (let second = 0; second <= 10; second += 1) {
      test.setNow(second * 1_000)
      test.recorder.emit(new Blob([`second-${second}`], { type: 'video/webm' }))
    }
    const retained = await rolling.retainMoment('cluster-wipe:7', {
      occurredAtMs: 6_000,
      tailMs: 0,
      priority: 92,
    })
    expect(retained).toMatchObject({
      status: 'ready',
      durationMs: 10_000,
      alignment: {
        momentKey: 'cluster-wipe:7',
        eventOffsetMs: 6_000,
        eventProgress: 0.6,
      },
    })

    for (let second = 11; second <= 20; second += 1) {
      test.setNow(second * 1_000)
      test.recorder.emit(new Blob([`second-${second}`], { type: 'video/webm' }))
    }
    const selected = await rolling.captureRetainedMoment('cluster-wipe:7')
    expect(selected).toMatchObject({
      status: 'ready',
      durationMs: 10_000,
      alignment: {
        momentKey: 'cluster-wipe:7',
        eventOffsetMs: 6_000,
      },
    })
    if (selected.status === 'ready') {
      expect(selected.durationMs).toBeGreaterThanOrEqual(8_000)
      expect(selected.durationMs).toBeLessThanOrEqual(12_000)
      expect(selected.alignment?.eventOffsetMs).toBeLessThanOrEqual(selected.durationMs)
    }
  })

  it('replaces a held-near-miss slot with the authoritative closest step only', async () => {
    const test = harness()
    const rolling = new RollingArenaRecorder(
      { captureStream: () => test.stream },
      { environment: test.environment, bufferDurationMs: 10_000, timesliceMs: 1_000 },
    )
    rolling.start()
    for (let second = 0; second <= 10; second += 1) {
      test.setNow(second * 1_000)
      test.recorder.emit(new Blob([`battle-${second}`], { type: 'video/webm' }))
    }

    await expect(rolling.retainLatestMoment(
      'held-near-miss',
      'near-miss:held:16',
      { occurredAtMs: 4_000, tailMs: 0, priority: 84 },
    )).resolves.toMatchObject({ status: 'ready' })
    await expect(rolling.retainLatestMoment(
      'held-near-miss',
      'near-miss:held:32',
      { occurredAtMs: 8_000, tailMs: 0, priority: 92 },
    )).resolves.toMatchObject({
      status: 'ready',
      alignment: {
        momentKey: 'near-miss:held:32',
        eventOffsetMs: 8_000,
      },
    })

    await expect(rolling.captureRetainedMoment('near-miss:held:16')).resolves.toEqual({
      status: 'fallback',
      reason: 'moment-not-retained',
      fallback: 'static-card',
    })
    await expect(rolling.captureRetainedMoment('near-miss:held:32')).resolves.toMatchObject({
      status: 'ready',
      alignment: { momentKey: 'near-miss:held:32', eventOffsetMs: 8_000 },
    })
  })

  it('bounds an unresolved live slot while closer battle steps keep arriving', async () => {
    const test = harness()
    const rolling = new RollingArenaRecorder(
      { captureStream: () => test.stream },
      { environment: test.environment, bufferDurationMs: 10_000, timesliceMs: 1_000 },
    )
    rolling.start()
    test.recorder.emit(new Blob(['opening'], { type: 'video/webm' }))
    const superseded = rolling.retainLatestMoment(
      'held-near-miss',
      'near-miss:held:1',
      { occurredAtMs: 0, priority: 84 },
    )
    test.setNow(500)
    test.recorder.emit(new Blob(['closer'], { type: 'video/webm' }))
    const authoritative = rolling.retainLatestMoment(
      'held-near-miss',
      'near-miss:held:2',
      { occurredAtMs: 500, priority: 92 },
    )
    await expect(superseded).resolves.toEqual({
      status: 'fallback',
      reason: 'moment-not-retained',
      fallback: 'static-card',
    })

    test.setNow(9_000)
    test.recorder.emit(new Blob(['settled'], { type: 'video/webm' }))
    test.flushTimers()
    await expect(authoritative).resolves.toMatchObject({
      status: 'ready',
      durationMs: 9_000,
      alignment: {
        momentKey: 'near-miss:held:2',
        eventOffsetMs: 500,
      },
    })
    await expect(rolling.captureRetainedMoment('near-miss:held:1')).resolves.toMatchObject({
      status: 'fallback',
      reason: 'moment-not-retained',
    })
  })

  it('does not substitute the latest footage for a missing moment key', async () => {
    const test = harness()
    const rolling = new RollingArenaRecorder(
      { captureStream: () => test.stream },
      { environment: test.environment },
    )
    rolling.start()
    test.recorder.emit(new Blob(['unrelated-live-tail'], { type: 'video/webm' }))

    await expect(rolling.captureRetainedMoment('escape')).resolves.toEqual({
      status: 'fallback',
      reason: 'moment-not-retained',
      fallback: 'static-card',
    })
  })

  it('requires native media-time evidence when the application clock is accelerated', async () => {
    const test = harness({ trustRecorderClock: false })
    const rolling = new RollingArenaRecorder(
      { captureStream: () => test.stream },
      { environment: test.environment, timesliceMs: 500 },
    )
    rolling.start()
    test.recorder.emit(new Blob(['zero']), 0)
    test.recorder.emit(new Blob(['half']), 500)
    test.recorder.emit(new Blob(['one']), 1_000)
    test.setNow(10_000)

    await expect(rolling.captureMoment(0)).resolves.toEqual({
      status: 'fallback',
      reason: 'invalid-media-duration',
      fallback: 'static-card',
    })
  })

  it('awaits the terminal chunk and finalizes an evidenced standalone segment', async () => {
    const finalizeBlob = vi.fn(async (blob: Blob) => blob)
    const test = harness({ trustRecorderClock: false, finalizeBlob })
    const rolling = new RollingArenaRecorder(
      { captureStream: () => test.stream },
      { environment: test.environment, timesliceMs: 500 },
    )
    rolling.start()
    for (let timecode = 0; timecode <= 8_000; timecode += 500) {
      test.recorder.emit(new Blob([`chunk-${timecode}|`]), timecode)
    }
    test.recorder.stop = vi.fn(() => {
      test.recorder.emit(new Blob(['terminal']), 8_500)
      test.recorder.state = 'inactive'
      test.recorder.onstop?.()
    })
    test.setNow(8_500)

    const clip = await rolling.captureMoment(0)
    expect(clip).toMatchObject({ status: 'ready', durationMs: 8_500 })
    expect(finalizeBlob).toHaveBeenCalledTimes(1)
    const raw = finalizeBlob.mock.calls[0]?.[0]
    expect(await raw?.text()).toContain('terminal')
  })

  it('cleans a pending tail timer when disposed', async () => {
    const recorder = new FakeMediaRecorder()
    const track = { stop: vi.fn() }
    const callbacks = new Map<number, () => void>()
    let timerId = 0
    const environment: RollingRecorderEnvironment = {
      createRecorder: () => recorder,
      isTypeSupported: () => true,
      prefersReducedMotion: () => false,
      now: () => 0,
      setTimeout(callback) {
        const id = ++timerId
        callbacks.set(id, callback)
        return id
      },
      clearTimeout(handle) {
        callbacks.delete(handle as number)
      },
      createBlob: (parts, options) => new Blob([...parts], options),
    }
    const rolling = new RollingArenaRecorder(
      { captureStream: () => ({ getTracks: () => [track] }) },
      { environment },
    )
    rolling.start()
    const pending = rolling.captureMoment(1_000)
    rolling.dispose()
    await expect(pending).resolves.toMatchObject({ status: 'fallback', reason: 'not-recording' })
    expect(callbacks.size).toBe(0)
    expect(track.stop).toHaveBeenCalledTimes(1)
  })
})
