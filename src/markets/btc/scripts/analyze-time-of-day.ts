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
  window_start: string;
}

interface HourBucket {
  hour: number;
  session: string;
  total: number;
  upWins: number;
  upRate: number;
  ciLow: number;
  ciHigh: number;
}

function binomialCI(successes: number, trials: number): [number, number] {
  if (trials === 0) return [0, 1];
  const p = successes / trials;
  const z = 1.96;
  const se = Math.sqrt(p * (1 - p) / trials);
  return [Math.max(0, p - z * se), Math.min(1, p + z * se)];
}

function chiSquareTest(buckets: HourBucket[], overallUpRate: number): { chiSquare: number; pValue: number; df: number } {
  let chiSquare = 0;
  let validBuckets = 0;

  for (const b of buckets) {
    if (b.total < 10) continue;
    validBuckets++;
    const expectedUp = b.total * overallUpRate;
    const expectedDown = b.total * (1 - overallUpRate);
    if (expectedUp > 0) chiSquare += Math.pow(b.upWins - expectedUp, 2) / expectedUp;
    if (expectedDown > 0) chiSquare += Math.pow(b.total - b.upWins - expectedDown, 2) / expectedDown;
  }

  const df = Math.max(1, validBuckets - 1);
  const pValue = chiSquarePValue(chiSquare, df);
  return { chiSquare, pValue, df };
}

