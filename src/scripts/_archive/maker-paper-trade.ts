/**
 * Maker Longshot Paper Trading
 *
 * Simulates the maker longshot strategy without real money.
 * Tracks orders, fills, and outcomes in SQLite for analysis.
 *
 * Usage:
 *   npm run maker:paper             # Run full cycle (scan → place → check → report)
 *   npm run maker:paper -- --scan   # Only scan and place new orders
 *   npm run maker:paper -- --check  # Check for fills and resolve outcomes
 *   npm run maker:paper -- --report # Show P&L report
 *   npm run maker:paper -- --reset  # Clear all paper trading data
 */

import "dotenv/config";
import crypto from "crypto";
import axios from "axios";
import { openValidationDb, migrateValidationDb, SqliteDatabase } from "../shared/validation/sqlite";
import { MakerLongshotSeller } from "../markets/btc/strategies/maker-longshot-seller";
import { log } from "../shared/utils/logger";

const DB_PATH = "backtests/validation.db";
const GAMMA_HOST = process.env.GAMMA_HOST || "https://gamma-api.polymarket.com";

// ─── Types ─────────────────────────────────────────────────────

interface PaperOrder {
  id: number;
  order_id: string;
  token_id: string;
  question: string;
  side: string;
  price: number;
  size: number;
  estimated_edge: number;
  max_loss: number;
  created_at: string;
  filled_at: string | null;
  cancelled_at: string | null;
  expired_at: string | null;
  status: string;
  fill_price: number | null;
  fill_size: number | null;
  event_slug: string;
  end_date: string;
  outcome: string | null;
  pnl: number | null;
  resolved_at: string | null;
}

// ─── Database Operations ───────────────────────────────────────

function placeOrder(
  db: SqliteDatabase,
  order: {
    tokenId: string;
    question: string;
    side: string;
    price: number;
    size: number;
    estimatedEdge: number;
    maxLoss: number;
    eventSlug: string;
    endDate: string;
  }
): string {
  const orderId = `paper_${crypto.randomBytes(8).toString("hex")}`;
  const now = new Date().toISOString();

  db.prepare(`
    INSERT INTO paper_orders (
      order_id, token_id, question, side, price, size,
      estimated_edge, max_loss, created_at, status,
      event_slug, end_date
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', ?, ?)
  `).run(
    orderId,
    order.tokenId,
    order.question,
    order.side,
    order.price,
    order.size,
    order.estimatedEdge,
    order.maxLoss,
    now,
    order.eventSlug,
    order.endDate
  );

  return orderId;
}

function getOpenOrders(db: SqliteDatabase): PaperOrder[] {
  return db.prepare(`
    SELECT * FROM paper_orders WHERE status = 'open'
  `).all() as PaperOrder[];
}

function getFilledOrders(db: SqliteDatabase): PaperOrder[] {
  return db.prepare(`
    SELECT * FROM paper_orders WHERE status = 'filled' AND outcome IS NULL
  `).all() as PaperOrder[];
}

function getAllOrders(db: SqliteDatabase): PaperOrder[] {
  return db.prepare(`
    SELECT * FROM paper_orders ORDER BY created_at DESC
  `).all() as PaperOrder[];
}

function markOrderFilled(db: SqliteDatabase, orderId: string, fillPrice: number): void {
  const now = new Date().toISOString();
  db.prepare(`
    UPDATE paper_orders
    SET status = 'filled', filled_at = ?, fill_price = ?, fill_size = size
    WHERE order_id = ?
  `).run(now, fillPrice, orderId);
}

function markOrderExpired(db: SqliteDatabase, orderId: string): void {
  const now = new Date().toISOString();
  db.prepare(`
    UPDATE paper_orders
    SET status = 'expired', expired_at = ?
    WHERE order_id = ?
  `).run(now, orderId);
}

function resolveOrder(db: SqliteDatabase, orderId: string, outcome: string, pnl: number): void {
  const now = new Date().toISOString();
  db.prepare(`
    UPDATE paper_orders
    SET outcome = ?, pnl = ?, resolved_at = ?
    WHERE order_id = ?
  `).run(outcome, pnl, now, orderId);
}

function hasExistingOrder(db: SqliteDatabase, tokenId: string): boolean {
  const row = db.prepare(`
    SELECT COUNT(*) as cnt FROM paper_orders
    WHERE token_id = ? AND status IN ('open', 'filled') AND outcome IS NULL
  `).get(tokenId) as { cnt: number };
  return row.cnt > 0;
}

function resetPaperTrading(db: SqliteDatabase): void {
  db.exec(`DELETE FROM paper_orders`);
  db.exec(`DELETE FROM paper_trading_summary`);
  log.info("Paper trading data cleared");
}

// ─── Market Checking ───────────────────────────────────────────

interface MarketStatus {
  closed: boolean;
  outcome: "YES" | "NO" | null;
  currentPrice: number | null;
}

