import { log } from "../utils/logger";

/**
 * RealtimeFeed — wraps @polymarket/real-time-data-client for live
 * WebSocket price and trade streaming.
 *
 * Two socket endpoints exist:
 *   - CLOB WS:  wss://ws-subscriptions-clob.polymarket.com  (orderbook/trades)
 *   - RTDS WS:  wss://ws-live-data.polymarket.com           (broader market data)
 *
 * This module uses the official real-time-data-client npm package.
 */
export class RealtimeFeed {
  private client: any = null;
  private pingInterval: ReturnType<typeof setInterval> | null = null;

  /**
   * Connect to the RTDS WebSocket.
   * Optionally pass CLOB auth creds for authenticated streams.
   */
  async connect(clobAuth?: { key: string; secret: string; passphrase: string }): Promise<void> {
    const { RealTimeDataClient } = await import("@polymarket/real-time-data-client");

    return new Promise((resolve) => {
      this.client = new RealTimeDataClient({
        onMessage: (msg: any) => {
          log.debug(`WS message: ${JSON.stringify(msg)}`);
          this.handleMessage(msg);
        },
        onConnect: () => {
          log.info("WebSocket connected to Polymarket RTDS");

          // Keep-alive ping every 5s
          this.pingInterval = setInterval(() => {
            try {
              this.client?.ping?.();
            } catch {
              // Silently handle ping failures
            }
          }, 5000);

          resolve();
        },
      });
    });
  }

  // ─── Subscriptions ─────────────────────────────────────

  /** Subscribe to live trade activity */
  subscribeTrades(): void {
    if (!this.client) throw new Error("Call connect() first");
    this.client.subscribe({ topic: "activity", type: "trades" });
    log.info("Subscribed to trade activity feed");
  }

  /** Subscribe to price updates for specific markets */
  subscribePrices(assetIds: string[]): void {
    if (!this.client) throw new Error("Call connect() first");
    for (const id of assetIds) {
      this.client.subscribe({
        topic: "price",
        type: "*",
        filters: { assetId: id },
      });
    }
    log.info(`Subscribed to price feed for ${assetIds.length} asset(s)`);
  }

  /** Unsubscribe from a topic */
  unsubscribe(topic: string): void {
    this.client?.unsubscribe?.({ topic });
  }

  // ─── Message Handling ──────────────────────────────────

  /**
   * Override this or attach your own handler for processing
   * incoming WebSocket messages in your strategy.
   */
  public onTrade: ((data: any) => void) | null = null;
  public onPrice: ((data: any) => void) | null = null;

  private handleMessage(msg: any): void {
    if (msg?.topic === "activity" && msg?.type === "trades") {
      this.onTrade?.(msg.data);
    }
    if (msg?.topic === "price") {
      this.onPrice?.(msg.data);
    }
  }

  // ─── Cleanup ───────────────────────────────────────────

  disconnect(): void {
    if (this.pingInterval) clearInterval(this.pingInterval);
    this.client?.close?.();
    this.client = null;
    log.info("WebSocket disconnected");
  }
}
