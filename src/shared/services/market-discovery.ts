import axios, { AxiosInstance } from "axios";
import { GammaEvent, GammaMarket, MarketSnapshot } from "../../types";
import { log } from "../utils/logger";

// Strict keyword filters to ensure market relevance
const BITCOIN_KEYWORDS = ["bitcoin", "btc", "cryptocurrency", "crypto price", "crypto market"];
const WEATHER_KEYWORDS = ["temperature", "rainfall", "hurricane", "weather", "storm", "climate", "tornado", "flood"];

// 5-minute market detection patterns
const FIVE_MIN_SLUG_PATTERN = /^btc-updown-5m-(\d+)$/;
const FIVE_MIN_QUESTION_PATTERN = /bitcoin\s+(?:up\s+or\s+down|updown)/i;

/**
 * Check if an event is a valid Bitcoin/crypto market by examining the question text
 */
function isValidBitcoinMarket(event: GammaEvent): boolean {
  const questionLower = event.title.toLowerCase();
  const descLower = (event.description || "").toLowerCase();
  return BITCOIN_KEYWORDS.some((kw) => questionLower.includes(kw) || descLower.includes(kw));
}

/**
 * Check if an event is a valid weather market by examining the question text
 */
function isValidWeatherMarket(event: GammaEvent): boolean {
  const questionLower = event.title.toLowerCase();
  const descLower = (event.description || "").toLowerCase();
  return WEATHER_KEYWORDS.some((kw) => questionLower.includes(kw) || descLower.includes(kw));
}

/**
 * MarketDiscovery — queries the Gamma API (no auth required) to find
 * and filter prediction markets by keyword, tag, or condition ID.
 *
 * Gamma API base: https://gamma-api.polymarket.com
 */
export class MarketDiscovery {
  private client: AxiosInstance;

  constructor(gammaHost: string) {
    this.client = axios.create({ baseURL: gammaHost, timeout: 10_000 });
  }

  // ─── Search ──────────────────────────────────────────

  /** Full-text search across all events (e.g. "bitcoin", "hurricane") */
  async searchEvents(query: string, limit = 20): Promise<GammaEvent[]> {
    log.info(`Searching Gamma for: "${query}"`);
    const { data } = await this.client.get("/events", {
      params: { q: query, active: true, closed: false, limit },
    });
    return data;
  }

  /** Fetch a single event by slug (e.g. "will-bitcoin-reach-100k") */
  async getEventBySlug(slug: string): Promise<GammaEvent | null> {
    const { data } = await this.client.get("/events", {
      params: { slug },
    });
    return data?.[0] ?? null;
  }

  // ─── Filtered Discovery ──────────────────────────────

  /** Find active weather-related markets */
  async discoverWeatherMarkets(limit = 20): Promise<GammaEvent[]> {
    const keywords = ["weather", "hurricane", "temperature", "rainfall", "storm", "climate"];
    const results: GammaEvent[] = [];

    for (const kw of keywords) {
      const events = await this.searchEvents(kw, limit);
      results.push(...events);
    }

    // Deduplicate by event ID and apply strict filtering
    const seen = new Set<string>();
    return results.filter((e) => {
      if (seen.has(e.id)) return false;
      if (!isValidWeatherMarket(e)) {
        log.debug(`Filtered out non-weather market: ${e.title}`);
        return false;
      }
      seen.add(e.id);
      return true;
    });
  }

  /** Find active bitcoin / crypto prediction markets */
  async discoverBitcoinMarkets(limit = 20): Promise<GammaEvent[]> {
    // Use multiple search terms to capture BTC price target markets
    // Gamma's search ranking can bury relevant markets, so cast a wide net
    const keywords = ["bitcoin", "btc", "crypto", "bitcoin price", "bitcoin hit"];
    const results: GammaEvent[] = [];

    for (const kw of keywords) {
      const events = await this.searchEvents(kw, limit);
      results.push(...events);
    }

    // Deduplicate by event ID and apply strict filtering
    const seen = new Set<string>();
    return results.filter((e) => {
      if (seen.has(e.id)) return false;
      if (!isValidBitcoinMarket(e)) {
        log.debug(`Filtered out non-bitcoin market: ${e.title}`);
        return false;
      }
      seen.add(e.id);
      return true;
    });
  }

  /**
   * Discover 5-minute Bitcoin Up/Down markets using deterministic slug calculation.
   * These markets have predictable slugs: btc-updown-5m-{UNIX_TIMESTAMP}
   * where timestamp is always a multiple of 300 (5 minutes).
   */
  async discover5MinBitcoinMarkets(windowCount = 6): Promise<GammaEvent[]> {
    const now = Math.floor(Date.now() / 1000);
    const currentWindow = now - (now % 300); // Round down to 5-min boundary
    const events: GammaEvent[] = [];

    // Fetch current window, previous windows, and upcoming windows
    const windows: number[] = [];
    for (let i = -2; i < windowCount; i++) {
      windows.push(currentWindow + i * 300);
    }

    log.info(`[5m] Fetching ${windows.length} 5-minute BTC markets...`);

    // Fetch in parallel for speed
    const fetches = windows.map(async (windowTs) => {
      const slug = `btc-updown-5m-${windowTs}`;
      try {
        const event = await this.getEventBySlug(slug);
        if (event && event.active && !event.closed) {
          return event;
        }
      } catch (err) {
        log.debug(`[5m] Market not found for window ${windowTs}: ${slug}`);
      }
      return null;
    });

    const results = await Promise.all(fetches);
    for (const event of results) {
      if (event) events.push(event);
    }

    log.info(`[5m] Found ${events.length} active 5-minute BTC markets`);
    return events;
  }

  /**
   * Check if an event is a 5-minute Up/Down market
   */
  static is5MinMarket(event: GammaEvent): boolean {
    return FIVE_MIN_SLUG_PATTERN.test(event.slug) || FIVE_MIN_QUESTION_PATTERN.test(event.title);
  }

  /**
   * Extract window timestamp from 5-minute market slug
   */
  static get5MinWindowTimestamp(slug: string): number | null {
    const match = slug.match(FIVE_MIN_SLUG_PATTERN);
    return match ? parseInt(match[1], 10) : null;
  }

  // ─── Market Details ──────────────────────────────────
  private parseMaybeJsonArray(input: unknown): string[] {
    if (Array.isArray(input)) return input.map((x) => String(x));
    if (typeof input !== "string") return [];
    try {
      const parsed = JSON.parse(input);
      return Array.isArray(parsed) ? parsed.map((x) => String(x)) : [];
    } catch {
      return [];
    }
  }

  /** Get all markets for a given event, with basic price snapshot */
  snapshotMarkets(event: GammaEvent): MarketSnapshot[] {
    return event.markets.map((m: GammaMarket) => {
      const prices = this.parseMaybeJsonArray(m.outcomePrices).map(Number);
      const tokenIds = this.parseMaybeJsonArray(m.clobTokenIds);
      const bestBid = prices[0] ?? 0;
      const bestAsk = prices[1] ?? 0;

      return {
        tokenId: tokenIds[0] ?? "",
        conditionId: m.condition_id,
        question: m.question,
        bestBid,
        bestAsk,
        spread: Math.abs(bestAsk - bestBid),
        volume: parseFloat(m.volume) || 0,
        lastPrice: bestBid,
        timestamp: new Date(),
      };
    });
  }

  // ─── Tags ────────────────────────────────────────────

  /** List all available tags (useful for discovering categories) */
  async getTags(limit = 100): Promise<Array<{ id: number; label: string; slug: string }>> {
    const { data } = await this.client.get("/tags", { params: { limit } });
    return data;
  }
}
