import type { DeckDefinition, GamePhase, RoundSummary } from '../game/types'

export interface SoundControllerOptions {
  muted?: boolean
  /** Master volume from 0 to 1. The synthesizer keeps additional headroom. */
  volume?: number
}

export interface HitSoundOptions {
  /** Zero-based position inside a cluster cascade. */
  clusterIndex?: number
  clusterSize?: number
  player?: boolean
}

export type SoundResult = RoundSummary | RoundSummary['outcome'] | 'escaped'

export interface StrikefallSoundApi {
  readonly supported: boolean
  readonly unlocked: boolean
  unlock: () => Promise<boolean>
  setMuted: (muted: boolean) => void
  setVolume: (volume: number) => void
  playPhase: (phase: GamePhase, deck?: DeckDefinition) => void
  playPlacementTone: (risk: number, crowd?: number) => void
  playCountdown: (seconds: number) => void
  playHit: (options?: HitSoundOptions) => void
  playEscape: () => void
  playResult: (result: SoundResult) => void
  stopAll: () => void
  dispose: () => void
}

interface ToneOptions {
  attack?: number
  detune?: number
  endFrequency?: number
  gain?: number
  start?: number
  type?: OscillatorType
}

interface NoiseOptions {
  filterFrequency?: number
  filterType?: BiquadFilterType
  gain?: number
  playbackRate?: number
  start?: number
}

type AudioContextConstructor = typeof AudioContext

const MIN_GAIN = 0.000_1

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

function contextConstructor(): AudioContextConstructor | undefined {
  if (typeof window === 'undefined') return undefined
  return (
    window.AudioContext ??
    (window as Window & { webkitAudioContext?: AudioContextConstructor }).webkitAudioContext
  )
}

function outcomeOf(result: SoundResult): RoundSummary['outcome'] | 'escaped' {
  return typeof result === 'string' ? result : result.outcome
}

/**
 * A small procedural Web Audio score for Strikefall. It intentionally ships no
 * samples: every cue is generated from oscillators and filtered noise, keeping
 * startup instant and making the sound layer safe to lazy-unlock on first input.
 */
export class StrikefallSoundController implements StrikefallSoundApi {
  private context: AudioContext | null = null
  private compressor: DynamicsCompressorNode | null = null
  private master: GainNode | null = null
  private noiseBuffer: AudioBuffer | null = null
  private sources = new Set<AudioScheduledSourceNode>()
  private muted: boolean
  private volume: number
  private disposed = false
  private lastPhase: GamePhase | null = null
  private lastCountdown: number | null = null
  private lastPlacementAt = 0
  private lastPlacementBand = -1

  constructor(options: SoundControllerOptions = {}) {
    this.muted = options.muted ?? false
    this.volume = clamp(options.volume ?? 0.72, 0, 1)
  }

  get supported(): boolean {
    return Boolean(contextConstructor())
  }

  get unlocked(): boolean {
    return this.context?.state === 'running'
  }

  async unlock(): Promise<boolean> {
    const context = this.ensureContext()
    if (!context) return false
    try {
      if (context.state === 'suspended') await context.resume()
      // A zero-volume pulse reliably primes Web Audio on older iOS versions.
      if (context.state === 'running') {
        const oscillator = context.createOscillator()
        const gain = context.createGain()
        gain.gain.value = 0
        oscillator.connect(gain)
        gain.connect(context.destination)
        oscillator.start()
        oscillator.stop(context.currentTime + 0.01)
      }
      return context.state === 'running'
    } catch {
      return false
    }
  }

  setMuted(muted: boolean): void {
    this.muted = muted
    this.updateMasterGain()
  }

  setVolume(volume: number): void {
    this.volume = clamp(volume, 0, 1)
    this.updateMasterGain()
  }

