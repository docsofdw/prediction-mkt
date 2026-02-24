# VPS Cron Setup for Paper Trading

## Quick Setup Commands

SSH into your VPS and run:

```bash
# Pull latest code
cd ~/prediction-mkt
git pull

# Create logs directory
mkdir -p ~/logs

# Reset paper trading (fresh start with $200 max)
npm run maker:paper:reset

# Test that it works
npm run maker:paper:cron

# Set up cron
crontab -e
```

Add these lines to crontab:

```bash
# Paper trading - every 4 hours (check fills, place new orders)
0 */4 * * * cd ~/prediction-mkt && npm run maker:paper:cron >> ~/logs/paper-cron.log 2>&1

# Daily summary at 9am UTC
0 9 * * * cd ~/prediction-mkt && npm run maker:paper:cron:summary >> ~/logs/paper-cron.log 2>&1
```

Save and verify:
```bash
crontab -l
```

## Verify It's Working

```bash
# Check cron logs
tail -50 ~/logs/paper-cron.log

# Check paper trading status
npm run maker:paper:report
```

## Configuration

Current settings (in `backtests/becker-reports/strategy-params.json`):
- Max gross exposure: $200
- Max loss per position: $25
- Min edge to trade: 1%
- Price range: 1-20 cents

## Troubleshooting

If VPS is unreachable:
1. Check AWS Lightsail console
2. Restart instance if needed
3. After restart: `sudo systemctl start tailscaled`
