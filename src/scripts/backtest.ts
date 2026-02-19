import fs from "node:fs";
import path from "node:path";
import { BacktestResult, BacktestRiskConfig } from "../backtesting/types";
import { getBitcoinCandidates, getWeatherCandidates } from "../backtesting/optimizer";
import { runWalkForward } from "../backtesting/walk-forward";
import { MarketDiscovery } from "../shared/services/market-discovery";
import { HistoricalPrices } from "../shared/services/historical-prices";
import { BitcoinMomentumStrategy } from "../markets/btc/strategies/bitcoin-momentum";
import { WeatherMeanReversionStrategy } from "../strategies/backtest/weather-mean-reversion";
import { log } from "../shared/utils/logger";

const gammaHost = process.env.GAMMA_HOST || "https://gamma-api.polymarket.com";
const clobHost = process.env.CLOB_HOST || "https://clob.polymarket.com";
const interval = (process.env.BACKTEST_INTERVAL as "max" | "1w" | "1d" | "6h" | "1h") || "1w";
const fidelity = Number(process.env.BACKTEST_FIDELITY || "15");
const maxPerCategory = Number(process.env.BACKTEST_MAX_MARKETS || "4");
const minBars = Number(process.env.BACKTEST_MIN_BARS || "30");
const trainSplit = Number(process.env.BACKTEST_TRAIN_SPLIT || "0.7");

const risk: BacktestRiskConfig = {
  stopLoss: process.env.RISK_STOP_LOSS ? Number(process.env.RISK_STOP_LOSS) : undefined,
  takeProfit: process.env.RISK_TAKE_PROFIT ? Number(process.env.RISK_TAKE_PROFIT) : undefined,
  minBarsBetweenTrades: Number(process.env.RISK_MIN_BARS_BETWEEN_TRADES || "2"),
  maxTrades: process.env.RISK_MAX_TRADES ? Number(process.env.RISK_MAX_TRADES) : undefined,
};

function summarize(results: BacktestResult[]): string {
  if (results.length === 0) return "No results";

  const totalPnl = results.reduce((a, r) => a + r.totalPnl, 0);
  const avgSharpe = results.reduce((a, r) => a + r.sharpe, 0) / results.length;
  const avgWinRate = results.reduce((a, r) => a + r.winRate, 0) / results.length;
  const totalRiskEvents = results.reduce((a, r) => a + r.riskEvents, 0);

  return `markets=${results.length} totalPnL=${totalPnl.toFixed(4)} avgSharpe=${avgSharpe.toFixed(3)} avgWinRate=${(avgWinRate * 100).toFixed(1)}% riskEvents=${totalRiskEvents}`;
}

type CategoryResult = {
  tokenId: string;
  question: string;
  bars: number;
  bestParams: unknown;
  candidatesEvaluated: number;
  train: BacktestResult;
  test: BacktestResult;
};

async function runCategory(params: {
  label: string;
  marketType: "bitcoin" | "weather";
  maxMarkets: number;
  interval: "max" | "1w" | "1d" | "6h" | "1h";
  fidelity: number;
  minBars: number;
  splitRatio: number;
}) {
  const { label, marketType, maxMarkets, interval, fidelity, minBars, splitRatio } = params;

  const discovery = new MarketDiscovery(gammaHost);
  const history = new HistoricalPrices(clobHost);

  const events = marketType === "bitcoin"
    ? await discovery.discoverBitcoinMarkets(20)
    : await discovery.discoverWeatherMarkets(20);

  const snapshots = events
    .flatMap((event) => discovery.snapshotMarkets(event))
    .filter((s) => s.tokenId)
    .sort((a, b) => b.volume - a.volume)
    .slice(0, maxMarkets);

  log.info(`[${label}] selected ${snapshots.length} market(s)`);

  const results: CategoryResult[] = [];

  for (const snap of snapshots) {
    try {
      const bars = await history.getBars({ tokenId: snap.tokenId, interval, fidelity });
      if (bars.length < minBars) {
        log.warn(`[${label}] skipping ${snap.tokenId} (bars=${bars.length}, min=${minBars})`);
        continue;
      }

      const wf = marketType === "bitcoin"
        ? runWalkForward({
            tokenId: snap.tokenId,
            marketQuestion: snap.question,
            bars,
            splitRatio,
            candidates: getBitcoinCandidates(),
            buildStrategy: (candidate) => BitcoinMomentumStrategy.fromParams(candidate),
            risk,
          })
        : runWalkForward({
            tokenId: snap.tokenId,
            marketQuestion: snap.question,
            bars,
            splitRatio,
            candidates: getWeatherCandidates(),
            buildStrategy: (candidate) => WeatherMeanReversionStrategy.fromParams(candidate),
            risk,
          });

      results.push({
        tokenId: snap.tokenId,
        question: snap.question,
        bars: bars.length,
        bestParams: wf.bestParams,
        candidatesEvaluated: wf.candidatesEvaluated,
        train: wf.train,
        test: wf.test,
      });

      log.info(
        `[${label}] ${snap.tokenId} testPnl=${wf.test.totalPnl.toFixed(4)} testSharpe=${wf.test.sharpe.toFixed(3)} best=${JSON.stringify(wf.bestParams)}`
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      log.warn(`[${label}] failed ${snap.tokenId}: ${message}`);
    }
  }

  return results;
}

function extractTestResults(results: CategoryResult[]): BacktestResult[] {
  return results.map((r) => r.test);
}

async function main() {
  log.info(
    `Starting walk-forward backtest interval=${interval} fidelity=${fidelity} maxPerCategory=${maxPerCategory} split=${trainSplit}`
  );

  const btcResults = await runCategory({
    label: "BTC",
    marketType: "bitcoin",
    maxMarkets: maxPerCategory,
    interval,
    fidelity,
    minBars,
    splitRatio: trainSplit,
  });

  const weatherResults = await runCategory({
    label: "WEATHER",
    marketType: "weather",
    maxMarkets: maxPerCategory,
    interval,
    fidelity,
    minBars,
    splitRatio: trainSplit,
  });

  const btcTest = extractTestResults(btcResults);
  const weatherTest = extractTestResults(weatherResults);

  log.info(`BTC summary (test): ${summarize(btcTest)}`);
  log.info(`WEATHER summary (test): ${summarize(weatherTest)}`);

  const output = {
    generatedAt: new Date().toISOString(),
    config: { interval, fidelity, maxPerCategory, minBars, trainSplit, risk },
    summaries: {
      bitcoin: summarize(btcTest),
      weather: summarize(weatherTest),
    },
    results: {
      bitcoin: btcResults,
      weather: weatherResults,
    },
  };

  const outputDir = path.resolve(process.cwd(), "backtests");
  const outputPath = path.join(outputDir, "latest.json");
  fs.mkdirSync(outputDir, { recursive: true });
  fs.writeFileSync(outputPath, JSON.stringify(output, null, 2));

  log.info(`Wrote backtest report: ${outputPath}`);
}

main().catch((err) => {
  const message = err instanceof Error ? err.stack || err.message : String(err);
  log.error(`Backtest failed: ${message}`);
  process.exit(1);
});
