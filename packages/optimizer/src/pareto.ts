/**
 * Pareto frontier tracking for multi-dimensional optimization.
 *
 * Instead of binary promote/abandon against a single baseline,
 * tracks a set of non-dominated solutions across N dimensions.
 * A solution dominates another if it's >= on all dimensions and > on at least one.
 */

export interface ParetoEntry<TConfig = string> {
  id: string
  config: TConfig
  scores: Record<string, number>
  hypothesis: string
  iteration: number
  timestamp: string
  metadata?: Record<string, string>
}

export interface ParetoFrontier<TConfig = string> {
  entries: ParetoEntry<TConfig>[]
  dimensions: string[]
  totalEvaluated: number
}

function dominates(a: Record<string, number>, b: Record<string, number>, dims: string[]): boolean {
  let strictlyBetter = false
  for (const dim of dims) {
    const va = a[dim] ?? 0
    const vb = b[dim] ?? 0
    if (va < vb) return false
    if (va > vb) strictlyBetter = true
  }
  return strictlyBetter
}

export function createFrontier<TConfig = string>(dimensions: string[]): ParetoFrontier<TConfig> {
  return { entries: [], dimensions, totalEvaluated: 0 }
}

/**
 * Add a candidate to the frontier. Returns true if the candidate
 * is non-dominated (added to frontier). Removes any entries
 * the new candidate dominates.
 */
export function addToFrontier<TConfig = string>(
  frontier: ParetoFrontier<TConfig>,
  candidate: ParetoEntry<TConfig>,
): boolean {
  frontier.totalEvaluated++

  // Check if any existing entry dominates the candidate
  for (const entry of frontier.entries) {
    if (dominates(entry.scores, candidate.scores, frontier.dimensions)) {
      return false // candidate is dominated
    }
  }

  // Remove entries that the candidate dominates
  frontier.entries = frontier.entries.filter(
    entry => !dominates(candidate.scores, entry.scores, frontier.dimensions)
  )

  frontier.entries.push(candidate)
  return true
}

/**
 * Get the best entry for a specific dimension.
 */
export function bestFor<TConfig = string>(
  frontier: ParetoFrontier<TConfig>,
  dimension: string,
): ParetoEntry<TConfig> | null {
  if (frontier.entries.length === 0) return null
  return frontier.entries.reduce((best, entry) =>
    (entry.scores[dimension] ?? 0) > (best.scores[dimension] ?? 0) ? entry : best
  )
}

/**
 * Serialize frontier for persistence.
 */
export function serializeFrontier<TConfig = string>(
  frontier: ParetoFrontier<TConfig>,
): string {
  return JSON.stringify(frontier, null, 2)
}

/**
 * Deserialize frontier from JSON string.
 */
export function deserializeFrontier<TConfig = string>(
  json: string,
): ParetoFrontier<TConfig> {
  return JSON.parse(json) as ParetoFrontier<TConfig>
}

/**
 * Summary stats for logging.
 */
export function frontierSummary<TConfig = string>(
  frontier: ParetoFrontier<TConfig>,
): string {
  const n = frontier.entries.length
  const total = frontier.totalEvaluated
  const dims = frontier.dimensions
    .map(d => {
      const best = bestFor(frontier, d)
      return best ? `${d}=${(best.scores[d] ?? 0).toFixed(3)}` : d
    })
    .join(', ')
  return `frontier: ${n} non-dominated / ${total} evaluated [${dims}]`
}
