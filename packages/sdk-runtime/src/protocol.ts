import type { ConversationClaimSnapshot, JsonObject, JsonValue, RuntimeJob, RuntimeJobAck, RuntimeManifest, RuntimeOrigin, RuntimeTriggerRule, TelegramChatType, TextOperator, TriggerKind } from './types';

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asJsonValue(value: unknown): JsonValue | undefined {
  if (value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return value;
  }
  if (Array.isArray(value)) {
    const entries: JsonValue[] = [];
    for (const entry of value) {
      const json = asJsonValue(entry);
      if (json === undefined) return undefined;
      entries.push(json);
    }
    return entries;
  }
  if (isObject(value)) {
    const object: Record<string, JsonValue> = {};
    for (const [key, entry] of Object.entries(value)) {
      const json = asJsonValue(entry);
      if (json === undefined) return undefined;
      object[key] = json;
    }
    return object;
  }
  return undefined;
}

function jsonObject(value: unknown): JsonObject | undefined {
  const parsed = asJsonValue(value);
  return parsed !== undefined && typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) ? parsed : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

export function parseRuntimeJobs(body: unknown): RuntimeJob[] {
  if (!isObject(body) || !Array.isArray(body.jobs)) return [];
  const jobs: RuntimeJob[] = [];
  for (const candidate of body.jobs) {
    if (!isObject(candidate) || typeof candidate.id !== 'string') continue;
    const params = jsonObject(candidate.params) ?? {};
    const kind = candidate.kind === 'transport_call'
      || candidate.kind === 'control'
      || candidate.kind === 'telegram_call'
      || candidate.kind === 'session_state'
      ? candidate.kind
      : typeof candidate.operation === 'string' || typeof candidate.method === 'string'
        ? 'telegram_call'
        : undefined;
    if (kind === undefined) continue;
    const operation = stringValue(candidate.operation) ?? stringValue(candidate.method);
    const method = stringValue(candidate.method) ?? (kind === 'transport_call' ? operation : undefined);
    const origin = parseOrigin(candidate.origin);
    jobs.push({
      protocolVersion: typeof candidate.protocolVersion === 'number' ? candidate.protocolVersion : 1,
      id: candidate.id,
      ...(stringValue(candidate.leaseToken) === undefined ? {} : { leaseToken: stringValue(candidate.leaseToken) }),
      ...(typeof candidate.attempt === 'number' ? { attempt: candidate.attempt } : {}),
      kind,
      ...(typeof candidate.transport === 'string' ? { transport: candidate.transport } : {}),
      ...(operation === undefined ? {} : { operation }),
      ...(method === undefined ? {} : { method }),
      params,
      ...(candidate.priority === 'interactive' || candidate.priority === 'normal' || candidate.priority === 'bulk'
        ? { priority: candidate.priority }
        : {}),
      ...(Array.isArray(candidate.requiredCapabilities)
        && candidate.requiredCapabilities.every((value) => typeof value === 'string')
        ? { requiredCapabilities: candidate.requiredCapabilities }
        : {}),
      ...(stringValue(candidate.conversationKey) === undefined
        ? {}
        : { conversationKey: stringValue(candidate.conversationKey) }),
      ...(stringValue(candidate.chatKey) === undefined ? {} : { chatKey: stringValue(candidate.chatKey) }),
      ...(typeof candidate.sequence === 'number' ? { sequence: candidate.sequence } : {}),
      ...(typeof candidate.needsResult === 'boolean' ? { needsResult: candidate.needsResult } : {}),
      ...(typeof candidate.deadlineAt === 'string' || typeof candidate.deadlineAt === 'number'
        ? { deadlineAt: candidate.deadlineAt }
        : {}),
      ...(origin === undefined ? {} : { origin }),
    });
  }
  return jobs;
}

function parseOrigin(value: unknown): RuntimeOrigin | undefined {
  if (typeof value === 'string'
    && ['flowcastle_runtime', 'customer_code', 'live_agent', 'unknown'].includes(value)) {
    return { type: value as RuntimeOrigin['type'] };
  }
  if (!isObject(value)
    || !['flowcastle_runtime', 'customer_code', 'live_agent', 'unknown'].includes(String(value.type))) {
    return undefined;
  }
  return {
    type: value.type as RuntimeOrigin['type'],
    ...(typeof value.flowId === 'string' ? { flowId: value.flowId } : {}),
    ...(typeof value.blockId === 'string' ? { blockId: value.blockId } : {}),
    ...(typeof value.executionId === 'string' ? { executionId: value.executionId } : {}),
  };
}

