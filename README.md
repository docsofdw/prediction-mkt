# polymarket-trader

Minimal TypeScript scaffolding for trading Polymarket prediction markets via their CLOB API, focused on **weather** and **bitcoin** markets.

## What This Is

A lightweight, npm-based codebase that connects to Polymarket's three API layers:

| Layer | URL | Auth | Purpose |
|-------|-----|------|---------|
| **Gamma API** | `gamma-api.polymarket.com` | None | Market discovery, search, metadata |
| **CLOB API** | `clob.polymarket.com` | API key + wallet | Order placement, orderbook, trading |
| **RTDS WebSocket** | `ws-live-data.polymarket.com` | Optional | Real-time price and trade streams |

The CLOB (Central Limit Order Book) is hybrid-decentralized: orders are matched off-chain by the operator, but settlement happens on-chain on Polygon via signed order messages. Your wallet remains in control of your funds at all times.

## Project Structure

```
polymarket-trader/
├── src/
│   ├── index.ts                    # Main entrypoint — wires everything together
│   ├── types/
│   │   └── index.ts                # All TypeScript interfaces
│   ├── utils/
│   │   ├── config.ts               # Env var loader
│   │   └── logger.ts               # Winston logger
│   ├── services/
│   │   ├── market-discovery.ts     # Gamma API client (find markets)
│   │   ├── trading-client.ts       # CLOB client wrapper (place orders)
│   │   └── realtime-feed.ts        # WebSocket price/trade streams
│   ├── strategies/
│   │   └── example-strategy.ts     # Placeholder strategy interface
│   └── scripts/
│       ├── discover-markets.ts     # Standalone market scanner
│       └── derive-keys.ts          # One-time API key derivation
├── .env.example                    # Template for your secrets
├── .gitignore
├── tsconfig.json
└── package.json
```

## Quick Start

### 1. Install dependencies

```bash
npm install
```

### 2. Configure environment

```bash
cp .env.example .env
```

Edit `.env` with your wallet private key and funder address. Everything else has sensible defaults.

### 3. Discover markets (no wallet needed)

Browse live bitcoin and weather markets without any API keys:

```bash
npm run discover
```

This queries the Gamma API (public, no auth) and prints active markets with their token IDs, prices, and volumes.

### 4. Derive API credentials

Once you have your private key set in `.env`:

```bash
npm run derive:keys
```

This calls `createOrDeriveApiKey()` on the CLOB and prints your `POLY_API_KEY`, `POLY_API_SECRET`, and `POLY_PASSPHRASE`. Paste them into `.env`.

### 5. Run the bot

```bash
npm run dev      # development (ts-node)
npm run build    # compile TypeScript
npm start        # run compiled JS
```

### 6. Run the local dashboard

```bash
npm run dashboard
```

Then open `http://localhost:8787`.

Dashboard env vars:
- `DASHBOARD_HOST` (default `127.0.0.1`)
- `DASHBOARD_PORT` (default `8787`)
- `RUNTIME_STATUS_PATH` (default `backtests/runtime-status.json`)
- `DASHBOARD_BOT_CMD` (default `npm run dev`)
- `DASHBOARD_IDEAS_CMD` (default `npm run ideas:build`)
- `DASHBOARD_SCAN_CMD` (default `npm run scan:btc:inefficiencies`)
- `DASHBOARD_AUTOPILOT_INTERVAL_MS` (default `3600000`)

The dashboard shows:
- Runtime mode + strategy + wallet/funder mask
- Risk guard state (equity, daily PnL, gross exposure, kill-switch)
- Signal counters (seen/executed/blocked/failed)
- Strategy diagnostics (meta-allocator token plans + selections)
- Idea-factory portfolio allocation
- Recent execution events
- Process controls to run ideas/start-stop bot from UI
- BTC inefficiency scanner control from UI
- Two workflows:
  - `Simple`: one-click `scan -> ideas -> bot`
  - `Autopilot`: recurring `scan -> ideas` cycle + keep-bot-alive mode
- Core vs Advanced view toggle:
  - Core: minimal controls + risk/system status
  - Advanced: diagnostics + logs + execution events
- Validation controls:
  - Phase 1 monitor (continuous 5m logging)
  - Phase 2 ingest
  - Run all thesis reports
  - Run week-1/week-2 soft checkpoint reports

Execution modes:
- `EXECUTION_MODE=paper` (default): runs strategy and simulates fills/PnL
- `EXECUTION_MODE=live`: sends real orders to CLOB
- `STRATEGY_MODE=dual-live` (default): legacy BTC momentum + weather mean-reversion
- `STRATEGY_MODE=meta-allocator`: regime-aware allocator driven by `backtests/idea-factory-latest.json`

Meta-allocator env vars:
- `IDEA_FACTORY_PATH` (default `backtests/idea-factory-latest.json`)
- `META_MIN_BARS` (min local bars before signals)
- `META_RELOAD_MS` (how often to reload idea file)
- `META_SIGNAL_COOLDOWN_MS` (minimum gap between signals per token)

