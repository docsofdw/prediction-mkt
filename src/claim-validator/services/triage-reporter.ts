import crypto from "crypto";
import {
  ParsedClaim,
  BTCMappingResult,
  GeneralValidationResult,
  CorrelationResult,
  TriageReport,
  TriageVerdict,
} from "../types";

interface ScoreWeights {
  legitimacy: number;
  applicability: number;
  uncorrelation: number;
  feasibility: number;
  urgency: number;
}

const DEFAULT_WEIGHTS: ScoreWeights = {
  legitimacy: 0.3,
  applicability: 0.25,
  uncorrelation: 0.2,
  feasibility: 0.15,
  urgency: 0.1,
};

export class TriageReporter {
  private weights: ScoreWeights;

  constructor(weights?: Partial<ScoreWeights>) {
    this.weights = { ...DEFAULT_WEIGHTS, ...weights };
  }

  /**
   * Generate the final triage report
   */
  generate(params: {
    claim: ParsedClaim;
    btcMapping?: BTCMappingResult;
    generalValidation?: GeneralValidationResult;
    correlation?: CorrelationResult;
  }): TriageReport {
    const { claim, btcMapping, generalValidation, correlation } = params;

    // Check for security blocks first
    if (claim.securityFlags.some(f => f.severity === "high")) {
      return this.generateSecurityBlockedReport(claim);
    }

    // Compute individual scores
    const scores = this.computeScores(claim, btcMapping, generalValidation, correlation);

    // Determine verdict
    const verdict = this.determineVerdict(claim, btcMapping, scores);

    // Generate reasoning
    const reasoning = this.generateReasoning(claim, btcMapping, generalValidation, correlation, verdict);

    // Generate next steps
    const nextSteps = this.generateNextSteps(verdict, claim, btcMapping, generalValidation);

    // Generate summary
    const summary = this.generateSummary(claim, verdict, scores);

    // Generate Telegram message
    const telegramMessage = this.formatForTelegram(claim, verdict, scores, summary, nextSteps, btcMapping, generalValidation);

    return {
      id: crypto.randomUUID(),
      generatedAt: new Date(),
      claim,
      verdict,
      confidence: this.computeConfidence(claim, btcMapping, generalValidation),
      scores,
      btcMapping,
      generalValidation,
      correlation,
      summary,
      nextSteps,
      reasoning,
      telegramMessage,
    };
  }

  /**
   * Generate report for security-blocked claims
   */
  private generateSecurityBlockedReport(claim: ParsedClaim): TriageReport {
    const highFlags = claim.securityFlags.filter(f => f.severity === "high");

    return {
      id: crypto.randomUUID(),
      generatedAt: new Date(),
      claim,
      verdict: "security_blocked",
      confidence: 1.0,
      scores: {
        legitimacy: 0,
        applicability: 0,
        uncorrelation: 0,
        feasibility: 0,
        urgency: 0,
        overall: 0,
      },
      summary: "Content blocked due to security concerns",
      nextSteps: [
        "Review the original content for malicious patterns",
        "Do not process this claim further",
      ],
      reasoning: `Security flags triggered: ${highFlags.map(f => f.description).join(", ")}`,
      telegramMessage: this.formatSecurityBlockForTelegram(claim, highFlags),
    };
  }

