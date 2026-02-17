import fs from "node:fs";
import path from "node:path";
import { buildExpandingFolds, CandidateEvaluation, CandidateSpec, computeMarketProfile, evaluateCandidates, profileBucket } from "../backtesting/idea-factory";
import { BacktestRiskConfig } from "../backtesting/types";
import { MarketDiscovery } from "../services/market-discovery";
import { HistoricalPrices } from "../services/historical-prices";
import { BitcoinMomentumStrategy } from "../strategies/backtest/bitcoin-momentum";
import { BitcoinBreakoutParams, BitcoinBreakoutStrategy } from "../strategies/backtest/bitcoin-breakout";
import { BitcoinRegimeTrendParams, BitcoinRegimeTrendStrategy } from "../strategies/backtest/bitcoin-regime-trend";
import { WeatherMeanReversionStrategy } from "../strategies/backtest/weather-mean-reversion";
import { WeatherRangeReversionParams, WeatherRangeReversionStrategy } from "../strategies/backtest/weather-range-reversion";
import { WeatherDriftTrendParams, WeatherDriftTrendStrategy } from "../strategies/backtest/weather-drift-trend";
import { log } from "../utils/logger";

type MarketType = "bitcoin" | "weather";
type HistoryInterval = "max" | "1w" | "1d" | "6h" | "1h";

interface IdeaMemoryBucket {
  runs: number;
  familyStats: Record<string, { count: number; scoreTotal: number; wins: number }>;
}

interface IdeaMemory {
  updatedAt: string;
  buckets: Record<string, IdeaMemoryBucket>;
}

interface RankedAlgo {
  id: string;
  family: string;
  params: unknown;
  score: number;
  metrics: CandidateEvaluation["metrics"];
}

interface MarketRun {
  marketType: MarketType;
  tokenId: string;
  question: string;
  interval: HistoryInterval;
  fidelity: number;
  volume: number;
  bars: number;
  profile: ReturnType<typeof computeMarketProfile>;
  regimeBucket: string;
  candidatesEvaluated: number;
  topAlgos: RankedAlgo[];
}

const gammaHost = process.env.GAMMA_HOST || "https://gamma-api.polymarket.com";
const clobHost = process.env.CLOB_HOST || "https://clob.polymarket.com";

const interval = (process.env.IDEA_INTERVAL as HistoryInterval) || "max";
const fidelity = Number(process.env.IDEA_FIDELITY || "60");
const maxMarketsPerCategory = Number(process.env.IDEA_MAX_MARKETS || "8");
const minBars = Number(process.env.IDEA_MIN_BARS || "100");
const minTrainBars = Number(process.env.IDEA_MIN_TRAIN_BARS || "70");
const foldTestBars = Number(process.env.IDEA_FOLD_TEST_BARS || "24");
const foldStepBars = Number(process.env.IDEA_FOLD_STEP_BARS || "10");
const maxFolds = Number(process.env.IDEA_MAX_FOLDS || "8");
const perFamilyCap = Number(process.env.IDEA_MAX_CANDIDATES_PER_FAMILY || "150");
const topPerMarket = Number(process.env.IDEA_TOP_PER_MARKET || "8");

const risk: BacktestRiskConfig = {
  stopLoss: process.env.RISK_STOP_LOSS ? Number(process.env.RISK_STOP_LOSS) : undefined,
  takeProfit: process.env.RISK_TAKE_PROFIT ? Number(process.env.RISK_TAKE_PROFIT) : undefined,
  minBarsBetweenTrades: Number(process.env.RISK_MIN_BARS_BETWEEN_TRADES || "2"),
  maxTrades: process.env.RISK_MAX_TRADES ? Number(process.env.RISK_MAX_TRADES) : undefined,
};

function capDeterministic<T>(arr: T[], cap: number): T[] {
  if (arr.length <= cap) return arr;
  const out: T[] = [];
  const stride = arr.length / cap;
  for (let i = 0; i < cap; i++) {
    const index = Math.floor(i * stride);
    out.push(arr[index]);
  }
  return out;
}

