/**
 * Maker vs Taker Edge Analysis
 *
 * Computes the edge (excess return) for makers vs takers in BTC prediction markets.
 *
 * Key question: Do makers earn positive excess returns in BTC markets?
 * Becker's aggregate data shows makers have +0.77% to +1.25% edge.
 * This script tests if BTC markets specifically show the same pattern.
 *
 * Methodology:
 * 1. Load all BTC trades from Becker dataset
 * 2. Identify maker vs taker for each trade
 * 3. Match trades to market outcomes (did the position win?)
 * 4. Compute PnL for each side
 * 5. Aggregate to get average edge by side and price level
 */

import "dotenv/config";
import { Database } from "duckdb-async";
import { existsSync, writeFileSync, mkdirSync } from "fs";
import { join } from "path";
import { log } from "../../shared/utils/logger";

const DATA_DIR = process.env.BECKER_DATA_DIR || "data/becker";
const OUTPUT_DIR = process.env.BECKER_OUTPUT_DIR || "backtests/becker-reports";

interface EdgeBucket {
  priceMin: number;
  priceMax: number;
  makerEdge: number;    // Average excess return for makers
  takerEdge: number;    // Average excess return for takers
  makerCount: number;   // Number of maker-side trades
  takerCount: number;   // Number of taker-side trades
  makerVolume: number;  // Total USD volume for makers
  takerVolume: number;  // Total USD volume for takers
}

interface MakerTakerReport {
  generatedAt: string;
  dataSource: string;
  filter: string;
  totalTrades: number;
  btcTrades: number;
  buckets: EdgeBucket[];
  summary: {
    overallMakerEdge: number;
    overallTakerEdge: number;
    makerWinRate: number;
    takerWinRate: number;
    longshotMakerEdge: number;    // Edge on <20% contracts
    longshotTakerEdge: number;
    totalMakerVolume: number;
    totalTakerVolume: number;
  };
  interpretation: string[];
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

  // Enable parallel processing for large dataset
  await db.run("SET threads TO 4");
  await db.run("SET memory_limit = '4GB'");

  log.info("Analyzing Polymarket trades...");

  // First, get total trade count
  const totalTradesResult = await db.all(`
    SELECT COUNT(*) as count FROM read_parquet('${tradesPath}/*.parquet')
  `);
  const totalTrades = Number(totalTradesResult[0]?.count ?? 0);
  log.info(`Total trades in dataset: ${totalTrades.toLocaleString()}`);

  // Get schema to understand trade structure
  const schemaResult = await db.all(`
    SELECT column_name, column_type
    FROM (DESCRIBE SELECT * FROM read_parquet('${tradesPath}/*.parquet') LIMIT 1)
  `);

  log.info("Trade schema:");
  const columns = schemaResult.map((c) => String(c.column_name));
  log.info(`  Columns: ${columns.join(", ")}`);

  // Sample trades to understand structure
  const sampleTrades = await db.all(`
    SELECT * FROM read_parquet('${tradesPath}/*.parquet') LIMIT 3
  `);

  log.info("Sample trade data:");
  for (const trade of sampleTrades) {
    log.info(JSON.stringify(trade, null, 2));
  }

  // The key insight: in the CTF exchange schema:
  // - maker_asset_id = 0 means maker is providing USDC (buying tokens)
  // - taker_asset_id = 0 means taker is providing USDC (buying tokens)
  // - Price = USDC_amount / token_amount

  // To compute maker/taker edge, we need to:
  // 1. Identify which asset was the outcome token
  // 2. Match that token to a market outcome
  // 3. Determine if that outcome won
  // 4. Compute PnL for the buyer/seller

  log.info("Computing maker/taker statistics...");

  // Get aggregate statistics first
  const aggStatsQuery = `
    SELECT
      COUNT(*) as total_trades,
      SUM(CASE WHEN maker_asset_id = 0 THEN maker_amount ELSE 0 END) / 1e6 as maker_buy_volume_usd,
      SUM(CASE WHEN taker_asset_id = 0 THEN taker_amount ELSE 0 END) / 1e6 as taker_buy_volume_usd,
      AVG(fee) / 1e6 as avg_fee_usd
    FROM read_parquet('${tradesPath}/*.parquet')
  `;

