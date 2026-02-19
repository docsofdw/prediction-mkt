import { ClaimValidator } from "../index";
import { log } from "../../shared/utils/logger";

async function main() {
  const input = process.argv[2];

  if (!input) {
    console.log("Usage: npx ts-node src/claim-validator/scripts/validate-claim.ts <url-or-text>");
    console.log("");
    console.log("Examples:");
    console.log("  npx ts-node src/claim-validator/scripts/validate-claim.ts 'https://x.com/user/status/123'");
    console.log("  npx ts-node src/claim-validator/scripts/validate-claim.ts 'BTC momentum with 12/48 MA crossover beats market'");
    console.log("");
    console.log("Environment variables:");
    console.log("  ANTHROPIC_API_KEY - Required for LLM extraction");
    console.log("  CLAIM_SOURCE_ID   - Optional source identifier for tracking");
    process.exit(1);
  }

  const anthropicKey = process.env.ANTHROPIC_API_KEY;
  if (!anthropicKey) {
    console.error("Error: ANTHROPIC_API_KEY environment variable required");
    process.exit(1);
  }

  const sourceId = process.env.CLAIM_SOURCE_ID;

  const validator = new ClaimValidator(anthropicKey);

  console.log("=".repeat(60));
  console.log("CLAIM VALIDATOR");
  console.log("=".repeat(60));
  console.log("");
  console.log(`Input: ${input.slice(0, 100)}${input.length > 100 ? "..." : ""}`);
  console.log("");

  try {
    const report = await validator.validate({
      source: input,
      receivedAt: new Date(),
      sourceId,
    });

    console.log("");
    console.log("=".repeat(60));
    console.log("TRIAGE REPORT");
    console.log("=".repeat(60));
    console.log("");
    console.log(report.telegramMessage);
    console.log("");
    console.log("=".repeat(60));
    console.log("FULL REASONING");
    console.log("=".repeat(60));
    console.log("");
    console.log(report.reasoning);
    console.log("");

    // Output JSON for machine parsing
    if (process.env.OUTPUT_JSON === "true") {
      console.log("=".repeat(60));
      console.log("JSON OUTPUT");
      console.log("=".repeat(60));
      console.log(JSON.stringify(report, null, 2));
    }

  } catch (error) {
    log.error(`Validation failed: ${error}`);
    console.error("");
    console.error("=".repeat(60));
    console.error("ERROR");
    console.error("=".repeat(60));
    console.error("");
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}

main().catch(console.error);
