// Tests against responses recorded from urlscan.io on 12 Nov 2026.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  AuthError,
  NotFoundError,
  RateLimitError,
  UrlscanClient,
  UrlscanError,
  type SearchResult,
} from "../src/index.ts";

interface Fixture {
  status: number;
  headers: Record<string, string>;
  body: unknown;
}

const load = (name: string): Fixture =>
  JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), "utf8"));

type Item = Fixture | Error;

function fakeFetch(...items: Item[]) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fn = (async (url: string | URL | Request, init: RequestInit = {}) => {
    calls.push({ url: String(url), init });
    const item = items.shift();
    if (!item) throw new Error("no more recorded responses");
    if (item instanceof Error) throw item;
    return new Response(JSON.stringify(item.body), { status: item.status, headers: item.headers });
  }) as typeof fetch;
  return { fn, calls };
}

const sleeps: number[] = [];
function client(items: Item[], extra: Record<string, unknown> = {}) {
  const f = fakeFetch(...items);
  sleeps.length = 0;
  const c = new UrlscanClient({ fetch: f.fn, sleep: async (ms) => void sleeps.push(ms), ...extra });
  return { c, calls: f.calls };
}

test("search parses the recorded response", async () => {
  const { c, calls } = client([load("search")]);
  const res = await c.search("page.domain:example.com", { size: 3 });
  assert.equal(res.total, 2375);
  assert.equal(res.has_more, false);
  assert.equal(res.results.length, 3);
  const first = res.results[0];
  assert.match(first.task.uuid, /^[0-9a-f-]{36}$/);
  assert.equal(first.task.visibility, "public");
  assert.ok(first.screenshot.endsWith(".png"));
  assert.equal(first.sort.length, 2);
  const u = new URL(calls[0].url);
  assert.equal(u.pathname, "/api/v1/search/");
  assert.equal(u.searchParams.get("q"), "page.domain:example.com");
  assert.equal(u.searchParams.get("size"), "3");
});

test("search reads the rate limit headers", async () => {
  const { c } = client([load("search")]);
  const { rateLimit } = await c.search("page.domain:example.com");
  assert.equal(rateLimit.scope, "ip-address");
  assert.equal(rateLimit.action, "search");
  assert.equal(rateLimit.window, "minute");
  assert.equal(rateLimit.limit, 30);
  assert.equal(rateLimit.remaining, 29);
  assert.equal(rateLimit.resetAfter, 38);
});

test("search without a key sends no API-Key header, with a key it does", async () => {
  const a = client([load("search")]);
  await a.c.search("x");
  assert.equal((a.calls[0].init.headers as Record<string, string>)["API-Key"], undefined);
  const b = client([load("search")], { apiKey: "k" });
  await b.c.search("x");
  assert.equal((b.calls[0].init.headers as Record<string, string>)["API-Key"], "k");
});

test("a bad query raises UrlscanError with the parser message", async () => {
  const { c } = client([load("bad")]);
  await assert.rejects(c.search("page.domain:("), (err: unknown) => {
    assert.ok(err instanceof UrlscanError);
    assert.equal(err.status, 400);
    assert.match(err.message, /^Expected/);
    return true;
  });
});

test("result without a key raises AuthError from the recorded 403", async () => {
  const { c } = client([load("res")]);
  await assert.rejects(c.result("01a1d0f3-7901-76c9-8361-00630ad3b19f"), (err: unknown) => {
    assert.ok(err instanceof AuthError);
    assert.equal(err.status, 403);
    assert.equal(err.message, "You're not logged in!");
    return true;
  });
});

test("searchAll follows search_after while pages are full, then stops on a short page", async () => {
  // Anonymous searches return has_more false even when more pages exist, as recorded.
  const rec = load("search") as Fixture & { body: { results: SearchResult[] } };
  const page1 = structuredClone(rec);
  page1.body.results = rec.body.results.slice(0, 2);
  const page2 = structuredClone(rec);
  page2.body.results = rec.body.results.slice(2);
  const { c, calls } = client([page1, page2]);
  const uuids: string[] = [];
  for await (const r of c.searchAll("page.domain:example.com", { size: 2 })) uuids.push(r.task.uuid);
  assert.equal(uuids.length, 3);
  assert.equal(calls.length, 2);
  const sa = new URL(calls[1].url).searchParams.get("search_after");
  assert.equal(sa, rec.body.results[1].sort.join(","));
});

test("searchAll stops when has_more is true but a page comes back empty", async () => {
  const empty = { status: 200, headers: {}, body: { results: [], total: 0, took: 1, has_more: true } };
  const { c, calls } = client([empty]);
  const got: string[] = [];
  for await (const r of c.searchAll("x")) got.push(r._id);
  assert.equal(got.length, 0);
  assert.equal(calls.length, 1);
});

test("searchAll respects limit", async () => {
  const { c, calls } = client([load("search")]);
  const got: string[] = [];
  for await (const r of c.searchAll("x", { limit: 2 })) got.push(r._id);
  assert.equal(got.length, 2);
  assert.equal(calls.length, 1);
});

