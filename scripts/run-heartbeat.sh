#!/usr/bin/env bash
# Foreman heartbeat — run via cron every 15 minutes
# Discovers active sessions, checks CI, auto-resumes blocked work.
set -euo pipefail

cd /home/drew/code/foreman

export FOREMAN_REPOS="/home/drew/code/openclaw-sandbox-blueprint:/home/drew/code/vllm-inference-blueprint:/home/drew/code/foreman:/home/drew/code/blueprint"
export PATH="/home/drew/.nvm/versions/node/v24.13.0/bin:/home/drew/.local/bin:/home/drew/.cargo/bin:$PATH"

# --heartbeat enables auto-resume. Remove this flag to just scan + report.
# Auto-resume is disabled until confidence scoring is implemented.
npx tsx packages/surfaces/src/operator-cli.ts -v \
  >> /tmp/foreman-heartbeat.log 2>&1
