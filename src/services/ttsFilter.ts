import { TTS_COMMAND_PREFIX } from '@/config/constants';

const COMMAND_PREFIX_PATTERN = new RegExp(`^${TTS_COMMAND_PREFIX}\\s*`, 'i');
const URL_PATTERN = /\b(?:https?:\/\/|www\.)\S+/gi;
// Control characters plus zero-width and bidi-override characters, which can
// hide text or flip how it renders in the chat history.
// eslint-disable-next-line no-control-regex
const INVISIBLE_PATTERN = /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff]/g;
// "aaaaaaaaaa" or "!!!!!!!!" spam: keep at most three in a row.
const REPEAT_PATTERN = /(.)\1{3,}/gu;

export const stripCommandPrefix = (content: string): string =>
  content.replace(COMMAND_PREFIX_PATTERN, '');

/**
 * Turns a chat message into what gets spoken: links become the word "link",
 * invisible characters and character spam are collapsed, and the result is
 * capped at `maxLength` characters. Returns null when nothing speakable is left.
 */
export function prepareSpeechText(raw: string, maxLength: number): string | null {
  const text = raw
    .replace(INVISIBLE_PATTERN, ' ')
    .replace(URL_PATTERN, ' link ')
    .replace(REPEAT_PATTERN, '$1$1$1')
    .replace(/\s+/g, ' ')
    .trim();
  if (!text) return null;

  // Count code points, not UTF-16 units, so emoji aren't cut in half.
  const chars = Array.from(text);
  if (chars.length <= maxLength) return text;
  const cut = chars.slice(0, maxLength).join('');
  const lastSpace = cut.lastIndexOf(' ');
  return `${lastSpace > maxLength * 0.6 ? cut.slice(0, lastSpace) : cut}…`;
}

/** Per-viewer cooldown so one person can't monopolize the voice. */
export class CooldownTracker {
  private readonly lastSpoken = new Map<string, number>();

  constructor(private readonly maxTracked = 5000) {}

  /** Records and allows the message, or returns false while `user` cools down. */
  allow(user: string, cooldownMs: number, now: number = Date.now()): boolean {
    if (cooldownMs <= 0) return true;
    const key = user.toLowerCase();
    const previous = this.lastSpoken.get(key);
    if (previous !== undefined && now - previous < cooldownMs) return false;

    this.lastSpoken.delete(key);
    this.lastSpoken.set(key, now);
    if (this.lastSpoken.size > this.maxTracked) {
      this.lastSpoken.delete(this.lastSpoken.keys().next().value as string);
    }
    return true;
  }
}
