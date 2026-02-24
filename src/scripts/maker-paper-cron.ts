/**
 * Maker Paper Trading - Cron Job with Telegram Notifications
 *
 * Designed to run automatically via cron. Performs the full paper trading
 * cycle and sends Telegram updates on significant events.
 *
 * Notifies on:
 *   - New paper orders placed
 *   - Orders filled (simulated)
 *   - Markets resolved with P&L
 *   - Daily summary (if --summary flag)
 *
 * Usage:
 *   npm run maker:paper:cron              # Run cycle, notify on events
 *   npm run maker:paper:cron -- --summary # Also send daily summary
 *   npm run maker:paper:cron -- --quiet   # No notifications (just run)
 *
 * See docs/MAKER_PAPER_TRADING.md for cron setup instructions.
 */

import "dotenv/config";
import crypto from "crypto";
import axios from "axios";
import { openValidationDb, migrateValidationDb, SqliteDatabase } from "../shared/validation/sqlite";
import { MakerLongshotSeller } from "../markets/btc/strategies/maker-longshot-seller";
import { log } from "../shared/utils/logger";

const DB_PATH = "backtests/validation.db";
const GAMMA_HOST = process.env.GAMMA_HOST || "https://gamma-api.polymarket.com";
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

// ─── Telegram ──────────────────────────────────────────────────

async function sendTelegram(message: string): Promise<void> {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) {
    log.warn("[cron] Telegram not configured, skipping notification");
    return;
  }

  const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;

  try {
    await axios.post(url, {
      chat_id: TELEGRAM_CHAT_ID,
      text: message,
      parse_mode: "Markdown",
      disable_web_page_preview: true,
    });
    log.info("[cron] Telegram sent");
  } catch (err) {
    log.error(`[cron] Telegram failed: ${err}`);
  }
}

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
  status: string;
  fill_price: number | null;
  fill_size: number | null;
  event_slug: string;
  outcome: string | null;
  pnl: number | null;
}

interface CycleResults {
  ordersPlaced: Array<{ question: string; price: number; size: number }>;
  ordersFilled: Array<{ question: string; price: number; size: number }>;
  ordersExpired: Array<{ question: string }>;
  ordersResolved: Array<{ question: string; outcome: string; pnl: number }>;
  summary: {
    totalOrders: number;
    openOrders: number;
    filledOrders: number;
    resolvedOrders: number;
    wins: number;
    losses: number;
    realizedPnl: number;
    openExposure: number;
  };
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
  }
): string {
  const orderId = `paper_${crypto.randomBytes(8).toString("hex")}`;
  const now = new Date().toISOString();

  db.prepare(`
    INSERT INTO paper_orders (
      order_id, token_id, question, side, price, size,
      estimated_edge, max_loss, created_at, status, event_slug, end_date
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', ?, '')
  `).run(
    orderId, order.tokenId, order.question, order.side,
    order.price, order.size, order.estimatedEdge, order.maxLoss,
    now, order.eventSlug
  );

  return orderId;
}

function getOpenOrders(db: SqliteDatabase): PaperOrder[] {
  return db.prepare(`SELECT * FROM paper_orders WHERE status = 'open'`).all() as PaperOrder[];
}

function getFilledUnresolved(db: SqliteDatabase): PaperOrder[] {
  return db.prepare(`SELECT * FROM paper_orders WHERE status = 'filled' AND outcome IS NULL`).all() as PaperOrder[];
}

function getAllOrders(db: SqliteDatabase): PaperOrder[] {
  return db.prepare(`SELECT * FROM paper_orders ORDER BY created_at DESC`).all() as PaperOrder[];
}

function hasExistingOrder(db: SqliteDatabase, tokenId: string): boolean {
  const row = db.prepare(`
    SELECT COUNT(*) as cnt FROM paper_orders
    WHERE token_id = ? AND status IN ('open', 'filled') AND outcome IS NULL
  `).get(tokenId) as { cnt: number };
  return row.cnt > 0;
}

function markFilled(db: SqliteDatabase, orderId: string, fillPrice: number): void {
  const now = new Date().toISOString();
  db.prepare(`UPDATE paper_orders SET status = 'filled', filled_at = ?, fill_price = ?, fill_size = size WHERE order_id = ?`)
    .run(now, fillPrice, orderId);
}

function markExpired(db: SqliteDatabase, orderId: string): void {
  const now = new Date().toISOString();
  db.prepare(`UPDATE paper_orders SET status = 'expired', expired_at = ? WHERE order_id = ?`)
    .run(now, orderId);
}

function resolveOrder(db: SqliteDatabase, orderId: string, outcome: string, pnl: number): void {
  const now = new Date().toISOString();
  db.prepare(`UPDATE paper_orders SET outcome = ?, pnl = ?, resolved_at = ? WHERE order_id = ?`)
    .run(outcome, pnl, now, orderId);
}

