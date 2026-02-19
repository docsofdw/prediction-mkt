import "dotenv/config";
import { validationConfig } from "../validation/config";
import { fetchSpotStateFromHistory, runPhase1Scan } from "../validation/scanner";
import { getMeta, migrateValidationDb, openValidationDb, setMeta } from "../../../shared/validation/sqlite";
import { log } from "../../../shared/utils/logger";

const gammaHost = process.env.GAMMA_HOST || "https://gamma-api.polymarket.com";
const clobHost = process.env.CLOB_HOST || "https://clob.polymarket.com";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function loadSpotHistory(db: ReturnType<typeof openValidationDb>): number[] {
  const rows = db.prepare(
    `SELECT btc_spot
     FROM phase1_scan_cycles
     WHERE btc_spot IS NOT NULL
     ORDER BY timestamp ASC
     LIMIT 2000`
  ).all() as Array<{ btc_spot: number }>;

  return rows.map((row) => Number(row.btc_spot)).filter((n) => Number.isFinite(n));
}

function upsertOpenViolation(db: ReturnType<typeof openValidationDb>, params: {
  violationKey: string;
  ts: string;
  type: string;
  legAJson: string;
  legBJson: string;
  violationSizeCents: number;
  fillableNotionalUsd: number;
  btcSpot: number | null;
  btc1hReturn: number | null;
  btc1hVol: number | null;
}): void {
  const existing = db.prepare(
    `SELECT id FROM phase1_violations
     WHERE violation_key = ? AND resolved_at IS NULL
     ORDER BY id DESC LIMIT 1`
  ).get(params.violationKey) as { id?: number } | undefined;

  if (existing?.id) {
    db.prepare(
      `UPDATE phase1_violations
       SET last_seen_ts = ?,
           leg_a_json = ?,
           leg_b_json = ?,
           violation_size_cents = ?,
           fillable_notional_usd = ?
       WHERE id = ?`
    ).run(
      params.ts,
      params.legAJson,
      params.legBJson,
      params.violationSizeCents,
      params.fillableNotionalUsd,
      existing.id
    );
    return;
  }

  db.prepare(
    `INSERT INTO phase1_violations(
      violation_key,
      first_seen_ts,
      last_seen_ts,
      type,
      leg_a_json,
      leg_b_json,
      violation_size_cents,
      fillable_notional_usd,
      btc_spot_at_detection,
      btc_1h_return_pct,
      btc_1h_realized_vol,
      resolved_at,
      duration_seconds,
      resolution
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL)`
  ).run(
    params.violationKey,
    params.ts,
    params.ts,
    params.type,
    params.legAJson,
    params.legBJson,
    params.violationSizeCents,
    params.fillableNotionalUsd,
    params.btcSpot,
    params.btc1hReturn,
    params.btc1hVol
  );
}

function resolveMissingViolations(db: ReturnType<typeof openValidationDb>, activeKeys: Set<string>, resolvedAt: string): number {
  const openRows = db.prepare(
    `SELECT id, violation_key, first_seen_ts
     FROM phase1_violations
     WHERE resolved_at IS NULL`
  ).all() as Array<{ id: number; violation_key: string; first_seen_ts: string }>;

  let resolvedCount = 0;
  for (const row of openRows) {
    if (activeKeys.has(row.violation_key)) continue;
    const duration = Math.max(0, Math.floor((new Date(resolvedAt).getTime() - new Date(row.first_seen_ts).getTime()) / 1000));

    db.prepare(
      `UPDATE phase1_violations
       SET resolved_at = ?, duration_seconds = ?, resolution = ?
       WHERE id = ?`
    ).run(resolvedAt, duration, "corrected", row.id);

    resolvedCount += 1;
  }

  return resolvedCount;
}

