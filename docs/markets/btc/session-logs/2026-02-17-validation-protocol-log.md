# Validation Protocol Build Log - 2026-02-17

This log captures the second major build segment of the session: moving from a broad trading/automation system to a strict, thesis-driven validation framework with SQLite persistence, gate reports, and UI controls for running the protocol.

## Context and Trigger

After the initial architecture buildout (idea factory, meta-allocator, risk guard, and dashboard), you provided a formal 3-phase validation protocol with explicit gate criteria, timelines, and operational constraints.

Key user constraints that shaped implementation:
1. Use SQLite (not JSON-only) for queryability and reproducibility.
2. Keep `EXECUTION_HAIRCUT=0.40` as default, but configurable.
3. Keep paper-first behavior with explicit manual arming for live mode.
4. Use soft 2-week enforcement (auto-reports + warning; no forced stop).
5. Make execution and validation workflows operable directly from UI.

You also provided BM Pro API key input for immediate pipeline wiring.

## Scope Delivered

This build segment implemented:
- SQLite-backed validation data layer.
- Phase 1 monitor + report with PASS/KILL/INCONCLUSIVE logic.
- Phase 2 ingest + report scaffold aligned to funding-cohort thesis.
- Phase 3 report scaffold aligned to range-carry thesis gates.
- Scheduled soft checkpoint automation (week 1 and week 2).
- Dashboard control-plane extensions for validation operations.
- Core UI verdict visibility (Thesis Verdicts panel).
- Runtime bugfix for SQLite migration invocation.

## New Validation Architecture

## 1) Validation Config and Data Model

### Files
- `src/validation/config.ts`
- `src/validation/sqlite.ts`

### Purpose
- Centralized gate thresholds and validation runtime settings.
- Database open/migration/meta helpers.
- Maintains durable state for scans, violations, contracts, funding rows, weekly carry stats, and thesis reports.

### SQLite tables created
- `validation_meta`
- `phase1_scan_cycles`
- `phase1_violations`
- `phase2_funding_rates`
- `phase2_contracts`
- `phase3_weekly_results`
- `thesis_reports`

### Notes
- WAL mode enabled for local reliability/performance.
- Validation start timestamp persisted in `validation_meta`.

## 2) Phase 1 Structural Arbitrage

### Files
- `src/validation/phase1/scanner.ts`
- `src/scripts/phase1-monitor.ts`
- `src/scripts/phase1-report.ts`

### Scanner behavior
- Discovers BTC markets via Gamma.
- Pulls YES token books from CLOB.
- Detects:
  - strike monotonicity violations
  - time monotonicity violations ("hit by" pattern)
- Produces per-scan cycle summary and active violation set.
- Enriches with BTC spot / 1h return / 1h realized vol where available.

### Monitor behavior
- Runs continuously on configured interval (default 5 minutes).
- Writes cycle rows to `phase1_scan_cycles`.
- Tracks open/active violations and resolves closed ones.
- Computes `duration_seconds` on resolution.
- Emits soft validation-window warning when window elapsed.

### Report behavior
- Computes 7-day metrics:
  - total violations
  - mean/median daily frequency
  - avg violation size
  - avg fillable notional
  - avg duration
  - theoretical gross and net revenue
- Net revenue uses `EXECUTION_HAIRCUT` (default 0.40).
- Applies explicit gate logic for PASS/KILL/INCONCLUSIVE.
- Writes JSON report to `backtests/validation-reports/`.
- Persists summary to `thesis_reports`.

## 3) Phase 2 Informational Edge (Funding)

### Files
- `src/scripts/phase2-ingest.ts`
- `src/scripts/phase2-report.ts`

### Ingest behavior
- Pulls BM Pro funding series (`fr-average`) with bearer auth.
- Computes rolling 30d percentile proxy for funding state.
- Pulls resolved BTC contracts from Gamma.
- Pulls pricing snapshots via CLOB `/prices-history`.
- Stores contract-level rows for cohort analysis.

### Report behavior
- Joins contract 48h state with nearest funding percentile.
- Builds cohorts A/B/C.
- Computes settlement-vs-market edge and SE checks.
- Applies decision logic:
  - PASS if edge significance + minimum magnitude
  - KILL if all cohorts weak
  - INCONCLUSIVE for sample/data limitations
- Writes JSON report and `thesis_reports` record.

## 4) Phase 3 Range Carry (Backtest Gate)

### File
- `src/scripts/phase3-report.ts`

### Behavior
- Builds weekly carry proxy from low/high strike extremes by expiry.
- Computes:
  - win rate
  - average weekly PnL
  - worst week
  - max losing streak
  - Sharpe / Sortino
  - max drawdown%
  - correlation proxy to BTC
