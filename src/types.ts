/** Forecast horizons, in seconds. Same ids as the subnet protocol. */
export const HORIZONS = { "1h": 3_600, "1d": 86_400, "1w": 604_800 } as const;

export type Horizon = keyof typeof HORIZONS;
export type Direction = "bullish" | "bearish" | "neutral";
export type Session = "regular" | "pre" | "post" | "overnight" | "closed";

/** One model's answer for one task. Prices are USD decimal strings. */
export interface Forecast {
  /** Lower bound of the central 80% prediction interval. */
  low: string;
  /** Best single estimate of the price at `as_of + horizon`. */
  point: string;
  /** Upper bound of the central 80% prediction interval. */
  high: string;
  /** Probability that the price ends above the reference price, "0".."1". */
  p_up: string;
}

/** Network forecast for one asset and horizon, aggregated from the top-ranked models. */
export interface ForecastEntry {
  asset: string;
  horizon: Horizon;
  /** Unix seconds the forecast was made at. */
  as_of: number;
  /** Unix seconds the forecast is for (`as_of + horizon`). */
  target_time: number;
  session: Session;
  /** Chainlink price at `as_of`. */
  reference_price: string;
  /** Medians of the top models' `low`, `point`, `high` and `p_up`. */
  low: string;
  point: string;
  high: string;
  p_up: string;
  direction: Direction;
  /** Share of top models whose own direction matches `direction`, 0..1. */
  agreement: number;
  /** Number of top models that answered. */
  models: number;
  /** True when served on the delayed (keyless) tier. */
  delayed: boolean;
}

export interface ConsensusEntry {
  asset: string;
  horizon: Horizon;
  as_of: number;
  direction: Direction;
  p_up: string;
  agreement: number;
  models: number;
  delayed: boolean;
}

export interface DivergenceEntry {
  asset: string;
  horizon: Horizon;
  as_of: number;
  /** max(p_up) − min(p_up) across the top models. */
  p_up_spread: number;
  bullish: number;
  bearish: number;
  neutral: number;
  delayed: boolean;
}

export interface LeaderboardModel {
  rank: number;
  /** Miner hotkey (ss58). */
  hotkey: string;
  uid: number | null;
  /** Rolling score, 6-decimal string (see SCORING.md). */
  rolling: string;
  /** Share of emissions from the latest weights, 6-decimal string. */
  weight: string;
  /** Tasks counted in the rolling window. */
  tasks: number;
  /** Share of those tasks with a valid, on-time forecast, 0..1. */
  valid_rate: number;
}

export interface Leaderboard {
  epoch: number;
  updated_at: number;
  models: LeaderboardModel[];
}

export interface ModelTaskRecord {
  task_id: string;
  asset: string;
  horizon: Horizon;
  as_of: number;
  forecast: Forecast | null;
  /** Task score, 6-decimal string, or null while the task is unresolved. */
  score: string | null;
}

export interface ModelProfile {
  hotkey: string;
  uid: number | null;
  rank: number | null;
  rolling: string;
  weight: string;
  by_horizon: Partial<Record<Horizon, string>>;
  by_session: Partial<Record<Session, string>>;
  recent: ModelTaskRecord[];
}

/** Epoch bundle as published by a validator (see PROTOCOL.md in stocktensor-subnet). */
export interface EpochBundle {
  version: number;
  scoring_version: number;
  netuid: number;
  validator: string;
  epoch: number;
  created_at: number;
  prev: string;
  tasks: BundleTask[];
  rolling: Record<string, string>;
  weights: Record<string, string>;
  signature: string;
}

export interface ChainlinkRound {
  round_id: string;
  answer: string;
  updated_at: number;
}

export interface BundleTask {
  task_id: string;
  asset: string;
  horizon: Horizon;
  as_of: number;
  session: Session;
  feed: string;
  reference: ChainlinkRound;
  realised: ChainlinkRound | null;
  void: string | null;
  responses: Array<{
    miner: string;
    forecast: Forecast | null;
    signature: string | null;
    error: string | null;
  }>;
  scores: Record<string, string>;
}
