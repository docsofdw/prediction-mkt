import axios, { AxiosInstance } from "axios";
import { MarketDiscovery } from "../../../shared/services/market-discovery";
import { GammaEvent, GammaMarket } from "../../../types";
import { validationConfig } from "./config";

export type ViolationType = "strike_monotonicity" | "time_monotonicity" | "complete_set";
export type MarketType = "5min" | "daily" | "unknown";

export interface ViolationLeg {
  token_id: string;
  market_question: string;
  strike: number | null;
  expiry: string | null;
  side: "yes";
  mid_price: number | null;
  best_bid: number | null;
  best_ask: number | null;
  bid_depth_usd: number;
  ask_depth_usd: number;
}

export interface ActiveViolation {
  violation_key: string;
  timestamp: string;
  type: ViolationType;
  leg_a: ViolationLeg;
  leg_b: ViolationLeg;
  violation_size_cents: number;
  fillable_notional_usd: number;
  btc_spot_at_detection: number | null;
  btc_1h_return_pct: number | null;
  btc_1h_realized_vol: number | null;
}

export interface MarketPriceSnapshot {
  market_id: string;
  token_id: string;
  question: string;
  best_bid: number | null;
  best_ask: number | null;
  mid_price: number | null;
  bid_depth_usd: number;
  ask_depth_usd: number;
}

export interface ScanCycleSummary {
  timestamp: string;
  active_btc_markets: number;
  total_violations_this_scan: number;
  avg_spread_cents_all_markets: number | null;
  btc_spot: number | null;
  btc_1h_return_pct: number | null;
  btc_1h_realized_vol: number | null;
  hour_of_day_utc: number;
  day_of_week: string;
}

interface BinaryMarket {
  marketId: string;
  question: string;
  yesTokenId: string;
  noTokenId: string;
}

type BookLevel = { price: string; size: string };
type OrderBook = { market: string; asset_id: string; bids: BookLevel[]; asks: BookLevel[] };

type SpotState = {
  spot: number | null;
  oneHourReturnPct: number | null;
  oneHourRealizedVol: number | null;
};

function parseMaybeJsonArray(input: unknown): string[] {
  if (Array.isArray(input)) return input.map((x) => String(x));
  if (typeof input !== "string") return [];
  try {
    const parsed = JSON.parse(input);
    return Array.isArray(parsed) ? parsed.map((x) => String(x)) : [];
  } catch {
    return [];
  }
}

function parseStrike(raw: string): number | null {
  const normalized = raw.replace(/,/g, "").trim().toLowerCase();
  if (normalized.endsWith("k")) {
    const n = Number(normalized.slice(0, -1));
    return Number.isFinite(n) ? n * 1000 : null;
  }
  const n = Number(normalized);
  return Number.isFinite(n) ? n : null;
}

