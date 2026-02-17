/**
 * polymarket-trader — main entrypoint
 *
 * Wires together: config, market discovery, CLOB trading client,
 * WebSocket feed, and strategy runner.
 *
 * Usage:
 *   npm run dev        # run with ts-node
 *   npm run build      # compile to JS
 *   npm start          # run compiled JS
 */
import { loadConfig } from "./utils/config";
import { log } from "./utils/logger";
import { MarketDiscovery } from "./services/market-discovery";
import { TradingClient } from "./services/trading-client";
import { RealtimeFeed } from "./services/realtime-feed";
import { DualLiveStrategy } from "./strategies/dual-live-strategy";
import { PaperExecution } from "./services/paper-execution";
import { Strategy, MarketSnapshot } from "./types";

async function main() {
  log.info("polymarket-trader starting up...");

  // ── 1. Load config ─────────────────────────────────
  const config = loadConfig();
  log.info(`Chain: ${config.chainId} | CLOB: ${config.clobHost} | mode=${config.executionMode}`);

  // ── 2. Discover target markets ─────────────────────
  const discovery = new MarketDiscovery(config.gammaHost);

  log.info("Scanning for bitcoin markets...");
  const btcEvents = await discovery.discoverBitcoinMarkets(5);
  log.info(`Found ${btcEvents.length} bitcoin event(s)`);

  log.info("Scanning for weather markets...");
  const wxEvents = await discovery.discoverWeatherMarkets(5);
  log.info(`Found ${wxEvents.length} weather event(s)`);

  const allEvents = [...btcEvents, ...wxEvents];
  const snapshots: MarketSnapshot[] = allEvents.flatMap((e) => discovery.snapshotMarkets(e));
  log.info(`Total market snapshots: ${snapshots.length}`);

  if (snapshots.length === 0) {
    log.warn("No active markets found. Exiting.");
    return;
  }

  // ── 3. Connect trading client ──────────────────────
  const trader = new TradingClient(config);
  if (config.executionMode === "live") {
    await trader.connect();
  }

  const paper = config.executionMode === "paper"
    ? new PaperExecution(config.paperInitialCash)
    : null;

  // ── 4. Start WebSocket feed ────────────────────────
  const feed = new RealtimeFeed();
  await feed.connect(
    config.apiKey && config.apiSecret && config.passphrase
      ? { key: config.apiKey, secret: config.apiSecret, passphrase: config.passphrase }
      : undefined
  );
  feed.subscribeTrades();

  // Subscribe to price updates for discovered markets
  const tokenIds = snapshots.map((s) => s.tokenId).filter(Boolean);
  if (tokenIds.length > 0) {
    feed.subscribePrices(tokenIds);
  }

  // ── 5. Load strategy ──────────────────────────────
  const strategy: Strategy = new DualLiveStrategy(config.defaultTradeSize);
  await strategy.initialize();

  // Wire price updates into strategy evaluation
  feed.onPrice = async (data: any) => {
    const assetId = data?.assetId || data?.asset_id;
    const px = Number(data?.price || data?.p || data?.lastPrice || 0);

    // Map incoming price data to a snapshot and evaluate
    const snapshot = snapshots.find((s) => s.tokenId === assetId);
    if (snapshot) {
      if (Number.isFinite(px) && px > 0) {
        snapshot.lastPrice = px;
      }

      if (paper && Number.isFinite(px) && px > 0) {
        paper.markPrice(snapshot.tokenId, px);
      }

      const signals = await strategy.evaluate(snapshot);
      for (const signal of signals) {
        log.info(`Signal: ${signal.side} ${signal.size} @ ${signal.price} — ${signal.reason}`);
        if (paper) {
          paper.applySignal(signal);
        } else {
          try {
            await trader.placeLimitOrder(signal);
          } catch (error: any) {
            const status = error?.response?.status;
            const body = JSON.stringify(error?.response?.data ?? {});
            log.error(`Live order failed status=${status ?? "n/a"} body=${body}`);
          }
        }
      }
    }
  };

  // ── 6. Run until interrupted ───────────────────────
  log.info("Bot is running. Press Ctrl+C to stop.");

  // Also run a one-time evaluation of current snapshots
  for (const snapshot of snapshots.slice(0, 5)) {
    await strategy.evaluate(snapshot);
  }

  // Graceful shutdown
  const shutdown = async () => {
    log.info("Shutting down...");
    paper?.logAccountSummary();
    await strategy.teardown();
    feed.disconnect();
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  // Keep process alive
  await new Promise(() => {});
}

main().catch((err) => {
  log.error(`Fatal error: ${err.message}`);
  log.error(err.stack);
  process.exit(1);
});
