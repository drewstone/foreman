/**
 * FTS5 session search index.
 *
 * Indexes Claude Code, Codex, and Pi session content into SQLite with
 * full-text search. Supports:
 *
 * - "what did I try last time on this repo?"
 * - "when did I last run cargo test in openclaw?"
 * - "show me sessions where I talked about billing"
 *
 * Storage: ~/.foreman/session-index.db
 *
 * Schema:
 *   messages(id, session_id, harness, project, repo, branch, role, timestamp, content)
 *   messages_fts(content) — FTS5 virtual table
 */

import Database from 'better-sqlite3'
import { createReadStream } from 'node:fs'
import { readdir, readFile, stat } from 'node:fs/promises'
import { createInterface } from 'node:readline'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

const FOREMAN_HOME = process.env.FOREMAN_HOME ?? join(homedir(), '.foreman')
const DB_PATH = join(FOREMAN_HOME, 'session-index.db')

export interface IndexedMessage {
  id: number
  sessionId: string
  harness: 'claude' | 'codex' | 'pi' | 'opencode'
  project: string
  repo: string
  branch: string
  role: 'user' | 'assistant' | 'tool'
  timestamp: string
  content: string
}

export interface SearchResult {
  message: IndexedMessage
  snippet: string
  rank: number
}

export interface SearchOptions {
  query: string
  repo?: string
  harness?: 'claude' | 'codex' | 'pi' | 'opencode'
  role?: 'user' | 'assistant' | 'tool'
  limit?: number
  hoursBack?: number
}

export interface IndexStats {
  totalMessages: number
  totalSessions: number
  byHarness: Record<string, number>
  byRepo: Record<string, number>
  oldestTimestamp: string | null
  newestTimestamp: string | null
}

export class SessionIndex {
  private db: Database.Database

  constructor(dbPath?: string) {
    this.db = new Database(dbPath ?? DB_PATH)
    this.db.pragma('journal_mode = WAL')
    this.db.pragma('synchronous = NORMAL')
    this.init()
  }

  private init(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL,
        harness TEXT NOT NULL,
        project TEXT NOT NULL DEFAULT '',
        repo TEXT NOT NULL DEFAULT '',
        branch TEXT NOT NULL DEFAULT '',
        role TEXT NOT NULL,
        timestamp TEXT NOT NULL,
        content TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS index_state (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id);
      CREATE INDEX IF NOT EXISTS idx_messages_repo ON messages(repo);
      CREATE INDEX IF NOT EXISTS idx_messages_harness ON messages(harness);
      CREATE INDEX IF NOT EXISTS idx_messages_timestamp ON messages(timestamp);
    `)

    // FTS5 external content table — linked to messages table
    try {
      this.db.exec(`
        CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
          content,
          content='messages',
          content_rowid=id,
          tokenize='porter unicode61'
        );

        CREATE TRIGGER IF NOT EXISTS messages_ai AFTER INSERT ON messages BEGIN
          INSERT INTO messages_fts(rowid, content) VALUES (new.id, new.content);
        END;

        CREATE TRIGGER IF NOT EXISTS messages_ad AFTER DELETE ON messages BEGIN
          INSERT INTO messages_fts(messages_fts, rowid, content) VALUES ('delete', old.id, old.content);
        END;

