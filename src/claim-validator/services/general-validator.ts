import { ParsedClaim, GeneralValidationResult } from "../types";
import { MarketDiscovery } from "../../shared/services/market-discovery";
import { HistoricalPrices } from "../../shared/services/historical-prices";
import { loadConfig } from "../../shared/utils/config";
import { log } from "../../shared/utils/logger";
import { GammaEvent } from "../../types";

export class GeneralValidator {
  private marketDiscovery: MarketDiscovery;
  private historicalPrices: HistoricalPrices;

  constructor() {
    const config = loadConfig();
    this.marketDiscovery = new MarketDiscovery(config.gammaHost);
    this.historicalPrices = new HistoricalPrices(config.clobHost);
  }

  /**
   * Validate a non-BTC claim
   */
  async validate(claim: ParsedClaim): Promise<GeneralValidationResult> {
    log.info(`[GeneralValidator] Validating claim: ${claim.marketType} / ${claim.strategyType}`);

    // Step 1: Logical coherence check
    const logicalCoherence = this.checkLogicalCoherence(claim);

    // Step 2: Market discovery
    const marketDiscovery = await this.discoverMarkets(claim);

    // Step 3: Data availability
    const dataAvailability = await this.checkDataAvailability(marketDiscovery.markets);

    // Step 4: Quick backtest if possible
    const quickBacktest = await this.runQuickBacktest(claim, marketDiscovery.markets, dataAvailability);

    // Compute overall legitimacy score
    const legitimacyScore = this.computeLegitimacyScore(
      claim,
      logicalCoherence,
      marketDiscovery,
      dataAvailability,
      quickBacktest
    );

    return {
      legitimacyScore,
      logicalCoherence,
      marketDiscovery,
      dataAvailability,
      quickBacktest,
      analysis: this.generateAnalysis(claim, legitimacyScore, logicalCoherence, marketDiscovery),
    };
  }

  /**
   * Check if the claim is logically coherent
   */
  private checkLogicalCoherence(claim: ParsedClaim): GeneralValidationResult["logicalCoherence"] {
    const issues: string[] = [];
    const strengths: string[] = [];
    let score = 5; // Start neutral

    // Check parse confidence
    if (claim.parseConfidence < 0.3) {
      issues.push("Low parse confidence - claim may be vague or unclear");
      score -= 2;
    } else if (claim.parseConfidence > 0.7) {
      strengths.push("Clear, well-structured claim");
      score += 1;
    }

    // Check if there are actual parameters
    const hasParams = (claim.parameters.windows?.length ?? 0) > 0 ||
      (claim.parameters.thresholds?.length ?? 0) > 0 ||
      (claim.parameters.indicators?.length ?? 0) > 0;

    if (!hasParams) {
      issues.push("No specific parameters mentioned - hard to test");
      score -= 1;
    } else {
      strengths.push("Contains testable parameters");
      score += 1;
    }

    // Check for entry/exit conditions
    if ((claim.parameters.entryConditions?.length ?? 0) > 0 && (claim.parameters.exitConditions?.length ?? 0) > 0) {
      strengths.push("Defines both entry and exit conditions");
      score += 1;
    } else if ((claim.parameters.entryConditions?.length ?? 0) === 0) {
      issues.push("No clear entry conditions");
      score -= 1;
    }

    // Check edge source
    if (claim.edgeSource === "unknown") {
      issues.push("Source of edge unclear");
      score -= 1;
    } else {
      strengths.push(`Edge source identified: ${claim.edgeSource}`);
      score += 0.5;
    }

    // Credit for specific metrics (shows rigor)
    if (claim.claimedEdge?.sharpeRatio && claim.claimedEdge.sharpeRatio > 0) {
      strengths.push(`Sharpe ratio provided: ${claim.claimedEdge.sharpeRatio}`);
      score += 0.5;
    }
    if (claim.claimedEdge?.winRate && claim.claimedEdge.winRate > 0) {
      strengths.push(`Win rate provided: ${(claim.claimedEdge.winRate * 100).toFixed(0)}%`);
      score += 0.5;
    }
    if (claim.parameters.timeframes?.length) {
      strengths.push(`Timeframe specified: ${claim.parameters.timeframes.join(", ")}`);
      score += 0.5;
    }

    // Check for red flags (unrealistic claims)
    if (claim.claimedEdge?.returnPercent && claim.claimedEdge.returnPercent > 100) {
      issues.push("Unrealistic return claims (>100%)");
      score -= 2;
    }

    if (claim.claimedEdge?.winRate && claim.claimedEdge.winRate > 0.9) {
      issues.push("Suspiciously high win rate claimed (>90%)");
      score -= 1;
    }

    if (claim.claimedEdge?.sharpeRatio && claim.claimedEdge.sharpeRatio > 5) {
      issues.push("Unrealistic Sharpe ratio claimed (>5)");
      score -= 2;
    }

    // Check warnings from parser (less punitive)
    if (claim.warnings.length > 0) {
      issues.push(...claim.warnings.map(w => `Parser warning: ${w}`));
      score -= Math.min(claim.warnings.length * 0.25, 1); // Cap at -1
    }

    // Check security flags
    if (claim.securityFlags.length > 0) {
      const highSeverity = claim.securityFlags.filter(f => f.severity === "high");
      if (highSeverity.length > 0) {
        issues.push("Security concerns detected in content");
        score -= 2;
      }
    }

    // Clamp score
    score = Math.max(1, Math.min(10, score));

    return { score, issues, strengths };
  }