Runtime risk guardrails:
- `RISK_MAX_GROSS_EXPOSURE_NOTIONAL` (block trades that exceed total gross notional)
- `RISK_MAX_PER_MARKET_NOTIONAL` (block trades that exceed one-token notional cap)
- `RISK_MAX_ORDER_NOTIONAL` (block oversized single orders)
- `RISK_MAX_DAILY_LOSS` (UTC day kill-switch; blocks all new orders after breach)
- `RISK_SHADOW_INITIAL_EQUITY` (starting equity for guardrail shadow book)

Validation protocol defaults:
- `EXECUTION_MODE=paper` by default; live trading requires manual arming via env.
- Validation data storage is SQLite (`VALIDATION_DB_PATH`).
- Structural arb net estimate uses conservative `EXECUTION_HAIRCUT=0.40` by default.
- Week-1/Week-2 checkpoints are soft-enforced (reports + warnings, no auto-stop).

## Trading Diagnostics

If order placement fails, run:

```bash
npm run diagnose:trading
```

Optional env vars:
- `DIAG_TOKEN_ID` (token to inspect orderbook/allowance)
- `DIAG_PLACE_ORDER=true` (attempt tiny post-only test order)
- `DIAG_PRICE` (default `0.01`)
- `DIAG_SIZE` (default `1`)

## Setup Validation

Check whether your env is ready:

```bash
npm run setup:check
```

This verifies:
- Wallet setup (`PRIVATE_KEY`, `FUNDER_ADDRESS`)
- Trading setup (`POLY_API_KEY`, `POLY_API_SECRET`, `POLY_PASSPHRASE`)

## Backtesting (BTC + Weather)

Run dual-strategy backtests without trading credentials:

```bash
npm run backtest
```

What it does:
- Discovers active BTC and weather markets
- Selects top markets by volume
- Pulls historical prices from CLOB `/prices-history`
- Runs walk-forward analysis (train/test split) per market
- Runs parameter sweep and auto-selects best train params:
  - `bitcoin-momentum` (short-vs-long moving average crossover)
  - `weather-mean-reversion` (z-score fade + mean reversion exit)
- Applies risk controls during simulation (stop loss, take profit, trade throttling)
- Writes a JSON report to `backtests/latest.json`

Backtest tuning vars in `.env`:
- `BACKTEST_INTERVAL` (`max | 1w | 1d | 6h | 1h`)
- `BACKTEST_FIDELITY` (minutes between bars)
- `BACKTEST_MAX_MARKETS`
- `BACKTEST_MIN_BARS`
- `BACKTEST_TRAIN_SPLIT` (e.g. `0.7`)
- `RISK_STOP_LOSS`
- `RISK_TAKE_PROFIT`
- `RISK_MIN_BARS_BETWEEN_TRADES`
- `RISK_MAX_TRADES`

## Idea Factory (Multi-Algo Research Pipeline)

Generate and rank a large library of high-timeframe BTC + weather strategies with robust walk-forward validation:

```bash
npm run ideas:build
```

Scan BTC markets for inefficiencies and arbitrage-style dislocations:

```bash
npm run scan:btc:inefficiencies
```

What it does:
- Discovers top-volume active BTC and weather markets
- Pulls historical bars from CLOB `/prices-history`
- Builds large candidate universes per market:
  - BTC: momentum, breakout, regime-trend
  - Weather: mean-reversion, range-reversion, drift-trend
- Runs expanding-window multi-fold walk-forward tests
- Scores candidates with robustness-focused metrics:
  - out-of-sample PnL, Sharpe, Sortino, drawdown, consistency, overfit penalty
- Persists cross-run pattern memory to `backtests/idea-memory.json`
- Writes latest ranked playbook to `backtests/idea-factory-latest.json`

Idea-factory tuning vars in `.env`:
- `IDEA_INTERVAL` (`max | 1w | 1d | 6h | 1h`)
- `IDEA_FIDELITY` (bar spacing in minutes)
- `IDEA_MAX_MARKETS`
- `IDEA_MIN_BARS`
- `IDEA_MIN_TRAIN_BARS`
- `IDEA_FOLD_TEST_BARS`
- `IDEA_FOLD_STEP_BARS`
- `IDEA_MAX_FOLDS`
- `IDEA_MAX_CANDIDATES_PER_FAMILY`
- `IDEA_TOP_PER_MARKET`

BTC scanner tuning vars:
- `BTC_SCAN_MAX_EVENTS`
- `BTC_SCAN_MAX_MARKETS`
- `BTC_SCAN_MIN_EDGE`
- `BTC_SCAN_STRUCTURAL_THRESHOLD`
- `BTC_SCAN_SLIPPAGE_BUFFER`

