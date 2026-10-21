import { describe, it, expect } from 'vitest';
import { mergePersistedSettings } from './settingsStore';

const current = {
  apiKey: '',
  volume: 0.7,
  ttsProvider: 'browser' as const,
  selectedVoice: '',
  englishVoice: '',
  ttsMaxLength: 200,
  ttsViewerCooldownSec: 10,
};

describe('mergePersistedSettings', () => {
  it('keeps the saved API key when settings from an older version lack new fields', () => {
    const merged = mergePersistedSettings({ apiKey: 'sk-saved', volume: 0.3, ttsProvider: 'elevenlabs', selectedVoice: 'Pavel' }, current);
    expect(merged).toMatchObject({ apiKey: 'sk-saved', volume: 0.3, ttsProvider: 'elevenlabs', ttsMaxLength: 200 });
  });

  it('ignores invalid values field by field', () => {
    const merged = mergePersistedSettings({ apiKey: 'sk', volume: 7, ttsMaxLength: 'long' }, current);
    expect(merged).toMatchObject({ apiKey: 'sk', volume: 0.7, ttsMaxLength: 200 });
  });

  it('survives missing or junk storage', () => {
    expect(mergePersistedSettings(undefined, current)).toEqual(current);
    expect(mergePersistedSettings('junk', current)).toEqual(current);
  });
});