test("5xx is retried with backoff, then succeeds", async () => {
  const busy = { status: 503, headers: {}, body: { message: "busy" } };
  const { c, calls } = client([busy, load("search")]);
  const res = await c.search("x");
  assert.equal(res.total, 2375);
  assert.equal(calls.length, 2);
  assert.deepEqual(sleeps, [500]);
});

test("network errors are retried and then reported", async () => {
  const { c, calls } = client([new TypeError("fetch failed"), new TypeError("fetch failed"), new TypeError("fetch failed")]);
  await assert.rejects(c.search("x"), /request failed: fetch failed/);
  assert.equal(calls.length, 3);
});

test("429 with a short reset waits and retries", async () => {
  const limited = {
    status: 429,
    headers: { "x-rate-limit-limit": "30", "x-rate-limit-remaining": "0", "x-rate-limit-reset-after": "4" },
    body: { message: "Rate limit exceeded", status: 429 },
  };
  const { c, calls } = client([limited, load("search")]);
  await c.search("x");
  assert.equal(calls.length, 2);
  assert.deepEqual(sleeps, [4000]);
});

test("429 with a long reset raises RateLimitError without waiting", async () => {
  const limited = {
    status: 429,
    headers: { "x-rate-limit-window": "day", "x-rate-limit-remaining": "0", "x-rate-limit-reset-after": "3600" },
    body: { message: "Rate limit exceeded", status: 429 },
  };
  const { c } = client([limited]);
  await assert.rejects(c.search("x"), (err: unknown) => {
    assert.ok(err instanceof RateLimitError);
    assert.equal(err.rateLimit.window, "day");
    assert.equal(err.rateLimit.resetAfter, 3600);
    return true;
  });
  assert.deepEqual(sleeps, []);
});

test("submit needs a key and sends the documented JSON body", async () => {
  const noKey = client([]);
  await assert.rejects(noKey.c.submit("https://example.com"), AuthError);
  const ok = {
    status: 200,
    headers: {},
    body: {
      message: "Submission successful",
      uuid: "0e37e828-a9d9-45c0-ac50-1ca579b86c72",
      result: "https://urlscan.io/result/0e37e828-a9d9-45c0-ac50-1ca579b86c72/",
      api: "https://urlscan.io/api/v1/result/0e37e828-a9d9-45c0-ac50-1ca579b86c72/",
      visibility: "unlisted",
      url: "https://example.com",
    },
  };
  const { c, calls } = client([ok], { apiKey: "k" });
  const res = await c.submit("https://example.com", { visibility: "unlisted", tags: ["demo"] });
  assert.equal(res.uuid, "0e37e828-a9d9-45c0-ac50-1ca579b86c72");
  assert.equal(calls[0].init.method, "POST");
  assert.deepEqual(JSON.parse(String(calls[0].init.body)), { url: "https://example.com", visibility: "unlisted", tags: ["demo"] });
});

test("waitForResult polls through 404 until the result is ready", async () => {
  const pending = { status: 404, headers: {}, body: { message: "Scan is not finished yet", status: 404 } };
  const done = { status: 200, headers: {}, body: { task: { uuid: "0e37e828-a9d9-45c0-ac50-1ca579b86c72" } } };
  const { c, calls } = client([pending, pending, done], { apiKey: "k" });
  const res = await c.waitForResult<{ task: { uuid: string } }>("0e37e828-a9d9-45c0-ac50-1ca579b86c72", {
    initialDelayMs: 10,
    intervalMs: 5,
  });
  assert.equal(res.task.uuid, "0e37e828-a9d9-45c0-ac50-1ca579b86c72");
  assert.equal(calls.length, 3);
  assert.deepEqual(sleeps, [10, 5, 5]);
});

test("a 404 from result is a NotFoundError", async () => {
  const { c } = client([{ status: 404, headers: {}, body: { message: "Not found", status: 404 } }], { apiKey: "k" });
  await assert.rejects(c.result("0e37e828-a9d9-45c0-ac50-1ca579b86c72"), NotFoundError);
});

test("screenshot and DOM URLs are built and UUIDs are checked", () => {
  const c = new UrlscanClient();
  assert.equal(
    c.screenshotUrl("01A1D0F3-7901-76C9-8361-00630AD3B19F"),
    "https://urlscan.io/screenshots/01a1d0f3-7901-76c9-8361-00630ad3b19f.png",
  );
  assert.equal(c.domUrl("01a1d0f3-7901-76c9-8361-00630ad3b19f"), "https://urlscan.io/dom/01a1d0f3-7901-76c9-8361-00630ad3b19f/");
  assert.throws(() => c.screenshotUrl("../etc"), TypeError);
});

test("empty query is rejected before any request", async () => {
  const { c, calls } = client([]);
  await assert.rejects(c.search("  "), TypeError);
  assert.equal(calls.length, 0);
});
