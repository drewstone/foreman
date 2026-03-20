#!/usr/bin/env bash
# Foreman nightly optimization — run via cron at 3am
# Reads traces, ranks artifact versions, auto-promotes winners.
set -euo pipefail

cd /home/drew/code/foreman

export PATH="/home/drew/.nvm/versions/node/v24.13.0/bin:/home/drew/.local/bin:/home/drew/.cargo/bin:$PATH"

echo "[$(date -Iseconds)] Starting nightly optimization..." >> /tmp/foreman-nightly-optimize.log

# Auto-promote versioned artifacts based on accumulated scores
node --import tsx -e "
import { VersionedStore } from '@drew/foreman-core'

async function main() {
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
    console.log('No promotions — insufficient data or no improvements.')
  }
}

main().catch(e => { console.error(e); process.exit(1) })
" >> /tmp/foreman-nightly-optimize.log 2>&1

echo "[$(date -Iseconds)] Nightly optimization complete." >> /tmp/foreman-nightly-optimize.log
