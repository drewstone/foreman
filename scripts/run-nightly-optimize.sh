#!/usr/bin/env bash
# Foreman nightly optimization — run via cron at 3am
# Full pipeline: variants → GEPA → promote → skills → golden suites → costs → notify
set -euo pipefail

cd /home/drew/code/foreman

export PATH="/home/drew/.nvm/versions/node/v24.13.0/bin:/home/drew/.local/bin:/home/drew/.cargo/bin:$PATH"
export FOREMAN_TELEGRAM_BOT_TOKEN="8569647724:AAGCD5wdpaVuHos3oN0T8ur1csUWIXxoCvI"
export FOREMAN_TELEGRAM_CHAT_ID="631795417"

echo "[$(date -Iseconds)] Starting nightly eval + optimization..." >> /tmp/foreman-nightly-optimize.log

node --import tsx packages/surfaces/src/eval-runner-cli.ts --all --optimize >> /tmp/foreman-nightly-optimize.log 2>&1

echo "[$(date -Iseconds)] Nightly eval + optimization complete." >> /tmp/foreman-nightly-optimize.log
