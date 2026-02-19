import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import { validationConfig, ValidationVerdict } from "../validation/config";
import { migrateValidationDb, openValidationDb } from "../../../shared/validation/sqlite";
import { log } from "../../../shared/utils/logger";

type ContractRow = {
  contract_id: string;
  strike: number | null;
  expiry: string | null;
  direction: string | null;
  settlement: number | null;
  price_at_48h_before: number | null;
  price_at_24h_before: number | null;
};

type FundingRow = {
  timestamp: string;
  fr_percentile_30d: number | null;
};

function average(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

function stdErrorBernoulli(p: number, n: number): number {
  if (n <= 0) return 0;
  return Math.sqrt((p * (1 - p)) / n);
}

function parseTs(ts: string): number {
  const t = new Date(ts).getTime();
  return Number.isFinite(t) ? t : NaN;
}

function nearestFundingPercentile(funding: FundingRow[], targetTs: number): number | null {
  let best: { dt: number; p: number | null } | null = null;
  for (const row of funding) {
    const ts = parseTs(row.timestamp);
    if (!Number.isFinite(ts)) continue;
    const dt = Math.abs(ts - targetTs);
    if (!best || dt < best.dt) {
      best = { dt, p: row.fr_percentile_30d };
    }
  }
  return best?.p ?? null;
}

function verdictFromCohorts(cohorts: Array<{ name: string; n: number; edge: number; twoSe: number }>): { verdict: ValidationVerdict; reasons: string[] } {
  const reasons: string[] = [];

  const valid = cohorts.filter((c) => c.n >= 20);
  if (valid.length === 0) {
    reasons.push("Sample size below minimum (n<20) for all cohorts.");
    return { verdict: "INCONCLUSIVE", reasons };
  }

  const pass = valid.find((c) => Math.abs(c.edge) > c.twoSe && Math.abs(c.edge) > 0.03);
  if (pass) {
    reasons.push(`Cohort ${pass.name} passed significance and magnitude thresholds.`);
    return { verdict: "PASS", reasons };
  }

  const weak = valid.every((c) => Math.abs(c.edge) < c.twoSe * 0.5);
  if (weak) {
    reasons.push("All cohorts show weak signal relative to statistical error.");
    return { verdict: "KILL", reasons };
  }

  reasons.push("Directional signal exists but does not meet full pass criteria.");
  return { verdict: "INCONCLUSIVE", reasons };
}

async function main() {
  const db = openValidationDb(validationConfig.dbPath);
  migrateValidationDb(db);

  const contracts = db.prepare(
    `SELECT contract_id, strike, expiry, direction, settlement, price_at_48h_before, price_at_24h_before
     FROM phase2_contracts
     WHERE settlement IS NOT NULL AND price_at_48h_before IS NOT NULL`
  ).all() as ContractRow[];

  const funding = db.prepare(
    `SELECT timestamp, fr_percentile_30d
     FROM phase2_funding_rates
     WHERE fr_percentile_30d IS NOT NULL
     ORDER BY timestamp ASC`
  ).all() as FundingRow[];

  const rows: Array<{
    contract_id: string;
    cohort: "A" | "B" | "C" | "OTHER";
    settlement: number;
    marketMid48h: number;
    edge: number;
  }> = [];

  for (const contract of contracts) {
    if (!contract.expiry || contract.price_at_48h_before === null || contract.settlement === null) continue;
    const expiryTs = new Date(`${contract.expiry}T00:00:00Z`).getTime() - 48 * 3600 * 1000;
    if (!Number.isFinite(expiryTs)) continue;

    const percentile = nearestFundingPercentile(funding, expiryTs);
    if (percentile === null) continue;

    const cohort: "A" | "B" | "C" | "OTHER" =
      percentile > 0.85 ? "A" :
      percentile < 0.15 ? "B" :
      (percentile > 0.3 && percentile < 0.7 ? "C" : "OTHER");

    rows.push({
      contract_id: contract.contract_id,
      cohort,
      settlement: contract.settlement,
      marketMid48h: contract.price_at_48h_before,
      edge: contract.settlement - contract.price_at_48h_before,
    });
  }

  const summarize = (name: string, cohortRows: typeof rows) => {
    const n = cohortRows.length;
    const p = average(cohortRows.map((r) => r.settlement));
    const market = average(cohortRows.map((r) => r.marketMid48h));
    const edge = p - market;
    const se = stdErrorBernoulli(Math.max(0.0001, Math.min(0.9999, p)), n);
    return { name, n, settlementAvg: p, marketAvg: market, edge, se, twoSe: 2 * se };
  };

  const cohortA = summarize("A", rows.filter((r) => r.cohort === "A"));
  const cohortB = summarize("B", rows.filter((r) => r.cohort === "B"));
  const cohortC = summarize("C", rows.filter((r) => r.cohort === "C"));

  const decision = verdictFromCohorts([cohortA, cohortB, cohortC].map((c) => ({ name: c.name, n: c.n, edge: c.edge, twoSe: c.twoSe })));

  const report = {
    generatedAt: new Date().toISOString(),
    thesis: "phase2_funding_tail_mispricing",
    verdict: decision.verdict,
    reasons: decision.reasons,
    sampleSize: rows.length,
    cohorts: {
      A: cohortA,
      B: cohortB,
      C: cohortC,
    },
    criteria: {
      minContractsPerCohort: 20,
      passRule: "edge > 2*SE and |edge| > 0.03",
    },
  };

  const outputDir = path.resolve(process.cwd(), "backtests", "validation-reports");
  fs.mkdirSync(outputDir, { recursive: true });
  const outputPath = path.join(outputDir, `phase2-report-${new Date().toISOString().slice(0, 10)}.json`);
  fs.writeFileSync(outputPath, JSON.stringify(report, null, 2));

  db.prepare(
    `INSERT INTO thesis_reports(thesis, generated_at, verdict, summary_json, report_path)
     VALUES (?, ?, ?, ?, ?)`
  ).run(
    "phase2_funding_tail_mispricing",
    report.generatedAt,
    decision.verdict,
    JSON.stringify(report.cohorts),
    outputPath
  );

  log.info(`Phase2 report generated: ${outputPath}`);
  log.info(`Phase2 verdict=${decision.verdict} samples=${rows.length}`);
}

main().catch((error) => {
  const message = error instanceof Error ? error.stack || error.message : String(error);
  log.error(`Phase2 report failed: ${message}`);
  process.exit(1);
});
