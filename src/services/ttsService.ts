
import { Message } from '@/types/message';
import { TTS_COMMAND_PREFIX } from '@/config/security';

interface TTSRequestOptions {
  text: string;
  apiKey: string;
  voice_id?: string;
  model_id?: string;
}

const DEFAULT_VOICE_ID = 'IKne3meq5aSn9XLyUdCD';
const DEFAULT_MODEL_ID = 'eleven_multilingual_v2';

export type TTSProvider = 'browser' | 'elevenlabs';

function isSpeechSynthesisSupported(): boolean {
  return 'speechSynthesis' in window;
}

async function generateSpeechFromText(options: TTSRequestOptions): Promise<ArrayBuffer> {
  const { text, apiKey, voice_id = DEFAULT_VOICE_ID, model_id = DEFAULT_MODEL_ID } = options;
  const url = `https://api.elevenlabs.io/v1/text-to-speech/${voice_id}`;

  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'xi-api-key': apiKey },
    body: JSON.stringify({ text, model_id, voice_settings: { stability: 0.5, similarity_boost: 0.5 } }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Failed to generate speech: ${response.status} ${errorText}`);
  }

  return await response.arrayBuffer();
}

function speakWithBrowserTTS(
  text: string,
  onPlaybackStart: () => void,
  onPlaybackEnd: () => void,
  volume: number = 1.0,
  voiceName?: string
): Promise<void> {
  return new Promise((resolve, reject) => {
    if (!isSpeechSynthesisSupported()) {
      reject(new Error('Your browser does not support speech synthesis'));
      return;
    }

    onPlaybackStart();
    window.speechSynthesis.cancel();

    const utterance = new SpeechSynthesisUtterance(text);
    utterance.volume = volume;

    const voices = window.speechSynthesis.getVoices();

    if (voiceName) {
      const voice = voices.find(v => v.name === voiceName);
      if (voice) utterance.voice = voice;
    } else {
      const pavelVoice = voices.find(v => v.name.includes('Pavel') || v.name.includes('Microsoft Pavel'));
      if (pavelVoice) {
        utterance.voice = pavelVoice;
      } else {
        const russianVoice = voices.find(v => v.lang.startsWith('ru') || v.name.includes('Russian') || v.name.includes('русский'));
        if (russianVoice) utterance.voice = russianVoice;
      }
    }

    utterance.onend = () => { onPlaybackEnd(); resolve(); };
    utterance.onerror = (event) => { onPlaybackEnd(); reject(new Error(`Speech synthesis error: ${event.error}`)); };

    window.speechSynthesis.speak(utterance);
  });
}

export async function playMessageAudio(
  message: Message, 
  apiKey: string, 
  onPlaybackStart: () => void,
  onPlaybackEnd: () => void,
  volume: number = 1.0,
  provider: TTSProvider = 'browser',
  voiceName?: string
): Promise<void> {
  try {
    // Extract the actual text without the !г (Russian r) command
    const textToSpeak = message.content.replace(new RegExp(`^${TTS_COMMAND_PREFIX}\\s*`, 'i'), '');
    
    if (provider === 'browser') {
      // Use browser's built-in speech synthesis (no token limits)
      await speakWithBrowserTTS(textToSpeak, onPlaybackStart, onPlaybackEnd, volume, voiceName);
    } else {
      // Use ElevenLabs (original implementation)
      onPlaybackStart();
      
      // Generate speech from the text
      const audioData = await generateSpeechFromText({
        text: textToSpeak,
        apiKey
      });
      
      // Create and play the audio
      const audioBlob = new Blob([audioData], { type: 'audio/mpeg' });
      const audioUrl = URL.createObjectURL(audioBlob);
      const audio = new Audio(audioUrl);
      
      // Set volume
      audio.volume = volume;
      
      // Return a promise that resolves when audio playback ends
      return new Promise((resolve) => {
        audio.onended = () => {
          URL.revokeObjectURL(audioUrl);
          onPlaybackEnd();
          resolve();
        };
        
        audio.play().catch(error => {
          console.error('Error playing audio:', error);
          onPlaybackEnd();
          resolve();
        });
      });
    }
  } catch (error) {
    console.error('Error in playMessageAudio:', error);
    onPlaybackEnd();
  }
}

export function getAvailableBrowserVoices(): SpeechSynthesisVoice[] {
  if (!isSpeechSynthesisSupported()) return [];
  return window.speechSynthesis.getVoices();
}
