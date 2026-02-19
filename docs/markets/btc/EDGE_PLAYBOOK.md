# Polymarket BTC Edge Playbook

This document simplifies the system into one operating loop:

1. `Scan` inefficiencies in live BTC markets.
2. `Build` ranked strategy ideas from backtests.
3. `Execute` with meta-allocator + risk guardrails.

## Official API Surfaces To Exploit

Primary references:
- CLOB overview: https://docs.polymarket.com/developers/CLOB/introduction
- CLOB endpoint summary: https://docs.polymarket.com/developers/CLOB/endpoints
- `GET /book` (order book by token): https://docs.polymarket.com/api-reference/orderbook/get-order-book-summary
- RTDS overview: https://docs.polymarket.com/developers/CLOB/websocket/overview
- Data API overview: https://docs.polymarket.com/developers/data-api/overview
- Gamma markets endpoint: https://docs.polymarket.com/developers/gamma-markets-api/get-markets

## Edge Classes for BTC Markets

### 1. Complete-Set Mispricing (Single Market)
Target: binary markets with YES and NO tokens.

Detector:
- Pull both token books.
- Compute `ask_yes + ask_no`.
- If significantly below `1.00`, complete-set buy can be positive EV after slippage/risk buffer.

Endpoint usage:
- Gamma `/markets`: discover token pairs.
- CLOB `/book` or `/books`: fetch best bid/ask for each token.

### 2. Strike Monotonicity Violations (Cross-Market)
For same expiry and same direction:
- `P(BTC > 95k)` should generally be >= `P(BTC > 100k)`.
- Violations indicate structural inconsistency.

Detector:
- Parse strike from market questions.
- Compare midpoint probabilities from books across strikes.
- Flag inversions above threshold.

### 3. Time-Monotonic "Hit By" Violations
For "hit/reach by date" markets at same strike:
- Probability by earlier date should be <= probability by later date.

Detector:
- Parse strike + deadline from question text.
- Group by strike and compare earlier/later yes midpoints.

### 4. Spread/Depth Micro-Inefficiencies
Even without hard arbitrage, weak books can provide edge:
- Wide spread with one-sided depth.
- Temporary stale quotes around external BTC moves.

Endpoint usage:
- CLOB books + RTDS price/trade streams.

## Revised System Structure

### Stage A: Scan (fast)
- Script: `npm run scan:btc:inefficiencies`
- Output: `backtests/btc-inefficiencies-latest.json`
- Frequency: every 15-60 min.

### Stage B: Build (research)
- Script: `npm run ideas:build`
- Output: `backtests/idea-factory-latest.json`
- Frequency: hourly/daily based on compute budget.

### Stage C: Execute (live/paper)
- Runtime: `npm run dev` with `STRATEGY_MODE=meta-allocator`
- Guardrails: gross/per-market/order notional + daily loss kill-switch.
- Telemetry: `backtests/runtime-status.json`.

## Dashboard Workflow

### Core (minimal)
Use only these actions:
1. `One-Click Launch` (`scan -> ideas -> bot`)
2. `Start/Stop Autopilot`
3. `Stop All`

### Advanced (optional)
Use when debugging:
- scanner logs
- ideas logs
- bot logs
- diagnostics/event table

## Practical Notes

- Use slippage/latency buffers when flagging arbitrage to avoid false positives.
- Treat all scanner results as candidates; route through risk limits before execution.
- For US operators, verify legal/compliance constraints before any live trading.
