import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { ConfidenceStore, type ConfidenceSignal } from './confidence.js'

describe('ConfidenceStore', () => {
  let dir: string
  let store: ConfidenceStore

  before(async () => {
    dir = await mkdtemp(join(tmpdir(), 'foreman-confidence-test-'))
    store = new ConfidenceStore(join(dir, 'test.db'))
  })

  after(() => {
    store.close()
  })

  it('initial confidence is 0.0', () => {
    assert.equal(store.getConfidence('spawn-session', 'my-project'), 0.0)
  })

  it('agree signal increases score by 0.1', () => {
    store.update('spawn-session', 'proj-a', 'agree')
    const score = store.getConfidence('spawn-session', 'proj-a')
    assert.ok(Math.abs(score - 0.1) < 1e-9)
  })

  it('disagree signal decreases score by 0.15', () => {
    store.update('create-pr', 'proj-b', 'agree')
    store.update('create-pr', 'proj-b', 'agree')
    // score is now 0.2
    store.update('create-pr', 'proj-b', 'disagree')
    const score = store.getConfidence('create-pr', 'proj-b')
    assert.ok(Math.abs(score - 0.05) < 1e-9)
  })

  it('success signal increases score by 0.05', () => {
    store.update('run-eval', 'proj-c', 'success')
    const score = store.getConfidence('run-eval', 'proj-c')
    assert.ok(Math.abs(score - 0.05) < 1e-9)
  })

  it('failure signal decreases score by 0.1', () => {
    store.update('invoke-skill', 'proj-d', 'agree')
    store.update('invoke-skill', 'proj-d', 'agree')
    // score is 0.2
    store.update('invoke-skill', 'proj-d', 'failure')
    const score = store.getConfidence('invoke-skill', 'proj-d')
    assert.ok(Math.abs(score - 0.1) < 1e-9)
  })

  it('transfer signal increases score by 0.02', () => {
    store.update('do-nothing', 'proj-e', 'transfer')
    const score = store.getConfidence('do-nothing', 'proj-e')
    assert.ok(Math.abs(score - 0.02) < 1e-9)
  })

  it('score clamps to 0.0 on the low end', () => {
    store.update('run-experiment', 'proj-floor', 'disagree')
    const score = store.getConfidence('run-experiment', 'proj-floor')
    assert.equal(score, 0.0)
  })

  it('score clamps to 1.0 on the high end', () => {
    for (let i = 0; i < 15; i++) {
      store.update('send-notification', 'proj-ceil', 'agree')
    }
    const score = store.getConfidence('send-notification', 'proj-ceil')
    assert.equal(score, 1.0)
  })

  it('level thresholds: dry-run below 0.3', () => {
    assert.equal(store.getLevelForScore(0.0), 'dry-run')
    assert.equal(store.getLevelForScore(0.29), 'dry-run')
  })

  it('level thresholds: propose at 0.3', () => {
    assert.equal(store.getLevelForScore(0.3), 'propose')
    assert.equal(store.getLevelForScore(0.59), 'propose')
  })

  it('level thresholds: act-notify at 0.6', () => {
    assert.equal(store.getLevelForScore(0.6), 'act-notify')
    assert.equal(store.getLevelForScore(0.79), 'act-notify')
  })

  it('level thresholds: autonomous at 0.8', () => {
    assert.equal(store.getLevelForScore(0.8), 'autonomous')
    assert.equal(store.getLevelForScore(1.0), 'autonomous')
  })

  it('override never-auto forces dry-run regardless of score', () => {
    // build up a high score
    for (let i = 0; i < 12; i++) {
      store.update('spawn-session', 'proj-override-never', 'agree')
    }
    const rawScore = store.getConfidence('spawn-session', 'proj-override-never')
    assert.ok(rawScore >= 0.8)

    store.setOverride('proj-override-never', 'never-auto')
    assert.equal(store.getLevel('spawn-session', 'proj-override-never'), 'dry-run')
  })

  it('override always-auto forces autonomous regardless of score', () => {
    // score starts at 0
    assert.equal(store.getConfidence('create-pr', 'proj-override-always'), 0.0)
    store.setOverride('proj-override-always', 'always-auto')
    assert.equal(store.getLevel('create-pr', 'proj-override-always'), 'autonomous')
  })

  it('removing override restores normal behavior', () => {
    store.setOverride('proj-override-always', null)
    assert.equal(store.getLevel('create-pr', 'proj-override-always'), 'dry-run')
  })

  it('log entries are created for each signal', () => {
    const store2 = new ConfidenceStore(join(dir, 'log-test.db'))
    store2.update('spawn-session', 'proj-log', 'agree')
    store2.update('spawn-session', 'proj-log', 'success')
    store2.update('spawn-session', 'proj-log', 'disagree')

    const rows = (store2 as any).db.prepare(
      'SELECT * FROM confidence_log WHERE action_type = ? AND project = ? ORDER BY id',
    ).all('spawn-session', 'proj-log') as Array<{
      signal: string
      old_score: number
      new_score: number
    }>

    assert.equal(rows.length, 3)
    assert.equal(rows[0].signal, 'agree')
    assert.equal(rows[0].old_score, 0.0)
    assert.ok(Math.abs(rows[0].new_score - 0.1) < 1e-9)
    assert.equal(rows[1].signal, 'success')
    assert.equal(rows[2].signal, 'disagree')
    store2.close()
  })

  it('list returns all entries', () => {
    const store3 = new ConfidenceStore(join(dir, 'list-test.db'))
    store3.update('spawn-session', 'proj-x', 'agree')
    store3.update('create-pr', 'proj-x', 'success')
    store3.update('spawn-session', 'proj-y', 'transfer')

    const all = store3.list()
    assert.equal(all.length, 3)

    const filtered = store3.list('proj-x')
    assert.equal(filtered.length, 2)
    assert.ok(filtered.every((e) => e.project === 'proj-x'))

    // verify entry shape
    const entry = filtered.find((e) => e.actionType === 'spawn-session')!
    assert.ok(entry)
    assert.equal(typeof entry.score, 'number')
    assert.equal(typeof entry.level, 'string')
    assert.equal(entry.totalSignals, 1)
    assert.ok(entry.lastUpdated)

    store3.close()
  })
})
