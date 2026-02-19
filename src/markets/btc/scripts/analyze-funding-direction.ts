import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import { validationConfig } from "../validation/config";
import { openValidationDb, migrateValidationDb } from "../../../shared/validation/sqlite";
import { log } from "../../../shared/utils/logger";

interface OutcomeRow {
  slug: string;
  market_type: string;
  outcome: string;
  fr_percentile: number | null;
  window_start: string;
  btc_price_start: number | null;
}

interface BucketStats {
  name: string;
  range: [number, number];
  total: number;
  upWins: number;
  downWins: number;
  upRate: number;
  expectedUp: number;
  chiSquareContrib: number;
}

function chiSquareTest(buckets: BucketStats[], overallUpRate: number): { chiSquare: number; pValue: number; df: number } {
  let chiSquare = 0;
  for (const b of buckets) {
    if (b.total < 5) continue; // Skip small samples
    const expectedUp = b.total * overallUpRate;
    const expectedDown = b.total * (1 - overallUpRate);
    if (expectedUp > 0) chiSquare += Math.pow(b.upWins - expectedUp, 2) / expectedUp;
    if (expectedDown > 0) chiSquare += Math.pow(b.downWins - expectedDown, 2) / expectedDown;
  }

  const df = buckets.filter(b => b.total >= 5).length - 1;
  // Approximate p-value using chi-square distribution
  // For df=4, critical values: 9.49 (p=0.05), 13.28 (p=0.01)
  const pValue = df <= 0 ? 1 : chiSquarePValue(chiSquare, df);

  return { chiSquare, pValue, df };
}

function chiSquarePValue(x: number, df: number): number {
  // Approximation using Wilson-Hilferty transformation
  if (df <= 0) return 1;
  const z = Math.pow(x / df, 1/3) - (1 - 2 / (9 * df));
  const se = Math.sqrt(2 / (9 * df));
  const zScore = z / se;
  // Convert to p-value (one-tailed)
  return 1 - normalCDF(zScore);
}

function normalCDF(z: number): number {
  const a1 = 0.254829592, a2 = -0.284496736, a3 = 1.421413741;
  const a4 = -1.453152027, a5 = 1.061405429, p = 0.3275911;
  const sign = z < 0 ? -1 : 1;
  z = Math.abs(z) / Math.sqrt(2);
  const t = 1 / (1 + p * z);
  const y = 1 - (((((a5 * t + a4) * t) + a3) * t + a2) * t + a1) * t * Math.exp(-z * z);
  return 0.5 * (1 + sign * y);
}

function binomialCI(successes: number, trials: number, confidence: number = 0.95): [number, number] {
  if (trials === 0) return [0, 1];
  const p = successes / trials;
  const z = 1.96; // 95% CI
  const se = Math.sqrt(p * (1 - p) / trials);
  return [Math.max(0, p - z * se), Math.min(1, p + z * se)];
}

