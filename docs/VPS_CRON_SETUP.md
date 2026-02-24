# VPS Setup for Final Seconds Recorder

## Quick Start

SSH into your VPS and run:

```bash
# Pull latest code
cd ~/prediction-mkt
git pull
npm install

# Create logs directory
mkdir -p ~/logs

# Start the recorder in a detached screen session
screen -dmS final-recorder bash -c 'npm run final:record >> ~/logs/final-recorder.log 2>&1'

# Verify it's running
screen -ls
tail -20 ~/logs/final-recorder.log
```

## Managing the Recorder

```bash
# View recent log output
tail -100 ~/logs/final-recorder.log

# Attach to screen session (Ctrl+A, D to detach)
screen -r final-recorder

# Stop the recorder
screen -S final-recorder -X quit

# Restart the recorder
screen -S final-recorder -X quit 2>/dev/null
screen -dmS final-recorder bash -c 'npm run final:record >> ~/logs/final-recorder.log 2>&1'
```

## Analyzing Results

```bash
# Quick summary
npm run final:analyze

# Full report
npm run final:report
```

## What It Records

The recorder captures order book snapshots at T-60s, T-30s, T-15s, T-10s, T-5s before resolution for every 5-minute BTC market:
- Best bid/ask for UP and DOWN tokens
- Bid/ask depth (USD value)
- BTC spot price vs target
- High-confidence side and price

After markets resolve, it records outcomes and calculates win rates.

## Troubleshooting

If VPS is unreachable:
1. Check AWS Lightsail console
2. Restart instance if needed
3. After restart: `sudo systemctl start tailscaled`

---

## Archived: Maker Longshot Paper Trading

The maker longshot paper trading scripts have been archived to `src/scripts/_archive/`:
- `maker-paper-trade.ts`
- `maker-paper-cron.ts`

These were for testing the longshot seller strategy on long-dated markets, but those markets take weeks/months to resolve. The final-seconds recorder provides faster validation (5-minute feedback loops).
