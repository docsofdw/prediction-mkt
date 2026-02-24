/**
 * Temperature Market Analyzer
 *
 * Compares Polymarket temperature predictions against NWS forecasts
 * to find mispricings using forecast error distributions.
 */

import axios from "axios";

// NWS gridpoint coordinates for major cities
const NWS_GRIDPOINTS: { [city: string]: { office: string | null; gridX: number; gridY: number } } = {
  "new york": { office: "OKX", gridX: 33, gridY: 37 },
  "new york city": { office: "OKX", gridX: 33, gridY: 37 },
  "nyc": { office: "OKX", gridX: 33, gridY: 37 },
  "miami": { office: "MFL", gridX: 110, gridY: 50 },
  "los angeles": { office: "LOX", gridX: 154, gridY: 44 },
  "chicago": { office: "LOT", gridX: 65, gridY: 76 },
  "london": { office: null, gridX: 0, gridY: 0 }, // Non-US, use different API
  "seoul": { office: null, gridX: 0, gridY: 0 },
};

// Historical forecast error (RMSE in °F) by days out
const FORECAST_ERROR_F: { [daysOut: number]: number } = {
  0: 2.0,   // Same day
  1: 2.5,   // 1 day out
  2: 3.0,   // 2 days out
  3: 3.5,   // 3 days out
  4: 4.0,   // 4 days out
  5: 4.5,   // 5 days out
  6: 5.0,   // 6 days out
  7: 5.5,   // 7 days out
};

export interface TemperatureMarket {
  slug: string;
  question: string;
  yesPrice: number;
  city: string;
  date: Date;
  tempMin: number | null;  // e.g., 64 for "64-65°F"
  tempMax: number | null;  // e.g., 65 for "64-65°F"
  comparison: "range" | "gte" | "lte"; // between X-Y, >= X, <= X
  unit: "F" | "C";
}

export interface TemperatureAnalysis {
  market: TemperatureMarket;
  forecastTemp: number | null;
  forecastError: number;
  daysOut: number;
  modelProbability: number | null;
  marketProbability: number;
  edge: number | null;
  recommendation: "BUY" | "SELL" | "HOLD" | "NO_DATA";
  confidence: "HIGH" | "MEDIUM" | "LOW";
}

/**
 * Normal CDF approximation
 */
function normalCdf(x: number, mean: number, stdDev: number): number {
  const z = (x - mean) / stdDev;
  // Approximation using error function
  const t = 1 / (1 + 0.2316419 * Math.abs(z));
  const d = 0.3989423 * Math.exp(-z * z / 2);
  const p = d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274))));
  return z > 0 ? 1 - p : p;
}

/**
 * Calculate probability of temperature falling in a range
 */
function calculateTempProbability(
  forecast: number,
  stdDev: number,
  tempMin: number | null,
  tempMax: number | null,
  comparison: "range" | "gte" | "lte"
): number {
  if (comparison === "range" && tempMin !== null && tempMax !== null) {
    // P(tempMin <= X <= tempMax)
    const pUpper = normalCdf(tempMax + 0.5, forecast, stdDev); // +0.5 for discrete rounding
    const pLower = normalCdf(tempMin - 0.5, forecast, stdDev);
    return pUpper - pLower;
  } else if (comparison === "gte" && tempMin !== null) {
    // P(X >= tempMin)
    return 1 - normalCdf(tempMin - 0.5, forecast, stdDev);
  } else if (comparison === "lte" && tempMax !== null) {
    // P(X <= tempMax)
    return normalCdf(tempMax + 0.5, forecast, stdDev);
  }
  return 0.5; // Unknown
}

/**
 * Fetch NWS forecast for a US city
 */
export async function fetchNwsForecast(city: string): Promise<{
  periods: Array<{ name: string; temperature: number; date: string }>;
} | null> {
  const gridpoint = NWS_GRIDPOINTS[city.toLowerCase()];
  if (!gridpoint || !gridpoint.office) {
    return null; // Non-US city
  }

  try {
    const url = `https://api.weather.gov/gridpoints/${gridpoint.office}/${gridpoint.gridX},${gridpoint.gridY}/forecast`;
    const { data } = await axios.get(url, {
      timeout: 10000,
      headers: { "User-Agent": "polymarket-analyzer" },
    });

    const periods = data.properties.periods.map((p: any) => ({
      name: p.name,
      temperature: p.temperature,
      date: p.startTime.split("T")[0],
    }));

    return { periods };
  } catch (err) {
    console.warn(`Failed to fetch NWS forecast for ${city}: ${err}`);
    return null;
  }
}

/**
 * Fetch OpenWeatherMap forecast (for international cities)
 */
export async function fetchOwmForecast(
  city: string,
  apiKey?: string
): Promise<{ temp: number; date: string }[] | null> {
  // This would require an API key - return null for now
  return null;
}

/**
 * Analyze a temperature market for potential edge
 */
