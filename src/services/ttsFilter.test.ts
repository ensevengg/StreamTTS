import { describe, it, expect } from 'vitest';
import { CooldownTracker, prepareSpeechText } from './ttsFilter';

describe('prepareSpeechText', () => {
  it('reads links as the word "link"', () => {
    expect(prepareSpeechText('смотри https://evil.example/x?y=1 сейчас', 200)).toBe('смотри link сейчас');
    expect(prepareSpeechText('www.example.com', 200)).toBe('link');
  });

  it('caps length on a word boundary', () => {
    const result = prepareSpeechText('один два три четыре пять шесть', 20);
    expect(result).toBe('один два три четыре…');
  });
});

describe('CooldownTracker', () => {
  it('blocks a viewer inside the cooldown and allows them after it', () => {
    const tracker = new CooldownTracker();
    expect(tracker.allow('Viewer', 10_000, 0)).toBe(true);
    expect(tracker.allow('viewer', 10_000, 5_000)).toBe(false);
    expect(tracker.allow('viewer', 10_000, 10_000)).toBe(true);
  });
});
