/**
 * The Telegram bot (Settings → Telegram), shared by the main process, preload and renderer.
 * The bot token never crosses to the renderer: only its status.
 */

/** Which notifications go to the chat (all on by default) */
export interface TelegramNotificationSettings {
  agentQuestion: boolean;
  reviewWaiting: boolean;
  taskFailed: boolean;
  ciFailed: boolean;
  taskMerged: boolean;
  regression: boolean;
}

export type TelegramNotificationKind = keyof TelegramNotificationSettings;

export interface TelegramOwner {
  userId: number;
  chatId: number;
  /** Telegram name or @username, for Settings */
  name?: string;
}

export type TelegramConnection =
  /** No token saved */
  | 'not_set'
  /** Polling */
  | 'connected'
  /** Starting, or waiting before the next try */
  | 'connecting'
  /** Stopped or failing: see `error` */
  | 'error';

export type TelegramErrorReason = 'bad_token' | 'conflict' | 'network' | 'rate_limited' | 'unknown';

export interface TelegramStatus {
  connection: TelegramConnection;
  error?: TelegramErrorReason;
  /** The bot's @username (without @), once known */
  botUsername?: string;
  owner?: TelegramOwner;
  /** The current one-time pairing code, while it is valid */
  pairingCode?: string;
  /** Epoch ms the code stops being valid */
  pairingExpiresAt?: number;
  notifications: TelegramNotificationSettings;
}

export interface TelegramResult<T = undefined> {
  success: boolean;
  data?: T;
  error?: TelegramErrorReason | 'empty_token';
}

export interface TelegramAPI {
  getStatus: () => Promise<TelegramStatus>;
  /** Checks the token with getMe, then saves it and starts the bot */
  saveToken: (token: string) => Promise<TelegramResult<TelegramStatus>>;
  /** Checks the token with getMe without saving it */
  testToken: (token: string) => Promise<TelegramResult<{ username?: string }>>;
  removeToken: () => Promise<TelegramStatus>;
  /** A new one-time pairing code (valid 10 minutes) */
  newPairingCode: () => Promise<TelegramStatus>;
  unpair: () => Promise<TelegramStatus>;
  setNotifications: (notifications: TelegramNotificationSettings) => Promise<TelegramStatus>;
  onStatus: (callback: (status: TelegramStatus) => void) => () => void;
}
