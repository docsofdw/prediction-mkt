export const validationConfig = {
  dbPath: process.env.VALIDATION_DB_PATH || "backtests/validation.db",
  executionHaircut: Number(process.env.EXECUTION_HAIRCUT || "0.40"),
  validationWindowDays: Number(process.env.VALIDATION_WINDOW_DAYS || "14"),
  phase1: {
    scanIntervalMs: Number(process.env.PHASE1_SCAN_INTERVAL_MS || String(5 * 60 * 1000)),
    minArbEdge: Number(process.env.BTC_SCAN_MIN_EDGE || "0.01"),
    structuralThreshold: Number(process.env.BTC_SCAN_STRUCTURAL_THRESHOLD || "0.04"),
    slippageBuffer: Number(process.env.BTC_SCAN_SLIPPAGE_BUFFER || "0.005"),
    maxEvents: Number(process.env.BTC_SCAN_MAX_EVENTS || "150"),
    maxMarkets: Number(process.env.BTC_SCAN_MAX_MARKETS || "160"),
    pass: {
      netRevenuePerWeek: Number(process.env.PHASE1_PASS_NET_REVENUE_PER_WEEK || "75"),
      medianViolationsPerDay: Number(process.env.PHASE1_PASS_MEDIAN_VIOLATIONS_PER_DAY || "2"),
      avgDurationSeconds: Number(process.env.PHASE1_PASS_AVG_DURATION_SECONDS || "30"),
    },
    kill: {
      netRevenuePerWeek: Number(process.env.PHASE1_KILL_NET_REVENUE_PER_WEEK || "25"),
      medianViolationsPerDay: Number(process.env.PHASE1_KILL_MEDIAN_VIOLATIONS_PER_DAY || "1"),
      avgDurationSeconds: Number(process.env.PHASE1_KILL_AVG_DURATION_SECONDS || "10"),
    },
  },
};

export type ValidationVerdict = "PASS" | "KILL" | "INCONCLUSIVE";
