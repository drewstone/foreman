/**
 * Skill Proposal System
 *
 * Foreman learns patterns from sessions and outcomes that should become
 * skill improvements. Instead of modifying the operator's skills directly,
 * it writes proposals to ~/.foreman/skill-proposals/ with full analysis.
 *
 * Each proposal includes:
 * - The proposed SKILL.md (new or modified)
 * - A diff against the current version
 * - Evidence (which outcomes/sessions motivated this)
 * - Impact analysis (what improves, what could go wrong)
 * - Quality/quantity metrics (deps, length, CLI usage, etc.)
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync } from 'node:fs'
import { join, basename } from 'node:path'
import { execFileSync } from 'node:child_process'
import { homedir } from 'node:os'

const FOREMAN_HOME = process.env.FOREMAN_HOME ?? join(homedir(), '.foreman')
const PROPOSALS_DIR = join(FOREMAN_HOME, 'skill-proposals')
const CLAUDE_SKILLS_DIR = join(homedir(), '.claude', 'skills')

export interface SkillMetrics {
  lineCount: number
  wordCount: number
  sectionCount: number        // ## headings
  ruleCount: number           // numbered rules
  codeBlockCount: number      // ``` blocks
  tableCount: number          // | tables
  skillReferences: string[]   // other skills referenced (/evolve, /pursue, etc.)
  cliCommands: string[]       // shell commands mentioned
  externalDeps: string[]      // npm packages, APIs, tools referenced
  hasExamples: boolean
  hasRules: boolean
  hasRelationshipSection: boolean
}

export interface SkillDiff {
  type: 'new' | 'modified'
  addedLines: number
  removedLines: number
  addedSections: string[]
  removedSections: string[]
  addedRules: string[]
  removedRules: string[]
  addedDeps: string[]
  removedDeps: string[]
  addedCliCommands: string[]
  removedCliCommands: string[]
  addedSkillRefs: string[]
  removedSkillRefs: string[]
  textDelta: number            // positive = longer, negative = shorter
  complexityDelta: number      // based on sections + rules + code blocks
}

export interface SkillProposal {
  id: string
  skillName: string
  type: 'new' | 'improvement'
  status: 'proposed' | 'approved' | 'rejected'
  proposedAt: string

  // The actual content
  proposedSkillMd: string
  currentSkillMd: string | null   // null for new skills

  // Analysis
  evidence: string[]               // decision IDs, session patterns that motivated this
  whatImproves: string[]           // specific improvements with reasoning
  whatCouldGoWrong: string[]       // risks and failure modes
  whatWouldBeRemoved: string[]     // capabilities lost or changed

  // Metrics
  currentMetrics: SkillMetrics | null
  proposedMetrics: SkillMetrics
  diff: SkillDiff
}

// ─── Skill analysis ──────────────────────────────────────────────────

export function analyzeSkill(content: string): SkillMetrics {
  const lines = content.split('\n')

  // Sections (## headings)
  const sections = lines.filter(l => l.match(/^#{1,3}\s/))

  // Rules (numbered items in a Rules section)
  const ruleMatches = content.match(/^\d+\.\s+\*\*.+?\*\*/gm) ?? []

  // Code blocks
  const codeBlocks = content.match(/```[\s\S]*?```/g) ?? []

  // Tables
  const tables = content.match(/\|.*\|.*\|/g) ?? []

  // Skill references
  const skillRefs = [...new Set((content.match(/\/(?:evolve|pursue|polish|verify|research|converge|critical-audit|diagnose|improve|reflect|capture-decisions|bad|loop)\b/g) ?? []))]

  // CLI commands (lines starting with common command patterns)
  const cliCommands = [...new Set(lines
    .filter(l => l.match(/^\s*(npm|npx|pnpm|yarn|git|docker|curl|pip|cargo|tsx|node|python|bash|sh)\s/))
    .map(l => l.trim().split(' ').slice(0, 3).join(' '))
  )]

  // External deps (npm packages, APIs)
  const depMatches = content.match(/@[\w-]+\/[\w-]+|https?:\/\/\S+/g) ?? []
  const externalDeps = [...new Set(depMatches)]

  return {
    lineCount: lines.length,
    wordCount: content.split(/\s+/).length,
    sectionCount: sections.length,
    ruleCount: ruleMatches.length,
    codeBlockCount: codeBlocks.length,
    tableCount: Math.floor(tables.length / 2), // rough: header + separator = 2 lines per table
    skillReferences: skillRefs,
    cliCommands,
    externalDeps,
    hasExamples: content.includes('example') || content.includes('Example') || codeBlocks.length > 0,
    hasRules: content.includes('## Rules') || ruleMatches.length > 0,
    hasRelationshipSection: content.includes('Relationship to Other Skills') || content.includes('Composing Skills'),
  }
}

