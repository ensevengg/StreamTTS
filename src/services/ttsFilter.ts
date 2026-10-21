import { TTS_COMMAND_PREFIX } from '@/config/constants';

const COMMAND_PREFIX_PATTERN = new RegExp(`^${TTS_COMMAND_PREFIX}\\s*`, 'i');

export const stripCommandPrefix = (content: string): string =>
  content.replace(COMMAND_PREFIX_PATTERN, '');