Validation protocol commands:
- `npm run validation:init`
- `npm run phase1:monitor`
- `npm run phase1:report`
- `npm run phase2:ingest`
- `npm run phase2:report`
- `npm run phase3:report`
- `npm run validation:checkpoints`

Detailed workflow and governance: `docs/TRADE_IDEA_FACTORY.md`
BTC API edge playbook: `docs/POLYMARKET_BTC_EDGE_PLAYBOOK.md`
Validation protocol implementation: `docs/VALIDATION_PROTOCOL_IMPLEMENTATION.md`

## Architecture

### Market Discovery (`MarketDiscovery`)

Wraps the Gamma API to search for markets by keyword. Pre-built methods for bitcoin and weather:

- `discoverBitcoinMarkets()` — searches "bitcoin", "btc", "crypto"
- `discoverWeatherMarkets()` — searches "weather", "hurricane", "temperature", "rainfall", "storm", "climate"
- `searchEvents(query)` — generic full-text search
- `snapshotMarkets(event)` — extracts price snapshots with tokenId, bid/ask, spread, volume

The Gamma API requires no authentication and returns market metadata including `clobTokenIds` (needed for trading) and `condition_id` (the on-chain market identifier).

### Trading Client (`TradingClient`)

Wraps `@polymarket/clob-client` with config-driven initialization:

- **Auto-derives API credentials** if not present in `.env`
- `getOrderbook(tokenId)` — fetch current orderbook
- `getMidpoint(tokenId)` — get mid price
- `placeLimitOrder({ tokenId, side, price, size })` — place a GTC limit order
- `cancelAll()` — cancel all open orders
- `getClient()` — escape hatch to the raw `ClobClient` for anything else

Authentication uses two levels:
- **L1** (wallet signature): for deriving API keys
- **L2** (HMAC headers via API key/secret/passphrase): for order management

Signature type `0` = EOA/browser wallet, `1` = Magic/email login.

### Real-Time Feed (`RealtimeFeed`)

Wraps `@polymarket/real-time-data-client` for WebSocket streaming:

- `subscribeTrades()` — live trade activity across all markets
- `subscribePrices(tokenIds)` — price updates for specific assets
- `onTrade` / `onPrice` — callback hooks for your strategy
- Auto-ping keep-alive every 5 seconds

### Strategy Interface

All strategies implement the `Strategy` interface:

```typescript
interface Strategy {
  name: string;
  description: string;
  initialize(): Promise<void>;
  evaluate(snapshot: MarketSnapshot): Promise<TradeSignal[]>;
  teardown(): Promise<void>;
}
```

The `ExampleStrategy` is a no-op placeholder that logs market data. Replace `evaluate()` with your actual trading logic. Return `TradeSignal[]` to place orders, or `[]` to pass.

## Key Concepts

### Token IDs vs Condition IDs

- **`condition_id`** — identifies a market (maps to an on-chain conditional token). One event can have multiple markets.
- **`clobTokenIds`** — the ERC-1155 token IDs you actually trade. A binary market has two token IDs (YES outcome and NO outcome). These are what you pass to `placeLimitOrder()`.

### Order Types

Currently the scaffolding uses GTC (Good Till Cancelled) limit orders. The SDK also supports FOK (Fill or Kill) and other types via `OrderType`.

### Fees

Polymarket currently charges 0% maker and taker fees.

## npm Packages Used

| Package | Version | Purpose |
|---------|---------|---------|
| `@polymarket/clob-client` | ^5.2.3 | Official CLOB trading SDK |
| `@polymarket/real-time-data-client` | ^1.4.0 | Official WebSocket streaming |
| `ethers` | 5.8.0 | Wallet/signing (required by clob-client) |
| `axios` | ^1.x | HTTP for Gamma API |
| `dotenv` | ^17.x | Environment variable loading |
| `winston` | ^3.x | Structured logging |

## What's Left for You

This is scaffolding only. To go live, you'll need to:

1. **Add your keys** — private key, funder address, and derived API creds in `.env`
2. **Fund your wallet** — send USDC to your funder address on Polygon
3. **Write strategies** — implement the `Strategy` interface with your actual algo logic
4. **Add risk management** — position sizing, max exposure, stop losses
5. **Add persistence** — trade log, PnL tracking, state recovery
6. **Consider Rust** — for microsecond-level latency, Polymarket also offers `rs-clob-client`

## Useful Links

- [Polymarket CLOB Docs](https://docs.polymarket.com/developers/CLOB/introduction)
- [CLOB Quickstart](https://docs.polymarket.com/developers/CLOB/quickstart)
- [Gamma API](https://gamma-api.polymarket.com)
- [clob-client GitHub](https://github.com/Polymarket/clob-client)
- [real-time-data-client GitHub](https://github.com/Polymarket/real-time-data-client)
- [Polymarket SDK Docs](https://docs.polymarket.us/sdks/introduction)
