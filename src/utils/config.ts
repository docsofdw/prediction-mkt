import dotenv from "dotenv";
import { AppConfig } from "../types";

dotenv.config();

function env(key: string, fallback?: string): string {
  const val = process.env[key] ?? fallback;
  if (val === undefined) {
    throw new Error(`Missing required env var: ${key}. See .env.example`);
  }
  return val;
}

function optionalPositiveFloat(key: string): number | undefined {
  const raw = process.env[key];
  if (raw === undefined || raw.trim() === "") return undefined;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) return undefined;
  return value;
}

export function loadConfig(): AppConfig {
  const mode = (env("EXECUTION_MODE", "paper").toLowerCase() === "live" ? "live" : "paper");
  const strategyMode = env("STRATEGY_MODE", "dual-live").toLowerCase() === "meta-allocator"
    ? "meta-allocator"
    : "dual-live";
  return {
    privateKey: env("PRIVATE_KEY"),
    funderAddress: env("FUNDER_ADDRESS"),
    chainId: parseInt(env("CHAIN_ID", "137"), 10),
    signatureType: parseInt(env("SIGNATURE_TYPE", "0"), 10),
    executionMode: mode,
    paperInitialCash: parseFloat(env("PAPER_INITIAL_CASH", "1000")),
    defaultTradeSize: parseFloat(env("DEFAULT_TRADE_SIZE", "2")),
    strategyMode,
    ideaFactoryPath: env("IDEA_FACTORY_PATH", "backtests/idea-factory-latest.json"),
    metaMinBars: parseInt(env("META_MIN_BARS", "48"), 10),
    metaReloadMs: parseInt(env("META_RELOAD_MS", "300000"), 10),
    metaSignalCooldownMs: parseInt(env("META_SIGNAL_COOLDOWN_MS", "900000"), 10),
    riskMaxGrossExposureNotional: optionalPositiveFloat("RISK_MAX_GROSS_EXPOSURE_NOTIONAL"),
    riskMaxPerMarketNotional: optionalPositiveFloat("RISK_MAX_PER_MARKET_NOTIONAL"),
    riskMaxOrderNotional: optionalPositiveFloat("RISK_MAX_ORDER_NOTIONAL"),
    riskMaxDailyLoss: optionalPositiveFloat("RISK_MAX_DAILY_LOSS"),
    riskShadowInitialEquity: Number(env("RISK_SHADOW_INITIAL_EQUITY", env("PAPER_INITIAL_CASH", "1000"))),
    clobHost: env("CLOB_HOST", "https://clob.polymarket.com"),
    gammaHost: env("GAMMA_HOST", "https://gamma-api.polymarket.com"),
    dataApiHost: env("DATA_API_HOST", "https://data-api.polymarket.com"),
    logLevel: env("LOG_LEVEL", "info"),
    apiKey: process.env.POLY_API_KEY || undefined,
    apiSecret: process.env.POLY_API_SECRET || undefined,
    passphrase: process.env.POLY_PASSPHRASE || undefined,
  };
}
