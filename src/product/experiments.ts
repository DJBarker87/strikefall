import { DECKS, getDeck, type DeckDefinition } from '../game'

export const EXPERIMENT_STORAGE_KEY = 'strikefall.experiments.v1'

export interface ExperimentVariant {
  id: string
  weight: number
}

export interface ExperimentDefinition {
  id: string
  version: number
  variants: readonly ExperimentVariant[]
}

export interface ExperimentAssignment {
  experimentId: string
  experimentVersion: number
  variant: string
  assignedAt: string
}

export interface ExperimentEnvelope {
  version: 1
  subjectId: string
  assignments: ExperimentAssignment[]
}

const DECK_STRUCTURE_EXPERIMENT = {
  id: 'deck-structure',
  version: 2,
  variants: [
    { id: 'flat', weight: 1 },
    { id: 'compression-break', weight: 1 },
  ],
} as const satisfies ExperimentDefinition

const ESCAPE_EXPERIMENT = {
  id: 'escape',
  version: 2,
  variants: [
    { id: 'absent', weight: 1 },
    { id: 'midpoint', weight: 1 },
  ],
} as const satisfies ExperimentDefinition

const RISK_DISPLAY_EXPERIMENT = {
  id: 'risk-display',
  version: 2,
  variants: [
    { id: 'probability', weight: 1 },
    { id: 'danger-band', weight: 1 },
  ],
} as const satisfies ExperimentDefinition

/** Public/default rollout: Quick Run rotates all decks and has no deck cohort. */
export const PUBLIC_EXPERIMENTS = [
  ESCAPE_EXPERIMENT,
  RISK_DISPLAY_EXPERIMENT,
] as const satisfies readonly ExperimentDefinition[]

/** Full allowed catalog. Deck structure is activated only by explicit alpha policy. */
export const ALPHA_EXPERIMENTS = [
  DECK_STRUCTURE_EXPERIMENT,
  ...PUBLIC_EXPERIMENTS,
] as const satisfies readonly ExperimentDefinition[]

export type DeckStructureVariant = 'flat' | 'compression-break'

/**
 * The exact opt-in value prevents a typo or unknown deployment label from
 * manufacturing a deck cohort. Any other value keeps the public rotation.
 */
export function practiceExperimentDefinitions(
  policy: string | null | undefined = import.meta.env.VITE_STRIKEFALL_DECK_STRUCTURE_EXPERIMENT,
): readonly ExperimentDefinition[] {
  return policy === 'closed-alpha' ? ALPHA_EXPERIMENTS : PUBLIC_EXPERIMENTS
}

function randomByte(): number {
  if (typeof crypto !== 'undefined' && typeof crypto.getRandomValues === 'function') {
    const bytes = new Uint8Array(1)
    crypto.getRandomValues(bytes)
    return bytes[0] as number
  }
  return Math.floor(Math.random() * 256)
}

/**
 * Chooses a fresh public Quick Run deck. Four divides the byte domain exactly,
 * so every deck receives 64 of 256 possible values. An explicit alpha
 * treatment pins only its disclosed treatment deck.
 */
export function selectQuickRunDeck(
  variant: string | null,
  entropyByte = randomByte(),
): DeckDefinition {
  if (variant !== null) {
    if (variant !== 'flat' && variant !== 'compression-break') {
      throw new RangeError('Quick Run deck treatment is invalid')
    }
    const id = variant === 'compression-break' ? 'compression-break' : 'balanced-tape'
    const deck = getDeck(id)
    if (!deck) throw new Error(`Missing Quick Run treatment deck: ${id}`)
    return deck
  }
  if (!Number.isInteger(entropyByte) || entropyByte < 0 || entropyByte > 255) {
    throw new RangeError('Quick Run entropy must be one byte')
  }
  return DECKS[entropyByte % DECKS.length] as DeckDefinition
}

export const AUTHORITATIVE_EXPERIMENT_KEYS = {
  deckStructure: 'deck-structure:v2',
  escape: 'escape:v2',
  riskDisplay: 'risk-display:v2',
} as const

export function experimentAssignmentKey(experimentId: string, experimentVersion: number) {
  return `${experimentId}:v${experimentVersion}`
}

/**
 * Only experiments that alter shipped behavior belong in the assignment
 * envelope. Bot, lobby-size, crowding, and three-life candidates stay out
 * until their alternate rules are replay-versioned; cohort labels without a
 * treatment would create misleading analytics.
 */

function hash32(value: string) {
  let hash = 0x811c9dc5
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193)
  }
  return hash >>> 0
}

function validateDefinition(definition: ExperimentDefinition) {
  if (!definition.id || !Number.isInteger(definition.version) || definition.version < 1) {
    throw new TypeError('Experiment id and positive integer version are required')
  }
  if (definition.variants.length < 2) {
    throw new TypeError(`Experiment ${definition.id} requires at least two variants`)
  }
  const ids = new Set<string>()
  for (const variant of definition.variants) {
    if (!variant.id || !Number.isFinite(variant.weight) || variant.weight <= 0 || ids.has(variant.id)) {
      throw new TypeError(`Experiment ${definition.id} has an invalid variant`)
    }
    ids.add(variant.id)
  }
}

