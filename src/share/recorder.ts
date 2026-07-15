import fixWebmDuration from 'fix-webm-duration'

export type RollingRecorderStatus =
  | 'idle'
  | 'recording'
  | 'frozen'
  | 'stopped'
  | 'unsupported'
  | 'error'
  | 'disposed'

export type RecorderFallbackReason =
  | 'reduced-motion'
  | 'composition-unavailable'
  | 'capture-stream-unavailable'
  | 'media-recorder-unavailable'
  | 'mime-type-unavailable'
  | 'empty-buffer'
  | 'moment-not-retained'
  | 'moment-outside-buffer'
  | 'not-recording'
  | 'invalid-media-duration'
  | 'memory-ceiling'

export interface MediaStreamTrackLike {
  stop(): void
}

export interface MediaStreamLike {
  getTracks(): readonly MediaStreamTrackLike[]
}

export interface ArenaCaptureCanvas {
  captureStream?: (frameRate?: number) => MediaStreamLike
}

export interface RecorderDataEventLike {
  data: Blob
  /** Native BlobEvent media clock; independent of application timer mocks. */
  timecode?: number
}

export interface RecorderErrorEventLike {
  error?: unknown
}

export interface MediaRecorderLike {
  readonly mimeType: string
  readonly state: 'inactive' | 'recording' | 'paused'
  ondataavailable: ((event: RecorderDataEventLike) => void) | null
  onerror: ((event: RecorderErrorEventLike) => void) | null
  onstop: (() => void) | null
  start(timeslice?: number): void
  stop(): void
  requestData?: () => void
}

export interface RollingRecorderEnvironment {
  createRecorder?: (
    stream: MediaStreamLike,
    options: MediaRecorderOptions,
  ) => MediaRecorderLike
  isTypeSupported?: (mimeType: string) => boolean
  prefersReducedMotion(): boolean
  now(): number
  setTimeout(callback: () => void, milliseconds: number): unknown
  clearTimeout(handle: unknown): void
  createBlob(parts: readonly BlobPart[], options: BlobPropertyBag): Blob
  /**
   * Finalizes container metadata and rejects unseekable/truncated media.
   * Test environments may provide an identity function for synthetic blobs.
   */
  finalizeBlob?: (blob: Blob, durationMs: number) => Promise<Blob>
  /** Synthetic test clocks can opt in; production requires BlobEvent timecodes. */
  trustRecorderClock?: boolean
}

export interface RollingArenaRecorderOptions {
  /** Maximum standalone segment length, clamped to the product's 8–12s contract. */
  bufferDurationMs?: number
  /** Hard ceiling for one finalized segment. */
  maxBytes?: number
  frameRate?: number
  videoBitsPerSecond?: number
  timesliceMs?: number
  /** Explicit product preference; otherwise the browser media query is used. */
  reducedMotion?: boolean
  environment?: RollingRecorderEnvironment
}

export interface RetainMomentOptions {
  /** Recorder-clock timestamp for the authoritative gameplay event. */
  occurredAtMs: number
  /** Small post-event beat. Segment duration still remains within 8–12s. */
  tailMs?: number
  /** Deterministic editorial priority used by the bounded candidate cache. */
  priority?: number
}

export interface RecorderMomentAlignment {
  momentKey: string
  /** Position of the gameplay event inside the exported clip. */
  eventOffsetMs: number
  /** Normalized position of the event inside the exported clip. */
  eventProgress: number
}

export interface RollingRecorderStats {
  status: RollingRecorderStatus
  bytes: number
  chunks: number
  bufferedDurationMs: number
  bufferDurationMs: number
  maxBytes: number
  mimeType: string | null
}

export type RecorderStartResult =
  | { status: 'recording'; mimeType: string }
  | { status: 'unsupported'; reason: RecorderFallbackReason; fallback: 'static-card' }
  | { status: 'error'; error: Error; fallback: 'static-card' }

export type RecorderClipResult =
  | {
      status: 'ready'
      blob: Blob
      durationMs: number
      mimeType: string
      alignment: RecorderMomentAlignment | null
    }
  | { status: 'fallback'; reason: RecorderFallbackReason; fallback: 'static-card' }
  | { status: 'error'; error: Error; fallback: 'static-card' }

interface SegmentChunk {
  blob: Blob
  timecode: number | null
}

