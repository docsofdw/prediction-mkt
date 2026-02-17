import fs from "node:fs";
import path from "node:path";
import { BacktestStrategy, PositionSide, PriceBar } from "../backtesting/types";
import { computeMarketProfile, profileBucket } from "../backtesting/idea-factory";
import { BitcoinBreakoutStrategy } from "./backtest/bitcoin-breakout";
import { BitcoinMomentumStrategy } from "./backtest/bitcoin-momentum";
import { BitcoinRegimeTrendStrategy } from "./backtest/bitcoin-regime-trend";
import { WeatherDriftTrendStrategy } from "./backtest/weather-drift-trend";
import { WeatherMeanReversionStrategy } from "./backtest/weather-mean-reversion";
import { WeatherRangeReversionStrategy } from "./backtest/weather-range-reversion";
import { MarketSnapshot, Strategy, TradeSignal } from "../types";
import { log } from "../utils/logger";

type MarketType = "bitcoin" | "weather";

type PortfolioEntry = {
  marketType: MarketType;
  tokenId: string;
  family: string;
  algoId: string;
  params: unknown;
  score: number;
  targetWeight: number;
};

type MarketRun = {
  marketType: MarketType;
  tokenId: string;
  question: string;
  topAlgos: Array<{
    id: string;
    family: string;
    params: unknown;
    score: number;
  }>;
};

type IdeaFactoryFile = {
  generatedAt?: string;
  results?: {
    bitcoin?: MarketRun[];
    weather?: MarketRun[];
    portfolio?: PortfolioEntry[];
  };
  memoryHints?: Array<{
    tokenId: string;
    regimeBucket: string;
    leaderboard?: Array<{ family: string; avgScore: number; winRate: number }>;
  }>;
};

type TokenAlgo = {
  tokenId: string;
  marketType: MarketType;
  family: string;
  algoId: string;
  params: unknown;
  score: number;
  weight: number;
  question?: string;
};

type StrategyState = {
  history: PriceBar[];
  positionUnits: number;
  lastSignalAt: number;
  lastSelection?: {
    at: string;
    bucket: string;
    algoId: string;
    family: string;
    blendedScore: number;
  };
};

