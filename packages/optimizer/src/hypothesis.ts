/**
 * Hypothesis discipline for meta-harness proposals.
 *
 * Every proposal must include a falsifiable hypothesis, a named base system,
 * and explicit mechanism changes. Prevents degeneration into parameter tweaks.
 *
 * From the meta-harness paper: "the most common failure mode is creating
 * systems that are just parameter variants."
 */

export interface Hypothesis {
  /** Unique proposal ID */
  id: string
  /** Which iteration of the evolution loop */
  iteration: number
  /** The variant name (snake_case, becomes filename) */
  name: string
  /** Falsifiable claim: "this will improve X by Y because Z" */
  hypothesis: string
  /** What existing harness this builds on */
  baseSystem: string
  /** Explicit mechanism changes — what's structurally different */
  changes: string[]
  /** exploration (new approach) or exploitation (refine existing) */
  axis: 'exploration' | 'exploitation'
  /** Path to the proposed code file */
  filePath: string
  /** ISO timestamp */
  timestamp: string
}

export interface HypothesisValidation {
  valid: boolean
  rejectionReason?: string
}

const PARAMETER_VARIANT_PATTERNS = [
  /\bchange\s+\w+\s+from\s+\d+\s+to\s+\d+/i,
  /\bincrease\s+\w+\s+(?:to|by)\s+\d+/i,
  /\bdecrease\s+\w+\s+(?:to|by)\s+\d+/i,
  /\bset\s+\w+\s*=\s*\d+/i,
  /\btune\s+\w+/i,
  /\badjust\s+(?:the\s+)?\w+\s+(?:parameter|threshold|limit|count|size|number)/i,
]

/**
 * Validate a hypothesis before allowing benchmark evaluation.
 * Rejects parameter-only changes and empty hypotheses.
 */
export function validateHypothesis(h: Hypothesis): HypothesisValidation {
  if (!h.hypothesis || h.hypothesis.trim().length < 20) {
    return { valid: false, rejectionReason: 'hypothesis too short — must be a substantive falsifiable claim' }
  }

  if (!h.baseSystem || h.baseSystem.trim().length === 0) {
    return { valid: false, rejectionReason: 'base system required — what are you building on?' }
  }

  if (!h.changes || h.changes.length === 0) {
    return { valid: false, rejectionReason: 'no mechanism changes listed — what is structurally different?' }
  }

  // Reject obvious parameter variants
  const allChanges = h.changes.join(' ')
  for (const pattern of PARAMETER_VARIANT_PATTERNS) {
    if (pattern.test(allChanges) && h.changes.length === 1) {
      return {
        valid: false,
        rejectionReason: `looks like a parameter variant ("${h.changes[0]}"). Change the mechanism, not the numbers.`,
      }
    }
  }

  if (!h.name || !/^[a-z][a-z0-9_]*$/.test(h.name)) {
    return { valid: false, rejectionReason: 'name must be snake_case (e.g., draft_verification)' }
  }

  return { valid: true }
}

/**
 * Parse a hypothesis from CC's pending_eval.json output.
 */
export function parseHypothesis(json: string, iteration: number): Hypothesis | null {
  try {
    const raw = JSON.parse(json)
    return {
      id: `hyp-${iteration}-${raw.name ?? 'unknown'}`,
      iteration,
      name: raw.name ?? '',
      hypothesis: raw.hypothesis ?? '',
      baseSystem: raw.base_system ?? raw.baseSystem ?? '',
      changes: Array.isArray(raw.changes) ? raw.changes : [],
      axis: raw.axis === 'exploration' ? 'exploration' : 'exploitation',
      filePath: raw.file ?? raw.filePath ?? '',
      timestamp: new Date().toISOString(),
    }
  } catch {
    return null
  }
}
