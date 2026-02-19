import fs from "node:fs";
import path from "node:path";
import { AppConfig, TradeSignal } from "../../types";

export interface RuntimeEvent {
  at: string;
  type: "signal" | "order" | "risk" | "lifecycle" | "error";
  status?: "executed" | "blocked" | "failed" | "info";
  tokenId?: string;
  side?: "BUY" | "SELL";
  size?: number;
  price?: number;
  reason?: string;
  details?: string;
}

interface RuntimeStatus {
  startedAt: string;
  updatedAt: string;
  config: {
    executionMode: string;
    strategyMode: string;
    chainId: number;
    clobHost: string;
    gammaHost: string;
    funderAddressMasked: string;
    ideaFactoryPath: string;
  };
  marketUniverse: {
    totalSnapshots: number;
    tokenIds: string[];
  };
  strategy: {
    name: string;
    diagnostics?: unknown;
  };
  paper?: {
    cash: number;
    equity: number;
    trades: number;
    openPositions: number;
  };
  risk?: {
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
  };
  counters: {
    signalsSeen: number;
    signalsExecuted: number;
    signalsBlocked: number;
    orderFailures: number;
  };
  recentEvents: RuntimeEvent[];
}

function maskAddress(address: string): string {
  if (!address || address.length < 10) return "unknown";
  return `${address.slice(0, 6)}...${address.slice(-4)}`;
}

export class RuntimeTelemetry {
  private readonly statusPath: string;
  private readonly status: RuntimeStatus;

  constructor(config: AppConfig, statusPath = "backtests/runtime-status.json") {
    this.statusPath = path.resolve(process.cwd(), statusPath);
    const startedAt = new Date().toISOString();

    this.status = {
      startedAt,
      updatedAt: startedAt,
      config: {
        executionMode: config.executionMode,
        strategyMode: config.strategyMode,
        chainId: config.chainId,
        clobHost: config.clobHost,
        gammaHost: config.gammaHost,
        funderAddressMasked: maskAddress(config.funderAddress),
        ideaFactoryPath: config.ideaFactoryPath,
      },
      marketUniverse: {
        totalSnapshots: 0,
        tokenIds: [],
      },
      strategy: {
        name: "unknown",
      },
      counters: {
        signalsSeen: 0,
        signalsExecuted: 0,
        signalsBlocked: 0,
        orderFailures: 0,
      },
      recentEvents: [],
    };

    this.flush();
  }

  setUniverse(tokenIds: string[]): void {
    this.status.marketUniverse = {
      totalSnapshots: tokenIds.length,
      tokenIds: Array.from(new Set(tokenIds)).slice(0, 500),
    };
    this.flush();
  }

  setStrategy(name: string, diagnostics?: unknown): void {
    this.status.strategy = { name, diagnostics };
    this.flush();
  }

  setPaper(paper: { cash: number; equity: number; trades: number; openPositions: number }): void {
    this.status.paper = paper;
    this.flush();
  }

  setRisk(risk: RuntimeStatus["risk"]): void {
    this.status.risk = risk;
    this.flush();
  }

  recordSignal(signal: TradeSignal, status: RuntimeEvent["status"], reason?: string): void {
    this.status.counters.signalsSeen += 1;
    if (status === "executed") this.status.counters.signalsExecuted += 1;
    if (status === "blocked") this.status.counters.signalsBlocked += 1;

    this.pushEvent({
      at: new Date().toISOString(),
      type: "signal",
      status,
      tokenId: signal.tokenId,
      side: signal.side,
      size: signal.size,
      price: signal.price,
      reason: reason || signal.reason,
    });
  }

  recordOrderFailure(signal: TradeSignal, details: string): void {
    this.status.counters.orderFailures += 1;
    this.pushEvent({
      at: new Date().toISOString(),
      type: "order",
      status: "failed",
      tokenId: signal.tokenId,
      side: signal.side,
      size: signal.size,
      price: signal.price,
      details,
    });
  }

  recordInfo(type: RuntimeEvent["type"], details: string): void {
    this.pushEvent({
      at: new Date().toISOString(),
      type,
      status: "info",
      details,
    });
  }

  private pushEvent(event: RuntimeEvent): void {
    this.status.recentEvents.unshift(event);
    if (this.status.recentEvents.length > 200) {
      this.status.recentEvents = this.status.recentEvents.slice(0, 200);
    }
    this.flush();
  }

  private flush(): void {
    this.status.updatedAt = new Date().toISOString();
    const dir = path.dirname(this.statusPath);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(this.statusPath, JSON.stringify(this.status, null, 2));
  }
}
