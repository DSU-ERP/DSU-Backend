// Small in-process TTL cache with a size cap (oldest entries evicted first).
//
// The backend runs as ONE Render instance, so an in-memory cache is coherent:
// every write that changes a cached value invalidates it in the same process.
// If the service is ever scaled to several instances, move these caches to the
// shared Redis or shorten their TTLs, because another instance's writes would
// not invalidate this one.
//
// ttlMs may be a function, read on every write, so a deployment setting can
// turn a cache off (0) without code changes. With a TTL of 0 nothing is
// stored and concurrent loads are not shared: behaviour is exactly uncached.
/** Identity caches (/session, student record): IDENTITY_CACHE_MS, unset = off. */
export const identityCacheMs = () => Number(process.env.IDENTITY_CACHE_MS || 0);

export function ttlCache({ ttlMs, max = 5000 }) {
  const ttl = () => Math.max(0, Number(typeof ttlMs === "function" ? ttlMs() : ttlMs) || 0);
  const entries = new Map();
  const inflight = new Map();
  const get = (key) => {
    const hit = entries.get(key);
    if (!hit) return undefined;
    if (hit.expires <= Date.now()) {
      entries.delete(key);
      return undefined;
    }
    return hit.value;
  };
  const set = (key, value) => {
    entries.delete(key);
    if (!ttl()) return value;
    entries.set(key, { value, expires: Date.now() + ttl() });
    while (entries.size > max) entries.delete(entries.keys().next().value);
    return value;
  };
  return {
    get,
    set,
    delete: (key) => {
      entries.delete(key);
      inflight.delete(key);
    },
    clear: () => {
      entries.clear();
      inflight.clear();
    },
    /** Returns the cached value or loads it once, sharing a concurrent load. */
    async wrap(key, load) {
      if (!ttl()) return load();
      const hit = get(key);
      if (hit !== undefined) return hit;
      if (inflight.has(key)) return inflight.get(key);
      const pending = (async () => {
        try {
          const value = await load();
          if (inflight.get(key) === pending) set(key, value);
          return value;
        } finally {
          if (inflight.get(key) === pending) inflight.delete(key);
        }
      })();
      inflight.set(key, pending);
      return pending;
    },
  };
}
