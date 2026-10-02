import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { consensus, directionOf, sessionAt, type Forecast } from "../src/index.js";

// Golden vectors produced by stocktensor-subnet (scripts/gen_golden.py).
const golden = JSON.parse(readFileSync(new URL("./fixtures/scoring.json", import.meta.url), "utf8"));

describe("consensus", () => {
  it("matches the subnet's reference implementation", () => {
    const task = golden.tasks.find((t: { task_id: string }) => t.task_id === golden.consensus.task_id);
    const forecasts: Record<string, Forecast> = {};
    for (const [miner, forecast] of Object.entries(task.responses))
      if (forecast) forecasts[miner] = forecast as Forecast;
    const result = consensus(forecasts, golden.rolling.expected);
    expect(result).not.toBeNull();
    expect(result!.direction).toBe(golden.consensus.expected.direction);
    expect(result!.models).toBe(golden.consensus.expected.models);
    expect(result!.p_up).toBeCloseTo(golden.consensus.expected.p_up, 12);
    expect(result!.agreement).toBeCloseTo(golden.consensus.expected.agreement, 12);
  });

  it("returns null without ranked models and respects top-k", () => {
    expect(consensus({ a: { low: "1", point: "2", high: "3", p_up: "0.9" } }, {})).toBeNull();
    const forecasts = Object.fromEntries(
      Array.from({ length: 12 }, (_, i) => [
        `m${i}`,
        { low: "1", point: "2", high: "3", p_up: i < 10 ? "0.9" : "0.1" },
      ]),
    );
    const rolling = Object.fromEntries(Array.from({ length: 12 }, (_, i) => [`m${i}`, 1 - i / 100]));
    expect(consensus(forecasts, rolling)).toEqual({ direction: "bullish", p_up: 0.9, agreement: 1, models: 10 });
  });

  it("reads direction with the 0.05 neutral band", () => {
    expect(directionOf(0.55)).toBe("bullish");
    expect(directionOf(0.549)).toBe("neutral");
    expect(directionOf(0.45)).toBe("bearish");
  });
});

describe("sessionAt", () => {
  // 2026-10-02 is a Friday; New York is on EDT (UTC-4).
  const at = (iso: string) => Date.parse(iso) / 1000;
  it("tags US equity sessions in New York time", () => {
    expect(sessionAt(at("2026-10-02T14:00:00Z"))).toBe("regular");
    expect(sessionAt(at("2026-10-02T12:49:00Z"))).toBe("pre");
    expect(sessionAt(at("2026-10-02T21:00:00Z"))).toBe("post");
    expect(sessionAt(at("2026-10-01T03:00:00Z"))).toBe("overnight");
    expect(sessionAt(at("2026-10-03T00:30:00Z"))).toBe("closed"); // Fri 20:30 ET
    expect(sessionAt(at("2026-10-04T15:00:00Z"))).toBe("closed"); // Sunday
    expect(sessionAt(at("2026-10-05T00:30:00Z"))).toBe("overnight"); // Sun 20:30 ET
  });
});
