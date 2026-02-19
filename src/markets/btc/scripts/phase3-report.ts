import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import { validationConfig, ValidationVerdict } from "../validation/config";
import { migrateValidationDb, openValidationDb } from "../../../shared/validation/sqlite";
import { log } from "../../../shared/utils/logger";

type Contract = {
  contract_id: string;
  question: string;
  strike: number | null;
  expiry: string | null;
  direction: string | null;
  settlement: number | null;
  price_at_listing: number | null;
};

function average(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

function std(values: number[]): number {
  if (values.length < 2) return 0;
  const m = average(values);
  const variance = values.reduce((a, v) => a + (v - m) ** 2, 0) / (values.length - 1);
  return Math.sqrt(variance);
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

function sharpe(returns: number[]): number {
  const s = std(returns);
  if (s === 0) return 0;
  return average(returns) / s * Math.sqrt(52);
}

function sortino(returns: number[]): number {
  const downside = returns.filter((r) => r < 0);
  if (downside.length < 2) return 0;
  const downsideStd = std(downside);
  if (downsideStd === 0) return 0;
  return average(returns) / downsideStd * Math.sqrt(52);
}

function maxDrawdown(equity: number[]): number {
  if (equity.length === 0) return 0;
  let peak = equity[0];
  let maxDd = 0;
  for (const e of equity) {
    if (e > peak) peak = e;
    const dd = peak - e;
    if (dd > maxDd) maxDd = dd;
  }
  return maxDd;
}

function evaluateVerdict(metrics: {
  observations: number;
  sharpe: number;
  winRate: number;
  maxDrawdownPct: number;
  correlationToBtc: number;
}): { verdict: ValidationVerdict; reasons: string[] } {
  const reasons: string[] = [];

  if (metrics.observations < 20) {
    reasons.push("Insufficient weekly observations (<20).");
    return { verdict: "INCONCLUSIVE", reasons };
  }

  const pass =
    metrics.sharpe > 0.5 &&
    metrics.winRate > 0.55 &&
    metrics.maxDrawdownPct < 0.30 &&
    metrics.correlationToBtc < 0.4;

  if (pass) {
    reasons.push("All PASS thresholds met.");
    return { verdict: "PASS", reasons };
  }

  const kill =
    metrics.sharpe < 0.3 ||
    metrics.winRate < 0.45 ||
    metrics.maxDrawdownPct > 0.5 ||
    metrics.correlationToBtc > 0.6;

  if (kill) {
    if (metrics.sharpe < 0.3) reasons.push("Sharpe below kill threshold.");
    if (metrics.winRate < 0.45) reasons.push("Win rate below kill threshold.");
    if (metrics.maxDrawdownPct > 0.5) reasons.push("Max drawdown above kill threshold.");
    if (metrics.correlationToBtc > 0.6) reasons.push("Correlation to BTC above kill threshold.");
    return { verdict: "KILL", reasons };
  }

  reasons.push("Marginal result. Consider regime-filtered variant.");
  return { verdict: "INCONCLUSIVE", reasons };
}

async function main() {
  const db = openValidationDb(validationConfig.dbPath);
  migrateValidationDb(db);

  const contracts = db.prepare(
    `SELECT contract_id, question, strike, expiry, direction, settlement, price_at_listing
     FROM phase2_contracts
     WHERE expiry IS NOT NULL AND strike IS NOT NULL AND settlement IS NOT NULL AND price_at_listing IS NOT NULL`
  ).all() as Contract[];

  const byExpiry = new Map<string, Contract[]>();
  for (const c of contracts) {
    const key = String(c.expiry);
    const arr = byExpiry.get(key) ?? [];
    arr.push(c);
    byExpiry.set(key, arr);
  }

  const weeklyReturns: number[] = [];
  const btcProxyReturns: number[] = [];

  for (const [expiry, rows] of byExpiry.entries()) {
    const sortedByStrike = [...rows].sort((a, b) => Number(a.strike) - Number(b.strike));
    if (sortedByStrike.length < 2) continue;

    const low = sortedByStrike[0];
    const high = sortedByStrike[sortedByStrike.length - 1];

    const lowEntry = Number(low.price_at_listing);
    const highEntry = Number(high.price_at_listing);
    const lowSettle = Number(low.settlement);
    const highSettle = Number(high.settlement);
    if (![lowEntry, highEntry, lowSettle, highSettle].every((n) => Number.isFinite(n))) continue;

    const pnlLow = lowEntry - lowSettle;
    const pnlHigh = highEntry - highSettle;
    const combined = pnlLow + pnlHigh;
    weeklyReturns.push(combined);

    const proxyBtc = (Number(high.strike) - Number(low.strike)) / Math.max(1, Number(low.strike));
    btcProxyReturns.push(proxyBtc);

    db.prepare(
      `INSERT INTO phase3_weekly_results(
        week_expiry,
        entry_time,
        floor_contract_id,
        ceiling_contract_id,
        floor_entry_price,
        ceiling_entry_price,
        floor_settlement,
        ceiling_settlement,
        combined_pnl,
        btc_weekly_return
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(week_expiry) DO UPDATE SET
        floor_contract_id = excluded.floor_contract_id,
        ceiling_contract_id = excluded.ceiling_contract_id,
        floor_entry_price = excluded.floor_entry_price,
        ceiling_entry_price = excluded.ceiling_entry_price,
        floor_settlement = excluded.floor_settlement,
        ceiling_settlement = excluded.ceiling_settlement,
        combined_pnl = excluded.combined_pnl,
        btc_weekly_return = excluded.btc_weekly_return`
    ).run(
      expiry,
      `${expiry}T00:00:00Z`,
      low.contract_id,
      high.contract_id,
      lowEntry,
      highEntry,
      lowSettle,
      highSettle,
      combined,
      proxyBtc
    );
  }

  const wins = weeklyReturns.filter((r) => r > 0).length;
  const winRate = weeklyReturns.length === 0 ? 0 : wins / weeklyReturns.length;

  const equity: number[] = [];
  let eq = 0;
  for (const r of weeklyReturns) {
    eq += r;
    equity.push(eq);
  }

  const dd = maxDrawdown(equity);
  const peak = equity.length ? Math.max(...equity) : 0;
  const maxDrawdownPct = peak === 0 ? 0 : dd / Math.abs(peak);

  const metrics = {
    observations: weeklyReturns.length,
    winRate,
    averageWeeklyPnl: average(weeklyReturns),
    worstSingleWeek: weeklyReturns.length ? Math.min(...weeklyReturns) : 0,
    maxConsecutiveLosingWeeks: (() => {
      let max = 0;
      let cur = 0;
      for (const r of weeklyReturns) {
        if (r < 0) {
          cur += 1;
          if (cur > max) max = cur;
        } else {
          cur = 0;
        }
      }
      return max;
    })(),
    sharpe: sharpe(weeklyReturns),
    sortino: sortino(weeklyReturns),
    maxDrawdownPct,
    correlationToBtc: correlation(weeklyReturns, btcProxyReturns),
  };

  const decision = evaluateVerdict(metrics);

  const report = {
    generatedAt: new Date().toISOString(),
    thesis: "phase3_range_bound_carry",
    verdict: decision.verdict,
    reasons: decision.reasons,
    metrics,
    thresholds: {
      pass: {
        sharpe: 0.5,
        winRate: 0.55,
        maxDrawdownPct: 0.3,
        correlationToBtc: 0.4,
      },
      kill: {
        sharpe: 0.3,
        winRate: 0.45,
        maxDrawdownPct: 0.5,
        correlationToBtc: 0.6,
      },
    },
  };

  const outputDir = path.resolve(process.cwd(), "backtests", "validation-reports");
  fs.mkdirSync(outputDir, { recursive: true });
  const outputPath = path.join(outputDir, `phase3-report-${new Date().toISOString().slice(0, 10)}.json`);
  fs.writeFileSync(outputPath, JSON.stringify(report, null, 2));

  db.prepare(
    `INSERT INTO thesis_reports(thesis, generated_at, verdict, summary_json, report_path)
     VALUES (?, ?, ?, ?, ?)`
  ).run(
    "phase3_range_bound_carry",
    report.generatedAt,
    decision.verdict,
    JSON.stringify(report.metrics),
    outputPath
  );

  log.info(`Phase3 report generated: ${outputPath}`);
  log.info(`Phase3 verdict=${decision.verdict} weeks=${metrics.observations}`);
}

main().catch((error) => {
  const message = error instanceof Error ? error.stack || error.message : String(error);
  log.error(`Phase3 report failed: ${message}`);
  process.exit(1);
});