interface FinalizedSegment {
  blob: Blob
  durationMs: number
  startedAt: number
  endedAt: number
  mimeType: string
}

interface RetainedMoment {
  result: Extract<RecorderClipResult, { status: 'ready' }>
  priority: number
  retainedAt: number
}

interface PendingMoment {
  key: string
  occurredAtMs: number
  priority: number
  segmentId: number
  promise: Promise<RecorderClipResult>
  resolve: (result: RecorderClipResult) => void
}

const MIME_TYPES = [
  'video/webm;codecs=vp9',
  'video/webm;codecs=vp8',
  'video/webm',
  'video/mp4;codecs=avc1.42E01E',
  'video/mp4',
] as const

const MIN_CLIP_DURATION_MS = 8_000
const MAX_CLIP_DURATION_MS = 12_000
const MAX_RETAINED_MOMENTS = 4
const MEDIA_DURATION_TOLERANCE_MS = 350

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value))
}

function errorOf(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error))
}

async function intrinsicVideoDuration(blob: Blob): Promise<number> {
  if (
    typeof document === 'undefined'
    || typeof URL === 'undefined'
    || typeof URL.createObjectURL !== 'function'
  ) return Number.NaN

  const url = URL.createObjectURL(blob)
  const video = document.createElement('video')
  video.muted = true
  video.preload = 'metadata'
  try {
    return await new Promise<number>((resolve, reject) => {
      let settled = false
      const finish = (action: () => void) => {
        if (settled) return
        settled = true
        globalThis.clearTimeout(timeout)
        video.onloadedmetadata = null
        video.onerror = null
        action()
      }
      const timeout = globalThis.setTimeout(
        () => finish(() => reject(new Error('Clip metadata timed out.'))),
        3_000,
      )
      video.onloadedmetadata = () => finish(() => resolve(video.duration))
      video.onerror = () => finish(() => reject(new Error('Clip metadata could not be decoded.')))
      video.src = url
    })
  } finally {
    video.removeAttribute('src')
    video.load()
    URL.revokeObjectURL(url)
  }
}

async function finalizeBrowserBlob(blob: Blob, durationMs: number): Promise<Blob> {
  const finalized = blob.type.includes('webm')
    ? await fixWebmDuration(blob, durationMs, { logger: false })
    : blob
  const durationSeconds = await intrinsicVideoDuration(finalized)
  if (!Number.isFinite(durationSeconds)) {
    throw new Error('Encoded clip has no finite intrinsic duration.')
  }
  const intrinsicMs = durationSeconds * 1_000
  if (
    intrinsicMs < MIN_CLIP_DURATION_MS - MEDIA_DURATION_TOLERANCE_MS
    || intrinsicMs > MAX_CLIP_DURATION_MS + MEDIA_DURATION_TOLERANCE_MS
  ) {
    throw new Error(`Encoded clip duration ${intrinsicMs.toFixed(0)}ms is outside the contract.`)
  }
  return finalized
}

function browserEnvironment(): RollingRecorderEnvironment {
  const Recorder = globalThis.MediaRecorder
  return {
    createRecorder: Recorder
      ? (stream, options) => new Recorder(stream as MediaStream, options) as unknown as MediaRecorderLike
      : undefined,
    isTypeSupported: Recorder ? Recorder.isTypeSupported.bind(Recorder) : undefined,
    prefersReducedMotion: () =>
      typeof globalThis.matchMedia === 'function'
      && globalThis.matchMedia('(prefers-reduced-motion: reduce)').matches,
    now: () => (typeof performance === 'undefined' ? Date.now() : performance.now()),
    setTimeout: (callback, milliseconds) => globalThis.setTimeout(callback, milliseconds),
    clearTimeout: (handle) => globalThis.clearTimeout(handle as number),
    createBlob: (parts, options) => new Blob([...parts], options),
    finalizeBlob: finalizeBrowserBlob,
    trustRecorderClock: false,
  }
}

function chooseMimeType(environment: RollingRecorderEnvironment): string | null {
  if (!environment.isTypeSupported) return 'video/webm'
  return MIME_TYPES.find((mimeType) => environment.isTypeSupported?.(mimeType)) ?? null
}

function fallback(reason: RecorderFallbackReason): RecorderClipResult {
  return { status: 'fallback', reason, fallback: 'static-card' }
}

