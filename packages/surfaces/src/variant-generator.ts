/**
 * Artifact variant generator.
 *
 * Reads the current best version of an artifact + its judge scores,
 * then uses an LLM to propose a new variant that addresses the weaknesses.
 * The new variant is stored as a candidate in the VersionedStore.
 *
 * This is the "create new variants" step that the AxPromptOptimizerAdapter
 * doesn't do — GEPA selects between variants, this generates them.
 *
 * Works for any versioned artifact: CLAUDE.md templates, judge directives,
 * repair strategies, system prompts.
 */

import { VersionedStore, type ArtifactVersion } from '@drew/foreman-core'
import { createClaudeProvider, type TextProvider } from '@drew/foreman-providers'
import { parseJsonOutput } from '@drew/foreman-providers'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { mkdir, writeFile } from 'node:fs/promises'

const FOREMAN_HOME = process.env.FOREMAN_HOME ?? join(homedir(), '.foreman')

export interface VariantProposal {
  kind: string
  name: string
  currentVersionId: string
  proposedContent: string
  rationale: string
  targetDimensions: string[]
}

export interface GenerateVariantsOptions {
  /** Which artifact kinds/names to generate variants for. Default: all with scores. */
  targets?: Array<{ kind: string; name: string }>
  /** Max variants to generate per artifact. Default: 1. */
  maxPerArtifact?: number
  /** Provider to use for generation. Default: claude. */
  provider?: TextProvider
  /** Only generate for artifacts scoring below this threshold (0-1). Default: 0.8. */
  scoreThreshold?: number
  onProgress?: (msg: string) => void
}

export async function generateVariants(options?: GenerateVariantsOptions): Promise<VariantProposal[]> {
  const store = new VersionedStore()
  const provider = options?.provider ?? createClaudeProvider('variant-gen', { model: 'claude-sonnet-4-6' })
  const threshold = options?.scoreThreshold ?? 0.8
  const maxPer = options?.maxPerArtifact ?? 1
  const log = options?.onProgress ?? (() => {})
  const proposals: VariantProposal[] = []

  // Find targets
  let targets = options?.targets
  if (!targets) {
    targets = []
    const kinds = await store.listKinds()
    for (const kind of kinds) {
      const names = await store.listNames(kind)
      for (const name of names) {
        targets.push({ kind, name })
      }
    }
  }

  for (const { kind, name } of targets) {
    const active = await store.getActive(kind, name)
    if (!active) continue

    // Only generate variants for artifacts with scores below threshold
    if (active.version.averageScore !== null && active.version.averageScore >= threshold) {
      log(`  ${kind}/${name}: ${active.version.averageScore.toFixed(2)} >= ${threshold} — skipping`)
      continue
    }

    // Skip if no scores yet (need data to know what to improve)
    if (active.version.scores.length === 0) {
      log(`  ${kind}/${name}: no scores yet — skipping`)
      continue
    }

    log(`  ${kind}/${name} @ ${active.version.id}: score ${active.version.averageScore?.toFixed(3)} — generating variant...`)

    // Build the generation prompt
    const scoreDetails = active.version.scores
      .map((s) => `  ${s.judgeId}: ${s.score}/${s.maxScore} (${(s.score / s.maxScore * 100).toFixed(0)}%)`)
      .join('\n')

    const prompt = `You are improving a Foreman artifact. Your job is to propose a better version that addresses the weak dimensions identified by judges.

## Current artifact
Kind: ${kind}
Name: ${name}
Version: ${active.version.id}
Average score: ${active.version.averageScore?.toFixed(3)}

## Judge scores
${scoreDetails}

## Current content
\`\`\`
${active.content}
\`\`\`

## Instructions
Propose an improved version of this artifact that would score higher. Focus on the dimensions where scores are lowest.

Return ONLY valid JSON:
{
  "content": "the full improved artifact text",
  "rationale": "one paragraph explaining what you changed and why",
  "targetDimensions": ["dimension1", "dimension2"]
}

Be specific in your improvements. Don't just add words — restructure, sharpen, remove noise, add precision. The goal is measurably better judge scores.`

    try {
      const execution = await provider.run(prompt, { timeoutMs: 60_000 })
      if (execution.exitCode !== 0) {
        log(`    generation failed: exit ${execution.exitCode}`)
        continue
      }

      const parsed = parseJsonOutput(execution.stdout) as {
        content?: string
        rationale?: string
        targetDimensions?: string[]
      }

      if (!parsed.content || typeof parsed.content !== 'string') {
        log(`    generation returned no content`)
        continue
      }

      // Store as candidate
      const result = await store.put(kind, name, parsed.content, {
        source: `variant-gen from ${active.version.id}`,
      })

      if (result.isDuplicate) {
        log(`    generated duplicate of existing version`)
        continue
      }

      const proposal: VariantProposal = {
        kind,
        name,
        currentVersionId: active.version.id,
        proposedContent: parsed.content,
        rationale: parsed.rationale ?? 'No rationale provided',
        targetDimensions: parsed.targetDimensions ?? [],
      }
      proposals.push(proposal)
      log(`    created ${result.version.id}: ${parsed.rationale?.slice(0, 100)}`)
    } catch (e) {
      log(`    generation error: ${e}`)
    }
  }

  // Save generation trace
  try {
    const traceDir = join(FOREMAN_HOME, 'traces', 'variant-gen')
    await mkdir(traceDir, { recursive: true })
    await writeFile(
      join(traceDir, `${new Date().toISOString().replace(/[:.]/g, '-')}.json`),
      JSON.stringify({
        timestamp: new Date().toISOString(),
        proposals: proposals.map((p) => ({
          kind: p.kind,
          name: p.name,
          from: p.currentVersionId,
          rationale: p.rationale,
          targets: p.targetDimensions,
        })),
      }, null, 2) + '\n',
      'utf8',
    )
  } catch { /* best effort */ }

  return proposals
}
