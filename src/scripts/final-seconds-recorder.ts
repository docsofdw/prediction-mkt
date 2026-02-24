/**
 * Final Seconds Recorder
 *
 * Purpose: Capture order book state in the final seconds of 5-minute BTC markets
 * to validate whether the "buy at 98c+ with <15s remaining" strategy has liquidity.
 *
 * Key questions:
 *   1. Is there actually liquidity at 98c+ in the final 15 seconds?
 *   2. When BTC is far from target, does the high-confidence side reach 98c+?
 *   3. What's the bid/ask depth at these prices?
 *
 * Usage:
 *   npx ts-node src/scripts/final-seconds-recorder.ts [--interval=10]
 *
 * The script runs continuously, targeting snapshots at T-60s, T-30s, T-15s, T-10s, T-5s.
 */

import "dotenv/config";
import axios from "axios";
import { validationConfig } from "../markets/btc/validation/config";
import { openValidationDb, migrateValidationDb, SqliteDatabase } from "../shared/validation/sqlite";
import { log } from "../shared/utils/logger";

const gammaHost = process.env.GAMMA_HOST || "https://gamma-api.polymarket.com";
const clobHost = process.env.CLOB_HOST || "https://clob.polymarket.com";

// Target snapshot times (seconds before resolution)
const SNAPSHOT_TARGETS = [60, 30, 15, 10, 5];

// How close (in seconds) we need to be to record a snapshot
const SNAPSHOT_TOLERANCE = 3;

interface ActiveMarket {
  slug: string;
  windowStart: number; // Unix timestamp
  windowEnd: number;   // Unix timestamp
  upTokenId: string;
  downTokenId: string;
  btcTarget: number;
}

