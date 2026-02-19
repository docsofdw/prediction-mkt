import { BacktestStrategy, PositionSide, PriceBar, StrategySignal } from "../../../backtesting/types";
import { avg, highest, lowest, std } from "../../../strategies/backtest/indicators";

export interface BitcoinBreakoutParams {
  breakoutWindow: number;
  confirmWindow: number;
  volatilityFloor: number;
  stopToFlat: number;
}

export class BitcoinBreakoutStrategy implements BacktestStrategy {
  name = "bitcoin-breakout";
  warmupBars: number;

  constructor(private readonly params: BitcoinBreakoutParams) {
    this.warmupBars = Math.max(params.breakoutWindow + 1, params.confirmWindow);
  }

  static fromParams(params: BitcoinBreakoutParams): BitcoinBreakoutStrategy {
    return new BitcoinBreakoutStrategy(params);
  }

  getSignal(series: PriceBar[], index: number, currentPosition: PositionSide): StrategySignal | null {
    const current = series[index].price;
    const prev = series[index - 1].price;

    const lookback = series.slice(index - this.params.breakoutWindow, index).map((b) => b.price);
    const upper = highest(lookback);
    const lower = lowest(lookback);

    const confirmSample = series.slice(index - this.params.confirmWindow + 1, index + 1).map((b) => b.price);
    const localMean = avg(confirmSample);
    const localVol = std(confirmSample);

    if (localMean <= 0 || localVol / localMean < this.params.volatilityFloor) {
      return null;
    }

    if (currentPosition === 1 && current < localMean * (1 - this.params.stopToFlat)) {
      return { targetPosition: 0, reason: "Breakout stop-to-flat (long)" };
    }

    if (currentPosition === -1 && current > localMean * (1 + this.params.stopToFlat)) {
      return { targetPosition: 0, reason: "Breakout stop-to-flat (short)" };
    }

    if (current > upper && prev <= upper && currentPosition !== 1) {
      return { targetPosition: 1, reason: "Upside breakout" };
    }

    if (current < lower && prev >= lower && currentPosition !== -1) {
      return { targetPosition: -1, reason: "Downside breakout" };
    }

    return null;
  }
}
