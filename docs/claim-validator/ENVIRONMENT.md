# Environment Variables

This document covers all environment variables required for the Claim Validator and Telegram bot.

## Required Variables

### Anthropic API (Claude)

```env
# Claude API key for claim parsing and validation
# Get yours at: https://console.anthropic.com/
ANTHROPIC_API_KEY=sk-ant-api03-...
```

### Telegram Bot

```env
# Bot token from @BotFather
# Create a bot: https://t.me/BotFather → /newbot
TELEGRAM_BOT_TOKEN=8525468988:AAE...

# Comma-separated list of authorized Telegram user IDs
# Find your ID: https://t.me/userinfobot
TELEGRAM_ALLOWED_USERS=1262476386

# Chat ID for automated notifications (maker:notify cron)
# Find by calling: curl "https://api.telegram.org/bot<TOKEN>/getUpdates"
TELEGRAM_CHAT_ID=1262476386
```

### Project Path (Optional)

```env
# Path to project root (defaults to cwd)
# Useful when running from a different directory
PREDICTION_MKT_PATH=/home/ubuntu/prediction-mkt
```

## Full .env Template

```env
# ─── Claim Validator ─────────────────────────────────────
ANTHROPIC_API_KEY=sk-ant-api03-your-key-here
TELEGRAM_BOT_TOKEN=your-bot-token-here
TELEGRAM_ALLOWED_USERS=your-user-id
TELEGRAM_CHAT_ID=your-chat-id  # For cron notifications

# ─── Polymarket (for existing trading bot) ───────────────
PRIVATE_KEY=0x...
FUNDER_ADDRESS=0x...
POLY_API_KEY=
POLY_API_SECRET=
POLY_PASSPHRASE=
CHAIN_ID=137
SIGNATURE_TYPE=1
CLOB_HOST=https://clob.polymarket.com
GAMMA_HOST=https://gamma-api.polymarket.com
DATA_API_HOST=https://data-api.polymarket.com

# ─── Bitcoin Magazine Pro (optional) ─────────────────────
BITCOIN_MAGAZINE_PRO_API_KEY=
BM_PRO_BASE_URL=https://api.bitcoinmagazinepro.com

# ─── General ─────────────────────────────────────────────
LOG_LEVEL=info
EXECUTION_MODE=paper
```

## How to Get Your Telegram User ID

1. Open Telegram
2. Search for `@userinfobot`
3. Send `/start`
4. The bot will reply with your user ID

## How to Create a Telegram Bot

1. Open Telegram
2. Search for `@BotFather`
3. Send `/newbot`
4. Follow the prompts to choose a name and username
5. BotFather will give you a token like `8525468988:AAEy-ol3Gdnfc7t0Ievlig9LKrRbwADmRUE`

## Security Notes

### Secrets to Never Commit

These should NEVER be committed to git:
- `ANTHROPIC_API_KEY`
- `TELEGRAM_BOT_TOKEN`
- `PRIVATE_KEY`
- `POLY_API_SECRET`
- `POLY_PASSPHRASE`
- `BITCOIN_MAGAZINE_PRO_API_KEY`

### .gitignore Entry

Ensure your `.gitignore` includes:
```
.env
.env.local
.env.*.local
```

### VPS Deployment

When deploying to VPS, either:

1. **Copy .env directly** (secure if using VPN):
   ```bash
   scp .env ubuntu@100.64.97.50:~/prediction-mkt/
   ```

2. **Set env vars in PM2 ecosystem file**:
   ```javascript
   // ecosystem.config.js
   module.exports = {
     apps: [{
       name: "telegram-bot",
       script: "dist/telegram-bot/index.js",
       env: {
         ANTHROPIC_API_KEY: "...",
         TELEGRAM_BOT_TOKEN: "...",
         TELEGRAM_ALLOWED_USERS: "...",
       }
     }]
   };
   ```

3. **Use systemd environment file**:
   ```bash
   sudo nano /etc/systemd/system/telegram-bot.service.d/env.conf
   ```

## Configuration Files

In addition to environment variables, these config files are used:

### `config/telegram-allowlist.json`

Persistent allowlist with notes:
```json
{
  "allowedUsers": ["1262476386"],
  "updatedAt": "2026-02-18T00:00:00.000Z",
  "notes": {
    "1262476386": "Duke Waldrop - Primary operator"
  }
}
```

This supplements `TELEGRAM_ALLOWED_USERS`. Users in either location are authorized.

### `config/source-credibility.json`

Tracks credibility of claim sources over time (auto-generated):
```json
{
  "sources": {
    "twitter:@example": {
      "totalClaims": 5,
      "verifiedEdges": 3,
      "falseEdges": 1,
      "credibilityScore": 0.72
    }
  }
}
```

### `config/audit-log.jsonl`

Append-only security audit log (auto-generated):
```
{"timestamp":"2026-02-18T12:00:00Z","eventType":"claim_validated",...}
{"timestamp":"2026-02-18T12:01:00Z","eventType":"security_flag",...}
```

## Tailscale VPN

For secure VPS access, the following Tailscale IPs are configured:

| Device | Tailscale IP |
|--------|--------------|
| Local machine | 100.68.16.22 |
| Tokyo VPS | 100.64.97.50 |

SSH via Tailscale:
```bash
ssh ubuntu@100.64.97.50
```
