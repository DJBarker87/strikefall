import type { StrikefallWasmClient } from '../wasm'

export type ScoringEngineMode = 'wasm-solmath' | 'typescript-fallback' | 'unavailable'
export type EnginePathSource =
  | 'typescript-bridge-extrema/v2'
  | 'rust-wasm-bridge-extrema/v1'
  | 'rust-server-bridge-extrema/v3'

/** Serializable identity committed into every browser replay. */
export interface ScoringEngineDescriptor {
  mode: ScoringEngineMode
  engineVersion: string
  digest: string
  /** Scorer eligibility only; a local/client-seeded round is still unranked. */
  rankable: boolean
  rustDeckId: string | null
  rustDeckVersion: number | null
  pricingVarianceFixed: string
  driftPerVarianceFixed: string
  pathSource: EnginePathSource
  reason: string | null
}

export type ScoringEngineStatusName = 'idle' | 'loading' | 'ready' | 'blocked'

export interface ScoringEngineStatus {
  status: ScoringEngineStatusName
  descriptor: ScoringEngineDescriptor
  message: string
}

export interface EngineDeckInput {
  id: string
  name: string
  version?: number
  monitoringConvention?: string
  /** Relative quarter weights; normalized before comparison with Rust. */
  variance?: readonly [number, number, number, number]
  openingRunway?: {
    steps: number
    varianceShareBps: number
  }
}

export interface EnginePlacementInput {
  id: string
  side: 'upper' | 'lower'
  barrier: number
  /** Canonical SCALE=1e12 input; when present, `barrier` is display-only. */
  barrierFixed?: string
}

export interface EngineLockedScore {
  id: string
  /** Canonical SCALE=1e12 values returned by the Rust/SolMath scorer. */
  survivalFixed: string
  riskFixed: string
  crowdFixed: string
  potentialFixed: string
  /** Display projections only. They are never reused to calculate points. */
  survival: number
  risk: number
  crowd: number
  potential: number
}

export interface EngineQuoteInput {
  spot: number
  /** Canonical SCALE=1e12 input; when present, `spot` is display-only. */
  spotFixed?: string
  barrier: number
  /** Canonical SCALE=1e12 input; when present, `barrier` is display-only. */
  barrierFixed?: string
  remainingVariance: number
  /** Canonical SCALE=1e12 input; when present, the Number is display-only. */
  remainingVarianceFixed?: string
  side: 'upper' | 'lower'
  alreadyBreached?: boolean
}

export interface EngineQuoteResult {
  survivalProbabilityFixed: string
  hitProbabilityFixed: string
  /** Display projections only. */
  survivalProbability: number
  hitProbability: number
}

export interface EngineRuntime {
  descriptor: ScoringEngineDescriptor
  client: StrikefallWasmClient | null
}
