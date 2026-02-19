import { ParsedClaim, BTCMappingResult } from "../types";
import { runBacktest } from "../../backtesting/engine";
import { HistoricalPrices } from "../../shared/services/historical-prices";
import { MarketDiscovery } from "../../shared/services/market-discovery";
import { PriceBar, BacktestStrategy, PositionSide, StrategySignal } from "../../backtesting/types";
import { loadConfig } from "../../shared/utils/config";
import { log } from "../../shared/utils/logger";
import * as fs from "fs";

interface StrategyMapping {
  family: "momentum" | "breakout" | "regime-trend";
  params: Record<string, number>;
  buildStrategy: () => BacktestStrategy;
}

interface IdeaEntry {
  family?: string;
  metrics?: { sharpe?: number };
}

export class BTCMapper {
  private historicalPrices: HistoricalPrices;
  private marketDiscovery: MarketDiscovery;
  private existingIdeas: IdeaEntry[];

  constructor() {
    const config = loadConfig();
    this.historicalPrices = new HistoricalPrices(config.clobHost);
    this.marketDiscovery = new MarketDiscovery(config.gammaHost);

    // Load existing idea factory results for comparison
    try {
      const ideasPath = "backtests/idea-factory-latest.json";
      if (fs.existsSync(ideasPath)) {
        const data = JSON.parse(fs.readFileSync(ideasPath, "utf-8"));
        this.existingIdeas = Array.isArray(data) ? data : (data.ideas ?? []);
      } else {
        this.existingIdeas = [];
      }
    } catch {
      this.existingIdeas = [];
    }
  }

  /**
   * Check if a parsed claim maps to existing BTC strategies
   */
  async map(claim: ParsedClaim): Promise<BTCMappingResult> {
    // Only process BTC/crypto claims
    if (claim.marketType !== "btc" && claim.marketType !== "crypto") {
      return {
        mapsToExisting: false,
        analysis: "Claim is not BTC/crypto related",
      };
    }

    const mapping = this.identifyStrategyFamily(claim);
    if (!mapping) {
      return {
        mapsToExisting: false,
        analysis: this.generateNonMappingAnalysis(claim),
      };
    }

    // Try to run a backtest with the extracted parameters
    const backtestResult = await this.runClaimBacktest(mapping);

    // Compare to existing strategies
    const comparison = this.compareToExisting(backtestResult, mapping.family);

    return {
      mapsToExisting: true,
      strategyFamily: mapping.family,
      testableParams: mapping.params,
      backtestResult: backtestResult ? {
        sharpe: backtestResult.sharpe,
        sortino: backtestResult.sortino,
        maxDrawdown: backtestResult.maxDrawdown,
        winRate: backtestResult.winRate,
        totalPnl: backtestResult.totalPnl,
        tradeCount: backtestResult.tradeCount,
      } : undefined,
      comparisonToExisting: comparison,
      analysis: this.generateMappingAnalysis(claim, mapping, backtestResult, comparison),
    };
  }

  /**
   * Identify which strategy family the claim maps to
   */
  private identifyStrategyFamily(claim: ParsedClaim): StrategyMapping | null {
    const { strategyType, parameters } = claim;
    const indicators = parameters.indicators?.map(i => i.toLowerCase()) ?? [];
    const entryConditions = parameters.entryConditions?.join(" ").toLowerCase() ?? "";

    // Momentum detection
    if (
      strategyType === "momentum" ||
      indicators.some(i => ["ma", "ema", "sma", "moving average", "macd"].includes(i)) ||
      entryConditions.includes("crossover") ||
      entryConditions.includes("trend")
    ) {
      const shortWindow = parameters.windows?.[0] ?? 8;
      const longWindow = parameters.windows?.[1] ?? 32;
      const adxThreshold = parameters.thresholds?.find(t => t >= 10 && t <= 50) ?? 20;

      return {
        family: "momentum",
        params: { shortWindow, longWindow, adxThreshold, confirmBars: 2 },
        buildStrategy: () => this.buildMomentumStrategy(shortWindow, longWindow, adxThreshold),
      };
    }

    // Breakout detection
    if (
      strategyType === "breakout" ||
      entryConditions.includes("breakout") ||
      entryConditions.includes("high") ||
      entryConditions.includes("low") ||
      entryConditions.includes("range")
    ) {
      const lookbackWindow = parameters.windows?.[0] ?? 20;

      return {
        family: "breakout",
        params: { lookbackWindow, confirmBars: 2, volatilityFloor: 0.001 },
        buildStrategy: () => this.buildBreakoutStrategy(lookbackWindow),
      };
    }

    // Regime/RSI detection
    if (
      indicators.some(i => ["rsi", "regime", "volatility"].includes(i)) ||
      entryConditions.includes("regime") ||
      entryConditions.includes("rsi") ||
      entryConditions.includes("overbought") ||
      entryConditions.includes("oversold")
    ) {
      const trendWindow = parameters.windows?.[0] ?? 48;
      const rsiPeriod = parameters.windows?.[1] ?? 14;

      return {
        family: "regime-trend",
        params: { trendWindow, rsiPeriod, volatilityCap: 0.05 },
        buildStrategy: () => this.buildRegimeStrategy(trendWindow, rsiPeriod),
      };
    }

    return null;
  }

