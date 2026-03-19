/**
 * Format a Foreman run trace into human-readable output.
 * Usage: node --import tsx scripts/format-trace.ts <run-dir>
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const runDir = process.argv[2];
if (!runDir) {
  console.error('Usage: node --import tsx scripts/format-trace.ts <run-dir>');
  process.exit(1);
}

// Read trace events
let events: Array<{ at: string; kind: string; summary: string; trackId?: string; metadata?: Record<string, string> }> = [];
try {
  events = JSON.parse(readFileSync(join(runDir, 'trace.json'), 'utf8'));
} catch {
  console.error(`Cannot read ${join(runDir, 'trace.json')}`);
  process.exit(1);
}

// Read task envelope for context
let envelope: Record<string, unknown> = {};
try {
  envelope = JSON.parse(readFileSync(join(runDir, 'task-envelope.json'), 'utf8'));
} catch { /* optional */ }

// Read final summary
let summary: Record<string, unknown> = {};
try {
  summary = JSON.parse(readFileSync(join(runDir, 'final-summary.json'), 'utf8'));
} catch { /* optional */ }

// Format
const startTime = events[0]?.at ? new Date(events[0].at).getTime() : Date.now();

console.log('═══════════════════════════════════════════════════════════');
console.log(`  Foreman Run Trace`);
console.log(`  Goal: ${String(envelope.originalGoal ?? '').slice(0, 100)}`);
console.log(`  Worker: ${envelope.selectedWorkerId ?? '?'} | Reviewer: ${envelope.reviewWorkerId ?? '?'}`);
const variants = (envelope.promptVariantIds ?? {}) as Record<string, string>;
console.log(`  Variants: impl=${(variants.implementer ?? '?').split(':')[0]} rev=${(variants.reviewer ?? '?').split(':')[0]}`);;
console.log('═══════════════════════════════════════════════════════════');
console.log('');

for (const event of events) {
  const elapsed = event.at ? new Date(event.at).getTime() - startTime : 0;
  const mins = Math.floor(elapsed / 60000);
  const secs = Math.floor((elapsed % 60000) / 1000);
  const ts = `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;

  const icon = {
    'task.started': '▶',
    'context.built': '📋',
    'plan.created': '📝',
    'track.started': '🔧',
    'track.completed': '✅',
    'validation.completed': '🔍',
    'repair.created': '🔄',
    'decision.made': '⚖️',
    'run.completed': '🏁',
    'run.failed': '❌',
  }[event.kind] ?? '•';

  console.log(`  [${ts}] ${icon} ${event.kind}: ${event.summary}`);

  // Show metadata for key events
  if (event.kind === 'decision.made' && event.metadata?.done === 'true') {
    console.log(`         → DONE (${event.summary})`);
  }
  if (event.kind === 'validation.completed' && event.metadata?.recommendation) {
    console.log(`         → recommendation: ${event.metadata.recommendation}`);
  }
}

console.log('');
console.log('───────────────────────────────────────────────────────────');
if (summary.status) {
  console.log(`  Status: ${summary.status}`);
  console.log(`  Rounds: ${summary.rounds ?? '?'}`);
  if (summary.outcome && typeof summary.outcome === 'object') {
    const o = summary.outcome as Record<string, unknown>;
    console.log(`  Validated: ${o.validated ?? '?'}`);
    console.log(`  Summary: ${String(o.summary ?? '').slice(0, 200)}`);
  }
}
console.log('───────────────────────────────────────────────────────────');
