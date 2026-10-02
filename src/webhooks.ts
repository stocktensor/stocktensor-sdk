/**
 * Webhook signatures: HMAC-SHA256 over `${timestamp}.${body}` with the
 * endpoint secret, sent as
 *
 *   x-stocktensor-timestamp: <unix seconds>
 *   x-stocktensor-signature: v1=<lowercase hex>
 *
 * Uses Web Crypto, so it runs on Node ≥ 20, Cloudflare Workers, Deno and Bun.
 */

export const TIMESTAMP_HEADER = "x-stocktensor-timestamp";
export const SIGNATURE_HEADER = "x-stocktensor-signature";
export const DEFAULT_TOLERANCE_SECONDS = 300;

export class WebhookVerificationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WebhookVerificationError";
  }
}

type HeaderSource = Headers | Record<string, string | string[] | undefined>;

function header(headers: HeaderSource, name: string): string | undefined {
  if (typeof (headers as Headers).get === "function") return (headers as Headers).get(name) ?? undefined;
  const record = headers as Record<string, string | string[] | undefined>;
  const key = Object.keys(record).find((k) => k.toLowerCase() === name);
  const value = key === undefined ? undefined : record[key];
  return Array.isArray(value) ? value[0] : value;
}

const encoder = new TextEncoder();

async function hmacHex(secret: string, payload: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, [
    "sign",
  ]);
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(payload)));
  return Array.from(mac, (b) => b.toString(16).padStart(2, "0")).join("");
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function bodyText(body: string | Uint8Array): string {
  return typeof body === "string" ? body : new TextDecoder().decode(body);
}

/** Sign a webhook body. Returns the two headers to send. */
export async function signWebhook(
  body: string | Uint8Array,
  secret: string,
  timestamp: number = Math.floor(Date.now() / 1000),
): Promise<Record<string, string>> {
  const signature = await hmacHex(secret, `${timestamp}.${bodyText(body)}`);
  return { [TIMESTAMP_HEADER]: String(timestamp), [SIGNATURE_HEADER]: `v1=${signature}` };
}

/**
 * Verify a webhook from its raw body (not re-serialised JSON) and headers.
 * Throws {@link WebhookVerificationError}; returns the parsed JSON body on success.
 */
export async function verifyWebhook<T = unknown>(
  body: string | Uint8Array,
  headers: HeaderSource,
  secret: string,
  options: { toleranceSec?: number; now?: number } = {},
): Promise<T> {
  if (!secret) throw new WebhookVerificationError("missing secret");
  const timestamp = header(headers, TIMESTAMP_HEADER);
  const signature = header(headers, SIGNATURE_HEADER);
  if (!timestamp || !/^\d+$/.test(timestamp)) throw new WebhookVerificationError("missing or invalid timestamp");
  if (!signature) throw new WebhookVerificationError("missing signature");

  const now = options.now ?? Math.floor(Date.now() / 1000);
  const tolerance = options.toleranceSec ?? DEFAULT_TOLERANCE_SECONDS;
  if (Math.abs(now - Number(timestamp)) > tolerance) throw new WebhookVerificationError("timestamp outside tolerance");

  const text = bodyText(body);
  const expected = await hmacHex(secret, `${timestamp}.${text}`);
  const candidates = signature
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part.startsWith("v1="))
    .map((part) => part.slice(3));
  if (!candidates.some((candidate) => timingSafeEqual(candidate, expected)))
    throw new WebhookVerificationError("signature mismatch");

  try {
    return JSON.parse(text) as T;
  } catch {
    throw new WebhookVerificationError("body is not JSON");
  }
}
