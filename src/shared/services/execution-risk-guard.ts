import { TradeSignal } from "../../types";

interface PositionState {
  quantity: number;
  avgPrice: number;
  realizedPnl: number;
  lastPrice: number;
}

interface GuardLimits {
  maxGrossExposureNotional?: number;
  maxPerMarketNotional?: number;
  maxOrderNotional?: number;
  maxDailyLoss?: number;
  shadowInitialEquity: number;
}

interface GuardDecision {
  allowed: boolean;
  reason: string;
}

interface GuardSnapshot {
  equity: number;
  dailyPnl: number;
  grossExposure: number;
  killSwitchActive: boolean;
  limits: {
    maxGrossExposureNotional?: number;
    maxPerMarketNotional?: number;
    maxOrderNotional?: number;
    maxDailyLoss?: number;
  };
}

function signedQty(side: "BUY" | "SELL", size: number): number {
  return side === "BUY" ? size : -size;
}

export class ExecutionRiskGuard {
  private readonly positions = new Map<string, PositionState>();
  private cash: number;
  private dayKey: string;
  private dayStartEquity: number;

  constructor(private readonly limits: GuardLimits) {
    this.cash = limits.shadowInitialEquity;
    this.dayKey = this.utcDayKey();
    this.dayStartEquity = limits.shadowInitialEquity;
  }

  markPrice(tokenId: string, price: number): void {
    if (!Number.isFinite(price) || price <= 0) return;
    const position = this.positions.get(tokenId);
    if (!position) return;
    position.lastPrice = price;
    this.positions.set(tokenId, position);
  }

  canExecute(signal: TradeSignal): GuardDecision {
    this.ensureDayRoll();

    if (this.isDailyLossBreached()) {
      return { allowed: false, reason: "Daily loss kill-switch active" };
    }

    const orderNotional = Math.abs(signal.size * signal.price);
    if (this.limits.maxOrderNotional !== undefined && orderNotional > this.limits.maxOrderNotional) {
      return {
        allowed: false,
        reason: `Order notional ${orderNotional.toFixed(4)} > maxOrderNotional ${this.limits.maxOrderNotional.toFixed(4)}`,
      };
    }

    const prev = this.positions.get(signal.tokenId) ?? {
      quantity: 0,
      avgPrice: 0,
      realizedPnl: 0,
      lastPrice: signal.price,
    };

    const currentTokenNotional = Math.abs(prev.quantity * prev.lastPrice);
    const nextQty = prev.quantity + signedQty(signal.side, signal.size);
    const nextTokenNotional = Math.abs(nextQty * signal.price);

    if (
      this.limits.maxPerMarketNotional !== undefined &&
      nextTokenNotional > this.limits.maxPerMarketNotional
    ) {
      return {
        allowed: false,
        reason: `Token notional ${nextTokenNotional.toFixed(4)} > maxPerMarketNotional ${this.limits.maxPerMarketNotional.toFixed(4)}`,
      };
    }

    const currentGross = this.computeGrossExposureNotional();
    const projectedGross = currentGross - currentTokenNotional + nextTokenNotional;

    if (
      this.limits.maxGrossExposureNotional !== undefined &&
      projectedGross > this.limits.maxGrossExposureNotional
    ) {
      return {
        allowed: false,
        reason: `Gross exposure ${projectedGross.toFixed(4)} > maxGrossExposureNotional ${this.limits.maxGrossExposureNotional.toFixed(4)}`,
      };
    }

    return { allowed: true, reason: "ok" };
  }

  recordFill(signal: TradeSignal): void {
    this.ensureDayRoll();

    const fillPrice = signal.price;
    const fillSize = signal.size;
    const tradeSignedQty = signedQty(signal.side, fillSize);

    const prev = this.positions.get(signal.tokenId) ?? {
      quantity: 0,
      avgPrice: 0,
      realizedPnl: 0,
      lastPrice: fillPrice,
    };

    const nextQty = prev.quantity + tradeSignedQty;
    let realizedPnl = prev.realizedPnl;
    let avgPrice = prev.avgPrice;

    const isReducingOrFlip =
      (prev.quantity !== 0 && Math.sign(prev.quantity) !== Math.sign(nextQty)) ||
      (prev.quantity !== 0 && Math.sign(prev.quantity) !== Math.sign(tradeSignedQty));

    if (isReducingOrFlip) {
      const closeQty = Math.min(Math.abs(prev.quantity), Math.abs(tradeSignedQty));
      const pnlPerShare = prev.quantity > 0 ? fillPrice - prev.avgPrice : prev.avgPrice - fillPrice;
      realizedPnl += closeQty * pnlPerShare;
    }

    if (nextQty === 0) {
      avgPrice = 0;
    } else if (Math.sign(prev.quantity) === Math.sign(nextQty) && Math.sign(prev.quantity) === Math.sign(tradeSignedQty)) {
      const prevNotional = Math.abs(prev.quantity) * prev.avgPrice;
      const addNotional = Math.abs(tradeSignedQty) * fillPrice;
      avgPrice = (prevNotional + addNotional) / Math.abs(nextQty);
    } else if (Math.sign(prev.quantity) !== Math.sign(nextQty) || prev.quantity === 0) {
      avgPrice = fillPrice;
    }

    this.cash -= tradeSignedQty * fillPrice;

    this.positions.set(signal.tokenId, {
      quantity: nextQty,
      avgPrice,
      realizedPnl,
      lastPrice: fillPrice,
    });
  }

  getDailyPnl(): number {
    this.ensureDayRoll();
    return this.getEquity() - this.dayStartEquity;
  }

  getSnapshot(): GuardSnapshot {
    return {
      equity: this.getEquity(),
      dailyPnl: this.getDailyPnl(),
      grossExposure: this.computeGrossExposureNotional(),
      killSwitchActive: this.isDailyLossBreached(),
      limits: {
        maxGrossExposureNotional: this.limits.maxGrossExposureNotional,
        maxPerMarketNotional: this.limits.maxPerMarketNotional,
        maxOrderNotional: this.limits.maxOrderNotional,
        maxDailyLoss: this.limits.maxDailyLoss,
      },
    };
  }

  getEquity(): number {
    const realized = Array.from(this.positions.values()).reduce((acc, p) => acc + p.realizedPnl, 0);
    let unrealized = 0;

    for (const position of this.positions.values()) {
      if (position.quantity === 0) continue;
      const pnlPerShare =
        position.quantity > 0
          ? position.lastPrice - position.avgPrice
          : position.avgPrice - position.lastPrice;
      unrealized += Math.abs(position.quantity) * pnlPerShare;
    }

    return this.cash + realized + unrealized;
  }

  computeGrossExposureNotional(): number {
    let gross = 0;
    for (const position of this.positions.values()) {
      gross += Math.abs(position.quantity * position.lastPrice);
    }
    return gross;
  }

  private isDailyLossBreached(): boolean {
    if (this.limits.maxDailyLoss === undefined) return false;
    return this.getDailyPnl() <= -Math.abs(this.limits.maxDailyLoss);
  }

  private ensureDayRoll(): void {
    const nowKey = this.utcDayKey();
    if (nowKey === this.dayKey) return;
    this.dayKey = nowKey;
    this.dayStartEquity = this.getEquity();
  }

  private utcDayKey(): string {
    const d = new Date();
    const year = d.getUTCFullYear();
    const month = String(d.getUTCMonth() + 1).padStart(2, "0");
    const day = String(d.getUTCDate()).padStart(2, "0");
    return `${year}-${month}-${day}`;
  }
}
