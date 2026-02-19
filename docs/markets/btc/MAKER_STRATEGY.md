# BTC Maker Strategy: Longshot Seller

This document describes the maker-based trading approach derived from analysis of the Becker prediction market dataset (404M trades).

## Strategic Pivot: Taker → Maker

### The Problem with Taker Strategies

Previous strategies (momentum, breakout, mean-reversion) were **taker** strategies:
- Cross the spread to enter positions
- Pay the bid-ask spread on every trade
- Compete with professional market makers

**Finding from Becker analysis**: Takers have negative excess returns at most price levels. The spread eats the edge.

### The Maker Advantage

**Makers** post limit orders and wait for fills:
- Earn the spread instead of paying it
- Let retail takers come to you
- Exploit systematic biases in taker behavior

**Finding from Becker analysis**: In longshot markets (< 20% price), takers are net SELLERS ($373.5M imbalance). This means makers who post BUY orders are capturing flow from retail capitulation.

## Longshot Bias: The Core Edge

### What is Longshot Bias?

Academic research shows that low-probability events are systematically overpriced:
- A 5% priced contract actually wins ~3% of the time
- A 10% priced contract actually wins ~8% of the time
- This creates ~2% seller edge on sub-10% contracts

### Estimated Seller Edge by Price

| Price Range | Estimated Edge | Confidence |
|-------------|----------------|------------|
| 0-5%        | +1.8%          | High       |
| 5-10%       | +1.6%          | High       |
| 10-15%      | +1.4%          | Medium     |
| 15-20%      | +1.2%          | Medium     |

### Strategy Execution

1. **Scan** for BTC markets with YES tokens priced below 20%
2. **Post limit SELL orders** slightly above the current best bid
3. **Wait** for takers to cross the spread and fill your orders
4. **Most longshots expire worthless** → you keep the premium
5. **Occasionally one hits** → you lose $(1 - price)
6. **Net expected value is positive** due to systematic mispricing

## Implementation

### Scripts

```bash
# Generate strategy parameters from Becker analysis
npm run becker:strategy

# Scan for current opportunities
npm run maker:scan

# Scan and output JSON for automation
npm run maker:scan -- --json
```

### Key Files

| File | Purpose |
|------|---------|
| `src/markets/btc/strategies/maker-longshot-seller.ts` | Core strategy module |
| `src/scripts/maker-scan.ts` | CLI scanner |
| `backtests/becker-reports/strategy-params.json` | Generated parameters |
| `backtests/becker-reports/strategy-refinements.json` | Strategy documentation |

### Configuration

Parameters are loaded from `backtests/becker-reports/strategy-params.json`:

```json
{
  "longshotThreshold": 0.20,
  "optimalPriceRange": { "min": 0.01, "max": 0.20 },
  "sizing": {
    "maxPositionPerMarket": 0.10,
    "maxGrossExposure": 500,
    "minEdgeToTrade": 0.005
  },
  "marketFilters": {
    "minDailyVolume": 100,
    "maxDaysToExpiry": 180
  },
  "risk": {
    "maxLossPerPosition": 50,
    "stopLossThreshold": 0.50
  }
}
```

## Risk Management

### Position Sizing

- **Max per market**: 10% of daily volume
- **Max gross exposure**: $500 total
- **Max loss per position**: $50

### Stop Loss

- Exit if price doubles (e.g., 5% → 10%)
- This limits loss on positions that go against you

### Correlation Management

- Don't cluster all positions in same expiry week
- Spread across different strike prices
- Max 30% in correlated BTC markets

## Testing Plan

### Phase 1: Scanner Validation (1-2 days)
- Run `npm run maker:scan` daily
- Verify candidate selection makes sense
- Tune filters in strategy-params.json

### Phase 2: Paper Trading (1 week)
- Enable maker strategy in paper mode
- Track simulated fills
- Monitor P&L and drawdowns

### Phase 3: Small Live (2 weeks)
- Start with $100 exposure limit
- Place real orders on 2-3 markets
- Monitor fill rates vs paper assumptions

### Phase 4: Scale Up (Ongoing)
- Increase to $500 exposure
- Add more markets
- Implement order management refinements

## Telegram Integration

### Manual Scan

Use the `/maker` command in the Telegram bot to run a scan on-demand:

```
/maker - Run maker opportunity scan
```

Output shows:
- Full market question
- NO price (what you're betting)
- $100 simulation (profit if you win)
- Direct link to Polymarket

### Automated Daily Notifications

The system runs automated scans via cron and sends **smart notifications**:

```bash
# Cron (9am UTC daily)
0 9 * * * cd ~/prediction-mkt && /usr/bin/npm run maker:notify >> ~/logs/maker-cron.log 2>&1
```

**Notification triggers:**
- 🆕 **New markets** - Markets not previously seen
- 📈 **Price changes** - >10% price movement on existing markets
- 📅 **Weekly digest** - Summary if no changes for 7 days

**Skips notification when:**
- Same markets, same prices, less than 7 days since last alert

**State tracking:** `backtests/maker-scan-state.json`

**Force notification:** `npm run maker:notify -- --force`

### 24/7 Operation (Lightsail VPS)

The telegram bot runs 24/7 on AWS Lightsail via PM2:

```bash
# Check status
ssh ubuntu@100.64.97.50 "pm2 status"

# View logs
ssh ubuntu@100.64.97.50 "pm2 logs telegram-bot --lines 50"

# Restart if needed
ssh ubuntu@100.64.97.50 "pm2 restart telegram-bot"

# Check cron logs
ssh ubuntu@100.64.97.50 "tail -50 ~/logs/maker-cron.log"
```

**Auto-recovery:**
- PM2 auto-restarts on crash
- PM2 startup enabled (survives reboots)
- 1GB swap prevents OOM kills

### Scripts

| Script | Purpose |
|--------|---------|
| `npm run maker:scan` | CLI scan with console output |
| `npm run maker:scan -- --json` | JSON output to `backtests/maker-scan-latest.json` |
| `npm run maker:notify` | Scan + Telegram notification (smart) |
| `npm run maker:notify -- --force` | Force send even if no changes |

## Becker Analysis Scripts

For ongoing calibration, use these scripts to analyze the Becker dataset:

```bash
# Download dataset (36GB, run in Colab recommended)
npm run becker:download

# Explore dataset structure
npm run becker:explore

# Analyze BTC calibration
npm run becker:calibration

# Analyze maker/taker flows
npm run becker:maker-taker

# Generate strategy parameters
npm run becker:strategy
```

Or use the Colab notebooks in `notebooks/`:
- `becker-analysis.ipynb` - Main analysis
- `becker-pnl-analysis.ipynb` - PnL calibration

## Comparison with Previous Approach

| Aspect | Taker Strategy | Maker Strategy |
|--------|----------------|----------------|
| Trade frequency | High | Low |
| Spread impact | Pay spread | Earn spread |
| Edge source | Price prediction | Behavioral bias |
| Fill certainty | 100% | Variable |
| Capital efficiency | Lower | Higher |
| Monitoring needed | High | Medium |

## References

- Becker prediction-market-analysis dataset: https://s3.jbecker.dev
- Academic research on longshot bias in prediction markets
- Polymarket CLOB documentation
