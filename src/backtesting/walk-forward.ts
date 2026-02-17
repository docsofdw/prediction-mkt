import { runBacktest } from "./engine";
import { BacktestResult, BacktestRiskConfig, BacktestCostConfig, BacktestStrategy, PriceBar, WalkForwardResult } from "./types";

/**
 * Compute a robustness-adjusted score for comparing backtest results.
 * Penalizes strategies that may be overfitting based on unrealistic metrics.
 */
function computeRobustnessScore(result: BacktestResult): number {
  // Base score on Sharpe ratio
  let score = result.sharpe;

  // Penalize extremely high Sharpe (likely overfitting)
  if (result.sharpe > 3) {
    score -= (result.sharpe - 3) * 0.5;
  }

  // Penalize very low trade counts (not enough samples)
  if (result.tradeCount < 5) {
    score *= 0.5;
  }

  // Reward positive PnL
  if (result.totalPnl > 0) {
    score += 0.1;
  }

  // Penalize high drawdown relative to PnL
  if (result.maxDrawdown > 0 && result.totalPnl > 0) {
    const calmar = result.totalPnl / result.maxDrawdown;
    if (calmar < 1) {
      score -= 0.2;
    }
  }

  return score;
}

function compareResults(a: BacktestResult, b: BacktestResult): number {
  const scoreA = computeRobustnessScore(a);
  const scoreB = computeRobustnessScore(b);
  return scoreA - scoreB;
}

export function runWalkForward<TParams>(params: {
  tokenId: string;
  marketQuestion: string;
  bars: PriceBar[];
  splitRatio: number;
  candidates: TParams[];
  buildStrategy: (candidate: TParams) => BacktestStrategy;
  risk?: BacktestRiskConfig;
  costs?: BacktestCostConfig;
}): WalkForwardResult<TParams> {
  const { tokenId, marketQuestion, bars, splitRatio, candidates, buildStrategy, risk, costs } = params;

  if (bars.length < 20) {
    throw new Error(`Not enough bars (${bars.length}) for walk-forward`);
  }

  if (candidates.length === 0) {
    throw new Error("No parameter candidates provided");
  }

  const splitIndex = Math.min(bars.length - 1, Math.max(2, Math.floor(bars.length * splitRatio)));
  const trainBars = bars.slice(0, splitIndex);
  const testBars = bars.slice(splitIndex - 1);

  let bestParams = candidates[0];
  let bestTrain = runBacktest({
    strategy: buildStrategy(bestParams),
    tokenId,
    marketQuestion,
    bars: trainBars,
    risk,
    costs,
  });

  for (let i = 1; i < candidates.length; i++) {
    const candidate = candidates[i];
    const result = runBacktest({
      strategy: buildStrategy(candidate),
      tokenId,
      marketQuestion,
      bars: trainBars,
      risk,
      costs,
    });

    if (compareResults(result, bestTrain) > 0) {
      bestTrain = result;
      bestParams = candidate;
    }
  }

  const test = runBacktest({
    strategy: buildStrategy(bestParams),
    tokenId,
    marketQuestion,
    bars: testBars,
    risk,
    costs,
  });

  // Calculate overfit score (ratio of train to test Sharpe)
  const trainSharpe = bestTrain.sharpe;
  const testSharpe = test.sharpe;
  const overfitScore = testSharpe !== 0 ? Math.abs(trainSharpe / testSharpe) : (trainSharpe > 0 ? Infinity : 0);

  // Calculate robustness score that penalizes train/test divergence
  const sharpeDiff = Math.abs(trainSharpe - testSharpe);
  const overfitPenalty = sharpeDiff * 0.5;
  const robustnessScore = testSharpe - overfitPenalty;

  return {
    bestParams,
    candidatesEvaluated: candidates.length,
    train: bestTrain,
    test,
    overfitScore,
    robustnessScore,
  };
}
