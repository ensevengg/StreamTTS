import { describe, it, expect } from 'vitest';
import { mergePersistedSettings } from './settingsStore';

const current = {
  apiKey: '',
  volume: 0.7,
  ttsProvider: 'browser' as const,
  selectedVoice: '',
};

describe('mergePersistedSettings', () => {
  it('keeps the saved API key when settings from an older version lack a field', () => {
    const merged = mergePersistedSettings({ apiKey: 'sk-saved', volume: 0.3, ttsProvider: 'elevenlabs' }, current);
    expect(merged).toMatchObject({ apiKey: 'sk-saved', volume: 0.3, ttsProvider: 'elevenlabs', selectedVoice: '' });
  });

  it('ignores invalid values field by field', () => {
    const merged = mergePersistedSettings({ apiKey: 'sk', volume: 7, ttsProvider: 'loud' }, current);
    expect(merged).toMatchObject({ apiKey: 'sk', volume: 0.7, ttsProvider: 'browser' });
  });

  it('survives missing or junk storage', () => {
    expect(mergePersistedSettings(undefined, current)).toEqual(current);
    expect(mergePersistedSettings('junk', current)).toEqual(current);
  });
});
