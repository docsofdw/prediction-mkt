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
import { MetaAllocatorLiveStrategy } from "./strategies/meta-allocator-live-strategy";
import { PaperExecution } from "./services/paper-execution";
import { ExecutionRiskGuard } from "./services/execution-risk-guard";
import { RuntimeTelemetry } from "./services/runtime-telemetry";
import { Strategy, MarketSnapshot } from "./types";
import fs from "node:fs";
import path from "node:path";

function loadIdeaTokenIds(ideaPath: string): string[] {
  try {
    const resolved = path.resolve(process.cwd(), ideaPath);
    if (!fs.existsSync(resolved)) return [];
    const raw = fs.readFileSync(resolved, "utf8");
    const parsed = JSON.parse(raw) as {
      results?: {
        portfolio?: Array<{ tokenId: string }>;
      };
    };
    const ids = parsed.results?.portfolio?.map((p) => p.tokenId).filter(Boolean) ?? [];
    return Array.from(new Set(ids));
  } catch {
    return [];
  }
}

async function main() {
  log.info("polymarket-trader starting up...");

  // ── 1. Load config ─────────────────────────────────
  const config = loadConfig();
  log.info(`Chain: ${config.chainId} | CLOB: ${config.clobHost} | mode=${config.executionMode}`);
  const telemetry = new RuntimeTelemetry(config);
  telemetry.recordInfo("lifecycle", "startup");

  // ── 2. Discover target markets ─────────────────────
  const discovery = new MarketDiscovery(config.gammaHost);

  const discoveryLimit = config.strategyMode === "meta-allocator" ? 20 : 5;
  log.info(`Scanning for bitcoin markets (limit=${discoveryLimit})...`);
  const btcEvents = await discovery.discoverBitcoinMarkets(discoveryLimit);
  log.info(`Found ${btcEvents.length} bitcoin event(s)`);

  log.info(`Scanning for weather markets (limit=${discoveryLimit})...`);
  const wxEvents = await discovery.discoverWeatherMarkets(discoveryLimit);
  log.info(`Found ${wxEvents.length} weather event(s)`);

  const allEvents = [...btcEvents, ...wxEvents];
  const snapshots: MarketSnapshot[] = allEvents.flatMap((e) => discovery.snapshotMarkets(e));

  if (config.strategyMode === "meta-allocator") {
    const plannedIds = loadIdeaTokenIds(config.ideaFactoryPath);
    const known = new Set(snapshots.map((s) => s.tokenId));
    for (const tokenId of plannedIds) {
      if (known.has(tokenId)) continue;
      snapshots.push({
        tokenId,
        conditionId: "",
        question: `Planned token ${tokenId}`,
        bestBid: 0,
        bestAsk: 0,
        spread: 0,
        volume: 0,
        lastPrice: 0,
        timestamp: new Date(),
      });
    }
    log.info(`Added ${Math.max(0, plannedIds.length - known.size)} planned token placeholder(s) from idea file`);
  }
  log.info(`Total market snapshots: ${snapshots.length}`);

  if (snapshots.length === 0) {
    log.warn("No active markets found. Exiting.");
    telemetry.recordInfo("lifecycle", "no snapshots found; exiting");
    return;
  }
  telemetry.setUniverse(snapshots.map((s) => s.tokenId).filter(Boolean));

  // ── 3. Connect trading client ──────────────────────
  const trader = new TradingClient(config);
  if (config.executionMode === "live") {
    await trader.connect();
  }

  const paper = config.executionMode === "paper"
    ? new PaperExecution(config.paperInitialCash)
    : null;
  const riskGuard = new ExecutionRiskGuard({
    maxGrossExposureNotional: config.riskMaxGrossExposureNotional,
    maxPerMarketNotional: config.riskMaxPerMarketNotional,
    maxOrderNotional: config.riskMaxOrderNotional,
    maxDailyLoss: config.riskMaxDailyLoss,
    shadowInitialEquity: config.riskShadowInitialEquity,
  });
  log.info(
    `Risk guard limits: gross=${config.riskMaxGrossExposureNotional ?? "off"} perMarket=${config.riskMaxPerMarketNotional ?? "off"} order=${config.riskMaxOrderNotional ?? "off"} dailyLoss=${config.riskMaxDailyLoss ?? "off"}`
  );
  telemetry.setRisk(riskGuard.getSnapshot());

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
  const strategy: Strategy = config.strategyMode === "meta-allocator"
    ? new MetaAllocatorLiveStrategy({
        tradeSize: config.defaultTradeSize,
        ideaFactoryPath: config.ideaFactoryPath,
        minBars: config.metaMinBars,
        reloadMs: config.metaReloadMs,
        signalCooldownMs: config.metaSignalCooldownMs,
      })
    : new DualLiveStrategy(config.defaultTradeSize);
  await strategy.initialize();
  log.info(`Strategy loaded: ${strategy.name} (${config.strategyMode})`);
  telemetry.setStrategy(strategy.name, strategy.getDiagnostics?.());

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
      if (Number.isFinite(px) && px > 0) {
        riskGuard.markPrice(snapshot.tokenId, px);
      }
      telemetry.setRisk(riskGuard.getSnapshot());
      if (paper) {
        telemetry.setPaper(paper.getSnapshot());
      }
      telemetry.setStrategy(strategy.name, strategy.getDiagnostics?.());

      const signals = await strategy.evaluate(snapshot);
      for (const signal of signals) {
        const decision = riskGuard.canExecute(signal);
        if (!decision.allowed) {
          log.warn(`Signal blocked by risk guard token=${signal.tokenId} reason=${decision.reason}`);
          telemetry.recordSignal(signal, "blocked", decision.reason);
          continue;
        }

        log.info(`Signal: ${signal.side} ${signal.size} @ ${signal.price} — ${signal.reason}`);
        if (paper) {
          paper.applySignal(signal);
          riskGuard.recordFill(signal);
          telemetry.recordSignal(signal, "executed", "paper fill");
          telemetry.setPaper(paper.getSnapshot());
          telemetry.setRisk(riskGuard.getSnapshot());
        } else {
          try {
            await trader.placeLimitOrder(signal);
            riskGuard.recordFill(signal);
            telemetry.recordSignal(signal, "executed", "live order posted");
            telemetry.setRisk(riskGuard.getSnapshot());
          } catch (error: any) {
            const status = error?.response?.status;
            const body = JSON.stringify(error?.response?.data ?? {});
            log.error(`Live order failed status=${status ?? "n/a"} body=${body}`);
            telemetry.recordOrderFailure(signal, `status=${status ?? "n/a"} body=${body}`);
          }
        }
      }
    }
  };

  // ── 6. Run until interrupted ───────────────────────
  log.info("Bot is running. Press Ctrl+C to stop.");
  telemetry.recordInfo("lifecycle", "running");

  const telemetryPulse = setInterval(() => {
    telemetry.setStrategy(strategy.name, strategy.getDiagnostics?.());
    telemetry.setRisk(riskGuard.getSnapshot());
    if (paper) {
      telemetry.setPaper(paper.getSnapshot());
    }
  }, 3000);

  // Also run a one-time evaluation of current snapshots
  for (const snapshot of snapshots.slice(0, 5)) {
    await strategy.evaluate(snapshot);
  }

  // Graceful shutdown
  const shutdown = async () => {
    log.info("Shutting down...");
    clearInterval(telemetryPulse);
    paper?.logAccountSummary();
    log.info(
      `[RISK] shadowEquity=${riskGuard.getEquity().toFixed(4)} dailyPnl=${riskGuard.getDailyPnl().toFixed(4)} gross=${riskGuard.computeGrossExposureNotional().toFixed(4)}`
    );
    telemetry.recordInfo("lifecycle", "shutdown");
    telemetry.setRisk(riskGuard.getSnapshot());
    if (paper) {
      telemetry.setPaper(paper.getSnapshot());
    }
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