export function assignExperiment(
  subjectId: string,
  definition: ExperimentDefinition,
  assignedAt = new Date(),
): ExperimentAssignment {
  if (!subjectId) throw new TypeError('Experiment subject id is required')
  validateDefinition(definition)
  const total = definition.variants.reduce((sum, variant) => sum + variant.weight, 0)
  const unit = hash32(`${subjectId}:${definition.id}:v${definition.version}`) / 0x1_0000_0000
  let cursor = unit * total
  let selected = definition.variants[definition.variants.length - 1]
  for (const variant of definition.variants) {
    cursor -= variant.weight
    if (cursor < 0) {
      selected = variant
      break
    }
  }
  return {
    experimentId: definition.id,
    experimentVersion: definition.version,
    variant: selected.id,
    assignedAt: assignedAt.toISOString(),
  }
}

export function createExperimentEnvelope(
  subjectId: string,
  definitions: readonly ExperimentDefinition[] = practiceExperimentDefinitions(),
  assignedAt = new Date(),
): ExperimentEnvelope {
  const seen = new Set<string>()
  for (const definition of definitions) {
    if (seen.has(definition.id)) throw new TypeError(`Duplicate experiment: ${definition.id}`)
    seen.add(definition.id)
  }
  return {
    version: 1,
    subjectId,
    assignments: definitions.map((definition) =>
      assignExperiment(subjectId, definition, assignedAt)),
  }
}

export function mergeExperimentEnvelope(
  existing: ExperimentEnvelope | null,
  subjectId: string,
  definitions: readonly ExperimentDefinition[] = practiceExperimentDefinitions(),
  assignedAt = new Date(),
): ExperimentEnvelope {
  if (!existing || existing.version !== 1 || existing.subjectId !== subjectId) {
    return createExperimentEnvelope(subjectId, definitions, assignedAt)
  }
  const current = new Map(
    existing.assignments.map((assignment) => [
      `${assignment.experimentId}:v${assignment.experimentVersion}`,
      assignment,
    ]),
  )
  return {
    version: 1,
    subjectId,
    assignments: definitions.map((definition) => {
      const key = experimentAssignmentKey(definition.id, definition.version)
      const saved = current.get(key)
      const valid = saved && definition.variants.some((variant) => variant.id === saved.variant)
      return valid ? saved : assignExperiment(subjectId, definition, assignedAt)
    }),
  }
}

export function parseExperimentEnvelope(value: string): ExperimentEnvelope | null {
  try {
    const parsed = JSON.parse(value) as Partial<ExperimentEnvelope>
    if (parsed.version !== 1 || typeof parsed.subjectId !== 'string' || !Array.isArray(parsed.assignments)) {
      return null
    }
    const assignments = parsed.assignments.flatMap((candidate) => {
      if (!candidate || typeof candidate !== 'object') return []
      const assignment = candidate as Partial<ExperimentAssignment>
      if (
        typeof assignment.experimentId !== 'string' ||
        !Number.isInteger(assignment.experimentVersion) ||
        typeof assignment.variant !== 'string' ||
        typeof assignment.assignedAt !== 'string'
      ) return []
      return [{
        experimentId: assignment.experimentId,
        experimentVersion: assignment.experimentVersion as number,
        variant: assignment.variant,
        assignedAt: assignment.assignedAt,
      }]
    })
    return { version: 1, subjectId: parsed.subjectId, assignments }
  } catch {
    return null
  }
}

export function loadExperimentEnvelope(
  subjectId: string,
  storage: Pick<Storage, 'getItem' | 'setItem'> | null = typeof localStorage === 'undefined' ? null : localStorage,
  definitions: readonly ExperimentDefinition[] = practiceExperimentDefinitions(),
  assignedAt = new Date(),
) {
  let existing: ExperimentEnvelope | null = null
  try {
    const value = storage?.getItem(EXPERIMENT_STORAGE_KEY)
    existing = value ? parseExperimentEnvelope(value) : null
  } catch {
    // Storage is optional; deterministic hashing still keeps the assignment stable.
  }
  const envelope = mergeExperimentEnvelope(existing, subjectId, definitions, assignedAt)
  try {
    storage?.setItem(EXPERIMENT_STORAGE_KEY, JSON.stringify(envelope))
  } catch {
    // The round remains playable without persisted experiment metadata.
  }
  return envelope
}

export function experimentVariant(envelope: ExperimentEnvelope, experimentId: string) {
  return envelope.assignments.find((assignment) => assignment.experimentId === experimentId)?.variant ?? null
}

/**
 * Resolves an authoritative session/round map only when its explicit version
 * and variant match the shipped treatment catalog. Unknown deployment labels
 * fail closed instead of silently creating an analytics cohort.
 */
export function authoritativeExperimentVariant(
  assignments: Readonly<Record<string, string>> | null | undefined,
  experimentId: string,
): string | null {
  const definition = ALPHA_EXPERIMENTS.find((candidate) => candidate.id === experimentId)
  if (!definition) return null
  const variant = assignments?.[experimentAssignmentKey(definition.id, definition.version)]
  return definition.variants.some((candidate) => candidate.id === variant) ? variant ?? null : null
}

export function authoritativeExperimentEnvelope(
  subjectId: string,
  assignments: Readonly<Record<string, string>>,
  assignedAt = new Date(0),
): ExperimentEnvelope {
  return {
    version: 1,
    subjectId,
    assignments: ALPHA_EXPERIMENTS.flatMap((definition) => {
      const variant = authoritativeExperimentVariant(assignments, definition.id)
      return variant
        ? [{
            experimentId: definition.id,
            experimentVersion: definition.version,
            variant,
            assignedAt: assignedAt.toISOString(),
          }]
        : []
    }),
  }
}
