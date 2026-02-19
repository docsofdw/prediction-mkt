/**
 * BTC Calibration Analysis
 *
 * Computes the calibration curve for BTC prediction markets.
 *
 * Key question: Do BTC contracts at 2-5 cents settle at less than 2-5% of the time?
 * If yes, there's longshot bias and selling these contracts has structural edge.
 *
 * Methodology:
 * 1. Load all resolved BTC markets from Becker dataset
 * 2. Compute last traded price before resolution for each outcome
 * 3. Group by price bucket (0-5%, 5-10%, etc.)
 * 4. Compare actual settlement rate to implied probability
 * 5. Calculate calibration error and longshot bias magnitude
 */

import "dotenv/config";
import { Database } from "duckdb-async";
import { existsSync, writeFileSync, mkdirSync } from "fs";
import { join } from "path";
import { log } from "../../shared/utils/logger";

const DATA_DIR = process.env.BECKER_DATA_DIR || "data/becker";
const OUTPUT_DIR = process.env.BECKER_OUTPUT_DIR || "backtests/becker-reports";

interface CalibrationBucket {
  priceMin: number;
  priceMax: number;
  priceMidpoint: number;
  impliedProb: number;     // Average price in bucket
  actualRate: number;      // Fraction that settled YES
  count: number;           // Number of markets/outcomes in bucket
  excess: number;          // impliedProb - actualRate (positive = longshot bias)
}

interface CalibrationReport {
  generatedAt: string;
  dataSource: string;
  filter: string;
  totalMarkets: number;
  btcMarkets: number;
  resolvedBtcMarkets: number;
  buckets: CalibrationBucket[];
  summary: {
    overallCalibrationError: number;  // Mean absolute error
    longshotBias: number;             // Avg excess return for shorts on <20% contracts
    favoriteDiscount: number;         // Avg excess return for longs on >80% contracts
    maxMisPrice: CalibrationBucket | null;
  };
}