export function diffSkills(current: string | null, proposed: string): SkillDiff {
  if (!current) {
    const metrics = analyzeSkill(proposed)
    return {
      type: 'new',
      addedLines: proposed.split('\n').length,
      removedLines: 0,
      addedSections: proposed.split('\n').filter(l => l.match(/^#{1,3}\s/)).map(l => l.replace(/^#+\s*/, '')),
      removedSections: [],
      addedRules: (proposed.match(/^\d+\.\s+\*\*.+?\*\*/gm) ?? []).map(r => r.replace(/^\d+\.\s+/, '')),
      removedRules: [],
      addedDeps: metrics.externalDeps,
      removedDeps: [],
      addedCliCommands: metrics.cliCommands,
      removedCliCommands: [],
      addedSkillRefs: metrics.skillReferences,
      removedSkillRefs: [],
      textDelta: proposed.split(/\s+/).length,
      complexityDelta: metrics.sectionCount + metrics.ruleCount + metrics.codeBlockCount,
    }
  }

  const currentMetrics = analyzeSkill(current)
  const proposedMetrics = analyzeSkill(proposed)

  const currentSections = new Set(current.split('\n').filter(l => l.match(/^#{1,3}\s/)).map(l => l.replace(/^#+\s*/, '')))
  const proposedSections = new Set(proposed.split('\n').filter(l => l.match(/^#{1,3}\s/)).map(l => l.replace(/^#+\s*/, '')))

  const currentLines = new Set(current.split('\n').map(l => l.trim()).filter(Boolean))
  const proposedLines = new Set(proposed.split('\n').map(l => l.trim()).filter(Boolean))

  return {
    type: 'modified',
    addedLines: [...proposedLines].filter(l => !currentLines.has(l)).length,
    removedLines: [...currentLines].filter(l => !proposedLines.has(l)).length,
    addedSections: [...proposedSections].filter(s => !currentSections.has(s)),
    removedSections: [...currentSections].filter(s => !proposedSections.has(s)),
    addedRules: (proposed.match(/^\d+\.\s+\*\*.+?\*\*/gm) ?? [])
      .filter(r => !current.includes(r)).map(r => r.replace(/^\d+\.\s+/, '')),
    removedRules: (current.match(/^\d+\.\s+\*\*.+?\*\*/gm) ?? [])
      .filter(r => !proposed.includes(r)).map(r => r.replace(/^\d+\.\s+/, '')),
    addedDeps: proposedMetrics.externalDeps.filter(d => !currentMetrics.externalDeps.includes(d)),
    removedDeps: currentMetrics.externalDeps.filter(d => !proposedMetrics.externalDeps.includes(d)),
    addedCliCommands: proposedMetrics.cliCommands.filter(c => !currentMetrics.cliCommands.includes(c)),
    removedCliCommands: currentMetrics.cliCommands.filter(c => !proposedMetrics.cliCommands.includes(c)),
    addedSkillRefs: proposedMetrics.skillReferences.filter(s => !currentMetrics.skillReferences.includes(s)),
    removedSkillRefs: currentMetrics.skillReferences.filter(s => !proposedMetrics.skillReferences.includes(s)),
    textDelta: proposedMetrics.wordCount - currentMetrics.wordCount,
    complexityDelta: (proposedMetrics.sectionCount + proposedMetrics.ruleCount + proposedMetrics.codeBlockCount)
      - (currentMetrics.sectionCount + currentMetrics.ruleCount + currentMetrics.codeBlockCount),
  }
}

// ─── Proposal management ─────────────────────────────────────────────

export function createProposal(opts: {
  skillName: string
  proposedSkillMd: string
  evidence: string[]
  whatImproves: string[]
  whatCouldGoWrong: string[]
  whatWouldBeRemoved: string[]
}): SkillProposal {
  const { skillName, proposedSkillMd, evidence, whatImproves, whatCouldGoWrong, whatWouldBeRemoved } = opts

  // Read current skill if it exists
  let currentSkillMd: string | null = null
  const currentPath = join(CLAUDE_SKILLS_DIR, skillName, 'SKILL.md')
  if (existsSync(currentPath)) {
    currentSkillMd = readFileSync(currentPath, 'utf8')
  }

  const currentMetrics = currentSkillMd ? analyzeSkill(currentSkillMd) : null
  const proposedMetrics = analyzeSkill(proposedSkillMd)
  const diff = diffSkills(currentSkillMd, proposedSkillMd)

  const id = `${skillName}-${Date.now().toString(36)}`

  const proposal: SkillProposal = {
    id,
    skillName,
    type: currentSkillMd ? 'improvement' : 'new',
    status: 'proposed',
    proposedAt: new Date().toISOString(),
    proposedSkillMd,
    currentSkillMd,
    evidence,
    whatImproves,
    whatCouldGoWrong,
    whatWouldBeRemoved,
    currentMetrics,
    proposedMetrics,
    diff,
  }

  // Write to disk
  const proposalDir = join(PROPOSALS_DIR, id)
  mkdirSync(proposalDir, { recursive: true })
  writeFileSync(join(proposalDir, 'proposal.json'), JSON.stringify(proposal, null, 2))
  writeFileSync(join(proposalDir, 'SKILL.md'), proposedSkillMd)
  if (currentSkillMd) {
    writeFileSync(join(proposalDir, 'SKILL.current.md'), currentSkillMd)
  }

  // Write a human-readable summary
  writeFileSync(join(proposalDir, 'REVIEW.md'), renderProposalReview(proposal))

  return proposal
}

export function listProposals(status?: string): SkillProposal[] {
  mkdirSync(PROPOSALS_DIR, { recursive: true })
  const proposals: SkillProposal[] = []

  for (const dir of readdirSync(PROPOSALS_DIR)) {
    const jsonPath = join(PROPOSALS_DIR, dir, 'proposal.json')
    if (!existsSync(jsonPath)) continue
    try {
      const p = JSON.parse(readFileSync(jsonPath, 'utf8')) as SkillProposal
      if (!status || p.status === status) proposals.push(p)
    } catch {}
  }

  return proposals.sort((a, b) => b.proposedAt.localeCompare(a.proposedAt))
}

export function updateProposalStatus(id: string, status: 'approved' | 'rejected'): boolean {
  const jsonPath = join(PROPOSALS_DIR, id, 'proposal.json')
  if (!existsSync(jsonPath)) return false

  const proposal = JSON.parse(readFileSync(jsonPath, 'utf8')) as SkillProposal
  proposal.status = status
  writeFileSync(jsonPath, JSON.stringify(proposal, null, 2))
  return true
}

// ─── Render human-readable review ────────────────────────────────────

function renderProposalReview(p: SkillProposal): string {
  const lines: string[] = []

  lines.push(`# Skill Proposal: ${p.skillName}`)
  lines.push(`Type: ${p.type} | Status: ${p.status} | Date: ${p.proposedAt}`)
  lines.push('')

  // Impact summary
  lines.push('## What Improves')
  for (const item of p.whatImproves) lines.push(`- ✅ ${item}`)
  lines.push('')

  lines.push('## What Could Go Wrong')
  for (const item of p.whatCouldGoWrong) lines.push(`- ⚠️ ${item}`)
  lines.push('')

  if (p.whatWouldBeRemoved.length > 0) {
    lines.push('## What Would Be Removed')
    for (const item of p.whatWouldBeRemoved) lines.push(`- 🗑️ ${item}`)
    lines.push('')
  }

  // Quality & quantity diff
  lines.push('## Quality & Quantity Diff')
  lines.push('')
  lines.push('| Metric | Current | Proposed | Delta |')
  lines.push('|---|---|---|---|')

  const cm = p.currentMetrics
  const pm = p.proposedMetrics

  if (cm) {
    lines.push(`| Lines | ${cm.lineCount} | ${pm.lineCount} | ${pm.lineCount - cm.lineCount > 0 ? '+' : ''}${pm.lineCount - cm.lineCount} |`)
    lines.push(`| Words | ${cm.wordCount} | ${pm.wordCount} | ${pm.wordCount - cm.wordCount > 0 ? '+' : ''}${pm.wordCount - cm.wordCount} |`)
    lines.push(`| Sections | ${cm.sectionCount} | ${pm.sectionCount} | ${pm.sectionCount - cm.sectionCount > 0 ? '+' : ''}${pm.sectionCount - cm.sectionCount} |`)
    lines.push(`| Rules | ${cm.ruleCount} | ${pm.ruleCount} | ${pm.ruleCount - cm.ruleCount > 0 ? '+' : ''}${pm.ruleCount - cm.ruleCount} |`)
    lines.push(`| Code blocks | ${cm.codeBlockCount} | ${pm.codeBlockCount} | ${pm.codeBlockCount - cm.codeBlockCount > 0 ? '+' : ''}${pm.codeBlockCount - cm.codeBlockCount} |`)
    lines.push(`| Tables | ${cm.tableCount} | ${pm.tableCount} | ${pm.tableCount - cm.tableCount > 0 ? '+' : ''}${pm.tableCount - cm.tableCount} |`)
    lines.push(`| Has examples | ${cm.hasExamples} | ${pm.hasExamples} | |`)
    lines.push(`| Has rules | ${cm.hasRules} | ${pm.hasRules} | |`)
  } else {
    lines.push(`| Lines | — | ${pm.lineCount} | new |`)
    lines.push(`| Words | — | ${pm.wordCount} | new |`)
    lines.push(`| Sections | — | ${pm.sectionCount} | new |`)
    lines.push(`| Rules | — | ${pm.ruleCount} | new |`)
    lines.push(`| Code blocks | — | ${pm.codeBlockCount} | new |`)
  }
  lines.push('')

  // Dependency changes
  if (p.diff.addedDeps.length > 0 || p.diff.removedDeps.length > 0) {
    lines.push('## Dependency Changes')
    for (const d of p.diff.addedDeps) lines.push(`- ➕ ${d}`)
    for (const d of p.diff.removedDeps) lines.push(`- ➖ ${d}`)
    lines.push('')
  }

  // CLI command changes
  if (p.diff.addedCliCommands.length > 0 || p.diff.removedCliCommands.length > 0) {
    lines.push('## CLI Usage Changes')
    for (const c of p.diff.addedCliCommands) lines.push(`- ➕ \`${c}\``)
    for (const c of p.diff.removedCliCommands) lines.push(`- ➖ \`${c}\``)
    lines.push('')
  }

  // Skill reference changes
  if (p.diff.addedSkillRefs.length > 0 || p.diff.removedSkillRefs.length > 0) {
    lines.push('## Skill Reference Changes')
    for (const s of p.diff.addedSkillRefs) lines.push(`- ➕ ${s}`)
    for (const s of p.diff.removedSkillRefs) lines.push(`- ➖ ${s}`)
    lines.push('')
  }

  // Section changes
  if (p.diff.addedSections.length > 0 || p.diff.removedSections.length > 0) {
    lines.push('## Section Changes')
    for (const s of p.diff.addedSections) lines.push(`- ➕ ${s}`)
    for (const s of p.diff.removedSections) lines.push(`- ➖ ${s}`)
    lines.push('')
  }

  // Evidence
  lines.push('## Evidence')
  for (const e of p.evidence) lines.push(`- ${e}`)
  lines.push('')

  lines.push(`## Full Proposed SKILL.md`)
  lines.push(`See \`SKILL.md\` in this directory.`)

  return lines.join('\n')
}