function buildBitcoinCandidates(): CandidateSpec[] {
  const momentum: CandidateSpec[] = [];
  const shortWindows = [4, 6, 8, 10, 12, 16];
  const longWindows = [20, 28, 36, 48, 64];
  const thresholds = [0.002, 0.0035, 0.005, 0.0075, 0.01];

  for (const shortWindow of shortWindows) {
    for (const longWindow of longWindows) {
      if (shortWindow >= longWindow) continue;
      for (const threshold of thresholds) {
        const params = { shortWindow, longWindow, threshold };
        momentum.push({
          id: `btc-mom-${shortWindow}-${longWindow}-${threshold}`,
          family: "btc-momentum",
          params,
          buildStrategy: () => BitcoinMomentumStrategy.fromParams(params),
        });
      }
    }
  }

  const breakout: CandidateSpec[] = [];
  const breakoutWindows = [14, 20, 28, 36, 48];
  const confirmWindows = [4, 6, 8, 10];
  const volFloors = [0.004, 0.007, 0.01, 0.013];
  const stopToFlats = [0.01, 0.02, 0.03];

  for (const breakoutWindow of breakoutWindows) {
    for (const confirmWindow of confirmWindows) {
      for (const volatilityFloor of volFloors) {
        for (const stopToFlat of stopToFlats) {
          const params: BitcoinBreakoutParams = {
            breakoutWindow,
            confirmWindow,
            volatilityFloor,
            stopToFlat,
          };
          breakout.push({
            id: `btc-bo-${breakoutWindow}-${confirmWindow}-${volatilityFloor}-${stopToFlat}`,
            family: "btc-breakout",
            params,
            buildStrategy: () => BitcoinBreakoutStrategy.fromParams(params),
          });
        }
      }
    }
  }

  const regimeTrend: CandidateSpec[] = [];
  const trendWindows = [24, 32, 48, 64];
  const triggerWindows = [8, 10, 12, 16];
  const rsiPeriods = [8, 12, 16];
  const longMins = [52, 56, 60];
  const shortMaxes = [48, 44, 40];
  const volCaps = [0.02, 0.03, 0.04];

  for (const trendWindow of trendWindows) {
    for (const triggerWindow of triggerWindows) {
      if (triggerWindow >= trendWindow) continue;
      for (const rsiPeriod of rsiPeriods) {
        for (const rsiLongMin of longMins) {
          for (const rsiShortMax of shortMaxes) {
            if (rsiShortMax >= rsiLongMin) continue;
            for (const volatilityCap of volCaps) {
              const params: BitcoinRegimeTrendParams = {
                trendWindow,
                triggerWindow,
                rsiPeriod,
                rsiLongMin,
                rsiShortMax,
                volatilityCap,
              };
              regimeTrend.push({
                id: `btc-rt-${trendWindow}-${triggerWindow}-${rsiPeriod}-${rsiLongMin}-${rsiShortMax}-${volatilityCap}`,
                family: "btc-regime-trend",
                params,
                buildStrategy: () => BitcoinRegimeTrendStrategy.fromParams(params),
              });
            }
          }
        }
      }
    }
  }

  return [
    ...capDeterministic(momentum, perFamilyCap),
    ...capDeterministic(breakout, perFamilyCap),
    ...capDeterministic(regimeTrend, perFamilyCap),
  ];
}

