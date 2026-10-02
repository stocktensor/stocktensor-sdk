import { describe, expect, it } from "vitest";
import { signWebhook, verifyWebhook, WebhookVerificationError } from "../src/webhooks.js";

const secret = "whsec_test";
const body = JSON.stringify({ type: "consensus.changed", asset: "NVDA", direction: "bullish" });
const now = 1_790_000_000;

describe("webhooks", () => {
  it("round-trips sign → verify with plain objects and Headers", async () => {
    const headers = await signWebhook(body, secret, now);
    expect(headers["x-stocktensor-signature"]).toMatch(/^v1=[0-9a-f]{64}$/);
    await expect(verifyWebhook(body, headers, secret, { now })).resolves.toMatchObject({ asset: "NVDA" });
    await expect(
      verifyWebhook(new TextEncoder().encode(body), new Headers(headers), secret, { now }),
    ).resolves.toBeTruthy();
  });

  it("matches a known HMAC vector (openssl dgst -sha256 -hmac)", async () => {
    // printf '1790000000.{}' | openssl dgst -sha256 -hmac whsec_test
    const headers = await signWebhook("{}", secret, now);
    expect(headers["x-stocktensor-signature"]).toBe(
      "v1=1c2847ad1f8158a1da978f36627ac1f07f7fd027321ac9ad40bccc06743f8396",
    );
  });

  it("rejects tampering, wrong secrets, stale timestamps and missing headers", async () => {
    const headers = await signWebhook(body, secret, now);
    const fail = (p: Promise<unknown>) => expect(p).rejects.toBeInstanceOf(WebhookVerificationError);
    await fail(verifyWebhook(body.replace("bullish", "bearish"), headers, secret, { now }));
    await fail(verifyWebhook(body, headers, "other", { now }));
    await fail(verifyWebhook(body, headers, secret, { now: now + 301 }));
    await expect(verifyWebhook(body, headers, secret, { now: now + 600, toleranceSec: 900 })).resolves.toBeTruthy();
    await fail(verifyWebhook(body, { "x-stocktensor-timestamp": String(now) }, secret, { now }));
    await fail(verifyWebhook(body, {}, secret, { now }));
    await fail(verifyWebhook(body, headers, "", { now }));
  });

  it("accepts any matching v1 signature during secret rotation", async () => {
    const current = await signWebhook(body, secret, now);
    const old = await signWebhook(body, "old", now);
    const both = {
      ...current,
      "x-stocktensor-signature": `${old["x-stocktensor-signature"]}, ${current["x-stocktensor-signature"]}`,
    };
    await expect(verifyWebhook(body, both, secret, { now })).resolves.toBeTruthy();
  });
});
