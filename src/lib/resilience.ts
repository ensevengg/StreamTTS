/**
 * Exponential backoff with jitter for reconnects: attempt 1 waits about
 * `baseMs`, doubling up to `maxMs`. The random half spreads reconnects out so
 * a dropped connection doesn't retry in lockstep.
 */
export function backoffDelay(
  attempt: number,
  { baseMs = 1000, maxMs = 30_000 }: { baseMs?: number; maxMs?: number } = {},
  random: () => number = Math.random,
): number {
  const ceiling = Math.min(maxMs, baseMs * 2 ** Math.max(0, attempt - 1));
  return Math.round(ceiling / 2 + (random() * ceiling) / 2);
}

/** Set that forgets its oldest entries past `limit`; for message de-duplication. */
export class BoundedSet<T> {
  private readonly items = new Set<T>();

  constructor(private readonly limit: number) {}

  has(item: T): boolean {
    return this.items.has(item);
  }

  /** Adds the item; returns false if it was already present. */
  add(item: T): boolean {
    if (this.items.has(item)) return false;
    this.items.add(item);
    if (this.items.size > this.limit) {
      const oldest = this.items.values().next().value as T;
      this.items.delete(oldest);
    }
    return true;
  }

  get size(): number {
    return this.items.size;
  }
}