function toNumber(value: unknown, fallback: number): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function normalizeWeight(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return 0;
  return value;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function familyBias(params: {
  family: string;
  marketType: MarketType;
  profileBucketValue: string;
}): number {
  const { family, marketType, profileBucketValue } = params;
  const trendHigh = profileBucketValue.includes("trend-high");
  const mrHigh = profileBucketValue.includes("mr-high");
  const volHigh = profileBucketValue.includes("vol-high");

  if (marketType === "bitcoin") {
    if (family === "btc-breakout") {
      if (trendHigh && volHigh) return 1.35;
      if (trendHigh) return 1.2;
      return 0.9;
    }

    if (family === "btc-regime-trend") {
      if (trendHigh && !volHigh) return 1.25;
      if (trendHigh) return 1.15;
      return 0.85;
    }

    if (family === "btc-momentum") {
      if (trendHigh) return 1.2;
      if (mrHigh) return 0.8;
      return 1.0;
    }
  }

  if (marketType === "weather") {
    if (family === "weather-mean-reversion" || family === "weather-range-reversion") {
      if (mrHigh && !volHigh) return 1.35;
      if (mrHigh) return 1.15;
      return 0.85;
    }

    if (family === "weather-drift-trend") {
      if (trendHigh) return 1.25;
      return 0.9;
    }
  }

  return 1.0;
}

function buildStrategyFromFamily(family: string, params: unknown): BacktestStrategy | null {
  if (!isObject(params)) return null;

  if (family === "btc-momentum") {
    return BitcoinMomentumStrategy.fromParams({
      shortWindow: toNumber(params.shortWindow, 8),
      longWindow: toNumber(params.longWindow, 32),
      threshold: toNumber(params.threshold, 0.008),
    });
  }

  if (family === "btc-breakout") {
    return BitcoinBreakoutStrategy.fromParams({
      breakoutWindow: toNumber(params.breakoutWindow, 28),
      confirmWindow: toNumber(params.confirmWindow, 8),
      volatilityFloor: toNumber(params.volatilityFloor, 0.008),
      stopToFlat: toNumber(params.stopToFlat, 0.02),
    });
  }

  if (family === "btc-regime-trend") {
    return BitcoinRegimeTrendStrategy.fromParams({
      trendWindow: toNumber(params.trendWindow, 48),
      triggerWindow: toNumber(params.triggerWindow, 12),
      rsiPeriod: toNumber(params.rsiPeriod, 12),
      rsiLongMin: toNumber(params.rsiLongMin, 56),
      rsiShortMax: toNumber(params.rsiShortMax, 44),
      volatilityCap: toNumber(params.volatilityCap, 0.03),
    });
  }

  if (family === "weather-mean-reversion") {
    return WeatherMeanReversionStrategy.fromParams({
      window: toNumber(params.window, 32),
      zEntry: toNumber(params.zEntry, 1.2),
      zExit: toNumber(params.zExit, 0.3),
    });
  }

  if (family === "weather-range-reversion") {
    return WeatherRangeReversionStrategy.fromParams({
      window: toNumber(params.window, 36),
      zEntry: toNumber(params.zEntry, 1.4),
      zExit: toNumber(params.zExit, 0.35),
      volatilityCeiling: toNumber(params.volatilityCeiling, 0.05),
    });
  }

  if (family === "weather-drift-trend") {
    return WeatherDriftTrendStrategy.fromParams({
      trendWindow: toNumber(params.trendWindow, 36),
      triggerWindow: toNumber(params.triggerWindow, 8),
      minSlope: toNumber(params.minSlope, 0.001),
      maxDistance: toNumber(params.maxDistance, 0.03),
    });
  }

  return null;
}

export class MetaAllocatorLiveStrategy implements Strategy {
  name = "meta-allocator-live";
  description = "Regime-aware allocator driven by idea-factory outputs";

  private tokenAlgos = new Map<string, TokenAlgo[]>();
  private tokenState = new Map<string, StrategyState>();
  private memoryBoost = new Map<string, Map<string, number>>();

  private lastReloadAt = 0;
  private lastFileMtime = 0;

  constructor(
    private readonly options: {
      tradeSize: number;
      ideaFactoryPath: string;
      minBars: number;
      reloadMs: number;
      signalCooldownMs: number;
    }
  ) {}

  async initialize(): Promise<void> {
    this.reloadFromDisk(true);
    log.info(`[${this.name}] initialized with ideaFactoryPath=${this.options.ideaFactoryPath}`);
  }

  async evaluate(snapshot: MarketSnapshot): Promise<TradeSignal[]> {
    this.reloadFromDisk();

    const tokenPlan = this.tokenAlgos.get(snapshot.tokenId);
    if (!tokenPlan || tokenPlan.length === 0) return [];

    const state = this.tokenState.get(snapshot.tokenId) ?? {
      history: [],
      positionUnits: 0,
      lastSignalAt: 0,
    };

    const px = snapshot.lastPrice > 0 ? snapshot.lastPrice : (snapshot.bestBid + snapshot.bestAsk) / 2;
    if (!Number.isFinite(px) || px <= 0) return [];

    state.history.push({ timestamp: Date.now(), price: px });
    if (state.history.length > 500) {
      state.history = state.history.slice(-500);
    }
    this.tokenState.set(snapshot.tokenId, state);

    if (state.history.length < this.options.minBars) return [];
    if (Date.now() - state.lastSignalAt < this.options.signalCooldownMs) return [];

    const profile = computeMarketProfile(state.history);
    const bucket = `${tokenPlan[0].marketType}:${profileBucket(profile)}`;
    const memoryBoost = this.memoryBoost.get(bucket) ?? new Map<string, number>();

    const scored = tokenPlan
      .map((algo) => {
        const bias = familyBias({
          family: algo.family,
          marketType: algo.marketType,
          profileBucketValue: bucket,
        });
        const boost = memoryBoost.get(algo.family) ?? 1;
        return {
          algo,
          blendedScore: algo.score * Math.max(0.1, algo.weight) * bias * boost,
          strategy: buildStrategyFromFamily(algo.family, algo.params),
        };
      })
      .filter((x) => x.strategy !== null)
      .sort((a, b) => b.blendedScore - a.blendedScore);

    const active = scored[0];
    if (!active || !active.strategy) return [];
    state.lastSelection = {
      at: new Date().toISOString(),
      bucket,
      algoId: active.algo.algoId,
      family: active.algo.family,
      blendedScore: active.blendedScore,
    };

    const currentPositionSide: PositionSide =
      state.positionUnits > 0 ? 1 : state.positionUnits < 0 ? -1 : 0;
    const index = state.history.length - 1;

    if (index < active.strategy.warmupBars) return [];

    const signal = active.strategy.getSignal(state.history, index, currentPositionSide);
    if (!signal) return [];

    const targetUnits = signal.targetPosition * this.sizeForWeight(active.algo.weight);
    const delta = targetUnits - state.positionUnits;
    if (Math.abs(delta) < 1e-9) return [];

    const side = delta > 0 ? "BUY" : "SELL";
    const size = Math.abs(delta);
    const price = side === "BUY"
      ? (snapshot.bestAsk > 0 ? snapshot.bestAsk : px)
      : (snapshot.bestBid > 0 ? snapshot.bestBid : px);

    state.positionUnits = targetUnits;
    state.lastSignalAt = Date.now();
    this.tokenState.set(snapshot.tokenId, state);

    return [{
      tokenId: snapshot.tokenId,
      side,
      size,
      price,
      reason: `${signal.reason} | algo=${active.algo.algoId} family=${active.algo.family} bucket=${bucket}`,
    }];
  }

  async teardown(): Promise<void> {
    return;
  }

  getDiagnostics(): unknown {
    const tokenPlans = Array.from(this.tokenAlgos.entries()).slice(0, 80).map(([tokenId, algos]) => ({
      tokenId,
      topFamilies: algos.slice(0, 3).map((a) => ({
        family: a.family,
        algoId: a.algoId,
        weight: a.weight,
        score: a.score,
      })),
    }));

    const stateSample = Array.from(this.tokenState.entries()).slice(0, 80).map(([tokenId, state]) => ({
      tokenId,
      historyBars: state.history.length,
      positionUnits: state.positionUnits,
      lastSignalAt: state.lastSignalAt ? new Date(state.lastSignalAt).toISOString() : null,
      lastSelection: state.lastSelection ?? null,
    }));

    return {
      tokenPlanCount: this.tokenAlgos.size,
      trackedTokenCount: this.tokenState.size,
      tokenPlans,
      stateSample,
    };
  }

  private sizeForWeight(weight: number): number {
    const scale = Math.max(0.3, Math.min(2.5, weight * 10));
    return Number((this.options.tradeSize * scale).toFixed(4));
  }

  private reloadFromDisk(force = false): void {
    const now = Date.now();
    if (!force && now - this.lastReloadAt < this.options.reloadMs) {
      return;
    }
    this.lastReloadAt = now;

    const filePath = path.resolve(process.cwd(), this.options.ideaFactoryPath);
    if (!fs.existsSync(filePath)) {
      if (force) {
        log.warn(`[${this.name}] idea file not found: ${filePath}`);
      }
      return;
    }

    const stats = fs.statSync(filePath);
    const mtime = stats.mtimeMs;
    if (!force && mtime === this.lastFileMtime) {
      return;
    }

    try {
      const raw = fs.readFileSync(filePath, "utf8");
      const parsed = JSON.parse(raw) as IdeaFactoryFile;

      const tokenMap = new Map<string, TokenAlgo[]>();
      const runByToken = new Map<string, MarketRun>();

      const btcRuns = parsed.results?.bitcoin ?? [];
      const weatherRuns = parsed.results?.weather ?? [];

      for (const run of [...btcRuns, ...weatherRuns]) {
        runByToken.set(run.tokenId, run);
      }

      const portfolio = parsed.results?.portfolio ?? [];
      for (const entry of portfolio) {
        const algo: TokenAlgo = {
          tokenId: entry.tokenId,
          marketType: entry.marketType,
          family: entry.family,
          algoId: entry.algoId,
          params: entry.params,
          score: entry.score,
          weight: normalizeWeight(entry.targetWeight),
          question: runByToken.get(entry.tokenId)?.question,
        };
        const arr = tokenMap.get(entry.tokenId) ?? [];
        arr.push(algo);
        tokenMap.set(entry.tokenId, arr);
      }

      for (const run of runByToken.values()) {
        const arr = tokenMap.get(run.tokenId) ?? [];
        for (const top of run.topAlgos.slice(0, 4)) {
          if (arr.some((a) => a.algoId === top.id)) continue;
          arr.push({
            tokenId: run.tokenId,
            marketType: run.marketType,
            family: top.family,
            algoId: top.id,
            params: top.params,
            score: top.score,
            weight: 0.05,
            question: run.question,
          });
        }
        tokenMap.set(run.tokenId, arr);
      }

      this.tokenAlgos = tokenMap;
      this.memoryBoost = new Map();

      for (const hint of parsed.memoryHints ?? []) {
        const familyBoost = new Map<string, number>();
        for (const row of hint.leaderboard ?? []) {
          const boost = 1 + Math.max(0, row.winRate) * 0.2 + Math.max(0, row.avgScore) * 0.05;
          familyBoost.set(row.family, boost);
        }
        this.memoryBoost.set(hint.regimeBucket, familyBoost);
      }

      this.lastFileMtime = mtime;

      const tokenCount = this.tokenAlgos.size;
      const algoCount = Array.from(this.tokenAlgos.values()).reduce((a, b) => a + b.length, 0);
      log.info(`[${this.name}] loaded tokenPlans=${tokenCount} algos=${algoCount} generatedAt=${parsed.generatedAt ?? "n/a"}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      log.error(`[${this.name}] failed to parse idea file: ${message}`);
    }
  }
}