function chiSquarePValue(x: number, df: number): number {
  if (df <= 0) return 1;
  const z = Math.pow(x / df, 1/3) - (1 - 2 / (9 * df));
  const se = Math.sqrt(2 / (9 * df));
  return 1 - normalCDF(z / se);
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

function getSession(hourUtc: number): string {
  if (hourUtc >= 0 && hourUtc < 8) return "Asian";
  if (hourUtc >= 8 && hourUtc < 16) return "European";
  return "US";
}

async function main() {
  const db = openValidationDb(validationConfig.dbPath);
  migrateValidationDb(db);

  const rows = db.prepare(`
    SELECT slug, market_type, outcome, window_start
    FROM updown_outcomes
    WHERE outcome IN ('Up', 'Down')
    ORDER BY window_start ASC
  `).all() as OutcomeRow[];

  const fiveMin = rows.filter(r => r.market_type === "5m");
  const fourHour = rows.filter(r => r.market_type === "4h");

  log.info(`Analyzing time-of-day: 5m=${fiveMin.length}, 4h=${fourHour.length}`);

  // Analyze by hour for 5m markets
  const analyzeByHour = (data: OutcomeRow[], label: string) => {
    const byHour = new Map<number, { total: number; up: number }>();

    for (let h = 0; h < 24; h++) {
      byHour.set(h, { total: 0, up: 0 });
    }

    for (const row of data) {
      const dt = new Date(row.window_start);
      const hour = dt.getUTCHours();
      const bucket = byHour.get(hour)!;
      bucket.total++;
      if (row.outcome === "Up") bucket.up++;
    }

    const totalUp = data.filter(r => r.outcome === "Up").length;
    const overallUpRate = totalUp / data.length;

    const hourBuckets: HourBucket[] = [];
    for (let h = 0; h < 24; h++) {
      const b = byHour.get(h)!;
      const [lo, hi] = binomialCI(b.up, b.total);
      hourBuckets.push({
        hour: h,
        session: getSession(h),
        total: b.total,
        upWins: b.up,
        upRate: b.total > 0 ? b.up / b.total : 0,
        ciLow: lo,
        ciHigh: hi,
      });
    }

    const chiTest = chiSquareTest(hourBuckets, overallUpRate);

    // Aggregate by session
    const sessions = ["Asian", "European", "US"];
    const sessionStats = sessions.map(s => {
      const inSession = hourBuckets.filter(h => h.session === s);
      const total = inSession.reduce((a, b) => a + b.total, 0);
      const up = inSession.reduce((a, b) => a + b.upWins, 0);
      const [lo, hi] = binomialCI(up, total);
      return {
        session: s,
        hours: s === "Asian" ? "00-08 UTC" : s === "European" ? "08-16 UTC" : "16-24 UTC",
        total,
        upWins: up,
        upRate: total > 0 ? up / total : 0,
        ciLow: lo,
        ciHigh: hi,
      };
    });

    const sessionChiTest = chiSquareTest(
      sessionStats.map(s => ({
        hour: 0,
        session: s.session,
        total: s.total,
        upWins: s.upWins,
        upRate: s.upRate,
        ciLow: s.ciLow,
        ciHigh: s.ciHigh,
      })),
      overallUpRate
    );

    return { label, overallUpRate, hourBuckets, chiTest, sessionStats, sessionChiTest };
  };

  const results5m = analyzeByHour(fiveMin, "5-Minute Markets");
  const results4h = analyzeByHour(fourHour, "4-Hour Markets");

  // Print results
  console.log("\n" + "=".repeat(70));
  console.log("TIME-OF-DAY ANALYSIS");
  console.log("=".repeat(70));

  const printResults = (r: ReturnType<typeof analyzeByHour>) => {
    console.log(`\n### ${r.label} (n=${r.hourBuckets.reduce((a, b) => a + b.total, 0)})`);
    console.log(`Baseline Up Rate: ${(r.overallUpRate * 100).toFixed(1)}%`);

    console.log("\n--- By Trading Session ---");
    console.log("Session      | Hours     | Count |  Up% | vs Base | 95% CI");
    console.log("-".repeat(60));

    for (const s of r.sessionStats) {
      const diff = ((s.upRate - r.overallUpRate) * 100).toFixed(1);
      const diffStr = Number(diff) >= 0 ? `+${diff}%` : `${diff}%`;
      console.log(
        `${s.session.padEnd(12)} | ${s.hours.padEnd(9)} | ${String(s.total).padStart(5)} | ${(s.upRate * 100).toFixed(1).padStart(4)}% | ${diffStr.padStart(7)} | [${(s.ciLow*100).toFixed(0)}%-${(s.ciHigh*100).toFixed(0)}%]`
      );
    }
    console.log(`Chi-square: ${r.sessionChiTest.chiSquare.toFixed(2)}, df=${r.sessionChiTest.df}, p=${r.sessionChiTest.pValue.toFixed(4)}`);

    // Find outlier hours
    const outliers = r.hourBuckets.filter(h => {
      if (h.total < 50) return false;
      return h.ciHigh < r.overallUpRate - 0.02 || h.ciLow > r.overallUpRate + 0.02;
    });

    if (outliers.length > 0) {
      console.log("\n--- Outlier Hours (95% CI excludes baseline) ---");
      for (const h of outliers) {
        const diff = ((h.upRate - r.overallUpRate) * 100).toFixed(1);
        console.log(`  ${String(h.hour).padStart(2)}:00 UTC (${h.session}): ${(h.upRate*100).toFixed(1)}% Up (${diff}% vs baseline), n=${h.total}`);
      }
    } else {
      console.log("\n--- No statistically significant outlier hours ---");
    }

    // Verdict
    const significant = r.sessionChiTest.pValue < 0.05 || outliers.length > 0;
    console.log(`\nVERDICT: ${significant ? "INVESTIGATE FURTHER" : "KILL"}`);
    if (!significant) {
      console.log("  • No significant time-of-day pattern detected");
    }
  };

  printResults(results5m);
  printResults(results4h);

  // US equity market open analysis (14:30 UTC)
  console.log("\n" + "=".repeat(70));
  console.log("US EQUITY OPEN ANALYSIS (14:00-15:00 UTC)");
  console.log("=".repeat(70));

  const usOpen5m = fiveMin.filter(r => {
    const h = new Date(r.window_start).getUTCHours();
    return h === 14;
  });
  const usOpenUp = usOpen5m.filter(r => r.outcome === "Up").length;
  const usOpenRate = usOpen5m.length > 0 ? usOpenUp / usOpen5m.length : 0;
  const [usLo, usHi] = binomialCI(usOpenUp, usOpen5m.length);
  const usDiff = ((usOpenRate - results5m.overallUpRate) * 100).toFixed(1);

  console.log(`5m markets during 14:00-15:00 UTC: n=${usOpen5m.length}`);
  console.log(`Up rate: ${(usOpenRate * 100).toFixed(1)}% (${Number(usDiff) >= 0 ? "+" : ""}${usDiff}% vs baseline)`);
  console.log(`95% CI: [${(usLo*100).toFixed(0)}%-${(usHi*100).toFixed(0)}%]`);
  console.log(`Significant: ${usHi < results5m.overallUpRate - 0.02 || usLo > results5m.overallUpRate + 0.02 ? "YES" : "NO"}`);

  // Save report
  const report = {
    generatedAt: new Date().toISOString(),
    thesis: "time_of_day_pattern",
    fiveMin: {
      totalMarkets: fiveMin.length,
      overallUpRate: results5m.overallUpRate,
      sessionStats: results5m.sessionStats,
      sessionChiTest: results5m.sessionChiTest,
      hourlyChiTest: results5m.chiTest,
    },
    fourHour: {
      totalMarkets: fourHour.length,
      overallUpRate: results4h.overallUpRate,
      sessionStats: results4h.sessionStats,
      sessionChiTest: results4h.sessionChiTest,
    },
  };

  const outputDir = path.resolve(process.cwd(), "backtests", "validation-reports");
  fs.mkdirSync(outputDir, { recursive: true });
  const outputPath = path.join(outputDir, `time-of-day-${new Date().toISOString().slice(0, 10)}.json`);
  fs.writeFileSync(outputPath, JSON.stringify(report, null, 2));

  db.prepare(`
    INSERT INTO thesis_reports(thesis, generated_at, verdict, summary_json, report_path)
    VALUES (?, ?, ?, ?, ?)
  `).run(
    "time_of_day_pattern",
    report.generatedAt,
    results5m.sessionChiTest.pValue < 0.05 ? "INVESTIGATE" : "KILL",
    JSON.stringify(report),
    outputPath
  );

  console.log(`\nReport saved: ${outputPath}`);
}

main().catch((error) => {
  const message = error instanceof Error ? error.stack || error.message : String(error);
  log.error(`Analysis failed: ${message}`);
  process.exit(1);
});
