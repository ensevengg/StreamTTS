import { describe, it, expect } from 'vitest';
import { backoffDelay } from './resilience';

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
