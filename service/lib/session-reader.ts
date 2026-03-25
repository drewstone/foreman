/**
 * Session reader — parses Claude Code session JSONL files for structured data.
 * Extracts: tool calls, cost, final outcome, closing protocol block.
 */

import { readFileSync } from 'node:fs'

export interface SessionTurn {
  uuid: string
  type: 'user' | 'assistant' | 'system'
  timestamp: string
  content: SessionBlock[]
  model?: string
  usage?: { input_tokens: number, output_tokens: number, cache_read_input_tokens?: number }
  stopReason?: string
}

export interface SessionBlock {
  type: 'text' | 'tool_use' | 'tool_result' | 'thinking'
  text?: string
  name?: string       // tool name
  input?: Record<string, unknown>  // tool input
  toolUseId?: string
  content?: string    // tool result content
}

export interface SessionSummary {
  sessionId: string
  cwd: string
  gitBranch: string
  model: string
  turnCount: number
  toolCalls: Array<{ name: string, input: Record<string, unknown> }>
  totalInputTokens: number
  totalOutputTokens: number
  totalCacheReadTokens: number
  estimatedCostUSD: number
  lastAssistantText: string
  closingBlock: ClosingBlock | null
  startTime: string
  endTime: string
}

export interface ClosingBlock {
  status: 'complete' | 'partial' | 'blocked' | 'unknown'
  summary: string
  stepsCompleted: string[]
  skillRecommendations: Array<{ skill: string, task: string, reasoning: string }>
  nextContext: string
  deliverables: string[]
}

// Per-million-token pricing: [input, output]
const MODEL_PRICING: Record<string, [number, number]> = {
  opus: [15, 75],
  sonnet: [3, 15],
  haiku: [0.25, 1.25],
}

function estimateCost(model: string, inputTokens: number, outputTokens: number): number {
  const key = model.toLowerCase()
  const tier = Object.keys(MODEL_PRICING).find(k => key.includes(k))
  const [inputRate, outputRate] = tier ? MODEL_PRICING[tier] : MODEL_PRICING.sonnet
  return (inputTokens * inputRate + outputTokens * outputRate) / 1_000_000
}

/**
 * Read a Claude Code session JSONL and extract structured summary.
 */
export function readSessionTranscript(transcriptPath: string): SessionSummary | null {
  try {
    const content = readFileSync(transcriptPath, 'utf8')
    const lines = content.trim().split('\n').filter(Boolean)

    let sessionId = ''
    let cwd = ''
    let gitBranch = ''
    let model = ''
    let startTime = ''
    let endTime = ''
    let turnCount = 0
    let totalInputTokens = 0
    let totalOutputTokens = 0
    let totalCacheReadTokens = 0
    const toolCalls: Array<{ name: string, input: Record<string, unknown> }> = []
    let lastAssistantText = ''

    for (const line of lines) {
      try {
        const obj = JSON.parse(line)

        // Extract session metadata
        if (!sessionId && obj.sessionId) sessionId = obj.sessionId
        if (!cwd && obj.cwd) cwd = obj.cwd
        if (!gitBranch && obj.gitBranch) gitBranch = obj.gitBranch
        if (!startTime && obj.timestamp) startTime = obj.timestamp
        if (obj.timestamp) endTime = obj.timestamp

        // Count turns
        if (obj.type === 'assistant' || obj.type === 'user') turnCount++

        // Extract from assistant messages
        if (obj.type === 'assistant') {
          const msg = obj.message
          if (!msg) continue

          // Model
          if (msg.model && !model) model = msg.model

          // Usage
          const usage = msg.usage
          if (usage) {
            totalInputTokens += usage.input_tokens ?? 0
            totalOutputTokens += usage.output_tokens ?? 0
            totalCacheReadTokens += usage.cache_read_input_tokens ?? 0
          }

          // Content blocks
          const blocks = msg.content
          if (Array.isArray(blocks)) {
            let textParts: string[] = []
            for (const block of blocks) {
              if (block.type === 'text' && block.text) {
                textParts.push(block.text)
              }
              if (block.type === 'tool_use') {
                toolCalls.push({
                  name: block.name ?? 'unknown',
                  input: block.input ?? {},
                })
              }
            }
            if (textParts.length > 0) {
              lastAssistantText = textParts.join('\n')
            }
          }
        }
      } catch { /* skip malformed lines */ }
    }

    // Parse closing block from last assistant text
    const closingBlock = parseClosingBlock(lastAssistantText)

    return {
      sessionId,
      cwd,
      gitBranch,
      model,
      turnCount,
      toolCalls,
      totalInputTokens,
      totalOutputTokens,
      totalCacheReadTokens,
      estimatedCostUSD: estimateCost(model, totalInputTokens, totalOutputTokens),
      lastAssistantText: lastAssistantText.slice(0, 5000),
      closingBlock,
      startTime,
      endTime,
    }
  } catch {
    return null
  }
}

