/**
 * Live Up/Down Market Logger
 *
 * Purpose: Capture opening prices for new Up/Down markets to determine
 * whether the mean-reversion edge (streaks → reversal) is already priced in.
 *
 * Usage:
 *   npx ts-node src/scripts/updown-live-logger.ts [--type=5m|4h|all] [--interval=60]
 *
 * The script runs continuously, checking for new markets every [interval] seconds.
 * For each new market:
 *   1. Captures opening mid-price, spread, depth
 *   2. Records streak context (previous outcomes)
 *   3. After resolution, updates with actual outcome
 *
 * Key metric: Compare opening price vs settlement to find edge
 */

import "dotenv/config";
import axios from "axios";
import { validationConfig } from "../validation/config";
import { openValidationDb, migrateValidationDb, SqliteDatabase } from "../../../shared/validation/sqlite";
import { log } from "../../../shared/utils/logger";

const gammaHost = process.env.GAMMA_HOST || "https://gamma-api.polymarket.com";
const clobHost = process.env.CLOB_HOST || "https://clob.polymarket.com";

interface MarketData {
  slug: string;
  marketType: "5m" | "4h";
  windowStart: Date;
  windowEnd: Date;
  upTokenId: string;
  downTokenId: string;
  btcPriceStart: number | null;
}

interface BookSnapshot {
  upMid: number | null;
  downMid: number | null;
  upBid: number | null;
  upAsk: number | null;
  downBid: number | null;
  downAsk: number | null;
  spreadCents: number | null;
  bidDepth: number | null;
  askDepth: number | null;
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function getDayOfWeek(date: Date): string {
  return ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][date.getUTCDay()];
}

async function fetchActiveMarket(slug: string): Promise<MarketData | null> {
  try {
    const { data } = await axios.get(`${gammaHost}/events/slug/${slug}`, { timeout: 10000 });
    const market = data.markets?.[0];
    if (!market || market.closed) return null;

    const tokenIds: string[] = JSON.parse(market.clobTokenIds || "[]");
    return {
      slug,
      marketType: slug.includes("-5m-") ? "5m" : "4h",
      windowStart: new Date(data.startTime || market.eventStartTime),
      windowEnd: new Date(market.endDate),
      upTokenId: tokenIds[0] || "",
      downTokenId: tokenIds[1] || "",
      btcPriceStart: data.eventMetadata?.priceToBeat ?? null,
    };
  } catch {
    return null;
  }
}

async function fetchBookSnapshot(upTokenId: string, downTokenId: string): Promise<BookSnapshot> {
  const result: BookSnapshot = {
    upMid: null, downMid: null,
    upBid: null, upAsk: null,
    downBid: null, downAsk: null,
    spreadCents: null, bidDepth: null, askDepth: null,
  };

  try {
    const [upBook, downBook] = await Promise.all([
      axios.get(`${clobHost}/book`, { params: { token_id: upTokenId }, timeout: 5000 }).catch(() => null),
      axios.get(`${clobHost}/book`, { params: { token_id: downTokenId }, timeout: 5000 }).catch(() => null),
    ]);

    if (upBook?.data) {
      const bids = upBook.data.bids || [];
      const asks = upBook.data.asks || [];
      if (bids.length > 0) result.upBid = Number(bids[0].price);
      if (asks.length > 0) result.upAsk = Number(asks[0].price);
      if (result.upBid && result.upAsk) {
        result.upMid = (result.upBid + result.upAsk) / 2;
      }
      // Sum depth
      result.bidDepth = bids.reduce((sum: number, b: any) => sum + Number(b.size) * Number(b.price), 0);
      result.askDepth = asks.reduce((sum: number, a: any) => sum + Number(a.size) * Number(a.price), 0);
    }

    if (downBook?.data) {
      const bids = downBook.data.bids || [];
      const asks = downBook.data.asks || [];
      if (bids.length > 0) result.downBid = Number(bids[0].price);
      if (asks.length > 0) result.downAsk = Number(asks[0].price);
      if (result.downBid && result.downAsk) {
        result.downMid = (result.downBid + result.downAsk) / 2;
      }
    }

    if (result.upAsk && result.upBid) {
      result.spreadCents = (result.upAsk - result.upBid) * 100;
    }
  } catch (err) {
    log.warn(`Book snapshot failed: ${err instanceof Error ? err.message : err}`);
  }

  return result;
}