async function checkMarketStatus(tokenId: string): Promise<MarketStatus> {
  try {
    // Get market info from Gamma API
    const { data } = await axios.get(`${GAMMA_HOST}/markets`, {
      params: { clob_token_ids: tokenId },
      timeout: 10_000,
    });

    if (data && data.length > 0) {
      const market = data[0];

      // Parse outcome prices
      const prices = typeof market.outcomePrices === "string"
        ? JSON.parse(market.outcomePrices)
        : market.outcomePrices;

      const yesPrice = parseFloat(prices[0]);

      // Check if market is closed/resolved
      if (market.closed) {
        // Determine outcome based on final prices
        // If YES price is ~1, YES won. If ~0, NO won.
        const outcome = yesPrice > 0.9 ? "YES" : yesPrice < 0.1 ? "NO" : null;
        return { closed: true, outcome, currentPrice: yesPrice };
      }

      return { closed: false, outcome: null, currentPrice: yesPrice };
    }

    return { closed: false, outcome: null, currentPrice: null };
  } catch (e) {
    log.warn(`Failed to check market status for ${tokenId.slice(0, 20)}...`);
    return { closed: false, outcome: null, currentPrice: null };
  }
}

// ─── Fill Simulation ───────────────────────────────────────────

/**
 * Simulates whether a maker sell order would have filled.
 *
 * Conservative assumption: if current price >= our sell price,
 * assume a taker crossed our order and we got filled.
 */
async function simulateFill(order: PaperOrder): Promise<boolean> {
  const status = await checkMarketStatus(order.token_id);

  if (status.currentPrice === null) return false;

  // For SELL orders: filled if market price rose to our price or higher
  // This is conservative - real fills depend on order book activity
  if (order.side === "SELL" && status.currentPrice >= order.price) {
    return true;
  }

  // For BUY orders: filled if market price dropped to our price or lower
  if (order.side === "BUY" && status.currentPrice <= order.price) {
    return true;
  }

  return false;
}

// ─── Main Operations ───────────────────────────────────────────

async function scanAndPlace(db: SqliteDatabase): Promise<void> {
  log.info("═".repeat(60));
  log.info("SCANNING FOR MAKER OPPORTUNITIES");
  log.info("═".repeat(60));

  const strategy = new MakerLongshotSeller(GAMMA_HOST);
  const { targets, summary } = await strategy.runScan();

  log.info(`Found ${targets.length} order targets`);

  let placed = 0;
  let skipped = 0;

  for (const target of targets) {
    // Skip if we already have an open order on this token
    if (hasExistingOrder(db, target.tokenId)) {
      log.info(`Skipping ${target.question.slice(0, 40)}... (existing order)`);
      skipped++;
      continue;
    }

    const orderId = placeOrder(db, {
      tokenId: target.tokenId,
      question: target.question,
      side: "SELL",
      price: target.sellPrice,
      size: target.sizeContracts,
      estimatedEdge: target.estimatedEdge,
      maxLoss: target.maxLossIfWrong,
      eventSlug: target.eventSlug,
      endDate: "", // Will be filled from market data
    });

    log.info(`📝 PAPER ORDER: SELL ${target.sizeContracts} @ ${(target.sellPrice * 100).toFixed(1)}¢`);
    log.info(`   ${target.question.slice(0, 50)}...`);
    log.info(`   Order ID: ${orderId}`);
    placed++;
  }

  log.info("");
  log.info(`Orders placed: ${placed}`);
  log.info(`Orders skipped: ${skipped} (already have position)`);
  log.info(`Total exposure: $${summary.totalExposure.toFixed(2)}`);
}

async function checkFillsAndResolve(db: SqliteDatabase): Promise<void> {
  log.info("═".repeat(60));
  log.info("CHECKING FILLS AND OUTCOMES");
  log.info("═".repeat(60));

  // Check open orders for fills
  const openOrders = getOpenOrders(db);
  log.info(`Open orders: ${openOrders.length}`);

  let filled = 0;
  let expired = 0;

  for (const order of openOrders) {
    const status = await checkMarketStatus(order.token_id);

    // If market is closed and we didn't fill, mark expired
    if (status.closed) {
      markOrderExpired(db, order.order_id);
      log.info(`⏰ EXPIRED: ${order.question.slice(0, 40)}...`);
      expired++;
      continue;
    }

    // Check for fill
    const didFill = await simulateFill(order);
    if (didFill) {
      markOrderFilled(db, order.order_id, order.price);
      log.info(`✅ FILLED: SELL ${order.size} @ ${(order.price * 100).toFixed(1)}¢`);
      log.info(`   ${order.question.slice(0, 50)}...`);
      filled++;
    }
  }

  log.info(`Filled this cycle: ${filled}`);
  log.info(`Expired this cycle: ${expired}`);

  // Check filled orders for resolution
  log.info("");
  log.info("Checking filled orders for market resolution...");

  const filledOrders = getFilledOrders(db);
  let resolved = 0;

  for (const order of filledOrders) {
    const status = await checkMarketStatus(order.token_id);

    if (status.closed && status.outcome) {
      // Calculate P&L
      // For SELL orders: we sold YES tokens
      // If NO wins: we keep the premium (positive P&L)
      // If YES wins: we lose (1 - sell_price) per contract (negative P&L)

      let pnl: number;
      if (order.side === "SELL") {
        if (status.outcome === "NO") {
          // We win - keep the premium
          pnl = order.fill_price! * order.fill_size!;
        } else {
          // YES wins - we lose
          pnl = -(1 - order.fill_price!) * order.fill_size!;
        }
      } else {
        // BUY orders (not used in this strategy, but for completeness)
        if (status.outcome === "YES") {
          pnl = (1 - order.fill_price!) * order.fill_size!;
        } else {
          pnl = -order.fill_price! * order.fill_size!;
        }
      }

      resolveOrder(db, order.order_id, status.outcome, pnl);

      const emoji = pnl >= 0 ? "🟢" : "🔴";
      log.info(`${emoji} RESOLVED: ${status.outcome} → P&L: $${pnl.toFixed(2)}`);
      log.info(`   ${order.question.slice(0, 50)}...`);
      resolved++;
    }
  }

  log.info(`Resolved this cycle: ${resolved}`);
}

