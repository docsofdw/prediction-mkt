import "dotenv/config";
import { spawnSync } from "node:child_process";
import { validationConfig } from "../validation/config";
import { getMeta, migrateValidationDb, openValidationDb, setMeta } from "../../../shared/validation/sqlite";
import { log } from "../../../shared/utils/logger";

function runCommand(cmd: string): boolean {
  const result = spawnSync(cmd, {
    shell: true,
    cwd: process.cwd(),
    env: process.env,
    stdio: "inherit",
  });
  return result.status === 0;
}

function shouldRunCheckpoint(startedAt: string, days: number): boolean {
  const elapsedDays = (Date.now() - new Date(startedAt).getTime()) / (24 * 3600 * 1000);
  return elapsedDays >= days;
}

async function main() {
  const db = openValidationDb(validationConfig.dbPath);
  migrateValidationDb(db);

  const startedAt = getMeta(db, "validation_started_at") || new Date().toISOString();
  setMeta(db, "validation_started_at", startedAt);

  const week1Due = shouldRunCheckpoint(startedAt, 7);
  const week2Due = shouldRunCheckpoint(startedAt, 14);

  if (week1Due && !getMeta(db, "checkpoint_week1_reported_at")) {
    log.warn("[validation] Week 1 checkpoint due — generating reports.");
    const ok1 = runCommand("npm run phase1:report");
    const ok2 = runCommand("npm run phase2:report");
    const ok3 = runCommand("npm run phase3:report");
    if (ok1 && ok2 && ok3) {
      setMeta(db, "checkpoint_week1_reported_at", new Date().toISOString());
    }
  }

  if (week2Due && !getMeta(db, "checkpoint_week2_reported_at")) {
    log.warn("[validation] Week 2 checkpoint due — generating reports.");
    const ok1 = runCommand("npm run phase1:report");
    const ok2 = runCommand("npm run phase2:report");
    const ok3 = runCommand("npm run phase3:report");
    if (ok1 && ok2 && ok3) {
      setMeta(db, "checkpoint_week2_reported_at", new Date().toISOString());
    }
    log.warn("[validation] VALIDATION WINDOW COMPLETE — review reports before continuing.");
    setMeta(db, "validation_window_complete_warned_at", new Date().toISOString());
  }

  if (!week1Due) {
    log.info("[validation] no checkpoint due yet");
  }
}

main().catch((error) => {
  const message = error instanceof Error ? error.stack || error.message : String(error);
  log.error(`validation-checkpoints failed: ${message}`);
  process.exit(1);
});
