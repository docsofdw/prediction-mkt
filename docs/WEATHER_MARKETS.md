# Weather Market Trading System

**Created:** 2026-02-24
**Status:** Active Development

---

## Overview

This system identifies mispricings in Polymarket weather and natural phenomena markets by comparing market prices against statistical models derived from authoritative public data sources.

Unlike BTC markets (which proved efficient), weather markets have a key advantage: **verifiable, public data sources** that provide ground truth for probability estimation.

---

## How It Works

### Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                     Weather Market Scanner                       │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│  ┌──────────────┐    ┌──────────────┐    ┌──────────────┐      │
│  │  Polymarket  │    │     USGS     │    │     NWS      │      │
│  │     CLI      │    │  Earthquake  │    │   Weather    │      │
│  │              │    │     API      │    │     API      │      │
│  └──────┬───────┘    └──────┬───────┘    └──────┬───────┘      │
│         │                   │                   │               │
│         ▼                   ▼                   ▼               │
│  ┌──────────────────────────────────────────────────────┐      │
│  │                   Analyzers                           │      │
│  │  ┌────────────────┐    ┌────────────────────┐        │      │
│  │  │   Earthquake   │    │    Temperature     │        │      │
│  │  │   (Poisson)    │    │  (Normal + Error)  │        │      │
│  │  └────────────────┘    └────────────────────┘        │      │
│  └──────────────────────────────────────────────────────┘      │
│                            │                                    │
│                            ▼                                    │
│  ┌──────────────────────────────────────────────────────┐      │
│  │              Opportunity Detection                    │      │
│  │                                                       │      │
│  │   Model Probability vs Market Price = Edge            │      │
│  │   If |Edge| > 15% → Generate Trade Signal             │      │
│  └──────────────────────────────────────────────────────┘      │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
```

### Data Sources

| Source | Data | Update Frequency | Reliability |
|--------|------|------------------|-------------|
| USGS FDSNWS | Earthquake counts, magnitudes, locations | Real-time | Very High |
| NWS/NOAA | Temperature forecasts for US cities | Hourly | High |
| Polymarket CLI | Market prices, order books | Real-time | High |

---

## Earthquake Market Analysis

### Model: Poisson Distribution

Earthquakes of magnitude 7.0+ follow a Poisson process with historically stable rates.

**Historical Data (7.0+ earthquakes per year):**
- 2020: 9
- 2021: 19
- 2022: 11
- 2023: 19
- 2024: 10
- 2025: 16
- **Average: ~14/year**

**First Half (Jan-Jun) Data:**
- 2023: 14
- 2024: 4
- 2025: 5
- **Average: ~7.7/half-year**

### Probability Calculation

For a market like "8 or more earthquakes by June 30":

```
Current count (as of Feb 24): 1
Days remaining until June 30: ~125
Historical rate for period: ~7.7 total

Need: 7 more earthquakes
Expected additional (Poisson λ): 7.7 × (125/181) ≈ 5.3

P(X ≥ 7 | λ = 5.3) = 1 - P(X ≤ 6 | λ = 5.3) ≈ 31%
```

### Current Opportunity (Feb 24, 2026)

| Metric | Value |
|--------|-------|
| Market Price | 58c |
| Model Probability | 31% |
| Edge | -27% |
| Recommendation | **SELL YES** |
| Confidence | HIGH |

**Expected Value:**
- If model is correct: Sell at 58c, expected payout 31c → profit 27c per share
- Risk: If 8+ earthquakes occur, lose 42c per share
- E[Return] = 0.69 × 0.58 - 0.31 × 0.42 = **+27c per $1 risked**

---

## Temperature Market Analysis

### Model: Normal Distribution with Forecast Error

NWS forecasts have known error distributions that increase with forecast horizon.

**Forecast Error (RMSE in °F):**

| Days Out | Error (σ) |
|----------|-----------|
| 0 (today) | ±2.0°F |
| 1 | ±2.5°F |
| 2 | ±3.0°F |
| 3 | ±3.5°F |
| 5 | ±4.5°F |
| 7 | ±5.5°F |

### Probability Calculation

For a market like "Miami high between 70-71°F on Feb 25":

```
NWS Forecast: 72°F
Forecast Error (1 day out): σ = 2.5°F