function getStreakInfo(db: SqliteDatabase, marketType: string, beforeTs: string): { prevOutcome: string | null; streakLength: number } {
  // Get recent outcomes for this market type
  const recent = db.prepare(`
    SELECT outcome FROM updown_outcomes
    WHERE market_type = ? AND window_start < ?
    ORDER BY window_start DESC
    LIMIT 10
  `).all(marketType, beforeTs) as Array<{ outcome: string }>;

  if (recent.length === 0) return { prevOutcome: null, streakLength: 0 };

  const prevOutcome = recent[0].outcome;
  let streakLength = 1;

  for (let i = 1; i < recent.length; i++) {
    if (recent[i].outcome === prevOutcome) {
      streakLength++;
    } else {
      break;
    }
  }

  return { prevOutcome, streakLength };
}

async function getFundingPercentile(db: SqliteDatabase): Promise<number | null> {
  const row = db.prepare(`
    SELECT fr_percentile_30d FROM phase2_funding_rates
    WHERE fr_percentile_30d IS NOT NULL
    ORDER BY timestamp DESC LIMIT 1
  `).get() as { fr_percentile_30d: number } | undefined;

  return row?.fr_percentile_30d ?? null;
}

function generateCurrentSlug(type: "5m" | "4h"): string {
  const now = Date.now();
  const intervalMs = type === "5m" ? 5 * 60 * 1000 : 4 * 60 * 60 * 1000;

  if (type === "5m") {
    const aligned = Math.floor(now / intervalMs) * intervalMs;
    return `btc-updown-5m-${aligned / 1000}`;
  } else {
    // 4h aligned to ET timezone (UTC-5)
    const etOffsetMs = 5 * 60 * 60 * 1000;
    const nowEt = now - etOffsetMs;
    const dayMs = 24 * 60 * 60 * 1000;
    const dayStart = Math.floor(nowEt / dayMs) * dayMs;
    const hourInDay = Math.floor((nowEt - dayStart) / intervalMs) * intervalMs;
    const windowStart = dayStart + hourInDay + etOffsetMs;
    return `btc-updown-4h-${windowStart / 1000}`;
  }
}

// Generate slug for market that's been open for ~2 minutes (when liquidity arrives)
function generateMatureSlug(type: "5m" | "4h"): string | null {
  const now = Date.now();
  const intervalMs = type === "5m" ? 5 * 60 * 1000 : 4 * 60 * 60 * 1000;
  const maturityDelayMs = type === "5m" ? 2 * 60 * 1000 : 15 * 60 * 1000; // 2min for 5m, 15min for 4h

  if (type === "5m") {
    const currentWindowStart = Math.floor(now / intervalMs) * intervalMs;
    const timeIntoWindow = now - currentWindowStart;

    // Only return if we're past maturity delay but before window ends
    if (timeIntoWindow >= maturityDelayMs && timeIntoWindow < intervalMs - 30000) {
      return `btc-updown-5m-${currentWindowStart / 1000}`;
    }
    return null;
  } else {
    // Similar logic for 4h
    const etOffsetMs = 5 * 60 * 60 * 1000;
    const nowEt = now - etOffsetMs;
    const dayMs = 24 * 60 * 60 * 1000;
    const dayStart = Math.floor(nowEt / dayMs) * dayMs;
    const hourInDay = Math.floor((nowEt - dayStart) / intervalMs) * intervalMs;
    const windowStart = dayStart + hourInDay + etOffsetMs;
    const timeIntoWindow = now - windowStart;

    if (timeIntoWindow >= maturityDelayMs && timeIntoWindow < intervalMs - 60000) {
      return `btc-updown-4h-${windowStart / 1000}`;
    }
    return null;
  }
}

