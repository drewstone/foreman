#!/usr/bin/env bash
# Foreman daily report — run via cron at 06:00 local time
# Generates a Markdown report from yesterday's heartbeat traces.
set -euo pipefail

cd /home/drew/code/foreman

export PATH="/home/drew/.nvm/versions/node/v24.13.0/bin:/home/drew/.local/bin:/home/drew/.cargo/bin:$PATH"
export FOREMAN_TELEGRAM_BOT_TOKEN="8569647724:AAGCD5wdpaVuHos3oN0T8ur1csUWIXxoCvI"
export FOREMAN_TELEGRAM_CHAT_ID="631795417"

DATE=$(date -d yesterday +%Y-%m-%d 2>/dev/null || date -v-1d +%Y-%m-%d)

# Run learning loop first (dry-run by default, writes traces)
echo "[$(date -Iseconds)] Running learning loop..." >> /tmp/foreman-daily-report.log
node --import tsx packages/surfaces/src/learning-cli.ts --hours 48 --live >> /tmp/foreman-daily-report.log 2>&1

# Update session index (incremental)
echo "[$(date -Iseconds)] Updating session index..." >> /tmp/foreman-daily-report.log
node --import tsx packages/surfaces/src/session-index-cli.ts index >> /tmp/foreman-daily-report.log 2>&1

# Generate daily report (includes judge scoring)
REPORT=$(node --import tsx packages/surfaces/src/daily-report-cli.ts --date "$DATE" 2>&1)
echo "[$(date -Iseconds)] Report generated: $REPORT" >> /tmp/foreman-daily-report.log