/**
 * Records independently finalized 8–12 second segments. Raw MediaRecorder
 * chunks are never trimmed or spliced across segment timelines: each exported
 * candidate owns its header, zero-based cluster timestamps, terminal chunk,
 * and finite container duration.
 */
export class RollingArenaRecorder {
  private readonly canvas: ArenaCaptureCanvas
  private readonly environment: RollingRecorderEnvironment
  private readonly bufferDurationMs: number
  private readonly maxBytes: number
  private readonly frameRate: number
  private readonly videoBitsPerSecond: number
  private readonly timesliceMs: number
  private readonly reducedMotion: boolean | undefined
  private readonly pendingTimers = new Map<unknown, () => void>()
  private recorder: MediaRecorderLike | null = null
  private stream: MediaStreamLike | null = null
  private segmentStartedAt: number | null = null
  private segmentId = 0
  private segmentChunks: SegmentChunk[] = []
  private segmentBytes = 0
  private segmentBoundaryTimer: unknown = null
  private finalizePromise: Promise<FinalizedSegment | null> | null = null
  private latestSegment: FinalizedSegment | null = null
  private mimeType: string | null = null
  private status: RollingRecorderStatus = 'idle'
  private lastError: Error | null = null
  private lastSegmentFailure: RecorderFallbackReason = 'empty-buffer'
  private readonly retainedMoments = new Map<string, RetainedMoment>()
  private readonly pendingMoments = new Map<string, PendingMoment>()
  private readonly latestMomentSlots = new Map<string, string>()

  constructor(canvas: ArenaCaptureCanvas, options: RollingArenaRecorderOptions = {}) {
    this.canvas = canvas
    this.environment = options.environment ?? browserEnvironment()
    this.bufferDurationMs = clamp(
      options.bufferDurationMs ?? 10_000,
      MIN_CLIP_DURATION_MS,
      MAX_CLIP_DURATION_MS,
    )
    this.maxBytes = Math.max(1_048_576, Math.floor(options.maxBytes ?? 16 * 1_048_576))
    this.frameRate = clamp(Math.floor(options.frameRate ?? 30), 12, 60)
    this.videoBitsPerSecond = clamp(
      Math.floor(options.videoBitsPerSecond ?? 2_400_000),
      500_000,
      5_000_000,
    )
    this.timesliceMs = clamp(Math.floor(options.timesliceMs ?? 500), 250, 2_000)
    this.reducedMotion = options.reducedMotion
  }

  start(): RecorderStartResult {
    if (this.status === 'recording' && this.mimeType) {
      return { status: 'recording', mimeType: this.mimeType }
    }
    if (this.status === 'disposed') {
      return { status: 'error', error: new Error('Recorder has been disposed.'), fallback: 'static-card' }
    }
    if (this.reducedMotion ?? this.environment.prefersReducedMotion()) {
      this.status = 'unsupported'
      return { status: 'unsupported', reason: 'reduced-motion', fallback: 'static-card' }
    }
    if (typeof this.canvas.captureStream !== 'function') {
      this.status = 'unsupported'
      return { status: 'unsupported', reason: 'capture-stream-unavailable', fallback: 'static-card' }
    }
    if (!this.environment.createRecorder) {
      this.status = 'unsupported'
      return { status: 'unsupported', reason: 'media-recorder-unavailable', fallback: 'static-card' }
    }
    const mimeType = chooseMimeType(this.environment)
    if (!mimeType) {
      this.status = 'unsupported'
      return { status: 'unsupported', reason: 'mime-type-unavailable', fallback: 'static-card' }
    }

    try {
      this.releaseRecorderAndStream()
      this.clearAllMedia()
      this.retainedMoments.clear()
      this.latestMomentSlots.clear()
      this.resolveAllPending(fallback('not-recording'))
      this.lastError = null
      this.lastSegmentFailure = 'empty-buffer'
      this.mimeType = mimeType
      this.stream = this.canvas.captureStream(this.frameRate)
      this.status = 'recording'
      this.startSegment()
      return { status: 'recording', mimeType }
    } catch (error) {
      const normalized = errorOf(error)
      this.fail(normalized)
      return { status: 'error', error: normalized, fallback: 'static-card' }
    }
  }

  async captureMoment(tailMs = 1_000): Promise<RecorderClipResult> {
    if (this.status === 'frozen') return this.resultFromSegment(this.latestSegment, null)
    if (this.status !== 'recording' || !this.recorder || !this.mimeType) {
      return this.unavailableResult()
    }
    await this.delay(clamp(tailMs, 0, 2_000))
    if (this.status !== 'recording') return this.unavailableResult()
    const segment = await this.finalizeSegment(true)
    return this.resultFromSegment(segment, null)
  }