  /**
   * Search for markets matching the claim
   */
  private async discoverMarkets(claim: ParsedClaim): Promise<GeneralValidationResult["marketDiscovery"]> {
    const searchTerms: string[] = [];

    // Add market identifiers
    if (claim.marketIdentifiers?.keywords) {
      searchTerms.push(...claim.marketIdentifiers.keywords);
    }

    // Add market type keywords
    const marketTypeKeywords: Record<string, string[]> = {
      btc: ["bitcoin", "btc"],
      crypto: ["crypto", "cryptocurrency", "ethereum"],
      weather: ["weather", "temperature", "hurricane", "storm"],
      elections: ["election", "president", "vote", "congress", "senate"],
      sports: ["nfl", "nba", "mlb", "game", "match", "super bowl"],
      economics: ["gdp", "inflation", "fed", "interest rate", "unemployment"],
      events: ["will", "happen"],
    };

    if (claim.marketType in marketTypeKeywords) {
      searchTerms.push(...marketTypeKeywords[claim.marketType]);
    }

    // Search for markets
    const markets: GeneralValidationResult["marketDiscovery"]["markets"] = [];
    const foundEvents: GammaEvent[] = [];
    const uniqueTerms = [...new Set(searchTerms)].slice(0, 5);

    for (const term of uniqueTerms) {
      try {
        const events = await this.marketDiscovery.searchEvents(term, 10);
        foundEvents.push(...events);
      } catch (error) {
        log.debug(`[GeneralValidator] Search failed for "${term}": ${error}`);
        continue;
      }
    }

    // Deduplicate and extract market info
    const seen = new Set<string>();
    for (const event of foundEvents) {
      if (seen.has(event.id)) continue;
      seen.add(event.id);

      const snapshots = this.marketDiscovery.snapshotMarkets(event);
      for (const snapshot of snapshots) {
        if (!snapshot.tokenId) continue;

        markets.push({
          question: snapshot.question,
          tokenId: snapshot.tokenId,
          volume: snapshot.volume,
          liquidity: 0, // Would need orderbook depth
          spread: snapshot.spread,
        });
      }
    }

    // Sort by volume
    markets.sort((a, b) => b.volume - a.volume);

    log.info(`[GeneralValidator] Found ${markets.length} matching markets`);

    return {
      found: markets.length > 0,
      markets: markets.slice(0, 10),
      searchTermsUsed: uniqueTerms,
    };
  }

