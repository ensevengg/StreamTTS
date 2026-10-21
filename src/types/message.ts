/** Speech progress of a message; plain chat that isn't read aloud has none. */
export type MessageStatus = 'queued' | 'playing' | 'completed' | 'skipped' | 'error';

export interface Message {
  id: string;
  content: string;
  timestamp: number;
  username?: string;
  status?: MessageStatus;
  /** Why it was skipped or failed. */
  statusDetail?: string;
}
