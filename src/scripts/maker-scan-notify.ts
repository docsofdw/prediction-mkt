/**
 * Maker Scan with Telegram Notification
 *
 * Runs the maker longshot scan and sends results to Telegram.
 * Designed to be run via cron for daily automated scans.
 *
 * Usage:
 *   npm run maker:notify
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
import { writeFileSync } from "fs";
import { join } from "path";
import { MakerLongshotSeller } from "../markets/btc/strategies/maker-longshot-seller";
import { log } from "../shared/utils/logger";

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

function formatMessage(data: {
  summary: {
    marketsScanned: number;
    candidatesFound: number;
    ordersGenerated: number;
    totalExposure: number;
    avgEdge: number;
  };
  targets: Array<{
    question: string;
    sellPrice: number;
    sizeContracts: number;
    estimatedEdge: number;
    maxLossIfWrong: number;
  }>;
}): string {
  const { summary, targets } = data;

  if (targets.length === 0) {
    return `📊 *Daily Maker Scan*\n\nNo opportunities found matching current filters.\n\nMarkets scanned: ${summary.marketsScanned}`;
  }

  let message = `🎯 *Daily Maker Scan*\n\n`;
  message += `📊 *Summary*\n`;
  message += `Markets: ${summary.marketsScanned} | Candidates: ${summary.candidatesFound}\n`;
  message += `Total exposure: $${summary.totalExposure.toFixed(2)}\n`;
  message += `Avg edge: +${(summary.avgEdge * 100).toFixed(2)}%\n\n`;

  message += `📝 *Top Opportunities*\n`;

  for (const t of targets.slice(0, 5)) {
    const question = t.question.length > 35 ? t.question.slice(0, 35) + "..." : t.question;
    message += `\n• *${question}*\n`;
    message += `  SELL @ ${(t.sellPrice * 100).toFixed(1)}¢ | ${t.sizeContracts} contracts\n`;
    message += `  Edge: +${(t.estimatedEdge * 100).toFixed(2)}% | Risk: $${t.maxLossIfWrong.toFixed(0)}`;
  }

  if (targets.length > 5) {
    message += `\n\n_...and ${targets.length - 5} more opportunities_`;
  }

  message += `\n\n_Run /maker for full details_`;

  return message;
}

async function main() {
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

  // Log summary
  log.info(`[notify] Found ${targets.length} order targets`);
  log.info(`[notify] Total exposure: $${summary.totalExposure.toFixed(2)}`);
  log.info(`[notify] Average edge: ${(summary.avgEdge * 100).toFixed(2)}%`);

  // Send Telegram notification
  const message = formatMessage({ summary, targets });
  await sendTelegramMessage(message);

  log.info("[notify] Done!");
}

main().catch((error) => {
  const message = error instanceof Error ? error.stack || error.message : String(error);
  log.error(`[notify] Maker scan failed: ${message}`);

  // Try to notify about failure
  sendTelegramMessage(`❌ *Maker Scan Failed*\n\n${message.slice(0, 200)}`).catch(() => {});

  process.exit(1);
});
