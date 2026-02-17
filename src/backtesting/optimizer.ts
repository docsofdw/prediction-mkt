export interface BitcoinParams {
  shortWindow: number;
  longWindow: number;
  threshold: number;
}

export interface WeatherParams {
  window: number;
  zEntry: number;
  zExit: number;
}

export function getBitcoinCandidates(): BitcoinParams[] {
  const shorts = [4, 6, 8];
  const longs = [16, 24, 32];
  const thresholds = [0.003, 0.005, 0.008];

  const candidates: BitcoinParams[] = [];
  for (const shortWindow of shorts) {
    for (const longWindow of longs) {
      if (shortWindow >= longWindow) continue;
      for (const threshold of thresholds) {
        candidates.push({ shortWindow, longWindow, threshold });
      }
    }
  }

  return candidates;
}

export function getWeatherCandidates(): WeatherParams[] {
  const windows = [16, 24, 32];
  const zEntries = [1.0, 1.2, 1.5];
  const zExits = [0.2, 0.3, 0.4];

  const candidates: WeatherParams[] = [];
  for (const window of windows) {
    for (const zEntry of zEntries) {
      for (const zExit of zExits) {
        if (zExit >= zEntry) continue;
        candidates.push({ window, zEntry, zExit });
      }
    }
  }

  return candidates;
}
