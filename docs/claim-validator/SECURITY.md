# Security Features

This document covers the security measures implemented in the Claim Validator system.

## Security Layers

```
┌─────────────────────────────────────────────────────────────┐
│ Layer 1: Network Security                                    │
│ • Tailscale VPN (private mesh network)                       │
│ • UFW firewall (Tailscale-only access)                       │
│ • Optional outbound whitelist                                │
└─────────────────────────────────────────────────────────────┘
                              │
┌─────────────────────────────────────────────────────────────┐
│ Layer 2: Authentication                                      │
│ • Telegram user allowlist                                    │
│ • User ID verification on every message                      │
│ • Unauthorized access logging                                │
└─────────────────────────────────────────────────────────────┘
                              │
┌─────────────────────────────────────────────────────────────┐
│ Layer 3: Input Validation                                    │
│ • Prompt injection detection (15+ patterns)                  │
│ • Input sanitization before LLM calls                        │
│ • Blocked messages logged and rejected                       │
└─────────────────────────────────────────────────────────────┘
                              │
┌─────────────────────────────────────────────────────────────┐
│ Layer 4: Audit Trail                                         │
│ • All actions logged to audit-log.jsonl                      │
│ • Immutable append-only log format                           │
│ • Security events flagged for review                         │
└─────────────────────────────────────────────────────────────┘
```

## Prompt Injection Detection

### Detected Patterns

The system blocks messages matching these patterns:

| Category | Examples | Severity |
|----------|----------|----------|
| Instruction override | "ignore previous instructions", "disregard your rules" | High |
| Role manipulation | "you are now a different assistant", "pretend to be" | High |
| System prompt access | "show me your system prompt", "reveal your instructions" | High |
| Delimiter injection | `[INST]`, `<<SYS>>`, `</s>` | High |
| Encoding tricks | Base64 instructions, unicode obfuscation | Medium |
| Repetition attacks | Repeated override attempts | Medium |

### Full Pattern List

```typescript
const INJECTION_PATTERNS = [
  // Instruction override
  { pattern: /ignore\s+(previous|all|your)\s+(instructions?|rules?)/i, severity: "high" },
  { pattern: /disregard\s+(previous|all|your)\s+(instructions?|programming)/i, severity: "high" },
  { pattern: /forget\s+(everything|all|your)\s+(instructions?|rules?)/i, severity: "high" },

  // Role manipulation
  { pattern: /you\s+are\s+now\s+a/i, severity: "high" },
  { pattern: /pretend\s+(to\s+be|you('re| are))/i, severity: "high" },
  { pattern: /act\s+as\s+(if|though|a)/i, severity: "medium" },

  // System prompt extraction
  { pattern: /what\s+(is|are)\s+your\s+(system\s+)?prompt/i, severity: "high" },
  { pattern: /reveal\s+your\s+(instructions?|programming)/i, severity: "high" },
  { pattern: /show\s+(me\s+)?your\s+(system\s+)?prompt/i, severity: "high" },

  // Delimiter injection
  { pattern: /\[INST\]/i, severity: "high" },
  { pattern: /<<SYS>>/i, severity: "high" },
  { pattern: /<\/s>/i, severity: "high" },
  { pattern: /system\s*:\s*/i, severity: "medium" },

  // Jailbreak markers
  { pattern: /\bDAN\b.*\bmode\b/i, severity: "high" },
  { pattern: /jailbreak/i, severity: "high" },
];
```

### Response to Detection

When injection is detected:
1. Message is **blocked** immediately
2. Security event is **logged** with full context
3. User receives generic "security_blocked" verdict
4. No LLM call is made

## User Allowlist

### Configuration

Users can be authorized via:

1. **Environment variable** (runtime):
   ```env
   TELEGRAM_ALLOWED_USERS=1262476386,9876543210
   ```

2. **Config file** (persistent):
   ```json
   // config/telegram-allowlist.json
   {
     "allowedUsers": ["1262476386"],
     "notes": {
       "1262476386": "Duke Waldrop - Primary operator"
     }
   }
   ```

