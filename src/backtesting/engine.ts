import { BacktestResult, BacktestRiskConfig, BacktestStrategy, PositionSide, PriceBar, BacktestTrade } from "./types";

function computeSharpe(returns: number[]): number {
  if (returns.length < 2) return 0;
  const mean = returns.reduce((a, b) => a + b, 0) / returns.length;
  const variance = returns.reduce((a, r) => a + (r - mean) ** 2, 0) / (returns.length - 1);
  const std = Math.sqrt(variance);
  if (std === 0) return 0;
  return mean / std * Math.sqrt(returns.length);
}

function computeMaxDrawdown(equity: number[]): number {
  if (equity.length === 0) return 0;
  let peak = equity[0];
  let maxDd = 0;

  for (const value of equity) {
    if (value > peak) peak = value;
    const dd = peak - value;
    if (dd > maxDd) maxDd = dd;
  }

  return maxDd;
}

function maybeApplyRiskExit(params: {
  risk?: BacktestRiskConfig;
  pnl: number;
  position: PositionSide;
}): string | null {
  const { risk, pnl, position } = params;
  if (!risk || position === 0) return null;

  if (risk.stopLoss !== undefined && pnl <= -Math.abs(risk.stopLoss)) {
    return "Risk stop-loss";
  }

  if (risk.takeProfit !== undefined && pnl >= Math.abs(risk.takeProfit)) {
    return "Risk take-profit";
  }

  return null;
}

export function runBacktest(params: {
  strategy: BacktestStrategy;
  tokenId: string;
  marketQuestion: string;
  bars: PriceBar[];
  risk?: BacktestRiskConfig;
}): BacktestResult {
  const { strategy, tokenId, marketQuestion, bars, risk } = params;

  let position: PositionSide = 0;
  let pnl = 0;
  const trades: BacktestTrade[] = [];
  const equityCurve: number[] = [0];
  const returns: number[] = [];
  let winningMoves = 0;
  let totalMoves = 0;
  let lastTradeIndex = -1_000_000;
  let riskEvents = 0;

  for (let i = 1; i < bars.length; i++) {
    const prev = bars[i - 1];
    const curr = bars[i];
    const priceChange = curr.price - prev.price;
    const incrementalPnl = position * priceChange;
    pnl += incrementalPnl;
    equityCurve.push(pnl);
    returns.push(incrementalPnl);

    const riskExitReason = maybeApplyRiskExit({ risk, pnl, position });
    if (riskExitReason) {
      trades.push({
        timestamp: curr.timestamp,
        price: curr.price,
        from: position,
        to: 0,
        reason: riskExitReason,
      });
      position = 0;
      lastTradeIndex = i;
      riskEvents += 1;
    }

    if (i < strategy.warmupBars) continue;

    if (risk?.maxTrades !== undefined && trades.length >= risk.maxTrades) {
      continue;
    }

    const minBarsBetweenTrades = risk?.minBarsBetweenTrades ?? 0;
    if (i - lastTradeIndex < minBarsBetweenTrades) {
      continue;
    }

    const signal = strategy.getSignal(bars, i, position);
    if (!signal) continue;

    if (signal.targetPosition !== position) {
      const oldPosition = position;
      position = signal.targetPosition;
      trades.push({
        timestamp: curr.timestamp,
        price: curr.price,
        from: oldPosition,
        to: position,
        reason: signal.reason,
      });
      lastTradeIndex = i;

      if (incrementalPnl !== 0) {
        totalMoves += 1;
        if (incrementalPnl > 0) winningMoves += 1;
      }
    }
  }

  return {
    strategyName: strategy.name,
    tokenId,
    marketQuestion,
    bars: bars.length,
    trades,
    totalPnl: pnl,
    maxDrawdown: computeMaxDrawdown(equityCurve),
    winRate: totalMoves === 0 ? 0 : winningMoves / totalMoves,
    sharpe: computeSharpe(returns),
    riskEvents,
  };
}
