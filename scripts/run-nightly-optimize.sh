#!/usr/bin/env bash
# Foreman nightly optimization — run via cron at 3am
# 1. Generate new artifact variants (LLM-proposed improvements)
# 2. Auto-promote best scoring artifact versions
# 3. Track skill performance and flag degradation
# 4. Send notifications for promotions and degradation
set -euo pipefail

cd /home/drew/code/foreman

export PATH="/home/drew/.nvm/versions/node/v24.13.0/bin:/home/drew/.local/bin:/home/drew/.cargo/bin:$PATH"
export FOREMAN_TELEGRAM_BOT_TOKEN="8569647724:AAGCD5wdpaVuHos3oN0T8ur1csUWIXxoCvI"
export FOREMAN_TELEGRAM_CHAT_ID="631795417"

echo "[$(date -Iseconds)] Starting nightly optimization..." >> /tmp/foreman-nightly-optimize.log

node --import tsx -e "
import { generateVariants } from './packages/surfaces/src/variant-generator.js'
import { VersionedStore } from '@drew/foreman-core'
import { trackSkillPerformance, detectDegradation } from './packages/surfaces/src/skill-tracker.js'
import { notifyPromotion, notifyDegradation } from './packages/surfaces/src/notify.js'

async function main() {
  // Step 1: Generate new variants for underperforming artifacts
  console.log('[variant-gen] Generating variants...')
  const proposals = await generateVariants({
    scoreThreshold: 0.8,
    maxPerArtifact: 1,
    onProgress: (msg) => console.log(msg),
  })
  console.log('[variant-gen] ' + proposals.length + ' variant(s) generated')

  // Step 2: Auto-promote artifact versions
  console.log('[promote] Checking for promotions...')
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
    console.log('[promote] Promoted:')
    for (const p of promoted) console.log('  ' + p)
    await notifyPromotion(promoted)
  } else {
    console.log('[promote] No promotions needed.')
  }

  // Step 3: Track skill performance
  console.log('[skills] Tracking skill performance...')
  const performances = await trackSkillPerformance({ hoursBack: 168, onProgress: (msg) => console.log(msg) })
  const degraded = detectDegradation(performances)

  if (degraded.length > 0) {
    console.log('[skills] DEGRADATION ALERTS:')
    for (const p of degraded) console.log('  [' + p.severity + '] /' + p.skillName + ': ' + p.reason)
    await notifyDegradation(degraded)
  }

  console.log('[done] Nightly optimization complete.')
}

main().catch(e => { console.error(e); process.exit(1) })
" >> /tmp/foreman-nightly-optimize.log 2>&1

echo "[$(date -Iseconds)] Nightly optimization complete." >> /tmp/foreman-nightly-optimize.log
