import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import { validationConfig } from "../validation/config";
import { fetchSpotStateFromHistory, runPhase1Scan } from "../validation/scanner";
import { migrateValidationDb, openValidationDb } from "../../../shared/validation/sqlite";
import { log } from "../../../shared/utils/logger";

const gammaHost = process.env.GAMMA_HOST || "https://gamma-api.polymarket.com";
const clobHost = process.env.CLOB_HOST || "https://clob.polymarket.com";

async function main() {
  const db = openValidationDb(validationConfig.dbPath);
  migrateValidationDb(db);

  const rows = db.prepare(
    `SELECT btc_spot
     FROM phase1_scan_cycles
     WHERE btc_spot IS NOT NULL
     ORDER BY timestamp ASC
     LIMIT 2000`
  ).all() as Array<{ btc_spot: number }>;

  const spotHistory = rows.map((r) => Number(r.btc_spot)).filter((n) => Number.isFinite(n));
  const spotState = await fetchSpotStateFromHistory(spotHistory);

  const { summary, activeViolations } = await runPhase1Scan({
    gammaHost,
    clobHost,
    spotState,
  });

  const output = {
    generatedAt: new Date().toISOString(),
    summary,
    opportunities: {
      strikeMonotonicityViolations: activeViolations.filter((v) => v.type === "strike_monotonicity"),
      timeMonotonicityViolations: activeViolations.filter((v) => v.type === "time_monotonicity"),
    },
  };

  const outputDir = path.resolve(process.cwd(), "backtests");
  const outputPath = path.join(outputDir, "btc-inefficiencies-latest.json");
  fs.mkdirSync(outputDir, { recursive: true });
  fs.writeFileSync(outputPath, JSON.stringify(output, null, 2));

  log.info(
    `[btc-scan] ts=${summary.timestamp} markets=${summary.active_btc_markets} violations=${summary.total_violations_this_scan}`
  );
  log.info(`[btc-scan] wrote ${outputPath}`);
}

main().catch((error) => {
  const message = error instanceof Error ? error.stack || error.message : String(error);
  log.error(`BTC inefficiency scan failed: ${message}`);
  process.exit(1);
});
