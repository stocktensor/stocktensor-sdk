import type { Direction, Forecast } from "./types.js";

/** Consensus parameters, identical to SCORING.md (version 1). */
export const NEUTRAL_BAND = 0.05;
export const CONSENSUS_TOP_K = 10;

/** Direction read from a probability of ending higher: bullish ≥ 0.55, bearish ≤ 0.45. */
export function directionOf(pUp: number): Direction {
  if (pUp >= 0.5 + NEUTRAL_BAND) return "bullish";
  if (pUp <= 0.5 - NEUTRAL_BAND) return "bearish";
  return "neutral";
}

export interface ConsensusResult {
  direction: Direction;
  /** Median p_up of the top models. */
  p_up: number;
  /** Share of top models whose own direction matches, 0..1. */
  agreement: number;
  models: number;
}

/**
 * Consensus of the top `topK` models (by rolling score) for one task,
 * the same rule the subnet uses (`stocktensor/scoring.py#consensus`).
 * Models with no rolling score, or with a non-numeric `p_up`, are skipped.
 */
export function consensus(
  forecasts: Record<string, Forecast>,
  rolling: Record<string, number>,
  topK: number = CONSENSUS_TOP_K,
): ConsensusResult | null {
  const ranked = Object.keys(forecasts)
    .filter((m) => (rolling[m] ?? 0) > 0)
    .sort((a, b) => rolling[b]! - rolling[a]! || (a < b ? -1 : a > b ? 1 : 0))
    .slice(0, topK);
  const pValues: number[] = [];
  for (const miner of ranked) {
    const p = Number(forecasts[miner]!.p_up);
    if (Number.isFinite(p)) pValues.push(p);
  }
  if (pValues.length === 0) return null;
  const ordered = [...pValues].sort((a, b) => a - b);
  const mid = Math.floor(ordered.length / 2);
  const median = ordered.length % 2 ? ordered[mid]! : (ordered[mid - 1]! + ordered[mid]!) / 2;
  const direction = directionOf(median);
  const agreeing = pValues.filter((p) => directionOf(p) === direction).length;
  return { direction, p_up: median, agreement: agreeing / pValues.length, models: pValues.length };
}
