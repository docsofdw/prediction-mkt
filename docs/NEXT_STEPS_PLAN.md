# Strategic Plan: Next Steps

**Date:** 2026-02-23

---

## Current State Assessment

### What We Tested and Killed

| Strategy | Hours Invested | Result |
|----------|---------------|--------|
| Structural Arbitrage (Phase 1) | ~20h | KILL - 0 violations |
| Funding Tail Mispricing (Phase 2) | ~10h | KILL - no signal |
| Range Bound Carry (Phase 3) | ~10h | KILL - no signal |
| Complete-Set Arbitrage | 24h scanner | KILL - 0 opportunities |
| Autocorrelation Streaks | ~5h | KILL - slight mean reversion, not tradeable |
| Funding Direction | ~5h | KILL - p=0.92, random |
| Time-of-Day Patterns | ~5h | KILL - p=0.90, random |
| "Final 15 Seconds" (external backtest) | N/A | NOT VIABLE - see below |

### Why "Final 15 Seconds" Strategy is Not Viable

The external backtest showed 56 wins / 0 losses. Here's why this is not actionable:

1. **Sample size is statistically meaningless**
   - 56 trades gives 95% CI of [93.6%, 100%] win rate
   - You need 98%+ win rate to break even
   - Cannot distinguish luck from edge

2. **Risk/reward is catastrophic**
   - Win: +$0.20 (2% of $10)
   - Loss: -$9.80 (98% of $10)
   - One loss erases 49 wins
   - Kelly criterion says: don't bet

3. **Execution is untested**
   - No order book depth data at 15 seconds
   - No latency modeling
   - Who sells at 98c with 15s left?
   - Backtest assumes instant fills (unrealistic)

4. **Data provenance issues**
   - External "polybacktest" data
   - AI-generated backtest code
   - Cannot verify fill assumptions

**Verdict:** Do not pursue without building proper testing infrastructure first.

---

## What Actually Has Edge

### Maker Longshot Selling

**Evidence:** 404M trades across 408,863 markets (Becker dataset)

| Price Bucket | Seller Edge | Volume | Confidence |
|--------------|-------------|--------|------------|
| 0-5% | +1.5% | $163M | High |
| 5-10% | +1.7% | $195M | High |
| 10-15% | +1.5% | $234M | Medium |

**Why it works:**
- Retail systematically overbids longshots (lottery ticket bias)
- Net taker flow: $373.5M selling to makers
- You're selling insurance to gamblers at inflated premiums

**Current status:**
- Telegram bot scanning for opportunities
- Order placement infrastructure ready
- No live orders placed yet

---

## Recommended Path Forward

### Option A: Double Down on Maker Longshot (Recommended)

**Rationale:** This is the only strategy with statistical evidence of edge from real market data.

**Steps:**

1. **Paper Trading Validation (Week 1)**
   - Place simulated orders at discovered prices
   - Track theoretical fills using real order flow
   - Measure actual fill rates vs theoretical
   - Goal: Validate 80%+ of theoretical edge survives execution

2. **Position Sizing Analysis**
   - Model tail risk (what if a 5% longshot wins?)
   - Calculate Kelly-optimal sizing given edge and variance
   - Set hard risk limits (already have in `ExecutionRiskGuard`)

3. **Live Pilot (Week 2-3)**
   - Start with $50-100 total exposure
   - Place real limit orders on 3-5 markets
   - Monitor fill rates religiously
   - Track realized vs theoretical PnL

4. **Scale Decision (Week 4)**
   - If realized edge > 1% after costs: increase size gradually
   - If realized edge < 0.5%: investigate why (adverse selection, stale fills)
   - If negative: kill and reassess

**Success Criteria:**
- Fill rate > 50% of posted orders
- Realized edge > 1% of notional
- No position losses > $50

---

### Option B: Build "Final Seconds" Testing Infrastructure

**Rationale:** If you want to validate the 98c strategy properly, you need real data first.

**Steps:**

1. **Order Book Recorder**
   - Subscribe to WebSocket for target markets
   - Log full order book state at: 60s, 30s, 15s, 10s, 5s before resolution
   - Capture: bid/ask prices, depths at each level, spread

2. **Run for 100+ Markets**
   - Don't trade, just observe
   - Answer: Is there liquidity at 98c with 15s left?
   - Answer: How much size is available?

3. **Latency Simulator**
   - Measure your actual order placement latency
   - Model realistic fill assumptions
   - Account for network jitter

4. **Forward Paper Test**
   - If liquidity exists, simulate 50+ trades
   - Assume worst-case fills (you cross the spread)
   - Track simulated PnL

**Timeline:** 2-3 weeks of data collection before any conclusions

**Success Criteria:**
- Document average depth at 98c with <15s left
- Measure actual latency distribution
- Forward test shows >98% win rate with realistic fills

---

### Option C: New Market Research

**Rationale:** BTC 5-minute markets may be over-optimized. Look elsewhere.

**Potential Areas:**

1. **Weather Markets**
   - Less competition than BTC
   - Already have strategy code (`weather-mean-reversion.ts`)
   - Need validation similar to BTC

2. **Politics Markets**
   - High volume, different participant base
   - Potential for longshot bias similar to BTC
   - Need to add market discovery

3. **Sports Markets**
   - Polymarket has some sports
   - Different dynamics (event-driven)
   - Higher variance, potentially higher edge

4. **Cross-Market Arbitrage**
   - Polymarket vs other prediction markets
   - Requires multi-venue infrastructure

---

## Recommended Priority

| Priority | Action | Timeline |
|----------|--------|----------|
| 1 | Paper trade maker longshot strategy | Week 1 |
| 2 | Live pilot with small size | Week 2-3 |
| 3 | Scale or kill based on results | Week 4 |
| 4 | (Optional) Build order book recorder for "final seconds" | Parallel |

---

## Implementation Tasks

### Immediate (This Week)

- [ ] Configure paper trading mode in `.env`
- [ ] Run `npm run maker:scan` daily
- [ ] Log theoretical fills manually
- [ ] Track in spreadsheet or SQLite

### Short-term (Weeks 2-4)

- [ ] Place first live limit orders ($50 total exposure)
- [ ] Set up position tracking
- [ ] Daily PnL reconciliation
- [ ] Decision checkpoint at week 4

### Medium-term (Month 2+)

- [ ] If maker strategy works: automated order management
- [ ] If maker strategy fails: pivot to Option B or C
- [ ] Build order book recorder regardless (useful data)

---

## Risk Warnings

1. **Tail Risk:** Even with 1.5% edge, a 5% longshot winning costs you 95 cents. You need many wins to recover.

2. **Adverse Selection:** Market makers may know something you don't. High fill rates on your sells could mean you're wrong.

3. **Liquidity Illusion:** Becker data is historical. Current market conditions may differ.

4. **Regulatory:** Polymarket operates in gray area. Withdrawal risk exists.

---

## Scripts Ready to Use

```bash
# Scan for maker opportunities
npm run maker:scan

# Get Telegram notifications
npm run telegram:bot

# Place a test order (modify script for real order)
npm run maker:place

# Check wallet/API setup
npm run setup:check

# View dashboard
npm run dashboard
```

---

## Conclusion

The data is clear: taker strategies on BTC 5-minute markets have zero edge. Competition has eliminated arbitrage opportunities. The only path forward with evidence is maker longshot selling, which shows 1.5-1.8% theoretical edge.

The "final 15 seconds" strategy is intellectually interesting but statistically unvalidated. If you want to pursue it, build the infrastructure to test it properly first.

My recommendation: Start paper trading the maker strategy this week. Real data from real orders will tell you more than another month of backtesting.
