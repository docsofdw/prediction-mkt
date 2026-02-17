import fs from "node:fs";
import path from "node:path";
import axios, { AxiosInstance } from "axios";
import { MarketDiscovery } from "../services/market-discovery";
import { GammaEvent, GammaMarket } from "../types";
import { log } from "../utils/logger";

type BookLevel = { price: string; size: string };
type OrderBook = { market: string; asset_id: string; bids: BookLevel[]; asks: BookLevel[] };

interface BinaryMarket {
  eventId: string;
  eventTitle: string;
  marketId: string;
  question: string;
  yesTokenId: string;
  noTokenId: string;
  yesLabel: string;
  noLabel: string;
}

interface ParsedQuestion {
  direction: "above" | "below" | null;
  strike: number | null;
  hitBy: boolean;
  deadline: string | null;
}

const gammaHost = process.env.GAMMA_HOST || "https://gamma-api.polymarket.com";
const clobHost = process.env.CLOB_HOST || "https://clob.polymarket.com";
const maxEvents = Number(process.env.BTC_SCAN_MAX_EVENTS || "80");
const minArbEdge = Number(process.env.BTC_SCAN_MIN_EDGE || "0.01");
const structuralThreshold = Number(process.env.BTC_SCAN_STRUCTURAL_THRESHOLD || "0.04");
const slippageBuffer = Number(process.env.BTC_SCAN_SLIPPAGE_BUFFER || "0.005");
const maxMarkets = Number(process.env.BTC_SCAN_MAX_MARKETS || "160");

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
  const datePattern = /(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\s+\d{1,2}(?:,\s*\d{4})?/i;
  const match = question.match(datePattern);
  if (!match) return null;
  const parsed = new Date(match[0]);
  if (!Number.isFinite(parsed.getTime())) return null;
  return parsed.toISOString().slice(0, 10);
}

function parseQuestion(question: string): ParsedQuestion {
  const q = question.toLowerCase();
  const strikeMatch = question.match(/\$?([0-9]{2,3}(?:,[0-9]{3})*(?:\.\d+)?k?)/i);
  const strike = strikeMatch ? parseStrike(strikeMatch[1]) : null;

  const isBelow = /(below|under|less than|fall to|drop to)/i.test(q);
  const isAbove = /(above|over|greater than|exceed|reach|hit|touch)/i.test(q);
  const direction = isBelow ? "below" : isAbove ? "above" : null;

  const hitBy = /(hit|reach|touch).+\bby\b|\bby\b.+(hit|reach|touch)/i.test(q);
  const deadline = parseDeadline(question);

  return { direction, strike, hitBy, deadline };
}

function midpointFromBook(book: OrderBook | undefined): number | null {
  if (!book) return null;
  const bestBid = Number(book.bids?.[0]?.price ?? NaN);
  const bestAsk = Number(book.asks?.[0]?.price ?? NaN);

  if (Number.isFinite(bestBid) && Number.isFinite(bestAsk) && bestBid > 0 && bestAsk > 0) {
    return (bestBid + bestAsk) / 2;
  }
  if (Number.isFinite(bestBid) && bestBid > 0) return bestBid;
  if (Number.isFinite(bestAsk) && bestAsk > 0) return bestAsk;
  return null;
}

