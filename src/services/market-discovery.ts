import axios, { AxiosInstance } from "axios";
import { GammaEvent, GammaMarket, MarketSnapshot } from "../types";
import { log } from "../utils/logger";

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

    // Deduplicate by event ID
    const seen = new Set<string>();
    return results.filter((e) => {
      if (seen.has(e.id)) return false;
      seen.add(e.id);
      return true;
    });
  }

  /** Find active bitcoin / crypto prediction markets */
  async discoverBitcoinMarkets(limit = 20): Promise<GammaEvent[]> {
    const keywords = ["bitcoin", "btc", "crypto"];
    const results: GammaEvent[] = [];

    for (const kw of keywords) {
      const events = await this.searchEvents(kw, limit);
      results.push(...events);
    }

    const seen = new Set<string>();
    return results.filter((e) => {
      if (seen.has(e.id)) return false;
      seen.add(e.id);
      return true;
    });
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