  /**
   * Binds a live event to the one standalone segment already recording it.
   * The segment finalizes after both an editorial tail and the eight-second
   * minimum, then recording immediately resumes in a fresh container.
   */
  retainMoment(momentKey: string, options: RetainMomentOptions): Promise<RecorderClipResult> {
    const key = momentKey.trim().slice(0, 96)
    if (!key) return Promise.resolve(fallback('moment-not-retained'))
    const retained = this.retainedMoments.get(key)
    if (retained) return Promise.resolve(retained.result)
    const pending = this.pendingMoments.get(key)
    if (pending) return pending.promise

    const occurredAtMs = Number.isFinite(options.occurredAtMs)
      ? options.occurredAtMs
      : this.environment.now()
    const recent = this.latestSegment
    if (
      recent
      && occurredAtMs >= recent.startedAt - this.timesliceMs
      && occurredAtMs <= recent.endedAt + this.timesliceMs
    ) {
      const result = this.resultFromSegment(recent, { key, occurredAtMs })
      if (result.status === 'ready') this.storeRetainedMoment(key, result, options.priority ?? 0)
      return Promise.resolve(result)
    }

    if (
      this.status !== 'recording'
      || !this.recorder
      || this.segmentStartedAt === null
    ) return Promise.resolve(this.unavailableResult())

    const now = this.environment.now()
    if (
      occurredAtMs < this.segmentStartedAt - this.timesliceMs
      || occurredAtMs > now + this.timesliceMs
    ) return Promise.resolve(fallback('moment-outside-buffer'))

    let resolve!: (result: RecorderClipResult) => void
    const promise = new Promise<RecorderClipResult>((done) => { resolve = done })
    const entry: PendingMoment = {
      key,
      occurredAtMs,
      priority: Number.isFinite(options.priority) ? options.priority ?? 0 : 0,
      segmentId: this.segmentId,
      promise,
      resolve,
    }
    this.pendingMoments.set(key, entry)

    const age = Math.max(0, now - this.segmentStartedAt)
    const eventAge = clamp(occurredAtMs - this.segmentStartedAt, 0, this.bufferDurationMs)
    const requestedTail = clamp(options.tailMs ?? 700, 0, 2_000)
    const targetAge = Math.min(
      this.bufferDurationMs,
      Math.max(MIN_CLIP_DURATION_MS + this.timesliceMs, eventAge + requestedTail),
    )
    const waitMs = Math.max(0, targetAge - age)
    const boundSegment = this.segmentId
    void this.delay(waitMs).then(() => {
      if (
        this.status === 'recording'
        && this.segmentId === boundSegment
        && this.pendingMoments.has(key)
      ) void this.finalizeSegment(true)
    })
    return promise
  }

  /**
   * Keeps one truthful live candidate for a logical editorial slot. A newer
   * authoritative event replaces an unresolved predecessor in the same
   * segment; an already finalized predecessor is released only after the new
   * standalone segment is safely retained.
   */
  retainLatestMoment(
    slotKey: string,
    momentKey: string,
    options: RetainMomentOptions,
  ): Promise<RecorderClipResult> {
    const slot = slotKey.trim().slice(0, 48)
    const key = momentKey.trim().slice(0, 96)
    if (!slot || !key) return Promise.resolve(fallback('moment-not-retained'))
    const previousKey = this.latestMomentSlots.get(slot)
    if (previousKey === key) return this.retainMoment(key, options)

    const operation = this.retainMoment(key, options)
    this.latestMomentSlots.set(slot, key)
    if (previousKey) {
      const pending = this.pendingMoments.get(previousKey)
      if (pending) {
        this.pendingMoments.delete(previousKey)
        pending.resolve(fallback('moment-not-retained'))
      }
    }

    return operation.then((result) => {
      if (this.latestMomentSlots.get(slot) !== key) {
        this.retainedMoments.delete(key)
        return result
      }
      if (result.status === 'ready' && previousKey) {
        this.retainedMoments.delete(previousKey)
      }
      return result
    })
  }

