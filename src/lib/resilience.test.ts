import { describe, it, expect } from 'vitest';
import { backoffDelay, BoundedSet } from './resilience';

describe('backoffDelay', () => {
  it('doubles per attempt within the jitter band', () => {
    expect(backoffDelay(1, {}, () => 0)).toBe(500);
    expect(backoffDelay(1, {}, () => 1)).toBe(1000);
    expect(backoffDelay(3, {}, () => 1)).toBe(4000);
  });

  it('never exceeds the cap, however many attempts', () => {
    for (let attempt = 1; attempt < 50; attempt++) {
      expect(backoffDelay(attempt, { maxMs: 30_000 })).toBeLessThanOrEqual(30_000);
    }
  });
});

describe('BoundedSet', () => {
  it('reports duplicates', () => {
    const set = new BoundedSet<string>(10);
    expect(set.add('a')).toBe(true);
    expect(set.add('a')).toBe(false);
  });

  it('forgets the oldest entries past its limit', () => {
    const set = new BoundedSet<number>(3);
    [1, 2, 3, 4].forEach(n => set.add(n));
    expect(set.size).toBe(3);
    expect(set.has(1)).toBe(false);
    expect(set.has(4)).toBe(true);
  });
});
