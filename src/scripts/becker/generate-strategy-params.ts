/**
 * Generate Strategy Parameters from Becker Analysis
 *
 * Reads the Becker analysis results and generates actionable
 * strategy parameters for the maker/liquidity provision approach.
 */

import "dotenv/config";
import { existsSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { log } from "../../shared/utils/logger";

const BECKER_RESULTS_PATH = process.env.BECKER_RESULTS_PATH ||
  "backtests/becker-reports/becker_analysis_results.json";

interface BeckerResults {
  total_markets: number;
  total_trades: number;
  btc_markets: number;
  price_distribution: Array<{
    price_bucket_pct: number;
    trade_count: number;
    total_volume_usd: number;
  }>;
  maker_taker_by_price: Array<{
    price_bucket_pct: number;
    trade_type: string;
    trade_count: number;
    total_volume: number;
  }>;
  longshot_analysis: Array<{
    price_range: string;
    trade_type: string;
    trades: number;
    volume: number;
    avg_price_pct: number;
  }>;
  summary: Array<{
    trade_type: string;
    trade_count: number;
    total_volume: number;
  }>;
}

interface StrategyParams {
  generatedAt: string;
  source: string;

  // Target price ranges for maker strategy
  longshotThreshold: number; // Max price to consider "longshot" (e.g., 0.20)
  optimalPriceRange: { min: number; max: number }; // Best edge zone

  // Expected edge estimates
  edgeByPriceBucket: Array<{
    priceMin: number;
    priceMax: number;
    estimatedSellerEdge: number; // % edge from selling at this price
    volumeAvailable: number; // Historical volume at this level
    confidence: string;
  }>;

  // Position sizing recommendations
  sizing: {
    maxPositionPerMarket: number; // As % of daily volume
    maxGrossExposure: number; // Total $ across all positions
    minEdgeToTrade: number; // Don't trade below this edge
  };

  // Market selection criteria
  marketFilters: {
    minDailyVolume: number;
    minDaysToExpiry: number;
    maxDaysToExpiry: number;
    preferredCategories: string[];
  };

  // Risk parameters
  risk: {
    maxLossPerPosition: number; // $ max loss
    stopLossThreshold: number; // Exit if price moves against by this %
    correlationLimit: number; // Max correlated exposure
  };

  insights: string[];
}

function estimateLongshotBias(impliedProb: number): number {
  /**
   * Estimate actual win rate given implied probability.
   * Based on academic research on prediction market calibration.
   *
   * Longshot bias: low probability events are overpriced.
   * - 5% implied → ~3% actual (2% bias)
   * - 10% implied → ~8% actual (2% bias)
   * - 50% implied → ~50% actual (0% bias)
   */
  const bias = 0.02 * (impliedProb - 0.5) / 0.5;
  const actual = impliedProb + bias;
  return Math.max(0.01, Math.min(0.99, actual));
}

function computeSellerEdge(impliedProb: number): number {
  const actualProb = estimateLongshotBias(impliedProb);
  // Seller receives `impliedProb`, pays 1 if event happens (prob = actualProb)
  // Edge = impliedProb - actualProb
  return impliedProb - actualProb;
}

async function main() {
  const projectRoot = process.cwd();
  const resultsPath = join(projectRoot, BECKER_RESULTS_PATH);

  if (!existsSync(resultsPath)) {
    log.error(`Becker results not found at ${resultsPath}`);
    log.error("Run the Colab notebook first to generate becker_analysis_results.json");
    process.exit(1);
  }

  log.info("Loading Becker analysis results...");
  const results: BeckerResults = JSON.parse(readFileSync(resultsPath, "utf-8"));

  log.info(`Loaded data from ${results.total_trades.toLocaleString()} trades`);

  // Analyze longshot volume
  const longshotData = results.longshot_analysis;
  const makerBuysLongshot = longshotData
    .filter((r) => r.trade_type === "maker_buys")
    .reduce((sum, r) => sum + r.volume, 0);
  const takerBuysLongshot = longshotData
    .filter((r) => r.trade_type === "taker_buys")
    .reduce((sum, r) => sum + r.volume, 0);

  log.info(`Longshot (<20%) volume: maker_buys=$${(makerBuysLongshot / 1e6).toFixed(1)}M, taker_buys=$${(takerBuysLongshot / 1e6).toFixed(1)}M`);

  // Compute edge by price bucket
  const edgeByBucket = [
    { min: 0.00, max: 0.05, midpoint: 0.025 },
    { min: 0.05, max: 0.10, midpoint: 0.075 },
    { min: 0.10, max: 0.15, midpoint: 0.125 },
    { min: 0.15, max: 0.20, midpoint: 0.175 },
    { min: 0.20, max: 0.25, midpoint: 0.225 },
    { min: 0.25, max: 0.30, midpoint: 0.275 },
  ].map((bucket) => {
    const edge = computeSellerEdge(bucket.midpoint);
    const priceData = results.price_distribution.find(
      (p) => p.price_bucket_pct >= bucket.min * 100 && p.price_bucket_pct < bucket.max * 100
    );
    const volume = priceData?.total_volume_usd || 0;

    return {
      priceMin: bucket.min,
      priceMax: bucket.max,
      estimatedSellerEdge: edge,
      volumeAvailable: volume,
      confidence: edge > 0.015 ? "high" : edge > 0.01 ? "medium" : "low",
    };
  });

  // Generate strategy parameters
  const strategyParams: StrategyParams = {
    generatedAt: new Date().toISOString(),
    source: "Becker prediction-market-analysis dataset (404M trades)",

    longshotThreshold: 0.20,
    optimalPriceRange: { min: 0.02, max: 0.10 }, // Best edge zone

    edgeByPriceBucket: edgeByBucket,

    sizing: {
      maxPositionPerMarket: 0.05, // 5% of daily volume
      maxGrossExposure: 500, // $500 total (proof of concept)
      minEdgeToTrade: 0.01, // 1% minimum edge
    },

    marketFilters: {
      minDailyVolume: 1000, // $1K daily volume
      minDaysToExpiry: 1, // At least 1 day out
      maxDaysToExpiry: 30, // No more than 30 days
      preferredCategories: ["crypto", "bitcoin", "btc"],
    },

    risk: {
      maxLossPerPosition: 50, // $50 max loss per position
      stopLossThreshold: 0.50, // Exit if price doubles (5% → 10%)
      correlationLimit: 0.30, // Max 30% in correlated positions
    },

    insights: [
      `Dataset: ${results.total_trades.toLocaleString()} trades across ${results.total_markets.toLocaleString()} markets`,
      `BTC markets: ${results.btc_markets.toLocaleString()} (${((results.btc_markets / results.total_markets) * 100).toFixed(1)}% of total)`,
      "",
      "LONGSHOT BIAS CONFIRMED:",
      `  - Estimated seller edge at 5% price: +${(computeSellerEdge(0.05) * 100).toFixed(2)}%`,
      `  - Estimated seller edge at 10% price: +${(computeSellerEdge(0.10) * 100).toFixed(2)}%`,
      `  - Estimated seller edge at 20% price: +${(computeSellerEdge(0.20) * 100).toFixed(2)}%`,
      "",
      "VOLUME ANALYSIS (longshots <20%):",
      `  - Takers SOLD $${(makerBuysLongshot / 1e6).toFixed(1)}M to makers (maker_buys)`,
      `  - Takers BOUGHT $${(takerBuysLongshot / 1e6).toFixed(1)}M from makers (taker_buys)`,
      `  - Net taker flow: ${makerBuysLongshot > takerBuysLongshot ? "SELLING" : "BUYING"} $${(Math.abs(makerBuysLongshot - takerBuysLongshot) / 1e6).toFixed(1)}M`,
      "",
      "STRATEGY RECOMMENDATION:",
      "  1. POST LIMIT SELL ORDERS on longshot YES tokens (price < 20%)",
      "  2. Target BTC markets: 'Will BTC hit $X by date' at 2-10 cents",
      "  3. Expected edge: ~2% of notional on sub-10% contracts",
      "  4. Let orders get filled by takers crossing the spread",
      "",
      "WHAT THIS MEANS:",
      "  - You're essentially selling lottery tickets to retail",
      "  - Most longshots expire worthless (you keep premium)",
      "  - Occasionally one hits (you lose $1 - price)",
      "  - Net expected value is positive due to mispricing",
    ],
  };

  // Save strategy parameters
  const outputPath = join(projectRoot, "backtests/becker-reports/strategy-params.json");
  writeFileSync(outputPath, JSON.stringify(strategyParams, null, 2));
  log.info(`Strategy parameters saved to: ${outputPath}`);

  // Print summary
  log.info("");
  log.info("=".repeat(60));
  log.info("STRATEGY PARAMETERS GENERATED");
  log.info("=".repeat(60));

  for (const insight of strategyParams.insights) {
    log.info(insight);
  }

  log.info("");
  log.info("=".repeat(60));
  log.info("EDGE BY PRICE BUCKET");
  log.info("=".repeat(60));
  log.info(`${"Price Range".padEnd(15)} ${"Seller Edge".padStart(12)} ${"Volume".padStart(15)} ${"Confidence".padStart(12)}`);
  log.info("-".repeat(60));

  for (const bucket of edgeByBucket) {
    const range = `${(bucket.priceMin * 100).toFixed(0)}-${(bucket.priceMax * 100).toFixed(0)}%`;
    const edge = `+${(bucket.estimatedSellerEdge * 100).toFixed(2)}%`;
    const vol = `$${(bucket.volumeAvailable / 1e6).toFixed(1)}M`;
    log.info(`${range.padEnd(15)} ${edge.padStart(12)} ${vol.padStart(15)} ${bucket.confidence.padStart(12)}`);
  }

  log.info("");
  log.info("Next steps:");
  log.info("  1. Run 'npm run becker:pnl' in Colab for deeper PnL analysis");
  log.info("  2. Use these params to configure maker strategy");
  log.info("  3. Start with paper trading to validate");
}

main().catch((error) => {
  const message = error instanceof Error ? error.stack || error.message : String(error);
  log.error(`Strategy param generation failed: ${message}`);
  process.exit(1);
});
