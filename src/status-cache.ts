const FRESH_MS = 60_000;
const RETAIN_SECONDS = 24 * 60 * 60;

type Snapshot<T> = { data: T; updatedAt: number };
type Failure = { code: string; message: string; retryAt: number };
type CacheStore = Pick<Cache, 'match' | 'put'>;

export function databaseFailure(error: unknown, now = Date.now()): Failure {
  const quota = /(?:daily.*(?:limit|quota)|exceeded.*free tier)/i.test(String(error));
  return quota
    ? { code: 'D1_DAILY_LIMIT', message: 'Monitoring data is temporarily unavailable because the daily database quota has been reached.', retryAt: Math.floor(now / 86400000) * 86400000 + 86400000 + 10000 }
    : { code: 'STATUS_UNAVAILABLE', message: 'Monitoring data is temporarily unavailable. Please try again shortly.', retryAt: now + 60_000 };
}

// Cache API storage is shared inside a Cloudflare location, not globally.
// In-flight coalescing is scoped to this Worker isolate.
export class StatusCache {
  private pending = new Map<string, Promise<Response>>();
  private failures = new Map<string, Failure>();

  async get<T>(key: string, cache: CacheStore, load: () => Promise<T>): Promise<Response> {
    const pending = this.pending.get(key);
    if (pending) return (await pending).clone();
    const task = this.resolve(key, cache, load);
    this.pending.set(key, task);
    try { return (await task).clone(); }
    finally { this.pending.delete(key); }
  }

  private async read<T>(cache: CacheStore, key: string): Promise<T | undefined> {
    try { return await (await cache.match(key))?.json<T>(); }
    catch { return undefined; }
  }

  private async put(cache: CacheStore, key: string, value: unknown, ttl: number) {
    try {
      await cache.put(key, new Response(JSON.stringify(value), {
        headers: { 'Content-Type': 'application/json', 'Cache-Control': `public, max-age=${ttl}` },
      }));
    } catch { console.warn(JSON.stringify({ event: 'status_cache_write_failed' })); }
  }

  private response<T>(snapshot: Snapshot<T> | undefined, failure?: Failure, hit = false): Response {
    const headers: Record<string, string> = { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' };
    if (failure) {
      headers['Retry-After'] = String(Math.max(1, Math.ceil((failure.retryAt - Date.now()) / 1000)));
      headers['X-Status-Error'] = failure.code;
    }
    if (snapshot) {
      headers['X-Status-Updated-At'] = String(snapshot.updatedAt);
      headers['X-Status-Stale'] = failure ? 'true' : 'false';
      headers['X-Status-Cache'] = failure ? 'STALE' : hit ? 'HIT' : 'MISS';
      return new Response(JSON.stringify(snapshot.data), { headers });
    }
    return new Response(JSON.stringify({ error: failure?.code, message: failure?.message, retryAt: failure?.retryAt }), { status: 503, headers });
  }

  private async resolve<T>(key: string, cache: CacheStore, load: () => Promise<T>): Promise<Response> {
    const now = Date.now();
    const stored = await this.read<Snapshot<T>>(cache, key);
    const snapshot = stored && Number.isFinite(stored.updatedAt) && now - stored.updatedAt < RETAIN_SECONDS * 1000 ? stored : undefined;
    if (snapshot && now - snapshot.updatedAt < FRESH_MS) return this.response(snapshot, undefined, true);
    const failureKey = key + '&failure=1';
    const failure = this.failures.get(key) || await this.read<Failure>(cache, failureKey);
    if (failure && failure.retryAt > now) return this.response(snapshot, failure);
    this.failures.delete(key);
    try {
      const data = await load();
      const fresh = { data, updatedAt: Date.now() };
      await this.put(cache, key, fresh, RETAIN_SECONDS);
      return this.response(fresh);
    } catch (error) {
      const unavailable = databaseFailure(error);
      // Bound local failure memory; edge storage remains the shared backoff.
      if (this.failures.size >= 100) this.failures.clear();
      this.failures.set(key, unavailable);
      console.error(JSON.stringify({ event: 'status_unavailable', code: unavailable.code, retryAt: unavailable.retryAt }));
      await this.put(cache, failureKey, unavailable, Math.max(1, Math.ceil((unavailable.retryAt - Date.now()) / 1000)));
      return this.response(snapshot, unavailable);
    }
  }
}