  try {
    const aggStats = await db.all(aggStatsQuery);
    log.info("Aggregate trade statistics:");
    log.info(JSON.stringify(aggStats[0], null, 2));
  } catch (err) {
    log.warn(`Aggregate stats query failed: ${err}`);
  }

  // Now attempt to identify BTC-related trades
  // This requires joining trades to markets via asset_id
  // The asset_id is the condition_id hash - we need to match this to markets

  log.info("Identifying BTC market trades...");

  // Get BTC market IDs first
  const btcMarketsQuery = `
    SELECT
      id,
      condition_id,
      question,
      outcomes,
      outcome_prices,
      closed
    FROM read_parquet('${marketsPath}/*.parquet')
    WHERE
      LOWER(question) LIKE '%bitcoin%'
      OR LOWER(question) LIKE '%btc%'
    LIMIT 100
  `;

  try {
    const btcMarkets = await db.all(btcMarketsQuery);
    log.info(`Found ${btcMarkets.length} BTC markets (sampled)`);

    if (btcMarkets.length > 0) {
      log.info("Sample BTC market:");
      const sample = btcMarkets[0];
      log.info(`  ID: ${sample.id}`);
      log.info(`  Condition ID: ${sample.condition_id}`);
      log.info(`  Question: ${String(sample.question).slice(0, 80)}`);
    }
  } catch (err) {
    log.warn(`BTC markets query failed: ${err}`);
  }

  // The challenge: matching trades to markets requires understanding
  // how asset_id maps to condition_id. This is blockchain-specific.
  // For CTF Exchange, asset_id is computed from condition_id + outcome_index

  // Let's compute aggregate maker/taker statistics without BTC filtering first
  // This gives us the overall picture similar to Becker's findings

  log.info("Computing overall maker/taker edge (all markets)...");

  const edgeQuery = `
    WITH trades_with_side AS (
      SELECT
        *,
        -- Determine which side is "buying" (providing USDC)
        CASE
          WHEN maker_asset_id = 0 THEN 'maker_buys'
          WHEN taker_asset_id = 0 THEN 'taker_buys'
          ELSE 'unknown'
        END as trade_direction,
        -- Compute trade price (USDC per token)
        CASE
          WHEN maker_asset_id = 0 AND taker_amount > 0
            THEN CAST(maker_amount AS DOUBLE) / CAST(taker_amount AS DOUBLE)
          WHEN taker_asset_id = 0 AND maker_amount > 0
            THEN CAST(taker_amount AS DOUBLE) / CAST(maker_amount AS DOUBLE)
          ELSE NULL
        END as price,
        -- Compute trade size in USDC
        CASE
          WHEN maker_asset_id = 0 THEN maker_amount / 1e6
          WHEN taker_asset_id = 0 THEN taker_amount / 1e6
          ELSE 0
        END as volume_usd
      FROM read_parquet('${tradesPath}/*.parquet')
    ),
    price_buckets AS (
      SELECT
        trade_direction,
        FLOOR(price * 20) / 20 as price_bucket,  -- 5% buckets
        volume_usd,
        price
      FROM trades_with_side
      WHERE price IS NOT NULL
        AND price >= 0 AND price <= 1
    )
    SELECT
      price_bucket,
      trade_direction,
      COUNT(*) as trade_count,
      SUM(volume_usd) as total_volume,
      AVG(price) as avg_price
    FROM price_buckets
    GROUP BY price_bucket, trade_direction
    ORDER BY price_bucket, trade_direction
  `;

