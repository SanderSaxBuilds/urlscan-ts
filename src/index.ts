/**
 * Small typed TypeScript client for the urlscan.io API (https://urlscan.io/docs/api/).
 *
 * Search works without a key. Result, scan submission and quotas need an API key.
 * Uses the global fetch, no runtime dependencies.
 */

export const DEFAULT_BASE_URL = "https://urlscan.io";
export const USER_AGENT = "urlscan-ts/0.1.0";

export type Visibility = "public" | "unlisted" | "private";

export interface RateLimit {
  scope?: string;
  action?: string;
  window?: string;
  limit?: number;
  remaining?: number;
  /** ISO time when the window resets. */
  reset?: string;
  /** Seconds until the window resets. */
  resetAfter?: number;
}

export interface SearchTask {
  visibility: Visibility;
  method: string;
  domain: string;
  apexDomain: string;
  time: string;
  uuid: string;
  url: string;
  tags?: string[];
  [key: string]: unknown;
}

export interface SearchPage {
  country?: string;
  server?: string;
  ip?: string;
  asn?: string;
  asnname?: string;
  domain?: string;
  apexDomain?: string;
  url?: string;
  title?: string;
  status?: string;
  mimeType?: string;
  tlsIssuer?: string;
  tlsValidDays?: number;
  domainAgeDays?: number;
  [key: string]: unknown;
}

export interface SearchResult {
  _id: string;
  _score: number | null;
  task: SearchTask;
  page: SearchPage;
  stats?: Record<string, number>;
  /** Values to pass as `searchAfter` to get the next page. */
  sort: Array<string | number>;
  /** API URL of the full result. */
  result: string;
  /** URL of the PNG screenshot. */
  screenshot: string;
  [key: string]: unknown;
}

export interface SearchResponse {
  results: SearchResult[];
  total: number;
  took: number;
  has_more: boolean;
  search_date_limit_days?: number;
  rateLimit: RateLimit;
}

export interface SearchOptions {
  /** Results per page. urlscan caps this by plan. */
  size?: number;
  /** The `sort` array of the last result of the previous page. */
  searchAfter?: Array<string | number>;
  signal?: AbortSignal;
}

export interface SubmitOptions {
  visibility?: Visibility;
  tags?: string[];
  customagent?: string;
  referer?: string;
  /** Two letter country code for the scanning location. */
  country?: string;
  signal?: AbortSignal;
}

export interface SubmitResponse {
  message: string;
  uuid: string;
  result: string;
  api: string;
  visibility: Visibility;
  url: string;
  country?: string;
  rateLimit: RateLimit;
}

export interface ClientOptions {
  apiKey?: string;
  baseUrl?: string;
  /** Retries for 5xx, network errors and short 429 waits. Default 2. */
  retries?: number;
  /** Base backoff in ms. Default 500. */
  backoffMs?: number;
  /** Longest 429 wait the client will sleep through, in seconds. Default 60. */
  maxRateLimitWaitS?: number;
  timeoutMs?: number;
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  userAgent?: string;
}

export class UrlscanError extends Error {
  readonly status: number;
  readonly body: unknown;
  constructor(message: string, status: number, body?: unknown) {
    super(message);
    this.name = "UrlscanError";
    this.status = status;
    this.body = body;
  }
}

/** HTTP 401 or 403, usually a missing or wrong API key. */
export class AuthError extends UrlscanError {
  constructor(message: string, status: number, body?: unknown) {
    super(message, status, body);
    this.name = "AuthError";
  }
}

/** HTTP 404, for a result this usually means the scan is still running. */
export class NotFoundError extends UrlscanError {
  constructor(message: string, status: number, body?: unknown) {
    super(message, status, body);
    this.name = "NotFoundError";
  }
}

export class RateLimitError extends UrlscanError {
  readonly rateLimit: RateLimit;
  constructor(message: string, status: number, rateLimit: RateLimit, body?: unknown) {
    super(message, status, body);
    this.name = "RateLimitError";
    this.rateLimit = rateLimit;
  }
}

