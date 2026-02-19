import TelegramBot from "node-telegram-bot-api";
import { ClaimValidator, TelegramAllowlist, AuditLogger } from "../claim-validator";
import { log } from "../shared/utils/logger";
import * as fs from "fs";
import * as path from "path";
import { spawn } from "child_process";

// ─── Configuration ───────────────────────────────────────

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const ALLOWED_USERS = process.env.TELEGRAM_ALLOWED_USERS?.split(",").map(s => s.trim()) ?? [];
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
const PROJECT_PATH = process.env.PREDICTION_MKT_PATH ?? process.cwd();

if (!BOT_TOKEN) {
  console.error("Error: TELEGRAM_BOT_TOKEN not set");
  process.exit(1);
}

if (!ANTHROPIC_KEY) {
  console.error("Error: ANTHROPIC_API_KEY not set");
  process.exit(1);
}

// ─── Initialize ──────────────────────────────────────────

const bot = new TelegramBot(BOT_TOKEN, { polling: true });
const validator = new ClaimValidator(ANTHROPIC_KEY, PROJECT_PATH);
const allowlist = new TelegramAllowlist(PROJECT_PATH);
const auditLogger = new AuditLogger(PROJECT_PATH);

// Add configured users to allowlist
for (const userId of ALLOWED_USERS) {
  if (userId) allowlist.addUser(userId);
}

log.info(`[TelegramBot] Starting Polymarket Claim Validator Bot`);
log.info(`[TelegramBot] Allowed users: ${allowlist.getAllowedUsers().join(", ")}`);

// ─── Security Check ──────────────────────────────────────

function isAuthorized(userId: number): boolean {
  return allowlist.isAllowed(userId);
}

function logUnauthorized(msg: TelegramBot.Message): void {
  log.warn(`[TelegramBot] Unauthorized access attempt from user ${msg.from?.id} (@${msg.from?.username})`);
  auditLogger.log({
    eventType: "security_flag",
    metadata: {
      type: "unauthorized_access",
      userId: msg.from?.id,
      username: msg.from?.username,
      message: msg.text?.slice(0, 100),
    },
  });
}

// ─── Command Handlers ────────────────────────────────────

bot.onText(/^\/start/, async (msg: TelegramBot.Message) => {
  if (!isAuthorized(msg.from?.id ?? 0)) {
    logUnauthorized(msg);
    return bot.sendMessage(msg.chat.id, "⛔ Unauthorized. Contact admin to get access.");
  }

  const welcome = `
🦞 *Polymarket Claim Validator Bot*

Send me:
• X/Twitter post URLs
• Text claims about trading edges

I'll analyze them and tell you if they're worth exploring.

*Commands:*
/validate <text> - Validate a claim
/status - Check bot status
/scan - Run BTC inefficiency scan
/maker - Run maker longshot scan
/portfolio - Check portfolio status
/credibility - View source credibility scores
/help - Show this message
`;

  return bot.sendMessage(msg.chat.id, welcome, { parse_mode: "Markdown" });
});

bot.onText(/^\/help/, async (msg: TelegramBot.Message) => {
  if (!isAuthorized(msg.from?.id ?? 0)) return;
  return bot.onText(/\/start/, () => {}); // Reuse start message
});

bot.onText(/^\/status$/, async (msg: TelegramBot.Message) => {
  if (!isAuthorized(msg.from?.id ?? 0)) {
    logUnauthorized(msg);
    return;
  }

  const statusPath = path.join(PROJECT_PATH, "backtests/runtime-status.json");

  if (!fs.existsSync(statusPath)) {
    return bot.sendMessage(msg.chat.id, "⚠️ No runtime status available. Trading bot may not be running.");
  }

  try {
    const status = JSON.parse(fs.readFileSync(statusPath, "utf-8"));
    const message = `
📊 *Bot Status*
Strategy: ${status.strategy?.name ?? "Unknown"}
Mode: ${status.strategy?.mode ?? "Unknown"}

💰 *Equity*
Cash: $${status.paperExecution?.cash?.toFixed(2) ?? "N/A"}
Equity: $${status.paperExecution?.equity?.toFixed(2) ?? "N/A"}
Realized PnL: $${status.paperExecution?.realizedPnl?.toFixed(2) ?? "N/A"}

📈 *Signals*
Seen: ${status.signals?.seen ?? 0}
Executed: ${status.signals?.executed ?? 0}
Blocked: ${status.signals?.blocked ?? 0}
`;
    return bot.sendMessage(msg.chat.id, message, { parse_mode: "Markdown" });
  } catch (error) {
    return bot.sendMessage(msg.chat.id, "❌ Error reading status file.");
  }
});