  /**
   * Build a simple momentum strategy
   */
  private buildMomentumStrategy(shortWindow: number, longWindow: number, adxThreshold: number): BacktestStrategy {
    return {
      name: `claim-momentum-${shortWindow}-${longWindow}`,
      warmupBars: Math.max(longWindow, 50),
      getSignal(series: PriceBar[], index: number, currentPosition: PositionSide): StrategySignal | null {
        if (index < longWindow) return null;

        // Calculate short and long MAs
        const shortPrices = series.slice(index - shortWindow, index).map(b => b.price);
        const longPrices = series.slice(index - longWindow, index).map(b => b.price);

        const shortMA = shortPrices.reduce((a, b) => a + b, 0) / shortWindow;
        const longMA = longPrices.reduce((a, b) => a + b, 0) / longWindow;

        // Simple crossover logic
        const bullish = shortMA > longMA * 1.005; // 0.5% threshold
        const bearish = shortMA < longMA * 0.995;

        if (bullish && currentPosition !== 1) {
          return { targetPosition: 1, reason: "Momentum bullish crossover" };
        }
        if (bearish && currentPosition !== -1) {
          return { targetPosition: -1, reason: "Momentum bearish crossover" };
        }

        return null;
      },
    };
  }

  /**
   * Build a simple breakout strategy
   */
  private buildBreakoutStrategy(lookbackWindow: number): BacktestStrategy {
    return {
      name: `claim-breakout-${lookbackWindow}`,
      warmupBars: lookbackWindow + 5,
      getSignal(series: PriceBar[], index: number, currentPosition: PositionSide): StrategySignal | null {
        if (index < lookbackWindow) return null;

        const lookbackPrices = series.slice(index - lookbackWindow, index).map(b => b.price);
        const high = Math.max(...lookbackPrices);
        const low = Math.min(...lookbackPrices);
        const current = series[index].price;

        // Breakout above high
        if (current > high && currentPosition !== 1) {
          return { targetPosition: 1, reason: "Breakout above range high" };
        }
        // Breakout below low
        if (current < low && currentPosition !== -1) {
          return { targetPosition: -1, reason: "Breakout below range low" };
        }

        return null;
      },
    };
  }

  /**
   * Build a simple regime/RSI strategy
   */
  private buildRegimeStrategy(trendWindow: number, rsiPeriod: number): BacktestStrategy {
    return {
      name: `claim-regime-${trendWindow}-${rsiPeriod}`,
      warmupBars: Math.max(trendWindow, rsiPeriod) + 5,
      getSignal(series: PriceBar[], index: number, currentPosition: PositionSide): StrategySignal | null {
        if (index < rsiPeriod + 1) return null;

        // Calculate RSI
        const changes: number[] = [];
        for (let i = index - rsiPeriod; i < index; i++) {
          changes.push(series[i].price - series[i - 1].price);
        }

        const gains = changes.filter(c => c > 0);
        const losses = changes.filter(c => c < 0).map(c => Math.abs(c));

        const avgGain = gains.length > 0 ? gains.reduce((a, b) => a + b, 0) / rsiPeriod : 0;
        const avgLoss = losses.length > 0 ? losses.reduce((a, b) => a + b, 0) / rsiPeriod : 0;

        const rs = avgLoss === 0 ? 100 : avgGain / avgLoss;
        const rsi = 100 - (100 / (1 + rs));

        // RSI-based signals
        if (rsi < 30 && currentPosition !== 1) {
          return { targetPosition: 1, reason: `RSI oversold (${rsi.toFixed(1)})` };
        }
        if (rsi > 70 && currentPosition !== -1) {
          return { targetPosition: -1, reason: `RSI overbought (${rsi.toFixed(1)})` };
        }

        return null;
      },
    };
  }

