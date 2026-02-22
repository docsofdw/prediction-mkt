/**
 * Complete-Set Arbitrage Scanner
 *
 * Tests the BoneReader hypothesis: are there arb opportunities where
 * yesAsk + noAsk < $1.00?
 *
 * Runs at high frequency, logs every opportunity with gap size and depth.
 * After 48 hours, analyze the data to decide if execution is worth building.
 */

import "dotenv/config";
import axios, { AxiosInstance } from "axios";
import * as fs from "fs";
import * as path from "path";
import { MarketDiscovery } from "../shared/services/market-discovery";
import { GammaEvent, GammaMarket } from "../types";
import { log } from "../shared/utils/logger";

const GAMMA_HOST = process.env.GAMMA_HOST || "https://gamma-api.polymarket.com";
const CLOB_HOST = process.env.CLOB_HOST || "https://clob.polymarket.com";

// Much lower threshold than P1 monitor - we want to see ALL opportunities
const MIN_EDGE_CENTS = 0.5; // 0.5 cent minimum
const SCAN_INTERVAL_MS = 30_000; // 30 seconds

const OUTPUT_DIR = path.join(process.cwd(), "backtests");
const LOG_FILE = path.join(OUTPUT_DIR, "complete-set-opportunities.jsonl");
const STATS_FILE = path.join(OUTPUT_DIR, "complete-set-stats.json");

interface Opportunity {
  timestamp: string;
  marketId: string;
  question: string;
  marketType: "5min" | "daily" | "other";
  direction: "buy" | "sell";
  yesTokenId: string;
  noTokenId: string;
  yesAsk: number | null;
  noAsk: number | null;
  yesBid: number | null;
  noBid: number | null;
  combinedCost: number; // for buy: yesAsk + noAsk; for sell: yesBid + noBid
  edgeCents: number;
  yesAskDepthUsd: number;
  noAskDepthUsd: number;
  fillableUsd: number;
  theoreticalProfitUsd: number;
}

interface ScanStats {
  startedAt: string;
  lastScanAt: string;
  totalScans: number;
  totalOpportunities: number;
  opportunitiesByType: { "5min": number; daily: number; other: number };
  avgEdgeCents: number;
  maxEdgeCents: number;
  avgFillableUsd: number;
  totalTheoreticalProfit: number;
}

type BookLevel = { price: string; size: string };
type OrderBook = { market: string; asset_id: string; bids: BookLevel[]; asks: BookLevel[] };

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

function is5MinMarket(question: string): boolean {
  const has5MinPattern = /bitcoin\s+(?:up\s+or\s+down|updown)/i.test(question);
  const hasTimeRange = /\d{1,2}:\d{2}\s*(?:AM|PM|am|pm).*-.*\d{1,2}:\d{2}\s*(?:AM|PM|am|pm)/i.test(question);
  return has5MinPattern && hasTimeRange;
}

function isDailyMarket(question: string): boolean {
  const hasBtc = /bitcoin|btc/i.test(question);
  const hasStrike = /\$\d+[,\d]*(?:k)?/i.test(question);
  const hasDate = /(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)\w*\s+\d{1,2}/i.test(question);
  return hasBtc && hasStrike && hasDate;
}

function classifyMarketType(question: string): "5min" | "daily" | "other" {
  if (is5MinMarket(question)) return "5min";
  if (isDailyMarket(question)) return "daily";
  return "other";
}

interface BinaryMarket {
  marketId: string;
  question: string;
  yesTokenId: string;
  noTokenId: string;
  marketType: "5min" | "daily" | "other";
}

function classifyBinaryMarket(market: GammaMarket): BinaryMarket | null {
  const tokenIds = parseMaybeJsonArray(market.clobTokenIds);
  const outcomes = parseMaybeJsonArray(market.outcomes);
  if (tokenIds.length < 2 || outcomes.length < 2) return null;

  let yesIndex = outcomes.findIndex((o) => /^yes$/i.test(o));
  let noIndex = outcomes.findIndex((o) => /^no$/i.test(o));

  // For 5-min Up/Down markets, outcomes are "Up" and "Down"
  if (yesIndex === -1 || noIndex === -1) {
    const upIndex = outcomes.findIndex((o) => /^up$/i.test(o));
    const downIndex = outcomes.findIndex((o) => /^down$/i.test(o));
    if (upIndex !== -1 && downIndex !== -1) {
      yesIndex = upIndex;
      noIndex = downIndex;
    } else {
      yesIndex = 0;
      noIndex = 1;
    }
  }

  const yesTokenId = tokenIds[yesIndex];
  const noTokenId = tokenIds[noIndex];
  if (!yesTokenId || !noTokenId) return null;

  return {
    marketId: market.id,
    question: market.question,
    yesTokenId,
    noTokenId,
    marketType: classifyMarketType(market.question),
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
      try {
        const { data } = await this.client.post<OrderBook[]>("/books", payload);
        for (const book of Array.isArray(data) ? data : []) {
          map.set(book.asset_id, book);
        }
      } catch (err) {
        log.warn(`Failed to fetch books chunk: ${err}`);
      }
    }

    return map;
  }
}

