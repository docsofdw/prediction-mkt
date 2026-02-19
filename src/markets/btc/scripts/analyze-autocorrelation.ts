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
  btc_price_start: number | null;
}

function binomialCI(successes: number, trials: number): [number, number] {
  if (trials === 0) return [0, 1];
  const p = successes / trials;
  const z = 1.96;
  const se = Math.sqrt(p * (1 - p) / trials);
  return [Math.max(0, p - z * se), Math.min(1, p + z * se)];
}

function binomialPValue(successes: number, trials: number, nullP: number): number {
  // Two-tailed test: how likely is this result or more extreme under null?
  const observed = successes / trials;
  const se = Math.sqrt(nullP * (1 - nullP) / trials);
  const z = Math.abs(observed - nullP) / se;
  return 2 * (1 - normalCDF(z));
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

async function main() {
  const db = openValidationDb(validationConfig.dbPath);
  migrateValidationDb(db);

  const rows = db.prepare(`
    SELECT slug, market_type, outcome, window_start, btc_price_start
    FROM updown_outcomes
    WHERE outcome IN ('Up', 'Down')
    ORDER BY window_start ASC
  `).all() as OutcomeRow[];

  const fiveMin = rows.filter(r => r.market_type === "5m");
  const fourHour = rows.filter(r => r.market_type === "4h");

  log.info(`Analyzing autocorrelation: 5m=${fiveMin.length}, 4h=${fourHour.length}`);

  console.log("\n" + "=".repeat(70));
  console.log("AUTOCORRELATION & STREAK ANALYSIS");
  console.log("=".repeat(70));

  const analyzeStreaks = (data: OutcomeRow[], label: string) => {
    const totalUp = data.filter(r => r.outcome === "Up").length;
    const overallUpRate = totalUp / data.length;

    console.log(`\n### ${label} (n=${data.length})`);
    console.log(`Baseline Up Rate: ${(overallUpRate * 100).toFixed(1)}%`);

    // Lag-1 autocorrelation: P(Up | prev was Up) vs P(Up | prev was Down)
    let afterUp = { total: 0, up: 0 };
    let afterDown = { total: 0, up: 0 };

    for (let i = 1; i < data.length; i++) {
      const prev = data[i - 1].outcome;
      const curr = data[i].outcome;

      if (prev === "Up") {
        afterUp.total++;
        if (curr === "Up") afterUp.up++;
      } else {
        afterDown.total++;
        if (curr === "Up") afterDown.up++;
      }
    }

    const upAfterUp = afterUp.total > 0 ? afterUp.up / afterUp.total : 0;
    const upAfterDown = afterDown.total > 0 ? afterDown.up / afterDown.total : 0;
    const [uuLo, uuHi] = binomialCI(afterUp.up, afterUp.total);
    const [udLo, udHi] = binomialCI(afterDown.up, afterDown.total);

    console.log("\n--- Lag-1 Conditional Probabilities ---");
    console.log(`P(Up | prev=Up):   ${(upAfterUp * 100).toFixed(1)}% (n=${afterUp.total}) [${(uuLo*100).toFixed(0)}%-${(uuHi*100).toFixed(0)}%]`);
    console.log(`P(Up | prev=Down): ${(upAfterDown * 100).toFixed(1)}% (n=${afterDown.total}) [${(udLo*100).toFixed(0)}%-${(udHi*100).toFixed(0)}%]`);

    const lag1Diff = upAfterUp - upAfterDown;
    const lag1Momentum = lag1Diff > 0.02 ? "MOMENTUM" : lag1Diff < -0.02 ? "MEAN-REVERT" : "NEUTRAL";
    console.log(`Difference: ${(lag1Diff * 100).toFixed(1)}% → ${lag1Momentum}`);

    // Streak analysis: P(Up | N consecutive same direction)
    console.log("\n--- Streak Analysis ---");
    console.log("After N consecutive same-direction outcomes, P(continuation):");
    console.log("Streak | Count | Continue% | 95% CI      | vs 50%");
    console.log("-".repeat(55));

    const streakResults: Array<{ streak: number; total: number; continues: number; rate: number }> = [];

    for (const streakLen of [2, 3, 4, 5]) {
      let total = 0;
      let continues = 0;

      for (let i = streakLen; i < data.length; i++) {
        // Check if previous streakLen outcomes are all same direction
        const streakDir = data[i - 1].outcome;
        let isStreak = true;
        for (let j = 1; j <= streakLen; j++) {
          if (data[i - j].outcome !== streakDir) {
            isStreak = false;
            break;
          }
        }

        if (isStreak) {
          total++;
          if (data[i].outcome === streakDir) continues++;
        }
      }

      if (total >= 10) {
        const rate = continues / total;
        const [lo, hi] = binomialCI(continues, total);
        const pVal = binomialPValue(continues, total, 0.5);
        const sig = pVal < 0.05 ? "*" : "";
        streakResults.push({ streak: streakLen, total, continues, rate });

        console.log(
          `${streakLen}+     | ${String(total).padStart(5)} | ${(rate * 100).toFixed(1).padStart(8)}% | [${(lo*100).toFixed(0)}%-${(hi*100).toFixed(0)}%]`.padEnd(42) +
          ` | p=${pVal.toFixed(3)}${sig}`
        );
      }
    }

    // Mean reversion after large moves (for 4h only, using price data)
    if (label.includes("4-Hour") && data.some(r => r.btc_price_start !== null)) {
      console.log("\n--- Mean Reversion After Large Moves ---");

      // Calculate implied price changes between consecutive windows
      let afterBigUp = { total: 0, down: 0 };
      let afterBigDown = { total: 0, up: 0 };

      for (let i = 1; i < data.length; i++) {
        const prev = data[i - 1];
        const curr = data[i];

        // Use outcome as proxy for direction (we don't have end prices)
        // "Big move" = 2+ consecutive same direction
        if (i >= 2 && data[i-1].outcome === data[i-2].outcome) {
          if (data[i-1].outcome === "Up") {
            afterBigUp.total++;
            if (curr.outcome === "Down") afterBigUp.down++;
          } else {
            afterBigDown.total++;
            if (curr.outcome === "Up") afterBigDown.up++;
          }
        }
      }

      if (afterBigUp.total >= 10) {
        const revertRate = afterBigUp.down / afterBigUp.total;
        console.log(`After 2+ Up: ${(revertRate * 100).toFixed(1)}% Down (n=${afterBigUp.total})`);
      }
      if (afterBigDown.total >= 10) {
        const revertRate = afterBigDown.up / afterBigDown.total;
        console.log(`After 2+ Down: ${(revertRate * 100).toFixed(1)}% Up (n=${afterBigDown.total})`);
      }
    }

    // Verdict
    const hasSignificantPattern =
      Math.abs(lag1Diff) > 0.03 &&
      (uuHi < overallUpRate - 0.02 || uuLo > overallUpRate + 0.02 ||
       udHi < overallUpRate - 0.02 || udLo > overallUpRate + 0.02);

    console.log(`\nVERDICT: ${hasSignificantPattern ? "INVESTIGATE FURTHER" : "KILL"}`);
    if (!hasSignificantPattern) {
      console.log("  • No significant autocorrelation detected");
      console.log("  • Outcomes appear independent of prior outcomes");
    }

    return {
      overallUpRate,
      lag1: { afterUp, afterDown, upAfterUp, upAfterDown, diff: lag1Diff },
      streaks: streakResults,
      verdict: hasSignificantPattern ? "INVESTIGATE" : "KILL",
    };
  };

  const results5m = analyzeStreaks(fiveMin, "5-Minute Markets");
  const results4h = analyzeStreaks(fourHour, "4-Hour Markets");

  // Save report
  const report = {
    generatedAt: new Date().toISOString(),
    thesis: "autocorrelation_streaks",
    fiveMin: results5m,
    fourHour: results4h,
  };

  const outputDir = path.resolve(process.cwd(), "backtests", "validation-reports");
  fs.mkdirSync(outputDir, { recursive: true });
  const outputPath = path.join(outputDir, `autocorrelation-${new Date().toISOString().slice(0, 10)}.json`);
  fs.writeFileSync(outputPath, JSON.stringify(report, null, 2));

  db.prepare(`
    INSERT INTO thesis_reports(thesis, generated_at, verdict, summary_json, report_path)
    VALUES (?, ?, ?, ?, ?)
  `).run(
    "autocorrelation_streaks",
    report.generatedAt,
    results5m.verdict === "INVESTIGATE" || results4h.verdict === "INVESTIGATE" ? "INVESTIGATE" : "KILL",
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