interface BookData {
  bestBid: number | null;
  bestAsk: number | null;
  bidDepth: number;
  askDepth: number;
  midPrice: number | null;
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Generate the slug for the current 5-minute window
 */
function getCurrentWindowSlug(): string {
  const nowSec = Math.floor(Date.now() / 1000);
  const windowStart = nowSec - (nowSec % 300);
  return `btc-updown-5m-${windowStart}`;
}

/**
 * Fetch active 5-minute market data
 */
async function fetchMarket(slug: string): Promise<ActiveMarket | null> {
  try {
    const { data } = await axios.get(`${gammaHost}/events/slug/${slug}`, { timeout: 10000 });
    const market = data.markets?.[0];
    if (!market || market.closed) return null;

    const tokenIds: string[] = JSON.parse(market.clobTokenIds || "[]");
    const windowTs = parseInt(slug.split("-").pop()!, 10);

    return {
      slug,
      windowStart: windowTs,
      windowEnd: windowTs + 300,
      upTokenId: tokenIds[0] || "",
      downTokenId: tokenIds[1] || "",
      btcTarget: data.eventMetadata?.priceToBeat ?? 0,
    };
  } catch {
    return null;
  }
}

/**
 * Fetch current BTC spot price from Binance
 */
async function fetchBtcSpot(): Promise<number | null> {
  try {
    const { data } = await axios.get("https://api.binance.com/api/v3/ticker/price", {
      params: { symbol: "BTCUSDT" },
      timeout: 5000,
    });
    return parseFloat(data.price);
  } catch {
    return null;
  }
}

/**
 * Fetch order book for a token
 */
async function fetchOrderBook(tokenId: string): Promise<BookData> {
  const result: BookData = {
    bestBid: null,
    bestAsk: null,
    bidDepth: 0,
    askDepth: 0,
    midPrice: null,
  };

  if (!tokenId) return result;

  try {
    const { data } = await axios.get(`${clobHost}/book`, {
      params: { token_id: tokenId },
      timeout: 5000,
    });

    const bids = data.bids || [];
    const asks = data.asks || [];

    if (bids.length > 0) {
      result.bestBid = Number(bids[0].price);
      result.bidDepth = bids.reduce(
        (sum: number, b: { price: string; size: string }) =>
          sum + Number(b.size) * Number(b.price),
        0
      );
    }

    if (asks.length > 0) {
      result.bestAsk = Number(asks[0].price);
      result.askDepth = asks.reduce(
        (sum: number, a: { price: string; size: string }) =>
          sum + Number(a.size) * Number(a.price),
        0
      );
    }

    if (result.bestBid !== null && result.bestAsk !== null) {
      result.midPrice = (result.bestBid + result.bestAsk) / 2;
    }
  } catch (err) {
    log.debug(`Failed to fetch order book for ${tokenId}: ${err instanceof Error ? err.message : err}`);
  }

  return result;
}

/**
 * Determine which side (Up or Down) is high-confidence based on BTC distance from target
 */
function getHighConfidenceSide(
  btcSpot: number,
  btcTarget: number,
  upBook: BookData,
  downBook: BookData
): { side: string | null; price: number | null; distance: number } {
  const distance = ((btcSpot - btcTarget) / btcTarget) * 100;

  // If BTC is significantly above target, UP is high confidence
  // If BTC is significantly below target, DOWN is high confidence
  if (Math.abs(distance) < 0.1) {
    // Too close to call
    return { side: null, price: null, distance };
  }

  if (distance > 0) {
    // BTC above target - UP should win
    return { side: "UP", price: upBook.midPrice, distance };
  } else {
    // BTC below target - DOWN should win
    return { side: "DOWN", price: downBook.midPrice, distance };
  }
}

/**
 * Check if we already have a snapshot for this market at this seconds_remaining
 */
function hasSnapshot(db: SqliteDatabase, slug: string, secondsRemaining: number): boolean {
  const row = db.prepare(
    "SELECT id FROM final_seconds_snapshots WHERE slug = ? AND seconds_remaining = ?"
  ).get(slug, secondsRemaining);
  return !!row;
}

/**
 * Save a snapshot to the database
 */
function saveSnapshot(
  db: SqliteDatabase,
  market: ActiveMarket,
  secondsRemaining: number,
  upBook: BookData,
  downBook: BookData,
  btcSpot: number | null
): void {
  const highConf = btcSpot && market.btcTarget
    ? getHighConfidenceSide(btcSpot, market.btcTarget, upBook, downBook)
    : { side: null, price: null, distance: 0 };

  const spread = upBook.bestAsk && upBook.bestBid
    ? (upBook.bestAsk - upBook.bestBid) * 100
    : null;

  db.prepare(`
    INSERT OR REPLACE INTO final_seconds_snapshots (
      slug, window_start, window_end, up_token_id, down_token_id,
      seconds_remaining, snapshot_ts,
      up_best_bid, up_best_ask, up_bid_depth, up_ask_depth, up_mid_price,
      down_best_bid, down_best_ask, down_bid_depth, down_ask_depth, down_mid_price,
      btc_spot, btc_target, btc_distance,
      spread_cents, high_confidence_side, high_confidence_price
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    market.slug,
    market.windowStart,
    market.windowEnd,
    market.upTokenId,
    market.downTokenId,
    secondsRemaining,
    new Date().toISOString(),
    upBook.bestBid,
    upBook.bestAsk,
    upBook.bidDepth,
    upBook.askDepth,
    upBook.midPrice,
    downBook.bestBid,
    downBook.bestAsk,
    downBook.bidDepth,
    downBook.askDepth,
    downBook.midPrice,
    btcSpot,
    market.btcTarget,
    highConf.distance,
    spread,
    highConf.side,
    highConf.price
  );
}

/**
 * Check for resolved markets and update outcomes
 */
async function updateOutcomes(db: SqliteDatabase): Promise<number> {
  // Find markets where we have snapshots but no outcome recorded
  const pending = db.prepare(`
    SELECT DISTINCT s.slug, s.window_start, s.window_end
    FROM final_seconds_snapshots s
    LEFT JOIN final_seconds_outcomes o ON s.slug = o.slug
    WHERE o.slug IS NULL
      AND s.window_end < ?
  `).all(Math.floor(Date.now() / 1000) - 60) as Array<{
    slug: string;
    window_start: number;
    window_end: number;
  }>;

  let updated = 0;

  for (const { slug, window_start, window_end } of pending) {
    try {
      const { data } = await axios.get(`${gammaHost}/events/slug/${slug}`, { timeout: 10000 });
      const market = data.markets?.[0];

      if (market?.closed) {
        const outcomePrices: number[] = JSON.parse(market.outcomePrices || "[]").map(Number);
        const outcome = outcomePrices[0] === 1 ? "UP" : outcomePrices[1] === 1 ? "DOWN" : null;

        if (outcome) {
          // Get the final snapshot data (closest to T-0)
          const finalSnap = db.prepare(`
            SELECT high_confidence_side, high_confidence_price, btc_distance
            FROM final_seconds_snapshots
            WHERE slug = ?
            ORDER BY seconds_remaining ASC
            LIMIT 1
          `).get(slug) as {
            high_confidence_side: string | null;
            high_confidence_price: number | null;
            btc_distance: number | null;
          } | undefined;

          // Get final prices from the closest snapshot
          const finalPrices = db.prepare(`
            SELECT up_mid_price, down_mid_price
            FROM final_seconds_snapshots
            WHERE slug = ?
            ORDER BY seconds_remaining ASC
            LIMIT 1
          `).get(slug) as {
            up_mid_price: number | null;
            down_mid_price: number | null;
          } | undefined;

          const highSide = finalSnap?.high_confidence_side;
          const highPrice = finalSnap?.high_confidence_price;
          const distance = finalSnap?.btc_distance ?? 0;

          db.prepare(`
            INSERT INTO final_seconds_outcomes (
              slug, window_start, window_end,
              final_up_price, final_down_price,
              final_high_side, final_high_price, btc_distance_at_final,
              outcome, resolved_at,
              high_side_won, was_98c_plus, was_sub_15s, btc_distance_25_plus
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `).run(
            slug,
            window_start,
            window_end,
            finalPrices?.up_mid_price,
            finalPrices?.down_mid_price,
            highSide,
            highPrice,
            distance,
            outcome,
            new Date().toISOString(),
            highSide === outcome ? 1 : 0,
            highPrice != null && highPrice >= 0.98 ? 1 : 0,
            1, // we're recording sub-15s data
            Math.abs(distance) >= 0.25 ? 1 : 0
          );

          updated++;
          log.info(`[OUTCOME] ${slug}: ${outcome} | High side: ${highSide} @ ${highPrice?.toFixed(2) || "N/A"}c | Won: ${highSide === outcome}`);
        }
      }
    } catch {
      // Will retry next cycle
    }
  }

  return updated;
}

/**
 * Main recording loop
 */
async function main() {
  const db = openValidationDb(validationConfig.dbPath);
  migrateValidationDb(db);

  const intervalArg = process.argv.find(a => a.startsWith("--interval="))?.split("=")[1];
  const intervalSec = intervalArg ? parseInt(intervalArg, 10) : 3;

  log.info("═══════════════════════════════════════════════════════════");
  log.info("  FINAL SECONDS RECORDER - 5-Minute BTC Markets");
  log.info("═══════════════════════════════════════════════════════════");
  log.info(`Poll interval: ${intervalSec}s`);
  log.info(`Snapshot targets: T-${SNAPSHOT_TARGETS.join("s, T-")}s`);
  log.info("Press Ctrl+C to stop");
  log.info("");

  let totalSnapshots = 0;
  let totalOutcomes = 0;

  while (true) {
    try {
      const nowSec = Math.floor(Date.now() / 1000);
      const slug = getCurrentWindowSlug();
      const windowEnd = parseInt(slug.split("-").pop()!, 10) + 300;
      const secondsRemaining = windowEnd - nowSec;

      // Only record in the final 60 seconds
      if (secondsRemaining > 0 && secondsRemaining <= 65) {
        // Find closest target
        const closestTarget = SNAPSHOT_TARGETS.find(
          t => Math.abs(secondsRemaining - t) <= SNAPSHOT_TOLERANCE
        );

        if (closestTarget && !hasSnapshot(db, slug, closestTarget)) {
          const market = await fetchMarket(slug);

          if (market) {
            const [upBook, downBook, btcSpot] = await Promise.all([
              fetchOrderBook(market.upTokenId),
              fetchOrderBook(market.downTokenId),
              fetchBtcSpot(),
            ]);

            saveSnapshot(db, market, closestTarget, upBook, downBook, btcSpot);
            totalSnapshots++;

            const highConf = btcSpot && market.btcTarget
              ? getHighConfidenceSide(btcSpot, market.btcTarget, upBook, downBook)
              : null;

            log.info(
              `[T-${closestTarget.toString().padStart(2)}s] ${slug.slice(-10)} | ` +
              `UP: ${upBook.midPrice?.toFixed(2) || "N/A"}c | ` +
              `DOWN: ${downBook.midPrice?.toFixed(2) || "N/A"}c | ` +
              `High: ${highConf?.side || "?"} @ ${highConf?.price?.toFixed(2) || "?"}c | ` +
              `BTC dist: ${highConf?.distance.toFixed(2) || "?"}%`
            );
          }
        }
      }

      // Periodically check for resolved markets
      if (nowSec % 30 < intervalSec) {
        const outcomes = await updateOutcomes(db);
        totalOutcomes += outcomes;
      }

      // Show periodic stats
      if (nowSec % 60 < intervalSec) {
        const stats = db.prepare(`
          SELECT
            COUNT(*) as snapshots,
            COUNT(DISTINCT slug) as markets
          FROM final_seconds_snapshots
        `).get() as { snapshots: number; markets: number };

        const outcomeStats = db.prepare(`
          SELECT
            COUNT(*) as total,
            SUM(high_side_won) as wins,
            SUM(was_98c_plus) as at_98c,
            AVG(final_high_price) as avg_price
          FROM final_seconds_outcomes
        `).get() as { total: number; wins: number; at_98c: number; avg_price: number | null };

        if (stats.markets > 0) {
          log.info(
            `[STATS] ${stats.snapshots} snapshots across ${stats.markets} markets | ` +
            `Outcomes: ${outcomeStats.total} (${outcomeStats.wins || 0} high-side wins) | ` +
            `At 98c+: ${outcomeStats.at_98c || 0}`
          );
        }
      }
    } catch (err) {
      log.warn(`Cycle error: ${err instanceof Error ? err.message : err}`);
    }

    await sleep(intervalSec * 1000);
  }
}

main().catch((error) => {
  const message = error instanceof Error ? error.stack || error.message : String(error);
  log.error(`Recorder failed: ${message}`);
  process.exit(1);
});
