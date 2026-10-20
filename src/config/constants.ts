export type SpeechLanguage = 'ru' | 'en';

/**
 * Chat messages starting with one of these commands are read aloud, in the
 * command's language. `!r` is `!г` as typed on an English keyboard.
 */
export const TTS_COMMANDS: readonly { prefix: string; language: SpeechLanguage }[] = [
  { prefix: '!г', language: 'ru' },
  { prefix: '!r', language: 'en' },
];