async function logMarket(db: SqliteDatabase, market: MarketData): Promise<boolean> {
  // Check if already logged
  const existing = db.prepare("SELECT id FROM updown_live_snapshots WHERE slug = ?").get(market.slug);
  if (existing) return false;

  const book = await fetchBookSnapshot(market.upTokenId, market.downTokenId);
  const { prevOutcome, streakLength } = getStreakInfo(db, market.marketType, market.windowStart.toISOString());
  const frPercentile = await getFundingPercentile(db);

  db.prepare(`
    INSERT INTO updown_live_snapshots(
      slug, market_type, window_start, window_end,
      snapshot_ts, up_mid_price, down_mid_price,
      up_best_bid, up_best_ask, down_best_bid, down_best_ask,
      spread_cents, bid_depth_usd, ask_depth_usd,
      btc_spot, fr_percentile, hour_utc, day_of_week,
      prev_outcome, streak_length
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    market.slug,
    market.marketType,
    market.windowStart.toISOString(),
    market.windowEnd.toISOString(),
    new Date().toISOString(),
    book.upMid,
    book.downMid,
    book.upBid,
    book.upAsk,
    book.downBid,
    book.downAsk,
    book.spreadCents,
    book.bidDepth,
    book.askDepth,
    market.btcPriceStart,
    frPercentile,
    market.windowStart.getUTCHours(),
    getDayOfWeek(market.windowStart),
    prevOutcome,
    streakLength
  );

  return true;
}

async function updateSettledMarkets(db: SqliteDatabase): Promise<number> {
  // Find logged markets that don't have outcome yet
  const pending = db.prepare(`
    SELECT slug FROM updown_live_snapshots
    WHERE outcome IS NULL AND window_end < datetime('now', '-5 minutes')
  `).all() as Array<{ slug: string }>;

  let updated = 0;

  for (const { slug } of pending) {
    try {
      const { data } = await axios.get(`${gammaHost}/events/slug/${slug}`, { timeout: 10000 });
      const market = data.markets?.[0];

      if (market?.closed) {
        const outcomePrices: number[] = JSON.parse(market.outcomePrices || "[]").map(Number);
        const outcome = outcomePrices[0] === 1 ? "Up" : outcomePrices[1] === 1 ? "Down" : null;

        if (outcome) {
          db.prepare(`
            UPDATE updown_live_snapshots
            SET outcome = ?, settled_at = ?
            WHERE slug = ?
          `).run(outcome, new Date().toISOString(), slug);
          updated++;
        }
      }
    } catch {
      // Ignore errors, will retry next cycle
    }
  }

  return updated;
}

async function main() {
  const db = openValidationDb(validationConfig.dbPath);
  migrateValidationDb(db);

  const typeArg = process.argv.find(a => a.startsWith("--type="))?.split("=")[1] || "all";
  const intervalArg = process.argv.find(a => a.startsWith("--interval="))?.split("=")[1];
  const intervalSec = intervalArg ? parseInt(intervalArg, 10) : 60;

  log.info(`Live logger started: type=${typeArg}, interval=${intervalSec}s`);
  log.info("Press Ctrl+C to stop");

  let totalLogged = 0;
  let totalSettled = 0;

  while (true) {
    try {
      // Check for markets that have been open ~2 minutes (when liquidity exists)
      const types: Array<"5m" | "4h"> = typeArg === "all" ? ["5m", "4h"] : [typeArg as "5m" | "4h"];

      for (const type of types) {
        const slug = generateMatureSlug(type);
        if (!slug) continue; // Not in the right time window

        const market = await fetchActiveMarket(slug);

        if (market) {
          const logged = await logMarket(db, market);
          if (logged) {
            totalLogged++;
            log.info(`[${type}] Logged: ${slug} | BTC: ${market.btcPriceStart ? "$" + market.btcPriceStart.toFixed(0) : "N/A"}`);
          }
        }
      }

      // Update settled markets
      const settled = await updateSettledMarkets(db);
      totalSettled += settled;
      if (settled > 0) {
        log.info(`Settled ${settled} markets (total: ${totalSettled})`);
      }

      // Stats
      const stats = db.prepare(`
        SELECT
          COUNT(*) as total,
          SUM(CASE WHEN outcome IS NOT NULL THEN 1 ELSE 0 END) as settled,
          AVG(spread_cents) as avg_spread
        FROM updown_live_snapshots
      `).get() as { total: number; settled: number; avg_spread: number | null };

      if (stats.total > 0 && stats.total % 10 === 0) {
        log.info(`Stats: ${stats.total} logged, ${stats.settled} settled, avg spread: ${stats.avg_spread?.toFixed(1) || "N/A"}¢`);
      }

    } catch (err) {
      log.warn(`Cycle error: ${err instanceof Error ? err.message : err}`);
    }

    await sleep(intervalSec * 1000);
  }
}

main().catch((error) => {
  const message = error instanceof Error ? error.stack || error.message : String(error);
  log.error(`Logger failed: ${message}`);
  process.exit(1);
});
