/**
 * Maker Scan with Telegram Notification
 *
 * Runs the maker longshot scan and sends results to Telegram.
 * Only notifies when:
 *   - New markets are found (not seen before)
 *   - Prices changed significantly (>10%)
 *   - Weekly digest (7 days since last notification)
 *
 * Usage:
 *   npm run maker:notify
 *   npm run maker:notify -- --force  # Force send even if no changes
 *
 * Environment:
 *   TELEGRAM_BOT_TOKEN - Bot token for sending messages
 *   TELEGRAM_CHAT_ID - Chat ID to send notifications to
 *
 * Cron example (daily at 9am):
 *   0 9 * * * cd /path/to/prediction-mkt && npm run maker:notify
 */

import "dotenv/config";
import axios from "axios";
import { writeFileSync, readFileSync, existsSync } from "fs";
import { join } from "path";
import { MakerLongshotSeller } from "../markets/btc/strategies/maker-longshot-seller";
import { log } from "../shared/utils/logger";

// ─── State Tracking ─────────────────────────────────────────
interface ScanState {
  lastNotificationDate: string;
  seenMarkets: Record<string, { price: number; firstSeen: string }>;
}

const STATE_FILE = join(process.cwd(), "backtests/maker-scan-state.json");
const PRICE_CHANGE_THRESHOLD = 0.10; // 10% price change triggers notification
const WEEKLY_DIGEST_DAYS = 7;

function loadState(): ScanState {
  if (existsSync(STATE_FILE)) {
    try {
      return JSON.parse(readFileSync(STATE_FILE, "utf-8"));
    } catch {
      log.warn("[notify] Could not parse state file, starting fresh");
    }
  }
  return { lastNotificationDate: "", seenMarkets: {} };
}

function saveState(state: ScanState): void {
  writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

function daysSinceLastNotification(state: ScanState): number {
  if (!state.lastNotificationDate) return Infinity;
  const last = new Date(state.lastNotificationDate);
  const now = new Date();
  return (now.getTime() - last.getTime()) / (1000 * 60 * 60 * 24);
}

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const GAMMA_HOST = process.env.GAMMA_HOST || "https://gamma-api.polymarket.com";

interface TelegramResponse {
  ok: boolean;
  description?: string;
}

async function sendTelegramMessage(message: string): Promise<void> {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) {
    log.warn("[notify] Telegram credentials not configured, skipping notification");
    return;
  }

  const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;

  try {
    const response = await axios.post<TelegramResponse>(url, {
      chat_id: TELEGRAM_CHAT_ID,
      text: message,
      parse_mode: "Markdown",
      disable_web_page_preview: true,
    });

    if (response.data.ok) {
      log.info("[notify] Telegram message sent successfully");
    } else {
      log.error(`[notify] Telegram API error: ${response.data.description}`);
    }
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    log.error(`[notify] Failed to send Telegram message: ${msg}`);
  }
}

interface Target {
  question: string;
  eventSlug: string;
  sellPrice: number;
  sizeContracts: number;
  estimatedEdge: number;
  maxLossIfWrong: number;
  returnPer1Dollar: number;
}

function formatMessage(data: {
  summary: {
    marketsScanned: number;
    candidatesFound: number;
    ordersGenerated: number;
    totalExposure: number;
    avgEdge: number;
  };
  targets: Target[];
  newMarkets: Target[];
  priceChanges: Array<{ target: Target; oldPrice: number; newPrice: number }>;
  isWeeklyDigest: boolean;
}): string {
  const { summary, targets, newMarkets, priceChanges, isWeeklyDigest } = data;

  if (targets.length === 0) {
    return `📊 *Maker Scan*\n\nNo opportunities found matching current filters.\n\nMarkets scanned: ${summary.marketsScanned}`;
  }

  // Determine header based on what triggered the notification
  let header: string;
  if (newMarkets.length > 0) {
    header = `🆕 *New Maker Opportunities Found!*`;
  } else if (priceChanges.length > 0) {
    header = `📈 *Price Movement Alert*`;
  } else if (isWeeklyDigest) {
    header = `📅 *Weekly Maker Digest*`;
  } else {
    header = `🎯 *Maker Scan Update*`;
  }

  let message = `${header}\n\n`;

  // Show new markets first if any
  if (newMarkets.length > 0) {
    message += `🆕 *${newMarkets.length} New Market${newMarkets.length > 1 ? "s" : ""}*\n`;
    for (const t of newMarkets.slice(0, 3)) {
      const marketUrl = t.eventSlug ? `https://polymarket.com/event/${t.eventSlug}` : "";
      const noPrice = ((1 - t.sellPrice) * 100).toFixed(1);
      const profitOn100 = (100 * t.sellPrice / (1 - t.sellPrice)).toFixed(2);
      message += `\n• *${t.question}*\n`;
      message += `  NO @ ${noPrice}¢ | 💰 $100 → +$${profitOn100}\n`;
      if (marketUrl) {
        message += `  [View Market](${marketUrl})\n`;
      }
    }
    if (newMarkets.length > 3) {
      message += `\n_...and ${newMarkets.length - 3} more new_\n`;
    }
    message += `\n`;
  }

  // Show price changes if any
  if (priceChanges.length > 0) {
    message += `📈 *Price Changes*\n`;
    for (const pc of priceChanges.slice(0, 3)) {
      const oldNo = ((1 - pc.oldPrice) * 100).toFixed(1);
      const newNo = ((1 - pc.newPrice) * 100).toFixed(1);
      const direction = pc.newPrice > pc.oldPrice ? "↗️" : "↘️";
      message += `${direction} ${pc.target.question.slice(0, 35)}...\n`;
      message += `   NO: ${oldNo}¢ → ${newNo}¢\n`;
    }
    message += `\n`;
  }

  // Summary stats
  message += `📊 Total: ${targets.length} opportunities | Avg edge: +${(summary.avgEdge * 100).toFixed(2)}%\n`;
  message += `\n_Run /maker for full details_`;

  return message;
}

