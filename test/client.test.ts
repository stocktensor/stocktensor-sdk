import { describe, expect, it, vi } from "vitest";
import {
  createClient,
  StocktensorApiError,
  StocktensorError,
  StocktensorNetworkError,
  StocktensorTimeoutError,
} from "../src/index.js";

type Call = { url: string; init: RequestInit };

function fakeFetch(responses: Array<Response | Error | "hang">) {
  const calls: Call[] = [];
  const fn = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    const next = responses.shift();
    if (next === undefined) throw new Error("unexpected request");
    if (next === "hang")
      return new Promise<Response>((_, reject) =>
        init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError"))),
      );
    if (next instanceof Error) throw next;
    return next;
  });
  return { fetch: fn as unknown as typeof fetch, calls };
}

const ok = (body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json", ...headers } });
const status = (code: number, body?: unknown, headers: Record<string, string> = {}) =>
  new Response(body === undefined ? null : JSON.stringify(body), { status: code, headers });

describe("createClient", () => {
  it("builds paths and query strings against the default base URL", async () => {
    const { fetch, calls } = fakeFetch([ok([]), ok([]), ok([]), ok({ models: [] }), ok({}), ok({}), ok({})]);
    const client = createClient({ fetch });
    await client.forecasts({ asset: "nvda", horizon: "1d" });
    await client.consensus();
    await client.divergence();
    await client.leaderboard();
    await client.model("5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY");
    await client.bundle("latest");
    await client.bundle(12);
    expect(calls.map((c) => c.url)).toEqual([
      "https://api.stocktensor.io/v1/forecasts?asset=NVDA&horizon=1d",
      "https://api.stocktensor.io/v1/consensus",
      "https://api.stocktensor.io/v1/divergence",
      "https://api.stocktensor.io/v1/leaderboard",
      "https://api.stocktensor.io/v1/models/5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY",
      "https://api.stocktensor.io/v1/bundles/latest",
      "https://api.stocktensor.io/v1/bundles/12",
    ]);
  });

  it("sends the API key as a bearer token, and nothing without one", async () => {
    const withKey = fakeFetch([ok([])]);
    await createClient({ fetch: withKey.fetch, apiKey: "sk_test" }).consensus();
    expect((withKey.calls[0]!.init.headers as Record<string, string>).authorization).toBe("Bearer sk_test");

    const without = fakeFetch([ok([])]);
    await createClient({ fetch: without.fetch, baseUrl: "http://localhost:8787/v1/" }).consensus();
    expect(without.calls[0]!.url).toBe("http://localhost:8787/v1/consensus");
    expect((without.calls[0]!.init.headers as Record<string, string>).authorization).toBeUndefined();
  });

  it("retries 429 and 5xx, honouring Retry-After", async () => {
    const { fetch, calls } = fakeFetch([
      status(429, undefined, { "retry-after": "0" }),
      status(503),
      ok([{ asset: "SPY" }]),
    ]);
    const result = await createClient({ fetch, backoffMs: 1 }).forecasts();
    expect(result).toEqual([{ asset: "SPY" }]);
    expect(calls).toHaveLength(3);
  });

  it("throws a typed API error with code and body, without retrying 4xx", async () => {
    const { fetch, calls } = fakeFetch([status(404, { error: "unknown model", code: "not_found" })]);
    const error = await createClient({ fetch })
      .model("5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY")
      .catch((e) => e);
    expect(error).toBeInstanceOf(StocktensorApiError);
    expect(error).toMatchObject({ status: 404, code: "not_found", message: "unknown model" });
    expect(calls).toHaveLength(1);
  });

  it("gives up after the configured retries", async () => {
    const { fetch, calls } = fakeFetch([status(500), status(500)]);
    await expect(createClient({ fetch, retries: 1, backoffMs: 1 }).leaderboard()).rejects.toMatchObject({
      status: 500,
    });
    expect(calls).toHaveLength(2);
  });

  it("maps aborts to timeouts and transport failures to network errors", async () => {
    const hang = fakeFetch(["hang"]);
    await expect(createClient({ fetch: hang.fetch, timeoutMs: 20, retries: 0 }).divergence()).rejects.toBeInstanceOf(
      StocktensorTimeoutError,
    );
    const broken = fakeFetch([new TypeError("fetch failed"), new TypeError("fetch failed")]);
    await expect(createClient({ fetch: broken.fetch, retries: 1, backoffMs: 1 }).divergence()).rejects.toBeInstanceOf(
      StocktensorNetworkError,
    );
    expect(broken.calls).toHaveLength(2);
  });

  it("validates inputs before any request", () => {
    const { fetch, calls } = fakeFetch([]);
    const client = createClient({ fetch });
    expect(() => client.forecasts({ horizon: "2h" as never })).toThrow(StocktensorError);
    expect(() => client.forecasts({ asset: "NV DA" })).toThrow(StocktensorError);
    expect(() => client.model("0xnotss58")).toThrow(StocktensorError);
    expect(() => client.bundle(-1)).toThrow(StocktensorError);
    expect(calls).toHaveLength(0);
  });
});
