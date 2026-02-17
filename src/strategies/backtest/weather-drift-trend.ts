import { BacktestStrategy, PositionSide, PriceBar, StrategySignal } from "../../backtesting/types";
import { avg, slope } from "./indicators";

export interface WeatherDriftTrendParams {
  trendWindow: number;
  triggerWindow: number;
  minSlope: number;
  maxDistance: number;
}

export class WeatherDriftTrendStrategy implements BacktestStrategy {
  name = "weather-drift-trend";
  warmupBars: number;

  constructor(private readonly params: WeatherDriftTrendParams) {
    this.warmupBars = Math.max(params.trendWindow, params.triggerWindow);
  }

  static fromParams(params: WeatherDriftTrendParams): WeatherDriftTrendStrategy {
    return new WeatherDriftTrendStrategy(params);
  }

  getSignal(series: PriceBar[], index: number, currentPosition: PositionSide): StrategySignal | null {
    const trendSlice = series.slice(index - this.params.trendWindow + 1, index + 1).map((b) => b.price);
    const triggerSlice = series.slice(index - this.params.triggerWindow + 1, index + 1).map((b) => b.price);

    const baseSlope = slope(trendSlice);
    const triggerMean = avg(triggerSlice);
    const longMean = avg(trendSlice);

    if (longMean <= 0) return null;

    const distance = Math.abs(triggerMean - longMean) / longMean;
    if (distance > this.params.maxDistance) {
      return currentPosition !== 0 ? { targetPosition: 0, reason: "Weather drift over-extended" } : null;
    }

    if (baseSlope >= this.params.minSlope && currentPosition !== 1) {
      return { targetPosition: 1, reason: "Weather upward drift" };
    }

    if (baseSlope <= -this.params.minSlope && currentPosition !== -1) {
      return { targetPosition: -1, reason: "Weather downward drift" };
    }

    if (Math.abs(baseSlope) < this.params.minSlope * 0.4 && currentPosition !== 0) {
      return { targetPosition: 0, reason: "Weather drift stalled" };
    }

    return null;
  }
}