export function parseRuntimeManifest(body: unknown): RuntimeManifest | undefined {
  if (!isObject(body) || typeof body.version !== 'string' || !Array.isArray(body.rules)) return undefined;
  const rules: RuntimeTriggerRule[] = [];
  for (const candidate of body.rules) {
    const rule = parseTriggerRule(candidate);
    if (rule !== undefined) rules.push(rule);
  }
  return {
    protocolVersion: typeof body.protocolVersion === 'number' ? body.protocolVersion : 1,
    version: body.version,
    rules,
    ...(Array.isArray(body.requiredCapabilities) && body.requiredCapabilities.every((value) => typeof value === 'string')
      ? { requiredCapabilities: body.requiredCapabilities }
      : {}),
  };
}

function parseTriggerRule(value: unknown): RuntimeTriggerRule | undefined {
  if (!isObject(value) || typeof value.id !== 'string' || typeof value.flowId !== 'string') return undefined;
  const kinds: TriggerKind[] = ['command', 'message', 'deep_link', 'callback', 'event'];
  if (!kinds.includes(value.kind as TriggerKind)) return undefined;
  const chatTypes = parseChatTypes(value.chatTypes);
  if (value.chatTypes !== undefined && chatTypes === undefined) return undefined;
  const rule: RuntimeTriggerRule = { id: value.id, flowId: value.flowId, kind: value.kind as TriggerKind };
  if (chatTypes !== undefined) rule.chatTypes = chatTypes;
  if (value.visibility === 'all' || value.visibility === 'addressed') rule.visibility = value.visibility;
  if (typeof value.command === 'string') rule.command = value.command;
  if (isObject(value.text) && typeof value.text.value === 'string' && ['equals', 'contains', 'starts_with', 'regex'].includes(String(value.text.operator))) {
    rule.text = { operator: value.text.operator as TextOperator, value: value.text.value, ...(typeof value.text.caseSensitive === 'boolean' ? { caseSensitive: value.text.caseSensitive } : {}) };
  }
  if (isObject(value.callbackData) && (typeof value.callbackData.exact === 'string' || typeof value.callbackData.prefix === 'string')) {
    rule.callbackData = { ...(typeof value.callbackData.exact === 'string' ? { exact: value.callbackData.exact } : {}), ...(typeof value.callbackData.prefix === 'string' ? { prefix: value.callbackData.prefix } : {}) };
  }
  if (typeof value.eventType === 'string') rule.eventType = value.eventType;
  if (value.claimScope === 'chat' || value.claimScope === 'chat_actor') rule.claimScope = value.claimScope;
  if (typeof value.priority === 'number' && Number.isFinite(value.priority)) rule.priority = value.priority;
  return rule;
}

function parseChatTypes(value: unknown): TelegramChatType[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const valid: TelegramChatType[] = ['private', 'group', 'supergroup', 'channel'];
  return value.every((item) => typeof item === 'string' && valid.includes(item as TelegramChatType)) ? value as TelegramChatType[] : undefined;
}

export function parseRunFlowResult(body: unknown): { executionId: string; acceptedAt?: number } | undefined {
  if (!isObject(body) || typeof body.executionId !== 'string') return undefined;
  return typeof body.acceptedAt === 'number' ? { executionId: body.executionId, acceptedAt: body.acceptedAt } : { executionId: body.executionId };
}

export function parseConversationClaimSnapshot(body: unknown): ConversationClaimSnapshot | undefined {
  if (!isObject(body) || typeof body.cursor !== 'string' || !Array.isArray(body.claims)) return undefined;
  const claims: ConversationClaimSnapshot['claims'] = [];
  for (const value of body.claims) {
    if (!isObject(value)
      || typeof value.conversationKey !== 'string'
      || typeof value.generation !== 'number'
      || !Number.isFinite(value.generation)
      || !Array.isArray(value.kinds)
      || !value.kinds.every((kind) => typeof kind === 'string')
      || typeof value.active !== 'boolean'
      || typeof value.expiresAt !== 'number'
      || !Number.isFinite(value.expiresAt)) continue;
    claims.push({
      conversationKey: value.conversationKey,
      generation: value.generation,
      kinds: value.kinds,
      active: value.active,
      expiresAt: value.expiresAt,
      ...(typeof value.updatedAt === 'number' && Number.isFinite(value.updatedAt) ? { updatedAt: value.updatedAt } : {}),
    });
  }
  return { cursor: body.cursor, claims };
}

export function encodeJobAcks(results: RuntimeJobAck[]): JsonObject {
  return { results: results as unknown as JsonValue };
}