function num(v: string | null): number | undefined {
  if (v === null || v === "") return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

export function readRateLimit(headers: Headers): RateLimit {
  return {
    scope: headers.get("x-rate-limit-scope") ?? undefined,
    action: headers.get("x-rate-limit-action") ?? undefined,
    window: headers.get("x-rate-limit-window") ?? undefined,
    limit: num(headers.get("x-rate-limit-limit")),
    remaining: num(headers.get("x-rate-limit-remaining")),
    reset: headers.get("x-rate-limit-reset") ?? undefined,
    resetAfter: num(headers.get("x-rate-limit-reset-after")),
  };
}

function errorMessage(body: unknown, status: number): string {
  if (body && typeof body === "object") {
    const b = body as Record<string, unknown>;
    if (typeof b.message === "string") return b.message;
    if (typeof b.description === "string") return b.description;
    if (typeof b.warning === "string") return b.warning;
  }
  return `HTTP ${status}`;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function checkUuid(uuid: string): string {
  if (!UUID_RE.test(uuid)) throw new TypeError(`not a urlscan UUID: ${uuid}`);
  return uuid.toLowerCase();
}

export class UrlscanClient {
  private readonly apiKey?: string;
  private readonly baseUrl: string;
  private readonly retries: number;
  private readonly backoffMs: number;
  private readonly maxRateLimitWaitS: number;
  private readonly timeoutMs: number;
  private readonly fetchFn: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly userAgent: string;

  constructor(options: ClientOptions = {}) {
    this.apiKey = options.apiKey;
    this.baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
    this.retries = Math.max(0, options.retries ?? 2);
    this.backoffMs = options.backoffMs ?? 500;
    this.maxRateLimitWaitS = options.maxRateLimitWaitS ?? 60;
    this.timeoutMs = options.timeoutMs ?? 30_000;
    this.fetchFn = options.fetch ?? globalThis.fetch.bind(globalThis);
    this.sleep = options.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.userAgent = options.userAgent ?? USER_AGENT;
  }

  /** Elasticsearch query string search, for example `page.domain:example.com AND date:>now-7d`. */
  async search(query: string, options: SearchOptions = {}): Promise<SearchResponse> {
    if (!query.trim()) throw new TypeError("query must not be empty");
    const params = new URLSearchParams({ q: query });
    if (options.size !== undefined) params.set("size", String(options.size));
    if (options.searchAfter?.length) params.set("search_after", options.searchAfter.join(","));
    const { body, rateLimit } = await this.request<Omit<SearchResponse, "rateLimit">>(
      "GET",
      `/api/v1/search/?${params}`,
      undefined,
      options.signal,
    );
    return { ...body, rateLimit };
  }

  /** Walks every page of a search with `search_after`, up to `limit` results. */
  async *searchAll(query: string, options: SearchOptions & { limit?: number } = {}): AsyncGenerator<SearchResult> {
    const limit = options.limit ?? Infinity;
    let searchAfter = options.searchAfter;
    let seen = 0;
    while (seen < limit) {
      const page = await this.search(query, { size: options.size, searchAfter, signal: options.signal });
      for (const r of page.results) {
        if (seen >= limit) return;
        seen += 1;
        yield r;
      }
      const last = page.results[page.results.length - 1];
      if (!last) return;
      // has_more stays false on anonymous searches even when more pages exist,
      // so a full page is also taken as a sign to keep going.
      const fullPage = page.results.length >= (options.size ?? 100);
      if (!page.has_more && !fullPage) return;
      searchAfter = last.sort;
    }
  }

  /** Full scan result. Needs an API key. Throws NotFoundError while the scan is running. */
  async result<T = Record<string, unknown>>(uuid: string, signal?: AbortSignal): Promise<T> {
    const { body } = await this.request<T>("GET", `/api/v1/result/${checkUuid(uuid)}/`, undefined, signal);
    return body;
  }

  /** Submit a URL for scanning. Needs an API key. */
  async submit(url: string, options: SubmitOptions = {}): Promise<SubmitResponse> {
    this.requireKey("submit");
    const { signal, ...fields } = options;
    const { body, rateLimit } = await this.request<Omit<SubmitResponse, "rateLimit">>(
      "POST",
      "/api/v1/scan/",
      { url, ...fields },
      signal,
    );
    return { ...body, rateLimit };
  }

  /** Polls the result endpoint until the scan is ready, as the docs advise (wait, then poll every few seconds). */
  async waitForResult<T = Record<string, unknown>>(
    uuid: string,
    opts: { initialDelayMs?: number; intervalMs?: number; timeoutMs?: number; signal?: AbortSignal } = {},
  ): Promise<T> {
    const interval = opts.intervalMs ?? 2_000;
    const deadline = Date.now() + (opts.timeoutMs ?? 120_000);
    await this.sleep(opts.initialDelayMs ?? 10_000);
    for (;;) {
      try {
        return await this.result<T>(uuid, opts.signal);
      } catch (err) {
        if (!(err instanceof NotFoundError) || Date.now() + interval > deadline) throw err;
        await this.sleep(interval);
      }
    }
  }

  /** Current quotas for the key. Needs an API key. */
  async quotas(signal?: AbortSignal): Promise<Record<string, unknown>> {
    this.requireKey("quotas");
    const { body } = await this.request<Record<string, unknown>>("GET", "/user/quotas/", undefined, signal);
    return body;
  }

  screenshotUrl(uuid: string): string {
    return `${this.baseUrl}/screenshots/${checkUuid(uuid)}.png`;
  }

  domUrl(uuid: string): string {
    return `${this.baseUrl}/dom/${checkUuid(uuid)}/`;
  }

  private requireKey(action: string): void {
    if (!this.apiKey) throw new AuthError(`${action} needs an API key, pass { apiKey } to UrlscanClient`, 401);
  }

  private async request<T>(
    method: "GET" | "POST",
    path: string,
    json?: unknown,
    signal?: AbortSignal,
  ): Promise<{ body: T; rateLimit: RateLimit }> {
    const headers: Record<string, string> = { Accept: "application/json", "User-Agent": this.userAgent };
    if (this.apiKey) headers["API-Key"] = this.apiKey;
    if (json !== undefined) headers["Content-Type"] = "application/json";

    for (let attempt = 0; ; attempt++) {
      let res: Response;
      try {
        const timeout = AbortSignal.timeout(this.timeoutMs);
        res = await this.fetchFn(this.baseUrl + path, {
          method,
          headers,
          body: json === undefined ? undefined : JSON.stringify(json),
          signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
        });
      } catch (err) {
        if (signal?.aborted) throw err;
        if (attempt < this.retries) {
          await this.sleep(this.backoffMs * 2 ** attempt);
          continue;
        }
        throw new UrlscanError(`request failed: ${(err as Error).message}`, 0);
      }

      const rateLimit = readRateLimit(res.headers);
      const text = await res.text();
      let body: unknown = undefined;
      try {
        body = text ? JSON.parse(text) : undefined;
      } catch {
        body = text;
      }

      if (res.ok) return { body: body as T, rateLimit };

      if (res.status === 429) {
        const wait = rateLimit.resetAfter ?? Number(res.headers.get("retry-after") ?? NaN);
        if (attempt < this.retries && Number.isFinite(wait) && wait <= this.maxRateLimitWaitS) {
          await this.sleep(Math.max(wait, 1) * 1000);
          continue;
        }
        throw new RateLimitError(errorMessage(body, 429), 429, rateLimit, body);
      }
      if (res.status >= 500 && attempt < this.retries) {
        await this.sleep(this.backoffMs * 2 ** attempt);
        continue;
      }
      const message = errorMessage(body, res.status);
      if (res.status === 401 || res.status === 403) throw new AuthError(message, res.status, body);
      if (res.status === 404) throw new NotFoundError(message, res.status, body);
      throw new UrlscanError(message, res.status, body);
    }
  }
}
