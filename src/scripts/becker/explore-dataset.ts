/**
 * Becker Dataset Explorer
 *
 * Explores the structure and content of the Becker prediction market dataset.
 * Use this to understand the data before running calibration or maker/taker analysis.
 */

import "dotenv/config";
import { Database } from "duckdb-async";
import { existsSync, readdirSync } from "fs";
import { join } from "path";
import { log } from "../../shared/utils/logger";

const DATA_DIR = process.env.BECKER_DATA_DIR || "data/becker";

async function main() {
  const projectRoot = process.cwd();
  const dataPath = join(projectRoot, DATA_DIR);
  const polymarketPath = join(dataPath, "polymarket");

  // Check if data exists
  if (!existsSync(polymarketPath)) {
    log.error(`Becker dataset not found at ${polymarketPath}`);
    log.error("Run 'npm run becker:download' first to download the dataset.");
    process.exit(1);
  }

  log.info("=== Becker Dataset Explorer ===\n");

  // List contents
  log.info("Directory structure:");
  const subdirs = readdirSync(polymarketPath, { withFileTypes: true });
  for (const entry of subdirs) {
    const entryPath = join(polymarketPath, entry.name);
    if (entry.isDirectory()) {
      const files = readdirSync(entryPath);
      const parquetFiles = files.filter((f) => f.endsWith(".parquet"));
      log.info(`  ${entry.name}/ (${parquetFiles.length} parquet files)`);
    } else {
      log.info(`  ${entry.name}`);
    }
  }

  log.info("\nInitializing DuckDB...");
  const db = await Database.create(":memory:");
  await db.run("SET threads TO 4");

  // Explore each subdirectory
  const marketsPath = join(polymarketPath, "markets");
  const tradesPath = join(polymarketPath, "trades");

  // Markets exploration
  if (existsSync(marketsPath)) {
    log.info("\n=== MARKETS TABLE ===\n");

    // Schema
    const schema = await db.all(`
      DESCRIBE SELECT * FROM read_parquet('${marketsPath}/*.parquet') LIMIT 1
    `);
    log.info("Schema:");
    for (const col of schema) {
      log.info(`  ${String(col.column_name).padEnd(20)} ${col.column_type}`);
    }

    // Row count
    const countResult = await db.all(`
      SELECT COUNT(*) as count FROM read_parquet('${marketsPath}/*.parquet')
    `);
    log.info(`\nTotal rows: ${Number(countResult[0]?.count).toLocaleString()}`);

    // Sample rows
    log.info("\nSample rows (3):");
    const samples = await db.all(`
      SELECT * FROM read_parquet('${marketsPath}/*.parquet') LIMIT 3
    `);
    for (const row of samples) {
      log.info(JSON.stringify(row, null, 2));
    }

    // BTC-specific stats
    const btcCount = await db.all(`
      SELECT COUNT(*) as count
      FROM read_parquet('${marketsPath}/*.parquet')
      WHERE LOWER(question) LIKE '%bitcoin%' OR LOWER(question) LIKE '%btc%'
    `);
    log.info(`\nBTC/Bitcoin markets: ${Number(btcCount[0]?.count).toLocaleString()}`);

    // Closed/resolved stats
    const closedStats = await db.all(`
      SELECT
        closed,
        COUNT(*) as count
      FROM read_parquet('${marketsPath}/*.parquet')
      GROUP BY closed
    `);
    log.info("\nMarket status:");
    for (const row of closedStats) {
      log.info(`  closed=${row.closed}: ${Number(row.count).toLocaleString()}`);
    }

    // Volume distribution
    const volumeStats = await db.all(`
      SELECT
        CASE
          WHEN volume < 1000 THEN '<$1K'
          WHEN volume < 10000 THEN '$1K-10K'
          WHEN volume < 100000 THEN '$10K-100K'
          WHEN volume < 1000000 THEN '$100K-1M'
          ELSE '>$1M'
        END as volume_bucket,
        COUNT(*) as count,
        SUM(volume) as total_volume
      FROM read_parquet('${marketsPath}/*.parquet')
      GROUP BY volume_bucket
      ORDER BY total_volume DESC
    `);
    log.info("\nVolume distribution:");
    for (const row of volumeStats) {
      log.info(`  ${String(row.volume_bucket).padEnd(12)}: ${Number(row.count).toLocaleString().padStart(8)} markets, $${(Number(row.total_volume) / 1e6).toFixed(2)}M total`);
    }
  }

  // Trades exploration
  if (existsSync(tradesPath)) {
    log.info("\n=== TRADES TABLE ===\n");

    // Schema
    const schema = await db.all(`
      DESCRIBE SELECT * FROM read_parquet('${tradesPath}/*.parquet') LIMIT 1
    `);
    log.info("Schema:");
    for (const col of schema) {
      log.info(`  ${String(col.column_name).padEnd(20)} ${col.column_type}`);
    }

    // Row count (may be slow for large datasets)
    log.info("\nCounting trades (this may take a moment for 36GB)...");
    const countResult = await db.all(`
      SELECT COUNT(*) as count FROM read_parquet('${tradesPath}/*.parquet')
    `);
    log.info(`Total rows: ${Number(countResult[0]?.count).toLocaleString()}`);

    // Sample rows
    log.info("\nSample rows (3):");
    const samples = await db.all(`
      SELECT * FROM read_parquet('${tradesPath}/*.parquet') LIMIT 3
    `);
    for (const row of samples) {
      log.info(JSON.stringify(row, null, 2));
    }

    // Asset ID distribution
    log.info("\nAnalyzing asset IDs (for mapping to markets)...");
    const assetStats = await db.all(`
      SELECT
        CASE WHEN maker_asset_id = 0 THEN 'USDC' ELSE 'Token' END as maker_asset,
        CASE WHEN taker_asset_id = 0 THEN 'USDC' ELSE 'Token' END as taker_asset,
        COUNT(*) as count
      FROM read_parquet('${tradesPath}/*.parquet')
      GROUP BY maker_asset, taker_asset
    `);
    log.info("Trade directions:");
    for (const row of assetStats) {
      log.info(`  Maker provides ${row.maker_asset}, Taker provides ${row.taker_asset}: ${Number(row.count).toLocaleString()}`);
    }

    // Volume stats
    const volumeStats = await db.all(`
      SELECT
        SUM(CASE WHEN maker_asset_id = 0 THEN maker_amount ELSE taker_amount END) / 1e6 as total_volume_usd,
        AVG(CASE WHEN maker_asset_id = 0 THEN maker_amount ELSE taker_amount END) / 1e6 as avg_trade_usd,
        MAX(CASE WHEN maker_asset_id = 0 THEN maker_amount ELSE taker_amount END) / 1e6 as max_trade_usd
      FROM read_parquet('${tradesPath}/*.parquet')
    `);
    log.info("\nVolume statistics:");
    log.info(`  Total volume: $${Number(volumeStats[0]?.total_volume_usd).toFixed(2)}M`);
    log.info(`  Avg trade size: $${Number(volumeStats[0]?.avg_trade_usd).toFixed(2)}`);
    log.info(`  Max trade size: $${Number(volumeStats[0]?.max_trade_usd).toFixed(2)}`);

    // Fee stats
    const feeStats = await db.all(`
      SELECT
        AVG(fee) / 1e6 as avg_fee,
        SUM(fee) / 1e6 as total_fees
      FROM read_parquet('${tradesPath}/*.parquet')
    `);
    log.info("\nFee statistics:");
    log.info(`  Avg fee per trade: $${Number(feeStats[0]?.avg_fee).toFixed(4)}`);
    log.info(`  Total fees collected: $${Number(feeStats[0]?.total_fees).toFixed(2)}`);
  }

  await db.close();
  log.info("\n=== Exploration Complete ===");
}

main().catch((error) => {
  const message = error instanceof Error ? error.stack || error.message : String(error);
  log.error(`Dataset exploration failed: ${message}`);
  process.exit(1);
});
