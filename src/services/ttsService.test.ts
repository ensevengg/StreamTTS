import { describe, it, expect } from 'vitest';
import { defaultVoiceFor } from './ttsService';

const voice = (name: string, lang: string, isDefault = false) =>
  ({ name, lang, default: isDefault }) as SpeechSynthesisVoice;

describe('defaultVoiceFor', () => {
  const voices = [
    voice('Microsoft David', 'en-GB'),
    voice('Microsoft Zira', 'en-US'),
    voice('Microsoft Irina', 'ru-RU'),
    voice('Microsoft Pavel', 'ru-RU'),
  ];

  it('prefers Pavel for Russian, then any Russian voice', () => {
    expect(defaultVoiceFor(voices, 'ru')?.name).toBe('Microsoft Pavel');
    expect(defaultVoiceFor(voices.slice(0, 3), 'ru')?.name).toBe('Microsoft Irina');
  });

  it('prefers the system default English voice, then US English, then any English', () => {
    expect(defaultVoiceFor([...voices, voice('Samantha', 'en-AU', true)], 'en')?.name).toBe('Samantha');
    expect(defaultVoiceFor(voices, 'en')?.name).toBe('Microsoft Zira');
    expect(defaultVoiceFor([voice('espeak', 'en_US'), voice('other', 'en-GB')], 'en')?.name).toBe('espeak');
    expect(defaultVoiceFor([voice('Microsoft David', 'en-GB')], 'en')?.name).toBe('Microsoft David');
  });

  it('finds nothing when no voice speaks the language', () => {
    expect(defaultVoiceFor(voices.slice(2), 'en')).toBeUndefined();
  });
});
