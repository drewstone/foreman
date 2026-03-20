#!/usr/bin/env bash
# Foreman heartbeat — run via cron every 15 minutes
# Discovers active sessions, checks CI, auto-resumes blocked work.
set -euo pipefail

cd /home/drew/code/foreman

# Core repos (always monitored) + dynamic discovery from session index
CORE_REPOS="/home/drew/code/openclaw-sandbox-blueprint:/home/drew/code/vllm-inference-blueprint:/home/drew/code/foreman:/home/drew/code/blueprint:/home/drew/code/agent-dev-container:/home/drew/code/phony"

# Discover repos with recent session activity (last 7 days)
DYNAMIC_REPOS=$(node --import tsx -e "
import { SessionIndex } from '@drew/foreman-memory/session-index'
const idx = new SessionIndex()
const repos = Object.keys(idx.stats().byRepo)
  .filter(r => r.length > 2)
  .map(r => '/home/drew/code/' + r)
  .filter(r => { try { require('fs').statSync(r); return true } catch { return false } })
idx.close()
console.log(repos.join(':'))
" 2>/dev/null || echo "")

export FOREMAN_REPOS="${CORE_REPOS}${DYNAMIC_REPOS:+:$DYNAMIC_REPOS}"
export PATH="/home/drew/.nvm/versions/node/v24.13.0/bin:/home/drew/.local/bin:/home/drew/.cargo/bin:$PATH"

# --heartbeat enables auto-resume decisions
# --max-resumes 1: at most one auto-resume per cycle (safety limit)
# --min-confidence 0.5: only act on recipes with >= 50% confidence
# CI diagnosis runs automatically when no recipe exists
npx tsx packages/surfaces/src/operator-cli.ts --heartbeat --max-resumes 1 --min-confidence 0.5 -v \
  >> /tmp/foreman-heartbeat.log 2>&1