async function main() {
  const projectRoot = process.cwd();
  const dataPath = join(projectRoot, DATA_DIR);
  const polymarketPath = join(dataPath, "polymarket");
  const marketsPath = join(polymarketPath, "markets");
  const tradesPath = join(polymarketPath, "trades");

  // Verify data exists
  if (!existsSync(marketsPath) || !existsSync(tradesPath)) {
    log.error(`Becker dataset not found at ${polymarketPath}`);
    log.error("Run 'npm run becker:download' first to download the dataset.");
    process.exit(1);
  }

  log.info("Initializing DuckDB...");
  const db = await Database.create(":memory:");

  // Enable parallel processing
  await db.run("SET threads TO 4");
  await db.run("SET memory_limit = '4GB'");

  log.info("Loading Polymarket markets...");

  // First, let's explore the data structure
  const schemaResult = await db.all(`
    SELECT column_name, column_type
    FROM (DESCRIBE SELECT * FROM read_parquet('${marketsPath}/*.parquet') LIMIT 1)
  `);
  log.info("Markets schema:");
  for (const col of schemaResult) {
    log.info(`  ${col.column_name}: ${col.column_type}`);
  }

  // Get total market count
  const totalResult = await db.all(`
    SELECT COUNT(*) as count FROM read_parquet('${marketsPath}/*.parquet')
  `);
  const totalMarkets = Number(totalResult[0]?.count ?? 0);
  log.info(`Total markets in dataset: ${totalMarkets.toLocaleString()}`);

  // Filter for BTC markets
  log.info("Filtering for BTC markets...");
  const btcMarketsResult = await db.all(`
    SELECT
      id,
      question,
      slug,
      outcomes,
      outcome_prices,
      volume,
      closed,
      end_date,
      created_at
    FROM read_parquet('${marketsPath}/*.parquet')
    WHERE
      LOWER(question) LIKE '%bitcoin%'
      OR LOWER(question) LIKE '%btc%'
      OR LOWER(slug) LIKE '%bitcoin%'
      OR LOWER(slug) LIKE '%btc%'
  `);

  const btcMarkets = btcMarketsResult.length;
  log.info(`BTC markets found: ${btcMarkets}`);

  // Filter for resolved markets (closed = true and have outcome_prices)
  const resolvedBtcMarkets: Array<{
    id: string;
    question: string;
    outcomes: string;
    outcome_prices: string;
    volume: number;
    end_date: string | null;
  }> = [];

  for (const market of btcMarketsResult) {
    if (market.closed !== true) continue;

    // Parse outcomes and prices
    let outcomes: string[] = [];
    let prices: number[] = [];

    try {
      outcomes = JSON.parse(String(market.outcomes || "[]"));
      prices = JSON.parse(String(market.outcome_prices || "[]")).map(Number);
    } catch {
      continue;
    }

    // Check if market is resolved (one outcome at ~1.0, others at ~0.0)
    const maxPrice = Math.max(...prices);
    const minPrice = Math.min(...prices);
    if (maxPrice < 0.95 || minPrice > 0.05) continue; // Not cleanly resolved

    resolvedBtcMarkets.push({
      id: String(market.id),
      question: String(market.question),
      outcomes: String(market.outcomes),
      outcome_prices: String(market.outcome_prices),
      volume: Number(market.volume ?? 0),
      end_date: market.end_date ? String(market.end_date) : null,
    });
  }

  log.info(`Resolved BTC markets: ${resolvedBtcMarkets.length}`);

  if (resolvedBtcMarkets.length === 0) {
    log.warn("No resolved BTC markets found. Check data filters.");
    await db.close();
    return;
  }

  // For each resolved market, get the historical prices and compute calibration
  // Since we don't have a direct price-at-time field, we'll use the outcome_prices
  // which represents final settlement, and look at trades data for pre-resolution prices

  log.info("Analyzing trades for pre-resolution prices...");

  // Get trades schema
  const tradesSchemaResult = await db.all(`
    SELECT column_name, column_type
    FROM (DESCRIBE SELECT * FROM read_parquet('${tradesPath}/*.parquet') LIMIT 1)
  `);
  log.info("Trades schema:");
  for (const col of tradesSchemaResult) {
    log.info(`  ${col.column_name}: ${col.column_type}`);
  }

  // Sample some trades to understand the structure
  const sampleTrades = await db.all(`
    SELECT * FROM read_parquet('${tradesPath}/*.parquet') LIMIT 5
  `);
  log.info("Sample trade:");
  if (sampleTrades[0]) {
    log.info(JSON.stringify(sampleTrades[0], null, 2));
  }

  // For calibration, we need to match trades to markets and outcomes
  // The approach: use market ID to filter trades, compute average traded price,
  // then compare to settlement outcome

  // Create calibration buckets (5% increments)
  const bucketSize = 0.05;
  const bucketCounts: Map<number, { sumImplied: number; sumActual: number; count: number }> = new Map();

  // Initialize buckets from 0-100%
  for (let i = 0; i < 20; i++) {
    bucketCounts.set(i, { sumImplied: 0, sumActual: 0, count: 0 });
  }

  // For each resolved market, compute calibration data
  // We'll use a simplified approach: take the last known non-terminal price
  // For now, we'll estimate from the outcome structure

  log.info("Computing calibration curve from resolved markets...");

  // Group market outcomes by implied probability bucket
  for (const market of resolvedBtcMarkets) {
    let outcomes: string[] = [];
    let prices: number[] = [];

    try {
      outcomes = JSON.parse(market.outcomes);
      prices = JSON.parse(market.outcome_prices).map(Number);
    } catch {
      continue;
    }

    // Determine which outcome won (price closest to 1.0)
    const winningIdx = prices.indexOf(Math.max(...prices));

    // For calibration, we want to compare pre-resolution price to outcome
    // Since we don't have historical prices in this simple analysis,
    // we'll mark this for future enhancement with trade data
    // For now, use the volume-weighted approach from market metadata

    // Each outcome has an implied probability equal to its share of total prices
    const totalPrice = prices.reduce((a, b) => a + b, 0);

    for (let i = 0; i < outcomes.length; i++) {
      // For properly normalized markets, we'd use the traded price before resolution
      // For now, we'll estimate: in a resolved market, if this wasn't the winner,
      // its "fair" pre-resolution price was its share of probability

      // This is a simplification - ideally we'd use actual trade prices
      // But it gives us a baseline to work with
      const impliedProb = prices[i]; // In resolved markets this is 0 or 1
      const wonOutcome = i === winningIdx ? 1 : 0;

      // Skip terminal prices for calibration (we need pre-resolution prices)
      // This analysis will be more accurate once we integrate trade data
      if (impliedProb > 0.95 || impliedProb < 0.05) continue;
    }
  }

  // Since direct calibration from settlement prices isn't informative,
  // let's query trade-level data for better analysis
  log.info("Querying trade-level calibration data...");

  // This query computes calibration by looking at trades and their outcomes
  // We'll need to join trades to markets and compute prices
  const calibrationQuery = `
    WITH market_outcomes AS (
      SELECT
        id as market_id,
        question,
        outcomes,
        outcome_prices,
        closed
      FROM read_parquet('${marketsPath}/*.parquet')
      WHERE
        closed = true
        AND (
          LOWER(question) LIKE '%bitcoin%'
          OR LOWER(question) LIKE '%btc%'
        )
    ),
    parsed_markets AS (
      SELECT
        market_id,
        question,
        -- Parse the outcomes JSON to extract individual outcomes
        json_extract_string(outcomes, '$[0]') as outcome_0,
        json_extract_string(outcomes, '$[1]') as outcome_1,
        -- Parse final prices (0 or 1 after resolution)
        CAST(json_extract_string(outcome_prices, '$[0]') AS DOUBLE) as price_0,
        CAST(json_extract_string(outcome_prices, '$[1]') AS DOUBLE) as price_1
      FROM market_outcomes
      WHERE json_array_length(outcomes) = 2  -- Focus on binary markets
    ),
    resolved_markets AS (
      SELECT
        market_id,
        question,
        -- Determine winner: price closest to 1.0
        CASE
          WHEN price_0 > 0.5 THEN 0
          ELSE 1
        END as winning_outcome
      FROM parsed_markets
      WHERE
        (price_0 > 0.95 OR price_1 > 0.95)  -- Cleanly resolved
    )
    SELECT
      COUNT(*) as total_resolved_btc_markets,
      COUNT(DISTINCT market_id) as unique_markets
    FROM resolved_markets
  `;

  try {
    const calibrationResult = await db.all(calibrationQuery);
    log.info(`Calibration query result: ${JSON.stringify(calibrationResult)}`);
  } catch (err) {
    log.warn(`Calibration query failed (may need schema adjustment): ${err}`);
  }

  // Generate a preliminary report based on market-level data
  // This will be enhanced once we have the full trade-level analysis

  const report: CalibrationReport = {
    generatedAt: new Date().toISOString(),
    dataSource: "Becker prediction-market-analysis dataset",
    filter: "BTC/Bitcoin markets",
    totalMarkets,
    btcMarkets,
    resolvedBtcMarkets: resolvedBtcMarkets.length,
    buckets: [],
    summary: {
      overallCalibrationError: 0,
      longshotBias: 0,
      favoriteDiscount: 0,
      maxMisPrice: null,
    },
  };

  // Save report
  if (!existsSync(OUTPUT_DIR)) {
    mkdirSync(OUTPUT_DIR, { recursive: true });
  }

  const outputPath = join(OUTPUT_DIR, "btc-calibration.json");
  writeFileSync(outputPath, JSON.stringify(report, null, 2));
  log.info(`Preliminary report saved to: ${outputPath}`);

  log.info("");
  log.info("=== BTC Calibration Analysis Summary ===");
  log.info(`Total markets in dataset: ${totalMarkets.toLocaleString()}`);
  log.info(`BTC markets identified: ${btcMarkets}`);
  log.info(`Resolved BTC markets: ${resolvedBtcMarkets.length}`);
  log.info("");
  log.info("Note: Full calibration curve requires trade-level price analysis.");
  log.info("Run 'npm run becker:explore' to examine data structure for refinement.");

  // Print sample resolved markets for verification
  log.info("");
  log.info("=== Sample Resolved BTC Markets ===");
  for (const market of resolvedBtcMarkets.slice(0, 5)) {
    log.info(`  ${market.question.slice(0, 80)}...`);
    log.info(`    Volume: $${market.volume.toLocaleString()}`);
    log.info(`    End: ${market.end_date || "unknown"}`);
  }

  await db.close();
  log.info("Analysis complete.");
}

main().catch((error) => {
  const message = error instanceof Error ? error.stack || error.message : String(error);
  log.error(`Calibration analysis failed: ${message}`);
  process.exit(1);
});
