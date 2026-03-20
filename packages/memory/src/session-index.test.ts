import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { SessionIndex } from './session-index.js'

describe('SessionIndex', () => {
  let dir: string
  let index: SessionIndex

  before(async () => {
    dir = await mkdtemp(join(tmpdir(), 'foreman-si-test-'))
    index = new SessionIndex(join(dir, 'test.db'))
  })

  after(() => {
    index.close()
  })

  it('insertBatch adds messages and makes them searchable', () => {
    const count = index.insertBatch([
      {
        sessionId: 'ses-1',
        harness: 'claude',
        project: 'test-project',
        repo: 'test-repo',
        branch: 'main',
        role: 'user',
        timestamp: '2026-03-20T10:00:00Z',
        content: 'Fix the cargo clippy warnings in the billing module',
      },
      {
        sessionId: 'ses-1',
        harness: 'claude',
        project: 'test-project',
        repo: 'test-repo',
        branch: 'main',
        role: 'assistant',
        timestamp: '2026-03-20T10:01:00Z',
        content: '[bash] cargo clippy -- -D warnings',
      },
    ])
    assert.equal(count, 2)
  })

  it('search finds messages by content', () => {
    const results = index.search({ query: 'cargo clippy' })
    assert.ok(results.length > 0)
    assert.ok(results[0].snippet.includes('cargo'))
  })

  it('search filters by repo', () => {
    index.insertBatch([{
      sessionId: 'ses-2',
      harness: 'claude',
      project: 'other',
      repo: 'other-repo',
      branch: 'main',
      role: 'user',
      timestamp: '2026-03-20T11:00:00Z',
      content: 'cargo clippy in a different repo',
    }])

    const results = index.search({ query: 'cargo clippy', repo: 'test-repo' })
    assert.ok(results.length > 0)
    for (const r of results) {
      assert.equal(r.message.repo, 'test-repo')
    }
  })

  it('search filters by role', () => {
    const userOnly = index.search({ query: 'cargo clippy', role: 'user' })
    for (const r of userOnly) {
      assert.equal(r.message.role, 'user')
    }
  })

  it('search handles special characters safely', () => {
    // Should not throw FTS5 parse error
    const results = index.search({ query: 'foo "bar" AND NOT baz*' })
    // May return 0 results but should not crash
    assert.ok(Array.isArray(results))
  })

  it('recentUserMessages returns user messages sorted by time', () => {
    const msgs = index.recentUserMessages({ limit: 10 })
    assert.ok(msgs.length > 0)
    for (const m of msgs) {
      assert.equal(m.role, 'user')
    }
    // Should be descending by timestamp
    for (let i = 1; i < msgs.length; i++) {
      assert.ok(msgs[i - 1].timestamp >= msgs[i].timestamp)
    }
  })

  it('recentUserMessages filters by repo', () => {
    const msgs = index.recentUserMessages({ repo: 'test-repo', limit: 10 })
    for (const m of msgs) {
      assert.equal(m.repo, 'test-repo')
    }
  })

  it('stats returns correct counts', () => {
    const s = index.stats()
    assert.ok(s.totalMessages >= 3)
    assert.ok(s.totalSessions >= 2)
    assert.ok(s.byHarness.claude >= 3)
    assert.ok(s.byRepo['test-repo'] >= 2)
  })

  it('high-water marks track indexing progress', () => {
    index.setLastIndexedTimestamp('claude', 'test', '2026-03-20T12:00:00Z')
    const ts = index.getLastIndexedTimestamp('claude', 'test')
    assert.equal(ts, '2026-03-20T12:00:00Z')
  })
})
