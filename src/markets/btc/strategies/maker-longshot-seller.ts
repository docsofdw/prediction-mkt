/**
 * Maker Longshot Seller Strategy
 *
 * Posts limit SELL orders on BTC longshot YES tokens (price < 15%).
 * Based on Becker dataset analysis showing ~2% seller edge at these levels
 * due to systematic longshot bias (low probability events are overpriced).
 *
 * Strategy:
 *   1. Scan BTC markets for YES tokens priced below threshold
 *   2. Post limit sell orders slightly above best bid
 *   3. Wait for takers to cross the spread and fill our orders
 *   4. Most longshots expire worthless → we keep premium
 *   5. Occasionally one hits → we lose (1 - price), but expected value is positive
 */

import { existsSync, readFileSync } from "fs";
import { join } from "path";
import axios from "axios";
import { TradeSignal, GammaEvent, GammaMarket } from "../../../types";
import { log } from "../../../shared/utils/logger";

// ─── Strategy Parameters ─────────────────────────────────────

interface StrategyParams {
  longshotThreshold: number;
  optimalPriceRange: { min: number; max: number };
  edgeByPriceBucket: Array<{
    priceMin: number;
    priceMax: number;
    estimatedSellerEdge: number;
    volumeAvailable: number;
    confidence: string;
  }>;
  sizing: {
    maxPositionPerMarket: number;
    maxGrossExposure: number;
    minEdgeToTrade: number;
  };
  marketFilters: {
    minDailyVolume: number;
    minDaysToExpiry: number;
    maxDaysToExpiry: number;
    preferredCategories: string[];
  };
  risk: {
    maxLossPerPosition: number;
    stopLossThreshold: number;
    correlationLimit: number;
  };
}

interface LongshotCandidate {
  tokenId: string;
  conditionId: string;
  question: string;
  currentPrice: number;
  bestBid: number;
  bestAsk: number;
  volume24h: number;
  daysToExpiry: number;
  estimatedEdge: number;
  strikePrice?: number;
  endDate: string;
}

interface OrderTarget {
  tokenId: string;
  question: string;
  sellPrice: number;
  sizeContracts: number;
  estimatedEdge: number;
  maxLossIfWrong: number;
  reason: string;
}

// ─── Default Parameters ─────────────────────────────────────

const DEFAULT_PARAMS: StrategyParams = {
  longshotThreshold: 0.20, // Only trade tokens priced below 20%
  optimalPriceRange: { min: 0.01, max: 0.20 }, // Wider range: 1-20 cents
  edgeByPriceBucket: [
    { priceMin: 0.00, priceMax: 0.05, estimatedSellerEdge: 0.018, volumeAvailable: 0, confidence: "high" },
    { priceMin: 0.05, priceMax: 0.10, estimatedSellerEdge: 0.016, volumeAvailable: 0, confidence: "high" },
    { priceMin: 0.10, priceMax: 0.15, estimatedSellerEdge: 0.014, volumeAvailable: 0, confidence: "medium" },
    { priceMin: 0.15, priceMax: 0.20, estimatedSellerEdge: 0.012, volumeAvailable: 0, confidence: "medium" },
  ],
  sizing: {
    maxPositionPerMarket: 0.10, // 10% of daily volume
    maxGrossExposure: 500, // $500 total exposure
    minEdgeToTrade: 0.005, // Need at least 0.5% edge
  },
  marketFilters: {
    minDailyVolume: 100, // $100 daily volume minimum (more permissive)
    minDaysToExpiry: 1,
    maxDaysToExpiry: 180, // Up to 180 days out (allow longer-dated markets)
    preferredCategories: ["crypto", "bitcoin", "btc"],
  },
  risk: {
    maxLossPerPosition: 50, // $50 max loss per position
    stopLossThreshold: 0.50, // Exit if price doubles
    correlationLimit: 0.30,
  },
};

// ─── Main Strategy Class ─────────────────────────────────────

export class MakerLongshotSeller {
  name = "maker-longshot-seller";
  description = "Posts limit sell orders on BTC longshot YES tokens to capture longshot bias";

  private params: StrategyParams;
  private gammaHost: string;
  private activePositions: Map<string, { quantity: number; avgPrice: number }> = new Map();

  constructor(gammaHost: string, paramsPath?: string) {
    this.gammaHost = gammaHost;
    this.params = this.loadParams(paramsPath);
  }