export async function analyzeTemperatureMarket(
  market: TemperatureMarket
): Promise<TemperatureAnalysis> {
  const now = new Date();
  const daysOut = Math.max(0, Math.floor((market.date.getTime() - now.getTime()) / (1000 * 60 * 60 * 24)));

  // Get forecast error for this day out
  const forecastError = FORECAST_ERROR_F[Math.min(daysOut, 7)] || 6.0;

  // Convert error to Celsius if needed
  const errorInUnit = market.unit === "C" ? forecastError * 5 / 9 : forecastError;

  // Try to fetch forecast
  let forecastTemp: number | null = null;
  const nwsForecast = await fetchNwsForecast(market.city);

  if (nwsForecast) {
    // Find the forecast for the target date
    const dateStr = market.date.toISOString().split("T")[0];
    const dayForecast = nwsForecast.periods.find(p =>
      p.date === dateStr && p.name.toLowerCase().includes("day")
    );
    if (dayForecast) {
      forecastTemp = dayForecast.temperature;
      // Convert to market unit if needed
      if (market.unit === "C") {
        forecastTemp = (forecastTemp - 32) * 5 / 9;
      }
    }
  }

  // Calculate model probability
  let modelProbability: number | null = null;
  let edge: number | null = null;
  let recommendation: "BUY" | "SELL" | "HOLD" | "NO_DATA" = "NO_DATA";
  let confidence: "HIGH" | "MEDIUM" | "LOW" = "LOW";

  if (forecastTemp !== null) {
    modelProbability = calculateTempProbability(
      forecastTemp,
      errorInUnit,
      market.tempMin,
      market.tempMax,
      market.comparison
    );

    edge = modelProbability - market.yesPrice;

    if (edge > 0.15) {
      recommendation = "BUY";
      confidence = edge > 0.25 ? "HIGH" : "MEDIUM";
    } else if (edge < -0.15) {
      recommendation = "SELL";
      confidence = edge < -0.25 ? "HIGH" : "MEDIUM";
    } else {
      recommendation = "HOLD";
    }
  }

  return {
    market,
    forecastTemp,
    forecastError: errorInUnit,
    daysOut,
    modelProbability,
    marketProbability: market.yesPrice,
    edge,
    recommendation,
    confidence,
  };
}

/**
 * Parse temperature market question to extract parameters
 */
export function parseTemperatureQuestion(question: string): {
  city: string;
  date: Date | null;
  tempMin: number | null;
  tempMax: number | null;
  comparison: "range" | "gte" | "lte";
  unit: "F" | "C";
} | null {
  // Match patterns like "highest temperature in Miami be between 64-65°F on February 24"
  const rangeMatchF = question.match(
    /temperature\s+in\s+([^be]+?)\s+be\s+between\s+(\d+)[–-](\d+)°?F\s+on\s+(\w+\s+\d+)/i
  );
  const rangeMatchC = question.match(
    /temperature\s+in\s+([^be]+?)\s+be\s+(\d+)°?C\s+on\s+(\w+\s+\d+)/i
  );
  const gteMatchF = question.match(
    /temperature\s+in\s+([^be]+?)\s+be\s+(\d+)°?F\s+or\s+higher\s+on\s+(\w+\s+\d+)/i
  );
  const lteMatchF = question.match(
    /temperature\s+in\s+([^be]+?)\s+be\s+(\d+)°?F\s+or\s+below\s+on\s+(\w+\s+\d+)/i
  );

  let city: string;
  let tempMin: number | null = null;
  let tempMax: number | null = null;
  let comparison: "range" | "gte" | "lte";
  let unit: "F" | "C";
  let dateStr: string;

  if (rangeMatchF) {
    city = rangeMatchF[1].trim();
    tempMin = parseInt(rangeMatchF[2], 10);
    tempMax = parseInt(rangeMatchF[3], 10);
    comparison = "range";
    unit = "F";
    dateStr = rangeMatchF[4];
  } else if (rangeMatchC) {
    city = rangeMatchC[1].trim();
    tempMin = parseInt(rangeMatchC[2], 10);
    tempMax = tempMin; // Single value
    comparison = "range";
    unit = "C";
    dateStr = rangeMatchC[3];
  } else if (gteMatchF) {
    city = gteMatchF[1].trim();
    tempMin = parseInt(gteMatchF[2], 10);
    comparison = "gte";
    unit = "F";
    dateStr = gteMatchF[3];
  } else if (lteMatchF) {
    city = lteMatchF[1].trim();
    tempMax = parseInt(lteMatchF[2], 10);
    comparison = "lte";
    unit = "F";
    dateStr = lteMatchF[3];
  } else {
    return null;
  }

  // Parse date
  let date: Date | null = null;
  const dateMatch = dateStr.match(/(january|february|march|april|may|june|july|august|september|october|november|december)\s+(\d+)/i);
  if (dateMatch) {
    const months: { [key: string]: number } = {
      january: 0, february: 1, march: 2, april: 3, may: 4, june: 5,
      july: 6, august: 7, september: 8, october: 9, november: 10, december: 11,
    };
    const month = months[dateMatch[1].toLowerCase()];
    const day = parseInt(dateMatch[2], 10);
    const year = new Date().getFullYear();
    date = new Date(year, month, day);
  }

  return { city, date, tempMin, tempMax, comparison, unit };
}
