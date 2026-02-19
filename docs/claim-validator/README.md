# Claim Validator System

A Telegram-based trading claim validation system that analyzes X/Twitter posts and text claims against your existing BTC trading strategies.

## Overview

The Claim Validator acts as a research triage system:
1. **Receive** trading claims via Telegram (X links or text)
2. **Extract** structured claim data using Claude AI
3. **Map** claims to existing BTC strategy families
4. **Score** legitimacy, applicability, and diversification potential
5. **Report** actionable triage verdicts back to Telegram

## Quick Start

```bash
# 1. Set environment variables (see ENVIRONMENT.md)
export ANTHROPIC_API_KEY="sk-ant-..."
export TELEGRAM_BOT_TOKEN="123456:ABC..."
export TELEGRAM_ALLOWED_USERS="your_telegram_user_id"

# 2. Build the project
npm run build

# 3. Run locally
npm run telegram:bot

# 4. Or deploy to VPS (see VPS_DEPLOYMENT.md)
```

## Documentation

| Document | Description |
|----------|-------------|
| [ARCHITECTURE.md](./ARCHITECTURE.md) | Module structure and data flow |
| [ENVIRONMENT.md](./ENVIRONMENT.md) | Environment variables and secrets |
| [TELEGRAM_BOT.md](./TELEGRAM_BOT.md) | Bot commands and usage guide |
| [SECURITY.md](./SECURITY.md) | Security features and hardening |
| [VPS_DEPLOYMENT.md](./VPS_DEPLOYMENT.md) | VPS deployment and PM2 setup |

## Features

### Claim Analysis
- Extracts market type, strategy, timeframe, and metrics from claims
- Maps claims to existing BTC strategy families (momentum, breakout, regime-trend)
- Detects prompt injection attempts
- Tracks source credibility over time

### Triage Verdicts
| Verdict | Description |
|---------|-------------|
| `high_priority` | Score >= 8/10, act soon |
| `explore` | Score >= 6/10, worth investigating |
| `test_further` | Maps to existing strategy, needs validation |
| `already_covered` | Existing strategy covers this |
| `ignore` | Low quality or not applicable |
| `security_blocked` | Injection attempt detected |

### Security
- Telegram user allowlist
- Prompt injection detection (15+ patterns)
- Full audit logging
- Tailscale VPN access
- Optional outbound whitelist

## Directory Structure

```
src/claim-validator/
├── index.ts                 # Main orchestrator
├── types.ts                 # TypeScript interfaces
└── services/
    ├── claim-parser.ts      # LLM claim extraction
    ├── btc-mapper.ts        # BTC strategy mapping
    ├── general-validator.ts # Non-BTC claim validation
    ├── correlation-analyzer.ts # Diversification analysis
    ├── triage-reporter.ts   # Verdict generation
    └── security.ts          # Injection detection, audit logging

src/telegram-bot/
└── index.ts                 # Telegram bot handler

config/
├── telegram-allowlist.json  # Authorized users
└── audit-log.jsonl          # Security audit trail

infra/
├── harden-vps.sh           # VPS hardening
├── setup-tailscale.sh      # Tailscale VPN
├── firewall-rules.sh       # UFW lockdown
└── outbound-whitelist.sh   # Restrict outbound
```

## Related Documentation

- [VPS_SETUP.md](../VPS_SETUP.md) - General VPS configuration
- [infra/README.md](../../infra/README.md) - Infrastructure security scripts
