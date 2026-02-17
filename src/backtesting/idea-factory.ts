import { runBacktest } from "./engine";
import { BacktestResult, BacktestRiskConfig, BacktestStrategy, PriceBar } from "./types";

export interface FoldWindow {
  trainBars: PriceBar[];
  testBars: PriceBar[];
  foldIndex: number;
}

export interface FoldConfig {
  minTrainBars: number;
  testBars: number;
  stepBars: number;
  maxFolds: number;
}

export interface CandidateSpec<TParams = unknown> {
  id: string;
  family: string;
  params: TParams;
  buildStrategy: () => BacktestStrategy;
}

export interface FoldRun {
  foldIndex: number;
  train: BacktestResult;
  test: BacktestResult;
}

export interface CandidateMetrics {
  avgTestPnl: number;
  medianTestPnl: number;
  avgTestSharpe: number;
  avgTestSortino: number;
  avgTestDrawdown: number;
  avgExposure: number;
  avgTradeCount: number;
  consistency: number;
  overfitPenalty: number;
  tailPenalty: number;
}

export interface CandidateEvaluation {
  candidate: CandidateSpec;
  folds: FoldRun[];
  metrics: CandidateMetrics;
  score: number;
}

export interface MarketProfile {
  trendiness: number;
  meanReversion: number;
  volatility: number;
  tailRisk: number;
}

function avg(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 0) {
    return (sorted[mid - 1] + sorted[mid]) / 2;
  }
  return sorted[mid];
}

function std(values: number[]): number {
  if (values.length < 2) return 0;
  const mean = avg(values);
  const variance = values.reduce((a, v) => a + (v - mean) ** 2, 0) / (values.length - 1);
  return Math.sqrt(variance);
}

function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const pos = Math.max(0, Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * p)));
  return sorted[pos];
}

function autocorrelation1(values: number[]): number {
  if (values.length < 3) return 0;
  const mean = avg(values);
  let num = 0;
  let den = 0;

  for (let i = 1; i < values.length; i++) {
    num += (values[i] - mean) * (values[i - 1] - mean);
  }

  for (const value of values) {
    den += (value - mean) ** 2;
  }

  if (den === 0) return 0;
  return num / den;
}

export function computeMarketProfile(bars: PriceBar[]): MarketProfile {
  if (bars.length < 3) {
    return { trendiness: 0, meanReversion: 0, volatility: 0, tailRisk: 0 };
  }

  const prices = bars.map((b) => b.price);
  const returns = prices.slice(1).map((value, i) => value - prices[i]);
  const meanPrice = Math.max(avg(prices), 1e-9);

  const meanX = (prices.length - 1) / 2;
  const meanY = avg(prices);
  let cov = 0;
  let varX = 0;
  for (let i = 0; i < prices.length; i++) {
    const dx = i - meanX;
    cov += dx * (prices[i] - meanY);
    varX += dx * dx;
  }

  const trendSlope = varX === 0 ? 0 : cov / varX;
  const trendiness = Math.abs(trendSlope) / meanPrice;
  const meanReversion = -autocorrelation1(returns);
  const volatility = std(returns) / meanPrice;
  const tailRisk = percentile(returns.map((r) => Math.abs(r)), 0.95) / meanPrice;

  return { trendiness, meanReversion, volatility, tailRisk };
}

export function buildExpandingFolds(bars: PriceBar[], cfg: FoldConfig): FoldWindow[] {
  const { minTrainBars, testBars, stepBars, maxFolds } = cfg;
  const folds: FoldWindow[] = [];

  if (bars.length < minTrainBars + testBars) {
    return folds;
  }

  let trainEnd = minTrainBars;
  let foldIndex = 0;

  while (trainEnd + testBars <= bars.length && folds.length < maxFolds) {
    const trainBars = bars.slice(0, trainEnd);
    const testBarsSlice = bars.slice(trainEnd - 1, trainEnd + testBars);
    folds.push({ trainBars, testBars: testBarsSlice, foldIndex });

    trainEnd += stepBars;
    foldIndex += 1;
  }

  return folds;
}

function safeRatio(numerator: number, denominator: number): number {
  if (denominator === 0) return 0;
  return numerator / denominator;
}

