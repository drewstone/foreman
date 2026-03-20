/**
 * Versioned artifact store.
 *
 * Universal versioning primitive for every text artifact Foreman produces
 * or optimizes: CLAUDE.md templates, judge directives, rubrics, system
 * prompts, heartbeat configs, repair recipes, operator profiles.
 *
 * Each artifact is identified by (kind, name). Each version has an ID,
 * content hash, timestamp, optional score, and active/retired status.
 *
 * Storage layout:
 *   {root}/{kind}/{name}/
 *     manifest.json        — version list, active pointer, scores
 *     v001.txt             — version content
 *     v002.txt
 *     ...
 *
 * The manifest is the source of truth. Version files are immutable once written.
 */

import { createHash } from 'node:crypto'
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { homedir } from 'node:os'

export interface ArtifactVersion {
  id: string
  hash: string
  timestamp: string
  source?: string
  scores: Array<{
    judgeId: string
    score: number
    maxScore: number
    timestamp: string
  }>
  averageScore: number | null
  status: 'active' | 'candidate' | 'retired'
}

export interface ArtifactManifest {
  kind: string
  name: string
  activeVersionId: string | null
  versions: ArtifactVersion[]
  promotionHistory: Array<{
    timestamp: string
    fromVersionId: string | null
    toVersionId: string
    reason: string
  }>
}

export interface PutResult {
  version: ArtifactVersion
  isNew: boolean
  isDuplicate: boolean
}

function contentHash(content: string): string {
  return createHash('sha256').update(content).digest('hex').slice(0, 12)
}

function nextVersionId(versions: ArtifactVersion[]): string {
  let max = 0
  for (const v of versions) {
    const num = parseInt(v.id.replace('v', ''), 10)
    if (num > max) max = num
  }
  return `v${String(max + 1).padStart(3, '0')}`
}

export class VersionedStore {
  private root: string

  constructor(rootDir?: string) {
    this.root = resolve(rootDir ?? join(
      process.env.FOREMAN_HOME ?? join(homedir(), '.foreman'),
      'artifacts',
    ))
  }

  private artifactDir(kind: string, name: string): string {
    return join(this.root, sanitize(kind), sanitize(name))
  }

  private manifestPath(kind: string, name: string): string {
    return join(this.artifactDir(kind, name), 'manifest.json')
  }

  private versionPath(kind: string, name: string, versionId: string): string {
    return join(this.artifactDir(kind, name), `${versionId}.txt`)
  }

  async getManifest(kind: string, name: string): Promise<ArtifactManifest> {
    try {
      const raw = await readFile(this.manifestPath(kind, name), 'utf8')
      return JSON.parse(raw) as ArtifactManifest
    } catch {
      return {
        kind,
        name,
        activeVersionId: null,
        versions: [],
        promotionHistory: [],
      }
    }
  }

  private async saveManifest(manifest: ArtifactManifest): Promise<void> {
    const dir = this.artifactDir(manifest.kind, manifest.name)
    await mkdir(dir, { recursive: true })
    await writeFile(
      this.manifestPath(manifest.kind, manifest.name),
      JSON.stringify(manifest, null, 2) + '\n',
      'utf8',
    )
  }

  /**
   * Store a new version. If content is identical to an existing version
   * (by hash), returns the existing version without creating a duplicate.
   */
  async put(kind: string, name: string, content: string, options?: {
    source?: string
    activate?: boolean
  }): Promise<PutResult> {
    const manifest = await this.getManifest(kind, name)
    const hash = contentHash(content)

    // Check for duplicate
    const existing = manifest.versions.find((v) => v.hash === hash)
    if (existing) {
      return { version: existing, isNew: false, isDuplicate: true }
    }

    const id = nextVersionId(manifest.versions)
    const version: ArtifactVersion = {
      id,
      hash,
      timestamp: new Date().toISOString(),
      source: options?.source,
      scores: [],
      averageScore: null,
      status: 'candidate',
    }

    manifest.versions.push(version)

    // Write version content
    const dir = this.artifactDir(kind, name)
    await mkdir(dir, { recursive: true })
    await writeFile(this.versionPath(kind, name, id), content, 'utf8')

    // Auto-activate if first version or explicitly requested
    if (manifest.activeVersionId === null || options?.activate) {
      const prevId = manifest.activeVersionId
      manifest.activeVersionId = id
      version.status = 'active'

      // Retire previous active
      if (prevId) {
        const prev = manifest.versions.find((v) => v.id === prevId)
        if (prev) prev.status = 'retired'
      }

      manifest.promotionHistory.push({
        timestamp: version.timestamp,
        fromVersionId: prevId,
        toVersionId: id,
        reason: options?.activate ? 'explicit activation' : 'first version',
      })
    }

    await this.saveManifest(manifest)
    return { version, isNew: true, isDuplicate: false }
  }

  /**
   * Get the content of the active version.
   */
  async getActive(kind: string, name: string): Promise<{ version: ArtifactVersion; content: string } | null> {
    const manifest = await this.getManifest(kind, name)
    if (!manifest.activeVersionId) return null

    const version = manifest.versions.find((v) => v.id === manifest.activeVersionId)
    if (!version) return null

    try {
      const content = await readFile(this.versionPath(kind, name, version.id), 'utf8')
      return { version, content }
    } catch {
      return null
    }
  }

