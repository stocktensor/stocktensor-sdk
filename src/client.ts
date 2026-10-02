import { StocktensorApiError, StocktensorError, StocktensorNetworkError, StocktensorTimeoutError } from "./errors.js";
import {
  HORIZONS,
  type ConsensusEntry,
  type DivergenceEntry,
  type EpochBundle,
  type ForecastEntry,
  type Horizon,
  type Leaderboard,
  type ModelProfile,
} from "./types.js";

export const DEFAULT_BASE_URL = "https://api.stocktensor.io/v1";

export interface ClientOptions {
  /** API root, default `https://api.stocktensor.io/v1`. */
  baseUrl?: string;
  /** API key for the real-time tier. Without one the API serves the delayed feed. */
  apiKey?: string;
  /** Custom fetch (tests, proxies, edge runtimes). Defaults to `globalThis.fetch`. */
  fetch?: typeof fetch;
  /** Per-attempt timeout, default 10 000 ms. */
  timeoutMs?: number;
  /** Extra attempts after a 429, 5xx, timeout or network error. Default 2. */
  retries?: number;
  /** First backoff delay, doubled per attempt, default 300 ms. `Retry-After` wins when present. */
  backoffMs?: number;
}

export interface Filter {
  asset?: string;
  horizon?: Horizon;
}

export interface StocktensorClient {
  /** Latest network forecast per asset and horizon. */
  forecasts(filter?: Filter): Promise<ForecastEntry[]>;
  /** Direction consensus of the top models per asset and horizon. */
  consensus(filter?: Filter): Promise<ConsensusEntry[]>;
  /** Assets where the top models disagree the most. */
  divergence(): Promise<DivergenceEntry[]>;
  /** Models ranked by rolling score. */
  leaderboard(): Promise<Leaderboard>;
  /** One model's scores and recent forecasts. */
  model(hotkey: string): Promise<ModelProfile>;
  /** A validator epoch bundle, by epoch number or `"latest"`. */
  bundle(epoch: number | "latest"): Promise<EpochBundle>;
}

const RETRY_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);

function normaliseFilter(filter: Filter = {}): URLSearchParams {
  const params = new URLSearchParams();
  if (filter.asset !== undefined) {
    if (!/^[A-Za-z0-9.]{1,12}$/.test(filter.asset)) throw new StocktensorError(`invalid asset ${filter.asset}`);
    params.set("asset", filter.asset.toUpperCase());
  }
  if (filter.horizon !== undefined) {
    if (!(filter.horizon in HORIZONS)) throw new StocktensorError(`invalid horizon ${String(filter.horizon)}`);
    params.set("horizon", filter.horizon);
  }
  return params;
}

function retryAfterMs(header: string | null): number | undefined {
  if (!header) return undefined;
  const seconds = Number(header);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const date = Date.parse(header);
  return Number.isNaN(date) ? undefined : Math.max(0, date - Date.now());
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Client for the Stocktensor HTTP API. See the README for the response contract. */
export function createClient(options: ClientOptions = {}): StocktensorClient {
  const baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const timeoutMs = options.timeoutMs ?? 10_000;
  const retries = options.retries ?? 2;
  const backoffMs = options.backoffMs ?? 300;
  if (!fetchImpl) throw new StocktensorError("no fetch implementation available");

  async function get<T>(path: string, params?: URLSearchParams): Promise<T> {
    const query = params && [...params].length ? `?${params.toString()}` : "";
    const url = `${baseUrl}${path}${query}`;
    const headers: Record<string, string> = { accept: "application/json" };
    if (options.apiKey) headers.authorization = `Bearer ${options.apiKey}`;

    let lastError: unknown;
    for (let attempt = 0; attempt <= retries; attempt++) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      let response: Response;
      try {
        response = await fetchImpl(url, { method: "GET", headers, signal: controller.signal });
      } catch (error) {
        clearTimeout(timer);
        lastError = controller.signal.aborted
          ? new StocktensorTimeoutError(timeoutMs)
          : new StocktensorNetworkError(error);
        if (attempt < retries) {
          await sleep(backoffMs * 2 ** attempt);
          continue;
        }
        throw lastError;
      }
      clearTimeout(timer);

      if (response.ok) return (await response.json()) as T;

      let body: unknown;
      const text = await response.text();
      try {
        body = text ? JSON.parse(text) : undefined;
      } catch {
        body = text;
      }
      const message =
        (typeof body === "object" && body && "error" in body && String((body as { error: unknown }).error)) ||
        `HTTP ${response.status}`;
      const code =
        typeof body === "object" && body && "code" in body ? String((body as { code: unknown }).code) : undefined;
      lastError = new StocktensorApiError(response.status, message, code, body);
      if (RETRY_STATUS.has(response.status) && attempt < retries) {
        await sleep(retryAfterMs(response.headers.get("retry-after")) ?? backoffMs * 2 ** attempt);
        continue;
      }
      throw lastError;
    }
    throw lastError;
  }

  return {
    forecasts: (filter) => get("/forecasts", normaliseFilter(filter)),
    consensus: (filter) => get("/consensus", normaliseFilter(filter)),
    divergence: () => get("/divergence"),
    leaderboard: () => get("/leaderboard"),
    model: (hotkey) => {
      if (!/^[1-9A-HJ-NP-Za-km-z]{46,48}$/.test(hotkey)) throw new StocktensorError(`invalid hotkey ${hotkey}`);
      return get(`/models/${hotkey}`);
    },
    bundle: (epoch) => {
      if (epoch !== "latest" && !(Number.isInteger(epoch) && epoch >= 0))
        throw new StocktensorError(`invalid epoch ${String(epoch)}`);
      return get(`/bundles/${epoch}`);
    },
  };
}