bot.onText(/^\/scan$/, async (msg: TelegramBot.Message) => {
  if (!isAuthorized(msg.from?.id ?? 0)) {
    logUnauthorized(msg);
    return;
  }

  await bot.sendMessage(msg.chat.id, "🔍 Running BTC inefficiency scan...");

  try {
    const result = await runScript("npm", ["run", "scan:btc:inefficiencies"]);

    const resultsPath = path.join(PROJECT_PATH, "backtests/btc-inefficiencies-latest.json");
    if (fs.existsSync(resultsPath)) {
      const data = JSON.parse(fs.readFileSync(resultsPath, "utf-8"));
      const violations = data.violations ?? [];

      if (violations.length === 0) {
        return bot.sendMessage(msg.chat.id, "✅ No inefficiencies detected.");
      }

      let message = `🚨 *Found ${violations.length} Inefficiencies*\n\n`;
      for (const v of violations.slice(0, 5)) {
        message += `• *${v.type}*: ${(v.edge * 100).toFixed(2)}% edge\n`;
        message += `  ${v.description?.slice(0, 60) ?? ""}...\n\n`;
      }

      if (violations.length > 5) {
        message += `_...and ${violations.length - 5} more_`;
      }

      return bot.sendMessage(msg.chat.id, message, { parse_mode: "Markdown" });
    }
  } catch (error) {
    return bot.sendMessage(msg.chat.id, `❌ Scan failed: ${error}`);
  }
});

bot.onText(/^\/maker$/, async (msg: TelegramBot.Message) => {
  if (!isAuthorized(msg.from?.id ?? 0)) {
    logUnauthorized(msg);
    return;
  }

  await bot.sendMessage(msg.chat.id, "🎯 Running maker longshot scan...");

  try {
    await runScript("npm", ["run", "maker:scan", "--", "--json"]);

    const resultsPath = path.join(PROJECT_PATH, "backtests/maker-scan-latest.json");
    if (fs.existsSync(resultsPath)) {
      const data = JSON.parse(fs.readFileSync(resultsPath, "utf-8"));
      const { summary, targets } = data;

      if (!targets || targets.length === 0) {
        return bot.sendMessage(msg.chat.id, "📊 No maker opportunities found matching current filters.");
      }

      let message = `🎯 *Maker Longshot Scan*\n\n`;
      message += `📊 *Summary*\n`;
      message += `Markets scanned: ${summary.marketsScanned}\n`;
      message += `Candidates: ${summary.candidatesFound}\n`;
      message += `Orders: ${summary.ordersGenerated}\n`;
      message += `Total exposure: $${summary.totalExposure.toFixed(2)}\n`;
      message += `Avg edge: ${(summary.avgEdge * 100).toFixed(2)}%\n\n`;

      message += `📝 *Order Targets*\n\n`;
      for (const t of targets.slice(0, 5)) {
        const marketUrl = t.eventSlug ? `https://polymarket.com/event/${t.eventSlug}` : "";
        const noPrice = ((1 - t.sellPrice) * 100).toFixed(1);
        // $100 simulation: risk $100, profit = 100 * (sellPrice / (1 - sellPrice))
        const profitOn100 = (100 * t.sellPrice / (1 - t.sellPrice)).toFixed(2);
        message += `• *${t.question}*\n`;
        message += `  NO @ ${noPrice}¢ | ${t.sizeContracts} contracts\n`;
        message += `  💰 $100 bet → +$${profitOn100} if NO wins\n`;
        if (marketUrl) {
          message += `  [View Market](${marketUrl})\n`;
        }
        message += `\n`;
      }

      if (targets.length > 5) {
        message += `_...and ${targets.length - 5} more_`;
      }

      return bot.sendMessage(msg.chat.id, message, { parse_mode: "Markdown", disable_web_page_preview: true });
    } else {
      return bot.sendMessage(msg.chat.id, "⚠️ Scan completed but no output file found.");
    }
  } catch (error) {
    return bot.sendMessage(msg.chat.id, `❌ Maker scan failed: ${error}`);
  }
});

bot.onText(/^\/portfolio$/, async (msg: TelegramBot.Message) => {
  if (!isAuthorized(msg.from?.id ?? 0)) {
    logUnauthorized(msg);
    return;
  }

  // Same as /status
  const statusPath = path.join(PROJECT_PATH, "backtests/runtime-status.json");

  if (!fs.existsSync(statusPath)) {
    return bot.sendMessage(msg.chat.id, "⚠️ No runtime status available.");
  }

  try {
    const status = JSON.parse(fs.readFileSync(statusPath, "utf-8"));
    const message = `
💼 *Portfolio Status*
Equity: $${status.paperExecution?.equity?.toFixed(2) ?? "N/A"}
Cash: $${status.paperExecution?.cash?.toFixed(2) ?? "N/A"}
Realized PnL: $${status.paperExecution?.realizedPnl?.toFixed(2) ?? "N/A"}
Unrealized PnL: $${status.paperExecution?.unrealizedPnl?.toFixed(2) ?? "N/A"}
`;
    return bot.sendMessage(msg.chat.id, message, { parse_mode: "Markdown" });
  } catch {
    return bot.sendMessage(msg.chat.id, "❌ Error reading portfolio.");
  }
});

