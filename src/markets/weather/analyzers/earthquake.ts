/**
 * Earthquake Market Analyzer
 *
 * Compares Polymarket earthquake predictions against USGS historical data
 * to find mispricings using Poisson probability models.
 */

import axios from "axios";

const USGS_API = "https://earthquake.usgs.gov/fdsnws/event/1";

export interface EarthquakeMarket {
  slug: string;
  question: string;
  yesPrice: number;
  threshold: number; // e.g., "8 or more" = 8
  comparison: "gte" | "eq" | "lte"; // >=, =, <=
  endDate: Date;
  magnitude: number; // minimum magnitude (usually 7.0)
}

export interface EarthquakeAnalysis {
  market: EarthquakeMarket;
  currentCount: number;
  daysRemaining: number;
  expectedAdditional: number;
  modelProbability: number;
  marketProbability: number;
  edge: number;
  recommendation: "BUY" | "SELL" | "HOLD";
  confidence: "HIGH" | "MEDIUM" | "LOW";
}

/**
 * Poisson probability mass function
 */
function poissonPmf(k: number, lambda: number): number {
  if (k < 0 || !Number.isInteger(k)) return 0;
  let result = Math.exp(-lambda);
  for (let i = 1; i <= k; i++) {
    result *= lambda / i;
  }
  return result;
}

/**
 * Poisson CDF: P(X <= k)
 */
function poissonCdf(k: number, lambda: number): number {
  let sum = 0;
  for (let i = 0; i <= k; i++) {
    sum += poissonPmf(i, lambda);
  }
  return sum;
}

/**
 * Fetch earthquake count from USGS for a date range
 */
export async function fetchEarthquakeCount(
  startDate: string,
  endDate: string,
  minMagnitude: number = 7.0
): Promise<number> {
  const url = `${USGS_API}/count`;
  const { data } = await axios.get(url, {
    params: {
      starttime: startDate,
      endtime: endDate,
      minmagnitude: minMagnitude,
    },
    timeout: 10000,
  });
  return parseInt(data, 10);
}

/**
 * Fetch historical earthquake counts for multiple years
 */
export async function fetchHistoricalRates(
  years: number[],
  startMonth: number = 1,
  endMonth: number = 12,
  minMagnitude: number = 7.0
): Promise<{ year: number; count: number }[]> {
  const results: { year: number; count: number }[] = [];

  for (const year of years) {
    const startDate = `${year}-${String(startMonth).padStart(2, "0")}-01`;
    const endDate = `${year}-${String(endMonth).padStart(2, "0")}-${endMonth === 12 ? 31 : 30}`;

    try {
      const count = await fetchEarthquakeCount(startDate, endDate, minMagnitude);
      results.push({ year, count });
    } catch (err) {
      console.warn(`Failed to fetch ${year}: ${err}`);
    }
  }

  return results;
}

/**
 * Calculate Poisson probability for a threshold
 */
export function calculatePoissonProbability(
  currentCount: number,
  threshold: number,
  comparison: "gte" | "eq" | "lte",
  expectedTotal: number
): number {
  // Expected additional = expectedTotal - currentCount
  const lambda = Math.max(0, expectedTotal - currentCount);

  // Calculate based on comparison type
  const needed = threshold - currentCount;

  if (comparison === "gte") {
    // P(X >= needed) = 1 - P(X < needed) = 1 - P(X <= needed-1)
    if (needed <= 0) return 1.0; // Already met threshold
    return 1 - poissonCdf(needed - 1, lambda);
  } else if (comparison === "eq") {
    // P(X = needed)
    if (needed < 0) return 0;
    return poissonPmf(needed, lambda);
  } else {
    // P(X <= needed)
    if (needed < 0) return 0;
    return poissonCdf(needed, lambda);
  }
}

/**
 * Analyze an earthquake market for potential edge
 */