function parseDeadline(question: string): string | null {
  // Match "Month DD[st/nd/rd/th][, YYYY | YYYY]" — ordinal suffix and comma before year are optional
  const datePattern = /(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\s+\d{1,2}(?:st|nd|rd|th)?(?:,?\s*\d{4})?/i;
  const match = question.match(datePattern);
  if (!match) return null;

  // Strip ordinal suffixes so Date() can parse cleanly
  let dateStr = match[0].replace(/(\d{1,2})(?:st|nd|rd|th)/i, "$1");

  // If no 4-digit year was captured, default to current UTC year (safe for live markets)
  if (!/\d{4}/.test(dateStr)) {
    dateStr = `${dateStr}, ${new Date().getUTCFullYear()}`;
  }

  const parsed = new Date(dateStr);
  if (!Number.isFinite(parsed.getTime())) return null;
  return parsed.toISOString().slice(0, 10);
}

/**
 * Detect if a question is a 5-minute Up/Down market
 * Format: "Bitcoin Up or Down - Feb 17, 3:00AM-3:05AM ET"
 */
function is5MinMarket(question: string): boolean {
  const has5MinPattern = /bitcoin\s+(?:up\s+or\s+down|updown)/i.test(question);
  const hasTimeRange = /\d{1,2}:\d{2}\s*(?:AM|PM|am|pm).*-.*\d{1,2}:\d{2}\s*(?:AM|PM|am|pm)/i.test(question);
  return has5MinPattern && hasTimeRange;
}

/**
 * Parse 5-minute market question to extract window info
 * Returns the window end time as ISO string for deadline
 */
function parse5MinQuestion(question: string): {
  direction: "up" | "down" | null;
  windowStart: string | null;
  windowEnd: string | null;
} {
  // Extract date: "Feb 17" or "February 17"
  const dateMatch = question.match(/(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\s+\d{1,2}/i);

  // Extract time range: "3:00AM-3:05AM" or "3:00 AM - 3:05 AM"
  const timeMatch = question.match(/(\d{1,2}:\d{2})\s*(AM|PM|am|pm)\s*-\s*(\d{1,2}:\d{2})\s*(AM|PM|am|pm)/i);

  if (!dateMatch || !timeMatch) {
    return { direction: null, windowStart: null, windowEnd: null };
  }

  const datePart = dateMatch[0];
  const startTime = `${timeMatch[1]} ${timeMatch[2].toUpperCase()}`;
  const endTime = `${timeMatch[3]} ${timeMatch[4].toUpperCase()}`;
  const year = new Date().getUTCFullYear();

  try {
    const windowStart = new Date(`${datePart}, ${year} ${startTime}`);
    const windowEnd = new Date(`${datePart}, ${year} ${endTime}`);

    return {
      direction: /\bup\b/i.test(question) ? "up" : "down",
      windowStart: Number.isFinite(windowStart.getTime()) ? windowStart.toISOString() : null,
      windowEnd: Number.isFinite(windowEnd.getTime()) ? windowEnd.toISOString() : null,
    };
  } catch {
    return { direction: null, windowStart: null, windowEnd: null };
  }
}

function parseQuestion(question: string): {
  direction: "above" | "below" | null;
  strike: number | null;
  hitBy: boolean;
  deadline: string | null;
  marketType: MarketType;
  fiveMinData?: {
    direction: "up" | "down" | null;
    windowStart: string | null;
    windowEnd: string | null;
  };
} {
  // Check for 5-minute market first
  if (is5MinMarket(question)) {
    const fiveMinData = parse5MinQuestion(question);
    return {
      direction: null,
      strike: null,
      hitBy: false,
      deadline: fiveMinData.windowEnd?.slice(0, 10) ?? null,
      marketType: "5min",
      fiveMinData,
    };
  }

  // Standard daily/weekly market parsing
  const q = question.toLowerCase();
  const strikeMatch = question.match(/\$?([0-9]{2,3}(?:,[0-9]{3})*(?:\.\d+)?k?)/i);
  const strike = strikeMatch ? parseStrike(strikeMatch[1]) : null;

  const isBelow = /(below|under|less than|fall to|drop to)/i.test(q);
  const isAbove = /(above|over|greater than|exceed|reach|hit|touch)/i.test(q);
  const direction = isBelow ? "below" : isAbove ? "above" : null;

  const hitBy = /(hit|reach|touch).+\bby\b|\bby\b.+(hit|reach|touch)/i.test(q);
  const deadline = parseDeadline(question);

  const marketType: MarketType = (direction && strike) ? "daily" : "unknown";

  return { direction, strike, hitBy, deadline, marketType };
}

function classifyBinaryMarket(market: GammaMarket): BinaryMarket | null {
  const tokenIds = parseMaybeJsonArray(market.clobTokenIds);
  const outcomes = parseMaybeJsonArray(market.outcomes);
  if (tokenIds.length < 2 || outcomes.length < 2) return null;

  let yesIndex = outcomes.findIndex((o) => /^yes$/i.test(o));
  let noIndex = outcomes.findIndex((o) => /^no$/i.test(o));
  if (yesIndex === -1 || noIndex === -1) {
    yesIndex = 0;
    noIndex = 1;
  }

  const yesTokenId = tokenIds[yesIndex];
  const noTokenId = tokenIds[noIndex];
  if (!yesTokenId || !noTokenId) return null;

  return {
    marketId: market.id,
    question: market.question,
    yesTokenId,
    noTokenId,
  };
}

class ClobBooks {
  private client: AxiosInstance;

  constructor(host: string) {
    this.client = axios.create({ baseURL: host, timeout: 15_000 });
  }

  async getBooks(tokenIds: string[]): Promise<Map<string, OrderBook>> {
    const map = new Map<string, OrderBook>();
    const deduped = Array.from(new Set(tokenIds)).filter(Boolean);
    const chunkSize = 100;

    for (let i = 0; i < deduped.length; i += chunkSize) {
      const chunk = deduped.slice(i, i + chunkSize);
      const payload = chunk.map((id) => ({ token_id: id }));
      const { data } = await this.client.post<OrderBook[]>("/books", payload);
      for (const book of Array.isArray(data) ? data : []) {
        map.set(book.asset_id, book);
      }
    }

    return map;
  }
}

function numberOrNull(value: unknown): number | null {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function midpoint(bestBid: number | null, bestAsk: number | null): number | null {
  if (bestBid !== null && bestAsk !== null && bestBid > 0 && bestAsk > 0) {
    return (bestBid + bestAsk) / 2;
  }
  if (bestBid !== null && bestBid > 0) return bestBid;
  if (bestAsk !== null && bestAsk > 0) return bestAsk;
  return null;
}

function calcDepthUsd(levels: BookLevel[] | undefined, priceFallback: number | null): number {
  if (!Array.isArray(levels) || levels.length === 0 || priceFallback === null) return 0;
  return levels.slice(0, 3).reduce((acc, level) => {
    const px = numberOrNull(level.price);
    const sz = numberOrNull(level.size);
    if (px === null || sz === null) return acc;
    return acc + px * sz;
  }, 0);
}

function compareByStrike(direction: "above" | "below", left: number, right: number): number {
  return direction === "above" ? left - right : right - left;
}

async function fetchBtcSpot(): Promise<number | null> {
  try {
    const { data } = await axios.get<{ bitcoin?: { usd?: number } }>(
      "https://api.coingecko.com/api/v3/simple/price",
      { params: { ids: "bitcoin", vs_currencies: "usd" }, timeout: 10_000 }
    );
    const spot = Number(data?.bitcoin?.usd);
    return Number.isFinite(spot) ? spot : null;
  } catch {
    return null;
  }
}

function utcDayName(d: Date): string {
  return ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"][d.getUTCDay()];
}

export async function runPhase1Scan(params: {
  gammaHost: string;
  clobHost: string;
  spotState: SpotState;
  include5MinMarkets?: boolean;
}): Promise<{ summary: ScanCycleSummary; activeViolations: ActiveViolation[]; marketSnapshots: MarketPriceSnapshot[]; fiveMinMarketCount: number }> {
  const { gammaHost, clobHost, spotState, include5MinMarkets = true } = params;
  const discovery = new MarketDiscovery(gammaHost);

  // Discover daily/weekly BTC markets
  const dailyEvents: GammaEvent[] = await discovery.discoverBitcoinMarkets(validationConfig.phase1.maxEvents);

  // Discover 5-minute Up/Down markets (if enabled)
  let fiveMinEvents: GammaEvent[] = [];
  if (include5MinMarkets) {
    try {
      fiveMinEvents = await discovery.discover5MinBitcoinMarkets(6);
    } catch (err) {
      console.warn("[phase1] Failed to fetch 5m markets:", err);
    }
  }

  // Combine all events
  const events: GammaEvent[] = [...dailyEvents, ...fiveMinEvents];

  const binaries = events
    .flatMap((event) => event.markets.map((market) => classifyBinaryMarket(market)))
    .filter((x): x is BinaryMarket => x !== null)
    .slice(0, validationConfig.phase1.maxMarkets);

  const books = await new ClobBooks(clobHost).getBooks(binaries.flatMap((m) => [m.yesTokenId, m.noTokenId]));

  const spreads: number[] = [];
  const semantics: Array<{
    market: BinaryMarket;
    direction: "above" | "below" | null;
    strike: number | null;
    hitBy: boolean;
    deadline: string | null;
    bestBid: number | null;
    bestAsk: number | null;
    mid: number | null;
    bidDepthUsd: number;
    askDepthUsd: number;
    marketType: MarketType;
    fiveMinData?: {
      direction: "up" | "down" | null;
      windowStart: string | null;
      windowEnd: string | null;
    };
  }> = [];

  for (const market of binaries) {
    const yesBook = books.get(market.yesTokenId);
    if (!yesBook) continue;

    const bestBid = numberOrNull(yesBook.bids?.[0]?.price);
    const bestAsk = numberOrNull(yesBook.asks?.[0]?.price);
    const mid = midpoint(bestBid, bestAsk);
    if (bestBid !== null && bestAsk !== null) {
      spreads.push(Math.abs(bestAsk - bestBid) * 100);
    }

    const parsed = parseQuestion(market.question);
    semantics.push({
      market,
      direction: parsed.direction,
      strike: parsed.strike,
      hitBy: parsed.hitBy,
      deadline: parsed.deadline,
      bestBid,
      bestAsk,
      mid,
      bidDepthUsd: calcDepthUsd(yesBook.bids, bestBid),
      askDepthUsd: calcDepthUsd(yesBook.asks, bestAsk),
      marketType: parsed.marketType,
      fiveMinData: parsed.fiveMinData,
    });
  }

  const activeViolations: ActiveViolation[] = [];
  const now = new Date();
  const ts = now.toISOString();

  const structured = semantics.filter((row) => row.direction && row.strike && row.mid !== null && row.deadline);

  const groupedByDeadline = new Map<string, Array<typeof structured[number]>>();
  for (const row of structured) {
    const key = `${row.direction}:${row.deadline}`;
    const arr = groupedByDeadline.get(key) ?? [];
    arr.push(row);
    groupedByDeadline.set(key, arr);
  }

  for (const [key, rows] of groupedByDeadline.entries()) {
    const [direction, deadline] = key.split(":") as ["above" | "below", string];
    const sorted = [...rows].sort((a, b) => compareByStrike(direction, Number(a.strike), Number(b.strike)));

    for (let i = 1; i < sorted.length; i++) {
      const left = sorted[i - 1];
      const right = sorted[i];
      const leftP = Number(left.mid);
      const rightP = Number(right.mid);

      const violation = direction === "above"
        ? rightP - leftP
        : leftP - rightP;

      if (violation > validationConfig.phase1.structuralThreshold) {
        const fillable = Math.min(left.bidDepthUsd, right.askDepthUsd);
        activeViolations.push({
          violation_key: `strike:${direction}:${deadline}:${left.market.yesTokenId}:${right.market.yesTokenId}`,
          timestamp: ts,
          type: "strike_monotonicity",
          leg_a: {
            token_id: left.market.yesTokenId,
            market_question: left.market.question,
            strike: left.strike,
            expiry: left.deadline,
            side: "yes",
            mid_price: left.mid,
            best_bid: left.bestBid,
            best_ask: left.bestAsk,
            bid_depth_usd: left.bidDepthUsd,
            ask_depth_usd: left.askDepthUsd,
          },
          leg_b: {
            token_id: right.market.yesTokenId,
            market_question: right.market.question,
            strike: right.strike,
            expiry: right.deadline,
            side: "yes",
            mid_price: right.mid,
            best_bid: right.bestBid,
            best_ask: right.bestAsk,
            bid_depth_usd: right.bidDepthUsd,
            ask_depth_usd: right.askDepthUsd,
          },
          violation_size_cents: violation * 100,
          fillable_notional_usd: fillable,
          btc_spot_at_detection: spotState.spot,
          btc_1h_return_pct: spotState.oneHourReturnPct,
          btc_1h_realized_vol: spotState.oneHourRealizedVol,
        });
      }
    }
  }

  const hitRows = structured.filter((row) => row.hitBy === true);
  const groupedByStrike = new Map<string, Array<typeof hitRows[number]>>();
  for (const row of hitRows) {
    const key = `${row.direction}:${row.strike}`;
    const arr = groupedByStrike.get(key) ?? [];
    arr.push(row);
    groupedByStrike.set(key, arr);
  }

  for (const [key, rows] of groupedByStrike.entries()) {
    const sorted = [...rows].sort((a, b) => String(a.deadline).localeCompare(String(b.deadline)));

    for (let i = 1; i < sorted.length; i++) {
      const earlier = sorted[i - 1];
      const later = sorted[i];
      const earlierP = Number(earlier.mid);
      const laterP = Number(later.mid);
      const violation = earlierP - laterP;

      if (violation > validationConfig.phase1.structuralThreshold) {
        const fillable = Math.min(earlier.bidDepthUsd, later.askDepthUsd);
        activeViolations.push({
          violation_key: `time:${key}:${earlier.deadline}:${later.deadline}:${earlier.market.yesTokenId}:${later.market.yesTokenId}`,
          timestamp: ts,
          type: "time_monotonicity",
          leg_a: {
            token_id: earlier.market.yesTokenId,
            market_question: earlier.market.question,
            strike: earlier.strike,
            expiry: earlier.deadline,
            side: "yes",
            mid_price: earlier.mid,
            best_bid: earlier.bestBid,
            best_ask: earlier.bestAsk,
            bid_depth_usd: earlier.bidDepthUsd,
            ask_depth_usd: earlier.askDepthUsd,
          },
          leg_b: {
            token_id: later.market.yesTokenId,
            market_question: later.market.question,
            strike: later.strike,
            expiry: later.deadline,
            side: "yes",
            mid_price: later.mid,
            best_bid: later.bestBid,
            best_ask: later.bestAsk,
            bid_depth_usd: later.bidDepthUsd,
            ask_depth_usd: later.askDepthUsd,
          },
          violation_size_cents: violation * 100,
          fillable_notional_usd: fillable,
          btc_spot_at_detection: spotState.spot,
          btc_1h_return_pct: spotState.oneHourReturnPct,
          btc_1h_realized_vol: spotState.oneHourRealizedVol,
        });
      }
    }
  }

  // ── Complete-set mispricing: YES_ask + NO_ask < $1.00 is a riskless buy ──
  for (const row of semantics) {
    const yesBook = books.get(row.market.yesTokenId);
    const noBook = books.get(row.market.noTokenId);
    if (!yesBook || !noBook) continue;

    const yesAsk = numberOrNull(yesBook.asks?.[0]?.price);
    const noAsk = numberOrNull(noBook.asks?.[0]?.price);
    const yesBid = numberOrNull(yesBook.bids?.[0]?.price);
    const noBid = numberOrNull(noBook.bids?.[0]?.price);

    // Buy complete set: cost to buy both sides < $1.00
    if (yesAsk !== null && noAsk !== null) {
      const buySetCost = yesAsk + noAsk;
      const edge = 1.0 - buySetCost;
      if (edge > validationConfig.phase1.structuralThreshold) {
        const fillable = Math.min(
          calcDepthUsd(yesBook.asks, yesAsk),
          calcDepthUsd(noBook.asks, noAsk)
        );
        activeViolations.push({
          violation_key: `cset:buy:${row.market.yesTokenId}:${row.market.noTokenId}`,
          timestamp: ts,
          type: "complete_set",
          leg_a: {
            token_id: row.market.yesTokenId,
            market_question: row.market.question,
            strike: row.strike,
            expiry: row.deadline,
            side: "yes",
            mid_price: row.mid,
            best_bid: yesBid,
            best_ask: yesAsk,
            bid_depth_usd: calcDepthUsd(yesBook.bids, yesBid),
            ask_depth_usd: calcDepthUsd(yesBook.asks, yesAsk),
          },
          leg_b: {
            token_id: row.market.noTokenId,
            market_question: row.market.question,
            strike: row.strike,
            expiry: row.deadline,
            side: "yes", // NO token side, but field is typed as "yes"
            mid_price: midpoint(noBid, noAsk),
            best_bid: noBid,
            best_ask: noAsk,
            bid_depth_usd: calcDepthUsd(noBook.bids, noBid),
            ask_depth_usd: calcDepthUsd(noBook.asks, noAsk),
          },
          violation_size_cents: edge * 100,
          fillable_notional_usd: fillable,
          btc_spot_at_detection: spotState.spot,
          btc_1h_return_pct: spotState.oneHourReturnPct,
          btc_1h_realized_vol: spotState.oneHourRealizedVol,
        });
      }
    }

    // Sell complete set: proceeds from selling both sides > $1.00
    if (yesBid !== null && noBid !== null) {
      const sellSetProceeds = yesBid + noBid;
      const edge = sellSetProceeds - 1.0;
      if (edge > validationConfig.phase1.structuralThreshold) {
        const fillable = Math.min(
          calcDepthUsd(yesBook.bids, yesBid),
          calcDepthUsd(noBook.bids, noBid)
        );
        activeViolations.push({
          violation_key: `cset:sell:${row.market.yesTokenId}:${row.market.noTokenId}`,
          timestamp: ts,
          type: "complete_set",
          leg_a: {
            token_id: row.market.yesTokenId,
            market_question: row.market.question,
            strike: row.strike,
            expiry: row.deadline,
            side: "yes",
            mid_price: row.mid,
            best_bid: yesBid,
            best_ask: yesAsk,
            bid_depth_usd: calcDepthUsd(yesBook.bids, yesBid),
            ask_depth_usd: calcDepthUsd(yesBook.asks, yesAsk),
          },
          leg_b: {
            token_id: row.market.noTokenId,
            market_question: row.market.question,
            strike: row.strike,
            expiry: row.deadline,
            side: "yes",
            mid_price: midpoint(noBid, noAsk),
            best_bid: noBid,
            best_ask: noAsk,
            bid_depth_usd: calcDepthUsd(noBook.bids, noBid),
            ask_depth_usd: calcDepthUsd(noBook.asks, noAsk),
          },
          violation_size_cents: edge * 100,
          fillable_notional_usd: fillable,
          btc_spot_at_detection: spotState.spot,
          btc_1h_return_pct: spotState.oneHourReturnPct,
          btc_1h_realized_vol: spotState.oneHourRealizedVol,
        });
      }
    }
  }

  const avgSpread = spreads.length === 0
    ? null
    : spreads.reduce((a, b) => a + b, 0) / spreads.length;

  // Build per-market snapshots for forward price collection (enables P3 backtest)
  const marketSnapshots: MarketPriceSnapshot[] = semantics.map((row) => ({
    market_id: row.market.marketId,
    token_id: row.market.yesTokenId,
    question: row.market.question,
    best_bid: row.bestBid,
    best_ask: row.bestAsk,
    mid_price: row.mid,
    bid_depth_usd: row.bidDepthUsd,
    ask_depth_usd: row.askDepthUsd,
  }));

  // Count 5-minute markets
  const fiveMinMarketCount = semantics.filter((s) => s.marketType === "5min").length;

  return {
    summary: {
      timestamp: ts,
      active_btc_markets: binaries.length,
      total_violations_this_scan: activeViolations.length,
      avg_spread_cents_all_markets: avgSpread,
      btc_spot: spotState.spot,
      btc_1h_return_pct: spotState.oneHourReturnPct,
      btc_1h_realized_vol: spotState.oneHourRealizedVol,
      hour_of_day_utc: now.getUTCHours(),
      day_of_week: utcDayName(now),
    },
    activeViolations,
    marketSnapshots,
    fiveMinMarketCount,
  };
}

export async function fetchSpotStateFromHistory(prices: number[]): Promise<SpotState> {
  let spot = prices.length > 0 ? prices[prices.length - 1] : null;
  if (spot === null || !Number.isFinite(spot)) {
    spot = await fetchBtcSpot();
  }

  if (prices.length < 12) {
    return { spot, oneHourReturnPct: null, oneHourRealizedVol: null };
  }

  const nowPx = prices[prices.length - 1];
  const oneHourPx = prices[prices.length - 12];
  const oneHourReturnPct = oneHourPx !== 0 ? ((nowPx - oneHourPx) / oneHourPx) * 100 : null;

  const returns: number[] = [];
  for (let i = prices.length - 12; i < prices.length; i++) {
    const prev = prices[i - 1];
    const curr = prices[i];
    if (!Number.isFinite(prev) || !Number.isFinite(curr) || prev === 0) continue;
    returns.push((curr - prev) / prev);
  }

  const mean = returns.length === 0 ? 0 : returns.reduce((a, b) => a + b, 0) / returns.length;
  const variance = returns.length < 2
    ? 0
    : returns.reduce((a, r) => a + (r - mean) ** 2, 0) / (returns.length - 1);

  const realizedVol = returns.length < 2 ? null : Math.sqrt(variance);

  return {
    spot,
    oneHourReturnPct,
    oneHourRealizedVol: realizedVol,
  };
}
