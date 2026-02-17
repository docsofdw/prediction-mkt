import dotenv from "dotenv";

dotenv.config();

const requiredNow = ["PRIVATE_KEY", "FUNDER_ADDRESS"] as const;
const optionalForTrading = ["POLY_API_KEY", "POLY_API_SECRET", "POLY_PASSPHRASE"] as const;

function isPresent(key: string): boolean {
  const value = process.env[key];
  if (!value) return false;
  const normalized = value.trim().toLowerCase();
  if (!normalized) return false;
  if (normalized.includes("your_private_key_here")) return false;
  if (normalized.includes("your_funder_address_here")) return false;
  return true;
}

function printBlock(title: string, keys: readonly string[]) {
  console.log(`\n${title}`);
  for (const key of keys) {
    console.log(`  ${isPresent(key) ? "[x]" : "[ ]"} ${key}`);
  }
}

function main() {
  printBlock("Required to connect wallet and derive API creds", requiredNow);
  printBlock("Required to place/manage orders", optionalForTrading);

  const missingRequired = requiredNow.filter((key) => !isPresent(key));
  const hasTradingCreds = optionalForTrading.every((key) => isPresent(key));

  if (missingRequired.length > 0) {
    console.log("\nStatus: blocked (missing wallet setup vars)");
    console.log("Next: fill PRIVATE_KEY and FUNDER_ADDRESS in .env");
    process.exit(1);
  }

  if (!hasTradingCreds) {
    console.log("\nStatus: wallet ready, trading creds missing");
    console.log("Next: run npm run derive:keys and paste output into .env");
    process.exit(0);
  }

  console.log("\nStatus: ready (wallet + trading creds configured)");
}

main();
