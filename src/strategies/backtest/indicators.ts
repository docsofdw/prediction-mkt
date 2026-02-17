export function avg(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

export function std(values: number[]): number {
  if (values.length < 2) return 0;
  const mean = avg(values);
  const variance = values.reduce((a, v) => a + (v - mean) ** 2, 0) / (values.length - 1);
  return Math.sqrt(variance);
}

export function highest(values: number[]): number {
  return values.reduce((max, v) => (v > max ? v : max), Number.NEGATIVE_INFINITY);
}

export function lowest(values: number[]): number {
  return values.reduce((min, v) => (v < min ? v : min), Number.POSITIVE_INFINITY);
}

export function rsi(values: number[], period: number): number {
  if (values.length < period + 1) return 50;
  let gains = 0;
  let losses = 0;

  for (let i = values.length - period; i < values.length; i++) {
    const diff = values[i] - values[i - 1];
    if (diff > 0) gains += diff;
    if (diff < 0) losses += Math.abs(diff);
  }

  const avgGain = gains / period;
  const avgLoss = losses / period;
  if (avgLoss === 0) return 100;

  const rs = avgGain / avgLoss;
  return 100 - (100 / (1 + rs));
}

export function slope(values: number[]): number {
  const n = values.length;
  if (n < 2) return 0;

  const meanX = (n - 1) / 2;
  const meanY = avg(values);

  let num = 0;
  let den = 0;
  for (let i = 0; i < n; i++) {
    const dx = i - meanX;
    num += dx * (values[i] - meanY);
    den += dx * dx;
  }

  if (den === 0) return 0;
  return num / den;
}

/**
 * Compute True Range for a single bar given current high/low/close and previous close
 */
export function trueRange(high: number, low: number, prevClose: number): number {
  return Math.max(high - low, Math.abs(high - prevClose), Math.abs(low - prevClose));
}

/**
 * Compute Average True Range (ATR) over a period
 * Uses price array assuming each value is the close price, approximating high/low from price changes
 */
export function atr(prices: number[], period: number): number {
  if (prices.length < period + 1) return 0;

  let sum = 0;
  for (let i = prices.length - period; i < prices.length; i++) {
    const curr = prices[i];
    const prev = prices[i - 1];
    // Approximate TR using price changes (since we only have close prices)
    const tr = Math.abs(curr - prev);
    sum += tr;
  }

  return sum / period;
}

/**
 * Compute volatility (standard deviation of returns) over a window
 */
export function volatility(prices: number[], period: number): number {
  if (prices.length < period + 1) return 0;

  const returns: number[] = [];
  for (let i = prices.length - period; i < prices.length; i++) {
    const ret = (prices[i] - prices[i - 1]) / prices[i - 1];
    returns.push(ret);
  }

  return std(returns);
}

/**
 * Compute Average Directional Index (ADX) over a period
 * ADX measures trend strength (not direction). Values > 20-25 indicate a trending market.
 *
 * Note: This is an approximation using close prices only. For true ADX, you need OHLC data.
 */
export function adx(prices: number[], period: number): number {
  if (prices.length < period * 2) return 0;

  const dmPlus: number[] = [];
  const dmMinus: number[] = [];
  const trValues: number[] = [];

  // Calculate DM+ and DM- using price changes as approximation
  for (let i = 1; i < prices.length; i++) {
    const curr = prices[i];
    const prev = prices[i - 1];
    const change = curr - prev;

    // Approximate directional movement
    if (change > 0) {
      dmPlus.push(change);
      dmMinus.push(0);
    } else {
      dmPlus.push(0);
      dmMinus.push(Math.abs(change));
    }
    trValues.push(Math.abs(change)); // Simplified TR
  }

  if (dmPlus.length < period) return 0;

  // Calculate smoothed DM+ and DM- using Wilder's smoothing
  let smoothDmPlus = avg(dmPlus.slice(0, period));
  let smoothDmMinus = avg(dmMinus.slice(0, period));
  let smoothTr = avg(trValues.slice(0, period));

  const dxValues: number[] = [];

  for (let i = period; i < dmPlus.length; i++) {
    // Wilder's smoothing
    smoothDmPlus = smoothDmPlus - smoothDmPlus / period + dmPlus[i];
    smoothDmMinus = smoothDmMinus - smoothDmMinus / period + dmMinus[i];
    smoothTr = smoothTr - smoothTr / period + trValues[i];

    if (smoothTr === 0) continue;

    const diPlus = (smoothDmPlus / smoothTr) * 100;
    const diMinus = (smoothDmMinus / smoothTr) * 100;
    const diSum = diPlus + diMinus;

    if (diSum === 0) continue;

    const dx = (Math.abs(diPlus - diMinus) / diSum) * 100;
    dxValues.push(dx);
  }

  if (dxValues.length < period) return dxValues.length > 0 ? avg(dxValues) : 0;

  // ADX is the smoothed average of DX values
  return avg(dxValues.slice(-period));
}

/**
 * Exponentially Weighted Moving Average
 */
export function ewma(values: number[], alpha: number): number {
  if (values.length === 0) return 0;

  let result = values[0];
  for (let i = 1; i < values.length; i++) {
    result = alpha * values[i] + (1 - alpha) * result;
  }
  return result;
}

/**
 * Exponentially Weighted Standard Deviation
 */
export function ewmStd(values: number[], alpha: number): number {
  if (values.length < 2) return 0;

  const mean = ewma(values, alpha);
  let variance = 0;
  let weight = 1;
  let weightSum = 0;

  for (let i = values.length - 1; i >= 0; i--) {
    variance += weight * (values[i] - mean) ** 2;
    weightSum += weight;
    weight *= (1 - alpha);
  }

  return Math.sqrt(variance / weightSum);
}

/**
 * Compute half-life of mean reversion using Ornstein-Uhlenbeck estimation
 * Returns the number of periods for the price to revert halfway to the mean.
 * A lower half-life indicates stronger mean reversion.
 * Returns -1 if not mean-reverting (positive autocorrelation).
 */
export function halfLife(prices: number[]): number {
  if (prices.length < 10) return -1;

  // Compute lagged price differences: y_t = price_t - price_{t-1}
  // Regress y_t on price_{t-1}
  const y: number[] = [];
  const x: number[] = [];

  for (let i = 1; i < prices.length; i++) {
    y.push(prices[i] - prices[i - 1]);
    x.push(prices[i - 1]);
  }

  const n = y.length;
  const meanX = avg(x);
  const meanY = avg(y);

  let num = 0;
  let den = 0;
  for (let i = 0; i < n; i++) {
    num += (x[i] - meanX) * (y[i] - meanY);
    den += (x[i] - meanX) ** 2;
  }

  if (den === 0) return -1;

  const beta = num / den; // Speed of mean reversion

  // Half-life = -ln(2) / ln(1 + beta)
  // For small beta: half-life ≈ -ln(2) / beta
  if (beta >= 0) return -1; // Not mean-reverting

  const hl = -Math.log(2) / beta;
  return hl > 0 ? hl : -1;
}
