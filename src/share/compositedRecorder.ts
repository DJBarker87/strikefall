import { shareClipDimensions } from './clipLayout'
import { RollingArenaRecorder } from './recorder'
import type {
  MediaStreamLike,
  RecorderClipResult,
  RecorderStartResult,
  RetainMomentOptions,
  RollingArenaRecorderOptions,
} from './recorder'
import { renderShareClipFrame } from './renderClipFrame'
import type { ShareClipFrameSource } from './renderClipFrame'
import type { ShareCardData, ShareClipFormat } from './types'

const FORMATS = [
  'portrait-9x16',
  'square-1x1',
  'landscape-16x9',
] as const satisfies readonly ShareClipFormat[]

export interface ShareClipCanvasSurface extends ShareClipFrameSource {
  getContext(contextId: '2d'): CanvasRenderingContext2D | null
  captureStream?: (frameRate?: number) => MediaStreamLike
}

export interface CompositedShareRecorderEnvironment {
  createCanvas(width: number, height: number): ShareClipCanvasSurface
  now(): number
  requestFrame(callback: () => void): unknown
  cancelFrame(handle: unknown): void
}

export interface CompositedShareRecorderOptions {
  environment?: CompositedShareRecorderEnvironment
  recorder?: RollingArenaRecorderOptions
  /** Composition redraw rate. Recording is intentionally capped for mobile heat/battery. */
  frameRate?: number
}

export type ShareClipCaptureResult =
  | (Extract<RecorderClipResult, { status: 'ready' }> & {
      format: ShareClipFormat
      width: number
      height: number
    })
  | Exclude<RecorderClipResult, { status: 'ready' }>

export type ShareClipStartReport = Readonly<Record<ShareClipFormat, RecorderStartResult>>

export type ShareClipMomentReport = Readonly<Record<ShareClipFormat, RecorderClipResult>>

interface ClipEntry {
  format: ShareClipFormat
  width: number
  height: number
  canvas: ShareClipCanvasSurface
  context: CanvasRenderingContext2D
  recorder: RollingArenaRecorder
}

function defaultEnvironment(): CompositedShareRecorderEnvironment | null {
  if (typeof document === 'undefined' || typeof document.createElement !== 'function') return null
  return {
    createCanvas(width, height) {
      const canvas = document.createElement('canvas')
      canvas.width = width
      canvas.height = height
      return canvas as unknown as ShareClipCanvasSurface
    },
    now: () => (typeof performance === 'undefined' ? Date.now() : performance.now()),
    requestFrame: (callback) => {
      if (typeof requestAnimationFrame === 'function') return requestAnimationFrame(callback)
      return globalThis.setTimeout(callback, 16)
    },
    cancelFrame: (handle) => {
      if (typeof cancelAnimationFrame === 'function') cancelAnimationFrame(handle as number)
      else globalThis.clearTimeout(handle as number)
    },
  }
}

function unavailableStart(): RecorderStartResult {
  return {
    status: 'unsupported',
    reason: 'composition-unavailable',
    fallback: 'static-card',
  }
}

/**
 * Maintains three bounded rolling encoders so the player can choose Story,
 * Square, or Wide after the dramatic moment. Only public ShareCardData reaches the
 * overlay renderer; source round IDs, seeds and proof internals are excluded.
 */
export class CompositedShareRecorder {
  private readonly source: ShareClipFrameSource
  private readonly environment: CompositedShareRecorderEnvironment | null
  private readonly entries: ClipEntry[] = []
  private readonly frameIntervalMs: number
  private data: ShareCardData
  private frameHandle: unknown = null
  private lastFrameAt = Number.NEGATIVE_INFINITY
  private disposed = false
  private running = false
  private freezePromise: Promise<void> | null = null
  private readonly momentPromises = new Map<string, Promise<ShareClipMomentReport>>()
  private readonly latestMomentSlots = new Map<string, string>()

  constructor(
    source: ShareClipFrameSource,
    data: ShareCardData,
    options: CompositedShareRecorderOptions = {},
  ) {
    this.source = source
    this.data = data
    this.environment = options.environment ?? defaultEnvironment()
    const frameRate = Math.min(24, Math.max(12, Math.floor(options.frameRate ?? 15)))
    this.frameIntervalMs = 1_000 / frameRate
    if (!this.environment) return

    for (const format of FORMATS) {
      const [width, height] = shareClipDimensions(format)
      const canvas = this.environment.createCanvas(width, height)
      canvas.width = width
      canvas.height = height
      const context = canvas.getContext('2d')
      if (!context) continue
      const recorder = new RollingArenaRecorder(canvas, {
        bufferDurationMs: 11_000,
        maxBytes: 6 * 1_048_576,
        frameRate,
        videoBitsPerSecond: 1_600_000,
        timesliceMs: 500,
        ...options.recorder,
      })
      this.entries.push({ format, width, height, canvas, context, recorder })
    }
  }

  update(data: ShareCardData): void {
    if (this.disposed) return
    this.data = data
  }

  start(): ShareClipStartReport {
    const report = Object.fromEntries(
      FORMATS.map((format) => [format, unavailableStart()]),
    ) as Record<ShareClipFormat, RecorderStartResult>
    if (this.disposed) return report

    this.drawAll()
    for (const entry of this.entries) report[entry.format] = entry.recorder.start()
    this.running = this.entries.some((entry) => report[entry.format].status === 'recording')
    if (this.running) this.scheduleFrame()
    return report
  }