P(70 ≤ X ≤ 71) where X ~ N(72, 2.5²)
= Φ((71.5 - 72)/2.5) - Φ((69.5 - 72)/2.5)
= Φ(-0.2) - Φ(-1.0)
= 0.42 - 0.16
≈ 26%
```

### Current Opportunities (Feb 24, 2026)

| Market | Price | Model | Edge | Action |
|--------|-------|-------|------|--------|
| Miami 76°F+ Feb 25 | 25.5c | 4% | -21% | SELL |
| Miami 70-71°F Feb 25 | 10.5c | 30% | +19% | BUY |
| Miami 80-81°F Feb 26 | 30.5c | 12% | -18% | SELL |
| Miami 76-77°F Feb 26 | 11c | 31% | +19% | BUY |

---

## Commands

```bash
# Scan all weather markets (earthquake + temperature)
npm run weather:scan

# Scan earthquake markets only
npm run weather:earthquake

# Scan temperature markets only
npm run weather:temperature

# Adjust minimum edge threshold (default 15%)
npm run weather:scan -- --min-edge=0.20
```

---

## Trading Execution

### Setup (One-Time)

```bash
# Install Polymarket CLI
brew tap Polymarket/polymarket-cli https://github.com/Polymarket/polymarket-cli
brew install polymarket

# Set up wallet
polymarket setup

# Or import existing key
polymarket wallet import 0xYOUR_PRIVATE_KEY
```

### Placing Trades

```bash
# Get market details
polymarket markets get "will-there-be-8-or-more-earthquakes"

# View order book
polymarket clob book <TOKEN_ID>

# Place a limit order to SELL YES at 55c
polymarket clob create-order \
  --token-id <YES_TOKEN_ID> \
  --side SELL \
  --price 0.55 \
  --size 100

# Or place a market order
polymarket clob market-order \
  --token-id <YES_TOKEN_ID> \
  --side SELL \
  --amount 50
```

### Position Management

```bash
# Check open orders
polymarket clob orders

# Check positions
polymarket clob positions

# Cancel an order
polymarket clob cancel <ORDER_ID>

