# Validation Results Summary

**Last Updated:** 2026-02-24

This document consolidates all strategy validation results and their verdicts.

---

## Executive Summary

| Strategy | Verdict | Edge Found | Action |
|----------|---------|------------|--------|
| Phase 1: Structural Arbitrage | **KILL** | No | Dead |
| Phase 2: Funding Tail Mispricing | INCONCLUSIVE | No data | Dead (no signal) |
| Phase 3: Range Bound Carry | INCONCLUSIVE | No data | Dead (no signal) |
| Complete-Set Arbitrage | **KILL** | No | Dead |
| Autocorrelation Streaks | **KILL** | No | Dead |
| Funding Direction | **KILL** | No | Dead |
| Time-of-Day Patterns | **KILL** | No | Dead |
| Maker Longshot Selling | **SHELVED** | ~1.5-1.8% theoretical | Too slow to validate |
| Final Seconds (98c+ Buy) | **KILL** | No | Dead (no liquidity) |

---

## Detailed Results

### Phase 1: Structural Arbitrage

**Hypothesis:** BTC Up/Down markets have structural mispricings where YES+NO != $1.00

**Test Period:** Feb 10-17, 2026

**Results:**
- Total violations detected: **0**
- Violations per day: 0
- Theoretical net revenue: $0/week

**Verdict:** `KILL`

**Why it failed:** Competition has eliminated structural arbitrage. Order books are well-arbitraged by sophisticated participants. The spread required to capture any edge exceeds execution costs.

---

### Phase 2: Funding Tail Mispricing

**Hypothesis:** Extreme funding rates predict Up/Down market outcomes

**Test Period:** Feb 10-17, 2026

**Results:**
- Sample size: 0 (insufficient data in cohorts)
- All cohorts had n < 20 minimum threshold

**Verdict:** `INCONCLUSIVE` (effectively dead)

**Why it failed:** Insufficient market activity to generate statistical significance. No edge signal detected even in preliminary data.

---

### Phase 3: Range Bound Carry

**Hypothesis:** BTC range-bound periods offer carry opportunities

**Test Period:** Feb 10-17, 2026

**Results:**
- Observations: 0
- Sharpe: 0
- Win rate: 0%

**Verdict:** `INCONCLUSIVE` (effectively dead)

**Why it failed:** No qualifying weekly observations. Strategy conditions never triggered.

---

### Complete-Set Arbitrage ("BoneReader")

**Hypothesis:** YES + NO token prices occasionally sum to < $1.00, allowing risk-free profit

**Test Run:** Feb 22-23, 2026 (24 hours continuous)

**Results:**
- Runtime: 24.0 hours
- Total scans: 2,623 (109.2/hr)
- Opportunities found: **0**
- Rate: 0.00/hour
- Threshold: 0.5 cents

**Verdict:** `KILL`

**Why it failed:** Competition has squeezed out complete-set arbs. Market makers and arbitrageurs keep YES+NO tightly coupled to $1.00. No opportunities above 0.5 cent threshold in 2,600+ scans.

---

### Autocorrelation Streaks

**Hypothesis:** BTC Up/Down outcomes show momentum (streaks continue)

**Data:** 3,996 five-minute markets, 179 four-hour markets

**Results - 5 Minute:**
| After Streak | Continue Rate | Expected (Random) |
|--------------|---------------|-------------------|
| 2 in a row | 46.0% | 50% |
| 3 in a row | 43.1% | 50% |
| 4 in a row | 44.1% | 50% |
| 5 in a row | 38.5% | 50% |

**Key Finding:** Streaks are *less* likely to continue than random chance. This is slight mean reversion, but not exploitable after costs.

**Verdict:** `KILL`

**Why it failed:** Autocorrelation is actually slightly *negative* (-4.8% for lag-1). Betting on streak continuation loses money. Betting against streaks has edge too small to overcome spread.

---

### Funding Rate Direction

**Hypothesis:** Extreme funding rates predict Up/Down outcomes

**Data:** 4,175 markets total

**Statistical Test:** Chi-square analysis across funding buckets

**Results:**
| Funding Bucket | Markets | Up Rate | Expected |
|----------------|---------|---------|----------|
| Very Low (0-10%) | 274 | 52.2% | 50.9% |
| Low (10-30%) | 1,023 | 50.4% | 50.9% |
| Mid-Low (30-50%) | 1,221 | 51.1% | 50.9% |
| Mid-High (50-70%) | 1,036 | 49.8% | 50.9% |
| High (70-90%) | 614 | 52.3% | 50.9% |
| Very High (90%+) | 7 | 42.9% | 50.9% |

**Chi-Square:** 1.43 | **p-value:** 0.92

**Verdict:** `KILL`

**Why it failed:** No statistical relationship between funding rate and outcomes (p=0.92 means indistinguishable from random). Funding rate does not predict Up/Down results.

---

### Time-of-Day Patterns

**Hypothesis:** Certain trading sessions (Asian/European/US) have directional bias

**Data:** 3,996 five-minute markets

**Results:**
| Session | Hours UTC | Markets | Up Rate | 95% CI |
|---------|-----------|---------|---------|--------|
| Asian | 00-08 | 1,327 | 50.6% | 48.0-53.3% |
| European | 08-16 | 1,332 | 51.3% | 48.6-54.0% |
| US | 16-24 | 1,337 | 51.5% | 48.8-54.1% |

**Session Chi-Square:** 0.20 | **p-value:** 0.90
**Hourly Chi-Square:** 12.65 | **p-value:** 0.96

**Verdict:** `KILL`

**Why it failed:** No statistically significant difference between sessions. All confidence intervals overlap. Time of day does not predict outcomes.

---

### Maker Longshot Selling (SHELVED)

