/**
 * tcloud-runner — Foreman's LLM calls routed through the Tangle Router.
 *
 * Drop-in replacement for `claude-runner.ts`'s `callClaude` shape. When
 * FOREMAN_USE_TCLOUD=1 is set, Foreman uses this; otherwise it falls
 * back to the subprocess-spawning claude-runner. One env flag to flip a
 * single callsite at a time.
 *
 * Path:
 *   Foreman → TCloudClient.bridge({ harness: 'claude-code', resume })
 *           → router.tangle.tools/api/chat
 *           → cli-bridge (same compose stack)
 *           → claude -p --resume <id>  (subscription-backed)
 *
 * Cost: Claude Max subscription covers it — `costUsd` returned is always
 * 0 for bridge-backed calls. The moment we route through a metered
 * model (passthrough/<provider>), usage.total_tokens * price shows up.
 *
 * Session resume: when `resume` is set, the same Claude Code conversation
 * survives across dispatches. Cuts input-token cost on repair loops ~60%.
 */
import { TCloudClient } from '@tangle-network/tcloud'
import type { BridgeOptions } from '@tangle-network/tcloud'

export interface TcloudRunResult {
  output: string
  durationMs: number
  costUsd: number
  success: boolean
  sessionId: string | null
}

let _client: TCloudClient | null = null

function getClient(): TCloudClient {
  if (_client) return _client
  const apiKey = process.env.TANGLE_API_KEY || process.env.TCLOUD_API_KEY
  if (!apiKey) {
    throw new Error('tcloud-runner: TANGLE_API_KEY (or TCLOUD_API_KEY) required')
  }
  const baseURL = process.env.TANGLE_ROUTER_URL || 'https://router.tangle.tools/api'
  _client = new TCloudClient({ apiKey, baseURL, timeout: 300_000 })
  return _client
}

function resolveBridgeUnlock(): string {
  const unlock = process.env.FOREMAN_BRIDGE_UNLOCK
    || process.env.CLI_BRIDGE_UNLOCK_TOKEN
    || process.env.AGENTIC_BRIDGE_UNLOCK
  if (!unlock) {
    throw new Error('tcloud-runner: FOREMAN_BRIDGE_UNLOCK (or CLI_BRIDGE_UNLOCK_TOKEN) required')
  }
  return unlock
}

/**
 * Map Foreman's short model names to bridge <harness>/<model> form.
 * `sonnet|opus|haiku` → Claude Code harness, subscription-backed.
 * `kimi-for-coding`   → Kimi Code harness, subscription-backed.
 * `claudish/*`        → Claude Code workflow with a non-Anthropic brain.
 * Anything else       → passed through as-is; caller owns the full id.
 */
function resolveBridge(model: string, resume: string | null): BridgeOptions {
  const lower = model.toLowerCase().trim()
  const unlock = resolveBridgeUnlock()
  if (lower === 'sonnet' || lower === 'opus' || lower === 'haiku') {
    return { harness: 'claude-code', model: lower, unlock, resume: resume ?? undefined }
  }
  if (lower.startsWith('claude-')) {
    return { harness: 'claude-code', model: lower.replace(/^claude-/, ''), unlock, resume: resume ?? undefined }
  }
  if (lower.startsWith('kimi-') || lower === 'kimi-for-coding') {
    return { harness: 'kimi-code', model: lower, unlock, resume: resume ?? undefined }
  }
  if (lower.startsWith('claudish/')) {
    return { harness: 'claudish', model: lower.slice('claudish/'.length), unlock, resume: resume ?? undefined }
  }
  if (lower.startsWith('codex')) {
    return { harness: 'codex', model: lower, unlock, resume: resume ?? undefined }
  }
  // Default: assume claude-code with whatever was passed
  return { harness: 'claude-code', model: lower, unlock, resume: resume ?? undefined }
}

export async function callTcloud(opts: {
  prompt: string
  model?: string
  timeoutMs?: number
  resume?: string | null
  systemPrompt?: string
}): Promise<TcloudRunResult> {
  const { prompt, model = 'sonnet', timeoutMs = 180_000, resume = null, systemPrompt } = opts
  const client = getClient()
  const bridge = resolveBridge(model, resume)

  const startMs = Date.now()
  const messages = systemPrompt
    ? [
        { role: 'system' as const, content: systemPrompt },
        { role: 'user' as const, content: prompt },
      ]
    : [{ role: 'user' as const, content: prompt }]

  try {
    const completion = await Promise.race([
      client.chat({ messages, bridge }),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error(`tcloud-runner: ${timeoutMs}ms timeout`)), timeoutMs),
      ),
    ])

    const output = completion.choices?.[0]?.message?.content ?? ''
    const durationMs = Date.now() - startMs
    // Bridge calls are subscription-backed → no per-call cost. Passthrough
    // or metered providers surface `usage` and the SDK computes cost in
    // `trackCost`. Read from the completion's reported usage if present.
    const usage = (completion as { usage?: { total_tokens?: number } }).usage
    const costUsd = (usage?.total_tokens && model.startsWith('passthrough/'))
      ? estimateCost(model, usage.total_tokens)
      : 0
    return {
      output,
      durationMs,
      costUsd,
      success: output.length > 0,
      sessionId: resume,
    }
  } catch (e) {
    return {
      output: '',
      durationMs: Date.now() - startMs,
      costUsd: 0,
      success: false,
      sessionId: resume,
    }
  }
}

export async function callTcloudForJSON<T = unknown>(prompt: string, model = 'haiku'): Promise<T | null> {
  const r = await callTcloud({ prompt, model })
  if (!r.success) return null
  try {
    // Tolerate a markdown ```json fence around the output
    const cleaned = r.output.trim()
      .replace(/^```json\n?/i, '')
      .replace(/^```\n?/, '')
      .replace(/\n?```$/, '')
    return JSON.parse(cleaned) as T
  } catch {
    return null
  }
}

// Heuristic per-million-token cost table. Only used for metered passthrough
// calls. Keep it conservative — under-reporting cost is worse than over.
function estimateCost(model: string, totalTokens: number): number {
  const m = model.toLowerCase()
  let perMillion = 15 // default conservative
  if (m.includes('opus')) perMillion = 75
  else if (m.includes('haiku')) perMillion = 1.25
  else if (m.includes('sonnet')) perMillion = 15
  else if (m.includes('gpt-4o-mini')) perMillion = 0.6
  else if (m.includes('gpt-4o')) perMillion = 5
  return (totalTokens / 1_000_000) * perMillion
}
