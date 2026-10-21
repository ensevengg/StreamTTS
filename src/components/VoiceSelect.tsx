import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import type { SpeechLanguage } from '@/config/constants';

interface VoiceSelectProps {
  id: string;
  label: string;
  language: SpeechLanguage;
  voices: SpeechSynthesisVoice[];
  value: string;
  onChange: (voice: string) => void;
}

/** Browser voice picker for one language; voices in that language come first. */
const VoiceSelect = ({ id, label, language, voices, value, onChange }: VoiceSelectProps) => {
  const speaksLanguage = (voice: SpeechSynthesisVoice) => voice.lang.toLowerCase().startsWith(language);
  const sorted = [...voices.filter(speaksLanguage), ...voices.filter(v => !speaksLanguage(v))];

  return (
    <div className="space-y-2">
      <Label htmlFor={id}>{label}</Label>
      <Select value={value} onValueChange={onChange}>
        <SelectTrigger id={id}>
          <SelectValue placeholder="Select a voice" />
        </SelectTrigger>
        <SelectContent>
          {sorted.map((voice) => (
            <SelectItem key={voice.name} value={voice.name}>
              {voice.name} {voice.lang ? `(${voice.lang})` : ''}
              {speaksLanguage(voice) && ' - Recommended'}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
};

export default VoiceSelect;
