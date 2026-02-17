import { MarketSnapshot, Strategy, TradeSignal } from "../types";

function avg(values: number[]): number {
  return values.reduce((a, b) => a + b, 0) / values.length;
}

function std(values: number[]): number {
  if (values.length < 2) return 0;
  const mean = avg(values);
  const variance = values.reduce((a, v) => a + (v - mean) ** 2, 0) / (values.length - 1);
  return Math.sqrt(variance);
}

export class DualLiveStrategy implements Strategy {
  name = "dual-live";
  description = "BTC momentum + weather mean-reversion";

  private readonly history = new Map<string, number[]>();

  constructor(private readonly tradeSize: number) {}

  async initialize(): Promise<void> {
    return;
  }

  async evaluate(snapshot: MarketSnapshot): Promise<TradeSignal[]> {
    const px = snapshot.lastPrice > 0 ? snapshot.lastPrice : (snapshot.bestBid + snapshot.bestAsk) / 2;
    if (!Number.isFinite(px) || px <= 0) return [];

    const arr = this.history.get(snapshot.tokenId) ?? [];
    arr.push(px);
    if (arr.length > 64) arr.shift();
    this.history.set(snapshot.tokenId, arr);

    const question = snapshot.question.toLowerCase();
    const isWeather = /(weather|hurricane|temperature|storm|rain|snow|climate)/.test(question);

    if (isWeather) {
      return this.weatherSignal(snapshot, arr);
    }

    return this.btcSignal(snapshot, arr);
  }

  private btcSignal(snapshot: MarketSnapshot, series: number[]): TradeSignal[] {
    const shortWindow = 8;
    const longWindow = 32;
    const threshold = 0.008;
    if (series.length < longWindow) return [];

    const shortMa = avg(series.slice(-shortWindow));
    const longMa = avg(series.slice(-longWindow));

    if (shortMa > longMa * (1 + threshold)) {
      return [{
        tokenId: snapshot.tokenId,
        side: "BUY",
        price: snapshot.bestAsk > 0 ? snapshot.bestAsk : series[series.length - 1],
        size: this.tradeSize,
        reason: "BTC momentum up",
      }];
    }

    if (shortMa < longMa * (1 - threshold)) {
      return [{
        tokenId: snapshot.tokenId,
        side: "SELL",
        price: snapshot.bestBid > 0 ? snapshot.bestBid : series[series.length - 1],
        size: this.tradeSize,
        reason: "BTC momentum down",
      }];
    }

    return [];
  }

  private weatherSignal(snapshot: MarketSnapshot, series: number[]): TradeSignal[] {
    const window = 32;
    const zEntry = 1.2;
    if (series.length < window) return [];

    const sample = series.slice(-window);
    const mu = avg(sample);
    const sigma = std(sample);
    if (sigma === 0) return [];

    const z = (series[series.length - 1] - mu) / sigma;

    if (z < -zEntry) {
      return [{
        tokenId: snapshot.tokenId,
        side: "BUY",
        price: snapshot.bestAsk > 0 ? snapshot.bestAsk : series[series.length - 1],
        size: this.tradeSize,
        reason: "Weather mean reversion long",
      }];
    }

    if (z > zEntry) {
      return [{
        tokenId: snapshot.tokenId,
        side: "SELL",
        price: snapshot.bestBid > 0 ? snapshot.bestBid : series[series.length - 1],
        size: this.tradeSize,
        reason: "Weather mean reversion short",
      }];
    }

    return [];
  }

  async teardown(): Promise<void> {
    return;
  }

  getDiagnostics(): unknown {
    return {
      trackedTokens: this.history.size,
    };
  }
}
