# Polymarket BTC Markets Validation - Final Report

**Date:** February 18-19, 2026
**Status:** CLOSED - No tradeable edge found
**Capital deployed:** $0
**Engineering time:** ~3 days

---

## Executive Summary

We conducted rigorous validation of four trading theses on Polymarket's BTC prediction markets. All four were killed with statistical evidence. The core finding is structural: Polymarket's Up/Down markets function as real-time binary options, not prediction markets. Books open empty and only develop liquidity once direction is apparent, eliminating any execution window for expressing views at fair prices.

**Recommendation:** Archive project, set scanner to daily monitoring, redirect hedging focus to IBIT puts.

---

## Theses Tested

### 1. Structural Arbitrage (Phase 1)
**Hypothesis:** Complete-set arbitrage opportunities exist when YES+NO tokens for the same market can be bought for less than $1 combined.

**Data:** 16 scan cycles over validation period

**Result:** **KILL**
- Zero violations detected
- Spreads consistently tight
- No structural inefficiency

---

### 2. Funding Rate Mispricing (Phase 2)
**Hypothesis:** Extreme funding rates (bullish/bearish sentiment) predict Up/Down market outcomes.

**Data:**
- 4,175 resolved Up/Down markets
- 21,615 funding rate observations (Sept 2023 - Feb 2026)

**Result:** **KILL**
- Chi-square test: p = 0.92
- All funding percentile buckets produce ~50-51% Up rate
- No predictive relationship

| Funding Bucket | n | Up % | vs Baseline |
|----------------|---|------|-------------|
| Very Low (0-10%) | 274 | 52.2% | +1.3% |
| Low (10-30%) | 1,023 | 50.4% | -0.4% |
| Mid (30-70%) | 2,257 | 50.5% | -0.3% |
| High (70-90%) | 614 | 52.3% | +1.4% |
| Very High (90-100%) | 7 | 42.9% | -8.0% |

---

### 3. Time-of-Day Patterns
**Hypothesis:** Trading sessions (Asian/European/US) show systematic bias in Up/Down outcomes.

**Data:** 3,996 five-minute markets with timestamps

**Result:** **KILL**
- Chi-square test: p = 0.90
- No session bias detected
- US equity open (14:00 UTC) shows no edge

| Session | Hours UTC | Count | Up % |
|---------|-----------|-------|------|
| Asian | 00-08 | 1,327 | 50.6% |
| European | 08-16 | 1,332 | 51.3% |
| US | 16-24 | 1,337 | 51.5% |

---

### 4. Streak Mean-Reversion
**Hypothesis:** After consecutive same-direction outcomes, the next outcome reverts.

**Data:** 873 post-3+ streak observations

**Result:** **KILL** (statistically real but untradeable)

The pattern IS statistically significant:
| After Streak | Continuation % | p-value |
|--------------|----------------|---------|
| 2+ same | 46.0% | <0.001 |
| 3+ same | 43.1% | <0.001 |
| 5+ same | 38.6% | 0.003 |

**However, the pattern is untradeable because:**

The books are empty at market open. Both 5-minute and 4-hour markets show:
- Best bid: 1 cent
- Best ask: 99 cents
- Spread: 98 cents
- No two-sided liquidity at any price near 50%

Liquidity only arrives mid-window once BTC direction is apparent. By then, the market is efficiently pricing the current move, not historical patterns.

---

## Core Structural Finding

**Polymarket's BTC Up/Down markets are real-time binary options, not prediction markets.**

The market structure:
1. Window opens with empty books (1/99 spread)
2. No market makers quote reasonable prices at open
3. Liquidity arrives only once direction becomes apparent
4. By then, efficient pricing reflects current BTC movement
5. No execution window exists for pre-event positioning

This means no amount of signal engineering (funding rates, on-chain data, streaks, time-of-day) can create tradeable edge because the execution layer doesn't support it.

---

## Infrastructure Built

| Component | File | Status |
|-----------|------|--------|
| Phase 1 Scanner | `src/validation/phase1/scanner.ts` | Set to daily cron |
| Funding Ingest | `src/scripts/phase2-ingest.ts` | Working (BM Pro CSV) |
| Up/Down Ingest | `src/scripts/ingest-updown.ts` | Working |
| Time-of-Day Analysis | `src/scripts/analyze-time-of-day.ts` | Complete |
| Autocorrelation Analysis | `src/scripts/analyze-autocorrelation.ts` | Complete |
| Live Logger | `src/scripts/updown-live-logger.ts` | Dormant |

---

## Data Collected

| Dataset | Records | Date Range |
|---------|---------|------------|
| Funding rates (BM Pro) | 21,615 | Sept 2023 - Feb 2026 |
| 5-minute outcomes | 3,996 | Jan 20 - Feb 19, 2026 |
| 4-hour outcomes | 179 | Jan 20 - Feb 18, 2026 |
| Scan cycles | 16 | Validation period |

All data stored in `backtests/validation.db`

---

## Recommendations

### Immediate
1. **Archive this project** - No further active development
2. **Set P1 scanner to daily cron** - Monitor for market structure changes
3. **Redirect hedging focus to IBIT puts** - More liquid, straightforward vehicle

### If Revisiting
The infrastructure is ready to reactivate if Polymarket:
- Launches proper pre-event binary contracts
- Develops two-sided books at market open
- Introduces new BTC contract structures

### Reusable Components
- BM Pro funding rate pipeline (useful for main book sizing)
- Validation framework (applicable to other venues)
- Statistical analysis scripts

---

## Conclusion

Four theses tested, four killed with evidence. Zero capital deployed. The project achieved its goal: definitively answering whether Polymarket's BTC markets offer systematic trading opportunities. The answer is no, due to structural limitations in the execution layer, not lack of statistical patterns.

This document serves as institutional memory. If this question arises again, the answer is documented with data, not speculation.

---

*Report generated: February 19, 2026*
