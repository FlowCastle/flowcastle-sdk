/** JSON values accepted by the versioned SDK runtime protocol. */
export type JsonPrimitive = boolean | number | string | null;
export type JsonValue = JsonPrimitive | JsonObject | JsonValue[];
export interface JsonObject {
  readonly [key: string]: JsonValue;
}

export type ConversationKey = string;
export type RuntimeCapability = string;

export interface RuntimeOrigin {
  type: 'flowcastle_runtime' | 'customer_code' | 'live_agent' | 'unknown';
  flowId?: string;
  blockId?: string;
  executionId?: string;
}

export interface RuntimeJob {
  protocolVersion: number;
  id: string;
  leaseToken?: string;
  attempt?: number;
  /** Canonical v2 kinds plus the two pre-v2 aliases accepted for compatibility. */
  kind: 'transport_call' | 'control' | 'telegram_call' | 'session_state';
  transport?: string;
  /** Canonical protocol-v2 operation name. */
  operation?: string;
  /** Compatibility alias used by the original grammY client and v1 jobs. */
  method?: string;
  params: JsonObject;
  priority?: 'interactive' | 'normal' | 'bulk';
  requiredCapabilities?: RuntimeCapability[];
  conversationKey?: ConversationKey;
  chatKey?: ConversationKey;
  sequence?: number;
  needsResult?: boolean;
  deadlineAt?: string | number;
  origin?: RuntimeOrigin;
}

export interface RuntimeJobError {
  code?: number;
  description: string;
  retryAfter?: number;
}

export interface RuntimeJobAck {
  id: string;
  leaseToken?: string;
  ok: boolean;
  result?: JsonValue;
  /** Canonical v2 error envelope. */
  error?: RuntimeJobError;
  /** Compatibility fields accepted by the FlowCastle API. */
  errorCode?: number;
  errorDescription?: string;
  retryAfter?: number;
}

export interface RuntimeManifest {
  protocolVersion: number;
  version: string;
  rules: RuntimeTriggerRule[];
  requiredCapabilities?: RuntimeCapability[];
}

export type TelegramChatType = 'private' | 'group' | 'supergroup' | 'channel';
export type TriggerKind = 'command' | 'message' | 'deep_link' | 'callback' | 'event';
export type TextOperator = 'equals' | 'contains' | 'starts_with' | 'regex';

export interface RuntimeTriggerRule {
  id: string;
  flowId: string;
  kind: TriggerKind;
  chatTypes?: TelegramChatType[];
  visibility?: 'all' | 'addressed';
  command?: string;
  text?: { operator: TextOperator; value: string; caseSensitive?: boolean };
  callbackData?: { exact?: string; prefix?: string };
  eventType?: string;
  claimScope?: 'chat' | 'chat_actor';
  priority?: number;
}

export interface ConversationClaim {
  conversationKey: ConversationKey;
  generation: number;
  kinds: string[];
  expiresAt: number;
}

export interface ConversationClaimUpdate extends ConversationClaim {
  active: boolean;
  updatedAt?: number;
}

export interface ConversationClaimSnapshot {
  cursor: string;
  claims: ConversationClaimUpdate[];
}

export interface RunFlowRequest {
  flowKey: string;
  inputs?: JsonObject;
  update?: JsonObject;
}

export interface RunFlowResult {
  executionId: string;
  acceptedAt?: number;
}

export interface RuntimeIdentity {
  instanceId: string;
  client: {
    name: string;
    version: string;
  };
  identity: {
    platform: 'telegram';
    accountId: string;
    username?: string;
  };
  capabilities: RuntimeCapability[];
}

export interface RuntimeUpdate {
  updateId?: string | number;
  chatId?: string | number;
  actorId?: string | number;
  chatType?: TelegramChatType;
  text?: string;
  command?: string;
  commandPayload?: string;
  callbackData?: string;
  eventType?: string;
  addressed?: boolean;
  raw: JsonObject;
}
