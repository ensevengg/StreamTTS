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
