import test from "node:test";
import assert from "node:assert/strict";
import { ttlCache } from "../src/platform/cache/ttl.js";

test("ttl cache shares concurrent loads, expires entries and caps its size", async () => {
  const cache = ttlCache({ ttlMs: 20, max: 2 });
  let loads = 0;
  const load = async () => { loads++; await new Promise((r) => setTimeout(r, 5)); return "v" + loads; };
  const [a, b] = await Promise.all([cache.wrap("k", load), cache.wrap("k", load)]);
  assert.equal(a, "v1"); assert.equal(b, "v1"); assert.equal(loads, 1, "one load for concurrent callers");
  assert.equal(await cache.wrap("k", load), "v1", "served from cache");
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(await cache.wrap("k", load), "v2", "reloaded after expiry");
  cache.set("x", 1); cache.set("y", 2);
  assert.equal(cache.get("k"), undefined, "oldest entry evicted at the size cap");
});

test("deleting a key during a load keeps the stale result out of the cache", async () => {
  const cache = ttlCache({ ttlMs: 1000 });
  let release;
  const pending = cache.wrap("k", () => new Promise((r) => (release = r)));
  cache.delete("k");
  release("stale");
  assert.equal(await pending, "stale");
  assert.equal(cache.get("k"), undefined);
});

test("a TTL of 0 means uncached: every call loads", async () => {
  const cache = ttlCache({ ttlMs: () => 0 });
  let loads = 0;
  await cache.wrap("k", async () => ++loads);
  await cache.wrap("k", async () => ++loads);
  assert.equal(loads, 2);
  assert.equal(cache.set("k", 1), 1);
  assert.equal(cache.get("k"), undefined);
});
