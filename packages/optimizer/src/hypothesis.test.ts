import { describe, it, expect } from 'vitest'
import { validateHypothesis, parseHypothesis, type Hypothesis } from './hypothesis.js'

function makeHypothesis(overrides: Partial<Hypothesis> = {}): Hypothesis {
  return {
    id: 'hyp-1-test',
    iteration: 1,
    name: 'draft_verification',
    hypothesis: 'Adding a verification stage after draft prediction will catch false positives by retrieving challengers',
    baseSystem: 'baseline',
    changes: ['Add second retrieval stage conditioned on draft prediction', 'Retrieve 5 challengers with different labels'],
    axis: 'exploration',
    filePath: '.meta-harness/variants/draft_verification.ts',
    timestamp: new Date().toISOString(),
    ...overrides,
  }
}

describe('validateHypothesis', () => {
  it('accepts valid hypothesis', () => {
    const result = validateHypothesis(makeHypothesis())
    expect(result.valid).toBe(true)
  })

  it('rejects short hypothesis', () => {
    const result = validateHypothesis(makeHypothesis({ hypothesis: 'too short' }))
    expect(result.valid).toBe(false)
    expect(result.rejectionReason).toContain('too short')
  })

  it('rejects empty base system', () => {
    const result = validateHypothesis(makeHypothesis({ baseSystem: '' }))
    expect(result.valid).toBe(false)
    expect(result.rejectionReason).toContain('base system')
  })

  it('rejects empty changes', () => {
    const result = validateHypothesis(makeHypothesis({ changes: [] }))
    expect(result.valid).toBe(false)
    expect(result.rejectionReason).toContain('mechanism changes')
  })

  it('rejects parameter-only changes', () => {
    const result = validateHypothesis(makeHypothesis({
      changes: ['increase timeout to 30000'],
    }))
    expect(result.valid).toBe(false)
    expect(result.rejectionReason).toContain('parameter variant')
  })

  it('allows parameter change when accompanied by structural change', () => {
    const result = validateHypothesis(makeHypothesis({
      changes: ['increase timeout to 30000', 'Add retry-with-backoff mechanism replacing linear retry'],
    }))
    expect(result.valid).toBe(true)
  })

  it('rejects non-snake-case name', () => {
    const result = validateHypothesis(makeHypothesis({ name: 'DraftVerification' }))
    expect(result.valid).toBe(false)
    expect(result.rejectionReason).toContain('snake_case')
  })
})

describe('parseHypothesis', () => {
  it('parses valid JSON', () => {
    const json = JSON.stringify({
      name: 'contrastive_retrieval',
      hypothesis: 'Using contrastive pairs from the local neighborhood will expose decision boundaries',
      base_system: 'baseline',
      changes: ['Add contrastive pair retrieval', 'Inject label-primed context'],
      axis: 'exploration',
      file: '.meta-harness/variants/contrastive_retrieval.ts',
    })
    const result = parseHypothesis(json, 3)
    expect(result).not.toBeNull()
    expect(result!.name).toBe('contrastive_retrieval')
    expect(result!.iteration).toBe(3)
    expect(result!.baseSystem).toBe('baseline')
  })

  it('returns null for invalid JSON', () => {
    expect(parseHypothesis('not json', 1)).toBeNull()
  })
})