async function main() {
  const db = openValidationDb(validationConfig.dbPath);
  migrateValidationDb(db);

  // Fetch all outcomes with funding rate
  const rows = db.prepare(`
    SELECT slug, market_type, outcome, fr_percentile, window_start, btc_price_start
    FROM updown_outcomes
    WHERE fr_percentile IS NOT NULL AND outcome IN ('Up', 'Down')
    ORDER BY window_start ASC
  `).all() as OutcomeRow[];

  log.info(`Analyzing ${rows.length} markets with funding rate data`);

  // Define percentile buckets
  const bucketDefs = [
    { name: "Very Low (0-10%)", range: [0, 0.10] as [number, number] },
    { name: "Low (10-30%)", range: [0.10, 0.30] as [number, number] },
    { name: "Mid-Low (30-50%)", range: [0.30, 0.50] as [number, number] },
    { name: "Mid-High (50-70%)", range: [0.50, 0.70] as [number, number] },
    { name: "High (70-90%)", range: [0.70, 0.90] as [number, number] },
    { name: "Very High (90-100%)", range: [0.90, 1.01] as [number, number] },
  ];

  // Analyze by market type
  const analyzeType = (marketType: string, data: OutcomeRow[]) => {
    const totalUp = data.filter(r => r.outcome === "Up").length;
    const overallUpRate = totalUp / data.length;

    const buckets: BucketStats[] = bucketDefs.map(def => {
      const inBucket = data.filter(r =>
        r.fr_percentile !== null &&
        r.fr_percentile >= def.range[0] &&
        r.fr_percentile < def.range[1]
      );
      const upWins = inBucket.filter(r => r.outcome === "Up").length;
      const downWins = inBucket.length - upWins;
      const upRate = inBucket.length > 0 ? upWins / inBucket.length : 0;
      const expectedUp = inBucket.length * overallUpRate;
      const chiContrib = inBucket.length > 0
        ? Math.pow(upWins - expectedUp, 2) / Math.max(1, expectedUp)
        : 0;

      return {
        name: def.name,
        range: def.range,
        total: inBucket.length,
        upWins,
        downWins,
        upRate,
        expectedUp,
        chiSquareContrib: chiContrib,
      };
    });

    const chiTest = chiSquareTest(buckets, overallUpRate);

    return {
      marketType,
      totalMarkets: data.length,
      overallUpRate,
      buckets,
      chiTest,
    };
  };

  // Run analysis for each market type and combined
  const results5m = analyzeType("5m", rows.filter(r => r.market_type === "5m"));
  const results4h = analyzeType("4h", rows.filter(r => r.market_type === "4h"));
  const resultsCombined = analyzeType("all", rows);

  // Determine verdict
  const getVerdict = (result: ReturnType<typeof analyzeType>): { verdict: string; reasons: string[] } => {
    const reasons: string[] = [];

    if (result.totalMarkets < 100) {
      reasons.push(`Insufficient sample size (n=${result.totalMarkets})`);
      return { verdict: "INCONCLUSIVE", reasons };
    }

    const significantBuckets = result.buckets.filter(b => {
      if (b.total < 20) return false;
      const [lo, hi] = binomialCI(b.upWins, b.total);
      // Check if CI excludes overall rate
      return hi < result.overallUpRate - 0.03 || lo > result.overallUpRate + 0.03;
    });

    if (result.chiTest.pValue < 0.05 && significantBuckets.length > 0) {
      reasons.push(`Chi-square test significant (p=${result.chiTest.pValue.toFixed(4)})`);
      for (const b of significantBuckets) {
        const diff = ((b.upRate - result.overallUpRate) * 100).toFixed(1);
        reasons.push(`${b.name}: ${(b.upRate * 100).toFixed(1)}% Up (${diff > "0" ? "+" : ""}${diff}% vs baseline)`);
      }
      return { verdict: "PASS", reasons };
    }

    if (result.chiTest.pValue > 0.20) {
      reasons.push(`No significant relationship (p=${result.chiTest.pValue.toFixed(4)})`);
      reasons.push("Funding rate does not predict Up/Down outcomes");
      return { verdict: "KILL", reasons };
    }

    reasons.push(`Marginal significance (p=${result.chiTest.pValue.toFixed(4)})`);
    reasons.push("More data needed for conclusive result");
    return { verdict: "INCONCLUSIVE", reasons };
  };

  const verdict5m = getVerdict(results5m);
  const verdict4h = getVerdict(results4h);
  const verdictCombined = getVerdict(resultsCombined);

  // Generate report
  const report = {
    generatedAt: new Date().toISOString(),
    thesis: "funding_rate_direction_correlation",
    summary: {
      hypothesis: "Extreme funding rates predict Up/Down market outcomes",
      combined: { ...resultsCombined, ...verdictCombined },
      byType: {
        "5m": { ...results5m, ...verdict5m },
        "4h": { ...results4h, ...verdict4h },
      },
    },
  };

  // Print results
  console.log("\n" + "=".repeat(60));
  console.log("FUNDING RATE → DIRECTION ANALYSIS");
  console.log("=".repeat(60));

  const printAnalysis = (label: string, result: ReturnType<typeof analyzeType>, verdict: { verdict: string; reasons: string[] }) => {
    console.log(`\n### ${label} (n=${result.totalMarkets})`);
    console.log(`Baseline Up Rate: ${(result.overallUpRate * 100).toFixed(1)}%`);
    console.log("\nBy Funding Percentile:");
    console.log("-".repeat(55));
    console.log("Bucket              | Count |  Up% | vs Base | 95% CI");
    console.log("-".repeat(55));

    for (const b of result.buckets) {
      if (b.total === 0) continue;
      const diff = ((b.upRate - result.overallUpRate) * 100).toFixed(1);
      const diffStr = Number(diff) >= 0 ? `+${diff}%` : `${diff}%`;
      const [lo, hi] = binomialCI(b.upWins, b.total);
      const ciStr = `[${(lo*100).toFixed(0)}%-${(hi*100).toFixed(0)}%]`;
      console.log(
        `${b.name.padEnd(19)} | ${String(b.total).padStart(5)} | ${(b.upRate*100).toFixed(1).padStart(4)}% | ${diffStr.padStart(7)} | ${ciStr}`
      );
    }

    console.log("-".repeat(55));
    console.log(`Chi-square: ${result.chiTest.chiSquare.toFixed(2)}, df=${result.chiTest.df}, p=${result.chiTest.pValue.toFixed(4)}`);
    console.log(`\nVERDICT: ${verdict.verdict}`);
    for (const r of verdict.reasons) {
      console.log(`  • ${r}`);
    }
  };

  printAnalysis("5-MINUTE MARKETS", results5m, verdict5m);
  printAnalysis("4-HOUR MARKETS", results4h, verdict4h);
  printAnalysis("ALL MARKETS COMBINED", resultsCombined, verdictCombined);

  // Save report
  const outputDir = path.resolve(process.cwd(), "backtests", "validation-reports");
  fs.mkdirSync(outputDir, { recursive: true });
  const outputPath = path.join(outputDir, `funding-direction-${new Date().toISOString().slice(0, 10)}.json`);
  fs.writeFileSync(outputPath, JSON.stringify(report, null, 2));

  // Store in DB
  db.prepare(`
    INSERT INTO thesis_reports(thesis, generated_at, verdict, summary_json, report_path)
    VALUES (?, ?, ?, ?, ?)
  `).run(
    "funding_rate_direction_correlation",
    report.generatedAt,
    verdictCombined.verdict,
    JSON.stringify(report.summary),
    outputPath
  );

  console.log(`\nReport saved: ${outputPath}`);
}

main().catch((error) => {
  const message = error instanceof Error ? error.stack || error.message : String(error);
  log.error(`Analysis failed: ${message}`);
  process.exit(1);
});