  /**
   * Compute all individual scores
   */
  private computeScores(
    claim: ParsedClaim,
    btcMapping?: BTCMappingResult,
    generalValidation?: GeneralValidationResult,
    correlation?: CorrelationResult
  ): TriageReport["scores"] {
    // Legitimacy score
    let legitimacy = generalValidation?.legitimacyScore ?? 5;
    if (claim.parseConfidence > 0.7) legitimacy = Math.min(10, legitimacy + 1);
    if (claim.parseConfidence < 0.3) legitimacy = Math.max(1, legitimacy - 1);

    // Applicability score - how well does this fit your system?
    let applicability = 5;
    if (btcMapping?.mapsToExisting) {
      applicability = 8;
      if (btcMapping.backtestResult?.sharpe && btcMapping.backtestResult.sharpe > 0.5) {
        applicability = 9;
      }
    } else if (claim.marketType === "btc" || claim.marketType === "crypto") {
      applicability = 6; // BTC but doesn't map to existing
    } else if (claim.marketType === "weather") {
      applicability = 7; // You have weather strategies
    } else {
      applicability = 4; // New market type
    }

    // Uncorrelation score
    const uncorrelation = correlation?.diversificationScore ?? 5;

    // Feasibility score - can you actually trade this?
    let feasibility = 5;
    if (generalValidation?.marketDiscovery.found) {
      feasibility = 7;
      const topVolume = generalValidation.marketDiscovery.markets?.[0]?.volume ?? 0;
      if (topVolume > 100_000) feasibility = 9;
      else if (topVolume > 10_000) feasibility = 8;
    }
    if (generalValidation?.dataAvailability.hasHistoricalData) {
      feasibility = Math.min(10, feasibility + 1);
    }

    // Urgency score - time-sensitive?
    let urgency = 5;
    if (claim.marketIdentifiers?.expirations?.length) {
      urgency = 7;
    }
    if (claim.strategyType === "arbitrage" || claim.edgeSource === "structural") {
      urgency = 8;
    }

    // Compute weighted overall
    const overall =
      legitimacy * this.weights.legitimacy +
      applicability * this.weights.applicability +
      uncorrelation * this.weights.uncorrelation +
      feasibility * this.weights.feasibility +
      urgency * this.weights.urgency;

    return {
      legitimacy: Math.round(legitimacy * 10) / 10,
      applicability: Math.round(applicability * 10) / 10,
      uncorrelation: Math.round(uncorrelation * 10) / 10,
      feasibility: Math.round(feasibility * 10) / 10,
      urgency: Math.round(urgency * 10) / 10,
      overall: Math.round(overall * 10) / 10,
    };
  }

  /**
   * Determine the triage verdict
   */
  private determineVerdict(
    claim: ParsedClaim,
    btcMapping?: BTCMappingResult,
    scores?: TriageReport["scores"]
  ): TriageVerdict {
    const overall = scores?.overall ?? 5;

    // Check if already covered
    if (btcMapping?.mapsToExisting && btcMapping.comparisonToExisting?.verdict === "underperforms") {
      return "already_covered";
    }

    // High priority if it outperforms existing
    if (btcMapping?.mapsToExisting && btcMapping.comparisonToExisting?.verdict === "outperforms") {
      return "high_priority";
    }

    // Score-based verdicts
    if (overall >= 7.5) return "high_priority";
    if (overall >= 6) return "explore";
    if (overall >= 4.5) return "test_further";
    return "ignore";
  }

  /**
   * Compute confidence in the verdict
   */
  private computeConfidence(
    claim: ParsedClaim,
    btcMapping?: BTCMappingResult,
    generalValidation?: GeneralValidationResult
  ): number {
    let confidence = claim.parseConfidence;

    // More data = more confidence
    if (btcMapping?.backtestResult) {
      confidence = Math.min(1, confidence + 0.2);
    }
    if (generalValidation?.quickBacktest) {
      confidence = Math.min(1, confidence + 0.15);
    }
    if (generalValidation?.marketDiscovery.found) {
      confidence = Math.min(1, confidence + 0.1);
    }

    // Warnings reduce confidence
    confidence -= claim.warnings.length * 0.05;

    return Math.max(0, Math.min(1, Math.round(confidence * 100) / 100));
  }

