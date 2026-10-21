import { describe, it, expect } from 'vitest';
import { stripCommandPrefix } from './ttsFilter';

describe('stripCommandPrefix', () => {
  it('removes the command and following space', () => {
    expect(stripCommandPrefix('!г Привет')).toBe('Привет');
    expect(stripCommandPrefix('Привет')).toBe('Привет');
  });
});