  /**
   * Get content of a specific version.
   */
  async getVersion(kind: string, name: string, versionId: string): Promise<{ version: ArtifactVersion; content: string } | null> {
    const manifest = await this.getManifest(kind, name)
    const version = manifest.versions.find((v) => v.id === versionId)
    if (!version) return null

    try {
      const content = await readFile(this.versionPath(kind, name, version.id), 'utf8')
      return { version, content }
    } catch {
      return null
    }
  }

  /**
   * Promote a version to active.
   */
  async promote(kind: string, name: string, versionId: string, reason?: string): Promise<void> {
    const manifest = await this.getManifest(kind, name)
    const version = manifest.versions.find((v) => v.id === versionId)
    if (!version) throw new Error(`Version ${versionId} not found for ${kind}/${name}`)

    const prevId = manifest.activeVersionId
    if (prevId === versionId) return // already active

    // Retire previous active
    if (prevId) {
      const prev = manifest.versions.find((v) => v.id === prevId)
      if (prev) prev.status = 'retired'
    }

    version.status = 'active'
    manifest.activeVersionId = versionId
    manifest.promotionHistory.push({
      timestamp: new Date().toISOString(),
      fromVersionId: prevId,
      toVersionId: versionId,
      reason: reason ?? 'manual promotion',
    })

    await this.saveManifest(manifest)
  }

  /**
   * Roll back to the previous active version.
   */
  async rollback(kind: string, name: string, reason?: string): Promise<ArtifactVersion | null> {
    const manifest = await this.getManifest(kind, name)
    if (manifest.promotionHistory.length < 2) return null

    const lastPromotion = manifest.promotionHistory[manifest.promotionHistory.length - 1]
    const prevId = lastPromotion?.fromVersionId
    if (!prevId) return null

    const prevVersion = manifest.versions.find((v) => v.id === prevId)
    if (!prevVersion) return null

    await this.promote(kind, name, prevId, reason ?? 'rollback')
    return prevVersion
  }

  /**
   * Record a score for a version from a judge.
   */
  async score(kind: string, name: string, versionId: string, score: {
    judgeId: string
    score: number
    maxScore: number
  }): Promise<void> {
    const manifest = await this.getManifest(kind, name)
    const version = manifest.versions.find((v) => v.id === versionId)
    if (!version) throw new Error(`Version ${versionId} not found for ${kind}/${name}`)

    version.scores.push({
      ...score,
      timestamp: new Date().toISOString(),
    })

    // Recompute average
    const totalScore = version.scores.reduce((s, sc) => s + sc.score / sc.maxScore, 0)
    version.averageScore = totalScore / version.scores.length

    await this.saveManifest(manifest)
  }

  /**
   * List all versions of an artifact.
   */
  async list(kind: string, name: string): Promise<ArtifactVersion[]> {
    const manifest = await this.getManifest(kind, name)
    return manifest.versions
  }

  /**
   * List all artifact names for a kind.
   */
  async listNames(kind: string): Promise<string[]> {
    const dir = join(this.root, sanitize(kind))
    try {
      const entries = await readdir(dir, { withFileTypes: true })
      return entries.filter((e) => e.isDirectory()).map((e) => e.name).sort()
    } catch {
      return []
    }
  }

  /**
   * List all kinds.
   */
  async listKinds(): Promise<string[]> {
    try {
      const entries = await readdir(this.root, { withFileTypes: true })
      return entries.filter((e) => e.isDirectory()).map((e) => e.name).sort()
    } catch {
      return []
    }
  }

  /**
   * Get the best-scoring version (for optimization loops).
   */
  async getBest(kind: string, name: string): Promise<{ version: ArtifactVersion; content: string } | null> {
    const manifest = await this.getManifest(kind, name)
    const scored = manifest.versions
      .filter((v) => v.averageScore !== null)
      .sort((a, b) => (b.averageScore ?? 0) - (a.averageScore ?? 0))

    if (scored.length === 0) return null

    const best = scored[0]
    try {
      const content = await readFile(this.versionPath(kind, name, best.id), 'utf8')
      return { version: best, content }
    } catch {
      return null
    }
  }

  /**
   * Auto-promote: if a candidate has enough scores and beats the active
   * version, promote it. Returns the promoted version or null.
   */
  async autoPromote(kind: string, name: string, options?: {
    minScores?: number
    minImprovement?: number
  }): Promise<ArtifactVersion | null> {
    const minScores = options?.minScores ?? 3
    const minImprovement = options?.minImprovement ?? 0.05

    const manifest = await this.getManifest(kind, name)
    const active = manifest.versions.find((v) => v.id === manifest.activeVersionId)
    const activeAvg = active?.averageScore ?? 0

    const candidates = manifest.versions
      .filter((v) => v.status === 'candidate' && v.scores.length >= minScores && v.averageScore !== null)
      .sort((a, b) => (b.averageScore ?? 0) - (a.averageScore ?? 0))

    const best = candidates[0]
    if (!best || (best.averageScore ?? 0) - activeAvg < minImprovement) return null

    await this.promote(kind, name, best.id,
      `auto-promote: ${best.averageScore?.toFixed(3)} vs active ${activeAvg.toFixed(3)} (improvement ${((best.averageScore ?? 0) - activeAvg).toFixed(3)})`,
    )
    return best
  }
}

function sanitize(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'item'
}
