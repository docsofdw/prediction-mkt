import { BacktestStrategy, PositionSide, PriceBar, StrategySignal } from "../../backtesting/types";
import { avg, std, ewma, ewmStd, halfLife, volatility } from "./indicators";

export interface WeatherMeanReversionParams {
  window: number;
  zEntry: number;
  zExit: number;
  useEwma?: boolean;
  ewmaAlpha?: number;
  maxHalfLife?: number;
  useVolatilityScaling?: boolean;
}

export class WeatherMeanReversionStrategy implements BacktestStrategy {
  name = "weather-mean-reversion";
  warmupBars: number;

  constructor(
    private readonly window = 24,
    private readonly zEntry = 1.2,
    private readonly zExit = 0.3,
    private readonly useEwma = true,
    private readonly ewmaAlpha = 0.1,
    private readonly maxHalfLife = 30,
    private readonly useVolatilityScaling = true
  ) {
    this.warmupBars = Math.max(window, 30);
  }

  static fromParams(params: WeatherMeanReversionParams) {
    return new WeatherMeanReversionStrategy(
      params.window,
      params.zEntry,
      params.zExit,
      params.useEwma ?? true,
      params.ewmaAlpha ?? 0.1,
      params.maxHalfLife ?? 30,
      params.useVolatilityScaling ?? true
    );
  }

  getSignal(series: PriceBar[], index: number, currentPosition: PositionSide): StrategySignal | null {
    const sample = series.slice(index - this.window + 1, index + 1).map((b) => b.price);
    const prices = series.slice(0, index + 1).map((b) => b.price);

    // Half-life filter: only trade if market shows mean-reverting behavior
    const hl = halfLife(prices);
    if (hl < 0 || hl > this.maxHalfLife) {
      // Not mean-reverting or reverting too slowly
      return null;
    }

    // Compute mean and std using EWMA or simple
    let mean: number;
    let sigma: number;

    if (this.useEwma) {
      mean = ewma(sample, this.ewmaAlpha);
      sigma = ewmStd(sample, this.ewmaAlpha);
    } else {
      mean = avg(sample);
      sigma = std(sample);
    }

    if (sigma === 0) return null;

    // Calculate z-score
    const z = (series[index].price - mean) / sigma;

    // Dynamic z-thresholds based on volatility regime
    let effectiveZEntry = this.zEntry;
    let effectiveZExit = this.zExit;

    if (this.useVolatilityScaling) {
      const regimeVol = volatility(prices, 50);
      // Tighter thresholds in low-vol, wider in high-vol
      const volMultiplier = 1 + regimeVol * 5;
      effectiveZEntry = this.zEntry * volMultiplier;
      effectiveZExit = this.zExit * volMultiplier;
    }

    if (z > effectiveZEntry && currentPosition !== -1) {
      return { targetPosition: -1, reason: `Price stretched above mean (z: ${z.toFixed(2)}, HL: ${hl.toFixed(1)})` };
    }

    if (z < -effectiveZEntry && currentPosition !== 1) {
      return { targetPosition: 1, reason: `Price stretched below mean (z: ${z.toFixed(2)}, HL: ${hl.toFixed(1)})` };
    }

    if (Math.abs(z) < effectiveZExit && currentPosition !== 0) {
      return { targetPosition: 0, reason: "Reverted near mean" };
    }

    return null;
  }
}
