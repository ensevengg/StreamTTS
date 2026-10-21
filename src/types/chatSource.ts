export type ChatPlatform = 'twitch' | 'youtube';

/**
 * `reconnecting` is a temporary drop being retried; `waiting` (YouTube) means
 * no live broadcast right now; `error` needs the user to act.
 */
export type ConnectionStatus = 'connecting' | 'connected' | 'reconnecting' | 'waiting' | 'error';

export interface ChatConnection {
  /** One session per platform, so the platform doubles as the id. */
  id: ChatPlatform;
  type: ChatPlatform;
  channelName: string;
  status: ConnectionStatus;
  /** Why the connection is reconnecting, waiting or failed. */
  detail?: string;
  /** Twitch alert (EventSub) state, shown next to the chat status. */
  alertsDetail?: string;
}
