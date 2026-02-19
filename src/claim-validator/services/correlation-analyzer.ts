import * as fs from "fs";
import * as path from "path";
import { CorrelationResult } from "../types";

interface StrategyReturns {
  strategyName: string;
  returns: number[];
  family: string;
  updatedAt: string;
}

const RETURNS_DIR = "backtests/strategy-returns";

export class CorrelationAnalyzer {
  private btcReturns: StrategyReturns[];
  private weatherReturns: StrategyReturns[];
  private basePath: string;

  constructor(basePath: string = process.cwd()) {
    this.basePath = basePath;
    this.btcReturns = this.loadReturns("btc");
    this.weatherReturns = this.loadReturns("weather");
  }

  /**
   * Load stored strategy returns for correlation analysis
   */
  private loadReturns(family: string): StrategyReturns[] {
    try {
      const filePath = path.join(this.basePath, RETURNS_DIR, `${family}-returns.json`);
      if (fs.existsSync(filePath)) {
        return JSON.parse(fs.readFileSync(filePath, "utf-8"));
      }
    } catch {
      // Ignore
    }
    return [];
  }

  /**
   * Analyze correlation of new claim's potential returns against existing strategies
   */
  analyze(claimReturns: number[]): CorrelationResult {
    if (claimReturns.length < 10) {
      return {
        btcCorrelation: 0,
        weatherCorrelation: 0,
        isUncorrelated: true,
        diversificationScore: 5,
        analysis: "Insufficient return data for correlation analysis (need at least 10 data points)",
      };
    }

    // Compute correlation against BTC strategies
    const btcCorrelation = this.computeAverageCorrelation(claimReturns, this.btcReturns);

    // Compute correlation against weather strategies
    const weatherCorrelation = this.computeAverageCorrelation(claimReturns, this.weatherReturns);

    // Determine if uncorrelated (|corr| < 0.3)
    const isUncorrelated = Math.abs(btcCorrelation) < 0.3 && Math.abs(weatherCorrelation) < 0.3;

    // Compute diversification score
    // Lower correlation = higher diversification value
    const avgAbsCorr = (Math.abs(btcCorrelation) + Math.abs(weatherCorrelation)) / 2;
    const diversificationScore = Math.round((1 - avgAbsCorr) * 10);

    return {
      btcCorrelation: Math.round(btcCorrelation * 1000) / 1000,
      weatherCorrelation: Math.round(weatherCorrelation * 1000) / 1000,
      isUncorrelated,
      diversificationScore: Math.max(0, Math.min(10, diversificationScore)),
      analysis: this.generateAnalysis(btcCorrelation, weatherCorrelation, isUncorrelated, diversificationScore),
    };
  }

  /**
   * Compute Pearson correlation between two return series
   */
  private pearsonCorrelation(x: number[], y: number[]): number {
    const n = Math.min(x.length, y.length);
    if (n < 5) return 0;

    const xSlice = x.slice(0, n);
    const ySlice = y.slice(0, n);

    const meanX = xSlice.reduce((a, b) => a + b, 0) / n;
    const meanY = ySlice.reduce((a, b) => a + b, 0) / n;

    let numerator = 0;
    let sumSqX = 0;
    let sumSqY = 0;

    for (let i = 0; i < n; i++) {
      const dx = xSlice[i] - meanX;
      const dy = ySlice[i] - meanY;
      numerator += dx * dy;
      sumSqX += dx * dx;
      sumSqY += dy * dy;
    }

    const denominator = Math.sqrt(sumSqX * sumSqY);
    if (denominator === 0) return 0;

    return numerator / denominator;
  }

  /**
   * Compute average correlation against a set of strategies
   */
  private computeAverageCorrelation(claimReturns: number[], strategies: StrategyReturns[]): number {
    if (strategies.length === 0) return 0;

    const correlations = strategies
      .filter(s => s.returns.length >= 10)
      .map(s => this.pearsonCorrelation(claimReturns, s.returns));

    if (correlations.length === 0) return 0;

    return correlations.reduce((a, b) => a + b, 0) / correlations.length;
  }

  private generateAnalysis(
    btcCorr: number,
    weatherCorr: number,
    isUncorrelated: boolean,
    divScore: number
  ): string {
    let analysis = "";

    // BTC correlation interpretation
    if (Math.abs(btcCorr) > 0.7) {
      analysis += `Highly correlated with BTC strategies (${btcCorr.toFixed(2)}). `;
    } else if (Math.abs(btcCorr) > 0.3) {
      analysis += `Moderately correlated with BTC strategies (${btcCorr.toFixed(2)}). `;
    } else {
      analysis += `Uncorrelated with BTC strategies (${btcCorr.toFixed(2)}). `;
    }

    // Weather correlation
    if (Math.abs(weatherCorr) > 0.3) {
      analysis += `Some correlation with weather strategies (${weatherCorr.toFixed(2)}). `;
    }

    // Diversification assessment
    if (isUncorrelated) {
      analysis += `Strong diversification potential - this strategy could reduce portfolio volatility. `;
    } else if (btcCorr > 0.5) {
      analysis += `Limited diversification benefit - returns move with your BTC exposure. `;
    }

    analysis += `Diversification score: ${divScore}/10.`;

    return analysis;
  }

  /**
   * Store returns from a backtest for future correlation analysis
   */
  static storeReturns(basePath: string, family: string, strategyName: string, returns: number[]): void {
    const dirPath = path.join(basePath, RETURNS_DIR);
    const filePath = path.join(dirPath, `${family}-returns.json`);

    // Ensure directory exists
    if (!fs.existsSync(dirPath)) {
      fs.mkdirSync(dirPath, { recursive: true });
    }

    let existing: StrategyReturns[] = [];

    try {
      if (fs.existsSync(filePath)) {
        existing = JSON.parse(fs.readFileSync(filePath, "utf-8"));
      }
    } catch {
      // Ignore
    }

    // Update or add
    const idx = existing.findIndex(s => s.strategyName === strategyName);
    const entry: StrategyReturns = {
      strategyName,
      returns,
      family,
      updatedAt: new Date().toISOString(),
    };

    if (idx >= 0) {
      existing[idx] = entry;
    } else {
      existing.push(entry);
    }

    fs.writeFileSync(filePath, JSON.stringify(existing, null, 2));
  }

  /**
   * Reload returns from disk
   */
  reload(): void {
    this.btcReturns = this.loadReturns("btc");
    this.weatherReturns = this.loadReturns("weather");
  }
}
