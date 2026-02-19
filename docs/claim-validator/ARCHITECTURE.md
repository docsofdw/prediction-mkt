# Claim Validator Architecture

## System Overview

```
┌─────────────────────────────────────────────────────────────────┐
│                        TELEGRAM BOT                              │
│  src/telegram-bot/index.ts                                       │
│  • Receives messages (X URLs, text claims)                       │
│  • Enforces user allowlist                                       │
│  • Routes to ClaimValidator                                      │
│  • Sends triage reports back                                     │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                      CLAIM VALIDATOR                             │
│  src/claim-validator/index.ts                                    │
│  • Orchestrates the validation pipeline                          │
│  • Aggregates scores from all services                           │
│  • Determines final verdict                                      │
└─────────────────────────────────────────────────────────────────┘
                              │
        ┌─────────────────────┼─────────────────────┐
        ▼                     ▼                     ▼
┌───────────────┐   ┌─────────────────┐   ┌─────────────────┐
│ SECURITY      │   │ CLAIM PARSER    │   │ BTC MAPPER      │
│ security.ts   │   │ claim-parser.ts │   │ btc-mapper.ts   │
│ • Injection   │   │ • Claude API    │   │ • Strategy      │
│   detection   │   │ • Extracts:     │   │   families      │
│ • Audit log   │   │   - market      │   │ • Confidence    │
│ • Allowlist   │   │   - strategy    │   │   scoring       │
└───────────────┘   │   - metrics     │   └─────────────────┘
                    │   - timeframe   │
                    └─────────────────┘
                              │
        ┌─────────────────────┼─────────────────────┐
        ▼                     ▼                     ▼
┌───────────────┐   ┌─────────────────┐   ┌─────────────────┐
│ GENERAL       │   │ CORRELATION     │   │ TRIAGE          │
│ VALIDATOR     │   │ ANALYZER        │   │ REPORTER        │
│ general-      │   │ correlation-    │   │ triage-         │
│ validator.ts  │   │ analyzer.ts     │   │ reporter.ts     │
│ • Non-BTC     │   │ • Diversify     │   │ • Final verdict │
│   claims      │   │   potential     │   │ • Telegram msg  │
│ • Heuristics  │   │ • Portfolio fit │   │ • Formatting    │
└───────────────┘   └─────────────────┘   └─────────────────┘
```

## Data Flow

### 1. Message Reception
```typescript
// Telegram bot receives message
bot.on("message", async (msg) => {
  // Check authorization
  if (!isAuthorized(msg.from?.id)) return;

  // Detect claim type
  const isXUrl = /https?:\/\/(twitter\.com|x\.com)\//.test(text);
  const isTradingClaim = /\b(edge|strategy|momentum|...)\b/i.test(text);

  if (isXUrl || isTradingClaim) {
    await processClaim(msg.chat.id, text, msg.from?.username);
  }
});
```

### 2. Validation Pipeline
```typescript
// ClaimValidator.validate()
async validate(input: ValidationInput): Promise<TriageReport> {
  // 1. Security check
  const securityResult = this.security.checkForInjection(input.source);
  if (securityResult.blocked) {
    return this.createBlockedReport(securityResult);
  }

  // 2. Parse claim using Claude
  const claim = await this.parser.parse(input.source);

  // 3. Map to BTC strategies (if applicable)
  const btcMapping = this.btcMapper.map(claim);

  // 4. Validate general claim quality
  const validation = this.generalValidator.validate(claim);

  // 5. Analyze correlation/diversification
  const correlation = this.correlationAnalyzer.analyze(claim);

  // 6. Generate triage report
  return this.reporter.generateReport({
    claim,
    btcMapping,
    validation,
    correlation,
    securityResult,
  });
}
```

### 3. Scoring System

Each claim receives scores (0-10) across five dimensions:

| Dimension | Weight | Description |
|-----------|--------|-------------|
| Legitimacy | 25% | Does the claim seem credible? |
| Applicability | 25% | Does it map to existing strategies? |
| Uncorrelation | 20% | Does it diversify the portfolio? |
| Feasibility | 15% | Can we backtest/implement this? |
| Urgency | 15% | Is this time-sensitive? |

### 4. Verdict Determination

```typescript
function determineVerdict(scores: Scores, btcMapping: BTCMapping): TriageVerdict {
  // Security blocked takes priority
  if (securityBlocked) return "security_blocked";

  // High overall score
  if (scores.overall >= 8) return "high_priority";

  // Maps to existing strategy with high confidence
  if (btcMapping.confidence > 0.8) return "already_covered";

  // Maps to existing strategy, needs testing
  if (btcMapping.confidence > 0.5) return "test_further";

  // Decent score, worth exploring
  if (scores.overall >= 6) return "explore";

  return "ignore";
}
```

## Module Details

### ClaimParser (`claim-parser.ts`)

Uses Claude API to extract structured data from raw claim text:

```typescript
interface ExtractedClaim {
  rawText: string;
  marketType: "btc" | "crypto" | "sports" | "politics" | "other";
  strategy: string;
  metrics: {
    returnClaim?: string;
    winRate?: string;
    sharpe?: string;
    drawdown?: string;
    timeframe?: string;
  };
  warnings: string[];
  confidence: number;
}
```

### BTCMapper (`btc-mapper.ts`)

Maps claims to existing BTC strategy families:

| Family | Signals | Example Strategies |
|--------|---------|-------------------|
| momentum | EMA crossover, RSI, MACD | Trend following |
| breakout | Support/resistance, volume | Range breakout |
| regime-trend | Funding rate, open interest | Sentiment-based |

### SecurityService (`security.ts`)

Detects prompt injection attempts using pattern matching:

```typescript
const INJECTION_PATTERNS = [
  { pattern: /ignore\s+(previous|all|your)\s+(instructions?|rules?)/i, severity: "high" },
  { pattern: /disregard\s+(previous|all)/i, severity: "high" },
  { pattern: /you\s+are\s+now\s+a/i, severity: "high" },
  { pattern: /system\s*:\s*/i, severity: "medium" },
  { pattern: /\[INST\]/i, severity: "high" },
  // ... 15+ patterns total
];
```

### SourceCredibility

Tracks credibility of claim sources over time:

```typescript
interface SourceCredibility {
  sourceId: string;           // Twitter handle, etc.
  totalClaims: number;
  verifiedEdges: number;      // Claims that proved profitable
  falseEdges: number;         // Claims that failed
  credibilityScore: number;   // 0-1, updated over time
}
```

## Configuration Files

### `config/telegram-allowlist.json`
```json
{
  "allowedUsers": ["1262476386"],
  "updatedAt": "2026-02-18T00:00:00.000Z",
  "notes": {
    "1262476386": "Duke Waldrop - Primary operator"
  }
}
```

### `config/audit-log.jsonl`
JSON Lines format, one event per line:
```json
{"timestamp":"2026-02-18T12:00:00Z","eventType":"claim_validated","metadata":{...}}
{"timestamp":"2026-02-18T12:01:00Z","eventType":"security_flag","metadata":{...}}
```