  playPhase(phase: GamePhase, deck?: DeckDefinition): void {
    if (phase === this.lastPhase) return
    this.lastPhase = phase
    this.lastCountdown = null
    switch (phase) {
      case 'home':
        break
      case 'deck':
        this.playDeckReveal(deck)
        break
      case 'approach':
        this.tone(126, 0.34, {
          type: 'sine',
          endFrequency: 188,
          gain: 0.035,
          attack: 0.045,
        })
        break
      case 'placement':
        this.tone(392, 0.14, { type: 'triangle', gain: 0.045 })
        this.tone(587.33, 0.2, { type: 'sine', gain: 0.028, start: 0.07 })
        break
      case 'lock':
        this.noise(0.16, {
          filterType: 'lowpass',
          filterFrequency: 620,
          gain: 0.11,
        })
        this.tone(92.5, 0.32, {
          type: 'sine',
          endFrequency: 61.7,
          gain: 0.13,
          attack: 0.006,
        })
        this.tone(277.18, 0.18, {
          type: 'triangle',
          endFrequency: 207.65,
          gain: 0.042,
        })
        break
      case 'battle':
        this.noise(0.48, {
          filterType: 'bandpass',
          filterFrequency: 420,
          gain: 0.045,
          playbackRate: 0.78,
        })
        this.tone(73.42, 0.55, {
          type: 'sine',
          endFrequency: 110,
          gain: 0.075,
          attack: 0.08,
        })
        this.tone(220, 0.24, {
          type: 'triangle',
          endFrequency: 330,
          gain: 0.028,
          start: 0.14,
        })
        break
      case 'result':
        // The caller follows with playResult, which can express the outcome.
        break
    }
  }

  playPlacementTone(risk: number, crowd = 1): void {
    const now = typeof performance === 'undefined' ? Date.now() : performance.now()
    const riskBand = Math.round(clamp(risk, 1, 8) * 3)
    if (now - this.lastPlacementAt < 72 && riskBand === this.lastPlacementBand) return
    this.lastPlacementAt = now
    this.lastPlacementBand = riskBand
    const normalizedRisk = (clamp(risk, 1, 8) - 1) / 7
    const frequency = 190 + normalizedRisk * 690
    this.tone(frequency, 0.075, {
      type: normalizedRisk > 0.68 ? 'triangle' : 'sine',
      endFrequency: frequency * 1.035,
      gain: 0.018 + normalizedRisk * 0.022,
      attack: 0.006,
    })
    if (crowd < 0.96) {
      const tension = clamp((0.96 - crowd) / 0.3, 0, 1)
      this.tone(frequency * 0.985, 0.09, {
        type: 'sine',
        detune: -8 - tension * 15,
        gain: 0.009 + tension * 0.011,
        start: 0.012,
      })
    }
  }

  playCountdown(seconds: number): void {
    const wholeSeconds = Math.ceil(seconds)
    if (wholeSeconds <= 0 || wholeSeconds > 10 || wholeSeconds === this.lastCountdown) return
    this.lastCountdown = wholeSeconds
    const final = wholeSeconds <= 3
    const urgency = (10 - wholeSeconds) / 9
    const frequency = final ? 720 + (3 - wholeSeconds) * 90 : 350 + urgency * 240
    this.tone(frequency, final ? 0.1 : 0.065, {
      type: final ? 'square' : 'sine',
      endFrequency: frequency * (final ? 0.86 : 1),
      gain: final ? 0.052 : 0.02 + urgency * 0.012,
      attack: 0.003,
    })
    // A restrained off-beat enters at six seconds and accelerates toward lock.
    // It conveys rising tempo without adding a continuous bed over impact cues.
    if (wholeSeconds <= 6 && !final) {
      this.tone(frequency * 1.18, 0.045, {
        type: 'sine',
        gain: 0.014 + urgency * 0.006,
        start: 0.34 - (6 - wholeSeconds) * 0.045,
        attack: 0.003,
      })
    }
    if (wholeSeconds === 1) {
      this.tone(1_080, 0.09, {
        type: 'triangle',
        gain: 0.035,
        start: 0.12,
      })
    }
  }

  playHit(options: HitSoundOptions = {}): void {
    const clusterIndex = Math.max(0, options.clusterIndex ?? 0)
    const clusterSize = Math.max(1, options.clusterSize ?? 1)
    const cascadeLift = Math.min(clusterIndex, 8)
    const base = options.player ? 72 : 94 + cascadeLift * 8
    this.noise(options.player ? 0.24 : 0.14, {
      filterType: 'bandpass',
      filterFrequency: options.player ? 460 : 780 + cascadeLift * 95,
      gain: options.player ? 0.17 : 0.105,
      playbackRate: 0.88 + cascadeLift * 0.035,
    })
    this.tone(base, options.player ? 0.42 : 0.24, {
      type: 'triangle',
      endFrequency: Math.max(42, base * (options.player ? 0.46 : 0.62)),
      gain: options.player ? 0.14 : 0.09,
      attack: 0.004,
    })
    this.tone(410 + cascadeLift * 48, 0.11, {
      type: 'square',
      endFrequency: 215 + cascadeLift * 22,
      gain: options.player ? 0.052 : 0.03,
      start: 0.018,
    })
    if (clusterSize >= 3 && clusterIndex === 0) {
      this.tone(55, 0.54, {
        type: 'sine',
        endFrequency: 82.41,
        gain: clamp(0.055 + clusterSize * 0.006, 0.055, 0.11),
        attack: 0.03,
      })
    }
  }

