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

export interface BacktestResult {
  strategyName: string;
  tokenId: string;
  marketQuestion: string;
  bars: number;
  trades: BacktestTrade[];
  totalPnl: number;
  maxDrawdown: number;
  winRate: number;
  sharpe: number;
  riskEvents: number;
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
}
