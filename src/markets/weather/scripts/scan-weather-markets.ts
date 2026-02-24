/**
 * Weather Market Scanner
 *
 * Scans Polymarket weather markets for mispricings using:
 * - USGS earthquake data + Poisson models
 * - NWS temperature forecasts + error distributions
 *
 * Uses the Polymarket CLI for market data.
 *
 * Usage:
 *   npm run weather:scan [--type=earthquake|temperature|all] [--min-edge=0.15]
 */

import "dotenv/config";
import { execSync } from "child_process";
import {
  analyzeEarthquakeMarket,
  parseEarthquakeQuestion,
  fetchEarthquakeCount,
  EarthquakeMarket,
  EarthquakeAnalysis,
} from "../analyzers/earthquake";
import {
  analyzeTemperatureMarket,
  parseTemperatureQuestion,
  TemperatureMarket,
  TemperatureAnalysis,
} from "../analyzers/temperature";
import { log } from "../../../shared/utils/logger";

interface CliMarket {
  id: string;
  question: string;
  slug: string;
  outcomePrices: string[];
  active: boolean;
  closed: boolean;
}

/**
 * Fetch markets using the Polymarket CLI
 */
function fetchMarketsFromCli(searchTerm: string, limit: number = 50): CliMarket[] {
  try {
    const cmd = `polymarket -o json markets search "${searchTerm}" --limit ${limit}`;
    const output = execSync(cmd, {
      encoding: "utf-8",
      timeout: 30000,
      maxBuffer: 10 * 1024 * 1024, // 10MB buffer
    });
    return JSON.parse(output);
  } catch (err) {
    log.error(`CLI fetch failed: ${err}`);
    return [];
  }
}

/**
 * Scan earthquake markets
 */
async function scanEarthquakeMarkets(minEdge: number): Promise<EarthquakeAnalysis[]> {
  log.info("Scanning earthquake markets...");

  const markets = fetchMarketsFromCli("earthquakes magnitude 7.0", 30);
  const activeMarkets = markets.filter(m => m.active && !m.closed);

  log.info(`Found ${activeMarkets.length} active earthquake markets`);

  const analyses: EarthquakeAnalysis[] = [];

  for (const m of activeMarkets) {
    const parsed = parseEarthquakeQuestion(m.question);
    if (!parsed || !parsed.endDate) continue;

    const prices = typeof m.outcomePrices === "string"
      ? JSON.parse(m.outcomePrices)
      : m.outcomePrices;
    const yesPrice = parseFloat(prices[0]);

    const market: EarthquakeMarket = {
      slug: m.slug,
      question: m.question,
      yesPrice,
      threshold: parsed.threshold,
      comparison: parsed.comparison,
      endDate: parsed.endDate,
      magnitude: parsed.magnitude,
    };

    try {
      const analysis = await analyzeEarthquakeMarket(market);
      if (Math.abs(analysis.edge) >= minEdge) {
        analyses.push(analysis);
      }
    } catch (err) {
      log.warn(`Failed to analyze ${m.slug}: ${err}`);
    }
  }

  return analyses.sort((a, b) => Math.abs(b.edge) - Math.abs(a.edge));
}

/**
 * Scan temperature markets
 */
async function scanTemperatureMarkets(minEdge: number): Promise<TemperatureAnalysis[]> {
  log.info("Scanning temperature markets...");

  // Search for various temperature markets
  const searchTerms = ["temperature Miami", "temperature New York", "temperature Chicago"];
  const allMarkets: CliMarket[] = [];

  for (const term of searchTerms) {
    const markets = fetchMarketsFromCli(term, 30);
    allMarkets.push(...markets);
  }

  // Dedupe by slug
  const seen = new Set<string>();
  const uniqueMarkets = allMarkets.filter(m => {
    if (seen.has(m.slug)) return false;
    seen.add(m.slug);
    return m.active && !m.closed;
  });

  log.info(`Found ${uniqueMarkets.length} active temperature markets`);

  const analyses: TemperatureAnalysis[] = [];

  for (const m of uniqueMarkets) {
    const parsed = parseTemperatureQuestion(m.question);
    if (!parsed || !parsed.date) continue;

    const prices = typeof m.outcomePrices === "string"
      ? JSON.parse(m.outcomePrices)
      : m.outcomePrices;
    const yesPrice = parseFloat(prices[0]);

    const market: TemperatureMarket = {
      slug: m.slug,
      question: m.question,
      yesPrice,
      city: parsed.city,
      date: parsed.date,
      tempMin: parsed.tempMin,
      tempMax: parsed.tempMax,
      comparison: parsed.comparison,
      unit: parsed.unit,
    };

    try {
      const analysis = await analyzeTemperatureMarket(market);
      if (analysis.edge !== null && Math.abs(analysis.edge) >= minEdge) {
        analyses.push(analysis);
      }
    } catch (err) {
      log.warn(`Failed to analyze ${m.slug}: ${err}`);
    }
  }

  return analyses.sort((a, b) => Math.abs(b.edge || 0) - Math.abs(a.edge || 0));
}

