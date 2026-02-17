export interface BitcoinParams {
  shortWindow: number;
  longWindow: number;
  threshold: number;
  adxThreshold?: number;
  confirmationBars?: number;
  useVolatilityScaling?: boolean;
}

export interface WeatherParams {
  window: number;
  zEntry: number;
  zExit: number;
  useEwma?: boolean;
  ewmaAlpha?: number;
  maxHalfLife?: number;
  useVolatilityScaling?: boolean;
}

/**
 * Get expanded Bitcoin momentum parameter grid (150+ candidates)
 * Includes ADX threshold and confirmation bar variations
 */
export function getBitcoinCandidates(): BitcoinParams[] {
  const shorts = [4, 6, 8, 10, 12];
  const longs = [16, 20, 24, 28, 32, 40];
  const thresholds = [0.002, 0.003, 0.004, 0.005, 0.006, 0.008, 0.01];
  const adxThresholds = [15, 20, 25];
  const confirmationBarOptions = [1, 2, 3];

  const candidates: BitcoinParams[] = [];
  for (const shortWindow of shorts) {
    for (const longWindow of longs) {
      if (shortWindow >= longWindow) continue;
      for (const threshold of thresholds) {
        for (const adxThreshold of adxThresholds) {
          for (const confirmationBars of confirmationBarOptions) {
            candidates.push({
              shortWindow,
              longWindow,
              threshold,
              adxThreshold,
              confirmationBars,
              useVolatilityScaling: true,
            });
          }
        }
      }
    }
  }

  return candidates;
}

/**
 * Get compact Bitcoin parameter grid for faster testing (~27 candidates)
 */
export function getBitcoinCandidatesCompact(): BitcoinParams[] {
  const shorts = [4, 6, 8];
  const longs = [16, 24, 32];
  const thresholds = [0.003, 0.005, 0.008];

  const candidates: BitcoinParams[] = [];
  for (const shortWindow of shorts) {
    for (const longWindow of longs) {
      if (shortWindow >= longWindow) continue;
      for (const threshold of thresholds) {
        candidates.push({
          shortWindow,
          longWindow,
          threshold,
          adxThreshold: 20,
          confirmationBars: 2,
          useVolatilityScaling: true,
        });
      }
    }
  }

  return candidates;
}

/**
 * Get expanded Weather mean-reversion parameter grid (200+ candidates)
 * Includes EWMA and half-life variations
 */
export function getWeatherCandidates(): WeatherParams[] {
  const windows = [12, 16, 20, 24, 28, 32, 40];
  const zEntries = [0.8, 1.0, 1.2, 1.4, 1.6, 1.8, 2.0];
  const zExits = [0.1, 0.2, 0.3, 0.4, 0.5];
  const maxHalfLifeOptions = [10, 20, 30];
  const useEwmaOptions = [true, false];

  const candidates: WeatherParams[] = [];
  for (const window of windows) {
    for (const zEntry of zEntries) {
      for (const zExit of zExits) {
        if (zExit >= zEntry) continue;
        for (const maxHalfLife of maxHalfLifeOptions) {
          for (const useEwma of useEwmaOptions) {
            candidates.push({
              window,
              zEntry,
              zExit,
              useEwma,
              ewmaAlpha: 0.1,
              maxHalfLife,
              useVolatilityScaling: true,
            });
          }
        }
      }
    }
  }

  return candidates;
}

/**
 * Get compact Weather parameter grid for faster testing (~27 candidates)
 */
export function getWeatherCandidatesCompact(): WeatherParams[] {
  const windows = [16, 24, 32];
  const zEntries = [1.0, 1.2, 1.5];
  const zExits = [0.2, 0.3, 0.4];

  const candidates: WeatherParams[] = [];
  for (const window of windows) {
    for (const zEntry of zEntries) {
      for (const zExit of zExits) {
        if (zExit >= zEntry) continue;
        candidates.push({
          window,
          zEntry,
          zExit,
          useEwma: true,
          ewmaAlpha: 0.1,
          maxHalfLife: 30,
          useVolatilityScaling: true,
        });
      }
    }
  }

  return candidates;
}
