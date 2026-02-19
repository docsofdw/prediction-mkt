import "dotenv/config";
import axios from "axios";
import { validationConfig } from "../validation/config";
import { migrateValidationDb, openValidationDb } from "../../../shared/validation/sqlite";
import { log } from "../../../shared/utils/logger";

const gammaHost = process.env.GAMMA_HOST || "https://gamma-api.polymarket.com";
const clobHost = process.env.CLOB_HOST || "https://clob.polymarket.com";
const bmBaseUrl = process.env.BM_PRO_BASE_URL || "https://api.bitcoinmagazinepro.com";
const bmKey = process.env.BITCOIN_MAGAZINE_PRO_API_KEY || "";

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

function parseStrike(question: string): number | null {
  const m = question.match(/\$?([0-9]{2,3}(?:,[0-9]{3})*(?:\.\d+)?k?)/i);
  if (!m) return null;
  const s = m[1].replace(/,/g, "").toLowerCase();
  if (s.endsWith("k")) {
    const n = Number(s.slice(0, -1));
    return Number.isFinite(n) ? n * 1000 : null;
  }
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

function parseDirection(question: string): "above" | "below" | null {
  const q = question.toLowerCase();
  if (/(below|under|less than|drop to|fall to)/i.test(q)) return "below";
  if (/(above|over|greater than|reach|hit|touch|exceed)/i.test(q)) return "above";
  return null;
}

function parseExpiry(question: string, referenceDate?: Date): string | null {
  // Match "Month DD[st/nd/rd/th][, YYYY | YYYY]" — ordinal suffix and comma before year are optional
  const datePattern = /(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\s+\d{1,2}(?:st|nd|rd|th)?(?:,?\s*\d{4})?/i;
  const match = question.match(datePattern);
  if (!match) return null;

  // Strip ordinal suffixes so Date() can parse cleanly
  let dateStr = match[0].replace(/(\d{1,2})(?:st|nd|rd|th)/i, "$1");

  // If no 4-digit year was captured, use the reference date's year (for historical markets)
  // or fall back to current UTC year
  if (!/\d{4}/.test(dateStr)) {
    const fallbackYear = referenceDate && Number.isFinite(referenceDate.getTime())
      ? referenceDate.getUTCFullYear()
      : new Date().getUTCFullYear();
    dateStr = `${dateStr}, ${fallbackYear}`;
  }

  const date = new Date(dateStr);
  if (!Number.isFinite(date.getTime())) return null;
  return date.toISOString().slice(0, 10);
}

async function getResolvedBtcMarkets(): Promise<any[]> {
  const client = axios.create({ baseURL: gammaHost, timeout: 20_000 });
  const { data } = await client.get("/markets", {
    params: {
      closed: true,
      resolved: true,
      limit: 1000,
    },
  });

  const markets = Array.isArray(data) ? data : [];
  return markets.filter((m: any) => {
    const q = String(m.question || "").toLowerCase();
    return /(bitcoin|\bbtc\b)/i.test(q);
  });
}

async function getPriceAt(clobTokenId: string, targetTsMs: number): Promise<number | null> {
  const client = axios.create({ baseURL: clobHost, timeout: 20_000 });
  const endTs = Math.floor(targetTsMs / 1000) + 3600;
  const startTs = Math.floor(targetTsMs / 1000) - 14 * 24 * 3600;

  const { data } = await client.get<{ history?: Array<{ t: number; p: number | string }> }>("/prices-history", {
    params: {
      market: clobTokenId,
      startTs,
      endTs,
      fidelity: 60,
    },
  });

  const history = Array.isArray(data?.history) ? data.history : [];
  if (history.length === 0) return null;

  let best: { dt: number; p: number } | null = null;
  for (const point of history) {
    const p = Number(point.p);
    const tMs = Number(point.t) * 1000;
    if (!Number.isFinite(p) || !Number.isFinite(tMs)) continue;
    const dt = Math.abs(tMs - targetTsMs);
    if (!best || dt < best.dt) best = { dt, p };
  }

  return best?.p ?? null;
}

function computeRollingPercentile(values: number[], index: number, window: number): number | null {
  if (index < 1) return null;
  const start = Math.max(0, index - window);
  const sample = values.slice(start, index + 1).filter((v) => Number.isFinite(v));
  if (sample.length < 5) return null;

  const current = values[index];
  const sorted = [...sample].sort((a, b) => a - b);
  let rank = 0;
  for (const value of sorted) {
    if (value <= current) rank += 1;
  }
  return (rank - 1) / Math.max(1, sorted.length - 1);
}

// ── Funding rate data sources (in priority order) ──────────────────────

interface FundingRow {
  ts: string;     // ISO timestamp
  fr: number;     // funding rate
  source: string; // exchange identifier
}

async function fetchBmProFunding(): Promise<FundingRow[]> {
  if (!bmKey) return [];
  try {
    const client = axios.create({
      baseURL: bmBaseUrl,
      timeout: 60_000, // Large response ~1.3MB
      headers: { Authorization: `Bearer ${bmKey}` },
    });
    const { data } = await client.get("/metrics/fr-average", { params: { hourly: 1 } });

    // BM Pro returns CSV format: ,exchange,funding_rate_usd,funding_rate_coin,Date,Price
    if (typeof data === "string" && data.includes("funding_rate")) {
      const lines = data.trim().split("\n");
      const header = lines[0]?.toLowerCase() || "";
      const dateIdx = header.split(",").findIndex((h) => h.trim() === "date");
      const frIdx = header.split(",").findIndex((h) => h.trim() === "funding_rate_usd");

      if (dateIdx === -1 || frIdx === -1) {
        log.warn(`BM Pro CSV header missing expected columns: ${header}`);
        return [];
      }

      const rows: FundingRow[] = [];
      for (let i = 1; i < lines.length; i++) {
        const cols = lines[i].split(",");
        const dateStr = cols[dateIdx]?.trim();
        const fr = Number(cols[frIdx]);
        if (!dateStr || !Number.isFinite(fr)) continue;

        // Parse "2023-09-01 01:00" → ISO timestamp
        const ts = new Date(dateStr.replace(" ", "T") + ":00Z").toISOString();
        rows.push({ ts, fr, source: "bm_pro" });
      }

      log.info(`[bm_pro] parsed ${rows.length} funding rate records from CSV`);
      return rows;
    }

    // Fallback: try JSON parsing
    const jsonRows: Array<{ timestamp?: string; date?: string; value?: number; fr_average?: number }> = Array.isArray(data)
      ? data
      : Array.isArray((data as any)?.data)
        ? (data as any).data
        : [];
    return jsonRows
      .map((row) => ({
        ts: String(row.timestamp || row.date || ""),
        fr: Number(row.value ?? row.fr_average),
        source: "bm_pro",
      }))
      .filter((row) => row.ts && Number.isFinite(row.fr));
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.warn(`BM Pro funding fetch failed: ${msg}`);
    return [];
  }
}

async function fetchBybitFunding(): Promise<FundingRow[]> {
  // Bybit v5 public API — no auth required, not geo-blocked in US
  // Returns max 200 rows per request; paginate backwards from now
  const all: FundingRow[] = [];
  const limit = 200;
  let endTime = Date.now();
  const maxPages = 50; // ~10k data points, ~416 days at 8h intervals

  for (let page = 0; page < maxPages; page++) {
    try {
      const { data } = await axios.get("https://api.bybit.com/v5/market/funding/history", {
        params: { category: "linear", symbol: "BTCUSDT", limit, endTime },
        timeout: 15_000,
      });

      const list: Array<{ fundingRate: string; fundingRateTimestamp: string }> =
        data?.result?.list ?? [];
      if (list.length === 0) break;

      for (const item of list) {
        const tsMs = Number(item.fundingRateTimestamp);
        const fr = Number(item.fundingRate);
        if (!Number.isFinite(tsMs) || !Number.isFinite(fr)) continue;
        all.push({
          ts: new Date(tsMs).toISOString(),
          fr,
          source: "bybit",
        });
      }

      // Move window earlier for next page
      const earliest = Math.min(...list.map((i) => Number(i.fundingRateTimestamp)));
      endTime = earliest - 1;

      if (list.length < limit) break; // no more data
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.warn(`Bybit funding fetch page ${page} failed: ${msg}`);
      break;
    }
  }

  log.info(`[bybit] fetched ${all.length} funding rate records`);
  return all;
}

async function fetchDeribitFunding(): Promise<FundingRow[]> {
  // Deribit public API — no auth required, returns 1h funding rates
  const all: FundingRow[] = [];
  const now = Date.now();
  // Fetch 90 days of history in 30-day chunks
  const chunkMs = 30 * 24 * 3600 * 1000;
  const startFrom = now - 90 * 24 * 3600 * 1000;

  for (let start = startFrom; start < now; start += chunkMs) {
    const end = Math.min(start + chunkMs, now);
    try {
      const { data } = await axios.get("https://www.deribit.com/api/v2/public/get_funding_rate_history", {
        params: { instrument_name: "BTC-PERPETUAL", start_timestamp: start, end_timestamp: end },
        timeout: 15_000,
      });

      const list: Array<{ timestamp: number; interest_8h: number }> = data?.result ?? [];
      for (const item of list) {
        if (!Number.isFinite(item.timestamp) || !Number.isFinite(item.interest_8h)) continue;
        all.push({
          ts: new Date(item.timestamp).toISOString(),
          fr: item.interest_8h,
          source: "deribit",
        });
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.warn(`Deribit funding fetch failed: ${msg}`);
      break;
    }
  }

  log.info(`[deribit] fetched ${all.length} funding rate records`);
  return all;
}

async function ingestFunding(db: ReturnType<typeof openValidationDb>): Promise<number> {
  // Try sources in priority order: BM Pro → Bybit → Deribit
  let fundingRows: FundingRow[] = [];

  log.info("[funding] attempting BM Pro...");
  fundingRows = await fetchBmProFunding();

  if (fundingRows.length === 0) {
    log.info("[funding] BM Pro unavailable, trying Bybit...");
    fundingRows = await fetchBybitFunding();
  }

  if (fundingRows.length === 0) {
    log.info("[funding] Bybit unavailable, trying Deribit...");
    fundingRows = await fetchDeribitFunding();
  }

  if (fundingRows.length === 0) {
    log.warn("[funding] all sources failed — no funding data ingested");
    return 0;
  }

  // De-duplicate and sort
  const dedupMap = new Map<string, FundingRow>();
  for (const row of fundingRows) {
    const key = row.ts.slice(0, 13); // group by hour
    if (!dedupMap.has(key)) dedupMap.set(key, row);
  }
  const parsed = Array.from(dedupMap.values()).sort((a, b) => a.ts.localeCompare(b.ts));

  log.info(`[funding] ingesting ${parsed.length} rows from ${parsed[0]?.source ?? "unknown"}`);

  const frSeries = parsed.map((x) => x.fr);
  let inserted = 0;

  for (let i = 0; i < parsed.length; i++) {
    const row = parsed[i];
    const percentile = computeRollingPercentile(frSeries, i, 24 * 30);

    db.prepare(
      `INSERT INTO phase2_funding_rates(timestamp, fr_average, fr_percentile_30d)
       VALUES (?, ?, ?)
       ON CONFLICT(timestamp) DO UPDATE SET
         fr_average = excluded.fr_average,
         fr_percentile_30d = excluded.fr_percentile_30d`
    ).run(row.ts, row.fr, percentile);
    inserted += 1;
  }

  return inserted;
}

async function ingestResolvedContracts(db: ReturnType<typeof openValidationDb>): Promise<number> {
  const markets = await getResolvedBtcMarkets();
  let inserted = 0;

  for (const market of markets) {
    const question = String(market.question || "");
    const tokenIds = parseMaybeJsonArray(market.clobTokenIds);
    const outcomes = parseMaybeJsonArray(market.outcomes);
    if (tokenIds.length === 0 || outcomes.length === 0) continue;

    let yesIndex = outcomes.findIndex((o: string) => /^yes$/i.test(o));
    if (yesIndex === -1) yesIndex = 0;

    const tokenId = tokenIds[yesIndex];
    if (!tokenId) continue;

    const strike = parseStrike(question);
    // Use market endDate as year reference for questions missing explicit years
    const marketEndDate = new Date(String(market.endDate || market.expiration || ""));
    const expiry = parseExpiry(question, marketEndDate);
    const direction = parseDirection(question);

    let settlement: number | null = null;
    const outcomePrices = parseMaybeJsonArray(market.outcomePrices).map(Number);
    if (Number.isFinite(outcomePrices[yesIndex])) {
      settlement = outcomePrices[yesIndex];
    } else if (Number.isFinite(Number(market.lastTradePrice))) {
      settlement = Number(market.lastTradePrice);
    }

    let priceAtListing: number | null = null;
    let priceAt24h: number | null = null;
    let priceAt48h: number | null = null;

    const createdAt = new Date(String(market.createdAt || market.startDate || market.endDate || ""));
    const endAt = new Date(String(market.endDate || market.expiration || ""));

    if (Number.isFinite(createdAt.getTime())) {
      priceAtListing = await getPriceAt(tokenId, createdAt.getTime() + 48 * 3600 * 1000);
    }

    if (Number.isFinite(endAt.getTime())) {
      priceAt24h = await getPriceAt(tokenId, endAt.getTime() - 24 * 3600 * 1000);
      priceAt48h = await getPriceAt(tokenId, endAt.getTime() - 48 * 3600 * 1000);
    }

    db.prepare(
      `INSERT INTO phase2_contracts(
        contract_id,
        token_id,
        question,
        strike,
        expiry,
        direction,
        settlement,
        price_at_listing,
        price_at_48h_before,
        price_at_24h_before
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(contract_id) DO UPDATE SET
        token_id = excluded.token_id,
        question = excluded.question,
        strike = excluded.strike,
        expiry = excluded.expiry,
        direction = excluded.direction,
        settlement = excluded.settlement,
        price_at_listing = excluded.price_at_listing,
        price_at_48h_before = excluded.price_at_48h_before,
        price_at_24h_before = excluded.price_at_24h_before`
    ).run(
      String(market.id),
      tokenId,
      question,
      strike,
      expiry,
      direction,
      settlement,
      priceAtListing,
      priceAt48h,
      priceAt24h
    );

    inserted += 1;
  }

  return inserted;
}

async function main() {
  const db = openValidationDb(validationConfig.dbPath);
  migrateValidationDb(db);

  const fundingRows = await ingestFunding(db);
  const contractRows = await ingestResolvedContracts(db);

  log.info(`[phase2] ingest complete fundingRows=${fundingRows} contractRows=${contractRows}`);
}

main().catch((error) => {
  const message = error instanceof Error ? error.stack || error.message : String(error);
  log.error(`Phase2 ingest failed: ${message}`);
  process.exit(1);
});