  /**
   * Check if historical data is available
   */
  private async checkDataAvailability(
    markets?: GeneralValidationResult["marketDiscovery"]["markets"]
  ): Promise<GeneralValidationResult["dataAvailability"]> {
    if (!markets || markets.length === 0) {
      return { hasHistoricalData: false };
    }

    // Try to get data for top market
    const topMarket = markets[0];
    if (!topMarket.tokenId) {
      return { hasHistoricalData: false };
    }

    try {
      const bars = await this.historicalPrices.getBars({
        tokenId: topMarket.tokenId,
        interval: "1w",
        fidelity: 15,
      });

      if (bars.length > 0) {
        return {
          hasHistoricalData: true,
          barCount: bars.length,
          oldestBar: new Date(bars[0].timestamp * 1000),
          newestBar: new Date(bars[bars.length - 1].timestamp * 1000),
        };
      }
    } catch (error) {
      log.debug(`[GeneralValidator] Could not get history: ${error}`);
    }

    return { hasHistoricalData: false };
  }

  /**
   * Run a quick backtest if possible
   */
  private async runQuickBacktest(
    claim: ParsedClaim,
    markets?: GeneralValidationResult["marketDiscovery"]["markets"],
    dataAvailability?: GeneralValidationResult["dataAvailability"]
  ): Promise<GeneralValidationResult["quickBacktest"]> {
    // Skip if no data
    if (!dataAvailability?.hasHistoricalData || !markets?.length) {
      return undefined;
    }

    // TODO: Implement generic strategy builder based on claim parameters
    // For now, return undefined - full implementation would:
    // 1. Build a generic strategy from claim parameters
    // 2. Get historical bars
    // 3. Run backtest
    // 4. Return results

    return undefined;
  }

  /**
   * Compute overall legitimacy score
   */
  private computeLegitimacyScore(
    claim: ParsedClaim,
    coherence: GeneralValidationResult["logicalCoherence"],
    marketDiscovery: GeneralValidationResult["marketDiscovery"],
    dataAvailability: GeneralValidationResult["dataAvailability"],
    quickBacktest?: GeneralValidationResult["quickBacktest"]
  ): number {
    let score = coherence.score; // Start with coherence score

    // Adjust for market discovery
    if (marketDiscovery.found) {
      const topVolume = marketDiscovery.markets?.[0]?.volume ?? 0;
      if (topVolume > 100_000) {
        score += 1.5; // High volume market
      } else if (topVolume > 10_000) {
        score += 0.5; // Moderate volume
      }
    } else {
      score -= 1; // No matching markets found
    }

    // Adjust for data availability
    if (dataAvailability.hasHistoricalData) {
      const bars = dataAvailability.barCount ?? 0;
      if (bars > 200) {
        score += 1;
      } else if (bars > 50) {
        score += 0.5;
      }
    }

    // Adjust for backtest results
    if (quickBacktest) {
      if (quickBacktest.sharpe > 0.5) {
        score += 1;
      } else if (quickBacktest.sharpe < 0) {
        score -= 1;
      }

      if (quickBacktest.confidence === "high") {
        score += 0.5;
      } else if (quickBacktest.confidence === "low") {
        score -= 0.5;
      }
    }

    // Clamp to 1-10
    return Math.max(1, Math.min(10, Math.round(score * 10) / 10));
  }

  private generateAnalysis(
    claim: ParsedClaim,
    legitimacyScore: number,
    coherence: GeneralValidationResult["logicalCoherence"],
    marketDiscovery: GeneralValidationResult["marketDiscovery"]
  ): string {
    let analysis = `Legitimacy score: ${legitimacyScore}/10. `;

    if (coherence.strengths.length > 0) {
      analysis += `Strengths: ${coherence.strengths.join(", ")}. `;
    }

    if (coherence.issues.length > 0) {
      analysis += `Issues: ${coherence.issues.join(", ")}. `;
    }

    if (marketDiscovery.found) {
      analysis += `Found ${marketDiscovery.markets?.length ?? 0} matching markets. `;
      const topMarket = marketDiscovery.markets?.[0];
      if (topMarket) {
        analysis += `Top market: "${topMarket.question.slice(0, 50)}..." ($${topMarket.volume.toLocaleString()} volume). `;
      }
    } else {
      analysis += `No matching markets found on Polymarket. `;
    }

    return analysis;
  }
}
