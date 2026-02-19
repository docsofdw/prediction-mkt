# Polymarket BTC Edge Validation Protocol - Implementation Notes

This file maps the requested 2-week protocol into implemented code and operating commands.

## Core Principles Enforced

- Paper-first default (`EXECUTION_MODE=paper`).
- Manual arming required for live mode.
- SQLite as system of record for validation data.
- Conservative structural-arb net haircut default (`EXECUTION_HAIRCUT=0.40`).
- Soft 2-week enforcement (report + warning, no forced stop).

## Storage

SQLite file:
- `backtests/validation.db` (configurable via `VALIDATION_DB_PATH`)

Primary tables:
- `phase1_scan_cycles`
- `phase1_violations`
- `phase2_funding_rates`
- `phase2_contracts`
- `phase3_weekly_results`
- `thesis_reports`
- `validation_meta`

## Phase 1 (Structural Arbitrage)

Scripts:
- Continuous monitor: `npm run phase1:monitor`
- 7-day gate report: `npm run phase1:report`

What monitor does:
- Runs scan every `PHASE1_SCAN_INTERVAL_MS` (default 5 min).
- Logs scan-cycle enrichment snapshot each cycle.
- Tracks open violations and resolves them when they disappear.
- Stores duration and resolution state.

What report does:
- Computes frequency, duration, violation size, fillable notional.
- Computes theoretical gross and net (`* EXECUTION_HAIRCUT`).
- Applies PASS/KILL/INCONCLUSIVE gate criteria.

## Phase 2 (Funding Rate Informational Edge)

Scripts:
- Ingest data: `npm run phase2:ingest`
- Cohort gate report: `npm run phase2:report`

Data sources:
- BM Pro `/metrics/fr-average` (via `BITCOIN_MAGAZINE_PRO_API_KEY`)
- Gamma resolved BTC markets
- CLOB `/prices-history` for contract pricing snapshots

Report:
- Builds cohort A/B/C by funding percentile.
- Computes edge and standard-error comparisons.
- Applies PASS/KILL/INCONCLUSIVE decision logic.

## Phase 3 (Range-Bound Carry)

Script:
- `npm run phase3:report`

Current implementation:
- Constructs weekly carry proxy from resolved contract extremes.
- Computes win rate, Sharpe, Sortino, drawdown, correlation proxy.
- Applies gate criteria.

## Checkpoints (Soft Enforcement)

Script:
- `npm run validation:checkpoints`

Behavior:
- At day 7: auto-runs all reports if not already checkpointed.
- At day 14: auto-runs all reports + emits "VALIDATION WINDOW COMPLETE" warning.
- Does **not** stop monitor/bot automatically.

## Dashboard Integration

From UI (`npm run dashboard`):
- Start/stop phase1 monitor
- Run phase2 ingest
- Run all reports
- Run checkpoint check
- Run simple workflow (`scan -> ideas -> bot`)
- Run autopilot (`scan -> ideas` recurring + keep-bot-alive)

## Environment Variables

Validation:
- `VALIDATION_DB_PATH`
- `EXECUTION_HAIRCUT`
- `VALIDATION_WINDOW_DAYS`
- `PHASE1_SCAN_INTERVAL_MS`
- `PHASE1_PASS_*`
- `PHASE1_KILL_*`

Phase 2:
- `BITCOIN_MAGAZINE_PRO_API_KEY`
- `BM_PRO_BASE_URL`

Dashboard control:
- `DASHBOARD_PHASE1_MONITOR_CMD`
- `DASHBOARD_PHASE2_INGEST_CMD`
- `DASHBOARD_REPORTS_CMD`
- `DASHBOARD_CHECKPOINTS_CMD`

## Operational Flow (Recommended)

1. `npm run validation:init`
2. Start dashboard: `npm run dashboard`
3. In UI:
   - Start P1 monitor
   - Run P2 ingest daily
   - Run reports at end of week
   - Run checkpoints script to enforce review cadence
4. Keep execution in paper until thesis PASS verdict and explicit live arm decision.
