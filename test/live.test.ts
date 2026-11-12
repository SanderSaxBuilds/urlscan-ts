// Live checks against urlscan.io search, which works without a key.
// Skipped unless URLSCAN_LIVE=1.
import { test } from "node:test";
import assert from "node:assert/strict";
import { UrlscanClient } from "../src/index.ts";

const live = process.env.URLSCAN_LIVE === "1";
const c = new UrlscanClient({ apiKey: process.env.URLSCAN_API_KEY });

test("live search returns public results with rate limit info", { skip: !live }, async () => {
  const res = await c.search("page.domain:example.com", { size: 2 });
  assert.ok(res.total > 0);
  assert.ok(res.results.length <= 2);
  assert.equal(res.rateLimit.action, "search");
  assert.ok(typeof res.rateLimit.remaining === "number");
});

test("live searchAll pages through results", { skip: !live }, async () => {
  const ids = new Set<string>();
  for await (const r of c.searchAll("page.domain:example.com", { size: 2, limit: 4 })) ids.add(r._id);
  assert.equal(ids.size, 4);
});

test("live screenshot URL serves a PNG", { skip: !live }, async () => {
  const res = await c.search("page.domain:example.com", { size: 1 });
  const png = await fetch(c.screenshotUrl(res.results[0].task.uuid));
  assert.equal(png.status, 200);
  assert.match(png.headers.get("content-type") ?? "", /image\/png/);
});
