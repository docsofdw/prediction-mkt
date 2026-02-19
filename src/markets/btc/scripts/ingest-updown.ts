import "dotenv/config";
import axios, { AxiosInstance } from "axios";
import { validationConfig } from "../validation/config";
import { migrateValidationDb, openValidationDb, SqliteDatabase } from "../../../shared/validation/sqlite";
import { log } from "../../../shared/utils/logger";

const gammaHost = process.env.GAMMA_HOST || "https://gamma-api.polymarket.com";

// Rate limiting: max 10 requests per second
const BATCH_SIZE = 20;
const BATCH_DELAY_MS = 2500;

// Series started Nov 21, 2025
const SERIES_START = new Date("2025-11-21T00:00:00Z").getTime();

interface UpDownMarket {
  slug: string;
  marketType: "5m" | "4h";
  windowStart: Date;
  windowEnd: Date;
  outcome: "Up" | "Down" | "unknown";
  btcPriceStart: number | null;
  btcPriceEnd: number | null;
  volume: number;
  upTokenId: string | null;
  downTokenId: string | null;
}

function generateTimestamps(
  type: "5m" | "4h",
  fromTs: number,
  toTs: number
): number[] {
  const timestamps: number[] = [];

  if (type === "5m") {
    // 5-minute markets: aligned to 5-minute intervals in UTC
    const intervalMs = 5 * 60 * 1000;
    const startAligned = Math.ceil(fromTs / intervalMs) * intervalMs;
    for (let ts = startAligned; ts < toTs; ts += intervalMs) {
      timestamps.push(ts / 1000);
    }
  } else {
    // 4-hour markets: aligned to ET timezone windows
    // Windows: 12AM-4AM, 4AM-8AM, 8AM-12PM, 12PM-4PM, 4PM-8PM, 8PM-12AM ET
    // In UTC (ET = UTC-5): 5:00, 9:00, 13:00, 17:00, 21:00, 01:00
    const etOffsetMs = 5 * 60 * 60 * 1000; // ET is UTC-5
    const intervalMs = 4 * 60 * 60 * 1000;

    // Find the first 4-hour window boundary
    // Windows start at midnight ET = 5AM UTC
    const midnightEtInUtc = 5 * 60 * 60 * 1000; // 5:00 UTC
    const dayMs = 24 * 60 * 60 * 1000;

    // Start from beginning of day containing fromTs
    const fromDate = new Date(fromTs);
    fromDate.setUTCHours(5, 0, 0, 0); // Start at 5AM UTC (midnight ET)
    let ts = fromDate.getTime();
    if (ts < fromTs) {
      // Move to next window
      ts = Math.ceil((fromTs - ts) / intervalMs) * intervalMs + ts;
    }

    for (; ts < toTs; ts += intervalMs) {
      timestamps.push(ts / 1000);
    }
  }

  return timestamps;
}

