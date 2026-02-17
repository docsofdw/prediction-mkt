import { BacktestStrategy, PositionSide, PriceBar, StrategySignal } from "../../backtesting/types";

function avg(values: number[]): number {
  return values.reduce((a, b) => a + b, 0) / values.length;
}

export class BitcoinMomentumStrategy implements BacktestStrategy {
  name = "bitcoin-momentum";
  warmupBars: number;

  constructor(
    private readonly shortWindow = 6,
    private readonly longWindow = 24,
    private readonly threshold = 0.005
  ) {
    this.warmupBars = Math.max(shortWindow, longWindow);
  }

  static fromParams(params: { shortWindow: number; longWindow: number; threshold: number }) {
    return new BitcoinMomentumStrategy(params.shortWindow, params.longWindow, params.threshold);
  }

  getSignal(series: PriceBar[], index: number, currentPosition: PositionSide): StrategySignal | null {
    const shortSlice = series.slice(index - this.shortWindow + 1, index + 1).map((b) => b.price);
    const longSlice = series.slice(index - this.longWindow + 1, index + 1).map((b) => b.price);

    const shortMa = avg(shortSlice);
    const longMa = avg(longSlice);

    if (shortMa > longMa * (1 + this.threshold) && currentPosition !== 1) {
      return { targetPosition: 1, reason: "Short MA above long MA" };
    }

    if (shortMa < longMa * (1 - this.threshold) && currentPosition !== -1) {
      return { targetPosition: -1, reason: "Short MA below long MA" };
    }

    return null;
  }
}