function buildWeatherCandidates(): CandidateSpec[] {
  const meanReversion: CandidateSpec[] = [];
  const windows = [16, 24, 32, 40, 48, 56];
  const zEntries = [1.0, 1.2, 1.4, 1.6, 1.8];
  const zExits = [0.2, 0.3, 0.4, 0.5];

  for (const window of windows) {
    for (const zEntry of zEntries) {
      for (const zExit of zExits) {
        if (zExit >= zEntry) continue;
        const params = { window, zEntry, zExit };
        meanReversion.push({
          id: `w-mr-${window}-${zEntry}-${zExit}`,
          family: "weather-mean-reversion",
          params,
          buildStrategy: () => WeatherMeanReversionStrategy.fromParams(params),
        });
      }
    }
  }

  const rangeReversion: CandidateSpec[] = [];
  const rrWindows = [20, 28, 36, 44, 56];
  const rrEntries = [1.0, 1.3, 1.6, 1.9];
  const rrExits = [0.25, 0.35, 0.45];
  const rrVolCaps = [0.03, 0.04, 0.05, 0.06];

  for (const window of rrWindows) {
    for (const zEntry of rrEntries) {
      for (const zExit of rrExits) {
        if (zExit >= zEntry) continue;
        for (const volatilityCeiling of rrVolCaps) {
          const params: WeatherRangeReversionParams = {
            window,
            zEntry,
            zExit,
            volatilityCeiling,
          };
          rangeReversion.push({
            id: `w-rr-${window}-${zEntry}-${zExit}-${volatilityCeiling}`,
            family: "weather-range-reversion",
            params,
            buildStrategy: () => WeatherRangeReversionStrategy.fromParams(params),
          });
        }
      }
    }
  }

  const driftTrend: CandidateSpec[] = [];
  const dtTrendWindows = [20, 28, 36, 48, 64];
  const dtTriggerWindows = [6, 8, 10, 12];
  const dtSlopes = [0.0006, 0.0009, 0.0012, 0.0015];
  const dtDistances = [0.02, 0.03, 0.04, 0.05];

  for (const trendWindow of dtTrendWindows) {
    for (const triggerWindow of dtTriggerWindows) {
      if (triggerWindow >= trendWindow) continue;
      for (const minSlope of dtSlopes) {
        for (const maxDistance of dtDistances) {
          const params: WeatherDriftTrendParams = {
            trendWindow,
            triggerWindow,
            minSlope,
            maxDistance,
          };
          driftTrend.push({
            id: `w-dt-${trendWindow}-${triggerWindow}-${minSlope}-${maxDistance}`,
            family: "weather-drift-trend",
            params,
            buildStrategy: () => WeatherDriftTrendStrategy.fromParams(params),
          });
        }
      }
    }
  }

  return [
    ...capDeterministic(meanReversion, perFamilyCap),
    ...capDeterministic(rangeReversion, perFamilyCap),
    ...capDeterministic(driftTrend, perFamilyCap),
  ];
}

function loadMemory(memoryPath: string): IdeaMemory {
  if (!fs.existsSync(memoryPath)) {
    return { updatedAt: new Date().toISOString(), buckets: {} };
  }

  try {
    const raw = fs.readFileSync(memoryPath, "utf8");
    const parsed = JSON.parse(raw) as IdeaMemory;
    if (typeof parsed !== "object" || parsed === null || typeof parsed.buckets !== "object") {
      return { updatedAt: new Date().toISOString(), buckets: {} };
    }
    return parsed;
  } catch {
    return { updatedAt: new Date().toISOString(), buckets: {} };
  }
}

function updateMemory(memory: IdeaMemory, bucketKey: string, ranking: RankedAlgo[]): void {
  const bucket = memory.buckets[bucketKey] ?? { runs: 0, familyStats: {} };
  bucket.runs += 1;

  ranking.slice(0, 3).forEach((algo, i) => {
    const family = bucket.familyStats[algo.family] ?? { count: 0, scoreTotal: 0, wins: 0 };
    family.count += 1;
    family.scoreTotal += algo.score;
    if (i === 0) family.wins += 1;
    bucket.familyStats[algo.family] = family;
  });

  memory.buckets[bucketKey] = bucket;
  memory.updatedAt = new Date().toISOString();
}

function bucketLeaderboard(memory: IdeaMemory, bucketKey: string): Array<{ family: string; avgScore: number; winRate: number }> {
  const bucket = memory.buckets[bucketKey];
  if (!bucket) return [];

  return Object.entries(bucket.familyStats)
    .map(([family, stats]) => ({
      family,
      avgScore: stats.count === 0 ? 0 : stats.scoreTotal / stats.count,
      winRate: stats.count === 0 ? 0 : stats.wins / stats.count,
    }))
    .sort((a, b) => {
      if (b.winRate !== a.winRate) return b.winRate - a.winRate;
      return b.avgScore - a.avgScore;
    });
}