  /** Returns only the requested event segment; never a later unrelated tail. */
  async captureRetainedMoment(momentKey: string): Promise<RecorderClipResult> {
    const key = momentKey.trim().slice(0, 96)
    const pending = this.pendingMoments.get(key)
    if (pending) await pending.promise
    return this.retainedMoments.get(key)?.result ?? fallback('moment-not-retained')
  }

  /** Stops encoder work and tracks after producing one complete final segment. */
  async freeze(tailMs = 0, ensureMinimumDuration = true): Promise<void> {
    if (this.status !== 'recording') return
    this.cancelSegmentBoundary()
    const age = this.segmentStartedAt === null
      ? 0
      : Math.max(0, this.environment.now() - this.segmentStartedAt)
    const minimumWait = ensureMinimumDuration
      ? Math.max(0, MIN_CLIP_DURATION_MS + this.timesliceMs - age)
      : 0
    await this.delay(Math.max(clamp(tailMs, 0, 2_000), minimumWait))
    if (this.status !== 'recording') return
    await this.finalizeSegment(false)
    this.status = 'frozen'
    this.releaseStream()
  }

  stop(): void {
    if (this.status === 'disposed') return
    this.cancelSegmentBoundary()
    this.releaseRecorderAndStream()
    this.clearAllMedia()
    this.retainedMoments.clear()
    this.latestMomentSlots.clear()
    this.resolveAllPending(fallback('not-recording'))
    if (this.status !== 'error' && this.status !== 'unsupported') this.status = 'stopped'
  }

  dispose(): void {
    if (this.status === 'disposed') return
    this.cancelSegmentBoundary()
    this.releaseRecorderAndStream()
    for (const [handle, resolve] of this.pendingTimers) {
      this.environment.clearTimeout(handle)
      resolve()
    }
    this.pendingTimers.clear()
    this.clearAllMedia()
    this.retainedMoments.clear()
    this.latestMomentSlots.clear()
    this.resolveAllPending(fallback('not-recording'))
    this.status = 'disposed'
  }

  getStats(): RollingRecorderStats {
    const now = this.environment.now()
    const activeDuration = this.segmentStartedAt === null
      ? this.latestSegment?.durationMs ?? 0
      : clamp(now - this.segmentStartedAt, 0, this.bufferDurationMs)
    return {
      status: this.status,
      bytes: this.segmentBytes || this.latestSegment?.blob.size || 0,
      chunks: this.segmentChunks.length || (this.latestSegment ? 1 : 0),
      bufferedDurationMs: activeDuration,
      bufferDurationMs: this.bufferDurationMs,
      maxBytes: this.maxBytes,
      mimeType: this.mimeType,
    }
  }

  private startSegment(): void {
    if (
      this.status !== 'recording'
      || !this.stream
      || !this.mimeType
      || !this.environment.createRecorder
    ) return
    this.cancelSegmentBoundary()
    this.segmentId += 1
    this.segmentStartedAt = this.environment.now()
    this.segmentChunks = []
    this.segmentBytes = 0
    const recorder = this.environment.createRecorder(this.stream, {
      mimeType: this.mimeType,
      videoBitsPerSecond: this.videoBitsPerSecond,
    })
    recorder.ondataavailable = (event) => this.retainChunk(event)
    recorder.onerror = (event) => this.fail(event.error ?? new Error('MediaRecorder failed.'))
    recorder.onstop = null
    this.recorder = recorder
    recorder.start(this.timesliceMs)
    const segmentId = this.segmentId
    this.segmentBoundaryTimer = this.environment.setTimeout(() => {
      this.segmentBoundaryTimer = null
      if (this.status === 'recording' && this.segmentId === segmentId) {
        void this.finalizeSegment(true)
      }
    }, this.bufferDurationMs)
  }

  private async finalizeSegment(restart: boolean): Promise<FinalizedSegment | null> {
    if (this.finalizePromise) {
      const current = await this.finalizePromise
      if (!restart && this.status === 'recording' && this.recorder) {
        return this.finalizeSegment(false)
      }
      return current
    }
    if (!this.recorder || this.segmentStartedAt === null || !this.mimeType) return null

    const operation = this.performFinalizeSegment(restart)
    this.finalizePromise = operation
    try {
      return await operation
    } finally {
      if (this.finalizePromise === operation) this.finalizePromise = null
    }
  }

