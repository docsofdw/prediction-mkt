import { ClobClient } from "@polymarket/clob-client";
import { Wallet } from "@ethersproject/wallet";
import { AppConfig } from "../types";
import { log } from "../utils/logger";

/**
 * TradingClient — wraps @polymarket/clob-client with config-driven
 * initialization and credential derivation.
 *
 * Two-phase init:
 *   1. connect()         — creates signer + derives API creds if missing
 *   2. use the client    — place/cancel orders, get orderbook, etc.
 */
export class TradingClient {
  private config: AppConfig;
  private client: ClobClient | null = null;
  private signer: Wallet | null = null;

  constructor(config: AppConfig) {
    this.config = config;
  }

  // ─── Lifecycle ─────────────────────────────────────────

  async connect(): Promise<void> {
    log.info("Connecting to Polymarket CLOB...");

    this.signer = new Wallet(this.config.privateKey);
    log.info(`Wallet address: ${this.signer.address}`);

    // If we don't have API creds yet, derive them
    if (!this.config.apiKey || !this.config.apiSecret || !this.config.passphrase) {
      log.info("No API credentials found — deriving via createOrDeriveApiKey()...");

      const tempClient = new ClobClient(
        this.config.clobHost,
        this.config.chainId,
        this.signer
      );

      const creds = await tempClient.createOrDeriveApiKey();
      log.info("API credentials derived. Add these to your .env:");
      log.info(`  POLY_API_KEY=${creds.key}`);
      log.info(`  POLY_API_SECRET=${creds.secret}`);
      log.info(`  POLY_PASSPHRASE=${creds.passphrase}`);

      this.config.apiKey = creds.key;
      this.config.apiSecret = creds.secret;
      this.config.passphrase = creds.passphrase;
    }

    // Full authenticated client
    this.client = new ClobClient(
      this.config.clobHost,
      this.config.chainId,
      this.signer,
      {
        key: this.config.apiKey!,
        secret: this.config.apiSecret!,
        passphrase: this.config.passphrase!,
      },
      this.config.signatureType,
      this.config.funderAddress
    );

    log.info("CLOB client connected.");
  }

  // ─── Getters ───────────────────────────────────────────

  /** Get the raw ClobClient for direct SDK access */
  getClient(): ClobClient {
    if (!this.client) throw new Error("Call connect() first");
    return this.client;
  }

  getSignerAddress(): string {
    if (!this.signer) throw new Error("Call connect() first");
    return this.signer.address;
  }

  // ─── Market Data (public, no auth) ─────────────────────

  async getOrderbook(tokenId: string) {
    return this.getClient().getOrderBook(tokenId);
  }

  async getMidpoint(tokenId: string) {
    return this.getClient().getMidpoint(tokenId);
  }

  async getPrice(tokenId: string, side: "BUY" | "SELL") {
    return this.getClient().getPrice(tokenId, side);
  }

  // ─── Order Management (authenticated) ──────────────────

  async getOpenOrders() {
    return this.getClient().getOpenOrders();
  }

  async cancelAll() {
    log.warn("Cancelling all open orders...");
    return this.getClient().cancelAll();
  }

  /**
   * Place a limit order. This is a thin wrapper — for your actual
   * algo logic, build on the Strategy interface instead.
   */
  async placeLimitOrder(params: {
    tokenId: string;
    side: "BUY" | "SELL";
    price: number;
    size: number;
    tickSize?: "0.1" | "0.01" | "0.001" | "0.0001";
    negRisk?: boolean;
  }) {
    const { Side, OrderType } = await import("@polymarket/clob-client");

    const userOrder = {
      tokenID: params.tokenId,
      side: params.side === "BUY" ? Side.BUY : Side.SELL,
      price: params.price,
      size: params.size,
    };

    const options = {
      ...(params.tickSize && { tickSize: params.tickSize }),
      ...(params.negRisk !== undefined && { negRisk: params.negRisk }),
    };

    const order = await this.getClient().createAndPostOrder(
      userOrder,
      options,
      OrderType.GTC
    );

    log.info(`Order placed: ${JSON.stringify(order)}`);
    return order;
  }
}
