// ─── Input Types ─────────────────────────────────────────

export interface ClaimInput {
  /** Raw URL or text content from X post */
  source: string;
  /** Optional: pre-fetched content if URL was resolved */
  content?: string;
  /** Timestamp when claim was received */
  receivedAt: Date;
  /** Source identifier (e.g., X handle, telegram user id) */
  sourceId?: string;
}

// ─── Parsed Claim Structure ──────────────────────────────

export type MarketType =
  | "btc"
  | "crypto"
  | "weather"
  | "elections"
  | "sports"
  | "economics"
  | "events"
  | "unknown";

export type StrategyType =
  | "momentum"
  | "mean-reversion"
  | "breakout"
  | "arbitrage"
  | "structural"
  | "information"
  | "sentiment"
  | "unknown";

export type EdgeSource =
  | "structural"      // Market structure inefficiency
  | "informational"   // Information asymmetry
  | "behavioral"      // Crowd behavior exploitation
  | "technical"       // Technical indicator based
  | "fundamental"     // Underlying asset analysis
  | "unknown";

export interface ExtractedParameters {
  /** Window/lookback periods mentioned */
  windows?: number[];
  /** Price levels, thresholds, strikes */
  thresholds?: number[];
  /** Z-scores, percentages, ratios */
  ratios?: number[];
  /** Timeframes mentioned (e.g., "5 minutes", "1 hour") */
  timeframes?: string[];
  /** Specific indicators mentioned (MA, RSI, ADX, etc.) */
  indicators?: string[];
  /** Entry/exit conditions described */
  entryConditions?: string[];
  exitConditions?: string[];
}

export interface ParsedClaim {
  /** Unique ID for tracking */
  id: string;
  /** Original input */
  input: ClaimInput;
  /** Confidence in extraction (0-1) */
  parseConfidence: number;

  /** Core claim classification */
  marketType: MarketType;
  strategyType: StrategyType;
  edgeSource: EdgeSource;

  /** What the claim actually says */
  summary: string;
  /** Extracted trading parameters */
  parameters: ExtractedParameters;

  /** Specific market identifiers if mentioned */
  marketIdentifiers?: {
    keywords?: string[];
    strikes?: number[];
    expirations?: string[];
    specificMarkets?: string[];  // e.g., "BTC > $100k by March"
  };

  /** The claimed edge/return */
  claimedEdge?: {
    returnPercent?: number;
    sharpeRatio?: number;
    winRate?: number;
    description: string;
  };

  /** Parsing warnings/issues */
  warnings: string[];

  /** Security flags */
  securityFlags: SecurityFlag[];
}

// ─── Security Types ──────────────────────────────────────

export interface SecurityFlag {
  type: "prompt_injection" | "suspicious_pattern" | "external_url" | "data_request";
  severity: "low" | "medium" | "high";
  description: string;
  matchedPattern?: string;
}

// ─── Validation Results ──────────────────────────────────

export interface BTCMappingResult {
  /** Does this map to existing BTC strategies? */
  mapsToExisting: boolean;
  /** Which strategy family it maps to */
  strategyFamily?: "momentum" | "breakout" | "regime-trend";
  /** Extracted parameters that could be tested */
  testableParams?: Record<string, unknown>;
  /** If tested, the backtest results */
  backtestResult?: {
    sharpe: number;
    sortino: number;
    maxDrawdown: number;
    winRate: number;
    totalPnl: number;
    tradeCount: number;
  };
  /** Comparison to your existing best strategies */
  comparisonToExisting?: {
    existingBestSharpe: number;
    claimSharpe: number;
    verdict: "outperforms" | "underperforms" | "comparable";
  };
  /** Reasoning */
  analysis: string;
}

export interface GeneralValidationResult {
  /** Overall legitimacy score (1-10) */
  legitimacyScore: number;

  /** Logical coherence check */
  logicalCoherence: {
    score: number;  // 1-10
    issues: string[];
    strengths: string[];
  };

  /** Market existence check */
  marketDiscovery: {
    found: boolean;
    markets?: Array<{
      question: string;
      tokenId: string;
      volume: number;
      liquidity: number;
      spread: number;
    }>;
    searchTermsUsed: string[];
  };

  /** Data availability for testing */
  dataAvailability: {
    hasHistoricalData: boolean;
    barCount?: number;
    oldestBar?: Date;
    newestBar?: Date;
  };

  /** Quick validation results if data available */
  quickBacktest?: {
    sharpe: number;
    winRate: number;
    totalPnl: number;
    tradeCount: number;
    confidence: "low" | "medium" | "high";
  };

  /** Reasoning */
  analysis: string;
}

export interface CorrelationResult {
  /** Correlation to your BTC strategy returns */
  btcCorrelation: number;
  /** Correlation to weather strategy returns */
  weatherCorrelation: number;
  /** Is this meaningfully uncorrelated? */
  isUncorrelated: boolean;  // |correlation| < 0.3
  /** Diversification benefit score */
  diversificationScore: number;  // 0-10
  /** Analysis */
  analysis: string;
}

// ─── Final Triage Report ─────────────────────────────────

export type TriageVerdict =
  | "explore"           // Worth deeper research
  | "ignore"            // Low quality / not actionable
  | "already_covered"   // Your existing strategies handle this
  | "test_further"      // Promising but needs more data
  | "high_priority"     // Strong signal, act soon
  | "security_blocked"; // Blocked due to security concerns

export interface TriageReport {
  /** Unique report ID */
  id: string;
  /** Timestamp */
  generatedAt: Date;
  /** The parsed claim */
  claim: ParsedClaim;

  /** Final verdict */
  verdict: TriageVerdict;
  /** Confidence in verdict (0-1) */
  confidence: number;

  /** Scores breakdown */
  scores: {
    legitimacy: number;       // 1-10
    applicability: number;    // 1-10 (how well it fits your system)
    uncorrelation: number;    // 1-10 (diversification value)
    feasibility: number;      // 1-10 (can you actually trade this?)
    urgency: number;          // 1-10 (time-sensitive?)
    overall: number;          // Weighted composite
  };

  /** Component results */
  btcMapping?: BTCMappingResult;
  generalValidation?: GeneralValidationResult;
  correlation?: CorrelationResult;

  /** Human-readable summary */
  summary: string;
  /** Suggested next steps */
  nextSteps: string[];
  /** Why this verdict */
  reasoning: string;

  /** For Telegram formatting */
  telegramMessage: string;
}

// ─── Credibility Tracking ────────────────────────────────

export interface SourceCredibility {
  sourceId: string;
  totalClaims: number;
  verifiedEdges: number;
  falseEdges: number;
  averageLegitimacyScore: number;
  lastClaimAt: Date;
  credibilityScore: number;  // Computed from history
}

// ─── Audit Log Types ─────────────────────────────────────

export interface AuditLogEntry {
  timestamp: Date;
  eventType: "claim_received" | "claim_parsed" | "validation_complete" | "security_flag" | "error";
  claimId?: string;
  sourceId?: string;
  verdict?: TriageVerdict;
  securityFlags?: SecurityFlag[];
  metadata?: Record<string, unknown>;
}
