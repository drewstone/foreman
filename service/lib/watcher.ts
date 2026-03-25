/**
 * Session watcher — monitors active sessions, detects idle/dead, triggers harvest.
 */

import {
  type ExecutionBackend,
  getStmts, log, emitEvent,
} from './state.js'
import {
  pendingPrompts, detectClaudeReady, sendPrompt, getBackend,
} from './session-manager.js'
import { harvestOutcome } from './harvester.js'

export function watcherTick(): void {
  const backend = getBackend()
  const stmts = getStmts()

  // 1. Check pending prompts — send when claude is ready
  for (const [name, req] of pendingPrompts) {
    if (!backend.isAlive(name)) {
      pendingPrompts.delete(name)
      stmts.updateSession.run('dead', '', name)
      emitEvent('session_died', name, req.goalId)
      continue
    }
    if (detectClaudeReady(name)) {
      setTimeout(() => {
        sendPrompt(name, req.prompt)
        stmts.updateSession.run('running', '', name)
        emitEvent('session_started', name, req.goalId)
        log(`Sent prompt to ${name}`)
      }, 2000)
      pendingPrompts.delete(name)
    }
  }

  // 2. Check running sessions for completion
  const active = stmts.activeSessions.all() as Array<{ name: string, status: string, goal_id: number }>
  for (const s of active) {
    if (pendingPrompts.has(s.name)) continue

    if (!backend.isAlive(s.name)) {
      if (s.status !== 'dead') {
        stmts.updateSession.run('dead', '', s.name)
        emitEvent('session_died', s.name, s.goal_id)
        log(`Session ${s.name} died`)
        harvestOutcome(s.name, s.goal_id, backend).catch(e => log(`Harvest failed for ${s.name}: ${e}`))
      }
      continue
    }

    const idle = backend.isIdle(s.name)
    const output = backend.capture(s.name, 3).trim().split('\n').pop() ?? ''

    if (idle && s.status === 'running') {
      stmts.updateSession.run('idle', output, s.name)
      log(`Session ${s.name} appears idle — confirming on next tick`)
    } else if (idle && s.status === 'idle') {
      emitEvent('session_idle', s.name, s.goal_id)
      log(`Session ${s.name} confirmed idle — harvesting`)
      harvestOutcome(s.name, s.goal_id, backend)
        .then(() => {
          backend.kill(s.name)
          stmts.updateSession.run('dead', 'completed', s.name)
          log(`Cleaned up completed session: ${s.name}`)
        })
        .catch(e => log(`Harvest failed for ${s.name}: ${e}`))
    } else {
      stmts.updateSession.run(idle ? 'idle' : 'running', output, s.name)
    }
  }
}
