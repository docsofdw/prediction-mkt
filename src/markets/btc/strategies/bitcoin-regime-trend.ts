import { BacktestStrategy, PositionSide, PriceBar, StrategySignal } from "../../../backtesting/types";
import { avg, rsi, std } from "../../../strategies/backtest/indicators";

export interface BitcoinRegimeTrendParams {
  trendWindow: number;
  triggerWindow: number;
  rsiPeriod: number;
  rsiLongMin: number;
  rsiShortMax: number;
  volatilityCap: number;
}

export class BitcoinRegimeTrendStrategy implements BacktestStrategy {
  name = "bitcoin-regime-trend";
  warmupBars: number;

  constructor(private readonly params: BitcoinRegimeTrendParams) {
    this.warmupBars = Math.max(params.trendWindow, params.triggerWindow, params.rsiPeriod + 1);
  }

  static fromParams(params: BitcoinRegimeTrendParams): BitcoinRegimeTrendStrategy {
    return new BitcoinRegimeTrendStrategy(params);
  }

  getSignal(series: PriceBar[], index: number, currentPosition: PositionSide): StrategySignal | null {
    const trendSlice = series.slice(index - this.params.trendWindow + 1, index + 1).map((b) => b.price);
    const triggerSlice = series.slice(index - this.params.triggerWindow + 1, index + 1).map((b) => b.price);

    const trendMa = avg(trendSlice);
    const triggerMa = avg(triggerSlice);
    if (trendMa <= 0) return null;

    const trendStrength = (triggerMa - trendMa) / trendMa;
    const rsiValue = rsi(series.slice(0, index + 1).map((b) => b.price), this.params.rsiPeriod);

    const returns = triggerSlice.slice(1).map((value, i) => value - triggerSlice[i]);
    const triggerVol = std(returns);
    if (triggerMa > 0 && triggerVol / triggerMa > this.params.volatilityCap) {
      return currentPosition !== 0 ? { targetPosition: 0, reason: "Volatility too high" } : null;
    }

    if (trendStrength > 0 && rsiValue >= this.params.rsiLongMin && currentPosition !== 1) {
      return { targetPosition: 1, reason: "Regime trend long" };
    }

    if (trendStrength < 0 && rsiValue <= this.params.rsiShortMax && currentPosition !== -1) {
      return { targetPosition: -1, reason: "Regime trend short" };
    }

    if (Math.abs(trendStrength) < 0.0015 && currentPosition !== 0) {
      return { targetPosition: 0, reason: "Trend neutralized" };
    }

    return null;
  }
}