/**
 * Parse the structured closing block from the last assistant message.
 * Looks for a JSON block or structured markdown that matches the closing protocol.
 */
function parseClosingBlock(text: string): ClosingBlock | null {
  if (!text) return null

  // Try JSON block first (```json ... ```)
  const jsonMatch = text.match(/```json\s*\n([\s\S]*?)\n```/)
  if (jsonMatch) {
    try {
      const parsed = JSON.parse(jsonMatch[1])
      if (parsed.status || parsed.summary || parsed.skillRecommendations) {
        return {
          status: parsed.status ?? 'unknown',
          summary: parsed.summary ?? '',
          stepsCompleted: Array.isArray(parsed.stepsCompleted) ? parsed.stepsCompleted : [],
          skillRecommendations: Array.isArray(parsed.skillRecommendations) ? parsed.skillRecommendations : [],
          nextContext: parsed.nextContext ?? '',
          deliverables: Array.isArray(parsed.deliverables) ? parsed.deliverables : [],
        }
      }
    } catch {}
  }

  // Try raw JSON object
  const rawJsonMatch = text.match(/\{[\s\S]*"status"\s*:\s*"[\s\S]*?\}/)
  if (rawJsonMatch) {
    try {
      const parsed = JSON.parse(rawJsonMatch[0])
      if (parsed.status && parsed.summary) {
        return {
          status: parsed.status,
          summary: parsed.summary ?? '',
          stepsCompleted: Array.isArray(parsed.stepsCompleted) ? parsed.stepsCompleted : [],
          skillRecommendations: Array.isArray(parsed.skillRecommendations) ? parsed.skillRecommendations : [],
          nextContext: parsed.nextContext ?? '',
          deliverables: Array.isArray(parsed.deliverables) ? parsed.deliverables : [],
        }
      }
    } catch {}
  }

  // Fallback: extract from natural language
  // Look for patterns like "## Session Closing" or structured markers
  const closingSection = text.match(/##\s*(?:Session Closing|Closing|Status|Results?)[\s\S]*/i)
  if (closingSection) {
    const section = closingSection[0]
    const statusMatch = section.match(/(?:status|result)\s*[:=]\s*(complete|partial|blocked)/i)
    const stepsMatch = section.match(/(?:steps|completed|done)\s*[:]\s*\n((?:[-*]\s+.+\n?)+)/i)

    return {
      status: (statusMatch?.[1]?.toLowerCase() as ClosingBlock['status']) ?? 'unknown',
      summary: section.slice(0, 500),
      stepsCompleted: stepsMatch ? stepsMatch[1].split('\n').map(s => s.replace(/^[-*]\s+/, '').trim()).filter(Boolean) : [],
      skillRecommendations: [],
      nextContext: '',
      deliverables: [],
    }
  }

  return null
}

/**
 * Extract just the last assistant message from a transcript.
 * Faster than full parse when you only need the closing context.
 */
export function readLastAssistantMessage(transcriptPath: string): string | null {
  try {
    const content = readFileSync(transcriptPath, 'utf8')
    const lines = content.trim().split('\n')

    // Read backwards for efficiency
    for (let i = lines.length - 1; i >= 0; i--) {
      try {
        const obj = JSON.parse(lines[i])
        if (obj.type === 'assistant') {
          const blocks = obj.message?.content
          if (Array.isArray(blocks)) {
            const textParts = blocks
              .filter((b: any) => b.type === 'text' && b.text)
              .map((b: any) => b.text)
            if (textParts.length > 0) return textParts.join('\n')
          }
        }
      } catch {}
    }
    return null
  } catch {
    return null
  }
}
