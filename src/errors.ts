/** Base class for every error thrown by the SDK. */
export class StocktensorError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "StocktensorError";
  }
}

/** The API answered with a non-2xx status. */
export class StocktensorApiError extends StocktensorError {
  readonly status: number;
  readonly code: string | undefined;
  readonly body: unknown;

  constructor(status: number, message: string, code?: string, body?: unknown) {
    super(message);
    this.name = "StocktensorApiError";
    this.status = status;
    this.code = code;
    this.body = body;
  }
}

/** The request did not finish within `timeoutMs`. */
export class StocktensorTimeoutError extends StocktensorError {
  constructor(timeoutMs: number) {
    super(`request timed out after ${timeoutMs} ms`);
    this.name = "StocktensorTimeoutError";
  }
}

/** The request never reached the API (DNS, TLS, connection reset...). */
export class StocktensorNetworkError extends StocktensorError {
  constructor(cause: unknown) {
    super(`network error: ${cause instanceof Error ? cause.message : String(cause)}`, { cause });
    this.name = "StocktensorNetworkError";
  }
}