function toRanked(evalResult: CandidateEvaluation): RankedAlgo {
  return {
    id: evalResult.candidate.id,
    family: evalResult.candidate.family,
    params: evalResult.candidate.params,
    score: evalResult.score,
    metrics: evalResult.metrics,
  };
}

async function discoverSnapshots(discovery: MarketDiscovery, marketType: MarketType, limit: number) {
  const events = marketType === "bitcoin"
    ? await discovery.discoverBitcoinMarkets(30)
    : await discovery.discoverWeatherMarkets(30);

  return events
    .flatMap((event) => discovery.snapshotMarkets(event))
    .filter((snapshot) => snapshot.tokenId)
    .sort((a, b) => b.volume - a.volume)
    .slice(0, limit);
}

function summarizeRuns(runs: MarketRun[]): string {
  if (runs.length === 0) return "none";
  const avgCandidates = runs.reduce((a, r) => a + r.candidatesEvaluated, 0) / runs.length;
  const avgScore = runs.reduce((a, r) => a + (r.topAlgos[0]?.score ?? 0), 0) / runs.length;
  return `markets=${runs.length} avgCandidates=${avgCandidates.toFixed(1)} avgTopScore=${avgScore.toFixed(3)}`;
}

function buildPortfolio(runs: MarketRun[]) {
  const all = runs.flatMap((run) =>
    run.topAlgos.slice(0, 2).map((algo) => ({
      marketType: run.marketType,
      tokenId: run.tokenId,
      question: run.question,
      family: algo.family,
      algoId: algo.id,
      score: algo.score,
      drawdown: algo.metrics.avgTestDrawdown,
      consistency: algo.metrics.consistency,
      params: algo.params,
    }))
  );

  const ranked = [...all].sort((a, b) => b.score - a.score).slice(0, 20);
  const total = ranked.reduce((acc, row) => acc + Math.max(0, row.score), 0);

  return ranked.map((row) => {
    const base = total > 0 ? Math.max(0, row.score) / total : 0;
    const riskPenalty = 1 / (1 + Math.max(0, row.drawdown));
    const rawWeight = base * riskPenalty;
    return { ...row, rawWeight };
  }).map((row, _, arr) => {
    const weightDen = arr.reduce((a, b) => a + b.rawWeight, 0);
    const weight = weightDen > 0 ? row.rawWeight / weightDen : 0;
    return {
      marketType: row.marketType,
      tokenId: row.tokenId,
      question: row.question,
      family: row.family,
      algoId: row.algoId,
      params: row.params,
      score: row.score,
      consistency: row.consistency,
      targetWeight: Number(weight.toFixed(4)),
    };
  });
}