- Applies PASS/KILL/INCONCLUSIVE gates.
- Added explicit sample-size safety: <20 observations => INCONCLUSIVE.
- Writes JSON report and `thesis_reports` row.

## 5) Soft Checkpoint Automation

### File
- `src/scripts/validation-checkpoints.ts`

### Behavior
- Checks elapsed days from `validation_started_at`.
- Day 7:
  - runs all phase reports once
  - marks checkpoint completion
- Day 14:
  - runs all phase reports once
  - emits `VALIDATION WINDOW COMPLETE` warning
  - does not stop running processes

Matches requested soft enforcement policy.

## 6) Dashboard Validation Control Plane

### Files
- `src/scripts/dashboard.ts`
- `src/dashboard/index.html`

### New UI operations
- Start/Stop Phase 1 monitor
- Run Phase 2 ingest
- Run all reports
- Run checkpoints

### Control API additions
`POST /api/control` actions:
- `start_phase1_monitor`
- `stop_phase1_monitor`
- `run_phase2_ingest`
- `run_reports`
- `run_checkpoints`

### Status/UI enhancements
- Process status includes validation processes.
- Advanced logs include consolidated validation logs.
- Core view includes a `Thesis Verdicts` panel from latest report files.

## 7) Legacy Scanner Refactor

### File
- `src/scripts/scan-btc-inefficiencies.ts`

### Change
Refactored to reuse Phase 1 scanner core rather than duplicate detection logic. This reduces drift between ad-hoc scanner output and validation monitor behavior.

## 8) New/Updated Commands

### Added npm scripts
- `validation:init`
- `phase1:monitor`
- `phase1:report`
- `phase2:ingest`
- `phase2:report`
- `phase3:report`
- `validation:checkpoints`

### Existing command relationships
- `scan:btc:inefficiencies` remains available for one-shot scanner runs.
- Dashboard now can invoke both research/execution and validation commands.

## 9) Configuration Added

### Validation and gates
- `VALIDATION_DB_PATH`
- `EXECUTION_HAIRCUT`
- `VALIDATION_WINDOW_DAYS`
- `PHASE1_SCAN_INTERVAL_MS`
- `PHASE1_PASS_*`
- `PHASE1_KILL_*`

### BM Pro
- `BITCOIN_MAGAZINE_PRO_API_KEY`
- `BM_PRO_BASE_URL`

### Dashboard validation controls
- `DASHBOARD_PHASE1_MONITOR_CMD`
- `DASHBOARD_PHASE2_INGEST_CMD`
- `DASHBOARD_REPORTS_CMD`
- `DASHBOARD_CHECKPOINTS_CMD`

## 10) Runtime Issue Encountered and Fixed

### Error observed
When running `npm run validation:init` locally:
- `TypeError: Illegal invocation`
- originating in `migrateValidationDb` in `src/validation/sqlite.ts`

### Root cause
Invalid method binding of prepared statement getter (`.get.bind(null)`), which broke invocation context for `better-sqlite3`.

### Fix
Replaced bound call with proper statement object invocation:
- use `const getMetaStmt = db.prepare(...)`
- call `getMetaStmt.get(...)`

### Verification after fix
- `npm run typecheck` passed
- `npm run validation:init` passed
- DB confirmed initialized at `backtests/validation.db`

## 11) User-Confirmed Operational State

User confirmed they clicked `Start P1 Monitor` in dashboard after setup.

This means the protocol has moved from implementation phase into active data collection phase for thesis validation.

## 12) Documentation Added/Updated in This Segment

- New: `docs/VALIDATION_PROTOCOL_IMPLEMENTATION.md`
- Updated: `README.md` (validation workflow, commands, defaults)
- Updated: `docs/session-logs/2026-02-17-session-build-log.md` (addendum section)

## 13) Operational Runbook Snapshot

Recommended immediate run order:
1. `npm run validation:init`
2. `npm run dashboard`
3. In dashboard:
   - `Start P1 Monitor`
   - `Run P2 Ingest` (daily cadence)
   - `Run Checkpoints` (daily or scheduled)
4. End of week windows:
   - `Run All Reports`
   - review Thesis Verdicts panel and JSON reports

## 14) Current Intent Clarity

The system now clearly separates:
- edge discovery and logging (Phase 1)
- statistical edge validation (Phase 2)
- carry/backtest validation (Phase 3)
- decision gates (PASS/KILL/INCONCLUSIVE)

and avoids accidental live risk by defaulting all workflows to paper-mode unless manually armed.
