# urlscan-ts

A small typed TypeScript client for the [urlscan.io API](https://urlscan.io/docs/api/). Search works without a key. Scan submission, full results and quotas use your API key.

No runtime dependencies, it uses the global `fetch` (Node 22.6+, Deno, Bun, browsers).

## Install

```bash
npm install github:SanderSaxBuilds/urlscan-ts
```

## Usage

```ts
import { UrlscanClient } from "urlscan-ts";

const urlscan = new UrlscanClient(); // or new UrlscanClient({ apiKey: process.env.URLSCAN_API_KEY })

// Search, no key needed
const res = await urlscan.search("page.domain:example.com AND date:>now-7d", { size: 10 });
for (const r of res.results) {
  console.log(r.task.time, r.task.url, r.page.ip, r.page.asnname);
}
console.log(res.rateLimit.remaining, "searches left this", res.rateLimit.window);

// Walk every page with search_after
for await (const r of urlscan.searchAll("page.domain:example.com", { size: 100, limit: 500 })) {
  console.log(r.task.uuid);
}

// Screenshot and DOM links for any public scan
urlscan.screenshotUrl(res.results[0].task.uuid);
urlscan.domUrl(res.results[0].task.uuid);
```

With an API key:

```ts
const urlscan = new UrlscanClient({ apiKey: process.env.URLSCAN_API_KEY });

const scan = await urlscan.submit("https://example.com", { visibility: "unlisted", tags: ["triage"] });
const result = await urlscan.waitForResult(scan.uuid); // waits 10 s, then polls every 2 s until ready
console.log(result);
```

## Errors, retries and rate limits

- `UrlscanError` has `status` and the parsed `body`. Subclasses: `AuthError` (401, 403, or a key-only call made without a key), `NotFoundError` (404, a scan still running), `RateLimitError` (429, with the parsed `rateLimit`).
- 5xx responses and network errors are retried with exponential backoff (`retries: 2`, `backoffMs: 500`).
- A 429 is retried once its `X-Rate-Limit-Reset-After` is short (60 s or less by default, `maxRateLimitWaitS`). Longer waits raise `RateLimitError` right away.
- Every search and submit response carries `rateLimit`, read from the `X-Rate-Limit-*` headers.
- Anonymous searches return `has_more: false` even when more pages exist, so `searchAll` also keeps going while pages come back full.

## Tests

```bash
npm install
npm test                    # 17 tests, on responses recorded from urlscan.io and error cases
URLSCAN_LIVE=1 npm test     # adds 3 tests against the live search and screenshot endpoints
npm run typecheck
```

## License

MIT