/**
 * Print earthquake analysis results
 */
function printEarthquakeResults(analyses: EarthquakeAnalysis[]): void {
  console.log("\n════════════════════════════════════════════════════════════");
  console.log("  EARTHQUAKE MARKET OPPORTUNITIES");
  console.log("════════════════════════════════════════════════════════════\n");

  if (analyses.length === 0) {
    console.log("  No opportunities found above threshold.\n");
    return;
  }

  for (const a of analyses) {
    const arrow = a.recommendation === "BUY" ? "📈" : a.recommendation === "SELL" ? "📉" : "➖";
    const conf = a.confidence === "HIGH" ? "🔥" : a.confidence === "MEDIUM" ? "⚡" : "";

    console.log(`${arrow} ${conf} ${a.market.question.slice(0, 70)}`);
    console.log(`   Market: ${(a.marketProbability * 100).toFixed(1)}c | Model: ${(a.modelProbability * 100).toFixed(1)}% | Edge: ${(a.edge * 100).toFixed(1)}%`);
    console.log(`   Current count: ${a.currentCount} | Days remaining: ${a.daysRemaining.toFixed(0)}`);
    console.log(`   → ${a.recommendation} (${a.confidence} confidence)`);
    console.log();
  }
}

/**
 * Print temperature analysis results
 */
function printTemperatureResults(analyses: TemperatureAnalysis[]): void {
  console.log("\n════════════════════════════════════════════════════════════");
  console.log("  TEMPERATURE MARKET OPPORTUNITIES");
  console.log("════════════════════════════════════════════════════════════\n");

  if (analyses.length === 0) {
    console.log("  No opportunities found above threshold.\n");
    return;
  }

  for (const a of analyses) {
    if (a.recommendation === "NO_DATA") continue;

    const arrow = a.recommendation === "BUY" ? "📈" : a.recommendation === "SELL" ? "📉" : "➖";
    const conf = a.confidence === "HIGH" ? "🔥" : a.confidence === "MEDIUM" ? "⚡" : "";

    console.log(`${arrow} ${conf} ${a.market.question.slice(0, 70)}`);
    console.log(`   Market: ${(a.marketProbability * 100).toFixed(1)}c | Model: ${(a.modelProbability! * 100).toFixed(1)}% | Edge: ${(a.edge! * 100).toFixed(1)}%`);
    console.log(`   Forecast: ${a.forecastTemp?.toFixed(0)}°${a.market.unit} ± ${a.forecastError.toFixed(1)}° | Days out: ${a.daysOut}`);
    console.log(`   → ${a.recommendation} (${a.confidence} confidence)`);
    console.log();
  }
}

/**
 * Print quick summary of current earthquake status
 */
async function printEarthquakeStatus(): Promise<void> {
  const now = new Date();
  const yearStart = `${now.getFullYear()}-01-01`;
  const today = now.toISOString().split("T")[0];

  try {
    const count = await fetchEarthquakeCount(yearStart, today, 7.0);
    console.log("\n📊 EARTHQUAKE STATUS (2026):");
    console.log(`   7.0+ earthquakes so far: ${count}`);
    console.log(`   Historical average (full year): ~15`);
    console.log(`   Historical average (Jan-Jun): ~7.5`);
    console.log();
  } catch (err) {
    log.warn(`Failed to fetch earthquake status: ${err}`);
  }
}

async function main() {
  const typeArg = process.argv.find(a => a.startsWith("--type="))?.split("=")[1] || "all";
  const minEdgeArg = process.argv.find(a => a.startsWith("--min-edge="))?.split("=")[1];
  const minEdge = minEdgeArg ? parseFloat(minEdgeArg) : 0.15;

  console.log("╔══════════════════════════════════════════════════════════════╗");
  console.log("║          WEATHER MARKET SCANNER - Polymarket                 ║");
  console.log("╠══════════════════════════════════════════════════════════════╣");
  console.log(`║  Type: ${typeArg.padEnd(20)} Min Edge: ${(minEdge * 100).toFixed(0)}%               ║`);
  console.log("╚══════════════════════════════════════════════════════════════╝");

  await printEarthquakeStatus();

  if (typeArg === "earthquake" || typeArg === "all") {
    const earthquakeAnalyses = await scanEarthquakeMarkets(minEdge);
    printEarthquakeResults(earthquakeAnalyses);
  }

  if (typeArg === "temperature" || typeArg === "all") {
    const temperatureAnalyses = await scanTemperatureMarkets(minEdge);
    printTemperatureResults(temperatureAnalyses);
  }

  console.log("════════════════════════════════════════════════════════════");
  console.log("  Scan complete. Use 'polymarket clob create-order' to trade.");
  console.log("════════════════════════════════════════════════════════════\n");
}

main().catch((error) => {
  const message = error instanceof Error ? error.stack || error.message : String(error);
  log.error(`Scanner failed: ${message}`);
  process.exit(1);
});
