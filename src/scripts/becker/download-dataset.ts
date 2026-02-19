import "dotenv/config";
import { spawn } from "child_process";
import { existsSync, mkdirSync, statSync } from "fs";
import { join } from "path";
import { log } from "../../shared/utils/logger";

const DATA_URL = "https://s3.jbecker.dev/data.tar.zst";
const DATA_DIR = process.env.BECKER_DATA_DIR || "data/becker";

async function runCommand(cmd: string, args: string[], cwd?: string): Promise<void> {
  return new Promise((resolve, reject) => {
    log.info(`Running: ${cmd} ${args.join(" ")}`);
    const proc = spawn(cmd, args, {
      cwd,
      stdio: "inherit",
    });
    proc.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${cmd} exited with code ${code}`));
    });
    proc.on("error", reject);
  });
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

async function main() {
  const projectRoot = process.cwd();
  const dataPath = join(projectRoot, DATA_DIR);
  const tarPath = join(dataPath, "data.tar.zst");
  const polymarketPath = join(dataPath, "polymarket");

  // Check if already downloaded and extracted
  if (existsSync(join(polymarketPath, "markets")) && existsSync(join(polymarketPath, "trades"))) {
    const marketsDir = join(polymarketPath, "markets");
    const tradesDir = join(polymarketPath, "trades");
    log.info(`Dataset already exists at ${polymarketPath}`);
    log.info(`  markets/: ${marketsDir}`);
    log.info(`  trades/: ${tradesDir}`);
    return;
  }

  // Create data directory
  if (!existsSync(dataPath)) {
    mkdirSync(dataPath, { recursive: true });
    log.info(`Created directory: ${dataPath}`);
  }

  // Download the tarball if not exists
  if (!existsSync(tarPath)) {
    log.info(`Downloading Becker dataset from ${DATA_URL}`);
    log.info(`This is approximately 36GB - ensure you have sufficient disk space and bandwidth.`);
    log.info(`Download location: ${tarPath}`);
    log.info("");

    // Use curl with progress bar
    await runCommand("curl", [
      "-L",           // Follow redirects
      "-o", tarPath,  // Output file
      "--progress-bar", // Show progress
      DATA_URL,
    ]);

    const stats = statSync(tarPath);
    log.info(`Download complete: ${formatBytes(stats.size)}`);
  } else {
    const stats = statSync(tarPath);
    log.info(`Tarball already exists: ${tarPath} (${formatBytes(stats.size)})`);
  }

  // Extract the tarball
  log.info(`Extracting ${tarPath}...`);
  log.info(`This may take several minutes for 36GB of data.`);

  // Check if zstd is available
  try {
    await runCommand("which", ["zstd"]);
  } catch {
    log.error("zstd is required but not installed.");
    log.error("Install with: brew install zstd (macOS) or apt install zstd (Ubuntu)");
    process.exit(1);
  }

  // Extract: zstd -d data.tar.zst -c | tar -xf - -C data/becker/
  // This streams the decompression directly to tar without creating an intermediate .tar file
  await runCommand("bash", [
    "-c",
    `zstd -d "${tarPath}" -c | tar -xf - -C "${dataPath}"`,
  ]);

  // The archive extracts to a 'data' subdirectory, so we need to move contents up
  const extractedDataDir = join(dataPath, "data");
  if (existsSync(extractedDataDir)) {
    log.info("Reorganizing extracted files...");
    await runCommand("bash", [
      "-c",
      `mv "${extractedDataDir}"/* "${dataPath}/" && rmdir "${extractedDataDir}"`,
    ]);
  }

  // Verify extraction
  if (existsSync(join(polymarketPath, "markets")) && existsSync(join(polymarketPath, "trades"))) {
    log.info(`Extraction complete!`);
    log.info(`Dataset available at: ${polymarketPath}`);

    // Optionally delete the tarball to save space
    const keepTarball = process.env.BECKER_KEEP_TARBALL === "true";
    if (!keepTarball) {
      log.info(`Removing tarball to save disk space...`);
      await runCommand("rm", [tarPath]);
      log.info(`Deleted ${tarPath}`);
    }
  } else {
    log.error("Extraction failed - expected directories not found");
    process.exit(1);
  }

  log.info("");
  log.info("Next steps:");
  log.info("  npm run becker:calibration   # Run BTC calibration analysis");
  log.info("  npm run becker:maker-taker   # Run maker vs taker decomposition");
}

main().catch((error) => {
  const message = error instanceof Error ? error.stack || error.message : String(error);
  log.error(`Download failed: ${message}`);
  process.exit(1);
});