  playEscape(): void {
    this.noise(0.36, {
      filterType: 'highpass',
      filterFrequency: 1_450,
      gain: 0.06,
      playbackRate: 1.32,
    })
    this.tone(293.66, 0.24, {
      type: 'sine',
      endFrequency: 587.33,
      gain: 0.055,
      attack: 0.025,
    })
    this.tone(880, 0.27, {
      type: 'sine',
      endFrequency: 1_174.66,
      gain: 0.034,
      start: 0.11,
      attack: 0.035,
    })
  }

  playResult(result: SoundResult): void {
    const outcome = outcomeOf(result)
    if (outcome === 'escaped') {
      this.playEscape()
      return
    }
    if (outcome === 'survived') {
      const rankLift = typeof result === 'string' ? 0 : clamp(4 - result.rank, 0, 3) * 20
      this.tone(261.63 + rankLift, 0.25, {
        type: 'triangle',
        gain: 0.055,
        attack: 0.018,
      })
      this.tone(392 + rankLift, 0.29, {
        type: 'triangle',
        gain: 0.06,
        start: 0.105,
        attack: 0.018,
      })
      this.tone(659.25 + rankLift, 0.48, {
        type: 'sine',
        gain: 0.068,
        start: 0.22,
        attack: 0.028,
      })
      this.noise(0.36, {
        filterType: 'highpass',
        filterFrequency: 2_800,
        gain: 0.025,
        start: 0.19,
      })
    } else {
      this.tone(196, 0.28, {
        type: 'triangle',
        endFrequency: 130.81,
        gain: 0.075,
        attack: 0.008,
      })
      this.tone(98, 0.58, {
        type: 'sine',
        endFrequency: 55,
        gain: 0.1,
        start: 0.12,
        attack: 0.012,
      })
      this.noise(0.22, {
        filterType: 'lowpass',
        filterFrequency: 520,
        gain: 0.07,
        start: 0.04,
      })
    }
  }

  stopAll(): void {
    for (const source of this.sources) {
      try {
        source.stop()
      } catch {
        // The source may already have naturally ended.
      }
    }
    this.sources.clear()
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.stopAll()
    const context = this.context
    this.context = null
    this.compressor = null
    this.master = null
    this.noiseBuffer = null
    if (context && context.state !== 'closed') void context.close()
  }

  private ensureContext(): AudioContext | null {
    if (this.disposed) return null
    if (this.context && this.context.state !== 'closed') return this.context
    const AudioContextClass = contextConstructor()
    if (!AudioContextClass) return null
    try {
      const context = new AudioContextClass({ latencyHint: 'interactive' })
      const compressor = context.createDynamicsCompressor()
      compressor.threshold.value = -14
      compressor.knee.value = 16
      compressor.ratio.value = 5
      compressor.attack.value = 0.004
      compressor.release.value = 0.18
      const master = context.createGain()
      compressor.connect(master)
      master.connect(context.destination)
      this.context = context
      this.compressor = compressor
      this.master = master
      this.updateMasterGain(false)
      return context
    } catch {
      return null
    }
  }

  private updateMasterGain(smooth = true): void {
    const context = this.context
    const master = this.master
    if (!context || !master) return
    const target = this.muted ? 0 : this.volume * 0.52
    master.gain.cancelScheduledValues(context.currentTime)
    if (smooth && context.state === 'running') {
      master.gain.setValueAtTime(Math.max(MIN_GAIN, master.gain.value), context.currentTime)
      master.gain.exponentialRampToValueAtTime(
        Math.max(MIN_GAIN, target),
        context.currentTime + 0.1,
      )
      if (target === 0) master.gain.setValueAtTime(0, context.currentTime + 0.101)
    } else {
      master.gain.value = target
    }
  }

  private connectSource(source: AudioScheduledSourceNode): void {
    source.addEventListener(
      'ended',
      () => {
        this.sources.delete(source)
        source.disconnect()
      },
      { once: true },
    )
    this.sources.add(source)
  }