  /**
   * Generate reasoning for the verdict
   */
  private generateReasoning(
    claim: ParsedClaim,
    btcMapping?: BTCMappingResult,
    generalValidation?: GeneralValidationResult,
    correlation?: CorrelationResult,
    verdict?: TriageVerdict
  ): string {
    const parts: string[] = [];

    parts.push(`Claim type: ${claim.marketType} / ${claim.strategyType}`);

    if (btcMapping?.mapsToExisting) {
      parts.push(`Maps to existing ${btcMapping.strategyFamily} strategy`);
      if (btcMapping.comparisonToExisting) {
        parts.push(`Comparison: ${btcMapping.comparisonToExisting.verdict} (claim Sharpe: ${btcMapping.comparisonToExisting.claimSharpe.toFixed(2)}, existing best: ${btcMapping.comparisonToExisting.existingBestSharpe.toFixed(2)})`);
      }
    }

    if (generalValidation) {
      parts.push(`Legitimacy: ${generalValidation.legitimacyScore}/10`);
      if (generalValidation.marketDiscovery.found) {
        parts.push(`Found ${generalValidation.marketDiscovery.markets?.length} matching markets`);
      }
    }

    if (correlation?.isUncorrelated) {
      parts.push(`Uncorrelated with existing strategies - diversification opportunity`);
    }

    parts.push(`Verdict: ${verdict}`);

    return parts.join(". ") + ".";
  }

  /**
   * Generate next steps based on verdict
   */
  private generateNextSteps(
    verdict: TriageVerdict,
    claim: ParsedClaim,
    btcMapping?: BTCMappingResult,
    generalValidation?: GeneralValidationResult
  ): string[] {
    const steps: string[] = [];

    switch (verdict) {
      case "high_priority":
        steps.push("Run full walk-forward backtest with the extracted parameters");
        steps.push("Review the original claim source for additional context");
        if (btcMapping?.mapsToExisting) {
          steps.push(`Update ${btcMapping.strategyFamily} strategy family with new parameters`);
        } else {
          steps.push("Consider implementing new strategy based on this approach");
        }
        steps.push("Set up monitoring for this market/strategy");
        break;

      case "explore":
        steps.push("Manually review the claim and verify extracted parameters");
        if (!generalValidation?.dataAvailability.hasHistoricalData) {
          steps.push("Collect historical data for backtesting");
        }
        steps.push("Run preliminary backtest when data available");
        steps.push("Track this claim source for future signals");
        break;

      case "test_further":
        steps.push("Gather more data before making a decision");
        if (generalValidation?.logicalCoherence.issues.length) {
          steps.push("Address identified issues: " + generalValidation.logicalCoherence.issues.slice(0, 2).join(", "));
        }
        steps.push("Re-evaluate when more market data is available");
        break;

      case "already_covered":
        steps.push("No action needed - your existing strategies handle this");
        steps.push("Consider if the claim source has novel insights worth following");
        break;

      case "ignore":
        steps.push("No further action recommended");
        if (claim.warnings.length) {
          steps.push("Red flags: " + claim.warnings.slice(0, 2).join(", "));
        }
        break;

      case "security_blocked":
        steps.push("Do not process this claim");
        steps.push("Review for potential attack patterns");
        break;
    }

    return steps;
  }

  /**
   * Generate human-readable summary
   */
  private generateSummary(
    claim: ParsedClaim,
    verdict: TriageVerdict,
    scores: TriageReport["scores"]
  ): string {
    const verdictEmoji: Record<TriageVerdict, string> = {
      high_priority: "🔥",
      explore: "🔍",
      test_further: "📊",
      already_covered: "✅",
      ignore: "⏭️",
      security_blocked: "🚫",
    };

    const verdictText: Record<TriageVerdict, string> = {
      high_priority: "High Priority - Act Soon",
      explore: "Worth Exploring",
      test_further: "Needs More Data",
      already_covered: "Already Covered",
      ignore: "Skip",
      security_blocked: "Blocked - Security Risk",
    };

    const summaryText = claim.summary.length > 100
      ? claim.summary.slice(0, 100) + "..."
      : claim.summary;

    return `${verdictEmoji[verdict]} ${verdictText[verdict]} | Overall: ${scores.overall}/10 | ${summaryText}`;
  }

