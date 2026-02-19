import "dotenv/config";
import { validationConfig } from "../validation/config";
import { migrateValidationDb, openValidationDb, setMeta } from "../../../shared/validation/sqlite";
import { log } from "../../../shared/utils/logger";

async function main() {
  const db = openValidationDb(validationConfig.dbPath);
  migrateValidationDb(db);
  setMeta(db, "validation_initialized_at", new Date().toISOString());
  log.info(`Validation DB ready at ${validationConfig.dbPath}`);
}

main().catch((error) => {
  const message = error instanceof Error ? error.stack || error.message : String(error);
  log.error(`validation-init failed: ${message}`);
  process.exit(1);
});
