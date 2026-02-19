import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import { validationConfig, ValidationVerdict } from "../validation/config";
import { migrateValidationDb, openValidationDb } from "../../../shared/validation/sqlite";
import { log } from "../../../shared/utils/logger";

type ViolationRow = {
  first_seen_ts: string;
  type: string;
  violation_size_cents: number;
  fillable_notional_usd: number;
  duration_seconds: number | null;
  btc_1h_realized_vol: number | null;
};

function average(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 0) return (sorted[mid - 1] + sorted[mid]) / 2;
  return sorted[mid];
}

function correlation(x: number[], y: number[]): number {
  if (x.length !== y.length || x.length < 2) return 0;
  const mx = average(x);
  const my = average(y);

  let num = 0;
  let denX = 0;
  let denY = 0;
  for (let i = 0; i < x.length; i++) {
    const dx = x[i] - mx;
    const dy = y[i] - my;
    num += dx * dy;
    denX += dx * dx;
    denY += dy * dy;
  }

  const den = Math.sqrt(denX * denY);
  if (den === 0) return 0;
  return num / den;
}

function decide(metrics: {
  theoreticalNetRevenuePerWeek: number;
  medianViolationsPerDay: number;
  averageDurationSeconds: number;
}): { verdict: ValidationVerdict; reasons: string[] } {
  const reasons: string[] = [];

  const pass =
    metrics.theoreticalNetRevenuePerWeek > validationConfig.phase1.pass.netRevenuePerWeek &&
    metrics.medianViolationsPerDay >= validationConfig.phase1.pass.medianViolationsPerDay &&
    metrics.averageDurationSeconds > validationConfig.phase1.pass.avgDurationSeconds;

  if (pass) {
    reasons.push("All PASS thresholds met.");
    return { verdict: "PASS", reasons };
  }

  const kill =
    metrics.theoreticalNetRevenuePerWeek < validationConfig.phase1.kill.netRevenuePerWeek ||
    metrics.medianViolationsPerDay < validationConfig.phase1.kill.medianViolationsPerDay ||
    metrics.averageDurationSeconds < validationConfig.phase1.kill.avgDurationSeconds;

  if (kill) {
    if (metrics.theoreticalNetRevenuePerWeek < validationConfig.phase1.kill.netRevenuePerWeek) {
      reasons.push("Theoretical net revenue below kill threshold.");
    }
    if (metrics.medianViolationsPerDay < validationConfig.phase1.kill.medianViolationsPerDay) {
      reasons.push("Violation frequency below kill threshold.");
    }
    if (metrics.averageDurationSeconds < validationConfig.phase1.kill.avgDurationSeconds) {
      reasons.push("Violation duration below kill threshold.");
    }
    return { verdict: "KILL", reasons };
  }

  reasons.push("Metrics between PASS and KILL thresholds.");
  return { verdict: "INCONCLUSIVE", reasons };
}

async function main() {
  const db = openValidationDb(validationConfig.dbPath);
  migrateValidationDb(db);

  const end = new Date();
  const start = new Date(end.getTime() - 7 * 24 * 3600 * 1000);
  const startIso = start.toISOString();
  const endIso = end.toISOString();

  const violations = db.prepare(
    `SELECT first_seen_ts, type, violation_size_cents, fillable_notional_usd, duration_seconds, btc_1h_realized_vol
     FROM phase1_violations
     WHERE first_seen_ts >= ? AND first_seen_ts <= ?`
  ).all(startIso, endIso) as ViolationRow[];

  const dailyCountsMap = new Map<string, number>();
  for (const row of violations) {
    const day = row.first_seen_ts.slice(0, 10);
    dailyCountsMap.set(day, (dailyCountsMap.get(day) ?? 0) + 1);
  }

  const dailyCounts = Array.from(dailyCountsMap.values());
  const durations = violations.map((v) => Number(v.duration_seconds ?? 0)).filter((n) => n > 0);

  const grossRevenue = violations.reduce((acc, row) => {
    const edgeDollarPerUnit = row.violation_size_cents / 100;
    return acc + edgeDollarPerUnit * row.fillable_notional_usd;
  }, 0);

  const theoreticalNetRevenuePerWeek = grossRevenue * validationConfig.executionHaircut;
  const medianViolationsPerDay = median(dailyCounts);
  const averageDurationSeconds = average(durations);

  const volSeries = violations.map((v) => Number(v.btc_1h_realized_vol ?? NaN)).filter((n) => Number.isFinite(n));
  const edgeSeries = violations.map((v) => Number(v.violation_size_cents)).filter((n) => Number.isFinite(n));
  const corr = correlation(volSeries.slice(0, Math.min(volSeries.length, edgeSeries.length)), edgeSeries.slice(0, Math.min(volSeries.length, edgeSeries.length)));

  const metrics = {
    windowStart: startIso,
    windowEnd: endIso,
    totalViolationsDetected: violations.length,
    violationsPerDay: {
      mean: average(dailyCounts),
      median: medianViolationsPerDay,
      min: dailyCounts.length ? Math.min(...dailyCounts) : 0,
      max: dailyCounts.length ? Math.max(...dailyCounts) : 0,
    },
    averageViolationSizeCents: average(violations.map((v) => v.violation_size_cents)),
    averageFillableNotionalUsd: average(violations.map((v) => v.fillable_notional_usd)),
    averageDurationSeconds,
    theoreticalGrossRevenuePerWeek: grossRevenue,
    theoreticalNetRevenuePerWeek,
    executionHaircut: validationConfig.executionHaircut,
    correlationViolationSizeToBtc1hVol: corr,
  };

  const decision = decide({
    theoreticalNetRevenuePerWeek,
    medianViolationsPerDay,
    averageDurationSeconds,
  });

  const report = {
    generatedAt: new Date().toISOString(),
    thesis: "phase1_structural_arbitrage",
    verdict: decision.verdict,
    reasons: decision.reasons,
    metrics,
    thresholds: {
      pass: validationConfig.phase1.pass,
      kill: validationConfig.phase1.kill,
    },
    nextAction: decision.verdict === "PASS"
      ? "Proceed to week-2 execution test with explicit manual arm."
      : decision.verdict === "KILL"
        ? "Kill thesis and stop execution work on phase 1."
        : "Extend logging window by one week and rerun report.",
  };

  const outputDir = path.resolve(process.cwd(), "backtests", "validation-reports");
  fs.mkdirSync(outputDir, { recursive: true });
  const outputPath = path.join(outputDir, `phase1-report-${new Date().toISOString().slice(0, 10)}.json`);
  fs.writeFileSync(outputPath, JSON.stringify(report, null, 2));

  db.prepare(
    `INSERT INTO thesis_reports(thesis, generated_at, window_start, window_end, verdict, summary_json, report_path)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(
    "phase1_structural_arbitrage",
    report.generatedAt,
    startIso,
    endIso,
    decision.verdict,
    JSON.stringify(report.metrics),
    outputPath
  );

  log.info(`Phase1 report generated: ${outputPath}`);
  log.info(`Phase1 verdict=${decision.verdict} netRev=${theoreticalNetRevenuePerWeek.toFixed(2)} median/day=${medianViolationsPerDay.toFixed(2)} avgDuration=${averageDurationSeconds.toFixed(1)}s`);
}

main().catch((error) => {
  const message = error instanceof Error ? error.stack || error.message : String(error);
  log.error(`Phase1 report failed: ${message}`);
  process.exit(1);
});