  /**
   * Run backtest using claimed parameters
   */
  private async runClaimBacktest(mapping: StrategyMapping) {
    try {
      // Discover active BTC markets
      const events = await this.marketDiscovery.discoverBitcoinMarkets(5);
      if (events.length === 0) {
        log.warn("[BTCMapper] No BTC markets found");
        return null;
      }

      // Get first market with enough history
      for (const event of events) {
        const snapshots = this.marketDiscovery.snapshotMarkets(event);
        if (snapshots.length === 0) continue;

        const tokenId = snapshots[0].tokenId;
        if (!tokenId) continue;

        try {
          const bars = await this.historicalPrices.getBars({
            tokenId,
            interval: "1w",
            fidelity: 15,
          });

          if (bars.length < 50) continue;

          log.info(`[BTCMapper] Running backtest on ${event.title} (${bars.length} bars)`);

          return runBacktest({
            strategy: mapping.buildStrategy(),
            tokenId,
            marketQuestion: event.title,
            bars,
          });
        } catch (error) {
          log.debug(`[BTCMapper] Could not get history for ${tokenId}: ${error}`);
          continue;
        }
      }

      return null;
    } catch (error) {
      log.error(`[BTCMapper] Backtest failed: ${error}`);
      return null;
    }
  }

  /**
   * Compare backtest to existing strategies
   */
  private compareToExisting(
    backtestResult: { sharpe: number } | null,
    family: string
  ): BTCMappingResult["comparisonToExisting"] {
    if (!backtestResult) return undefined;

    // Find best existing strategy in same family from idea factory
    const existingBest = this.findBestExistingStrategy(family);
    if (!existingBest) return undefined;

    const claimSharpe = backtestResult.sharpe;
    const existingBestSharpe = existingBest.sharpe;

    let verdict: "outperforms" | "underperforms" | "comparable";
    if (claimSharpe > existingBestSharpe * 1.1) {
      verdict = "outperforms";
    } else if (claimSharpe < existingBestSharpe * 0.9) {
      verdict = "underperforms";
    } else {
      verdict = "comparable";
    }

    return { existingBestSharpe, claimSharpe, verdict };
  }

  private findBestExistingStrategy(family: string): { sharpe: number } | null {
    try {
      const familyIdeas = this.existingIdeas.filter(i =>
        i.family?.toLowerCase().includes(family.toLowerCase())
      );

      if (familyIdeas.length === 0) return null;

      const best = familyIdeas.reduce((best, current) => {
        const currentSharpe = current.metrics?.sharpe ?? 0;
        const bestSharpe = best.metrics?.sharpe ?? 0;
        return currentSharpe > bestSharpe ? current : best;
      });

      return { sharpe: best.metrics?.sharpe ?? 0 };
    } catch {
      return null;
    }
  }

  private generateMappingAnalysis(
    claim: ParsedClaim,
    mapping: StrategyMapping,
    backtest: { sharpe: number; winRate: number; totalPnl: number; tradeCount: number } | null,
    comparison: BTCMappingResult["comparisonToExisting"]
  ): string {
    let analysis = `Claim maps to ${mapping.family} strategy family. `;
    analysis += `Extracted params: ${JSON.stringify(mapping.params)}. `;

    if (backtest) {
      analysis += `Backtest results: Sharpe ${backtest.sharpe.toFixed(2)}, `;
      analysis += `Win rate ${(backtest.winRate * 100).toFixed(1)}%, `;
      analysis += `PnL ${backtest.totalPnl.toFixed(4)}, `;
      analysis += `${backtest.tradeCount} trades. `;
    } else {
      analysis += `Could not run backtest (no market data available). `;
    }

    if (comparison) {
      analysis += `Compared to your existing best (Sharpe ${comparison.existingBestSharpe.toFixed(2)}): `;
      analysis += `${comparison.verdict}. `;
    }

    return analysis;
  }

  private generateNonMappingAnalysis(claim: ParsedClaim): string {
    return `Claim strategy type "${claim.strategyType}" with parameters ` +
      `${JSON.stringify(claim.parameters)} does not directly map to existing ` +
      `BTC strategy families (momentum, breakout, regime-trend). ` +
      `May require new strategy implementation.`;
  }
}
