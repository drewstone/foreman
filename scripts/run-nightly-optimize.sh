#!/usr/bin/env bash
# Foreman nightly optimization — run via cron at 3am
# Full pipeline: variants → GEPA → promote → skills → golden suites → costs → notify
set -euo pipefail

cd /home/drew/code/foreman

export PATH="/home/drew/.nvm/versions/node/v24.13.0/bin:/home/drew/.local/bin:/home/drew/.cargo/bin:$PATH"
export FOREMAN_TELEGRAM_BOT_TOKEN="8569647724:AAGCD5wdpaVuHos3oN0T8ur1csUWIXxoCvI"
export FOREMAN_TELEGRAM_CHAT_ID="631795417"

echo "[$(date -Iseconds)] Starting nightly optimization..." >> /tmp/foreman-nightly-optimize.log

node --import tsx -e "
import { runNightlyOptimization } from './packages/surfaces/src/nightly-optimize.js'

const result = await runNightlyOptimization({
  costBudgetUsd: 10,
  onProgress: (msg) => console.log(msg),
})

console.log()
console.log('=== Nightly Summary ===')
console.log('Variants generated:', result.variantsGenerated)
console.log('Promotions:', result.promotions.length > 0 ? result.promotions.join(', ') : 'none')
console.log('GEPA ran:', result.gepaRan)
console.log('Skill alerts:', result.skillAlerts)
console.log('Golden cases:', result.goldenCases)
console.log('24h cost: \$' + result.costLast24h.toFixed(2))
console.log('Budget exceeded:', result.budgetExceeded)
" >> /tmp/foreman-nightly-optimize.log 2>&1

echo "[$(date -Iseconds)] Nightly optimization complete." >> /tmp/foreman-nightly-optimize.log