  private async performFinalizeSegment(restart: boolean): Promise<FinalizedSegment | null> {
    const recorder = this.recorder
    const startedAt = this.segmentStartedAt
    const segmentId = this.segmentId
    const mimeType = this.mimeType
    if (!recorder || startedAt === null || !mimeType) return null
    this.cancelSegmentBoundary()

    try {
      recorder.requestData?.()
      await this.delay(0)
      await this.stopRecorder(recorder)
    } catch (error) {
      this.fail(error)
      return null
    }

    if (this.recorder === recorder) this.recorder = null
    recorder.ondataavailable = null
    recorder.onerror = null
    recorder.onstop = null
    const endedAt = this.environment.now()
    const chunks = this.segmentChunks
    const bytes = this.segmentBytes
    this.segmentChunks = []
    this.segmentBytes = 0
    this.segmentStartedAt = null

    let segment: FinalizedSegment | null = null
    let failureReason: RecorderFallbackReason = 'empty-buffer'
    const durationMs = this.evidencedDurationMs(startedAt, endedAt, chunks)
    if (bytes > this.maxBytes) {
      failureReason = 'memory-ceiling'
    } else if (chunks.length > 0 && durationMs < MIN_CLIP_DURATION_MS) {
      failureReason = 'invalid-media-duration'
    } else if (chunks.length > 0) {
      try {
        const raw = this.environment.createBlob(
          chunks.map((chunk) => chunk.blob),
          { type: mimeType },
        )
        const finalized = await (this.environment.finalizeBlob?.(raw, durationMs)
          ?? Promise.resolve(raw))
        segment = { blob: finalized, durationMs, startedAt, endedAt, mimeType }
        this.latestSegment = segment
        this.lastSegmentFailure = 'empty-buffer'
      } catch {
        failureReason = 'invalid-media-duration'
      }
    }

    if (!segment) this.lastSegmentFailure = failureReason
    this.resolveSegmentMoments(segmentId, segment, failureReason)
    if (restart && this.status === 'recording' && this.stream) this.startSegment()
    return segment
  }

  private evidencedDurationMs(
    startedAt: number,
    endedAt: number,
    chunks: readonly SegmentChunk[],
  ): number {
    const wallDuration = clamp(endedAt - startedAt, 0, this.bufferDurationMs)
    if (this.environment.trustRecorderClock !== false) return wallDuration
    const timecodes = chunks
      .map((chunk) => chunk.timecode)
      .filter((value): value is number => value !== null)
    if (timecodes.length < 2) return 0
    const mediaSpan = Math.max(0, (timecodes.at(-1) ?? 0) - (timecodes[0] ?? 0))
    // The final BlobEvent marks its first chunk, so allow at most one declared
    // timeslice for the terminal chunk. A mocked app clock cannot manufacture
    // eight seconds of media evidence from one second of encoded frames.
    return clamp(
      Math.min(wallDuration, mediaSpan + this.timesliceMs),
      0,
      this.bufferDurationMs,
    )
  }

  private stopRecorder(recorder: MediaRecorderLike): Promise<void> {
    if (recorder.state === 'inactive') return Promise.resolve()
    return new Promise((resolve) => {
      let settled = false
      let timeout: unknown = null
      const finish = () => {
        if (settled) return
        settled = true
        if (timeout !== null) this.environment.clearTimeout(timeout)
        resolve()
      }
      recorder.onstop = finish
      timeout = this.environment.setTimeout(finish, 1_000)
      try {
        recorder.stop()
      } catch {
        finish()
      }
    })
  }

  private retainChunk(event: RecorderDataEventLike): void {
    if (event.data.size === 0) return
    const timecode = typeof event.timecode === 'number' && Number.isFinite(event.timecode)
      ? event.timecode
      : null
    this.segmentChunks.push({ blob: event.data, timecode })
    this.segmentBytes += event.data.size
    if (this.segmentBytes > this.maxBytes) void this.finalizeSegment(true)
  }

  private resultFromSegment(
    segment: FinalizedSegment | null,
    moment: { key: string; occurredAtMs: number } | null,
  ): RecorderClipResult {
    if (!segment) return fallback(this.lastSegmentFailure)
    let alignment: RecorderMomentAlignment | null = null
    if (moment) {
      if (
        moment.occurredAtMs < segment.startedAt - this.timesliceMs
        || moment.occurredAtMs > segment.endedAt + this.timesliceMs
      ) return fallback('moment-outside-buffer')
      const eventOffsetMs = clamp(
        moment.occurredAtMs - segment.startedAt,
        0,
        segment.durationMs,
      )
      alignment = {
        momentKey: moment.key,
        eventOffsetMs,
        eventProgress: segment.durationMs > 0 ? eventOffsetMs / segment.durationMs : 0,
      }
    }
    return {
      status: 'ready',
      blob: segment.blob,
      durationMs: segment.durationMs,
      mimeType: segment.mimeType,
      alignment,
    }
  }