        CREATE TRIGGER IF NOT EXISTS messages_au AFTER UPDATE ON messages BEGIN
          INSERT INTO messages_fts(messages_fts, rowid, content) VALUES ('delete', old.id, old.content);
          INSERT INTO messages_fts(rowid, content) VALUES (new.id, new.content);
        END;
      `)
    } catch {
      // FTS5 already exists
    }
  }

  search(options: SearchOptions): SearchResult[] {
    const { query, repo, harness, role, limit = 20, hoursBack } = options

    const safeQuery = '"' + query.replace(/"/g, '""') + '"'
    const conditions: string[] = ['messages_fts MATCH ?']
    const params: (string | number)[] = [safeQuery]

    if (repo) {
      conditions.push('m.repo = ?')
      params.push(repo)
    }
    if (harness) {
      conditions.push('m.harness = ?')
      params.push(harness)
    }
    if (role) {
      conditions.push('m.role = ?')
      params.push(role)
    }
    if (hoursBack) {
      const cutoff = new Date(Date.now() - hoursBack * 3600 * 1000).toISOString()
      conditions.push('m.timestamp >= ?')
      params.push(cutoff)
    }

    params.push(limit)

    const sql = `
      SELECT
        m.*,
        snippet(messages_fts, 0, '>>>', '<<<', '...', 40) AS snippet,
        rank
      FROM messages_fts
      JOIN messages m ON m.id = messages_fts.rowid
      WHERE ${conditions.join(' AND ')}
      ORDER BY rank
      LIMIT ?
    `

    const rows = this.db.prepare(sql).all(...params) as Array<IndexedMessage & { snippet: string; rank: number }>

    return rows.map((row) => ({
      message: {
        id: row.id,
        sessionId: row.sessionId ?? (row as unknown as Record<string, unknown>).session_id as string,
        harness: row.harness as IndexedMessage['harness'],
        project: row.project,
        repo: row.repo,
        branch: row.branch,
        role: row.role as IndexedMessage['role'],
        timestamp: row.timestamp,
        content: row.content,
      },
      snippet: row.snippet,
      rank: row.rank,
    }))
  }

  recentUserMessages(options: { repo?: string; limit?: number; hoursBack?: number }): IndexedMessage[] {
    const conditions: string[] = ["role = 'user'"]
    const params: (string | number)[] = []

    if (options.repo) {
      conditions.push('repo = ?')
      params.push(options.repo)
    }
    if (options.hoursBack) {
      const cutoff = new Date(Date.now() - options.hoursBack * 3600 * 1000).toISOString()
      conditions.push('timestamp >= ?')
      params.push(cutoff)
    }

    params.push(options.limit ?? 50)

    const sql = `
      SELECT * FROM messages
      WHERE ${conditions.join(' AND ')}
      ORDER BY timestamp DESC
      LIMIT ?
    `

    return this.db.prepare(sql).all(...params) as IndexedMessage[]
  }

  stats(): IndexStats {
    const total = this.db.prepare('SELECT COUNT(*) as c FROM messages').get() as { c: number }
    const sessions = this.db.prepare('SELECT COUNT(DISTINCT session_id) as c FROM messages').get() as { c: number }

    const byHarness: Record<string, number> = {}
    const harnessRows = this.db.prepare('SELECT harness, COUNT(*) as c FROM messages GROUP BY harness').all() as Array<{ harness: string; c: number }>
    for (const row of harnessRows) byHarness[row.harness] = row.c

    const byRepo: Record<string, number> = {}
    const repoRows = this.db.prepare("SELECT repo, COUNT(*) as c FROM messages WHERE repo != '' GROUP BY repo ORDER BY c DESC LIMIT 20").all() as Array<{ repo: string; c: number }>
    for (const row of repoRows) byRepo[row.repo] = row.c

    const oldest = this.db.prepare('SELECT MIN(timestamp) as t FROM messages').get() as { t: string | null }
    const newest = this.db.prepare('SELECT MAX(timestamp) as t FROM messages').get() as { t: string | null }

    return {
      totalMessages: total.c,
      totalSessions: sessions.c,
      byHarness,
      byRepo,
      oldestTimestamp: oldest.t,
      newestTimestamp: newest.t,
    }
  }

  getLastIndexedTimestamp(harness: string, project: string): string | null {
    const row = this.db.prepare(
      "SELECT value FROM index_state WHERE key = ?",
    ).get(`last_ts:${harness}:${project}`) as { value: string } | undefined
    return row?.value ?? null
  }

  setLastIndexedTimestamp(harness: string, project: string, timestamp: string): void {
    this.db.prepare(
      "INSERT OR REPLACE INTO index_state (key, value) VALUES (?, ?)",
    ).run(`last_ts:${harness}:${project}`, timestamp)
  }

  insertBatch(messages: Omit<IndexedMessage, 'id'>[]): number {
    if (messages.length === 0) return 0

    const insert = this.db.prepare(`
      INSERT INTO messages (session_id, harness, project, repo, branch, role, timestamp, content)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `)

    let count = 0
    const tx = this.db.transaction(() => {
      for (const msg of messages) {
        insert.run(
          msg.sessionId, msg.harness, msg.project, msg.repo, msg.branch,
          msg.role, msg.timestamp, msg.content,
        )
        count++
      }
    })
    tx()
    return count
  }

  close(): void {
    this.db.close()
  }
}

// ─── Indexers ────────────────────────────────────────────────────────

function decodeProjectDir(dirName: string): string {
  // -home-drew-code-foreman → /home/drew/code/foreman
  // Lossy encoding, but we match forward from known repo paths
  return '/' + dirName.replace(/^-/, '').replace(/-/g, '/')
}

function extractTextFromContent(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''

  const parts: string[] = []
  for (const block of content) {
    if (typeof block !== 'object' || block === null) continue
    const b = block as Record<string, unknown>
    if (b.type === 'text' && typeof b.text === 'string') {
      parts.push(b.text)
    } else if (b.type === 'tool_use') {
      const name = b.name as string ?? ''
      const input = b.input as Record<string, unknown> ?? {}
      if (name === 'Bash' && typeof input.command === 'string') {
        parts.push(`[bash] ${input.command}`)
      } else if (name === 'Read' && typeof input.file_path === 'string') {
        parts.push(`[read] ${input.file_path}`)
      } else if (name === 'Write' && typeof input.file_path === 'string') {
        parts.push(`[write] ${input.file_path}`)
      } else if (name === 'Edit' && typeof input.file_path === 'string') {
        parts.push(`[edit] ${input.file_path}`)
      } else if (name === 'Grep' && typeof input.pattern === 'string') {
        parts.push(`[grep] ${input.pattern}`)
      } else if (name) {
        parts.push(`[${name}]`)
      }
    } else if (b.type === 'tool_result') {
      // Skip tool results — too noisy for search
    }
  }
  return parts.join('\n')
}

export async function indexClaudeSessions(
  index: SessionIndex,
  options?: { maxAge?: number; onProgress?: (msg: string) => void },
): Promise<number> {
  const root = join(homedir(), '.claude', 'projects')
  const maxAge = options?.maxAge ?? 30 * 24 * 3600 * 1000 // 30 days default
  const log = options?.onProgress ?? (() => {})
  const cutoff = Date.now() - maxAge

  let dirs: string[]
  try {
    dirs = (await readdir(root, { withFileTypes: true }))
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
  } catch {
    return 0
  }

  let totalIndexed = 0

  for (const dirName of dirs) {
    const dir = join(root, dirName)
    const lastTs = index.getLastIndexedTimestamp('claude', dirName)
    const lastTsMs = lastTs ? new Date(lastTs).getTime() : 0

    let files: string[]
    try {
      files = (await readdir(dir)).filter((f) => f.endsWith('.jsonl'))
    } catch { continue }

    for (const file of files) {
      const filePath = join(dir, file)
      let fileStat
      try { fileStat = await stat(filePath) } catch { continue }
      if (fileStat.mtimeMs < cutoff) continue
      if (fileStat.mtimeMs <= lastTsMs) continue

      const sessionId = file.replace('.jsonl', '')
      const messages: Omit<IndexedMessage, 'id'>[] = []

      try {
        const stream = createReadStream(filePath, { encoding: 'utf8', highWaterMark: 64 * 1024 })
        const rl = createInterface({ input: stream, crlfDelay: Infinity })

        for await (const line of rl) {
          if (!line.trim()) continue
          try {
            const entry = JSON.parse(line) as Record<string, unknown>
            const type = entry.type as string
            if (type !== 'user' && type !== 'assistant') continue

            const msg = entry.message as Record<string, unknown> | undefined
            if (!msg) continue

            const content = extractTextFromContent(msg.content)
            if (!content || content.length < 5) continue
            // Skip XML system content
            if (content.startsWith('<system-reminder>') || content.startsWith('<local-command-caveat>')) continue

            const role = type === 'user' ? 'user' as const : 'assistant' as const
            const timestamp = typeof entry.timestamp === 'string'
              ? entry.timestamp
              : typeof entry.timestamp === 'number'
                ? new Date(entry.timestamp).toISOString()
                : new Date().toISOString()

            const branch = typeof entry.gitBranch === 'string' ? entry.gitBranch : ''
            // Extract repo name: -home-drew-code-foreman → foreman
            // For deeper paths like -home-drew-code-agent-dev-container, we can't
            // reliably split, so store the full project dir and use cwd if available
            const cwd = typeof entry.cwd === 'string' ? entry.cwd : ''
            const repo = cwd ? cwd.split('/').pop() ?? '' : ''

            messages.push({
              sessionId,
              harness: 'claude',
              project: dirName,
              repo,
              branch,
              role,
              timestamp,
              content: content.slice(0, 5000), // cap per-message size
            })
          } catch { continue }
        }
      } catch { continue }

      if (messages.length > 0) {
        const count = index.insertBatch(messages)
        totalIndexed += count
        log(`  claude/${dirName}/${sessionId}: ${count} messages`)
      }
    }

    // Update high-water mark
    index.setLastIndexedTimestamp('claude', dirName, new Date().toISOString())
  }

  return totalIndexed
}

export async function indexCodexSessions(
  index: SessionIndex,
  options?: { maxAge?: number; onProgress?: (msg: string) => void },
): Promise<number> {
  const historyPath = join(homedir(), '.codex', 'history.jsonl')
  const log = options?.onProgress ?? (() => {})
  const maxAge = options?.maxAge ?? 30 * 24 * 3600 * 1000
  const cutoff = Date.now() - maxAge

  const lastTs = index.getLastIndexedTimestamp('codex', 'history')
  const lastTsMs = lastTs ? new Date(lastTs).getTime() : 0

  let fileStat
  try { fileStat = await stat(historyPath) } catch { return 0 }
  if (fileStat.mtimeMs <= lastTsMs) return 0

  const messages: Omit<IndexedMessage, 'id'>[] = []

  try {
    const stream = createReadStream(historyPath, { encoding: 'utf8', highWaterMark: 64 * 1024 })
    const rl = createInterface({ input: stream, crlfDelay: Infinity })

    for await (const line of rl) {
      if (!line.trim()) continue
      try {
        const entry = JSON.parse(line) as { session_id?: string; ts?: string; text?: string }
        if (!entry.text || entry.text.length < 10) continue

        const ts = entry.ts ? new Date(entry.ts) : new Date()
        if (ts.getTime() < cutoff) continue
        if (ts.getTime() <= lastTsMs) continue

        messages.push({
          sessionId: entry.session_id ?? 'unknown',
          harness: 'codex',
          project: '',
          repo: '',
          branch: '',
          role: 'user',
          timestamp: ts.toISOString(),
          content: entry.text.slice(0, 5000),
        })
      } catch { continue }
    }
  } catch { return 0 }

  if (messages.length > 0) {
    const count = index.insertBatch(messages)
    log(`  codex/history: ${count} messages`)
    index.setLastIndexedTimestamp('codex', 'history', new Date().toISOString())
    return count
  }

  return 0
}

export async function indexOpencodeSessions(
  index: SessionIndex,
  options?: { maxAge?: number; onProgress?: (msg: string) => void },
): Promise<number> {
  const messagesDir = join(homedir(), '.local', 'share', 'opencode', 'storage', 'message')
  const sessionsDir = join(homedir(), '.local', 'share', 'opencode', 'storage', 'session', 'global')
  const log = options?.onProgress ?? (() => {})
  const maxAge = options?.maxAge ?? 30 * 24 * 3600 * 1000
  const cutoff = Date.now() - maxAge

  // Load session metadata for directory info
  const sessionMeta = new Map<string, { directory?: string; title?: string }>()
  try {
    for (const file of await readdir(sessionsDir)) {
      if (!file.endsWith('.json')) continue
      try {
        const raw = await readFile(join(sessionsDir, file), 'utf8')
        const ses = JSON.parse(raw)
        sessionMeta.set(ses.id, { directory: ses.directory, title: ses.title })
      } catch { continue }
    }
  } catch { return 0 }

  let sesDirs: string[]
  try {
    sesDirs = await readdir(messagesDir)
  } catch { return 0 }

  let totalIndexed = 0

  for (const sesId of sesDirs) {
    const lastTs = index.getLastIndexedTimestamp('opencode', sesId)
    const lastTsMs = lastTs ? new Date(lastTs).getTime() : 0

    const sesDir = join(messagesDir, sesId)
    let dirStat
    try { dirStat = await stat(sesDir) } catch { continue }
    if (dirStat.mtimeMs < cutoff) continue
    if (dirStat.mtimeMs <= lastTsMs) continue

    const meta = sessionMeta.get(sesId)
    const repo = meta?.directory?.split('/').pop() ?? ''

    let msgFiles: string[]
    try { msgFiles = (await readdir(sesDir)).filter((f) => f.endsWith('.json')) } catch { continue }

    const messages: Omit<IndexedMessage, 'id'>[] = []
    // Also read parts for the actual text content
    const partsDir = join(homedir(), '.local', 'share', 'opencode', 'storage', 'part')

    for (const msgFile of msgFiles) {
      try {
        const raw = await readFile(join(sesDir, msgFile), 'utf8')
        const msg = JSON.parse(raw)
        const role = msg.role === 'user' ? 'user' as const
          : msg.role === 'assistant' ? 'assistant' as const
          : null
        if (!role) continue

        // Get text content from parts
        const msgId = msg.id as string
        let content = ''
        try {
          const partFiles = await readdir(join(partsDir, msgId))
          for (const pf of partFiles) {
            if (!pf.endsWith('.json')) continue
            const partRaw = await readFile(join(partsDir, msgId, pf), 'utf8')
            const part = JSON.parse(partRaw)
            if (part.type === 'text' && typeof part.text === 'string') {
              content += part.text + '\n'
            } else if (part.type === 'tool-invocation' && typeof part.toolName === 'string') {
              content += `[${part.toolName}]\n`
            }
          }
        } catch { /* no parts */ }

        // Fall back to summary title for user messages
        if (!content && role === 'user' && msg.summary?.title) {
          content = msg.summary.title
        }

        if (!content || content.length < 5) continue

        const timestamp = msg.time?.created
          ? new Date(msg.time.created).toISOString()
          : new Date().toISOString()

        messages.push({
          sessionId: sesId,
          harness: 'opencode',
          project: meta?.directory ?? '',
          repo,
          branch: '',
          role,
          timestamp,
          content: content.slice(0, 5000),
        })
      } catch { continue }
    }

    if (messages.length > 0) {
      const count = index.insertBatch(messages)
      totalIndexed += count
      log(`  opencode/${sesId}: ${count} messages`)
    }

    index.setLastIndexedTimestamp('opencode', sesId, new Date().toISOString())
  }

  return totalIndexed
}

export async function indexAllSessions(
  options?: { maxAge?: number; onProgress?: (msg: string) => void },
): Promise<{ index: SessionIndex; stats: IndexStats }> {
  const log = options?.onProgress ?? (() => {})
  const index = new SessionIndex()

  log('Indexing Claude sessions...')
  const claudeCount = await indexClaudeSessions(index, options)
  log(`  ${claudeCount} new Claude messages indexed`)

  log('Indexing Codex sessions...')
  const codexCount = await indexCodexSessions(index, options)
  log(`  ${codexCount} new Codex messages indexed`)

  log('Indexing Opencode sessions...')
  const opencodeCount = await indexOpencodeSessions(index, options)
  log(`  ${opencodeCount} new Opencode messages indexed`)

  const s = index.stats()
  log(`Total: ${s.totalMessages} messages across ${s.totalSessions} sessions`)

  return { index, stats: s }
}
