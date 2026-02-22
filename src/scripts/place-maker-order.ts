/**
 * place-maker-order.ts
 *
 * Places a maker sell order on a longshot YES token.
 *
 * Usage:
 *   npm run maker:place -- --token=TOKEN_ID --price=0.021 --size=50
 *   npm run maker:place -- --dry-run  (shows what would be placed without executing)
 */
import "dotenv/config";
import { loadConfig } from "../shared/utils/config";
import { log } from "../shared/utils/logger";
import { TradingClient } from "../shared/services/trading-client";

// Default: MicroStrategy sells BTC by March 31, 2026
const DEFAULT_TOKEN_ID = "108547978327958467449318042977006580876058560639743186491243488736783119648127";
const DEFAULT_PRICE = 0.021;  // 2.1 cents
const DEFAULT_SIZE = 50;      // 50 contracts = ~$1 at risk if filled, $49 max loss if YES

function parseArgs(): { tokenId: string; price: number; size: number; dryRun: boolean } {
  const args = process.argv.slice(2);

  let tokenId = DEFAULT_TOKEN_ID;
  let price = DEFAULT_PRICE;
  let size = DEFAULT_SIZE;
  let dryRun = false;

  for (const arg of args) {
    if (arg.startsWith("--token=")) {
      tokenId = arg.split("=")[1];
    } else if (arg.startsWith("--price=")) {
      price = parseFloat(arg.split("=")[1]);
    } else if (arg.startsWith("--size=")) {
      size = parseInt(arg.split("=")[1], 10);
    } else if (arg === "--dry-run") {
      dryRun = true;
    }
  }

  return { tokenId, price, size, dryRun };
}

async function main() {
  const { tokenId, price, size, dryRun } = parseArgs();

  const exposure = price * size;
  const maxLoss = (1 - price) * size;
  const profitIfNo = price * size;

  console.log("\n════════════════════════════════════════════════════════════");
  console.log("MAKER SELL ORDER");
  console.log("════════════════════════════════════════════════════════════\n");
  console.log(`Token:        ${tokenId.slice(0, 20)}...${tokenId.slice(-10)}`);
  console.log(`Side:         SELL (betting NO)`);
  console.log(`Price:        ${(price * 100).toFixed(1)}¢`);
  console.log(`Size:         ${size} contracts`);
  console.log(`\nIf filled:`);
  console.log(`  You receive: $${exposure.toFixed(2)} immediately`);
  console.log(`  If NO wins:  +$${profitIfNo.toFixed(2)} profit (keep premium)`);
  console.log(`  If YES wins: -$${maxLoss.toFixed(2)} loss (pay out $1/contract)`);
  console.log("");

  if (dryRun) {
    console.log("🔶 DRY RUN - no order placed\n");
    console.log("To place for real, run without --dry-run flag");
    return;
  }

  const config = loadConfig();
  const trader = new TradingClient(config);

  console.log("Connecting to Polymarket CLOB...");
  await trader.connect();

  // Check current orderbook
  console.log("\nFetching current orderbook...");
  const book = await trader.getOrderbook(tokenId);
  const bestBid = book.bids?.[0];
  const bestAsk = book.asks?.[0];
  console.log(`Best bid: ${bestBid ? `${(parseFloat(bestBid.price) * 100).toFixed(1)}¢ x ${bestBid.size}` : "none"}`);
  console.log(`Best ask: ${bestAsk ? `${(parseFloat(bestAsk.price) * 100).toFixed(1)}¢ x ${bestAsk.size}` : "none"}`);

  // Place the sell order
  console.log("\n🚀 Placing SELL order...");
  try {
    const result = await trader.placeLimitOrder({
      tokenId,
      side: "SELL",
      price,
      size,
      tickSize: "0.01",
    });

    console.log("\n✅ ORDER PLACED SUCCESSFULLY");
    console.log(`Order ID: ${result.orderID || result.order_id || "see details below"}`);
    console.log(`Status: ${result.status || "submitted"}`);

    if (result.success === false) {
      console.log(`\n⚠️  Note: ${JSON.stringify(result)}`);
    }

    // Show open orders
    console.log("\nYour open orders:");
    const openOrders = await trader.getOpenOrders();
    if (Array.isArray(openOrders) && openOrders.length > 0) {
      for (const order of openOrders.slice(0, 5)) {
        const side = order.side === "BUY" ? "BUY " : "SELL";
        const px = (parseFloat(order.price) * 100).toFixed(1);
        console.log(`  ${side} ${order.size_matched}/${order.original_size} @ ${px}¢ [${order.status}]`);
      }
    } else {
      console.log("  (none visible yet - may take a moment to appear)");
    }

    console.log("\n════════════════════════════════════════════════════════════");
    console.log("NEXT STEPS");
    console.log("════════════════════════════════════════════════════════════");
    console.log("1. Check Polymarket UI to see your order in the book");
    console.log("2. Wait for a taker to fill your order");
    console.log("3. If filled, you'll receive the premium immediately");
    console.log("4. At expiry, if NO wins, you keep everything");
    console.log("");

  } catch (err: unknown) {
    const error = err as Error & { response?: { data?: unknown } };
    console.error(`\n❌ Order failed: ${error.message}`);
    if (error.response?.data) {
      console.error(`API response: ${JSON.stringify(error.response.data)}`);
    }
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(`Fatal: ${err.message}`);
  process.exit(1);
});