function summarizeCandidate(folds: FoldRun[]): CandidateMetrics {
  const testPnls = folds.map((f) => f.test.totalPnl);
  const testSharpes = folds.map((f) => f.test.sharpe);
  const testSortinos = folds.map((f) => f.test.sortino);
  const testDrawdowns = folds.map((f) => f.test.maxDrawdown);
  const testTrades = folds.map((f) => f.test.tradeCount);
  const testExposure = folds.map((f) => f.test.exposure);

  const trainPnls = folds.map((f) => f.train.totalPnl);
  const avgTrainPnl = avg(trainPnls);
  const avgTestPnl = avg(testPnls);

  const positiveFolds = testPnls.filter((p) => p > 0).length;
  const consistency = safeRatio(positiveFolds, Math.max(1, testPnls.length));
  const overfitPenalty = Math.max(0, avgTrainPnl - avgTestPnl);
  const tailPenalty = percentile(testDrawdowns, 0.9);

  return {
    avgTestPnl,
    medianTestPnl: median(testPnls),
    avgTestSharpe: avg(testSharpes),
    avgTestSortino: avg(testSortinos),
    avgTestDrawdown: avg(testDrawdowns),
    avgExposure: avg(testExposure),
    avgTradeCount: avg(testTrades),
    consistency,
    overfitPenalty,
    tailPenalty,
  };
}

function rankPercentile(values: number[], value: number, higherIsBetter: boolean): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  let lessOrEqual = 0;

  for (const v of sorted) {
    if (v <= value) lessOrEqual += 1;
  }

  const percentile = safeRatio(lessOrEqual - 1, Math.max(1, sorted.length - 1));
  return higherIsBetter ? percentile : 1 - percentile;
}

export function scoreCandidateSet(evals: CandidateEvaluation[]): CandidateEvaluation[] {
  const pnlSeries = evals.map((e) => e.metrics.avgTestPnl);
  const sharpeSeries = evals.map((e) => e.metrics.avgTestSharpe);
  const sortinoSeries = evals.map((e) => e.metrics.avgTestSortino);
  const drawdownSeries = evals.map((e) => e.metrics.avgTestDrawdown);
  const consistencySeries = evals.map((e) => e.metrics.consistency);
  const overfitSeries = evals.map((e) => e.metrics.overfitPenalty);
  const tailSeries = evals.map((e) => e.metrics.tailPenalty);

  return evals
    .map((evaluation) => {
      const score =
        0.22 * rankPercentile(pnlSeries, evaluation.metrics.avgTestPnl, true) +
        0.20 * rankPercentile(sharpeSeries, evaluation.metrics.avgTestSharpe, true) +
        0.18 * rankPercentile(sortinoSeries, evaluation.metrics.avgTestSortino, true) +
        0.15 * rankPercentile(consistencySeries, evaluation.metrics.consistency, true) +
        0.10 * rankPercentile(drawdownSeries, evaluation.metrics.avgTestDrawdown, false) +
        0.10 * rankPercentile(overfitSeries, evaluation.metrics.overfitPenalty, false) +
        0.05 * rankPercentile(tailSeries, evaluation.metrics.tailPenalty, false);

      return { ...evaluation, score };
    })
    .sort((a, b) => b.score - a.score);
}

export function evaluateCandidates(params: {
  tokenId: string;
  question: string;
  bars: PriceBar[];
  risk?: BacktestRiskConfig;
  candidates: CandidateSpec[];
  folds: FoldWindow[];
}): CandidateEvaluation[] {
  const { tokenId, question, bars, risk, candidates, folds } = params;

  if (bars.length < 3) return [];
  if (candidates.length === 0 || folds.length === 0) return [];

  const evaluations: CandidateEvaluation[] = [];

  for (const candidate of candidates) {
    const runs: FoldRun[] = [];

    for (const fold of folds) {
      const train = runBacktest({
        strategy: candidate.buildStrategy(),
        tokenId,
        marketQuestion: question,
        bars: fold.trainBars,
        risk,
      });

      const test = runBacktest({
        strategy: candidate.buildStrategy(),
        tokenId,
        marketQuestion: question,
        bars: fold.testBars,
        risk,
      });

      runs.push({ foldIndex: fold.foldIndex, train, test });
    }

    const metrics = summarizeCandidate(runs);
    evaluations.push({ candidate, folds: runs, metrics, score: 0 });
  }

  return scoreCandidateSet(evaluations);
}

export function profileBucket(profile: MarketProfile): string {
  const trend = profile.trendiness > 0.0025 ? "trend-high" : "trend-low";
  const mr = profile.meanReversion > 0.05 ? "mr-high" : "mr-low";
  const vol = profile.volatility > 0.02 ? "vol-high" : "vol-low";
  return `${trend}:${mr}:${vol}`;
}
