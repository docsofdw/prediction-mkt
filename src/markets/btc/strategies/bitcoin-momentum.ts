import { BacktestStrategy, PositionSide, PriceBar, StrategySignal } from "../../../backtesting/types";
import { avg, adx, volatility } from "../../../strategies/backtest/indicators";

export interface BitcoinMomentumParams {
  shortWindow: number;
  longWindow: number;
  threshold: number;
  adxThreshold?: number;
  confirmationBars?: number;
  useVolatilityScaling?: boolean;
}

export class BitcoinMomentumStrategy implements BacktestStrategy {
  name = "bitcoin-momentum";
  warmupBars: number;

  // Signal confirmation state
  private consecutiveBullish = 0;
  private consecutiveBearish = 0;

  constructor(
    private readonly shortWindow = 6,
    private readonly longWindow = 24,
    private readonly threshold = 0.005,
    private readonly adxThreshold = 20,
    private readonly confirmationBars = 2,
    private readonly useVolatilityScaling = true
  ) {
    this.warmupBars = Math.max(shortWindow, longWindow, 30); // Need extra for ADX
  }

  static fromParams(params: BitcoinMomentumParams) {
    return new BitcoinMomentumStrategy(
      params.shortWindow,
      params.longWindow,
      params.threshold,
      params.adxThreshold ?? 20,
      params.confirmationBars ?? 2,
      params.useVolatilityScaling ?? true
    );
  }

  getSignal(series: PriceBar[], index: number, currentPosition: PositionSide): StrategySignal | null {
    const prices = series.slice(0, index + 1).map((b) => b.price);

    // ADX filter: only trade in trending markets
    const currentAdx = adx(prices, 14);
    if (currentAdx < this.adxThreshold) {
      // Reset confirmation counters in ranging markets
      this.consecutiveBullish = 0;
      this.consecutiveBearish = 0;
      return null;
    }

    const shortSlice = series.slice(index - this.shortWindow + 1, index + 1).map((b) => b.price);
    const longSlice = series.slice(index - this.longWindow + 1, index + 1).map((b) => b.price);

    const shortMa = avg(shortSlice);
    const longMa = avg(longSlice);

    // Dynamic threshold based on volatility
    let effectiveThreshold = this.threshold;
    if (this.useVolatilityScaling) {
      const recentVol = volatility(prices, 20);
      effectiveThreshold = this.threshold * (1 + recentVol * 10);
    }

    // Check for bullish crossover
    const isBullish = shortMa > longMa * (1 + effectiveThreshold);
    // Check for bearish crossover
    const isBearish = shortMa < longMa * (1 - effectiveThreshold);

    // Signal confirmation: require consecutive bars
    if (isBullish) {
      this.consecutiveBullish++;
      this.consecutiveBearish = 0;
    } else if (isBearish) {
      this.consecutiveBearish++;
      this.consecutiveBullish = 0;
    } else {
      this.consecutiveBullish = 0;
      this.consecutiveBearish = 0;
    }

    // Only generate signal after confirmation
    if (this.consecutiveBullish >= this.confirmationBars && currentPosition !== 1) {
      return { targetPosition: 1, reason: `Bullish MA crossover (ADX: ${currentAdx.toFixed(1)})` };
    }

    if (this.consecutiveBearish >= this.confirmationBars && currentPosition !== -1) {
      return { targetPosition: -1, reason: `Bearish MA crossover (ADX: ${currentAdx.toFixed(1)})` };
    }

    return null;
  }
}
