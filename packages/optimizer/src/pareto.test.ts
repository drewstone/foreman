import { describe, it, expect } from 'vitest'
import {
  createFrontier,
  addToFrontier,
  bestFor,
  frontierSummary,
  serializeFrontier,
  deserializeFrontier,
  type ParetoEntry,
} from './pareto.js'

function entry(id: string, scores: Record<string, number>, iter = 1): ParetoEntry<string> {
  return { id, config: `code-${id}`, scores, hypothesis: `hypothesis for ${id}`, iteration: iter, timestamp: new Date().toISOString() }
}

describe('pareto frontier', () => {
  it('adds non-dominated entry to empty frontier', () => {
    const f = createFrontier(['accuracy', 'speed'])
    const added = addToFrontier(f, entry('a', { accuracy: 0.8, speed: 0.5 }))
    expect(added).toBe(true)
    expect(f.entries).toHaveLength(1)
    expect(f.totalEvaluated).toBe(1)
  })

  it('rejects dominated entry', () => {
    const f = createFrontier(['accuracy', 'speed'])
    addToFrontier(f, entry('a', { accuracy: 0.8, speed: 0.5 }))
    const added = addToFrontier(f, entry('b', { accuracy: 0.7, speed: 0.4 }))
    expect(added).toBe(false)
    expect(f.entries).toHaveLength(1)
    expect(f.totalEvaluated).toBe(2)
  })

  it('adds non-dominated entry that trades off dimensions', () => {
    const f = createFrontier(['accuracy', 'speed'])
    addToFrontier(f, entry('a', { accuracy: 0.8, speed: 0.5 }))
    const added = addToFrontier(f, entry('b', { accuracy: 0.6, speed: 0.9 }))
    expect(added).toBe(true)
    expect(f.entries).toHaveLength(2)
  })

  it('removes dominated entries when new entry dominates them', () => {
    const f = createFrontier(['accuracy', 'speed'])
    addToFrontier(f, entry('a', { accuracy: 0.5, speed: 0.5 }))
    addToFrontier(f, entry('b', { accuracy: 0.6, speed: 0.4 }))
    const added = addToFrontier(f, entry('c', { accuracy: 0.7, speed: 0.6 }))
    expect(added).toBe(true)
    // c dominates a (0.7>0.5, 0.6>0.5). b is not dominated (0.6>0.7 is false).
    // Actually c dominates a but not b (0.7>0.6 but 0.6>0.4 — c dominates b too? 0.7>=0.6 and 0.6>=0.4, strictly better on both — yes c dominates b)
    expect(f.entries).toHaveLength(1)
    expect(f.entries[0]!.id).toBe('c')
  })

  it('handles equal scores (no domination)', () => {
    const f = createFrontier(['accuracy'])
    addToFrontier(f, entry('a', { accuracy: 0.8 }))
    const added = addToFrontier(f, entry('b', { accuracy: 0.8 }))
    // Equal — neither dominates the other (strictly better on at least one required)
    expect(added).toBe(true)
    expect(f.entries).toHaveLength(2)
  })

  it('bestFor returns highest on a specific dimension', () => {
    const f = createFrontier(['accuracy', 'speed'])
    addToFrontier(f, entry('fast', { accuracy: 0.6, speed: 0.9 }))
    addToFrontier(f, entry('accurate', { accuracy: 0.9, speed: 0.6 }))
    expect(bestFor(f, 'accuracy')!.id).toBe('accurate')
    expect(bestFor(f, 'speed')!.id).toBe('fast')
  })

  it('serializes and deserializes', () => {
    const f = createFrontier<string>(['accuracy', 'speed'])
    addToFrontier(f, entry('a', { accuracy: 0.8, speed: 0.5 }))
    const json = serializeFrontier(f)
    const restored = deserializeFrontier<string>(json)
    expect(restored.entries).toHaveLength(1)
    expect(restored.dimensions).toEqual(['accuracy', 'speed'])
    expect(restored.totalEvaluated).toBe(1)
  })

  it('frontierSummary produces readable output', () => {
    const f = createFrontier(['accuracy', 'speed'])
    addToFrontier(f, entry('a', { accuracy: 0.8, speed: 0.5 }))
    addToFrontier(f, entry('b', { accuracy: 0.6, speed: 0.9 }))
    const s = frontierSummary(f)
    expect(s).toContain('2 non-dominated')
    expect(s).toContain('accuracy=')
    expect(s).toContain('speed=')
  })
})