async function runCategory(params: {
  marketType: MarketType;
  discovery: MarketDiscovery;
  history: HistoricalPrices;
  memory: IdeaMemory;
}): Promise<MarketRun[]> {
  const { marketType, discovery, history, memory } = params;
  const snapshots = await discoverSnapshots(discovery, marketType, maxMarketsPerCategory);
  log.info(`[IDEA ${marketType}] selected snapshots=${snapshots.length}`);

  const candidates = marketType === "bitcoin" ? buildBitcoinCandidates() : buildWeatherCandidates();
  const runs: MarketRun[] = [];

  for (const snapshot of snapshots) {
    try {
      const bars = await history.getBars({ tokenId: snapshot.tokenId, interval, fidelity });
      if (bars.length < minBars) {
        log.warn(`[IDEA ${marketType}] skip token=${snapshot.tokenId} bars=${bars.length} min=${minBars}`);
        continue;
      }

      const folds = buildExpandingFolds(bars, {
        minTrainBars,
        testBars: foldTestBars,
        stepBars: foldStepBars,
        maxFolds,
      });
      if (folds.length === 0) {
        log.warn(`[IDEA ${marketType}] insufficient folds token=${snapshot.tokenId}`);
        continue;
      }

      const profile = computeMarketProfile(bars);
      const regimeBucket = `${marketType}:${profileBucket(profile)}`;

      const evaluation = evaluateCandidates({
        tokenId: snapshot.tokenId,
        question: snapshot.question,
        bars,
        candidates,
        folds,
        risk,
      });
      if (evaluation.length === 0) continue;

      const topAlgos = evaluation.slice(0, topPerMarket).map(toRanked);
      updateMemory(memory, regimeBucket, topAlgos);

      runs.push({
        marketType,
        tokenId: snapshot.tokenId,
        question: snapshot.question,
        interval,
        fidelity,
        volume: snapshot.volume,
        bars: bars.length,
        profile,
        regimeBucket,
        candidatesEvaluated: evaluation.length,
        topAlgos,
      });

      log.info(
        `[IDEA ${marketType}] token=${snapshot.tokenId} bars=${bars.length} candidates=${evaluation.length} top=${topAlgos[0].id} score=${topAlgos[0].score.toFixed(3)}`
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      log.warn(`[IDEA ${marketType}] failed token=${snapshot.tokenId} err=${message}`);
    }
  }

  return runs;
}

async function main() {
  const startedAt = new Date().toISOString();
  log.info(
    `Starting idea factory interval=${interval} fidelity=${fidelity} maxMarkets=${maxMarketsPerCategory} minBars=${minBars} perFamilyCap=${perFamilyCap}`
  );

  const discovery = new MarketDiscovery(gammaHost);
  const history = new HistoricalPrices(clobHost);

  const outputDir = path.resolve(process.cwd(), "backtests");
  const memoryPath = path.join(outputDir, "idea-memory.json");
  const latestPath = path.join(outputDir, "idea-factory-latest.json");

  fs.mkdirSync(outputDir, { recursive: true });
  const memory = loadMemory(memoryPath);

  const bitcoin = await runCategory({ marketType: "bitcoin", discovery, history, memory });
  const weather = await runCategory({ marketType: "weather", discovery, history, memory });

  fs.writeFileSync(memoryPath, JSON.stringify(memory, null, 2));

  const allRuns = [...bitcoin, ...weather];
  const portfolio = buildPortfolio(allRuns);

  const output = {
    generatedAt: new Date().toISOString(),
    startedAt,
    config: {
      interval,
      fidelity,
      maxMarketsPerCategory,
      minBars,
      fold: { minTrainBars, foldTestBars, foldStepBars, maxFolds },
      perFamilyCap,
      topPerMarket,
      risk,
    },
    summary: {
      bitcoin: summarizeRuns(bitcoin),
      weather: summarizeRuns(weather),
      portfolioAlgos: portfolio.length,
    },
    automation: {
      commands: {
        research: "npm run ideas:build",
        dryRunBacktest: "npm run backtest",
      },
      cadence: {
        hourly: "refresh rankings for active markets",
        daily: "full candidate sweep + memory update",
        weekly: "parameter grid refresh and threshold recalibration",
      },
    },
    memoryHints: allRuns.map((run) => ({
      tokenId: run.tokenId,
      marketType: run.marketType,
      regimeBucket: run.regimeBucket,
      leaderboard: bucketLeaderboard(memory, run.regimeBucket).slice(0, 3),
    })),
    results: {
      bitcoin,
      weather,
      portfolio,
    },
  };

  fs.writeFileSync(latestPath, JSON.stringify(output, null, 2));
  log.info(`Wrote idea factory output: ${latestPath}`);
  log.info(`Bitcoin summary: ${summarizeRuns(bitcoin)}`);
  log.info(`Weather summary: ${summarizeRuns(weather)}`);
}

main().catch((error) => {
  const message = error instanceof Error ? error.stack || error.message : String(error);
  log.error(`Idea factory failed: ${message}`);
  process.exit(1);
});
