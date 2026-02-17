import { Strategy, MarketSnapshot, TradeSignal } from "../types";
import { log } from "../utils/logger";

/**
 * ExampleStrategy — a no-op placeholder showing the strategy interface.
 *
 * Replace this with your actual trading logic. The runner will call:
 *   1. initialize()   — once at startup
 *   2. evaluate()     — on each market snapshot (price tick, poll, etc.)
 *   3. teardown()     — on shutdown
 */
export class ExampleStrategy implements Strategy {
  name = "example";
  description = "Placeholder strategy — logs snapshots, never trades";

  async initialize(): Promise<void> {
    log.info(`[${this.name}] Strategy initialized`);
  }

  async evaluate(snapshot: MarketSnapshot): Promise<TradeSignal[]> {
    log.debug(
      `[${this.name}] ${snapshot.question} | ` +
        `bid=${snapshot.bestBid.toFixed(3)} ask=${snapshot.bestAsk.toFixed(3)} ` +
        `spread=${snapshot.spread.toFixed(3)} vol=${snapshot.volume.toFixed(0)}`
    );

    // ── Your logic goes here ──
    // Return TradeSignal[] to place orders, or [] to do nothing.
    //
    // Example signal (commented out):
    // if (snapshot.bestBid < 0.10 && snapshot.volume > 50000) {
    //   return [{
    //     tokenId: snapshot.tokenId,
    //     side: "BUY",
    //     price: snapshot.bestBid + 0.01,
    //     size: 10,
    //     reason: "Low price + high volume",
    //   }];
    // }

    return [];
  }

  async teardown(): Promise<void> {
    log.info(`[${this.name}] Strategy torn down`);
  }
}
