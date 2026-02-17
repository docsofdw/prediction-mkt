/**
 * discover-markets.ts
 *
 * Standalone script to search Polymarket for weather and bitcoin markets.
 * Run with: npm run discover
 *
 * No wallet or API keys required — Gamma API is public.
 */
import { MarketDiscovery } from "../services/market-discovery";
import { log } from "../utils/logger";

const GAMMA_HOST = process.env.GAMMA_HOST || "https://gamma-api.polymarket.com";

async function main() {
  const discovery = new MarketDiscovery(GAMMA_HOST);

  // ── Bitcoin Markets ──────────────────────────────────
  log.info("=== BITCOIN / CRYPTO MARKETS ===");
  const btcEvents = await discovery.discoverBitcoinMarkets(10);
  for (const event of btcEvents) {
    log.info(`\n📊 ${event.title}`);
    log.info(`   slug: ${event.slug}`);
    const snapshots = discovery.snapshotMarkets(event);
    for (const s of snapshots) {
      log.info(
        `   └─ ${s.question} | bid=${s.bestBid.toFixed(3)} ask=${s.bestAsk.toFixed(3)} vol=${s.volume.toFixed(0)}`
      );
      log.info(`      tokenId: ${s.tokenId}`);
    }
  }

  // ── Weather Markets ──────────────────────────────────
  log.info("\n=== WEATHER MARKETS ===");
  const wxEvents = await discovery.discoverWeatherMarkets(10);
  if (wxEvents.length === 0) {
    log.info("No active weather markets found right now.");
  }
  for (const event of wxEvents) {
    log.info(`\n🌦️  ${event.title}`);
    log.info(`   slug: ${event.slug}`);
    const snapshots = discovery.snapshotMarkets(event);
    for (const s of snapshots) {
      log.info(
        `   └─ ${s.question} | bid=${s.bestBid.toFixed(3)} ask=${s.bestAsk.toFixed(3)} vol=${s.volume.toFixed(0)}`
      );
      log.info(`      tokenId: ${s.tokenId}`);
    }
  }

  log.info("\nDone. Use these tokenIds in your .env or strategy config.");
}

main().catch((err) => {
  log.error(`Discovery failed: ${err.message}`);
  process.exit(1);
});
