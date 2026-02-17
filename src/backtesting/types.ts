export interface PriceBar {
  timestamp: number;
  price: number;
}

export type PositionSide = -1 | 0 | 1;

export interface BacktestTrade {
  timestamp: number;
  price: number;
  from: PositionSide;
  to: PositionSide;
  reason: string;
}

export interface BacktestRiskConfig {
  stopLoss?: number;
  takeProfit?: number;
  minBarsBetweenTrades?: number;
  maxTrades?: number;
}

export interface BacktestCostConfig {
  spreadBps?: number;      // Spread in basis points (default 10-50 bps for Polymarket)
  slippageBps?: number;    // Size-dependent slippage in basis points
  makerRebate?: number;    // Maker rebate as a fraction (e.g., 0.0001 for 1 bps)
}

export interface BacktestResult {
  strategyName: string;
  tokenId: string;
  marketQuestion: string;
  bars: number;
  trades: BacktestTrade[];
  tradeCount: number;
  totalPnl: number;
  totalCosts: number;
  grossPnl: number;
  maxDrawdown: number;
  winRate: number;
  sharpe: number;
  sortino: number;
  profitFactor: number;
  exposure: number;
  equityCurve: number[];
  returns: number[];
  riskEvents: number;

  // Enhanced metrics
  calmarRatio: number;        // Return / MaxDrawdown
  avgWin: number;             // Average winning trade
  avgLoss: number;            // Average losing trade
  payoffRatio: number;        // avgWin / avgLoss
  expectancy: number;         // (winRate * avgWin) - ((1-winRate) * avgLoss)
  recoveryFactor: number;     // Total PnL / MaxDrawdown
  ulcerIndex: number;         // Pain of drawdowns over time
  tailRatio: number;          // 95th percentile win / 5th percentile loss (risk/reward asymmetry)
}

export interface StrategySignal {
  targetPosition: PositionSide;
  reason: string;
}

export interface BacktestStrategy {
  name: string;
  warmupBars: number;
  getSignal(series: PriceBar[], index: number, currentPosition: PositionSide): StrategySignal | null;
}

export interface WalkForwardResult<TParams> {
  bestParams: TParams;
  candidatesEvaluated: number;
  train: BacktestResult;
  test: BacktestResult;
  overfitScore: number;       // Train Sharpe / Test Sharpe ratio (>1.5 indicates overfitting)
  robustnessScore: number;    // Combined metric accounting for train/test divergence
}
