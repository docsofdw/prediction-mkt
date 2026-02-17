import { runBacktest } from "./engine";
import { BacktestResult, BacktestRiskConfig, BacktestStrategy, PriceBar, WalkForwardResult } from "./types";

function compareResults(a: BacktestResult, b: BacktestResult): number {
  if (a.totalPnl !== b.totalPnl) return a.totalPnl - b.totalPnl;
  if (a.sharpe !== b.sharpe) return a.sharpe - b.sharpe;
  return b.maxDrawdown - a.maxDrawdown;
}

export function runWalkForward<TParams>(params: {
  tokenId: string;
  marketQuestion: string;
  bars: PriceBar[];
  splitRatio: number;
  candidates: TParams[];
  buildStrategy: (candidate: TParams) => BacktestStrategy;
  risk?: BacktestRiskConfig;
}): WalkForwardResult<TParams> {
  const { tokenId, marketQuestion, bars, splitRatio, candidates, buildStrategy, risk } = params;

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
  });

  for (let i = 1; i < candidates.length; i++) {
    const candidate = candidates[i];
    const result = runBacktest({
      strategy: buildStrategy(candidate),
      tokenId,
      marketQuestion,
      bars: trainBars,
      risk,
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
  });

  return {
    bestParams,
    candidatesEvaluated: candidates.length,
    train: bestTrain,
    test,
  };
}
