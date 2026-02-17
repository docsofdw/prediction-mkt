import { BacktestResult, BacktestRiskConfig, BacktestCostConfig, BacktestStrategy, PositionSide, PriceBar, BacktestTrade } from "./types";

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

function computeSortino(returns: number[]): number {
  if (returns.length < 2) return 0;
  const mean = returns.reduce((a, b) => a + b, 0) / returns.length;
  const downside = returns.filter((r) => r < 0);
  if (downside.length === 0) return 0;
  const downsideVariance = downside.reduce((a, r) => a + r * r, 0) / downside.length;
  const downsideDeviation = Math.sqrt(downsideVariance);
  if (downsideDeviation === 0) return 0;
  return mean / downsideDeviation * Math.sqrt(returns.length);
}

function computeProfitFactor(returns: number[]): number {
  const grossProfit = returns.filter((r) => r > 0).reduce((a, b) => a + b, 0);
  const grossLoss = Math.abs(returns.filter((r) => r < 0).reduce((a, b) => a + b, 0));
  if (grossLoss === 0) return grossProfit > 0 ? Number.POSITIVE_INFINITY : 0;
  return grossProfit / grossLoss;
}

function computeUlcerIndex(equity: number[]): number {
  if (equity.length < 2) return 0;

  let peak = equity[0];
  let sumSquaredDrawdown = 0;

  for (const value of equity) {
    if (value > peak) peak = value;
    const percentDrawdown = peak > 0 ? ((peak - value) / peak) * 100 : 0;
    sumSquaredDrawdown += percentDrawdown ** 2;
  }

  return Math.sqrt(sumSquaredDrawdown / equity.length);
}

function computeEnhancedMetrics(returns: number[], pnl: number, maxDrawdown: number) {
  const wins = returns.filter((r) => r > 0);
  const losses = returns.filter((r) => r < 0);

  const avgWin = wins.length > 0 ? wins.reduce((a, b) => a + b, 0) / wins.length : 0;
  const avgLoss = losses.length > 0 ? Math.abs(losses.reduce((a, b) => a + b, 0) / losses.length) : 0;

  const payoffRatio = avgLoss !== 0 ? avgWin / avgLoss : avgWin > 0 ? Infinity : 0;

  const winRate = returns.length > 0 ? wins.length / returns.length : 0;
  const expectancy = winRate * avgWin - (1 - winRate) * avgLoss;

  const calmarRatio = maxDrawdown !== 0 ? pnl / maxDrawdown : pnl > 0 ? Infinity : 0;
  const recoveryFactor = maxDrawdown !== 0 ? pnl / maxDrawdown : pnl > 0 ? Infinity : 0;

  // Tail ratio: 95th percentile win / 5th percentile loss
  const sortedReturns = [...returns].sort((a, b) => a - b);
  const p5Index = Math.floor(sortedReturns.length * 0.05);
  const p95Index = Math.floor(sortedReturns.length * 0.95);
  const p5 = sortedReturns[p5Index] ?? 0;
  const p95 = sortedReturns[p95Index] ?? 0;
  const tailRatio = p5 !== 0 ? Math.abs(p95 / p5) : p95 > 0 ? Infinity : 0;

  return {
    avgWin,
    avgLoss,
    payoffRatio,
    expectancy,
    calmarRatio,
    recoveryFactor,
    tailRatio,
  };
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

function computeTransactionCost(
  price: number,
  positionChange: number,
  costs?: BacktestCostConfig
): number {
  if (!costs) return 0;
  const tradeSize = Math.abs(positionChange);
  if (tradeSize === 0) return 0;

  const spreadCost = (costs.spreadBps ?? 0) / 10000 * price * tradeSize;
  const slippageCost = (costs.slippageBps ?? 0) / 10000 * price * tradeSize;
  const rebate = (costs.makerRebate ?? 0) * price * tradeSize;

  return spreadCost + slippageCost - rebate;
}

export function runBacktest(params: {
  strategy: BacktestStrategy;
  tokenId: string;
  marketQuestion: string;
  bars: PriceBar[];
  risk?: BacktestRiskConfig;
  costs?: BacktestCostConfig;
}): BacktestResult {
  const { strategy, tokenId, marketQuestion, bars, risk, costs } = params;

  let position: PositionSide = 0;
  let pnl = 0;
  let totalCosts = 0;
  const trades: BacktestTrade[] = [];
  const equityCurve: number[] = [0];
  const returns: number[] = [];
  let winningMoves = 0;
  let totalMoves = 0;
  let lastTradeIndex = -1_000_000;
  let riskEvents = 0;
  let inMarketBars = 0;

  for (let i = 1; i < bars.length; i++) {
    const prev = bars[i - 1];
    const curr = bars[i];
    const priceChange = curr.price - prev.price;
    const incrementalPnl = position * priceChange;
    if (position !== 0) {
      inMarketBars += 1;
    }
    pnl += incrementalPnl;
    equityCurve.push(pnl);
    returns.push(incrementalPnl);

    const riskExitReason = maybeApplyRiskExit({ risk, pnl, position });
    if (riskExitReason) {
      const exitCost = computeTransactionCost(curr.price, Math.abs(position), costs);
      pnl -= exitCost;
      totalCosts += exitCost;
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
      const positionChange = Math.abs(signal.targetPosition - oldPosition);
      const tradeCost = computeTransactionCost(curr.price, positionChange, costs);
      pnl -= tradeCost;
      totalCosts += tradeCost;

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

  const maxDrawdown = computeMaxDrawdown(equityCurve);
  const enhanced = computeEnhancedMetrics(returns, pnl, maxDrawdown);

  return {
    strategyName: strategy.name,
    tokenId,
    marketQuestion,
    bars: bars.length,
    trades,
    tradeCount: trades.length,
    totalPnl: pnl,
    totalCosts,
    grossPnl: pnl + totalCosts,
    maxDrawdown,
    winRate: totalMoves === 0 ? 0 : winningMoves / totalMoves,
    sharpe: computeSharpe(returns),
    sortino: computeSortino(returns),
    profitFactor: computeProfitFactor(returns),
    exposure: bars.length <= 1 ? 0 : inMarketBars / (bars.length - 1),
    equityCurve,
    returns,
    riskEvents,

    // Enhanced metrics
    calmarRatio: enhanced.calmarRatio,
    avgWin: enhanced.avgWin,
    avgLoss: enhanced.avgLoss,
    payoffRatio: enhanced.payoffRatio,
    expectancy: enhanced.expectancy,
    recoveryFactor: enhanced.recoveryFactor,
    ulcerIndex: computeUlcerIndex(equityCurve),
    tailRatio: enhanced.tailRatio,
  };
}