  private resolveSegmentMoments(
    segmentId: number,
    segment: FinalizedSegment | null,
    failureReason: RecorderFallbackReason,
  ): void {
    for (const [key, pending] of this.pendingMoments) {
      if (pending.segmentId !== segmentId) continue
      const result = segment
        ? this.resultFromSegment(segment, { key, occurredAtMs: pending.occurredAtMs })
        : fallback(failureReason)
      if (result.status === 'ready') {
        this.storeRetainedMoment(key, result, pending.priority)
      }
      pending.resolve(result)
      this.pendingMoments.delete(key)
    }
  }

  private storeRetainedMoment(
    key: string,
    result: Extract<RecorderClipResult, { status: 'ready' }>,
    priority: number,
  ): void {
    const boundedPriority = Number.isFinite(priority) ? priority : 0
    if (this.retainedMoments.size >= MAX_RETAINED_MOMENTS) {
      const lowest = [...this.retainedMoments.entries()].sort(
        ([leftKey, left], [rightKey, right]) =>
          left.priority - right.priority
          || left.retainedAt - right.retainedAt
          || leftKey.localeCompare(rightKey),
      )[0]
      if (lowest && boundedPriority <= lowest[1].priority) return
      if (lowest) this.retainedMoments.delete(lowest[0])
    }
    this.retainedMoments.set(key, {
      result,
      priority: boundedPriority,
      retainedAt: this.environment.now(),
    })
  }

  private unavailableResult(): RecorderClipResult {
    if (this.status === 'error' && this.lastError) {
      return { status: 'error', error: this.lastError, fallback: 'static-card' }
    }
    return fallback('not-recording')
  }

  private fail(error: unknown): void {
    this.lastError = errorOf(error)
    this.status = 'error'
    this.cancelSegmentBoundary()
    this.releaseRecorderAndStream()
    this.segmentChunks = []
    this.segmentBytes = 0
    this.segmentStartedAt = null
    this.resolveAllPending({ status: 'error', error: this.lastError, fallback: 'static-card' })
  }

  private releaseRecorderAndStream(): void {
    const recorder = this.recorder
    this.recorder = null
    if (recorder) {
      recorder.ondataavailable = null
      recorder.onerror = null
      recorder.onstop = null
      try {
        if (recorder.state !== 'inactive') recorder.stop()
      } catch {
        // Disposal still releases every capture track below.
      }
    }
    this.releaseStream()
  }

  private releaseStream(): void {
    const stream = this.stream
    this.stream = null
    for (const track of stream?.getTracks() ?? []) {
      try {
        track.stop()
      } catch {
        // Track cleanup is best effort across browser implementations.
      }
    }
  }

  private clearAllMedia(): void {
    this.cancelSegmentBoundary()
    this.segmentChunks = []
    this.segmentBytes = 0
    this.segmentStartedAt = null
    this.latestSegment = null
    this.finalizePromise = null
  }

  private resolveAllPending(result: RecorderClipResult): void {
    for (const pending of this.pendingMoments.values()) pending.resolve(result)
    this.pendingMoments.clear()
  }

  private cancelSegmentBoundary(): void {
    if (this.segmentBoundaryTimer === null) return
    this.environment.clearTimeout(this.segmentBoundaryTimer)
    this.segmentBoundaryTimer = null
  }

  private delay(milliseconds: number): Promise<void> {
    return new Promise((resolve) => {
      let handle: unknown
      let completed = false
      const finish = () => {
        completed = true
        this.pendingTimers.delete(handle)
        resolve()
      }
      handle = this.environment.setTimeout(finish, milliseconds)
      if (!completed) this.pendingTimers.set(handle, resolve)
    })
  }
}

export function createRollingArenaRecorder(
  canvas: ArenaCaptureCanvas,
  options: RollingArenaRecorderOptions = {},
): RollingArenaRecorder {
  return new RollingArenaRecorder(canvas, options)
}