// ─── Market Status ─────────────────────────────────────────────

interface MarketStatus {
  closed: boolean;
  outcome: "YES" | "NO" | null;
  currentPrice: number | null;
}

async function checkMarketStatus(tokenId: string): Promise<MarketStatus> {
  try {
    const { data } = await axios.get(`${GAMMA_HOST}/markets`, {
      params: { clob_token_ids: tokenId },
      timeout: 10_000,
    });

    if (data && data.length > 0) {
      const market = data[0];
      const prices = typeof market.outcomePrices === "string"
        ? JSON.parse(market.outcomePrices)
        : market.outcomePrices;
      const yesPrice = parseFloat(prices[0]);

      if (market.closed) {
        const outcome = yesPrice > 0.9 ? "YES" : yesPrice < 0.1 ? "NO" : null;
        return { closed: true, outcome, currentPrice: yesPrice };
      }
      return { closed: false, outcome: null, currentPrice: yesPrice };
    }
    return { closed: false, outcome: null, currentPrice: null };
  } catch {
    return { closed: false, outcome: null, currentPrice: null };
  }
}

// ─── Main Cycle ────────────────────────────────────────────────

async function runCycle(db: SqliteDatabase): Promise<CycleResults> {
  const results: CycleResults = {
    ordersPlaced: [],
    ordersFilled: [],
    ordersExpired: [],
    ordersResolved: [],
    summary: {
      totalOrders: 0,
      openOrders: 0,
      filledOrders: 0,
      resolvedOrders: 0,
      wins: 0,
      losses: 0,
      realizedPnl: 0,
      openExposure: 0,
    },
  };

  // ─── 1. Scan and place new orders ─────────────────────────────

  log.info("[cron] Scanning for opportunities...");
  const strategy = new MakerLongshotSeller(GAMMA_HOST);
  const { targets } = await strategy.runScan();

  for (const target of targets) {
    if (hasExistingOrder(db, target.tokenId)) continue;

    placeOrder(db, {
      tokenId: target.tokenId,
      question: target.question,
      side: "SELL",
      price: target.sellPrice,
      size: target.sizeContracts,
      estimatedEdge: target.estimatedEdge,
      maxLoss: target.maxLossIfWrong,
      eventSlug: target.eventSlug,
    });

    results.ordersPlaced.push({
      question: target.question,
      price: target.sellPrice,
      size: target.sizeContracts,
    });
  }

  log.info(`[cron] Placed ${results.ordersPlaced.length} new orders`);

  // ─── 2. Check open orders for fills ───────────────────────────

  log.info("[cron] Checking for fills...");
  const openOrders = getOpenOrders(db);

  for (const order of openOrders) {
    const status = await checkMarketStatus(order.token_id);

    if (status.closed) {
      markExpired(db, order.order_id);
      results.ordersExpired.push({ question: order.question });
      continue;
    }

    // Fill simulation: if current price >= our sell price
    if (status.currentPrice !== null && status.currentPrice >= order.price) {
      markFilled(db, order.order_id, order.price);
      results.ordersFilled.push({
        question: order.question,
        price: order.price,
        size: order.size,
      });
    }
  }

  log.info(`[cron] Filled: ${results.ordersFilled.length}, Expired: ${results.ordersExpired.length}`);

  // ─── 3. Check filled orders for resolution ────────────────────

  log.info("[cron] Checking for resolutions...");
  const filledOrders = getFilledUnresolved(db);

  for (const order of filledOrders) {
    const status = await checkMarketStatus(order.token_id);

    if (status.closed && status.outcome) {
      let pnl: number;
      if (order.side === "SELL") {
        pnl = status.outcome === "NO"
          ? order.fill_price! * order.fill_size!
          : -(1 - order.fill_price!) * order.fill_size!;
      } else {
        pnl = status.outcome === "YES"
          ? (1 - order.fill_price!) * order.fill_size!
          : -order.fill_price! * order.fill_size!;
      }

      resolveOrder(db, order.order_id, status.outcome, pnl);
      results.ordersResolved.push({
        question: order.question,
        outcome: status.outcome,
        pnl,
      });
    }
  }

  log.info(`[cron] Resolved: ${results.ordersResolved.length}`);

  // ─── 4. Calculate summary ─────────────────────────────────────

  const allOrders = getAllOrders(db);
  results.summary = {
    totalOrders: allOrders.length,
    openOrders: allOrders.filter(o => o.status === "open").length,
    filledOrders: allOrders.filter(o => o.status === "filled").length,
    resolvedOrders: allOrders.filter(o => o.outcome !== null).length,
    wins: allOrders.filter(o => o.pnl !== null && o.pnl > 0).length,
    losses: allOrders.filter(o => o.pnl !== null && o.pnl < 0).length,
    realizedPnl: allOrders.reduce((sum, o) => sum + (o.pnl || 0), 0),
    openExposure: allOrders
      .filter(o => o.status === "filled" && o.outcome === null)
      .reduce((sum, o) => sum + (o.fill_price || 0) * (o.fill_size || 0), 0),
  };

  return results;
}