  try {
    const edgeResults = await db.all(edgeQuery);
    log.info(`Price bucket results: ${edgeResults.length} rows`);

    // Aggregate results by price bucket
    const bucketMap: Map<number, EdgeBucket> = new Map();

    for (const row of edgeResults) {
      const bucket = Number(row.price_bucket);
      const direction = String(row.trade_direction);
      const count = Number(row.trade_count);
      const volume = Number(row.total_volume);

      if (!bucketMap.has(bucket)) {
        bucketMap.set(bucket, {
          priceMin: bucket,
          priceMax: bucket + 0.05,
          makerEdge: 0,
          takerEdge: 0,
          makerCount: 0,
          takerCount: 0,
          makerVolume: 0,
          takerVolume: 0,
        });
      }

      const b = bucketMap.get(bucket)!;
      if (direction === "maker_buys") {
        b.makerCount = count;
        b.makerVolume = volume;
      } else if (direction === "taker_buys") {
        b.takerCount = count;
        b.takerVolume = volume;
      }
    }

    // Convert to array and sort
    const buckets = Array.from(bucketMap.values()).sort(
      (a, b) => a.priceMin - b.priceMin
    );

    // Print summary
    log.info("");
    log.info("=== Trade Volume by Price Bucket ===");
    log.info("Bucket    | Maker Buys    | Taker Buys    | Maker Vol     | Taker Vol");
    log.info("-".repeat(80));

    for (const b of buckets) {
      log.info(
        `${(b.priceMin * 100).toFixed(0).padStart(3)}-${((b.priceMax) * 100).toFixed(0).padStart(3)}%  | ` +
        `${b.makerCount.toLocaleString().padStart(12)} | ` +
        `${b.takerCount.toLocaleString().padStart(12)} | ` +
        `$${(b.makerVolume / 1e6).toFixed(2)}M`.padStart(12) + ` | ` +
        `$${(b.takerVolume / 1e6).toFixed(2)}M`.padStart(12)
      );
    }

    // Compute totals
    const totalMakerVolume = buckets.reduce((a, b) => a + b.makerVolume, 0);
    const totalTakerVolume = buckets.reduce((a, b) => a + b.takerVolume, 0);
    const totalMakerTrades = buckets.reduce((a, b) => a + b.makerCount, 0);
    const totalTakerTrades = buckets.reduce((a, b) => a + b.takerCount, 0);

    log.info("-".repeat(80));
    log.info(
      `TOTAL     | ${totalMakerTrades.toLocaleString().padStart(12)} | ` +
      `${totalTakerTrades.toLocaleString().padStart(12)} | ` +
      `$${(totalMakerVolume / 1e6).toFixed(2)}M`.padStart(12) + ` | ` +
      `$${(totalTakerVolume / 1e6).toFixed(2)}M`.padStart(12)
    );

    // Generate report
    const report: MakerTakerReport = {
      generatedAt: new Date().toISOString(),
      dataSource: "Becker prediction-market-analysis dataset",
      filter: "All markets (BTC filtering requires asset_id mapping)",
      totalTrades,
      btcTrades: 0, // Not yet filtered
      buckets,
      summary: {
        overallMakerEdge: 0, // Requires outcome matching
        overallTakerEdge: 0,
        makerWinRate: 0,
        takerWinRate: 0,
        longshotMakerEdge: 0,
        longshotTakerEdge: 0,
        totalMakerVolume,
        totalTakerVolume,
      },
      interpretation: [
        "This report shows trade volume distribution by price bucket and side.",
        "Maker = limit order placer, Taker = order filler.",
        "Full edge calculation requires matching trades to market outcomes.",
        "Next step: Map asset_id to condition_id for BTC-specific analysis.",
        "",
        "Key insight from Becker's research:",
        "- Takers have negative excess returns at 80/99 price levels",
        "- Makers earn +0.77% to +1.25% edge on average",
        "- Longshot bias is strongest at low price levels (<20%)",
      ],
    };

    // Save report
    if (!existsSync(OUTPUT_DIR)) {
      mkdirSync(OUTPUT_DIR, { recursive: true });
    }

    const outputPath = join(OUTPUT_DIR, "maker-taker-analysis.json");
    writeFileSync(outputPath, JSON.stringify(report, null, 2));
    log.info(`\nReport saved to: ${outputPath}`);

  } catch (err) {
    log.error(`Edge analysis query failed: ${err}`);
  }

  await db.close();
  log.info("\nAnalysis complete.");
}

main().catch((error) => {
  const message = error instanceof Error ? error.stack || error.message : String(error);
  log.error(`Maker/taker analysis failed: ${message}`);
  process.exit(1);
});