function numberOrNull(value: unknown): number | null {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function calcDepthUsd(levels: BookLevel[] | undefined): number {
  if (!Array.isArray(levels) || levels.length === 0) return 0;
  return levels.slice(0, 5).reduce((acc, level) => {
    const px = numberOrNull(level.price);
    const sz = numberOrNull(level.size);
    if (px === null || sz === null) return acc;
    return acc + px * sz;
  }, 0);
}

function loadStats(): ScanStats {
  try {
    if (fs.existsSync(STATS_FILE)) {
      return JSON.parse(fs.readFileSync(STATS_FILE, "utf8"));
    }
  } catch {}
  return {
    startedAt: new Date().toISOString(),
    lastScanAt: new Date().toISOString(),
    totalScans: 0,
    totalOpportunities: 0,
    opportunitiesByType: { "5min": 0, daily: 0, other: 0 },
    avgEdgeCents: 0,
    maxEdgeCents: 0,
    avgFillableUsd: 0,
    totalTheoreticalProfit: 0,
  };
}

function saveStats(stats: ScanStats): void {
  fs.writeFileSync(STATS_FILE, JSON.stringify(stats, null, 2));
}

function appendOpportunity(opp: Opportunity): void {
  fs.appendFileSync(LOG_FILE, JSON.stringify(opp) + "\n");
}

async function runScan(discovery: MarketDiscovery, clobBooks: ClobBooks): Promise<Opportunity[]> {
  const opportunities: Opportunity[] = [];
  const ts = new Date().toISOString();

  // Fetch all BTC markets (both daily and 5-min)
  const events: GammaEvent[] = [];

  try {
    const dailyEvents = await discovery.discoverBitcoinMarkets(100);
    events.push(...dailyEvents);
  } catch (err) {
    log.warn(`Failed to fetch daily markets: ${err}`);
  }

  try {
    const fiveMinEvents = await discovery.discover5MinBitcoinMarkets(10);
    events.push(...fiveMinEvents);
  } catch (err) {
    log.warn(`Failed to fetch 5-min markets: ${err}`);
  }

  const binaries = events
    .flatMap((event) => event.markets.map((market) => classifyBinaryMarket(market)))
    .filter((x): x is BinaryMarket => x !== null);

  if (binaries.length === 0) {
    return opportunities;
  }

  const allTokenIds = binaries.flatMap((m) => [m.yesTokenId, m.noTokenId]);
  const books = await clobBooks.getBooks(allTokenIds);

  for (const market of binaries) {
    const yesBook = books.get(market.yesTokenId);
    const noBook = books.get(market.noTokenId);
    if (!yesBook || !noBook) continue;

    const yesAsk = numberOrNull(yesBook.asks?.[0]?.price);
    const noAsk = numberOrNull(noBook.asks?.[0]?.price);
    const yesBid = numberOrNull(yesBook.bids?.[0]?.price);
    const noBid = numberOrNull(noBook.bids?.[0]?.price);

    // Check BUY arb: buy both sides for < $1.00
    if (yesAsk !== null && noAsk !== null) {
      const combinedCost = yesAsk + noAsk;
      const edgeCents = (1.0 - combinedCost) * 100;

      if (edgeCents >= MIN_EDGE_CENTS) {
        const yesAskDepthUsd = calcDepthUsd(yesBook.asks);
        const noAskDepthUsd = calcDepthUsd(noBook.asks);
        const fillableUsd = Math.min(yesAskDepthUsd, noAskDepthUsd);
        const theoreticalProfitUsd = (edgeCents / 100) * fillableUsd;

        opportunities.push({
          timestamp: ts,
          marketId: market.marketId,
          question: market.question,
          marketType: market.marketType,
          direction: "buy",
          yesTokenId: market.yesTokenId,
          noTokenId: market.noTokenId,
          yesAsk,
          noAsk,
          yesBid,
          noBid,
          combinedCost,
          edgeCents,
          yesAskDepthUsd,
          noAskDepthUsd,
          fillableUsd,
          theoreticalProfitUsd,
        });
      }
    }

    // Check SELL arb: sell both sides for > $1.00
    if (yesBid !== null && noBid !== null) {
      const combinedProceeds = yesBid + noBid;
      const edgeCents = (combinedProceeds - 1.0) * 100;

      if (edgeCents >= MIN_EDGE_CENTS) {
        const yesBidDepthUsd = calcDepthUsd(yesBook.bids);
        const noBidDepthUsd = calcDepthUsd(noBook.bids);
        const fillableUsd = Math.min(yesBidDepthUsd, noBidDepthUsd);
        const theoreticalProfitUsd = (edgeCents / 100) * fillableUsd;

        opportunities.push({
          timestamp: ts,
          marketId: market.marketId,
          question: market.question,
          marketType: market.marketType,
          direction: "sell",
          yesTokenId: market.yesTokenId,
          noTokenId: market.noTokenId,
          yesAsk,
          noAsk,
          yesBid,
          noBid,
          combinedCost: combinedProceeds,
          edgeCents,
          yesAskDepthUsd: calcDepthUsd(yesBook.asks),
          noAskDepthUsd: calcDepthUsd(noBook.asks),
          fillableUsd,
          theoreticalProfitUsd,
        });
      }
    }
  }

  return opportunities;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main() {
  // Ensure output directory exists
  if (!fs.existsSync(OUTPUT_DIR)) {
    fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  }

  const runOnce = process.argv.includes("--once");
  const showStats = process.argv.includes("--stats");

  if (showStats) {
    const stats = loadStats();
    const hoursRunning = (new Date().getTime() - new Date(stats.startedAt).getTime()) / (1000 * 60 * 60);
    const oppsPerHour = stats.totalOpportunities / Math.max(hoursRunning, 0.01);

    console.log("\n=== Complete-Set Arbitrage Scanner Stats ===\n");
    console.log(`Started:          ${stats.startedAt}`);
    console.log(`Last scan:        ${stats.lastScanAt}`);
    console.log(`Hours running:    ${hoursRunning.toFixed(1)}`);
    console.log(`Total scans:      ${stats.totalScans}`);
    console.log(`Total opps:       ${stats.totalOpportunities}`);
    console.log(`Opps/hour:        ${oppsPerHour.toFixed(1)}`);
    console.log(`Opps by type:     5min=${stats.opportunitiesByType["5min"]}, daily=${stats.opportunitiesByType.daily}, other=${stats.opportunitiesByType.other}`);
    console.log(`Avg edge:         ${stats.avgEdgeCents.toFixed(2)}¢`);
    console.log(`Max edge:         ${stats.maxEdgeCents.toFixed(2)}¢`);
    console.log(`Avg fillable:     $${stats.avgFillableUsd.toFixed(2)}`);
    console.log(`Total theo profit: $${stats.totalTheoreticalProfit.toFixed(2)}`);
    console.log(`\nData: ${LOG_FILE}`);
    return;
  }

  log.info(`[cset-scanner] Starting complete-set arbitrage scanner`);
  log.info(`[cset-scanner] Min edge: ${MIN_EDGE_CENTS}¢, interval: ${SCAN_INTERVAL_MS / 1000}s`);
  log.info(`[cset-scanner] Logging to: ${LOG_FILE}`);

  const discovery = new MarketDiscovery(GAMMA_HOST);
  const clobBooks = new ClobBooks(CLOB_HOST);
  let stats = loadStats();

  if (runOnce) {
    const opps = await runScan(discovery, clobBooks);
    for (const opp of opps) {
      appendOpportunity(opp);
      log.info(`[cset-scanner] OPPORTUNITY: ${opp.marketType} ${opp.direction} edge=${opp.edgeCents.toFixed(1)}¢ fillable=$${opp.fillableUsd.toFixed(0)}`);
    }
    log.info(`[cset-scanner] Single scan complete, found ${opps.length} opportunities`);
    return;
  }

  // Continuous loop
  while (true) {
    try {
      const opps = await runScan(discovery, clobBooks);

      stats.totalScans++;
      stats.lastScanAt = new Date().toISOString();

      for (const opp of opps) {
        appendOpportunity(opp);
        stats.totalOpportunities++;
        stats.opportunitiesByType[opp.marketType]++;
        stats.maxEdgeCents = Math.max(stats.maxEdgeCents, opp.edgeCents);
        stats.totalTheoreticalProfit += opp.theoreticalProfitUsd;

        // Rolling averages
        const n = stats.totalOpportunities;
        stats.avgEdgeCents = ((n - 1) * stats.avgEdgeCents + opp.edgeCents) / n;
        stats.avgFillableUsd = ((n - 1) * stats.avgFillableUsd + opp.fillableUsd) / n;

        log.info(
          `[cset-scanner] OPP #${n}: ${opp.marketType} ${opp.direction} ` +
          `edge=${opp.edgeCents.toFixed(1)}¢ fillable=$${opp.fillableUsd.toFixed(0)} ` +
          `[${opp.question.slice(0, 50)}...]`
        );
      }

      saveStats(stats);

      if (opps.length === 0) {
        log.debug(`[cset-scanner] scan #${stats.totalScans} - no opportunities`);
      }
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      log.error(`[cset-scanner] Scan error: ${msg}`);
    }

    await sleep(SCAN_INTERVAL_MS);
  }
}

main().catch((err) => {
  log.error(`[cset-scanner] Fatal error: ${err}`);
  process.exit(1);
});
