import { describe, expect, it } from 'vitest'
import {
  ALPHA_EXPERIMENTS,
  AUTHORITATIVE_EXPERIMENT_KEYS,
  EXPERIMENT_STORAGE_KEY,
  PUBLIC_EXPERIMENTS,
  assignExperiment,
  authoritativeExperimentEnvelope,
  authoritativeExperimentVariant,
  createExperimentEnvelope,
  experimentVariant,
  loadExperimentEnvelope,
  mergeExperimentEnvelope,
  parseExperimentEnvelope,
  practiceExperimentDefinitions,
  selectQuickRunDeck,
  type ExperimentDefinition,
} from './experiments'

const TEST_EXPERIMENT: ExperimentDefinition = {
  id: 'test',
  version: 1,
  variants: [
    { id: 'control', weight: 1 },
    { id: 'treatment', weight: 1 },
  ],
}

const WHEN = new Date('2026-07-14T12:00:00.000Z')

describe('experiment assignment', () => {
  it('assigns only treatment pairs that alter shipped behavior', () => {
    expect(ALPHA_EXPERIMENTS.map(({ id, version, variants }) => ({
      id,
      version,
      variants: variants.map((variant) => variant.id),
    }))).toEqual([
      { id: 'deck-structure', version: 2, variants: ['flat', 'compression-break'] },
      { id: 'escape', version: 2, variants: ['absent', 'midpoint'] },
      { id: 'risk-display', version: 2, variants: ['probability', 'danger-band'] },
    ])
    expect(AUTHORITATIVE_EXPERIMENT_KEYS).toEqual({
      deckStructure: 'deck-structure:v2',
      escape: 'escape:v2',
      riskDisplay: 'risk-display:v2',
    })
    expect(PUBLIC_EXPERIMENTS.map(({ id }) => id)).toEqual(['escape', 'risk-display'])
    expect(practiceExperimentDefinitions(undefined)).toBe(PUBLIC_EXPERIMENTS)
    expect(practiceExperimentDefinitions('off')).toBe(PUBLIC_EXPERIMENTS)
    expect(practiceExperimentDefinitions('typo')).toBe(PUBLIC_EXPERIMENTS)
    expect(practiceExperimentDefinitions('closed-alpha')).toBe(ALPHA_EXPERIMENTS)
  })

  it('rotates public Quick Runs uniformly across four decks and pins only an explicit treatment', () => {
    const counts = new Map<string, number>()
    for (let entropy = 0; entropy < 256; entropy += 1) {
      const id = selectQuickRunDeck(null, entropy).id
      counts.set(id, (counts.get(id) ?? 0) + 1)
    }
    expect(counts).toEqual(new Map([
      ['balanced-tape', 64],
      ['compression-break', 64],
      ['opening-rush', 64],
      ['pulse', 64],
    ]))
    expect(selectQuickRunDeck('flat', 255).id).toBe('balanced-tape')
    expect(selectQuickRunDeck('compression-break', 0).id).toBe('compression-break')
    expect(() => selectQuickRunDeck('invented', 0)).toThrow(/invalid/)
    expect(() => selectQuickRunDeck(null, 256)).toThrow(/one byte/)
  })

  it('parses authoritative versioned assignments without admitting label-only cohorts', () => {
    const assignments = {
      'deck-structure:v2': 'compression-break',
      'escape:v2': 'absent',
      'risk-display:v2': 'probability',
      impact_fx_v1: 'enhanced',
    }
    expect(authoritativeExperimentVariant(assignments, 'deck-structure')).toBe('compression-break')
    expect(authoritativeExperimentVariant(assignments, 'escape')).toBe('absent')
    expect(authoritativeExperimentVariant({ 'escape:v1': 'midpoint' }, 'escape')).toBeNull()
    expect(authoritativeExperimentVariant({ 'escape:v2': 'invented' }, 'escape')).toBeNull()
    expect(authoritativeExperimentEnvelope('ranked-session', assignments, WHEN)).toEqual({
      version: 1,
      subjectId: 'ranked-session',
      assignments: [
        { experimentId: 'deck-structure', experimentVersion: 2, variant: 'compression-break', assignedAt: WHEN.toISOString() },
        { experimentId: 'escape', experimentVersion: 2, variant: 'absent', assignedAt: WHEN.toISOString() },
        { experimentId: 'risk-display', experimentVersion: 2, variant: 'probability', assignedAt: WHEN.toISOString() },
      ],
    })
  })
  it('is stable for a subject and version', () => {
    const first = assignExperiment('anon-a', TEST_EXPERIMENT, WHEN)
    const second = assignExperiment('anon-a', TEST_EXPERIMENT, new Date())
    expect(second.variant).toBe(first.variant)
    expect(first.assignedAt).toBe(WHEN.toISOString())
  })

  it('supports positive weighted variants without falling out of range', () => {
    const weighted: ExperimentDefinition = {
      id: 'weighted',
      version: 3,
      variants: [
        { id: 'rare', weight: 1 },
        { id: 'common', weight: 9 },
      ],
    }
    const assignments = Array.from({ length: 200 }, (_, index) =>
      assignExperiment(`subject-${index}`, weighted, WHEN).variant)
    expect(new Set(assignments)).toEqual(new Set(['rare', 'common']))
    expect(assignments.filter((variant) => variant === 'common').length).toBeGreaterThan(150)
  })

  it('preserves valid assignments and reassigns a new experiment version', () => {
    const original = createExperimentEnvelope('anon-a', [TEST_EXPERIMENT], WHEN)
    const same = mergeExperimentEnvelope(original, 'anon-a', [TEST_EXPERIMENT], new Date())
    expect(same.assignments[0]).toEqual(original.assignments[0])

    const nextVersion = { ...TEST_EXPERIMENT, version: 2 }
    const updated = mergeExperimentEnvelope(original, 'anon-a', [nextVersion], WHEN)
    expect(updated.assignments[0].experimentVersion).toBe(2)
    expect(updated.assignments[0].assignedAt).toBe(WHEN.toISOString())
  })

  it('persists an envelope and exposes variants by experiment id', () => {
    const values = new Map<string, string>()
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => { values.set(key, value) },
    }
    const envelope = loadExperimentEnvelope('anon-a', storage, [TEST_EXPERIMENT], WHEN)
    expect(values.has(EXPERIMENT_STORAGE_KEY)).toBe(true)
    expect(experimentVariant(envelope, 'test')).toMatch(/control|treatment/)
    expect(parseExperimentEnvelope(values.get(EXPERIMENT_STORAGE_KEY)!)).toEqual(envelope)
    expect(parseExperimentEnvelope('{')).toBeNull()
  })

  it('removes a legacy deck cohort when storage loads under public rollout policy', () => {
    const values = new Map<string, string>()
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => { values.set(key, value) },
    }
    const legacy = createExperimentEnvelope('anon-a', ALPHA_EXPERIMENTS, WHEN)
    expect(experimentVariant(legacy, 'deck-structure')).not.toBeNull()
    values.set(EXPERIMENT_STORAGE_KEY, JSON.stringify(legacy))

    const migrated = loadExperimentEnvelope(
      'anon-a',
      storage,
      PUBLIC_EXPERIMENTS,
      new Date(WHEN.getTime() + 1_000),
    )
    expect(migrated.assignments.map(({ experimentId }) => experimentId)).toEqual([
      'escape',
      'risk-display',
    ])
    expect(experimentVariant(migrated, 'deck-structure')).toBeNull()
    expect(parseExperimentEnvelope(values.get(EXPERIMENT_STORAGE_KEY)!)).toEqual(migrated)
  })

  it('rejects unsafe experiment definitions', () => {
    expect(() => createExperimentEnvelope('anon-a', [TEST_EXPERIMENT, TEST_EXPERIMENT], WHEN))
      .toThrow(/Duplicate/)
    expect(() => assignExperiment('anon-a', { ...TEST_EXPERIMENT, variants: [{ id: 'only', weight: 1 }] }, WHEN))
      .toThrow(/at least two/)
    expect(() => assignExperiment('anon-a', {
      ...TEST_EXPERIMENT,
      variants: [{ id: 'bad', weight: 0 }, { id: 'ok', weight: 1 }],
    }, WHEN)).toThrow(/invalid variant/)
  })
})