  async captureMoment(format: ShareClipFormat, tailMs = 700): Promise<ShareClipCaptureResult> {
    if (this.disposed) {
      return { status: 'fallback', reason: 'not-recording', fallback: 'static-card' }
    }
    const entry = this.entries.find((candidate) => candidate.format === format)
    if (!entry) {
      return { status: 'fallback', reason: 'composition-unavailable', fallback: 'static-card' }
    }
    if (this.freezePromise) await this.freezePromise
    this.drawAll()
    const result = await entry.recorder.captureMoment(this.freezePromise ? 0 : tailMs)
    if (result.status !== 'ready') return result
    return {
      ...result,
      format,
      width: entry.width,
      height: entry.height,
    }
  }

  /**
   * Retains the same authoritative event window in Story, Square, and Wide.
   * Recording continues so later, higher-impact candidates can also be kept.
   */
  retainMoment(
    momentKey: string,
    options: RetainMomentOptions,
  ): Promise<ShareClipMomentReport> {
    const existing = this.momentPromises.get(momentKey)
    if (existing) return existing
    this.drawAll()
    const operation = Promise.all(
      FORMATS.map(async (format) => {
        const entry = this.entries.find((candidate) => candidate.format === format)
        const result = entry
          ? await entry.recorder.retainMoment(momentKey, options)
          : { status: 'fallback', reason: 'composition-unavailable', fallback: 'static-card' } as const
        return [format, result] as const
      }),
    ).then((entries) => Object.fromEntries(entries) as Record<ShareClipFormat, RecorderClipResult>)
    this.momentPromises.set(momentKey, operation)
    return operation
  }

  /** Retains only the newest authoritative candidate for a bounded live slot. */
  retainLatestMoment(
    slotKey: string,
    momentKey: string,
    options: RetainMomentOptions,
  ): Promise<ShareClipMomentReport> {
    const slot = slotKey.trim().slice(0, 48)
    const key = momentKey.trim().slice(0, 96)
    if (!slot || !key) return this.retainMoment(momentKey, options)
    const previousKey = this.latestMomentSlots.get(slot)
    if (previousKey === key) {
      return this.momentPromises.get(key) ?? this.retainMoment(key, options)
    }

    this.drawAll()
    const operation = Promise.all(
      FORMATS.map(async (format) => {
        const entry = this.entries.find((candidate) => candidate.format === format)
        const result = entry
          ? await entry.recorder.retainLatestMoment(slot, key, options)
          : { status: 'fallback', reason: 'composition-unavailable', fallback: 'static-card' } as const
        return [format, result] as const
      }),
    ).then((entries) => Object.fromEntries(entries) as Record<ShareClipFormat, RecorderClipResult>)
    this.latestMomentSlots.set(slot, key)
    this.momentPromises.set(key, operation)
    if (previousKey) this.momentPromises.delete(previousKey)
    return operation
  }

  /** Exports only the matching retained candidate; never a temporally unrelated tail. */
  async captureRetainedMoment(
    format: ShareClipFormat,
    momentKey: string,
  ): Promise<ShareClipCaptureResult> {
    if (this.disposed) {
      return { status: 'fallback', reason: 'not-recording', fallback: 'static-card' }
    }
    const entry = this.entries.find((candidate) => candidate.format === format)
    if (!entry) {
      return { status: 'fallback', reason: 'composition-unavailable', fallback: 'static-card' }
    }
    await this.momentPromises.get(momentKey)
    if (this.freezePromise) await this.freezePromise
    const result = await entry.recorder.captureRetainedMoment(momentKey)
    if (result.status !== 'ready') return result
    return {
      ...result,
      format,
      width: entry.width,
      height: entry.height,
    }
  }

  /** Stops RAF, encoders and media tracks after a short branded result tail. */
  freeze(tailMs = 700): Promise<void> {
    if (this.disposed) return Promise.resolve()
    if (this.freezePromise) return this.freezePromise
    this.freezePromise = (async () => {
      await Promise.all(this.momentPromises.values())
      this.drawAll()
      this.running = false
      if (this.frameHandle !== null) this.environment?.cancelFrame(this.frameHandle)
      this.frameHandle = null
      const needsGenericResultTail = this.momentPromises.size === 0
      await Promise.all(this.entries.map((entry) =>
        entry.recorder.freeze(tailMs, needsGenericResultTail)))
    })()
    return this.freezePromise
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.running = false
    if (this.frameHandle !== null) this.environment?.cancelFrame(this.frameHandle)
    this.frameHandle = null
    this.momentPromises.clear()
    this.latestMomentSlots.clear()
    for (const entry of this.entries) entry.recorder.dispose()
  }

  private drawAll(): void {
    if (this.disposed) return
    for (const entry of this.entries) {
      renderShareClipFrame(entry.context, this.source, this.data, entry.format)
    }
    this.lastFrameAt = this.environment?.now() ?? this.lastFrameAt
  }

  private scheduleFrame(): void {
    if (!this.running || this.disposed || !this.environment || this.frameHandle !== null) return
    this.frameHandle = this.environment.requestFrame(() => {
      this.frameHandle = null
      if (!this.running || this.disposed || !this.environment) return
      const now = this.environment.now()
      if (now - this.lastFrameAt >= this.frameIntervalMs) this.drawAll()
      this.scheduleFrame()
    })
  }
}

export function createCompositedShareRecorder(
  source: ShareClipFrameSource,
  data: ShareCardData,
  options: CompositedShareRecorderOptions = {},
): CompositedShareRecorder {
  return new CompositedShareRecorder(source, data, options)
}
