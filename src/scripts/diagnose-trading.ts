import { AssetType, OrderType, Side } from "@polymarket/clob-client";
import { loadConfig } from "../shared/utils/config";
import { TradingClient } from "../shared/services/trading-client";
import { log } from "../shared/utils/logger";

const tokenId = process.env.DIAG_TOKEN_ID || "";
const price = Number(process.env.DIAG_PRICE || "0.01");
const size = Number(process.env.DIAG_SIZE || "1");
const placeOrder = process.env.DIAG_PLACE_ORDER === "true";

function formatError(error: unknown): string {
  const err = error as any;
  const status = err?.response?.status;
  const body = err?.response?.data;
  return `message=${err?.message || String(error)} status=${status ?? "n/a"} body=${JSON.stringify(body ?? {})}`;
}

async function main() {
  const config = loadConfig();
  const trader = new TradingClient(config);

  log.info("=== Trading Diagnostics ===");
  log.info(`wallet=${config.funderAddress} chain=${config.chainId} sigType=${config.signatureType}`);

  await trader.connect();
  const client = trader.getClient();

  try {
    const keys = await client.getApiKeys();
    log.info(`apiKeys count=${Array.isArray(keys) ? keys.length : 0}`);
  } catch (error) {
    log.error(`getApiKeys failed: ${formatError(error)}`);
  }

  try {
    const collateral = await client.getBalanceAllowance({ asset_type: AssetType.COLLATERAL });
    log.info(`collateral balance=${collateral.balance} allowance=${collateral.allowance}`);
  } catch (error) {
    log.error(`getBalanceAllowance(COLLATERAL) failed: ${formatError(error)}`);
  }

  if (tokenId) {
    try {
      const conditional = await client.getBalanceAllowance({
        asset_type: AssetType.CONDITIONAL,
        token_id: tokenId,
      });
      log.info(`conditional(${tokenId.slice(0, 10)}..) balance=${conditional.balance} allowance=${conditional.allowance}`);
    } catch (error) {
      log.error(`getBalanceAllowance(CONDITIONAL) failed: ${formatError(error)}`);
    }

    try {
      const book = await trader.getOrderbook(tokenId);
      log.info(`orderbook market=${book.market} bids=${book.bids?.length ?? 0} asks=${book.asks?.length ?? 0}`);
    } catch (error) {
      log.error(`getOrderBook failed: ${formatError(error)}`);
    }

    if (placeOrder) {
      try {
        const order = await client.createAndPostOrder(
          {
            tokenID: tokenId,
            side: Side.BUY,
            price,
            size,
          },
          { tickSize: "0.01", negRisk: false },
          OrderType.GTC,
          false,
          true
        );

        log.info(`test order ok: ${JSON.stringify(order)}`);
      } catch (error) {
        log.error(`createAndPostOrder failed: ${formatError(error)}`);
      }
    } else {
      log.info("Skipping order placement. Set DIAG_PLACE_ORDER=true to test write permissions.");
    }
  } else {
    log.info("No DIAG_TOKEN_ID set. Skipping token-scoped diagnostics.");
  }
}

main().catch((error) => {
  log.error(`fatal: ${formatError(error)}`);
  process.exit(1);
});