async function runOnce(db: ReturnType<typeof openValidationDb>): Promise<void> {
  const history = loadSpotHistory(db);
  const spotState = await fetchSpotStateFromHistory(history);

  const { summary, activeViolations, marketSnapshots } = await runPhase1Scan({
    gammaHost,
    clobHost,
    spotState,
  });

  db.prepare(
    `INSERT INTO phase1_scan_cycles(
      timestamp,
      active_btc_markets,
      total_violations_this_scan,
      avg_spread_cents_all_markets,
      btc_spot,
      btc_1h_return_pct,
      btc_1h_realized_vol,
      hour_of_day_utc,
      day_of_week
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    summary.timestamp,
    summary.active_btc_markets,
    summary.total_violations_this_scan,
    summary.avg_spread_cents_all_markets,
    summary.btc_spot,
    summary.btc_1h_return_pct,
    summary.btc_1h_realized_vol,
    summary.hour_of_day_utc,
    summary.day_of_week
  );

  const activeKeys = new Set<string>();
  for (const violation of activeViolations) {
    activeKeys.add(violation.violation_key);
    upsertOpenViolation(db, {
      violationKey: violation.violation_key,
      ts: summary.timestamp,
      type: violation.type,
      legAJson: JSON.stringify(violation.leg_a),
      legBJson: JSON.stringify(violation.leg_b),
      violationSizeCents: violation.violation_size_cents,
      fillableNotionalUsd: violation.fillable_notional_usd,
      btcSpot: violation.btc_spot_at_detection,
      btc1hReturn: violation.btc_1h_return_pct,
      btc1hVol: violation.btc_1h_realized_vol,
    });
  }

  const resolved = resolveMissingViolations(db, activeKeys, summary.timestamp);

  // Persist per-market price snapshots (forward data collection for P3 backtest)
  let snapshotCount = 0;
  const snapshotStmt = db.prepare(
    `INSERT INTO market_price_snapshots(
      timestamp, market_id, token_id, question,
      best_bid, best_ask, mid_price, bid_depth_usd, ask_depth_usd, btc_spot
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(timestamp, token_id) DO NOTHING`
  );
  for (const snap of marketSnapshots) {
    snapshotStmt.run(
      summary.timestamp,
      snap.market_id,
      snap.token_id,
      snap.question,
      snap.best_bid,
      snap.best_ask,
      snap.mid_price,
      snap.bid_depth_usd,
      snap.ask_depth_usd,
      summary.btc_spot
    );
    snapshotCount += 1;
  }

  log.info(
    `[phase1] scan ts=${summary.timestamp} markets=${summary.active_btc_markets} activeViolations=${activeViolations.length} resolvedNow=${resolved} snapshots=${snapshotCount}`
  );

  const startedAt = getMeta(db, "validation_started_at") || summary.timestamp;
  const elapsedDays = (Date.now() - new Date(startedAt).getTime()) / (24 * 3600 * 1000);
  if (elapsedDays >= validationConfig.validationWindowDays) {
    log.warn(
      `[validation] VALIDATION WINDOW COMPLETE (${validationConfig.validationWindowDays} days) — review reports before continuing.`
    );
    setMeta(db, "validation_window_complete_warned_at", new Date().toISOString());
  }
}

async function main() {
  const db = openValidationDb(validationConfig.dbPath);
  migrateValidationDb(db);
  setMeta(db, "phase1_monitor_started_at", new Date().toISOString());

  const runOnceMode = process.argv.includes("--once");

  log.info(
    `[phase1] monitor started intervalMs=${validationConfig.phase1.scanIntervalMs} db=${validationConfig.dbPath} once=${runOnceMode}`
  );

  if (runOnceMode) {
    // Single scan for cron/daily monitoring
    await runOnce(db);
    log.info("[phase1] single scan complete, exiting");
    return;
  }

  while (true) {
    try {
      await runOnce(db);
    } catch (error) {
      const message = error instanceof Error ? error.stack || error.message : String(error);
      log.error(`[phase1] scan failure: ${message}`);
    }

    await sleep(validationConfig.phase1.scanIntervalMs);
  }
}

main().catch((error) => {
  const message = error instanceof Error ? error.stack || error.message : String(error);
  log.error(`Phase1 monitor crashed: ${message}`);
  process.exit(1);
});
