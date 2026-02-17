/**
 * test-order.ts
 *
 * Places a tiny test order to verify trading connectivity.
 * Run with: npx ts-node src/scripts/test-order.ts
 */
import { loadConfig } from "../utils/config";
import { log } from "../utils/logger";
import { TradingClient } from "../services/trading-client";

// MicroStrategy sells BTC by March 31, 2026 — good liquidity, low probability
const TEST_TOKEN_ID = "108547978327958467449318042977006580876058560639743186491243488736783119648127";
const TEST_PRICE = 0.01;   // Very low price — unlikely to fill
const TEST_SIZE = 1;       // Minimum size: 1 share = $0.01 risk

async function main() {
  const config = loadConfig();

  log.info("=== TEST ORDER SCRIPT ===");
  log.info(`Token: ${TEST_TOKEN_ID.slice(0, 20)}...`);
  log.info(`Price: $${TEST_PRICE} | Size: ${TEST_SIZE} share(s)`);

  const trader = new TradingClient(config);
  await trader.connect();

  // Check orderbook first
  log.info("Fetching orderbook...");
  const book = await trader.getOrderbook(TEST_TOKEN_ID);
  log.info(`Orderbook: ${JSON.stringify(book, null, 2).slice(0, 500)}...`);

  // Place the test order
  log.info("Placing test BUY order...");
  try {
    const result = await trader.placeLimitOrder({
      tokenId: TEST_TOKEN_ID,
      side: "BUY",
      price: TEST_PRICE,
      size: TEST_SIZE,
      tickSize: "0.01",
    });
    log.info(`Order result: ${JSON.stringify(result, null, 2)}`);

    // Check open orders
    log.info("Checking open orders...");
    const openOrders = await trader.getOpenOrders();
    log.info(`Open orders: ${JSON.stringify(openOrders, null, 2).slice(0, 1000)}`);

    // Cancel all orders to clean up
    log.info("Cancelling test order...");
    await trader.cancelAll();
    log.info("Done! Test order placed and cancelled successfully.");
  } catch (err: any) {
    log.error(`Order failed: ${err.message}`);
    if (err.response?.data) {
      log.error(`API response: ${JSON.stringify(err.response.data)}`);
    }
  }
}

main().catch((err) => {
  log.error(`Fatal: ${err.message}`);
  process.exit(1);
});