function generateReport(db: SqliteDatabase): void {
  log.info("═".repeat(60));
  log.info("PAPER TRADING REPORT");
  log.info("═".repeat(60));

  const allOrders = getAllOrders(db);

  // Calculate statistics
  const stats = {
    total: allOrders.length,
    open: allOrders.filter((o) => o.status === "open").length,
    filled: allOrders.filter((o) => o.status === "filled").length,
    expired: allOrders.filter((o) => o.status === "expired").length,
    resolved: allOrders.filter((o) => o.outcome !== null).length,
    wins: allOrders.filter((o) => o.pnl !== null && o.pnl > 0).length,
    losses: allOrders.filter((o) => o.pnl !== null && o.pnl < 0).length,
    realizedPnl: allOrders.reduce((sum, o) => sum + (o.pnl || 0), 0),
    totalExposure: allOrders
      .filter((o) => o.status === "filled" && o.outcome === null)
      .reduce((sum, o) => sum + (o.fill_price || 0) * (o.fill_size || 0), 0),
  };

  const winRate = stats.resolved > 0 ? (stats.wins / stats.resolved * 100).toFixed(1) : "N/A";

  log.info("");
  log.info("SUMMARY");
  log.info("-".repeat(40));
  log.info(`Total orders:     ${stats.total}`);
  log.info(`  Open:           ${stats.open}`);
  log.info(`  Filled:         ${stats.filled}`);
  log.info(`  Expired:        ${stats.expired}`);
  log.info("");
  log.info(`Resolved:         ${stats.resolved}`);
  log.info(`  Wins:           ${stats.wins}`);
  log.info(`  Losses:         ${stats.losses}`);
  log.info(`  Win Rate:       ${winRate}%`);
  log.info("");
  log.info(`Realized P&L:     $${stats.realizedPnl.toFixed(2)}`);
  log.info(`Open Exposure:    $${stats.totalExposure.toFixed(2)}`);

  // Show recent orders
  if (allOrders.length > 0) {
    log.info("");
    log.info("RECENT ORDERS");
    log.info("-".repeat(40));

    for (const order of allOrders.slice(0, 10)) {
      const statusEmoji =
        order.status === "open" ? "⏳" :
        order.status === "filled" ? (order.outcome ? (order.pnl! >= 0 ? "🟢" : "🔴") : "📦") :
        "⏰";

      const pnlStr = order.pnl !== null ? ` → $${order.pnl.toFixed(2)}` : "";
      const priceStr = `${(order.price * 100).toFixed(1)}¢`;

      log.info(`${statusEmoji} ${order.side} ${order.size} @ ${priceStr}${pnlStr}`);
      log.info(`   ${order.question.slice(0, 50)}...`);
    }
  }

  // Show edge analysis
  const resolvedOrders = allOrders.filter((o) => o.outcome !== null);
  if (resolvedOrders.length > 0) {
    const avgEdgeExpected = resolvedOrders.reduce((sum, o) => sum + o.estimated_edge, 0) / resolvedOrders.length;
    const avgPnlPerContract = stats.realizedPnl / resolvedOrders.reduce((sum, o) => sum + (o.fill_size || 0), 0);

    log.info("");
    log.info("EDGE ANALYSIS");
    log.info("-".repeat(40));
    log.info(`Expected edge:    ${(avgEdgeExpected * 100).toFixed(2)}%`);
    log.info(`Realized edge:    ${(avgPnlPerContract * 100).toFixed(2)}% per contract`);
  }
}

// ─── Main ──────────────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2);

  const db = openValidationDb(DB_PATH);
  migrateValidationDb(db);

  try {
    if (args.includes("--reset")) {
      resetPaperTrading(db);
      return;
    }

    if (args.includes("--report")) {
      generateReport(db);
      return;
    }

    if (args.includes("--scan")) {
      await scanAndPlace(db);
      return;
    }

    if (args.includes("--check")) {
      await checkFillsAndResolve(db);
      return;
    }

    // Default: run full cycle
    await scanAndPlace(db);
    log.info("");
    await checkFillsAndResolve(db);
    log.info("");
    generateReport(db);

  } finally {
    db.close();
  }
}

main().catch((err) => {
  log.error(`Paper trading failed: ${err.message}`);
  process.exit(1);
});
