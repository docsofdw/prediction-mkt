import axios, { AxiosInstance } from "axios";
import { PriceBar } from "../../backtesting/types";

type HistoryPoint = {
  p: number | string;
  t: number;
};

type HistoryResponse = {
  history?: HistoryPoint[];
};

export class HistoricalPrices {
  private client: AxiosInstance;

  constructor(clobHost: string) {
    this.client = axios.create({ baseURL: clobHost, timeout: 15_000 });
  }

  async getBars(params: {
    tokenId: string;
    interval?: "max" | "1w" | "1d" | "6h" | "1h";
    fidelity?: number;
  }): Promise<PriceBar[]> {
    const { tokenId, interval = "1w", fidelity = 15 } = params;
    const nowTs = Math.floor(Date.now() / 1000);
    const weekAgoTs = nowTs - 7 * 24 * 60 * 60;

    const attempts: Array<Record<string, string | number>> = [
      { market: tokenId, interval, fidelity },
      { market: tokenId, interval },
      { market: tokenId, startTs: weekAgoTs, endTs: nowTs, fidelity },
      { market: tokenId, startTs: weekAgoTs, endTs: nowTs },
    ];

    let lastError: unknown;

    for (const attempt of attempts) {
      try {
        const { data } = await this.client.get<HistoryResponse>("/prices-history", {
          params: attempt,
        });

        const raw = Array.isArray(data?.history) ? data.history : [];
        return raw
          .map((point) => ({
            timestamp: Number(point.t),
            price: Number(point.p),
          }))
          .filter((bar) => Number.isFinite(bar.timestamp) && Number.isFinite(bar.price))
          .sort((a, b) => a.timestamp - b.timestamp);
      } catch (error) {
        lastError = error;
      }
    }

    if (axios.isAxiosError(lastError)) {
      const status = lastError.response?.status;
      const body = JSON.stringify(lastError.response?.data ?? {});
      throw new Error(`Failed to fetch price history for market=${tokenId} status=${status} body=${body}`);
    }

    throw lastError instanceof Error ? lastError : new Error(`Failed to fetch price history for market=${tokenId}`);
  }
}