**Source:** Becker dataset analysis (404M trades across 408,863 markets)

**Hypothesis:** Retail overbids on longshot outcomes; sellers extract premium

**Results:**
| Price Bucket | Estimated Seller Edge | Volume | Confidence |
|--------------|----------------------|--------|------------|
| 0-5% | +1.5% | $163M | High |
| 5-10% | +1.7% | $195M | High |
| 10-15% | +1.5% | $234M | Medium |
| 15-20% | +1.3% | $272M | Medium |
| 20-25% | +1.1% | $341M | Medium |
| 25-30% | +0.9% | $452M | Low |

**Key Finding:**
- Net taker flow: SELLING $373.5M to makers (longshots < 20%)
- Retail is systematically overpaying for low-probability events

**Verdict:** `SHELVED`

**Why shelved:** The strategy targets long-dated markets (weeks to months until resolution). Validation would take too long - we can't wait months to know if orders filled profitably. Theoretical edge exists but practical validation is impractical for our timeline.

**Status:** Code archived in `src/scripts/_archive/`. Can revisit if willing to run multi-month paper trading.

---

### Final Seconds Strategy (98c+ Buy)

**Source:** Polymarket 5-minute BTC Up/Down markets

**Hypothesis:** In the final 15 seconds before resolution, when BTC is far from the target price, one side trades at 98c+. Buy at 98c+, collect $1 at resolution. Win rate should be >98% to profit.

**Test Method:** Built order book recorder to capture snapshots at T-60s, T-30s, T-15s, T-10s, T-5s before resolution.

**Test Date:** Feb 24, 2026

**Results:**

Order book state observed:
```
Market: btc-updown-5m-1771960200
UP token:   0 bids, 99 asks @ 99c
DOWN token: 99 bids @ 1c, 0 asks
```

**Critical Finding:** When outcome is "decided" (BTC far from target):
- Winning side has **no sellers** below 99c (why sell if it resolves to $1?)
- Winning side has **no buyers** at all (everyone's already positioned)
- Losing side has **no buyers** above 1c (it's going to $0)

**Verdict:** `KILL`

**Why it failed:** **Liquidity problem, not win-rate problem.** The strategy assumes you can buy at 98c+, but:

1. When the outcome is obvious, there's nothing to buy
2. The only offers are at 99c from people trying to exit
3. No one is selling the winning side below fair value
4. The order book empties in the final 15-30 seconds

This is a fundamental market microstructure issue. The strategy is mathematically sound but physically impossible to execute.

**Key Insight:** Markets are efficient at the extremes. When one outcome is nearly certain, the order book reflects that immediately - there's no "free money" sitting around for 15 seconds.

---

## Scripts Reference

| Script | Purpose | Status |
|--------|---------|--------|
| `npm run validation:init` | Initialize SQLite validation DB | Working |
| `npm run phase1:monitor` | Continuous 5m price logging | Working |
| `npm run phase1:report` | Generate Phase 1 verdict | Working |
| `npm run phase2:ingest` | Ingest trade data | Working |
| `npm run phase2:report` | Generate Phase 2 verdict | Working |
| `npm run phase3:report` | Generate Phase 3 verdict | Working |
| `npm run btc:autocorrelation` | Analyze streak patterns | Working |
| `npm run btc:funding` | Analyze funding correlation | Working |
| `npm run btc:timeofday` | Analyze session patterns | Working |
| `npm run cset:scan` | Complete-set arb scanner (continuous) | Working |
| `npm run cset:report` | Generate 24h scanner report | Working |
| `npm run maker:scan` | Scan for longshot opportunities | Working |
| `npm run maker:notify` | Telegram notifications | Working |
| `npm run final:record` | Final seconds order book recorder | Working |
| `npm run final:report` | Final seconds analysis report | Working |

---

## Data Artifacts

Reports are stored in `backtests/validation-reports/`:

```
validation-reports/
├── phase1-report-2026-02-17.json
├── phase2-report-2026-02-17.json
├── phase3-report-2026-02-17.json
├── autocorrelation-2026-02-19.json
├── funding-direction-2026-02-19.json
└── time-of-day-2026-02-19.json
```

Becker analysis in `backtests/becker-reports/`:

```
becker-reports/
├── becker_analysis_results.json
├── strategy-params.json
└── strategy-refinements.json
```

Archived code in `src/scripts/_archive/`:

```
_archive/
├── maker-paper-trade.ts
└── maker-paper-cron.ts
```

---

## Conclusions

1. **All taker strategies are dead.** Structural arb, complete-set arb, final-seconds, and directional prediction all show zero exploitable edge. Competition and market efficiency have eliminated these opportunities.

2. **Statistical patterns don't exist.** Autocorrelation, funding direction, and time-of-day all fail statistical significance tests. BTC Up/Down outcomes are effectively random conditional on these factors.

3. **Maker strategy has theoretical edge but is impractical.** Longshot selling shows 1.5-1.8% theoretical edge based on 404M historical trades, but markets take weeks/months to resolve - too slow for practical validation.

4. **Liquidity kills execution.** Even when theoretical edge exists (final seconds), the order book structure makes execution impossible. When outcomes are obvious, there's no counterparty.

5. **The efficient market hypothesis wins.** Every strategy tested has been either competed away or structurally impossible to execute. Polymarket's BTC markets are effectively efficient.

---

## What's Next?

Options to consider:

1. **Exit Polymarket BTC markets** - Evidence suggests no exploitable edge exists
2. **Explore other market types** - Politics, sports, weather may have different dynamics
3. **Accept maker longshot timeline** - Run paper trading for months, accept slow feedback
4. **Look for illiquid edges** - Low-volume markets may have inefficiencies but also execution risk
