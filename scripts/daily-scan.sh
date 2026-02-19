#!/bin/bash
# Daily Polymarket BTC market structure monitor
# Add to crontab: 0 12 * * * /path/to/prediction-mkt/scripts/daily-scan.sh

cd "$(dirname "$0")/.."

# Run a single scan cycle
npx ts-node src/markets/btc/scripts/phase1-monitor.ts --once 2>&1 | tee -a logs/daily-scan.log

# Check for any violations
VIOLATIONS=$(sqlite3 backtests/validation.db "SELECT COUNT(*) FROM phase1_violations WHERE resolved_at IS NULL")

if [ "$VIOLATIONS" -gt "0" ]; then
  echo "[ALERT] $VIOLATIONS open violations detected" >> logs/daily-scan.log
fi
