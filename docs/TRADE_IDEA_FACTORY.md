# Trade Idea Factory

This pipeline is designed for ultra-high-timeframe prediction-market trading across BTC and weather markets.

## Objective

Build a repeatable research loop that:
1. Continuously discovers liquid markets.
2. Generates large candidate sets of strategy variants.
3. Validates them with robust out-of-sample tests.
4. Learns recurring market-regime-to-strategy mappings.
5. Produces ranked trade ideas and portfolio weights.

## Pipeline Stages

### 1. Market Universe Ingestion
- Pull active events from Gamma.
- Build token-level snapshots.
- Keep top-volume markets by category.
- Exclude low-liquidity token IDs.

### 2. Historical Dataset Builder
- Pull bars from CLOB `/prices-history`.
- Use high-timeframe defaults (`IDEA_INTERVAL=max`, `IDEA_FIDELITY=60`).
- Enforce minimum bar count threshold.
- Persist normalized bars in run artifacts.

### 3. Regime Profiling
Each market gets a feature profile:
- `trendiness`: normalized linear slope of price path.
- `meanReversion`: negative lag-1 autocorrelation of returns.
- `volatility`: return std normalized by price.
- `tailRisk`: 95th percentile absolute return normalized by price.

These profile values map each market into a regime bucket.

### 4. Strategy Candidate Factory
The system creates large parameterized candidate universes:

BTC families:
- `btc-momentum`
- `btc-breakout`
- `btc-regime-trend`

Weather families:
- `weather-mean-reversion`
- `weather-range-reversion`
- `weather-drift-trend`

Each family is grid-expanded, then deterministically capped to keep compute bounded.

### 5. Robust Validation Engine
Each candidate is evaluated by expanding-window walk-forward folds.

Per fold:
- Train on expanding history.
- Test on forward holdout segment.
- Collect metrics for train and test.

Candidate robustness metrics:
- Average out-of-sample PnL.
- Median out-of-sample PnL.
- Average Sharpe and Sortino.
- Average drawdown.
- Consistency (positive-fold ratio).
- Overfit penalty (`avgTrainPnl - avgTestPnl`, floored at 0).
- Tail drawdown penalty (90th percentile drawdown).

### 6. Ranking and Selection
Candidates are rank-scored with a composite objective emphasizing:
- Out-of-sample performance.
- Stability across folds.
- Lower drawdown and lower overfit risk.

Top candidates per market are retained as actionable trade ideas.

### 7. Learning Memory
`backtests/idea-memory.json` stores bucket-level family performance.

For each regime bucket:
- Track how often each family appears in top ranks.
- Track score accumulation.
- Track first-place win frequency.

This creates a data-driven prior for future market selection.

### 8. Portfolio Constructor
The system collects top ideas and computes target weights based on:
- Composite score.
- Drawdown-adjusted penalty.
- Cross-market diversification by token and family.

Output includes execution-ready ranked ideas and weights.

## Artifacts

`backtests/idea-factory-latest.json`
- Full run config.
- Per-market ranking results.
- Regime memory hints.
- Portfolio allocation suggestions.

`backtests/idea-memory.json`
- Persistent strategy-family performance memory by regime.

## Operational Cadence

### Hourly
- Refresh active market set.
- Re-run reduced candidate pass on impacted markets.

### Daily
- Full candidate sweep.
- Memory update.
- Produce fresh portfolio weights.

### Weekly
- Expand/reseed parameter grids.
- Review family-level degradation.
- Tighten or loosen risk caps based on realized drawdowns.

## Governance Rules

Promote an idea to production only if all are true:
1. Positive average out-of-sample PnL.
2. Positive-fold consistency above threshold.
3. Drawdown below max threshold.
4. Overfit penalty below max threshold.
5. Minimum trade count above floor.

Demote or quarantine if:
1. Rolling drawdown breaches kill-switch.
2. Fold consistency collapses.
3. Regime mismatch appears versus memory priors.

## Command Surface

- Build strategy ideas: `npm run ideas:build`
- Scan BTC inefficiencies: `npm run scan:btc:inefficiencies`
- Baseline walk-forward backtest: `npm run backtest`
- Market discovery sanity check: `npm run discover`

## Live Integration

Use the allocator in runtime:
- `STRATEGY_MODE=meta-allocator`
- `IDEA_FACTORY_PATH=backtests/idea-factory-latest.json`

Runtime behavior:
- Reloads idea file on a timer.
- Maps token weights to position sizes.
- Selects active family per token based on live regime bucket.
- Uses family-specific strategy parameters from the idea file.
- Enforces hard guardrails before order placement:
  - max gross exposure notional
  - max per-market notional
  - max single-order notional
  - UTC daily loss kill-switch
- Publishes runtime telemetry to `backtests/runtime-status.json` for local dashboarding.
- Supports UI control workflows:
  - Simple launch: build ideas once then start bot
  - Autopilot: recurring ideas build cadence with keep-bot-alive behavior

## Next Extension Targets

1. Add event-level feature joins for weather (external NOAA/API feeds).
2. Add cost/slippage simulation under adverse fill assumptions.
3. Add Bayesian optimization for parameter search.
4. Add Monte Carlo path perturbation stress tests.
5. Add regime-switching meta-allocator across strategy families.
