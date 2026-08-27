/** JSON events sent by the FlowCastle Telegraf adapter. */
export interface SdkUpdateEvent {
  type: 'update';
  at: number;
  update: object;
  handled?: boolean;
}

export interface SdkOutgoingEvent {
  type: 'outgoing';
  at: number;
  method: string;
  chatId?: number | string;
  ok: boolean;
  errorCode?: number;
  errorDescription?: string;
  payload?: object;
  result?: { messageId?: number };
  correlationUpdateId?: number;
  correlationJobId?: string;
}

export interface SdkGoalEvent {
  type: 'goal';
  at: number;
  key: string;
  telegramUserId?: number | string;
  chatId?: number | string;
  props?: Record<string, unknown>;
  correlationUpdateId?: number;
}

export interface SdkIdentifyEvent {
  type: 'identify';
  at: number;
  telegramUserId: number | string;
  props: Record<string, unknown>;
  correlationUpdateId?: number;
}

export interface SdkLiveAgentRequestEvent {
  type: 'live_agent_request';
  at: number;
  telegramUserId: number | string;
  chatId?: number | string;
  note?: string;
}

export type SdkEvent = SdkUpdateEvent | SdkOutgoingEvent | SdkGoalEvent | SdkIdentifyEvent | SdkLiveAgentRequestEvent;