  private tone(frequency: number, duration: number, options: ToneOptions = {}): void {
    if (this.muted || this.volume <= 0) return
    const context = this.ensureContext()
    const output = this.compressor
    if (!context || !output) return
    if (context.state === 'suspended') void context.resume().catch(() => undefined)
    const start = context.currentTime + Math.max(0, options.start ?? 0)
    const safeDuration = clamp(duration, 0.02, 2)
    const end = start + safeDuration
    const attack = clamp(options.attack ?? 0.008, 0.002, safeDuration * 0.45)
    const oscillator = context.createOscillator()
    const envelope = context.createGain()
    oscillator.type = options.type ?? 'sine'
    oscillator.frequency.setValueAtTime(Math.max(24, frequency), start)
    if (options.endFrequency) {
      oscillator.frequency.exponentialRampToValueAtTime(
        Math.max(24, options.endFrequency),
        end,
      )
    }
    oscillator.detune.value = options.detune ?? 0
    const peak = clamp(options.gain ?? 0.05, MIN_GAIN, 0.35)
    envelope.gain.setValueAtTime(MIN_GAIN, start)
    envelope.gain.exponentialRampToValueAtTime(peak, start + attack)
    envelope.gain.exponentialRampToValueAtTime(MIN_GAIN, end)
    oscillator.connect(envelope)
    envelope.connect(output)
    this.connectSource(oscillator)
    oscillator.start(start)
    oscillator.stop(end + 0.02)
  }

  private noise(duration: number, options: NoiseOptions = {}): void {
    if (this.muted || this.volume <= 0) return
    const context = this.ensureContext()
    const output = this.compressor
    if (!context || !output) return
    if (context.state === 'suspended') void context.resume().catch(() => undefined)
    const start = context.currentTime + Math.max(0, options.start ?? 0)
    const safeDuration = clamp(duration, 0.025, 1)
    const source = context.createBufferSource()
    source.buffer = this.getNoiseBuffer(context)
    source.playbackRate.value = clamp(options.playbackRate ?? 1, 0.3, 3)
    const filter = context.createBiquadFilter()
    filter.type = options.filterType ?? 'bandpass'
    filter.frequency.value = clamp(options.filterFrequency ?? 900, 60, 12_000)
    filter.Q.value = filter.type === 'bandpass' ? 0.75 : 0.45
    const envelope = context.createGain()
    const peak = clamp(options.gain ?? 0.06, MIN_GAIN, 0.32)
    envelope.gain.setValueAtTime(MIN_GAIN, start)
    envelope.gain.exponentialRampToValueAtTime(peak, start + Math.min(0.012, safeDuration / 3))
    envelope.gain.exponentialRampToValueAtTime(MIN_GAIN, start + safeDuration)
    source.connect(filter)
    filter.connect(envelope)
    envelope.connect(output)
    this.connectSource(source)
    source.start(start, 0, safeDuration)
    source.stop(start + safeDuration + 0.02)
  }

  private getNoiseBuffer(context: AudioContext): AudioBuffer {
    if (this.noiseBuffer && this.noiseBuffer.sampleRate === context.sampleRate) {
      return this.noiseBuffer
    }
    const length = context.sampleRate
    const buffer = context.createBuffer(1, length, context.sampleRate)
    const channel = buffer.getChannelData(0)
    let state = 0x91e10da5
    for (let index = 0; index < channel.length; index += 1) {
      state ^= state << 13
      state ^= state >>> 17
      state ^= state << 5
      channel[index] = ((state >>> 0) / 2_147_483_648 - 1) * 0.82
    }
    this.noiseBuffer = buffer
    return buffer
  }

  private playDeckReveal(deck?: DeckDefinition): void {
    const variance = deck?.variance ?? [1, 1, 1, 1]
    const maxVariance = Math.max(...variance)
    const hueOffset = deck ? ((deck.hue % 120) / 120) * 36 : 0
    const tempo = clamp(deck?.tempo ?? 1, 0.7, 1.4)
    this.noise(0.46, {
      filterType: 'highpass',
      filterFrequency: 1_100 + hueOffset * 18,
      gain: 0.035,
      playbackRate: tempo,
    })
    variance.forEach((value, index) => {
      const intensity = value / Math.max(MIN_GAIN, maxVariance)
      const frequency = 174.61 + hueOffset + index * 42 + intensity * 160
      this.tone(frequency, 0.25, {
        type: index % 2 === 0 ? 'triangle' : 'sine',
        endFrequency: frequency * (1.02 + intensity * 0.08),
        gain: 0.025 + intensity * 0.032,
        start: index * (0.085 / tempo),
        attack: 0.014,
      })
    })
    this.tone(65.41, 0.6, {
      type: 'sine',
      endFrequency: 98,
      gain: 0.065,
      attack: 0.08,
    })
  }
}

export function createSoundController(
  options: SoundControllerOptions = {},
): StrikefallSoundController {
  return new StrikefallSoundController(options)
}
