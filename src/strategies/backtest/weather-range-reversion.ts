import { BacktestStrategy, PositionSide, PriceBar, StrategySignal } from "../../backtesting/types";
import { avg, std } from "./indicators";

export interface WeatherRangeReversionParams {
  window: number;
  zEntry: number;
  zExit: number;
  volatilityCeiling: number;
}

export class WeatherRangeReversionStrategy implements BacktestStrategy {
  name = "weather-range-reversion";
  warmupBars: number;

  constructor(private readonly params: WeatherRangeReversionParams) {
    this.warmupBars = this.params.window;
  }

  static fromParams(params: WeatherRangeReversionParams): WeatherRangeReversionStrategy {
    return new WeatherRangeReversionStrategy(params);
  }

  getSignal(series: PriceBar[], index: number, currentPosition: PositionSide): StrategySignal | null {
    const sample = series.slice(index - this.params.window + 1, index + 1).map((b) => b.price);
    const mean = avg(sample);
    const sigma = std(sample);

    if (mean <= 0 || sigma === 0) return null;
    const volRatio = sigma / mean;

    if (volRatio > this.params.volatilityCeiling) {
      return currentPosition !== 0 ? { targetPosition: 0, reason: "Weather vol regime unsafe" } : null;
    }

    const z = (series[index].price - mean) / sigma;

    if (z > this.params.zEntry && currentPosition !== -1) {
      return { targetPosition: -1, reason: "Weather upper-band fade" };
    }

    if (z < -this.params.zEntry && currentPosition !== 1) {
      return { targetPosition: 1, reason: "Weather lower-band fade" };
    }

    if (Math.abs(z) <= this.params.zExit && currentPosition !== 0) {
      return { targetPosition: 0, reason: "Weather mean reached" };
    }

    return null;
  }
}