// ─── Notification Formatting ───────────────────────────────────

function formatEventNotification(results: CycleResults): string | null {
  const parts: string[] = [];

  // New orders
  if (results.ordersPlaced.length > 0) {
    parts.push(`📝 *${results.ordersPlaced.length} New Paper Order${results.ordersPlaced.length > 1 ? "s" : ""}*`);
    for (const o of results.ordersPlaced.slice(0, 3)) {
      parts.push(`• SELL ${o.size} @ ${(o.price * 100).toFixed(1)}¢`);
      parts.push(`  _${o.question.slice(0, 40)}..._`);
    }
    if (results.ordersPlaced.length > 3) {
      parts.push(`_...and ${results.ordersPlaced.length - 3} more_`);
    }
    parts.push("");
  }

  // Fills
  if (results.ordersFilled.length > 0) {
    parts.push(`✅ *${results.ordersFilled.length} Order${results.ordersFilled.length > 1 ? "s" : ""} Filled!*`);
    for (const o of results.ordersFilled.slice(0, 3)) {
      const premium = (o.price * o.size).toFixed(2);
      parts.push(`• SELL ${o.size} @ ${(o.price * 100).toFixed(1)}¢ (+$${premium} premium)`);
      parts.push(`  _${o.question.slice(0, 40)}..._`);
    }
    parts.push("");
  }

  // Resolutions
  if (results.ordersResolved.length > 0) {
    const totalPnl = results.ordersResolved.reduce((sum, o) => sum + o.pnl, 0);
    const emoji = totalPnl >= 0 ? "🟢" : "🔴";
    parts.push(`${emoji} *${results.ordersResolved.length} Market${results.ordersResolved.length > 1 ? "s" : ""} Resolved*`);

    for (const o of results.ordersResolved) {
      const pnlStr = o.pnl >= 0 ? `+$${o.pnl.toFixed(2)}` : `-$${Math.abs(o.pnl).toFixed(2)}`;
      const outcomeEmoji = o.pnl >= 0 ? "✓" : "✗";
      parts.push(`${outcomeEmoji} ${o.outcome}: ${pnlStr}`);
      parts.push(`  _${o.question.slice(0, 40)}..._`);
    }
    parts.push("");
  }

  if (parts.length === 0) return null;

  return parts.join("\n");
}

function formatSummary(results: CycleResults): string {
  const { summary } = results;
  const winRate = summary.resolvedOrders > 0
    ? ((summary.wins / summary.resolvedOrders) * 100).toFixed(1)
    : "N/A";

  const pnlEmoji = summary.realizedPnl >= 0 ? "🟢" : "🔴";
  const pnlStr = summary.realizedPnl >= 0
    ? `+$${summary.realizedPnl.toFixed(2)}`
    : `-$${Math.abs(summary.realizedPnl).toFixed(2)}`;

  return `📊 *Paper Trading Summary*

*Portfolio*
├ Open orders: ${summary.openOrders}
├ Filled (awaiting): ${summary.filledOrders - summary.resolvedOrders}
├ Resolved: ${summary.resolvedOrders}
└ Total: ${summary.totalOrders}

*Performance*
├ Wins: ${summary.wins}
├ Losses: ${summary.losses}
├ Win Rate: ${winRate}%
└ ${pnlEmoji} P&L: ${pnlStr}

*Exposure*
└ Open: $${summary.openExposure.toFixed(2)}

_Run_ \`npm run maker:paper:report\` _for details_`;
}

// ─── Main ──────────────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2);
  const sendSummary = args.includes("--summary");
  const quiet = args.includes("--quiet");

  log.info("[cron] Starting paper trading cycle...");

  const db = openValidationDb(DB_PATH);
  migrateValidationDb(db);

  try {
    const results = await runCycle(db);

    // Send event notification if anything happened
    if (!quiet) {
      const eventMsg = formatEventNotification(results);
      if (eventMsg) {
        await sendTelegram(eventMsg);
      }

      // Send summary if requested
      if (sendSummary) {
        await sendTelegram(formatSummary(results));
      }
    }

    log.info("[cron] Cycle complete");
    log.info(`[cron] P&L: $${results.summary.realizedPnl.toFixed(2)} | Win rate: ${results.summary.wins}/${results.summary.resolvedOrders}`);

  } finally {
    db.close();
  }
}

main().catch(async (err) => {
  log.error(`[cron] Failed: ${err.message}`);

  // Notify about failure
  if (TELEGRAM_BOT_TOKEN && TELEGRAM_CHAT_ID) {
    await sendTelegram(`❌ *Paper Trading Cron Failed*\n\n\`${err.message.slice(0, 200)}\``);
  }

  process.exit(1);
});
