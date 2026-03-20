import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { VersionedStore } from './versioned-store.js'

describe('VersionedStore', () => {
  let dir: string
  let store: VersionedStore

  before(async () => {
    dir = await mkdtemp(join(tmpdir(), 'foreman-vs-test-'))
    store = new VersionedStore(dir)
  })

  after(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('put creates first version and auto-activates', async () => {
    const result = await store.put('test-kind', 'test-name', 'content v1')
    assert.equal(result.isNew, true)
    assert.equal(result.isDuplicate, false)
    assert.equal(result.version.id, 'v001')
    assert.equal(result.version.status, 'active')
  })

  it('put detects duplicates by content hash', async () => {
    const result = await store.put('test-kind', 'test-name', 'content v1')
    assert.equal(result.isDuplicate, true)
    assert.equal(result.isNew, false)
    assert.equal(result.version.id, 'v001')
  })

  it('put creates candidate for subsequent versions', async () => {
    const result = await store.put('test-kind', 'test-name', 'content v2')
    assert.equal(result.isNew, true)
    assert.equal(result.version.id, 'v002')
    assert.equal(result.version.status, 'candidate')
  })

  it('getActive returns the active version', async () => {
    const active = await store.getActive('test-kind', 'test-name')
    assert.ok(active)
    assert.equal(active.version.id, 'v001')
    assert.equal(active.content, 'content v1')
  })

  it('getVersion returns specific version', async () => {
    const v2 = await store.getVersion('test-kind', 'test-name', 'v002')
    assert.ok(v2)
    assert.equal(v2.content, 'content v2')
    assert.equal(v2.version.status, 'candidate')
  })

  it('promote changes active version', async () => {
    await store.promote('test-kind', 'test-name', 'v002', 'test promotion')
    const active = await store.getActive('test-kind', 'test-name')
    assert.ok(active)
    assert.equal(active.version.id, 'v002')
    assert.equal(active.content, 'content v2')

    // Old version should be retired
    const v1 = await store.getVersion('test-kind', 'test-name', 'v001')
    assert.ok(v1)
    assert.equal(v1.version.status, 'retired')
  })

  it('rollback returns to previous version', async () => {
    const rolled = await store.rollback('test-kind', 'test-name', 'test rollback')
    assert.ok(rolled)
    assert.equal(rolled.id, 'v001')

    const active = await store.getActive('test-kind', 'test-name')
    assert.ok(active)
    assert.equal(active.version.id, 'v001')
  })

  it('score records judge scores and updates average', async () => {
    await store.score('test-kind', 'test-name', 'v001', {
      judgeId: 'test-judge',
      score: 8,
      maxScore: 10,
    })
    await store.score('test-kind', 'test-name', 'v001', {
      judgeId: 'test-judge-2',
      score: 6,
      maxScore: 10,
    })

    const v = await store.getVersion('test-kind', 'test-name', 'v001')
    assert.ok(v)
    assert.equal(v.version.scores.length, 2)
    // Average of 8/10 and 6/10 = 0.7
    assert.ok(Math.abs(v.version.averageScore! - 0.7) < 0.01)
  })

  it('autoPromote promotes candidate with enough scores', async () => {
    // Create a fresh artifact for this test
    await store.put('auto-kind', 'auto-name', 'base content', { activate: true })
    const v2 = await store.put('auto-kind', 'auto-name', 'improved content')
    assert.equal(v2.version.status, 'candidate')

    // Score v002 high enough
    await store.score('auto-kind', 'auto-name', v2.version.id, { judgeId: 'j1', score: 9, maxScore: 10 })
    await store.score('auto-kind', 'auto-name', v2.version.id, { judgeId: 'j2', score: 9, maxScore: 10 })
    await store.score('auto-kind', 'auto-name', v2.version.id, { judgeId: 'j3', score: 9, maxScore: 10 })

    const promoted = await store.autoPromote('auto-kind', 'auto-name', { minScores: 3, minImprovement: 0.05 })
    assert.ok(promoted)
    assert.equal(promoted.id, v2.version.id)
  })

  it('list returns all versions', async () => {
    const versions = await store.list('test-kind', 'test-name')
    assert.equal(versions.length, 2)
  })

  it('listKinds returns kinds', async () => {
    const kinds = await store.listKinds()
    assert.ok(kinds.includes('test-kind'))
  })

  it('listNames returns names for a kind', async () => {
    const names = await store.listNames('test-kind')
    assert.ok(names.includes('test-name'))
  })

  it('getActive returns null for non-existent artifact', async () => {
    const result = await store.getActive('nonexistent', 'nope')
    assert.equal(result, null)
  })

  it('getBest returns highest-scoring version', async () => {
    const best = await store.getBest('auto-kind', 'auto-name')
    assert.ok(best)
    assert.equal(best.version.averageScore, 0.9)
  })
})