  private loadParams(paramsPath?: string): StrategyParams {
    const defaultPath = join(process.cwd(), "backtests/becker-reports/strategy-params.json");
    const path = paramsPath || defaultPath;

    if (existsSync(path)) {
      try {
        const data = JSON.parse(readFileSync(path, "utf-8"));
        log.info(`[maker] Loaded strategy params from ${path}`);
        return { ...DEFAULT_PARAMS, ...data };
      } catch (e) {
        log.warn(`[maker] Failed to load params from ${path}, using defaults`);
      }
    }
    return DEFAULT_PARAMS;
  }

  // ─── Market Discovery ─────────────────────────────────────

  async discoverBtcMarkets(): Promise<GammaEvent[]> {
    const keywords = ["bitcoin", "btc", "bitcoin price", "bitcoin hit"];
    const results: GammaEvent[] = [];
    const seen = new Set<string>();

    for (const kw of keywords) {
      try {
        const { data } = await axios.get(`${this.gammaHost}/events`, {
          params: { q: kw, active: true, closed: false, limit: 50 },
          timeout: 10_000,
        });

        for (const event of data) {
          if (!seen.has(event.id) && this.isBtcMarket(event)) {
            seen.add(event.id);
            results.push(event);
          }
        }
      } catch (e) {
        log.warn(`[maker] Failed to search for "${kw}": ${e}`);
      }
    }

    log.info(`[maker] Discovered ${results.length} BTC markets`);
    return results;
  }

  private isBtcMarket(event: GammaEvent): boolean {
    const text = `${event.title} ${event.description || ""}`.toLowerCase();
    return this.params.marketFilters.preferredCategories.some((cat) => text.includes(cat));
  }

  // ─── Candidate Filtering ─────────────────────────────────────

  async findLongshotCandidates(events: GammaEvent[]): Promise<LongshotCandidate[]> {
    const candidates: LongshotCandidate[] = [];
    const allCandidates: LongshotCandidate[] = [];
    const now = Date.now();

    for (const event of events) {
      for (const market of event.markets) {
        const candidate = this.extractCandidate(market, now);
        if (candidate) {
          allCandidates.push(candidate);
          if (this.passesFilters(candidate)) {
            candidates.push(candidate);
          }
        }
      }
    }

    // Log debug info about what was found vs filtered
    if (allCandidates.length > 0 && candidates.length === 0) {
      log.info(`[maker] Found ${allCandidates.length} longshots but all filtered out. Sample:`);
      for (const c of allCandidates.slice(0, 3)) {
        log.info(`  - ${c.question.slice(0, 40)}... price=${(c.currentPrice * 100).toFixed(1)}% vol=$${c.volume24h.toFixed(0)} days=${c.daysToExpiry.toFixed(0)}`);
      }
    }

    // Sort by estimated edge (highest first)
    candidates.sort((a, b) => b.estimatedEdge - a.estimatedEdge);

    log.info(`[maker] Found ${candidates.length} longshot candidates (of ${allCandidates.length} total)`);
    return candidates;
  }

  private extractCandidate(market: GammaMarket, now: number): LongshotCandidate | null {
    if (!market.active || market.closed) return null;

    // Parse prices and token IDs
    const prices = this.parseArray(market.outcomePrices).map(Number);
    const tokenIds = this.parseArray(market.clobTokenIds);

    if (prices.length < 2 || tokenIds.length < 2) return null;

    // YES token is typically first
    const yesPrice = prices[0];
    const yesTokenId = tokenIds[0];

    // Skip if not a longshot
    if (yesPrice >= this.params.longshotThreshold) return null;

    // Calculate days to expiry (handle invalid dates)
    const endDate = new Date(market.endDate);
    const endTime = endDate.getTime();
    const daysToExpiry = Number.isNaN(endTime) ? 30 : Math.max(0, (endTime - now) / (1000 * 60 * 60 * 24));

    // Estimate edge based on price bucket
    const edge = this.getEstimatedEdge(yesPrice);

    return {
      tokenId: yesTokenId,
      conditionId: market.condition_id,
      question: market.question,
      currentPrice: yesPrice,
      bestBid: yesPrice - 0.01, // Estimate
      bestAsk: yesPrice,
      volume24h: parseFloat(market.volume) || 0,
      daysToExpiry,
      estimatedEdge: edge,
      strikePrice: this.extractStrikePrice(market.question),
      endDate: market.endDate,
    };
  }

  private parseArray(input: unknown): string[] {
    if (Array.isArray(input)) return input.map(String);
    if (typeof input === "string") {
      try {
        const parsed = JSON.parse(input);
        return Array.isArray(parsed) ? parsed.map(String) : [];
      } catch {
        return [];
      }
    }
    return [];
  }

