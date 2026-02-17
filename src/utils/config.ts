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

export function loadConfig(): AppConfig {
  const mode = (env("EXECUTION_MODE", "paper").toLowerCase() === "live" ? "live" : "paper");
  return {
    privateKey: env("PRIVATE_KEY"),
    funderAddress: env("FUNDER_ADDRESS"),
    chainId: parseInt(env("CHAIN_ID", "137"), 10),
    signatureType: parseInt(env("SIGNATURE_TYPE", "0"), 10),
    executionMode: mode,
    paperInitialCash: parseFloat(env("PAPER_INITIAL_CASH", "1000")),
    defaultTradeSize: parseFloat(env("DEFAULT_TRADE_SIZE", "2")),
    clobHost: env("CLOB_HOST", "https://clob.polymarket.com"),
    gammaHost: env("GAMMA_HOST", "https://gamma-api.polymarket.com"),
    dataApiHost: env("DATA_API_HOST", "https://data-api.polymarket.com"),
    logLevel: env("LOG_LEVEL", "info"),
    apiKey: process.env.POLY_API_KEY || undefined,
    apiSecret: process.env.POLY_API_SECRET || undefined,
    passphrase: process.env.POLY_PASSPHRASE || undefined,
  };
}
