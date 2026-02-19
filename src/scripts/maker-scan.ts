/**
 * Maker Strategy Scanner
 *
 * Scans BTC markets for longshot selling opportunities based on
 * Becker dataset analysis. Outputs actionable order targets.
 *
 * Usage:
 *   npm run maker:scan            # Scan and report
 *   npm run maker:scan -- --json  # Output JSON for automation
 */

import "dotenv/config";
import { writeFileSync } from "fs";
import { join } from "path";
import { MakerLongshotSeller } from "../markets/btc/strategies/maker-longshot-seller";
import { log } from "../shared/utils/logger";

const gammaHost = process.env.GAMMA_HOST || "https://gamma-api.polymarket.com";
const outputJson = process.argv.includes("--json");

async function main() {
  log.info("═".repeat(60));
  log.info("MAKER LONGSHOT SCANNER");
  log.info("═".repeat(60));
  log.info("");

  const strategy = new MakerLongshotSeller(gammaHost);
  const { candidates, targets, summary } = await strategy.runScan();

  if (outputJson) {
    const output = {
      generatedAt: new Date().toISOString(),
      summary,
      candidates: candidates.slice(0, 20), // Top 20
      targets,
    };
    const outputPath = join(process.cwd(), "backtests/maker-scan-latest.json");
    writeFileSync(outputPath, JSON.stringify(output, null, 2));
    log.info(`JSON output written to: ${outputPath}`);
    return;
  }

  // Console report
  log.info("SCAN SUMMARY");
  log.info("-".repeat(60));
  log.info(`Markets scanned:    ${summary.marketsScanned}`);
  log.info(`Candidates found:   ${summary.candidatesFound}`);
  log.info(`Orders to place:    ${summary.ordersGenerated}`);
  log.info(`Total exposure:     $${summary.totalExposure.toFixed(2)}`);
  log.info(`Average edge:       ${(summary.avgEdge * 100).toFixed(2)}%`);
  log.info("");

  if (targets.length === 0) {
    log.info("No order targets found matching criteria.");
    log.info("Try adjusting filters in strategy-params.json");
    return;
  }

  log.info("ORDER TARGETS (limit sell orders to post)");
  log.info("═".repeat(60));
  log.info("");

  for (const target of targets) {
    log.info(`Token: ${target.tokenId.slice(0, 20)}...`);
    log.info(`  Question:   ${target.question.slice(0, 60)}...`);
    log.info(`  Sell Price: ${(target.sellPrice * 100).toFixed(1)} cents`);
    log.info(`  Size:       ${target.sizeContracts} contracts`);
    log.info(`  Est. Edge:  +${(target.estimatedEdge * 100).toFixed(2)}%`);
    log.info(`  Max Loss:   $${target.maxLossIfWrong.toFixed(2)} (if outcome = YES)`);
    log.info("");
  }

  log.info("═".repeat(60));
  log.info("NEXT STEPS");
  log.info("═".repeat(60));
  log.info("1. Review the targets above");
  log.info("2. Run in paper mode first: npm run dev (with EXECUTION_MODE=paper)");
  log.info("3. Monitor fills and track P&L");
  log.info("4. Graduate to live when confident");
  log.info("");

  // Show top candidates that didn't make the cut
  const skipped = candidates.filter(
    (c) => !targets.find((t) => t.tokenId === c.tokenId)
  ).slice(0, 5);

  if (skipped.length > 0) {
    log.info("CANDIDATES SKIPPED (didn't meet sizing/filters)");
    log.info("-".repeat(60));
    for (const c of skipped) {
      log.info(`  ${c.question.slice(0, 50)}...`);
      log.info(`    Price: ${(c.currentPrice * 100).toFixed(1)}c, Volume: $${c.volume24h.toFixed(0)}, Days: ${c.daysToExpiry.toFixed(0)}`);
    }
  }
}

main().catch((error) => {
  const message = error instanceof Error ? error.stack || error.message : String(error);
  log.error(`Maker scan failed: ${message}`);
  process.exit(1);
});
