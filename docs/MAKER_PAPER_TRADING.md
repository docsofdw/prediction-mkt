# Maker Longshot Paper Trading Guide

## Quick Start

```bash
# Run full cycle (scan + check + report)
npm run maker:paper

# Or run individual steps:
npm run maker:paper:scan    # Find opportunities and place paper orders
npm run maker:paper:check   # Check for fills and resolve outcomes
npm run maker:paper:report  # View P&L report
npm run maker:paper:reset   # Clear all paper trading data
```

---

## Automated Mode (Recommended)

### Cron Commands

```bash
# Run cycle with Telegram notifications
npm run maker:paper:cron

# Run with daily summary
npm run maker:paper:cron:summary

# Run silently (no notifications)
npm run maker:paper:cron -- --quiet
```

### Cron Setup

Add to your crontab (`crontab -e`):

```bash
# Every 4 hours - check for fills and opportunities
0 */4 * * * cd ~/prediction-mkt && npm run maker:paper:cron >> ~/logs/paper-cron.log 2>&1

# Daily at 9am UTC - with summary report
0 9 * * * cd ~/prediction-mkt && npm run maker:paper:cron:summary >> ~/logs/paper-cron.log 2>&1
```

### VPS Setup (if using your existing VPS)

```bash
# SSH to VPS
ssh ubuntu@100.64.97.50

# Create logs directory
mkdir -p ~/logs

# Edit crontab
crontab -e

# Add the cron jobs above, then verify
crontab -l
```

### What Gets Notified

You'll receive Telegram messages when:
- **New orders placed** - Shows market, price, size
- **Orders filled** - Confirms your paper order got "hit"
- **Markets resolved** - Shows outcome (YES/NO) and P&L
- **Daily summary** (if using --summary) - Portfolio overview

Example notification:
```
📝 2 New Paper Orders

• SELL 53 @ 7.5¢
  MicroStrategy sells any Bitcoin by June...

✅ 1 Order Filled!
• SELL 51 @ 2.1¢ (+$1.07 premium)
  MicroStrategy sells any Bitcoin by March...

🟢 1 Market Resolved
✓ NO: +$1.07
  MicroStrategy sells any Bitcoin by March...
```

---

## Manual Mode

## Daily Workflow

### Morning (or whenever you start)

```bash
npm run maker:paper
```

This will:
1. Scan for new longshot opportunities
2. Place paper orders (skip tokens where you already have a position)
3. Check if any open orders would have filled
4. Resolve any markets that closed
5. Show your P&L report

### Throughout the day

Run `npm run maker:paper:check` periodically to:
- Detect fills (if market price rose to your sell price)
- Resolve closed markets
- Update P&L

### End of day

```bash
npm run maker:paper:report
```

Review your positions and P&L.

---

## How It Works

### Order Placement

When you run `maker:paper:scan`:
1. Scans Polymarket for BTC-related longshot markets (YES tokens priced < 20%)
2. Filters by volume, days to expiry, and estimated edge
3. Creates paper SELL orders slightly above current price (to be a maker)
4. Records orders in SQLite (`backtests/validation.db`)

### Fill Simulation

When you run `maker:paper:check`:
- For each open order, checks current market price
- If current price >= your sell price, assumes you got filled
- This is conservative (real fills depend on order book activity)

### P&L Calculation

When a market closes:
- **If NO wins:** You keep the premium (profit = sell_price × contracts)
- **If YES wins:** You lose (loss = (1 - sell_price) × contracts)

---

## Example Output

```
PAPER TRADING REPORT
════════════════════════════════════════════════════════════

SUMMARY
----------------------------------------
Total orders:     12
  Open:           4
  Filled:         6
  Expired:        2

Resolved:         6
  Wins:           5
  Losses:         1
  Win Rate:       83.3%

Realized P&L:     $2.47
Open Exposure:    $8.50

EDGE ANALYSIS
----------------------------------------
Expected edge:    1.52%
Realized edge:    1.38% per contract
```

---

## Understanding the Strategy

### What you're doing:
- Selling YES tokens on low-probability events (longshots)
- You receive premium upfront
- Most of these expire worthless (NO wins) → you keep premium
- Occasionally one hits (YES wins) → you pay out

### Expected edge:
Based on 404M historical trades, sellers at these price points have ~1.5-1.8% edge.

### Risk profile:
- Win: Small profit (sell price × contracts)
- Loss: Large loss ((1 - sell price) × contracts)
- Need 80-95% win rate to be profitable (depending on price level)

---

## Graduating to Live Trading

After 2-4 weeks of paper trading:

1. **Verify edge is real**
   - Is realized P&L positive?
   - Is win rate > 80%?
   - Does realized edge match expected edge?

2. **If yes, start small**
   ```bash
   npm run maker:place -- --token=TOKEN_ID --price=0.05 --size=20
   ```
   - Start with $50-100 total exposure
   - Monitor fills in Polymarket UI
   - Track actual P&L

3. **Scale gradually**
   - Increase size only after confirmed positive results
   - Set hard risk limits (already configured in ExecutionRiskGuard)

---

## Data Location

All paper trading data stored in:
- **Database:** `backtests/validation.db`
- **Table:** `paper_orders`

Query directly with:
```bash
sqlite3 backtests/validation.db "SELECT * FROM paper_orders ORDER BY created_at DESC LIMIT 10"
```

---

## Troubleshooting

### "No order targets found"

The scanner found no markets matching criteria. Check:
- Are there active BTC longshot markets? (`npm run maker:scan`)
- Are filters too strict? (see `backtests/becker-reports/strategy-params.json`)

### Orders never fill

The fill simulation is conservative. In paper trading, fills only happen when market price reaches your sell price. Real maker orders may fill sooner from taker activity.

### Want to start fresh

```bash
npm run maker:paper:reset
```

Clears all paper trading history.
