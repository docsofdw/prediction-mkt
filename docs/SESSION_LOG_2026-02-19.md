# Session Log: February 19, 2026

## Summary

Set up 24/7 Telegram bot with maker longshot scanning, smart notifications, and claim validation on AWS Lightsail VPS.

---

## Current Infrastructure

### VPS (AWS Lightsail - Tokyo)

| Component | Value |
|-----------|-------|
| Instance | $5/mo (512MB RAM + 1GB swap) |
| Tailscale IP | `100.64.97.50` |
| Public IP | `54.248.145.165` |
| Local Tailscale | `100.68.16.22` |

### Services Running

| Service | Status | Manager |
|---------|--------|---------|
| Telegram Bot | Running | PM2 (auto-restart, survives reboots) |
| Maker Scan Cron | 9am UTC daily | crontab |

### Quick Access

```bash
# SSH to VPS
ssh ubuntu@100.64.97.50

# Check bot status
ssh ubuntu@100.64.97.50 "pm2 status"

# View bot logs
ssh ubuntu@100.64.97.50 "pm2 logs telegram-bot --lines 50"

# View cron logs
ssh ubuntu@100.64.97.50 "tail -50 ~/logs/maker-cron.log"

# Restart bot
ssh ubuntu@100.64.97.50 "pm2 restart telegram-bot"
```

---

## What's Working

### Telegram Bot Commands

| Command | Function |
|---------|----------|
| `/start` | Welcome message |
| `/maker` | Run maker longshot scan (full questions, links, $100 ROI sim) |
| `/scan` | Run BTC inefficiency scan |
| `/status` | Check bot/portfolio status |
| `/portfolio` | View portfolio metrics |
| `/credibility` | View source credibility scores |
| `/validate <text>` | Validate a trading claim |
| Send URL | Auto-validates X/Twitter links |

### Maker Scan Output

```
• MicroStrategy sells any Bitcoin by June 30, 2026?
  NO @ 92.5¢ | 53 contracts
  💰 $100 bet → +$8.11 if NO wins
  View Market
```

### Smart Notifications (Cron)

Only notifies when:
- 🆕 New markets found
- 📈 Price changed >10%
- 📅 Weekly digest (7 days no changes)

State tracked in: `backtests/maker-scan-state.json`

### Claim Validator

- Fetches X/Twitter content via FxTwitter API
- Claude analyzes for trading edges
- Scores: Legitimacy, Applicability, Feasibility
- Generates actionable validation steps

---

## Key Files

| File | Purpose |
|------|---------|
| `src/telegram-bot/index.ts` | Main bot code |
| `src/scripts/maker-scan-notify.ts` | Cron notification script |
| `src/markets/btc/strategies/maker-longshot-seller.ts` | Maker strategy |
| `src/claim-validator/` | Claim validation services |
| `backtests/maker-scan-state.json` | Tracks seen markets |
| `backtests/maker-scan-latest.json` | Latest scan results |
| `docs/markets/btc/MAKER_STRATEGY.md` | Strategy documentation |
| `docs/claim-validator/VPS_DEPLOYMENT.md` | VPS setup guide |

---

## Next Steps to Test

### 1. Paper Trade the Maker Strategy

The scan identifies opportunities, but we haven't placed actual orders yet.

```bash
# Review current opportunities
/maker

# Set up paper trading mode
EXECUTION_MODE=paper npm run dev
```

**Goal**: Track hypothetical fills for 1-2 weeks, measure simulated P&L.

### 2. Monitor Cron Notifications

Watch for a few days to verify:
- Smart notifications work (skips when no changes)
- Weekly digest fires after 7 days
- No false positives

```bash
# Check cron history
ssh ubuntu@100.64.97.50 "tail -100 ~/logs/maker-cron.log"
```

### 3. Test Claim Validator with More Sources

Try different types of claims:
- Academic papers about prediction markets
- Trading strategy threads
- Polymarket-specific alpha claims

### 4. Expand Market Coverage

Currently scanning BTC markets only. Consider:
- Politics markets
- Sports markets
- Crypto markets beyond BTC

Would require updating `maker-longshot-seller.ts` to scan more categories.

### 5. Live Order Placement (When Ready)

After paper trading validation:
1. Start with $50-100 exposure limit
2. Place real limit orders on 2-3 markets
3. Monitor fill rates
4. Track actual P&L

### 6. Add Order Management

Future enhancements:
- Cancel stale orders
- Adjust prices based on market movement
- Position tracking dashboard

---

## Environment Variables (VPS)

Located in `~/prediction-mkt/.env`:

```
TELEGRAM_BOT_TOKEN=<set>
TELEGRAM_ALLOWED_USERS=1262476386
TELEGRAM_CHAT_ID=1262476386
ANTHROPIC_API_KEY=<set>
GAMMA_HOST=https://gamma-api.polymarket.com
```

---

## Troubleshooting

### Bot Not Responding

```bash
ssh ubuntu@100.64.97.50 "pm2 restart telegram-bot && pm2 logs telegram-bot --lines 20"
```

### OOM Kills

Swap is configured (1GB), but if issues persist:
```bash
ssh ubuntu@100.64.97.50 "free -h"
```

### VPS Unreachable

1. Check Tailscale status locally: `tailscale status`
2. If VPS shows offline, restart from AWS Lightsail console
3. Then: `ssh ubuntu@100.64.97.50 "sudo systemctl start tailscaled"`

### Cron Not Running

```bash
ssh ubuntu@100.64.97.50 "crontab -l"
# Should show: 0 9 * * * cd ~/prediction-mkt && /usr/bin/npm run maker:notify >> ~/logs/maker-cron.log 2>&1
```

---

## Git Status

All changes committed and pushed to `main`.

Latest commits:
- `fcf7a42` - Update docs with maker scan and VPS deployment details
- `4e79ce6` - Fix state tracking: use question as key instead of eventSlug
- `e60bc3d` - Smart notifications: only alert on new markets or price changes
- `395a5fa` - Add $100 simulation to maker scan output
