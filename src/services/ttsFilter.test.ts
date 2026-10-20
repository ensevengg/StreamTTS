import { describe, it, expect } from 'vitest';
import { CooldownTracker, parseTtsCommand, prepareSpeechText, stripCommandPrefix } from './ttsFilter';

describe('parseTtsCommand', () => {
  it('reads !г in Russian and !r in English', () => {
    expect(parseTtsCommand('!г Привет')).toEqual({ language: 'ru', text: 'Привет' });
    expect(parseTtsCommand('!r Hello there')).toEqual({ language: 'en', text: 'Hello there' });
  });

  it('ignores case and surrounding spaces', () => {
    expect(parseTtsCommand('!Г  Привет')).toEqual({ language: 'ru', text: 'Привет' });
    expect(parseTtsCommand('  !R hello')).toEqual({ language: 'en', text: 'hello' });
  });

  it('does not fire on other commands that start the same way', () => {
    for (const message of ['!rules', '!raid now', '!rank', '!гг', '!rHello']) {
      expect(parseTtsCommand(message)).toBeNull();
    }
  });

  it('needs the command at the start', () => {
    expect(parseTtsCommand('hello !r there')).toBeNull();
    expect(parseTtsCommand('Привет')).toBeNull();
  });

  it('accepts a bare command, with nothing to read', () => {
    expect(parseTtsCommand('!r')).toEqual({ language: 'en', text: '' });
  });
});

describe('stripCommandPrefix', () => {
  it('removes the command and following space', () => {
    expect(stripCommandPrefix('!г Привет')).toBe('Привет');
    expect(stripCommandPrefix('!r Hello')).toBe('Hello');
    expect(stripCommandPrefix('Привет')).toBe('Привет');
  });
});

describe('prepareSpeechText', () => {
  it('reads links as the word "link"', () => {
    expect(prepareSpeechText('смотри https://evil.example/x?y=1 сейчас', 200)).toBe('смотри link сейчас');
    expect(prepareSpeechText('www.example.com', 200)).toBe('link');
  });

  it('strips invisible and bidi-override characters', () => {
    expect(prepareSpeechText('при\u200bвет\u202e', 200)).toBe('при вет');
  });

  it('collapses character spam', () => {
    expect(prepareSpeechText('аааааааааа!!!!!!!', 200)).toBe('ааа!!!');
  });

  it('caps length on a word boundary', () => {
    const result = prepareSpeechText('один два три четыре пять шесть', 20);
    expect(result).toBe('один два три четыре…');
  });

  it('does not split emoji when truncating', () => {
    const result = prepareSpeechText('😀'.repeat(10), 5) as string;
    expect(Array.from(result.replace('…', '')).every(ch => ch === '😀')).toBe(true);
  });

  it('returns null when nothing speakable is left', () => {
    expect(prepareSpeechText('   \u200b  ', 200)).toBeNull();
  });
});

describe('CooldownTracker', () => {
  it('blocks a viewer inside the cooldown and allows them after it', () => {
    const tracker = new CooldownTracker();
    expect(tracker.allow('Viewer', 10_000, 0)).toBe(true);
    expect(tracker.allow('viewer', 10_000, 5_000)).toBe(false);
    expect(tracker.allow('viewer', 10_000, 10_000)).toBe(true);
  });

  it('tracks viewers independently and can be disabled', () => {
    const tracker = new CooldownTracker();
    expect(tracker.allow('a', 10_000, 0)).toBe(true);
    expect(tracker.allow('b', 10_000, 1)).toBe(true);
    expect(tracker.allow('a', 0, 2)).toBe(true);
  });

  it('stays bounded', () => {
    const tracker = new CooldownTracker(2);
    tracker.allow('a', 10_000, 0);
    tracker.allow('b', 10_000, 0);
    tracker.allow('c', 10_000, 0);
    // 'a' was evicted, so it is no longer cooling down.
    expect(tracker.allow('a', 10_000, 1)).toBe(true);
  });
});
