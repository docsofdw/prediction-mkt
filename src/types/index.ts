// ─── Gamma API Types (Market Discovery) ──────────────────

export interface GammaMarket {
  id: string;
  condition_id: string;
  question: string;
  slug: string;
  active: boolean;
  closed: boolean;
  outcomes: string[];
  outcomePrices: string[] | string;
  clobTokenIds: string[] | string;
  volume: string;
  liquidity: string;
  startDate: string;
  endDate: string;
  description: string;
  tags: GammaTag[];
}

export interface GammaTag {
  id: number;
  label: string;
  slug: string;
}

export interface GammaEvent {
  id: string;
  slug: string;
  title: string;
  description: string;
  active: boolean;
  closed: boolean;
  markets: GammaMarket[];
  tags: GammaTag[];
}

export interface GammaSearchResponse {
  data: GammaEvent[];
  count: number;
}

// ─── Trading Types ───────────────────────────────────────

export interface MarketSnapshot {
  tokenId: string;
  conditionId: string;
  question: string;
  bestBid: number;
  bestAsk: number;
  spread: number;
  volume: number;
  lastPrice: number;
  timestamp: Date;
}

export interface TradeSignal {
  tokenId: string;
  side: "BUY" | "SELL";
  price: number;
  size: number;
  reason: string;
}

// ─── Strategy Interface ──────────────────────────────────

export interface Strategy {
  name: string;
  description: string;

  /** Called once when the strategy is loaded */
  initialize(): Promise<void>;

  /** Evaluate market data and return trade signals (if any) */
  evaluate(snapshot: MarketSnapshot): Promise<TradeSignal[]>;

  /** Called on shutdown for cleanup */
  teardown(): Promise<void>;

  /** Optional diagnostics for local observability/dashboard */
  getDiagnostics?(): unknown;
}

// ─── Config Types ────────────────────────────────────────

export interface AppConfig {
  privateKey: string;
  funderAddress: string;
  chainId: number;
  signatureType: number;
  executionMode: "paper" | "live";
  paperInitialCash: number;
  defaultTradeSize: number;
  strategyMode: "dual-live" | "meta-allocator";
  ideaFactoryPath: string;
  metaMinBars: number;
  metaReloadMs: number;
  metaSignalCooldownMs: number;
  riskMaxGrossExposureNotional?: number;
  riskMaxPerMarketNotional?: number;
  riskMaxOrderNotional?: number;
  riskMaxDailyLoss?: number;
  riskShadowInitialEquity: number;
  clobHost: string;
  gammaHost: string;
  dataApiHost: string;
  logLevel: string;
  apiKey?: string;
  apiSecret?: string;
  passphrase?: string;
}
