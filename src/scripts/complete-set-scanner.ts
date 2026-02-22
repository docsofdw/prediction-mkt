/**
 * Complete-Set Arbitrage Scanner
 *
 * Tests the BoneReader hypothesis: are there arb opportunities where
 * yesAsk + noAsk < $1.00?
 *
 * Runs at high frequency, logs every opportunity with gap size and depth.
 * After 48 hours, sends detailed Telegram report with verdict.
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
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

// Much lower threshold than P1 monitor - we want to see ALL opportunities
const MIN_EDGE_CENTS = 0.5; // 0.5 cent minimum
const SCAN_INTERVAL_MS = 30_000; // 30 seconds
const REPORT_AFTER_HOURS = 48; // Send detailed report after this many hours
const INTERIM_REPORT_HOURS = 12; // Send interim updates every N hours

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
  opportunitiesByDirection: { buy: number; sell: number };
  avgEdgeCents: number;
  maxEdgeCents: number;
  minEdgeCents: number;
  avgFillableUsd: number;
  maxFillableUsd: number;
  totalTheoreticalProfit: number;
  edgeDistribution: { "0.5-1": number; "1-2": number; "2-5": number; "5+": number };
  bestOpportunities: Array<{
    timestamp: string;
    question: string;
    marketType: string;
    direction: string;
    edgeCents: number;
    fillableUsd: number;
  }>;
  lastReportSentAt: string | null;
  reportsSent: number;
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
      const loaded = JSON.parse(fs.readFileSync(STATS_FILE, "utf8"));
      // Ensure all fields exist (handle upgrades)
      return {
        startedAt: loaded.startedAt || new Date().toISOString(),
        lastScanAt: loaded.lastScanAt || new Date().toISOString(),
        totalScans: loaded.totalScans || 0,
        totalOpportunities: loaded.totalOpportunities || 0,
        opportunitiesByType: loaded.opportunitiesByType || { "5min": 0, daily: 0, other: 0 },
        opportunitiesByDirection: loaded.opportunitiesByDirection || { buy: 0, sell: 0 },
        avgEdgeCents: loaded.avgEdgeCents || 0,
        maxEdgeCents: loaded.maxEdgeCents || 0,
        minEdgeCents: loaded.minEdgeCents || 999,
        avgFillableUsd: loaded.avgFillableUsd || 0,
        maxFillableUsd: loaded.maxFillableUsd || 0,
        totalTheoreticalProfit: loaded.totalTheoreticalProfit || 0,
        edgeDistribution: loaded.edgeDistribution || { "0.5-1": 0, "1-2": 0, "2-5": 0, "5+": 0 },
        bestOpportunities: loaded.bestOpportunities || [],
        lastReportSentAt: loaded.lastReportSentAt || null,
        reportsSent: loaded.reportsSent || 0,
      };
    }
  } catch {}
  return {
    startedAt: new Date().toISOString(),
    lastScanAt: new Date().toISOString(),
    totalScans: 0,
    totalOpportunities: 0,
    opportunitiesByType: { "5min": 0, daily: 0, other: 0 },
    opportunitiesByDirection: { buy: 0, sell: 0 },
    avgEdgeCents: 0,
    maxEdgeCents: 0,
    minEdgeCents: 999,
    avgFillableUsd: 0,
    maxFillableUsd: 0,
    totalTheoreticalProfit: 0,
    edgeDistribution: { "0.5-1": 0, "1-2": 0, "2-5": 0, "5+": 0 },
    bestOpportunities: [],
    lastReportSentAt: null,
    reportsSent: 0,
  };
}

function saveStats(stats: ScanStats): void {
  fs.writeFileSync(STATS_FILE, JSON.stringify(stats, null, 2));
}

function appendOpportunity(opp: Opportunity): void {
  fs.appendFileSync(LOG_FILE, JSON.stringify(opp) + "\n");
}

// ─── Telegram Notifications ─────────────────────────────────

async function sendTelegramMessage(message: string): Promise<boolean> {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) {
    log.warn("[cset-scanner] Telegram credentials not configured");
    return false;
  }

  const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;

  try {
    const response = await axios.post(url, {
      chat_id: TELEGRAM_CHAT_ID,
      text: message,
      parse_mode: "Markdown",
      disable_web_page_preview: true,
    });

    if (response.data.ok) {
      log.info("[cset-scanner] Telegram report sent successfully");
      return true;
    } else {
      log.error(`[cset-scanner] Telegram API error: ${response.data.description}`);
      return false;
    }
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    log.error(`[cset-scanner] Failed to send Telegram message: ${msg}`);
    return false;
  }
}

function getHoursRunning(stats: ScanStats): number {
  return (new Date().getTime() - new Date(stats.startedAt).getTime()) / (1000 * 60 * 60);
}

function formatDetailedReport(stats: ScanStats, isFinal: boolean): string {
  const hoursRunning = getHoursRunning(stats);
  const oppsPerHour = stats.totalOpportunities / Math.max(hoursRunning, 0.01);
  const scansPerHour = stats.totalScans / Math.max(hoursRunning, 0.01);

  const header = isFinal
    ? `🏁 *Complete-Set Arb Scanner - FINAL REPORT*`
    : `📊 *Complete-Set Arb Scanner - ${Math.round(hoursRunning)}h Update*`;

  let msg = `${header}\n\n`;

  // Runtime stats
  msg += `⏱ *Runtime*\n`;
  msg += `• Started: ${new Date(stats.startedAt).toUTCString()}\n`;
  msg += `• Duration: ${hoursRunning.toFixed(1)} hours\n`;
  msg += `• Total scans: ${stats.totalScans.toLocaleString()} (${scansPerHour.toFixed(1)}/hr)\n\n`;

  // Opportunity summary
  msg += `🎯 *Opportunities Found*\n`;
  msg += `• Total: ${stats.totalOpportunities}\n`;
  msg += `• Rate: ${oppsPerHour.toFixed(2)}/hour\n`;

  if (stats.totalOpportunities > 0) {
    msg += `• By type: 5min=${stats.opportunitiesByType["5min"]}, daily=${stats.opportunitiesByType.daily}, other=${stats.opportunitiesByType.other}\n`;
    msg += `• By direction: buy=${stats.opportunitiesByDirection.buy}, sell=${stats.opportunitiesByDirection.sell}\n\n`;

    // Edge analysis
    msg += `💰 *Edge Analysis*\n`;
    msg += `• Average: ${stats.avgEdgeCents.toFixed(2)}¢\n`;
    msg += `• Range: ${stats.minEdgeCents.toFixed(2)}¢ - ${stats.maxEdgeCents.toFixed(2)}¢\n`;
    msg += `• Distribution:\n`;
    msg += `  0.5-1¢: ${stats.edgeDistribution["0.5-1"]} | 1-2¢: ${stats.edgeDistribution["1-2"]}\n`;
    msg += `  2-5¢: ${stats.edgeDistribution["2-5"]} | 5+¢: ${stats.edgeDistribution["5+"]}\n\n`;

    // Fillable depth
    msg += `📦 *Fillable Depth*\n`;
    msg += `• Average: $${stats.avgFillableUsd.toFixed(2)}\n`;
    msg += `• Max seen: $${stats.maxFillableUsd.toFixed(2)}\n`;
    msg += `• Total theo profit: $${stats.totalTheoreticalProfit.toFixed(2)}\n\n`;

    // Best opportunities
    if (stats.bestOpportunities.length > 0) {
      msg += `🏆 *Top Opportunities*\n`;
      for (const opp of stats.bestOpportunities.slice(0, 5)) {
        const time = new Date(opp.timestamp).toLocaleTimeString("en-US", { hour12: false });
        msg += `• ${opp.edgeCents.toFixed(1)}¢ @ $${opp.fillableUsd.toFixed(0)} (${opp.marketType} ${opp.direction})\n`;
        msg += `  _${opp.question.slice(0, 40)}..._\n`;
      }
      msg += `\n`;
    }
  } else {
    msg += `\n_No opportunities detected above ${MIN_EDGE_CENTS}¢ threshold_\n\n`;
  }

  // Verdict
  msg += `📋 *Verdict*\n`;
  if (stats.totalOpportunities === 0) {
    msg += `❌ *NO EDGE DETECTED*\n`;
    msg += `Competition has squeezed out complete-set arbs. The BoneReader strategy is no longer viable at current thresholds.\n`;
  } else if (oppsPerHour < 1) {
    msg += `⚠️ *MARGINAL EDGE*\n`;
    msg += `Only ${oppsPerHour.toFixed(2)} opps/hour. Not enough volume to justify execution infrastructure.\n`;
  } else if (stats.avgEdgeCents < 1.0) {
    msg += `⚠️ *THIN EDGE*\n`;
    msg += `Average edge ${stats.avgEdgeCents.toFixed(2)}¢ is sub-penny. Trading fees may eat profits.\n`;
  } else if (stats.avgFillableUsd < 20) {
    msg += `⚠️ *LOW DEPTH*\n`;
    msg += `Average fillable $${stats.avgFillableUsd.toFixed(0)} is too small for meaningful profit.\n`;
  } else {
    msg += `✅ *WORTH TESTING*\n`;
    msg += `${oppsPerHour.toFixed(1)} opps/hr at ${stats.avgEdgeCents.toFixed(1)}¢ avg edge. Consider building execution layer.\n`;
  }

  if (isFinal) {
    msg += `\n_Scanner complete. Run /cset:stats for full data._`;
  }

  return msg;
}

function shouldSendReport(stats: ScanStats): { send: boolean; isFinal: boolean } {
  const hoursRunning = getHoursRunning(stats);

  // Final report at 48 hours
  if (hoursRunning >= REPORT_AFTER_HOURS && stats.reportsSent === 0) {
    return { send: true, isFinal: true };
  }

  // Interim reports every N hours
  const hoursSinceLastReport = stats.lastReportSentAt
    ? (new Date().getTime() - new Date(stats.lastReportSentAt).getTime()) / (1000 * 60 * 60)
    : hoursRunning;

  if (hoursSinceLastReport >= INTERIM_REPORT_HOURS && hoursRunning < REPORT_AFTER_HOURS) {
    return { send: true, isFinal: false };
  }

  return { send: false, isFinal: false };
}

function updateStatsWithOpportunity(stats: ScanStats, opp: Opportunity): void {
  stats.totalOpportunities++;
  stats.opportunitiesByType[opp.marketType]++;
  stats.opportunitiesByDirection[opp.direction]++;
  stats.maxEdgeCents = Math.max(stats.maxEdgeCents, opp.edgeCents);
  stats.minEdgeCents = Math.min(stats.minEdgeCents, opp.edgeCents);
  stats.maxFillableUsd = Math.max(stats.maxFillableUsd, opp.fillableUsd);
  stats.totalTheoreticalProfit += opp.theoreticalProfitUsd;

  // Edge distribution
  if (opp.edgeCents >= 5) {
    stats.edgeDistribution["5+"]++;
  } else if (opp.edgeCents >= 2) {
    stats.edgeDistribution["2-5"]++;
  } else if (opp.edgeCents >= 1) {
    stats.edgeDistribution["1-2"]++;
  } else {
    stats.edgeDistribution["0.5-1"]++;
  }

  // Rolling averages
  const n = stats.totalOpportunities;
  stats.avgEdgeCents = ((n - 1) * stats.avgEdgeCents + opp.edgeCents) / n;
  stats.avgFillableUsd = ((n - 1) * stats.avgFillableUsd + opp.fillableUsd) / n;

  // Track best opportunities (keep top 10 by edge)
  stats.bestOpportunities.push({
    timestamp: opp.timestamp,
    question: opp.question,
    marketType: opp.marketType,
    direction: opp.direction,
    edgeCents: opp.edgeCents,
    fillableUsd: opp.fillableUsd,
  });
  stats.bestOpportunities.sort((a, b) => b.edgeCents - a.edgeCents);
  stats.bestOpportunities = stats.bestOpportunities.slice(0, 10);
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
  const sendReport = process.argv.includes("--report");

  if (showStats) {
    const stats = loadStats();
    const hoursRunning = getHoursRunning(stats);
    const oppsPerHour = stats.totalOpportunities / Math.max(hoursRunning, 0.01);

    console.log("\n=== Complete-Set Arbitrage Scanner Stats ===\n");
    console.log(`Started:          ${stats.startedAt}`);
    console.log(`Last scan:        ${stats.lastScanAt}`);
    console.log(`Hours running:    ${hoursRunning.toFixed(1)}`);
    console.log(`Total scans:      ${stats.totalScans}`);
    console.log(`Total opps:       ${stats.totalOpportunities}`);
    console.log(`Opps/hour:        ${oppsPerHour.toFixed(2)}`);
    console.log(`\nBy type:          5min=${stats.opportunitiesByType["5min"]}, daily=${stats.opportunitiesByType.daily}, other=${stats.opportunitiesByType.other}`);
    console.log(`By direction:     buy=${stats.opportunitiesByDirection.buy}, sell=${stats.opportunitiesByDirection.sell}`);
    console.log(`\nEdge stats:`);
    console.log(`  Average:        ${stats.avgEdgeCents.toFixed(2)}¢`);
    console.log(`  Range:          ${stats.minEdgeCents === 999 ? "N/A" : stats.minEdgeCents.toFixed(2)}¢ - ${stats.maxEdgeCents.toFixed(2)}¢`);
    console.log(`  Distribution:   0.5-1¢: ${stats.edgeDistribution["0.5-1"]} | 1-2¢: ${stats.edgeDistribution["1-2"]} | 2-5¢: ${stats.edgeDistribution["2-5"]} | 5+¢: ${stats.edgeDistribution["5+"]}`);
    console.log(`\nFillable depth:`);
    console.log(`  Average:        $${stats.avgFillableUsd.toFixed(2)}`);
    console.log(`  Max:            $${stats.maxFillableUsd.toFixed(2)}`);
    console.log(`  Total profit:   $${stats.totalTheoreticalProfit.toFixed(2)}`);

    if (stats.bestOpportunities.length > 0) {
      console.log(`\nTop opportunities:`);
      for (const opp of stats.bestOpportunities.slice(0, 5)) {
        console.log(`  ${opp.edgeCents.toFixed(1)}¢ @ $${opp.fillableUsd.toFixed(0)} (${opp.marketType} ${opp.direction}) - ${opp.question.slice(0, 40)}...`);
      }
    }

    console.log(`\nReports sent:     ${stats.reportsSent}`);
    console.log(`Last report:      ${stats.lastReportSentAt || "never"}`);
    console.log(`\nData: ${LOG_FILE}`);
    return;
  }

  if (sendReport) {
    const stats = loadStats();
    console.log("Sending Telegram report...");
    const report = formatDetailedReport(stats, false);
    const sent = await sendTelegramMessage(report);
    if (sent) {
      stats.lastReportSentAt = new Date().toISOString();
      stats.reportsSent++;
      saveStats(stats);
      console.log("Report sent successfully!");
    } else {
      console.log("Failed to send report. Check Telegram credentials.");
    }
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

  // Send startup notification
  await sendTelegramMessage(
    `🚀 *Complete-Set Arb Scanner Started*\n\n` +
    `• Min edge: ${MIN_EDGE_CENTS}¢\n` +
    `• Scan interval: ${SCAN_INTERVAL_MS / 1000}s\n` +
    `• Report after: ${REPORT_AFTER_HOURS}h\n` +
    `• Interim updates: every ${INTERIM_REPORT_HOURS}h\n\n` +
    `_Scanning for BoneReader-style complete-set arbitrage..._`
  );

  // Continuous loop
  while (true) {
    try {
      const opps = await runScan(discovery, clobBooks);

      stats.totalScans++;
      stats.lastScanAt = new Date().toISOString();

      for (const opp of opps) {
        appendOpportunity(opp);
        updateStatsWithOpportunity(stats, opp);

        log.info(
          `[cset-scanner] OPP #${stats.totalOpportunities}: ${opp.marketType} ${opp.direction} ` +
          `edge=${opp.edgeCents.toFixed(1)}¢ fillable=$${opp.fillableUsd.toFixed(0)} ` +
          `[${opp.question.slice(0, 50)}...]`
        );
      }

      saveStats(stats);

      // Check if we should send a report
      const { send, isFinal } = shouldSendReport(stats);
      if (send) {
        const report = formatDetailedReport(stats, isFinal);
        const sent = await sendTelegramMessage(report);
        if (sent) {
          stats.lastReportSentAt = new Date().toISOString();
          stats.reportsSent++;
          saveStats(stats);
        }

        if (isFinal) {
          log.info("[cset-scanner] Final report sent. Continuing to scan...");
        }
      }

      if (opps.length === 0 && stats.totalScans % 60 === 0) {
        // Log every ~30 minutes if no opps
        const hours = getHoursRunning(stats);
        log.info(`[cset-scanner] ${hours.toFixed(1)}h elapsed, ${stats.totalScans} scans, ${stats.totalOpportunities} opps`);
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