async function fetchMarket(
  client: AxiosInstance,
  slug: string
): Promise<UpDownMarket | null> {
  try {
    const { data } = await client.get(`/events/slug/${slug}`, { timeout: 10000 });

    const market = data.markets?.[0];
    if (!market) return null;

    // Check if resolved
    if (!market.closed) return null;

    // Parse outcome from outcomePrices: ["Up_price", "Down_price"]
    // Winner has price = 1, loser has price = 0
    const outcomePrices: number[] = JSON.parse(market.outcomePrices || "[]").map(Number);
    let outcome: "Up" | "Down" | "unknown" = "unknown";
    if (outcomePrices[0] === 1) outcome = "Up";
    else if (outcomePrices[1] === 1) outcome = "Down";

    // Parse token IDs
    const tokenIds: string[] = JSON.parse(market.clobTokenIds || "[]");
    const upTokenId = tokenIds[0] || null;
    const downTokenId = tokenIds[1] || null;

    // Parse timestamps
    const windowStart = new Date(data.startTime || market.eventStartTime || market.startDate);
    const windowEnd = new Date(data.closedTime || market.closedTime || market.endDate);

    // BTC price at start from eventMetadata
    const btcPriceStart = data.eventMetadata?.priceToBeat ?? null;

    // Determine market type from slug
    const marketType: "5m" | "4h" = slug.includes("-5m-") ? "5m" : "4h";

    return {
      slug,
      marketType,
      windowStart,
      windowEnd,
      outcome,
      btcPriceStart,
      btcPriceEnd: null, // Would need another API call
      volume: Number(market.volume) || 0,
      upTokenId,
      downTokenId,
    };
  } catch (err: any) {
    if (err.response?.status === 404) return null;
    // Rate limit or other error
    if (err.response?.status === 429) {
      log.warn(`Rate limited on ${slug}, waiting...`);
      await sleep(5000);
      return fetchMarket(client, slug);
    }
    return null;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function getNearestFundingPercentile(
  db: SqliteDatabase,
  targetTs: number
): Promise<number | null> {
  const row = db.prepare(`
    SELECT fr_percentile_30d
    FROM phase2_funding_rates
    WHERE fr_percentile_30d IS NOT NULL
    ORDER BY ABS(strftime('%s', timestamp) * 1000 - ?)
    LIMIT 1
  `).get(targetTs) as { fr_percentile_30d: number | null } | undefined;

  return row?.fr_percentile_30d ?? null;
}

async function ingestUpDownMarkets(
  db: SqliteDatabase,
  type: "5m" | "4h",
  daysBack: number
): Promise<number> {
  const client = axios.create({ baseURL: gammaHost });

  const now = Date.now();
  const fromTs = Math.max(SERIES_START, now - daysBack * 24 * 60 * 60 * 1000);
  // Go up to 1 hour ago to ensure markets are resolved
  const toTs = now - 60 * 60 * 1000;

  const prefix = type === "5m" ? "btc-updown-5m-" : "btc-updown-4h-";
  const timestamps = generateTimestamps(type, fromTs, toTs);

  log.info(`[${type}] Generated ${timestamps.length} timestamps to check (${daysBack} days back)`);

  // Check which slugs we already have
  const existingSlugs = new Set(
    (db.prepare("SELECT slug FROM updown_outcomes WHERE market_type = ?").all(type) as { slug: string }[])
      .map((r) => r.slug)
  );

  const slugsToFetch = timestamps
    .map((ts) => prefix + ts)
    .filter((slug) => !existingSlugs.has(slug));

  log.info(`[${type}] ${slugsToFetch.length} new markets to fetch (${existingSlugs.size} already ingested)`);

  let inserted = 0;
  let notFound = 0;
  let errors = 0;

  // Process in batches
  for (let i = 0; i < slugsToFetch.length; i += BATCH_SIZE) {
    const batch = slugsToFetch.slice(i, i + BATCH_SIZE);

    const results = await Promise.all(
      batch.map((slug) => fetchMarket(client, slug))
    );

    for (let j = 0; j < results.length; j++) {
      const market = results[j];
      const slug = batch[j];

      if (!market) {
        notFound++;
        continue;
      }

      if (market.outcome === "unknown") {
        errors++;
        continue;
      }

      // Get funding rate percentile near window start
      const frPercentile = await getNearestFundingPercentile(
        db,
        market.windowStart.getTime()
      );

      try {
        db.prepare(`
          INSERT INTO updown_outcomes(
            slug, market_type, window_start, window_end, outcome,
            btc_price_start, btc_price_end, volume,
            up_token_id, down_token_id,
            up_price_before, down_price_before, fr_percentile, ingested_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(slug) DO UPDATE SET
            outcome = excluded.outcome,
            volume = excluded.volume,
            fr_percentile = excluded.fr_percentile
        `).run(
          market.slug,
          market.marketType,
          market.windowStart.toISOString(),
          market.windowEnd.toISOString(),
          market.outcome,
          market.btcPriceStart,
          market.btcPriceEnd,
          market.volume,
          market.upTokenId,
          market.downTokenId,
          null, // up_price_before - would need CLOB history
          null, // down_price_before
          frPercentile,
          new Date().toISOString()
        );
        inserted++;
      } catch (err: any) {
        log.warn(`Failed to insert ${slug}: ${err.message}`);
        errors++;
      }
    }

    const progress = Math.min(100, ((i + BATCH_SIZE) / slugsToFetch.length) * 100).toFixed(1);
    log.info(`[${type}] Progress: ${progress}% (${inserted} inserted, ${notFound} not found)`);

    // Rate limit delay between batches
    if (i + BATCH_SIZE < slugsToFetch.length) {
      await sleep(BATCH_DELAY_MS);
    }
  }

  log.info(`[${type}] Complete: ${inserted} inserted, ${notFound} not found, ${errors} errors`);
  return inserted;
}

async function main() {
  const db = openValidationDb(validationConfig.dbPath);
  migrateValidationDb(db);

  // Parse args: --days=N (default 30)
  const daysArg = process.argv.find((a) => a.startsWith("--days="));
  const days = daysArg ? parseInt(daysArg.split("=")[1], 10) : 30;

  // Parse args: --type=5m|4h|all (default all)
  const typeArg = process.argv.find((a) => a.startsWith("--type="));
  const typeFilter = typeArg ? typeArg.split("=")[1] : "all";

  log.info(`Ingesting Up/Down markets: days=${days}, type=${typeFilter}`);

  let total = 0;

  if (typeFilter === "all" || typeFilter === "5m") {
    total += await ingestUpDownMarkets(db, "5m", days);
  }

  if (typeFilter === "all" || typeFilter === "4h") {
    total += await ingestUpDownMarkets(db, "4h", days);
  }

  log.info(`[updown] Total ingested: ${total} markets`);

  // Summary stats
  const stats = db.prepare(`
    SELECT
      market_type,
      COUNT(*) as total,
      SUM(CASE WHEN outcome = 'Up' THEN 1 ELSE 0 END) as up_wins,
      SUM(CASE WHEN outcome = 'Down' THEN 1 ELSE 0 END) as down_wins,
      AVG(volume) as avg_volume
    FROM updown_outcomes
    GROUP BY market_type
  `).all() as Array<{
    market_type: string;
    total: number;
    up_wins: number;
    down_wins: number;
    avg_volume: number;
  }>;

  console.log("\n=== Up/Down Market Statistics ===");
  for (const row of stats) {
    const upPct = ((row.up_wins / row.total) * 100).toFixed(1);
    console.log(`${row.market_type}: ${row.total} markets, Up wins: ${upPct}%, Avg volume: $${row.avg_volume.toFixed(0)}`);
  }
}

main().catch((error) => {
  const message = error instanceof Error ? error.stack || error.message : String(error);
  log.error(`Ingest failed: ${message}`);
  process.exit(1);
});