export async function analyzeEarthquakeMarket(
  market: EarthquakeMarket
): Promise<EarthquakeAnalysis> {
  const now = new Date();
  const yearStart = `${now.getFullYear()}-01-01`;
  const today = now.toISOString().split("T")[0];

  // Get current count for this year
  const currentCount = await fetchEarthquakeCount(yearStart, today, market.magnitude);

  // Get historical data to estimate rate
  const years = [2020, 2021, 2022, 2023, 2024, 2025];
  const endMonth = market.endDate.getMonth() + 1;

  const historical = await fetchHistoricalRates(years, 1, endMonth, market.magnitude);
  const avgForPeriod = historical.reduce((sum, h) => sum + h.count, 0) / historical.length;

  // Calculate days and expected additional
  const daysRemaining = Math.max(0, (market.endDate.getTime() - now.getTime()) / (1000 * 60 * 60 * 24));
  const totalDaysInPeriod = (market.endDate.getTime() - new Date(`${now.getFullYear()}-01-01`).getTime()) / (1000 * 60 * 60 * 24);
  const daysElapsed = totalDaysInPeriod - daysRemaining;

  // Pro-rate expected total based on time remaining
  const expectedTotal = avgForPeriod;
  const expectedAdditional = (avgForPeriod / totalDaysInPeriod) * daysRemaining;

  // Calculate model probability
  const modelProbability = calculatePoissonProbability(
    currentCount,
    market.threshold,
    market.comparison,
    expectedTotal
  );

  const marketProbability = market.yesPrice;
  const edge = modelProbability - marketProbability;

  // Determine recommendation
  let recommendation: "BUY" | "SELL" | "HOLD" = "HOLD";
  let confidence: "HIGH" | "MEDIUM" | "LOW" = "LOW";

  if (edge > 0.15) {
    recommendation = "BUY";
    confidence = edge > 0.25 ? "HIGH" : "MEDIUM";
  } else if (edge < -0.15) {
    recommendation = "SELL";
    confidence = edge < -0.25 ? "HIGH" : "MEDIUM";
  }

  return {
    market,
    currentCount,
    daysRemaining,
    expectedAdditional,
    modelProbability,
    marketProbability,
    edge,
    recommendation,
    confidence,
  };
}

/**
 * Parse earthquake market question to extract parameters
 */
export function parseEarthquakeQuestion(question: string): {
  threshold: number;
  comparison: "gte" | "eq" | "lte";
  magnitude: number;
  endDate: Date | null;
} | null {
  // Match patterns like "8 or more earthquakes" or "exactly 5 earthquakes"
  const gteMatch = question.match(/(\d+)\s+or\s+more\s+earthquakes?\s+of\s+magnitude\s+([\d.]+)/i);
  const eqMatch = question.match(/exactly\s+(\d+)\s+earthquakes?\s+of\s+magnitude\s+([\d.]+)/i);
  const lteMatch = question.match(/fewer\s+than\s+(\d+)\s+earthquakes?\s+of\s+magnitude\s+([\d.]+)/i);

  let threshold: number;
  let comparison: "gte" | "eq" | "lte";
  let magnitude: number;

  if (gteMatch) {
    threshold = parseInt(gteMatch[1], 10);
    magnitude = parseFloat(gteMatch[2]);
    comparison = "gte";
  } else if (eqMatch) {
    threshold = parseInt(eqMatch[1], 10);
    magnitude = parseFloat(eqMatch[2]);
    comparison = "eq";
  } else if (lteMatch) {
    threshold = parseInt(lteMatch[1], 10);
    magnitude = parseFloat(lteMatch[2]);
    comparison = "lte";
  } else {
    return null;
  }

  // Try to parse end date (e.g., "by June 30" or "in 2026")
  let endDate: Date | null = null;
  const byDateMatch = question.match(/by\s+(january|february|march|april|may|june|july|august|september|october|november|december)\s+(\d+)/i);
  const inYearMatch = question.match(/in\s+(\d{4})/i);

  if (byDateMatch) {
    const months: { [key: string]: number } = {
      january: 0, february: 1, march: 2, april: 3, may: 4, june: 5,
      july: 6, august: 7, september: 8, october: 9, november: 10, december: 11,
    };
    const month = months[byDateMatch[1].toLowerCase()];
    const day = parseInt(byDateMatch[2], 10);
    const year = new Date().getFullYear();
    endDate = new Date(year, month, day);
  } else if (inYearMatch) {
    const year = parseInt(inYearMatch[1], 10);
    endDate = new Date(year, 11, 31); // End of year
  }

  return { threshold, comparison, magnitude, endDate };
}
