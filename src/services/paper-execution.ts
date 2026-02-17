import { TradeSignal } from "../types";
import { log } from "../utils/logger";

type PositionState = {
  quantity: number;
  avgPrice: number;
  realizedPnl: number;
  lastPrice: number;
};

export class PaperExecution {
  private cash: number;
  private readonly positions = new Map<string, PositionState>();
  private trades = 0;

  constructor(initialCash = 1000) {
    this.cash = initialCash;
  }

  applySignal(signal: TradeSignal): void {
    const fillPrice = signal.price;
    const fillSize = signal.size;
    const signedQty = signal.side === "BUY" ? fillSize : -fillSize;

    const prev = this.positions.get(signal.tokenId) ?? {
      quantity: 0,
      avgPrice: 0,
      realizedPnl: 0,
      lastPrice: fillPrice,
    };

    const nextQty = prev.quantity + signedQty;
    let realizedPnl = prev.realizedPnl;
    let avgPrice = prev.avgPrice;

    // Realize PnL when trade reduces/flip existing position
    if (prev.quantity !== 0 && Math.sign(prev.quantity) !== Math.sign(nextQty) || (prev.quantity !== 0 && Math.sign(prev.quantity) !== Math.sign(signedQty))) {
      const closeQty = Math.min(Math.abs(prev.quantity), Math.abs(signedQty));
      const pnlPerShare = prev.quantity > 0 ? fillPrice - prev.avgPrice : prev.avgPrice - fillPrice;
      realizedPnl += closeQty * pnlPerShare;
    }

    if (nextQty === 0) {
      avgPrice = 0;
    } else if (Math.sign(prev.quantity) === Math.sign(nextQty) && Math.sign(prev.quantity) === Math.sign(signedQty)) {
      const prevNotional = Math.abs(prev.quantity) * prev.avgPrice;
      const addNotional = Math.abs(signedQty) * fillPrice;
      avgPrice = (prevNotional + addNotional) / Math.abs(nextQty);
    } else if (Math.sign(prev.quantity) !== Math.sign(nextQty) || prev.quantity === 0) {
      avgPrice = fillPrice;
    }

    this.cash -= signedQty * fillPrice;
    this.positions.set(signal.tokenId, {
      quantity: nextQty,
      avgPrice,
      realizedPnl,
      lastPrice: fillPrice,
    });

    this.trades += 1;
    log.info(
      `[PAPER] ${signal.side} ${fillSize} ${signal.tokenId} @ ${fillPrice.toFixed(4)} reason=${signal.reason}`
    );

    if (this.trades % 10 === 0) {
      this.logAccountSummary();
    }
  }

  markPrice(tokenId: string, price: number): void {
    const current = this.positions.get(tokenId);
    if (!current) return;
    current.lastPrice = price;
    this.positions.set(tokenId, current);
  }

  getEquity(): number {
    let unrealized = 0;
    for (const pos of this.positions.values()) {
      if (pos.quantity === 0) continue;
      const pnlPerShare = pos.quantity > 0 ? pos.lastPrice - pos.avgPrice : pos.avgPrice - pos.lastPrice;
      unrealized += Math.abs(pos.quantity) * pnlPerShare;
    }

    const realized = Array.from(this.positions.values()).reduce((acc, pos) => acc + pos.realizedPnl, 0);
    return this.cash + unrealized + realized;
  }

  getSnapshot(): { cash: number; equity: number; trades: number; openPositions: number } {
    const openPositions = Array.from(this.positions.values()).filter((p) => p.quantity !== 0).length;
    return {
      cash: this.cash,
      equity: this.getEquity(),
      trades: this.trades,
      openPositions,
    };
  }

  logAccountSummary(): void {
    const openPositions = Array.from(this.positions.entries())
      .filter(([, p]) => p.quantity !== 0)
      .map(([tokenId, p]) => `${tokenId.slice(0, 8)}.. qty=${p.quantity.toFixed(2)} avg=${p.avgPrice.toFixed(3)} last=${p.lastPrice.toFixed(3)}`);

    log.info(`[PAPER] trades=${this.trades} equity=${this.getEquity().toFixed(4)} cash=${this.cash.toFixed(4)}`);
    if (openPositions.length > 0) {
      log.info(`[PAPER] open positions: ${openPositions.join(" | ")}`);
    }
  }
}