  private getEstimatedEdge(price: number): number {
    for (const bucket of this.params.edgeByPriceBucket) {
      if (price >= bucket.priceMin && price < bucket.priceMax) {
        return bucket.estimatedSellerEdge;
      }
    }
    return 0;
  }

  private extractStrikePrice(question: string): number | undefined {
    // Match patterns like "$100,000", "$95k", "100000"
    const match = question.match(/\$?([\d,]+)(?:k|K)?/);
    if (match) {
      let value = parseFloat(match[1].replace(/,/g, ""));
      if (question.toLowerCase().includes("k")) value *= 1000;
      return value;
    }
    return undefined;
  }

  private passesFilters(candidate: LongshotCandidate): boolean {
    const filters = this.params.marketFilters;

    if (candidate.daysToExpiry < filters.minDaysToExpiry) return false;
    if (candidate.daysToExpiry > filters.maxDaysToExpiry) return false;
    if (candidate.volume24h < filters.minDailyVolume) return false;
    if (candidate.estimatedEdge < this.params.sizing.minEdgeToTrade) return false;

    // Skip if price outside optimal range
    if (candidate.currentPrice < this.params.optimalPriceRange.min) return false;
    if (candidate.currentPrice > this.params.optimalPriceRange.max) return false;

    return true;
  }

  // ─── Order Generation ─────────────────────────────────────

  generateOrderTargets(candidates: LongshotCandidate[]): OrderTarget[] {
    const targets: OrderTarget[] = [];
    let totalExposure = 0;

    for (const candidate of candidates) {
      // Check gross exposure limit
      if (totalExposure >= this.params.sizing.maxGrossExposure) break;

      // Calculate position size
      const maxFromVolume = candidate.volume24h * this.params.sizing.maxPositionPerMarket;
      const maxFromLoss = this.params.risk.maxLossPerPosition / (1 - candidate.currentPrice);
      const maxFromExposure = this.params.sizing.maxGrossExposure - totalExposure;

      const sizeContracts = Math.min(maxFromVolume, maxFromLoss, maxFromExposure);
      if (sizeContracts < 10) continue; // Skip tiny positions

      // Sell price: slightly above current price to be a maker
      const sellPrice = Math.min(candidate.currentPrice + 0.01, this.params.longshotThreshold);

      const maxLoss = sizeContracts * (1 - sellPrice);

      targets.push({
        tokenId: candidate.tokenId,
        question: candidate.question,
        sellPrice,
        sizeContracts: Math.round(sizeContracts),
        estimatedEdge: candidate.estimatedEdge,
        maxLossIfWrong: maxLoss,
        reason: `Longshot sell: ${(candidate.currentPrice * 100).toFixed(1)}% price, ${(candidate.estimatedEdge * 100).toFixed(2)}% edge, ${candidate.daysToExpiry.toFixed(0)}d expiry`,
      });

      totalExposure += sizeContracts * sellPrice;
    }

    return targets;
  }

  // ─── Signal Generation (for integration with main loop) ─────

  async generateSignals(): Promise<TradeSignal[]> {
    const events = await this.discoverBtcMarkets();
    const candidates = await this.findLongshotCandidates(events);
    const targets = this.generateOrderTargets(candidates);

    return targets.map((t) => ({
      tokenId: t.tokenId,
      side: "SELL" as const,
      price: t.sellPrice,
      size: t.sizeContracts,
      reason: t.reason,
    }));
  }

  // ─── Reporting ─────────────────────────────────────────────

  async runScan(): Promise<{
    candidates: LongshotCandidate[];
    targets: OrderTarget[];
    summary: {
      marketsScanned: number;
      candidatesFound: number;
      ordersGenerated: number;
      totalExposure: number;
      avgEdge: number;
    };
  }> {
    const events = await this.discoverBtcMarkets();
    const candidates = await this.findLongshotCandidates(events);
    const targets = this.generateOrderTargets(candidates);

    const totalExposure = targets.reduce((sum, t) => sum + t.sizeContracts * t.sellPrice, 0);
    const avgEdge =
      targets.length > 0 ? targets.reduce((sum, t) => sum + t.estimatedEdge, 0) / targets.length : 0;

    return {
      candidates,
      targets,
      summary: {
        marketsScanned: events.reduce((sum, e) => sum + e.markets.length, 0),
        candidatesFound: candidates.length,
        ordersGenerated: targets.length,
        totalExposure,
        avgEdge,
      },
    };
  }
}
