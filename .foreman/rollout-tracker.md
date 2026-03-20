# Foreman Live Rollout Tracker

Started: 2026-03-20T19:30:00Z
Duration: 7 days (ends 2026-03-27)
Status: **DAY 0 — JUST LAUNCHED**

## What went live

| System | Mode | Safety limits |
|---|---|---|
| Heartbeat | **LIVE** (was dry-run) | max 1 resume/cycle, min 50% confidence |
| Learning loop | **LIVE** (was dry-run) | writes to ~/.foreman/memory/ |
| Daily report | LIVE | includes session index + judges |
| LLM judge | LIVE | Opus, versioned directive |
| Nightly optimization | LIVE | variant gen + auto-promote + skill tracking |
| CI diagnosis | LIVE | reads gh run view --log-failed |
| Recipe scoring | LIVE | updates confidence after outcomes |
| Session index | LIVE | 172K messages, 4 harnesses |
| Pi auto-loop | BUILT | untested in real Pi session |
| Pi watchdog | BUILT | untested in real Pi session |

## Daily check commands

```bash
# 1. What happened overnight?
tail -200 /tmp/foreman-heartbeat.log | grep -E 'AUTO-FIX|SKIP|diagnosis|resumed|error'

# 2. Daily report quality
npm run daily-report -- --stdout 2>&1 | tail -30  # judge scores at bottom

# 3. Learning loop output
ls -lt ~/.foreman/traces/learning/ | head -3
cat ~/.foreman/memory/user/operator.json | python3 -m json.tool

# 4. Recipe state
find ~/.foreman/memory -name 'engineering.json' | xargs cat 2>/dev/null | python3 -m json.tool

# 5. Artifact versions + promotions
for f in ~/.foreman/artifacts/*/daily-report/manifest.json; do echo "=== $f ==="; python3 -c "import json; d=json.load(open('$f')); print('Active:', d['activeVersionId']); print('Versions:', len(d['versions'])); print('Promotions:', len(d['promotionHistory']))"; done 2>/dev/null

# 6. Nightly optimization
tail -30 /tmp/foreman-nightly-optimize.log

# 7. Skill performance
cat ~/.foreman/memory/skills/performance.json 2>/dev/null | python3 -c "import json,sys; d=json.load(sys.stdin); [print(f'  /{s[\"skillName\"]}: {s[\"totalInvocations\"]}x, {s[\"overallSuccessRate\"]*100:.0f}%, {s[\"trend\"]}') for s in d['skills']]"

# 8. Session metrics (if any sessions were spawned)
ls ~/.foreman/traces/sessions/ 2>/dev/null | wc -l && echo "session traces"

# 9. Variant generation
ls ~/.foreman/traces/variant-gen/ 2>/dev/null | head -3
```

## Daily log

### Day 0 — 2026-03-20 (launch)
- [x] Heartbeat dry-run removed, live with max 1 resume, min 50% confidence
- [x] CI diagnosis tested: agent-dev-container/feat/sandbox-eval-infra → lint diff in shared package
- [x] CI diagnosis tested: phony/feat/credits-system → generic (no clear error in logs)
- [x] Learning loop ran live: 3 recipes, 33 facts, 5 operator patterns
- [x] Session index: 172K messages, 2250 sessions, 4 harnesses
- [x] LLM judge first run: 20/50 (brutal, correct)
- [x] 145 tests passing, all types clean
- [x] 13 audit findings fixed
- [ ] **PENDING**: First heartbeat live action (next 15min cycle)
- [ ] **PENDING**: First daily report with live data (tomorrow 5:47am)
- [ ] **PENDING**: First nightly optimization run (tonight 3:13am)

### Day 1 — 2026-03-21
- [ ] Check: Did heartbeat take any actions? (grep AUTO-FIX in heartbeat log)
- [ ] Check: Did CI diagnosis generate new recipes? (check engineering.json)
- [ ] Check: Daily report LLM judge score (target: above 20/50)
- [ ] Check: Nightly optimization — any variants generated? Any promotions?
- [ ] Check: Learning loop — new facts discovered?
- [ ] Issue tracker: ___

### Day 2 — 2026-03-22
- [ ] Check: Recipe confidence updates (did any go up/down)?
- [ ] Check: Judge score trend (day 1 vs day 2)
- [ ] Check: Variant generation working? New candidates in artifact store?
- [ ] Check: Skill tracker accuracy — compare with manual assessment
- [ ] Issue tracker: ___

### Day 3 — 2026-03-23
- [ ] Check: Auto-promote eligibility (need 3 scores per version)
- [ ] Check: Heartbeat resume success rate
- [ ] Check: Any new repos discovered dynamically?
- [ ] Issue tracker: ___

### Day 4 — 2026-03-24
- [ ] Check: First auto-promotion? (needs 3 scores + improvement threshold)
- [ ] Check: LLM judge score trajectory
- [ ] Check: Recipe confidence convergence
- [ ] Issue tracker: ___

### Day 5 — 2026-03-25
- [ ] Check: Promoted artifact performing better than original?
- [ ] Check: Skill degradation alerts — any real issues?
- [ ] Issue tracker: ___

### Day 6 — 2026-03-26
- [ ] Check: Overall system health
- [ ] Check: Cost tracking — how much are judges + variants costing?
- [ ] Issue tracker: ___

### Day 7 — 2026-03-27 (assessment)
- [ ] Final daily report review
- [ ] Judge score trend over 7 days
- [ ] Recipe confidence evolution
- [ ] Artifact promotion history
- [ ] Heartbeat actions taken vs skipped
- [ ] Skill performance trends
- [ ] Cost analysis
- [ ] Decision: scale up or adjust?

## Success criteria

| Metric | Baseline (Day 0) | Target (Day 7) |
|---|---|---|
| LLM judge score | 20/50 (40%) | 30/50 (60%) |
| Deterministic judge score | 46/50 (92%) | 48/50 (96%) |
| Heartbeat actions (not SKIP) | 0 | ≥5 |
| Recipes with confidence > 0.5 | 3 | ≥8 |
| Artifact promotions | 0 | ≥1 |
| Session traces persisted | 0 | ≥3 |
| Repos tracked | 6 hardcoded | 8+ (dynamic) |

## Known issues to watch

1. **Skill success classifier miscalibrated** — /verify shows 0% success, /evolve shows 4%. These skills work fine; the keyword matching for completion signals needs tuning.
2. **Pi auto-loop + watchdog untested** — built but never run in a real Pi session. First real test pending.
3. **Variant generator untested** — first run tonight at 3:13am. May produce garbage or duplicates.
4. **Dynamic repo discovery** — uses session index repo names which may not map 1:1 to paths in ~/code/. The `statSync` check should catch mismatches but may miss repos in other locations.
5. **Cost of LLM judge** — Opus judge runs on every daily report. At ~$0.09/run that's ~$0.63/week. Acceptable but monitor.