  /**
   * Format report for Telegram - clean, actionable, no truncation
   */
  private formatForTelegram(
    claim: ParsedClaim,
    verdict: TriageVerdict,
    scores: TriageReport["scores"],
    summary: string,
    nextSteps: string[],
    btcMapping?: BTCMappingResult,
    generalValidation?: GeneralValidationResult
  ): string {
    const lines: string[] = [];

    // Verdict header - clean and prominent
    const verdictEmoji: Record<TriageVerdict, string> = {
      high_priority: "🔥",
      explore: "🔍",
      test_further: "📊",
      already_covered: "✅",
      ignore: "⏭️",
      security_blocked: "🚫",
    };

    lines.push(`${verdictEmoji[verdict]} **${this.getVerdictText(verdict)}** · ${scores.overall}/10`);
    lines.push(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
    lines.push(``);

    // THE CLAIM - full text, no truncation
    lines.push(`📝 **THE CLAIM**`);
    lines.push(claim.summary || "No summary available");
    lines.push(``);

    // CLAIMED METRICS - if available
    if (claim.claimedEdge) {
      const metrics: string[] = [];
      if (claim.claimedEdge.sharpeRatio) {
        metrics.push(`Sharpe: ${claim.claimedEdge.sharpeRatio}`);
      }
      if (claim.claimedEdge.winRate && claim.claimedEdge.winRate <= 1) {
        metrics.push(`Win Rate: ${(claim.claimedEdge.winRate * 100).toFixed(0)}%`);
      }
      if (claim.claimedEdge.returnPercent) {
        metrics.push(`Return: ${claim.claimedEdge.returnPercent}%`);
      }
      if (metrics.length > 0) {
        lines.push(`📈 **CLAIMED METRICS**`);
        lines.push(metrics.join(" · "));
        lines.push(``);
      }
    }

    // TESTABLE PARAMETERS - the actionable stuff
    const params = claim.parameters;
    const hasTestableParams =
      (params.indicators?.length ?? 0) > 0 ||
      (params.windows?.length ?? 0) > 0 ||
      (params.thresholds?.length ?? 0) > 0 ||
      (params.entryConditions?.length ?? 0) > 0 ||
      (params.exitConditions?.length ?? 0) > 0;

    if (hasTestableParams) {
      lines.push(`⚙️ **TESTABLE PARAMETERS**`);
      if (params.indicators?.length) {
        lines.push(`• Indicators: ${params.indicators.join(", ")}`);
      }
      if (params.windows?.length) {
        lines.push(`• Windows: ${params.windows.join(", ")}`);
      }
      if (params.thresholds?.length) {
        lines.push(`• Thresholds: ${params.thresholds.join(", ")}`);
      }
      if (params.timeframes?.length) {
        lines.push(`• Timeframe: ${params.timeframes.join(", ")}`);
      }
      if (params.entryConditions?.length) {
        lines.push(`• Entry: ${params.entryConditions.join(" | ")}`);
      }
      if (params.exitConditions?.length) {
        lines.push(`• Exit: ${params.exitConditions.join(" | ")}`);
      }
      lines.push(``);
    }

    // BTC MAPPING - if it maps to existing strategies
    if (btcMapping?.mapsToExisting) {
      lines.push(`🎯 **MAPS TO EXISTING STRATEGY**`);
      lines.push(`• Family: ${btcMapping.strategyFamily}`);
      if (btcMapping.comparisonToExisting) {
        const comp = btcMapping.comparisonToExisting;
        lines.push(`• Comparison: ${comp.verdict}`);
        lines.push(`• Claim Sharpe: ${comp.claimSharpe.toFixed(2)} vs Your Best: ${comp.existingBestSharpe.toFixed(2)}`);
      }
      lines.push(``);
    }

    // SCORES - compact format
    lines.push(`📊 **SCORES:** Legitimacy ${scores.legitimacy}/10 · Applicability ${scores.applicability}/10 · Feasibility ${scores.feasibility}/10`);
    lines.push(``);

    // HOW TO VALIDATE - detailed, actionable steps
    lines.push(`🔬 **HOW TO VALIDATE**`);
    const actionSteps = this.generateActionableSteps(claim, btcMapping, generalValidation);
    actionSteps.forEach((step, i) => {
      lines.push(`${i + 1}. ${step}`);
    });
    lines.push(``);

    // WARNINGS - compact
    if (claim.warnings.length > 0) {
      lines.push(`⚠️ **WATCH OUT FOR**`);
      claim.warnings.forEach(w => {
        lines.push(`• ${w}`);
      });
    }

    return lines.join("\n");
  }

  /**
   * Generate specific, actionable validation steps
   */
  private generateActionableSteps(
    claim: ParsedClaim,
    btcMapping?: BTCMappingResult,
    generalValidation?: GeneralValidationResult
  ): string[] {
    const steps: string[] = [];
    const params = claim.parameters;

    // Step 1: Data source
    if (claim.marketType === "btc" || claim.marketType === "crypto") {
      const timeframe = params.timeframes?.[0] || "1h";
      steps.push(`DATA: Run "npm run becker:download" or pull BTC from Binance (${timeframe})`);
    } else if (generalValidation?.marketDiscovery.found && generalValidation.marketDiscovery.markets?.length) {
      steps.push(`DATA: Run "npm run discover -- ${claim.marketIdentifiers?.keywords?.[0] || claim.marketType}"`);
    } else {
      steps.push(`DATA: Run "npm run discover -- ${claim.marketType}" to find markets`);
    }

    // Step 2: Implement strategy
    if (btcMapping?.mapsToExisting && btcMapping.strategyFamily) {
      steps.push(`CODE: Update src/markets/btc/strategies/bitcoin-${btcMapping.strategyFamily}.ts with new params`);
    } else if (params.indicators?.length) {
      steps.push(`CODE: Implement ${params.indicators.join("/")} in src/strategies/backtest/`);
    } else if (params.entryConditions?.length) {
      const shortEntry = params.entryConditions[0].length > 50
        ? params.entryConditions[0].slice(0, 50) + "..."
        : params.entryConditions[0];
      steps.push(`CODE: Implement "${shortEntry}" as entry rule`);
    } else {
      steps.push(`CODE: Extract entry/exit rules from original post and implement`);
    }

    // Step 3: Backtest
    if (claim.claimedEdge?.sharpeRatio) {
      const targetSharpe = Math.max(0.5, claim.claimedEdge.sharpeRatio * 0.6).toFixed(1);
      steps.push(`TEST: Run "npm run backtest" → target Sharpe ≥ ${targetSharpe} (60% of claimed)`);
    } else if (claim.claimedEdge?.winRate && claim.claimedEdge.winRate <= 1) {
      const targetWR = Math.round(claim.claimedEdge.winRate * 100 * 0.7);
      steps.push(`TEST: Run "npm run backtest" → target win rate ≥ ${targetWR}%`);
    } else {
      steps.push(`TEST: Run "npm run backtest" → look for Sharpe > 0.5`);
    }

    // Step 4: Validate/Deploy
    steps.push(`DEPLOY: Paper trade 5-7 days with "EXECUTION_MODE=paper npm run dev"`);

    return steps;
  }

  private getVerdictText(verdict: TriageVerdict): string {
    const map: Record<TriageVerdict, string> = {
      high_priority: "HIGH PRIORITY",
      explore: "WORTH EXPLORING",
      test_further: "NEEDS MORE DATA",
      already_covered: "ALREADY COVERED",
      ignore: "SKIP",
      security_blocked: "BLOCKED",
    };
    return map[verdict];
  }

  /**
   * Format security block for Telegram
   */
  private formatSecurityBlockForTelegram(
    claim: ParsedClaim,
    flags: Array<{ description: string; matchedPattern?: string }>
  ): string {
    const lines: string[] = [];

    lines.push(`🚫 **Security Block**`);
    lines.push(``);
    lines.push(`This claim has been blocked due to security concerns.`);
    lines.push(``);
    lines.push(`**Detected Issues:**`);
    flags.slice(0, 3).forEach(f => {
      lines.push(`• ${f.description}`);
      if (f.matchedPattern) {
        lines.push(`  Pattern: "${f.matchedPattern}"`);
      }
    });
    lines.push(``);
    lines.push(`**Action:** Do not process. Review source.`);

    return lines.join("\n");
  }
}
