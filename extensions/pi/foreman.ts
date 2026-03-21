/**
 * Foreman extension for Pi.
 *
 * Composed from three modules:
 *   foreman-tools.ts   — tools + commands (status, resume, validate, memory, context)
 *   foreman-auto.ts    — autonomous behavior (auto-loop, watchdog)
 *   foreman-context.ts — context management (session start, compaction, memory nudges)
 *
 * Install:
 *   ln -s ~/code/foreman/extensions/pi ~/.pi/agent/extensions/foreman
 *   # Pi will load foreman.ts as the entry point
 *
 * Tools: foreman_status, foreman_resume, foreman_validate, foreman_memory
 * Commands: /foreman, /heartbeat, /context, /auto, /watchdog
 * Flags: --foreman-auto
 */

import type { ExtensionAPI } from '@mariozechner/pi-coding-agent'
import { registerForemanTools } from './foreman-tools.js'
import { registerForemanAuto } from './foreman-auto.js'
import { registerForemanContext } from './foreman-context.js'

export default function foremanExtension(pi: ExtensionAPI) {
  registerForemanTools(pi)
  registerForemanAuto(pi)
  registerForemanContext(pi)
}
