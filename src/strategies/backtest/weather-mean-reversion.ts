import { BacktestStrategy, PositionSide, PriceBar, StrategySignal } from "../../backtesting/types";

function avg(values: number[]): number {
  return values.reduce((a, b) => a + b, 0) / values.length;
}

function std(values: number[]): number {
  if (values.length < 2) return 0;
  const mean = avg(values);
  const variance = values.reduce((a, v) => a + (v - mean) ** 2, 0) / (values.length - 1);
  return Math.sqrt(variance);
}

export class WeatherMeanReversionStrategy implements BacktestStrategy {
  name = "weather-mean-reversion";
  warmupBars: number;

  constructor(
    private readonly window = 24,
    private readonly zEntry = 1.2,
    private readonly zExit = 0.3
  ) {
    this.warmupBars = window;
  }

  static fromParams(params: { window: number; zEntry: number; zExit: number }) {
    return new WeatherMeanReversionStrategy(params.window, params.zEntry, params.zExit);
  }

  getSignal(series: PriceBar[], index: number, currentPosition: PositionSide): StrategySignal | null {
    const sample = series.slice(index - this.window + 1, index + 1).map((b) => b.price);
    const mean = avg(sample);
    const sigma = std(sample);
    if (sigma === 0) return null;

    const z = (series[index].price - mean) / sigma;

    if (z > this.zEntry && currentPosition !== -1) {
      return { targetPosition: -1, reason: "Price stretched above mean" };
    }

    if (z < -this.zEntry && currentPosition !== 1) {
      return { targetPosition: 1, reason: "Price stretched below mean" };
    }

    if (Math.abs(z) < this.zExit && currentPosition !== 0) {
      return { targetPosition: 0, reason: "Reverted near mean" };
    }

    return null;
  }
}