# Cancel all orders
polymarket clob cancel-all
```

---

## Potential Improvements

### 1. Enhanced Earthquake Model

**Current Limitation:** Simple Poisson assumes constant rate.

**Improvements:**
- **Clustering adjustment:** Earthquakes cluster in time. After a major quake, probability of another increases short-term.
- **Regional analysis:** Track by tectonic region for more granular predictions.
- **Magnitude distribution:** Model magnitude 7.0-7.9 vs 8.0+ separately.

```typescript
// Example: Add clustering factor
const clusteringFactor = recentQuakeCount > 0 ? 1.2 : 1.0;
const adjustedLambda = baseLambda * clusteringFactor;
```

### 2. Better Temperature Forecasting

**Current Limitation:** Uses single NWS point forecast.

**Improvements:**
- **Ensemble forecasts:** Use GFS/ECMWF ensemble spread for better uncertainty.
- **Historical bias correction:** Adjust for systematic NWS over/under-prediction.
- **Multiple sources:** Combine NWS, AccuWeather, Weather Underground for consensus.

```typescript
// Example: Multi-source consensus
const forecasts = await Promise.all([
  fetchNwsForecast(city),
  fetchAccuWeather(city),
  fetchWeatherUnderground(city),
]);
const consensusForecast = average(forecasts);
const uncertainty = stddev(forecasts);
```

### 3. Automated Position Sizing

**Current Limitation:** Manual position sizing.

**Improvements:**
- **Kelly Criterion:** Optimal bet sizing based on edge and bankroll.
- **Correlation tracking:** Reduce size when multiple bets are correlated.
- **Max exposure limits:** Cap total exposure per market type.

```typescript
// Kelly Criterion
const edge = modelProb - marketPrice;
const odds = (1 - marketPrice) / marketPrice;
const kellyFraction = edge / (1 - marketPrice);
const positionSize = bankroll * kellyFraction * 0.25; // Quarter Kelly for safety
```

### 4. Real-Time Monitoring

**Current Limitation:** Manual scanning.

**Improvements:**
- **Continuous scanner:** Run every 5 minutes, alert on new opportunities.
- **Price alerts:** Notify when market moves into/out of opportunity zone.
- **Telegram integration:** Push notifications for high-confidence signals.

```typescript
// Example: Telegram alert
if (analysis.confidence === "HIGH" && Math.abs(analysis.edge) > 0.20) {
  await sendTelegramAlert(
    `🎯 ${analysis.recommendation} opportunity!\n` +
    `Market: ${analysis.market.question}\n` +
    `Edge: ${(analysis.edge * 100).toFixed(1)}%`
  );
}
```

### 5. Backtesting Framework

**Current Limitation:** No historical validation.

**Improvements:**
- **Historical market data:** Scrape past Polymarket weather markets.
- **Simulated P&L:** Calculate what returns would have been.
- **Model calibration:** Tune error distributions based on actual outcomes.

### 6. Additional Market Types

**Current:** Earthquakes, US temperatures.

**Expansion:**
- **International temperatures:** Add OpenWeatherMap for non-US cities.
- **Precipitation markets:** Use NWS probability of precipitation.
- **Hurricane markets:** Integrate NHC forecast cones.
- **Arctic ice extent:** Compare to NSIDC data.

### 7. Order Book Analysis

**Current Limitation:** Only looks at best bid/ask.

**Improvements:**
- **Depth analysis:** Check if there's enough liquidity to execute.
- **Spread tracking:** Wider spreads = higher execution cost.
- **Impact estimation:** Model price impact of large orders.

---

## Next Steps

### Immediate (This Week)

1. **Paper Trade the Earthquake Market**
   - Track the "8+ earthquakes by June 30" market daily
   - Record model probability vs market price
   - Simulate what P&L would be with $100 position

2. **Validate Temperature Model**
   - For next 7 days, record model predictions vs actual outcomes
   - Calculate model accuracy (Brier score)
   - Adjust error parameters if needed

3. **Add Telegram Alerts**
   - Integrate existing Telegram bot
   - Push alerts for HIGH confidence opportunities
   - Daily summary of open opportunities

### Short-Term (Next 2 Weeks)

4. **Implement Position Sizing**
   - Add Kelly Criterion calculation
   - Set max exposure per market ($50 initially)
   - Track correlation between bets

5. **Build Continuous Scanner**
   - Run scanner every 15 minutes on VPS
   - Log all opportunities to SQLite
   - Generate daily report

6. **First Live Trade**
   - Start with smallest possible size ($10-20)
   - Choose highest-confidence earthquake opportunity
   - Document execution and slippage

### Medium-Term (Next Month)

7. **Expand Market Coverage**
   - Add precipitation markets
   - Add international temperature (via OpenWeatherMap API)
   - Add hurricane/storm markets during season

8. **Backtest Historical Performance**
   - Scrape historical Polymarket weather data
   - Simulate model performance
   - Calculate Sharpe ratio

9. **Automate Trading**
   - Build order placement module
   - Implement position monitoring
   - Add stop-loss logic

---

## Risk Management

### Known Risks

| Risk | Mitigation |
|------|------------|
| Model error | Start small, validate before scaling |
| Black swan events | Cap max loss per position |
| Liquidity | Check depth before trading |
| Correlation | Limit exposure to correlated events |
| API downtime | Multiple data source fallbacks |

### Position Limits

| Limit | Value |
|-------|-------|
| Max per market | $50 |
| Max earthquake exposure | $200 |
| Max temperature exposure | $100 |
| Max total exposure | $500 |

### Stop Criteria

- Pause trading if model accuracy < 60% over 20 markets
- Pause if cumulative loss > $100
- Review and adjust if edge < 10% average

---

## Files

```
src/markets/weather/
├── analyzers/
│   ├── earthquake.ts    # Poisson model + USGS integration
│   └── temperature.ts   # Normal distribution + NWS integration
└── scripts/
    └── scan-weather-markets.ts  # Main scanner CLI
```

---

## Changelog

- **2026-02-24:** Initial release with earthquake and temperature analyzers