function classifyBinaryMarket(event: GammaEvent, market: GammaMarket): BinaryMarket | null {
  const tokenIds = parseMaybeJsonArray(market.clobTokenIds);
  const outcomes = Array.isArray(market.outcomes) ? market.outcomes.map((o) => String(o)) : [];
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
    eventId: event.id,
    eventTitle: event.title,
    marketId: market.id,
    question: market.question,
    yesTokenId,
    noTokenId,
    yesLabel: outcomes[yesIndex],
    noLabel: outcomes[noIndex],
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

function compareByStrike(direction: "above" | "below", left: number, right: number): number {
  return direction === "above" ? left - right : right - left;
}

async function main() {
  log.info(`BTC inefficiency scan starting events=${maxEvents}`);
  const discovery = new MarketDiscovery(gammaHost);
  const events = await discovery.discoverBitcoinMarkets(maxEvents);

  const binaries = events
    .flatMap((event) => event.markets.map((market) => classifyBinaryMarket(event, market)))
    .filter((x): x is BinaryMarket => x !== null)
    .slice(0, maxMarkets);

  if (binaries.length === 0) {
    throw new Error("No binary BTC markets discovered");
  }

  const allTokenIds = binaries.flatMap((m) => [m.yesTokenId, m.noTokenId]);
  const books = await new ClobBooks(clobHost).getBooks(allTokenIds);

  const pairArbs: Array<Record<string, unknown>> = [];
  const pairedBids: Array<Record<string, unknown>> = [];
  const semantics: Array<Record<string, unknown>> = [];

  for (const market of binaries) {
    const yesBook = books.get(market.yesTokenId);
    const noBook = books.get(market.noTokenId);
    if (!yesBook || !noBook) continue;

    const yesAsk = Number(yesBook.asks?.[0]?.price ?? NaN);
    const noAsk = Number(noBook.asks?.[0]?.price ?? NaN);
    const yesBid = Number(yesBook.bids?.[0]?.price ?? NaN);
    const noBid = Number(noBook.bids?.[0]?.price ?? NaN);
    const yesAskSize = Number(yesBook.asks?.[0]?.size ?? 0);
    const noAskSize = Number(noBook.asks?.[0]?.size ?? 0);
    const yesBidSize = Number(yesBook.bids?.[0]?.size ?? 0);
    const noBidSize = Number(noBook.bids?.[0]?.size ?? 0);

    if (Number.isFinite(yesAsk) && Number.isFinite(noAsk)) {
      const pairCost = yesAsk + noAsk;
      const grossEdge = 1 - pairCost;
      const netEdge = grossEdge - slippageBuffer;
      if (netEdge >= minArbEdge) {
        pairArbs.push({
          tokenYes: market.yesTokenId,
          tokenNo: market.noTokenId,
          question: market.question,
          yesAsk,
          noAsk,
          pairCost,
          grossEdge,
          netEdge,
          maxSize: Math.min(yesAskSize, noAskSize),
        });
      }
    }

    if (Number.isFinite(yesBid) && Number.isFinite(noBid)) {
      const pairBid = yesBid + noBid;
      const grossEdge = pairBid - 1;
      const netEdge = grossEdge - slippageBuffer;
      if (netEdge >= minArbEdge) {
        pairedBids.push({
          tokenYes: market.yesTokenId,
          tokenNo: market.noTokenId,
          question: market.question,
          yesBid,
          noBid,
          pairBid,
          grossEdge,
          netEdge,
          maxSize: Math.min(yesBidSize, noBidSize),
        });
      }
    }

    const parsed = parseQuestion(market.question);
    const yesMid = midpointFromBook(yesBook);

    semantics.push({
      marketId: market.marketId,
      question: market.question,
      direction: parsed.direction,
      strike: parsed.strike,
      hitBy: parsed.hitBy,
      deadline: parsed.deadline,
      yesMid,
      yesTokenId: market.yesTokenId,
      noTokenId: market.noTokenId,
    });
  }

  const structured = semantics.filter((row) => row.direction && row.strike && row.yesMid !== null && row.deadline);

  const strikeViolations: Array<Record<string, unknown>> = [];
  const groupedByDeadline = new Map<string, Array<typeof structured[number]>>();

  for (const row of structured) {
    const key = `${row.direction}:${row.deadline}`;
    const arr = groupedByDeadline.get(key) ?? [];
    arr.push(row);
    groupedByDeadline.set(key, arr);
  }

  for (const [key, rows] of groupedByDeadline.entries()) {
    const [direction] = key.split(":") as ["above" | "below", string];
    const sorted = [...rows].sort((a, b) => compareByStrike(direction, Number(a.strike), Number(b.strike)));

    for (let i = 1; i < sorted.length; i++) {
      const left = sorted[i - 1];
      const right = sorted[i];
      const leftP = Number(left.yesMid);
      const rightP = Number(right.yesMid);

      const violation = direction === "above"
        ? rightP - leftP
        : leftP - rightP;

      if (violation > structuralThreshold) {
        strikeViolations.push({
          direction,
          deadline: left.deadline,
          left: { strike: left.strike, prob: leftP, question: left.question },
          right: { strike: right.strike, prob: rightP, question: right.question },
          violation,
        });
      }
    }
  }

  const timeViolations: Array<Record<string, unknown>> = [];
  const hitRows = structured.filter((row) => row.hitBy === true);
  const groupedByStrike = new Map<string, Array<typeof hitRows[number]>>();

  for (const row of hitRows) {
    const key = `${row.direction}:${row.strike}`;
    const arr = groupedByStrike.get(key) ?? [];
    arr.push(row);
    groupedByStrike.set(key, arr);
  }

  for (const [key, rows] of groupedByStrike.entries()) {
    const sorted = [...rows]
      .filter((r) => typeof r.deadline === "string")
      .sort((a, b) => String(a.deadline).localeCompare(String(b.deadline)));

    for (let i = 1; i < sorted.length; i++) {
      const earlier = sorted[i - 1];
      const later = sorted[i];
      const earlierP = Number(earlier.yesMid);
      const laterP = Number(later.yesMid);
      const violation = earlierP - laterP;

      if (violation > structuralThreshold) {
        timeViolations.push({
          key,
          earlier: { deadline: earlier.deadline, prob: earlierP, question: earlier.question },
          later: { deadline: later.deadline, prob: laterP, question: later.question },
          violation,
        });
      }
    }
  }

  pairArbs.sort((a, b) => Number(b.netEdge) - Number(a.netEdge));
  pairedBids.sort((a, b) => Number(b.netEdge) - Number(a.netEdge));
  strikeViolations.sort((a, b) => Number(b.violation) - Number(a.violation));
  timeViolations.sort((a, b) => Number(b.violation) - Number(a.violation));

  const output = {
    generatedAt: new Date().toISOString(),
    config: {
      maxEvents,
      maxMarkets,
      minArbEdge,
      structuralThreshold,
      slippageBuffer,
    },
    universe: {
      events: events.length,
      binaryMarkets: binaries.length,
      booksLoaded: books.size,
    },
    opportunities: {
      completeSetBuyArbs: pairArbs.slice(0, 50),
      completeSetBidDislocations: pairedBids.slice(0, 50),
      strikeMonotonicityViolations: strikeViolations.slice(0, 80),
      hitByTimeMonotonicityViolations: timeViolations.slice(0, 80),
    },
  };

  const outputDir = path.resolve(process.cwd(), "backtests");
  const outputPath = path.join(outputDir, "btc-inefficiencies-latest.json");
  fs.mkdirSync(outputDir, { recursive: true });
  fs.writeFileSync(outputPath, JSON.stringify(output, null, 2));

  log.info(
    `BTC scan done markets=${binaries.length} buyArbs=${pairArbs.length} bidDislocations=${pairedBids.length} strikeViolations=${strikeViolations.length} timeViolations=${timeViolations.length}`
  );
  log.info(`Wrote inefficiency report: ${outputPath}`);
}

main().catch((error) => {
  const message = error instanceof Error ? error.stack || error.message : String(error);
  log.error(`BTC inefficiency scan failed: ${message}`);
  process.exit(1);
});