bot.onText(/^\/credibility$/, async (msg: TelegramBot.Message) => {
  if (!isAuthorized(msg.from?.id ?? 0)) {
    logUnauthorized(msg);
    return;
  }

  const credibilities = validator.getAllCredibilities();

  if (credibilities.length === 0) {
    return bot.sendMessage(msg.chat.id, "📊 No source credibility data yet. Submit some claims first!");
  }

  let message = "📊 *Source Credibility Scores*\n\n";

  const sorted = [...credibilities].sort((a, b) => b.credibilityScore - a.credibilityScore);

  for (const cred of sorted.slice(0, 10)) {
    const emoji = cred.credibilityScore > 0.7 ? "🟢" : cred.credibilityScore > 0.4 ? "🟡" : "🔴";
    message += `${emoji} *${cred.sourceId}*\n`;
    message += `   Score: ${(cred.credibilityScore * 100).toFixed(0)}% | Claims: ${cred.totalClaims}\n`;
    message += `   Verified: ${cred.verifiedEdges} | False: ${cred.falseEdges}\n\n`;
  }

  return bot.sendMessage(msg.chat.id, message, { parse_mode: "Markdown" });
});

bot.onText(/^\/validate (.+)/, async (msg: TelegramBot.Message, match: RegExpExecArray | null) => {
  if (!isAuthorized(msg.from?.id ?? 0)) {
    logUnauthorized(msg);
    return;
  }

  const claim = match?.[1];
  if (!claim) {
    return bot.sendMessage(msg.chat.id, "Usage: /validate <claim text or URL>");
  }

  await processClaim(msg.chat.id, claim, msg.from?.username);
});

// ─── Message Handler (for URLs and text) ─────────────────

bot.on("message", async (msg: TelegramBot.Message) => {
  // Skip commands
  if (msg.text?.startsWith("/")) return;

  if (!isAuthorized(msg.from?.id ?? 0)) {
    logUnauthorized(msg);
    return bot.sendMessage(msg.chat.id, "⛔ Unauthorized.");
  }

  const text = msg.text;
  if (!text) return;

  // Check if it's an X/Twitter URL
  const isXUrl = /https?:\/\/(twitter\.com|x\.com)\//.test(text);

  // Check if it looks like a trading claim
  const isTradingClaim = /\b(edge|strategy|momentum|breakout|arbitrage|profit|win\s*rate|sharpe|alpha|return|trading|btc|bitcoin|market)\b/i.test(text);

  if (isXUrl || isTradingClaim) {
    await processClaim(msg.chat.id, text, msg.from?.username);
  }
});

// ─── Claim Processing ────────────────────────────────────

async function processClaim(chatId: number, claim: string, username?: string): Promise<void> {
  await bot.sendMessage(chatId, "🔍 Analyzing claim...");

  try {
    const report = await validator.validate({
      source: claim,
      receivedAt: new Date(),
      sourceId: username ?? "telegram",
    });

    // Send the formatted telegram message
    await bot.sendMessage(chatId, report.telegramMessage, { parse_mode: "Markdown" });

    // If high priority, send additional alert
    if (report.verdict === "high_priority") {
      await bot.sendMessage(chatId, "🔥 *HIGH PRIORITY* - Consider acting on this soon!", { parse_mode: "Markdown" });
    }

  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    log.error(`[TelegramBot] Validation error: ${errorMsg}`);
    await bot.sendMessage(chatId, `❌ Validation failed: ${errorMsg}`);
  }
}

// ─── Helper Functions ────────────────────────────────────

function runScript(command: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: PROJECT_PATH,
      env: process.env,
    });

    let stdout = "";
    let stderr = "";

    child.stdout?.on("data", (data) => {
      stdout += data.toString();
    });

    child.stderr?.on("data", (data) => {
      stderr += data.toString();
    });

    child.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(`Command failed with code ${code}: ${stderr}`));
      } else {
        resolve(stdout);
      }
    });
  });
}

// ─── Startup ─────────────────────────────────────────────

log.info("[TelegramBot] Bot is running. Waiting for messages...");
console.log("🦞 Polymarket Claim Validator Bot started!");
console.log(`📱 Chat with your bot: https://t.me/Poly_mkt_claim_bot`);
