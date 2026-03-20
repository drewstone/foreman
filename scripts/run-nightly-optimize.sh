#!/usr/bin/env bash
# Foreman nightly optimization — run via cron at 3am
# 1. Generate new artifact variants (LLM-proposed improvements)
# 2. Auto-promote best scoring artifact versions
# 3. Track skill performance and flag degradation
set -euo pipefail

cd /home/drew/code/foreman

export PATH="/home/drew/.nvm/versions/node/v24.13.0/bin:/home/drew/.local/bin:/home/drew/.cargo/bin:$PATH"

echo "[$(date -Iseconds)] Starting nightly optimization..." >> /tmp/foreman-nightly-optimize.log

# Step 1: Generate new variants for underperforming artifacts
echo "[$(date -Iseconds)] Generating variants..." >> /tmp/foreman-nightly-optimize.log
node --import tsx -e "
import { generateVariants } from './packages/surfaces/src/variant-generator.js'

const proposals = await generateVariants({
  scoreThreshold: 0.8,
  maxPerArtifact: 1,
  onProgress: (msg) => console.log(msg),
})
console.log('Generated ' + proposals.length + ' variant(s)')
for (const p of proposals) {
  console.log('  ' + p.kind + '/' + p.name + ': ' + p.rationale.slice(0, 100))
}
" >> /tmp/foreman-nightly-optimize.log 2>&1

# Step 2: Auto-promote artifact versions based on accumulated scores
echo "[$(date -Iseconds)] Auto-promoting..." >> /tmp/foreman-nightly-optimize.log
node --import tsx -e "
import { VersionedStore } from '@drew/foreman-core'

const store = new VersionedStore()
const kinds = await store.listKinds()
const promoted = []

for (const kind of kinds) {
  const names = await store.listNames(kind)
  for (const name of names) {
    const result = await store.autoPromote(kind, name, { minScores: 3, minImprovement: 0.05 })
    if (result) {
      promoted.push(kind + '/' + name + ': promoted ' + result.id + ' (avg ' + result.averageScore?.toFixed(3) + ')')
    }
  }
}

if (promoted.length > 0) {
  console.log('Promoted:')
  for (const p of promoted) console.log('  ' + p)
} else {
  console.log('No promotions needed.')
}
" >> /tmp/foreman-nightly-optimize.log 2>&1

# Step 3: Track skill performance
echo "[$(date -Iseconds)] Tracking skill performance..." >> /tmp/foreman-nightly-optimize.log
node --import tsx -e "
import { trackSkillPerformance, detectDegradation } from './packages/surfaces/src/skill-tracker.js'

const performances = await trackSkillPerformance({ hoursBack: 168, onProgress: (msg) => console.log(msg) })
const proposals = detectDegradation(performances)

if (proposals.length > 0) {
  console.log('DEGRADATION ALERTS:')
  for (const p of proposals) {
    console.log('  [' + p.severity + '] /' + p.skillName + ': ' + p.reason)
  }
}
" >> /tmp/foreman-nightly-optimize.log 2>&1

echo "[$(date -Iseconds)] Nightly optimization complete." >> /tmp/foreman-nightly-optimize.log