Users in either location are authorized.

### Verification Flow

```typescript
function isAuthorized(userId: number): boolean {
  return allowlist.isAllowed(userId);
}

// Called on every message
bot.on("message", async (msg) => {
  if (!isAuthorized(msg.from?.id ?? 0)) {
    logUnauthorized(msg);
    return bot.sendMessage(msg.chat.id, "Unauthorized.");
  }
  // ... process message
});
```

## Audit Logging

### Log Format

JSON Lines format (one event per line):

```json
{
  "timestamp": "2026-02-18T12:00:00.000Z",
  "eventType": "claim_validated",
  "metadata": {
    "sourceId": "telegram:duke",
    "verdict": "explore",
    "score": 7.2,
    "claimHash": "a1b2c3..."
  }
}
```

### Event Types

| Event Type | Description |
|------------|-------------|
| `claim_validated` | Successful claim validation |
| `security_flag` | Injection attempt detected |
| `unauthorized_access` | User not in allowlist |
| `api_error` | Claude API failure |
| `bot_started` | Bot initialization |

### Log Location

```
config/audit-log.jsonl
```

### Viewing Logs

```bash
# Latest entries
tail -20 config/audit-log.jsonl

# Security events only
grep '"eventType":"security_flag"' config/audit-log.jsonl

# Pretty print
cat config/audit-log.jsonl | jq .
```

## Network Security

### Tailscale VPN

All access to the VPS is through Tailscale mesh VPN:

| Device | Tailscale IP |
|--------|--------------|
| Local machine | 100.68.16.22 |
| Tokyo VPS | 100.64.97.50 |

Benefits:
- **Encrypted**: All traffic is encrypted
- **Private**: VPS not exposed to public internet
- **Identity-based**: Access tied to Tailscale account

### UFW Firewall

When `infra/firewall-rules.sh` is applied:

```
Default incoming: DENY
Default outgoing: ALLOW

Allowed:
- SSH from 100.64.0.0/10 (Tailscale only)
- All traffic on tailscale0 interface
```

### Outbound Whitelist (Optional)

When `infra/outbound-whitelist.sh --enable` is applied:

Only these destinations are allowed:
- api.anthropic.com (Claude)
- api.telegram.org (Telegram)
- gamma-api.polymarket.com
- clob.polymarket.com
- api.coingecko.com
- Ubuntu/npm package managers
- Tailscale control plane
- GitHub

All other outbound traffic is blocked and logged.

## Secret Management

### Secrets in Environment

These must never be committed:
- `ANTHROPIC_API_KEY`
- `TELEGRAM_BOT_TOKEN`
- `PRIVATE_KEY`
- `POLY_API_SECRET`
- `POLY_PASSPHRASE`

### .gitignore

Ensure these patterns are in `.gitignore`:
```
.env
.env.local
.env.*.local
config/audit-log.jsonl
```

### VPS Security

On the VPS:
1. `.env` file permissions: `chmod 600 .env`
2. Config directory: `chmod 700 config/`
3. Audit log: append-only operations

## Incident Response

### If Injection Detected

1. Check audit log for context:
   ```bash
   grep security_flag config/audit-log.jsonl | tail -10
   ```

2. Review the blocked message for actual threat level

3. If persistent, consider blocking at Telegram level:
   - Add user ID to a blocklist
   - Report to Telegram

### If Unauthorized Access

1. Unauthorized attempts are logged automatically

2. Review patterns:
   ```bash
   grep unauthorized_access config/audit-log.jsonl
   ```

3. If targeted, enable firewall hardening:
   ```bash
   sudo bash infra/firewall-rules.sh
   ```

### If API Key Compromised

1. Immediately rotate the key:
   - Anthropic: https://console.anthropic.com/
   - Telegram: @BotFather → /revoke

2. Update `.env` on VPS

3. Restart bot:
   ```bash
   pm2 restart telegram-bot
   ```

4. Review audit logs for unauthorized usage
