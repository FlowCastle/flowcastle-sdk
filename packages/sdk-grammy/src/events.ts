/**
 * Wire protocol v1 event types (FlowCastle SDK ingest).
 *
 * Mirrors `SdkEvent` in `docs/SDK_GRAMMY_PLUGIN_PLAN.md` §3.3. These objects are
 * JSON-serialized into the batch body posted to `POST /api/sdk/v1/events`.
 */

/** An incoming Telegram update observed by the middleware. */
export interface SdkUpdateEvent {
  type: 'update';
  at: number;
  /** Raw Telegram `Update`, optionally text-redacted. */
  update: object;
  /** True when the adapter claimed the update for server-side FlowCastle execution. */
  handled?: boolean;
}

/** An outgoing Bot API call observed by the transformer (success or failure). */
export interface SdkOutgoingEvent {
  type: 'outgoing';
  at: number;
  method: string;
  /**
   * Extracted from the call payload's `chat_id` when present. Absent for
   * chat-less methods (e.g. `getMe`, `setWebhook`).
   */
  chatId?: number | string;
  ok: boolean;
  errorCode?: number;
  errorDescription?: string;
  /**
   * Sanitized payload — only `reply_markup.inline_keyboard` is kept (text/callback_data/url),
   * other reply_markup kinds dropped; text/caption stripped when redaction is on.
   */
  payload?: object;
  result?: { messageId?: number };
  /**
   * `update_id` of the incoming update whose handling caused this call. Present
   * only when the call was made while an update was being processed (Flow Map
   * causal correlation). Absent for calls made outside any handler.
   */
  correlationUpdateId?: number;
  /**
   * Id of the pulled delivery job whose execution produced this call. Present
   * only for sends the {@link JobPuller} executed on the server's behalf (e.g.
   * a Live Chat agent reply). Lets the server tell agent-reply sends apart from
   * the bot's own outgoing traffic and avoid echoing them back. Absent for all
   * bot-originated calls.
   */
  correlationJobId?: string;
}

/** A goal fired via `ctx.flowcastle.goal()`. */
export interface SdkGoalEvent {
  type: 'goal';
  at: number;
  key: string;
  telegramUserId?: number | string;
  chatId?: number | string;
  props?: Record<string, unknown>;
  /** `update_id` of the update being handled when the goal fired, when available. */
  correlationUpdateId?: number;
}

/** Contact traits set via `ctx.flowcastle.identify()`. */
export interface SdkIdentifyEvent {
  type: 'identify';
  at: number;
  telegramUserId: number | string;
  props: Record<string, unknown>;
  /** `update_id` of the update being handled when identify fired, when available. */
  correlationUpdateId?: number;
}

/**
 * A request to hand the current conversation to a human agent in FlowCastle Live
 * Chat, fired via `ctx.flowcastle.requestLiveAgent()`.
 */
export interface SdkLiveAgentRequestEvent {
  type: 'live_agent_request';
  at: number;
  telegramUserId: number | string;
  chatId?: number | string;
  /** Optional free-text note for the agent (clamped to 500 chars by the plugin). */
  note?: string;
}

export type SdkEvent =
  | SdkUpdateEvent
  | SdkOutgoingEvent
  | SdkGoalEvent
  | SdkIdentifyEvent
  | SdkLiveAgentRequestEvent;