async function main() {
  const forceNotify = process.argv.includes("--force");
  log.info("[notify] Starting maker scan with Telegram notification...");

  const strategy = new MakerLongshotSeller(GAMMA_HOST);
  const { candidates, targets, summary } = await strategy.runScan();

  // Save results
  const output = {
    generatedAt: new Date().toISOString(),
    summary,
    candidates: candidates.slice(0, 20),
    targets,
  };

  const outputPath = join(process.cwd(), "backtests/maker-scan-latest.json");
  writeFileSync(outputPath, JSON.stringify(output, null, 2));
  log.info(`[notify] Results saved to: ${outputPath}`);

  // Load previous state
  const state = loadState();
  const daysSinceLast = daysSinceLastNotification(state);
  log.info(`[notify] Days since last notification: ${daysSinceLast.toFixed(1)}`);

  // Categorize markets
  const newMarkets: Target[] = [];
  const priceChanges: Array<{ target: Target; oldPrice: number; newPrice: number }> = [];

  for (const target of targets) {
    const key = target.eventSlug || target.question;
    const prev = state.seenMarkets[key];

    if (!prev) {
      // New market
      newMarkets.push(target);
      state.seenMarkets[key] = {
        price: target.sellPrice,
        firstSeen: new Date().toISOString(),
      };
    } else {
      // Check for significant price change
      const priceDiff = Math.abs(target.sellPrice - prev.price) / prev.price;
      if (priceDiff >= PRICE_CHANGE_THRESHOLD) {
        priceChanges.push({
          target,
          oldPrice: prev.price,
          newPrice: target.sellPrice,
        });
      }
      // Update price
      state.seenMarkets[key].price = target.sellPrice;
    }
  }

  // Log summary
  log.info(`[notify] Found ${targets.length} order targets`);
  log.info(`[notify] New markets: ${newMarkets.length}`);
  log.info(`[notify] Price changes: ${priceChanges.length}`);

  // Determine if we should notify
  const isWeeklyDigest = daysSinceLast >= WEEKLY_DIGEST_DAYS;
  const hasChanges = newMarkets.length > 0 || priceChanges.length > 0;
  const shouldNotify = forceNotify || hasChanges || isWeeklyDigest;

  if (!shouldNotify) {
    log.info("[notify] No changes detected, skipping notification");
    saveState(state);
    return;
  }

  if (forceNotify) {
    log.info("[notify] Force flag set, sending notification");
  } else if (isWeeklyDigest) {
    log.info("[notify] Sending weekly digest");
  } else {
    log.info("[notify] Changes detected, sending notification");
  }

  // Send Telegram notification
  const message = formatMessage({
    summary,
    targets,
    newMarkets,
    priceChanges,
    isWeeklyDigest: isWeeklyDigest && !hasChanges,
  });
  await sendTelegramMessage(message);

  // Update state
  state.lastNotificationDate = new Date().toISOString();
  saveState(state);

  log.info("[notify] Done!");
}

main().catch((error) => {
  const message = error instanceof Error ? error.stack || error.message : String(error);
  log.error(`[notify] Maker scan failed: ${message}`);

  // Try to notify about failure
  sendTelegramMessage(`❌ *Maker Scan Failed*\n\n${message.slice(0, 200)}`).catch(() => {});

  process.exit(1);
});
