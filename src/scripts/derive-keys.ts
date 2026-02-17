/**
 * derive-keys.ts
 *
 * One-time helper to derive your Polymarket API credentials
 * from your private key. Run once, then paste the output into .env.
 *
 * Requires: PRIVATE_KEY in .env
 * Run with: npx ts-node src/scripts/derive-keys.ts
 */
import dotenv from "dotenv";
dotenv.config();

import { ClobClient } from "@polymarket/clob-client";
import { Wallet } from "@ethersproject/wallet";

async function main() {
  const pk = process.env.PRIVATE_KEY;
  if (!pk) {
    console.error("Set PRIVATE_KEY in your .env file first.");
    process.exit(1);
  }

  const signer = new Wallet(pk);
  console.log(`Wallet: ${signer.address}`);

  const host = process.env.CLOB_HOST || "https://clob.polymarket.com";
  const chainId = parseInt(process.env.CHAIN_ID || "137", 10);

  const client = new ClobClient(host, chainId, signer);
  const creds = await client.createOrDeriveApiKey();

  console.log("\n── Add these to your .env ──────────────────");
  console.log(`POLY_API_KEY=${creds.key}`);
  console.log(`POLY_API_SECRET=${creds.secret}`);
  console.log(`POLY_PASSPHRASE=${creds.passphrase}`);
  console.log("────────────────────────────────────────────\n");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
