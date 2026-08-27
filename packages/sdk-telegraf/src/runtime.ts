import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';

import type { Telegram } from 'telegraf';
import {
  conversationKey,
  ConversationClaims,
  decodeTransportParams,
  matchManifest,
  RuntimeClient,
  RuntimeJobLoop,
} from '@flowcastle/sdk-runtime';
import type { JsonObject, JsonValue, RuntimeJob, RuntimeJobAck, RuntimeManifest, RuntimeUpdate } from '@flowcastle/sdk-runtime';

const SAFE_METHODS: ReadonlySet<string> = new Set([
  'sendMessage', 'sendPhoto', 'sendDocument', 'sendVideo', 'sendVideoNote', 'sendAnimation',
  'sendAudio', 'sendVoice', 'sendSticker', 'sendMediaGroup', 'sendContact', 'sendDice', 'sendLocation',
  'sendPoll', 'sendVenue', 'sendInvoice', 'createInvoiceLink', 'editMessageText', 'editMessageMedia',
  'editMessageReplyMarkup', 'editMessageCaption', 'deleteMessage', 'answerCallbackQuery',
  'answerPreCheckoutQuery', 'sendChatAction', 'restrictChatMember', 'banChatMember', 'unbanChatMember',
  'getChatMember', 'pinChatMessage', 'unpinChatMessage', 'getMe',
]);
const LIFECYCLE_METHODS: ReadonlySet<string> = new Set(['getUpdates', 'setWebhook', 'deleteWebhook', 'close', 'logOut']);
const BUILT_IN_CAPABILITIES = [
  'telegram.bot_api',
  'telegram.send_message',
  'telegram.inline_keyboard',
  'telegram.media',
  'telegram.payments',
  ...[...SAFE_METHODS].map((method) => `transport.telegram.bot_api.${method}`),
];

interface RuntimeAckCompatibility extends RuntimeJobAck {
  error?: { code?: number; description: string; retryAfter?: number };
  errorCode?: number;
  errorDescription?: string;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function operationFor(job: RuntimeJob): string | undefined {
  const operation = isObject(job) ? job.operation : undefined;
  return typeof operation === 'string' ? operation : job.method;
}

function compatibilityAck(
  job: RuntimeJob,
  ok: boolean,
  details: { result?: JsonValue; errorCode?: number; errorDescription?: string } = {},
): RuntimeAckCompatibility {
  const ack: RuntimeAckCompatibility = { id: job.id, leaseToken: job.leaseToken, ok };
  if (details.result !== undefined) ack.result = details.result;
  if (!ok) {
    const description = details.errorDescription ?? 'telegram method failed';
    ack.errorDescription = description;
    ack.error = { ...(details.errorCode === undefined ? {} : { code: details.errorCode }), description };
    if (details.errorCode !== undefined) ack.errorCode = details.errorCode;
  }
  return ack;
}

function decodedParams(params: JsonObject): Record<string, unknown> {
  const decoded = decodeTransportParams(params, (file) => Buffer.from(file.bytes));
  if (!isObject(decoded)) throw new Error('FlowCastle: runtime job params must be an object');
  return decoded;
}

function toJsonValue(value: unknown): JsonValue {
  const serialized = JSON.stringify(value);
  if (serialized === undefined) return null;
  return JSON.parse(serialized) as JsonValue;
}

function applyConversationClaim(claims: ConversationClaims, job: RuntimeJob): RuntimeAckCompatibility {
  const params = job.params;
  const active = params.active;
  const conversationKeyValue = isObject(job) ? job.conversationKey : undefined;
  const key = typeof conversationKeyValue === 'string'
    ? conversationKeyValue
    : typeof params.conversationKey === 'string' ? params.conversationKey : job.chatKey;
  const generation = typeof params.generation === 'number' ? params.generation : 0;
  if (key === undefined || typeof active !== 'boolean') return compatibilityAck(job, false, { errorCode: 400, errorDescription: 'invalid conversation claim job' });
  if (!active) {
    claims.clear(key, generation);
    return compatibilityAck(job, true);
  }
  const expiresAt = typeof params.expiresAt === 'number' ? params.expiresAt : Date.now() + 30 * 60_000;
  const kinds = Array.isArray(params.kinds) ? params.kinds.filter((kind): kind is string => typeof kind === 'string') : ['flow'];
  claims.set({ conversationKey: key, generation, kinds, expiresAt });
  return compatibilityAck(job, true);
}

/** Executes a fixed safe Telegram surface for FlowCastle runtime jobs. */
export class TelegrafRuntimeJobExecutor {
  public constructor(
    private readonly telegram: Telegram,
    private readonly claims: ConversationClaims,
    private readonly jobContext: AsyncLocalStorage<string>,
    private readonly onError: (error: unknown) => void,
  ) {}

  public async execute(job: RuntimeJob): Promise<RuntimeJobAck> {
    const operation = operationFor(job);
    const kind = isObject(job) && typeof job.kind === 'string' ? job.kind : '';
    if (kind === 'session_state' || (kind === 'control' && operation === 'conversation_claim')) {
      return applyConversationClaim(this.claims, job);
    }
    if (operation === undefined || LIFECYCLE_METHODS.has(operation) || !SAFE_METHODS.has(operation) || kind === 'control') {
      this.onError(new Error(`FlowCastle: refused disallowed runtime method '${operation ?? 'unknown'}'`));
      return compatibilityAck(job, false, { errorCode: 400, errorDescription: 'method not allowed' });
    }
    try {
      const result = await this.jobContext.run(job.id, () => this.dispatch(operation, decodedParams(job.params)));
      return compatibilityAck(job, true, { result: toJsonValue(result) });
    } catch (error) {
      this.onError(error);
      const detail = isObject(error) ? error : {};
      return compatibilityAck(job, false, {
        ...(typeof detail.error_code === 'number' ? { errorCode: detail.error_code } : {}),
        errorDescription: typeof detail.description === 'string'
          ? detail.description
          : error instanceof Error ? error.message : 'telegram method failed',
      });
    }
  }

  private async dispatch(operation: string, params: Record<string, unknown>): Promise<unknown> {
    switch (operation) {
      case 'sendMessage': return this.telegram.callApi('sendMessage', params as never);
      case 'sendPhoto': return this.telegram.callApi('sendPhoto', params as never);
      case 'sendDocument': return this.telegram.callApi('sendDocument', params as never);
      case 'sendVideo': return this.telegram.callApi('sendVideo', params as never);
      case 'sendVideoNote': return this.telegram.callApi('sendVideoNote', params as never);
      case 'sendAnimation': return this.telegram.callApi('sendAnimation', params as never);
      case 'sendAudio': return this.telegram.callApi('sendAudio', params as never);
      case 'sendVoice': return this.telegram.callApi('sendVoice', params as never);
      case 'sendSticker': return this.telegram.callApi('sendSticker', params as never);
      case 'sendMediaGroup': return this.telegram.callApi('sendMediaGroup', params as never);
      case 'sendContact': return this.telegram.callApi('sendContact', params as never);
      case 'sendDice': return this.telegram.callApi('sendDice', params as never);
      case 'sendLocation': return this.telegram.callApi('sendLocation', params as never);
      case 'sendPoll': return this.telegram.callApi('sendPoll', params as never);
      case 'sendVenue': return this.telegram.callApi('sendVenue', params as never);
      case 'sendInvoice': return this.telegram.callApi('sendInvoice', params as never);
      case 'createInvoiceLink': return this.telegram.callApi('createInvoiceLink', params as never);
      case 'editMessageText': return this.telegram.callApi('editMessageText', params as never);
      case 'editMessageMedia': return this.telegram.callApi('editMessageMedia', params as never);
      case 'editMessageReplyMarkup': return this.telegram.callApi('editMessageReplyMarkup', params as never);
      case 'editMessageCaption': return this.telegram.callApi('editMessageCaption', params as never);
      case 'deleteMessage': return this.telegram.callApi('deleteMessage', params as never);
      case 'answerCallbackQuery': return this.telegram.callApi('answerCallbackQuery', params as never);
      case 'answerPreCheckoutQuery': return this.telegram.callApi('answerPreCheckoutQuery', params as never);
      case 'sendChatAction': return this.telegram.callApi('sendChatAction', params as never);
      case 'restrictChatMember': return this.telegram.callApi('restrictChatMember', params as never);
      case 'banChatMember': return this.telegram.callApi('banChatMember', params as never);
      case 'unbanChatMember': return this.telegram.callApi('unbanChatMember', params as never);
      case 'getChatMember': return this.telegram.callApi('getChatMember', params as never);
      case 'pinChatMessage': return this.telegram.callApi('pinChatMessage', params as never);
      case 'unpinChatMessage': return this.telegram.callApi('unpinChatMessage', params as never);
      case 'getMe': return this.telegram.callApi('getMe', params as never);
      default: throw new Error(`FlowCastle: unsupported safe runtime method '${operation}'`);
    }
  }
}

export interface TelegrafRuntimeOptions {
  enabled?: boolean;
  capabilities?: string[];
  instanceId?: string;
}

export class TelegrafRuntime {
  public readonly claims = new ConversationClaims();
  private manifest: RuntimeManifest | undefined;
  private loop: RuntimeJobLoop | undefined;
  private telegram: Telegram | undefined;
  private heartbeatTimer: ReturnType<typeof setInterval> | undefined;
  private manifestTimer: ReturnType<typeof setInterval> | undefined;
  private claimTimer: ReturnType<typeof setInterval> | undefined;
  private claimCursor: string | undefined;
  private readonly instanceId: string;

  public constructor(
    private readonly client: RuntimeClient,
    private readonly options: TelegrafRuntimeOptions,
    private readonly jobContext: AsyncLocalStorage<string>,
    private readonly onError: (error: unknown) => void,
  ) {
    this.instanceId = options.instanceId ?? randomUUID();
  }

  public attach(telegram: Telegram): void {
    this.telegram = telegram;
    if (this.loop !== undefined) return;
    this.loop = new RuntimeJobLoop({
      apiKey: this.client.headers().Authorization.replace('Bearer ', ''),
      apiUrl: this.client.baseUrl(),
      onError: this.onError,
      capabilities: this.capabilities(),
      executor: new TelegrafRuntimeJobExecutor(telegram, this.claims, this.jobContext, this.onError),
    });
    this.loop.start();
    void this.refreshManifest();
    void this.refreshClaims();
    void this.sendHeartbeat();
    this.heartbeatTimer = setInterval(() => { void this.sendHeartbeat(); }, 30_000);
    this.manifestTimer = setInterval(() => { void this.refreshManifest(); }, 25_000);
    this.claimTimer = setInterval(() => { void this.refreshClaims(); }, 2_000);
    for (const timer of [this.heartbeatTimer, this.manifestTimer, this.claimTimer]) {
      if (typeof timer.unref === 'function') timer.unref();
    }
  }

  public async refreshManifest(): Promise<void> {
    const result = await this.client.fetchManifest();
    if (result.manifest !== undefined) this.manifest = result.manifest;
  }

  public async refreshClaims(): Promise<void> {
    await this.client.flushSpool();
    const snapshot = await this.client.fetchClaims(this.claimCursor);
    if (snapshot === undefined) return;
    for (const claim of snapshot.claims) {
      if (claim.active) this.claims.set(claim);
      else this.claims.clear(claim.conversationKey, claim.generation);
    }
    this.claimCursor = snapshot.cursor;
  }

  public shouldHandle(update: RuntimeUpdate): boolean { return matchManifest(this.manifest, this.claims, update).matched; }
  public async ingestMatched(update: JsonObject): Promise<boolean> { return this.client.ingest({ type: 'update', at: Date.now(), handled: true, update }); }
  public async runFlow(flowKey: string, inputs: JsonObject | undefined, update: JsonObject): Promise<{ executionId: string; acceptedAt?: number }> { return this.client.runFlow({ flowKey, inputs, update }); }
  public destroy(): void {
    this.loop?.stop();
    if (this.heartbeatTimer !== undefined) clearInterval(this.heartbeatTimer);
    if (this.manifestTimer !== undefined) clearInterval(this.manifestTimer);
    if (this.claimTimer !== undefined) clearInterval(this.claimTimer);
  }

  private capabilities(): string[] { return [...new Set([...BUILT_IN_CAPABILITIES, ...(this.options.capabilities ?? [])])]; }
  private async sendHeartbeat(): Promise<void> {
    if (this.telegram === undefined) return;
    try {
      const me = await this.telegram.getMe();
      await this.client.heartbeat({
        instanceId: this.instanceId,
        client: { name: 'telegraf', version: '0.4.0' },
        identity: { platform: 'telegram', accountId: String(me.id), ...(me.username === undefined ? {} : { username: me.username }) },
        capabilities: this.capabilities(),
      });
    } catch (error) {
      this.onError(error);
    }
  }
}

export function toRuntimeUpdate(update: JsonObject, botIdentity?: { id?: string | number; username?: string }): RuntimeUpdate {
  const message = isObject(update.message) ? update.message : isObject(update.edited_message) ? update.edited_message : undefined;
  const callback = isObject(update.callback_query) ? update.callback_query : undefined;
  const callbackMessage = callback !== undefined && isObject(callback.message) ? callback.message : undefined;
  const chat = message !== undefined && isObject(message.chat) ? message.chat : callbackMessage !== undefined && isObject(callbackMessage.chat) ? callbackMessage.chat : undefined;
  const sender = message !== undefined && isObject(message.from) ? message.from : callback !== undefined && isObject(callback.from) ? callback.from : undefined;
  const text = message !== undefined && typeof message.text === 'string' ? message.text : undefined;
  const command = text?.match(/^\/([^\s@]+)(?:@([^\s]+))?(?:\s+([\s\S]*))?$/);
  const chatType = chat !== undefined && ['private', 'group', 'supergroup', 'channel'].includes(String(chat.type)) ? chat.type as RuntimeUpdate['chatType'] : undefined;
  const commandTarget = command?.[2]?.toLocaleLowerCase();
  const username = botIdentity?.username?.replace(/^@/, '').toLocaleLowerCase();
  const reply = message !== undefined && isObject(message.reply_to_message) ? message.reply_to_message : undefined;
  const replyFrom = reply !== undefined && isObject(reply.from) ? reply.from : undefined;
  const repliesToBot = botIdentity?.id !== undefined && replyFrom !== undefined && (typeof replyFrom.id === 'number' || typeof replyFrom.id === 'string') && String(replyFrom.id) === String(botIdentity.id);
  const mentionsBot = username !== undefined && text?.toLocaleLowerCase().includes(`@${username}`) === true;
  const commandAddressesBot = command !== undefined && command !== null && (commandTarget === undefined || username === undefined || commandTarget === username);
  return {
    ...(typeof update.update_id === 'number' ? { updateId: update.update_id } : {}),
    ...(chat !== undefined && (typeof chat.id === 'number' || typeof chat.id === 'string') ? { chatId: chat.id } : {}),
    ...(sender !== undefined && (typeof sender.id === 'number' || typeof sender.id === 'string') ? { actorId: sender.id } : {}),
    ...(chatType === undefined ? {} : { chatType }),
    ...(text === undefined ? {} : { text }),
    ...(command === null || command === undefined ? {} : { command: command[1], ...(command[3] === undefined ? {} : { commandPayload: command[3] }) }),
    ...(callback !== undefined && typeof callback.data === 'string' ? { callbackData: callback.data } : {}),
    addressed: chatType === 'private' || callback !== undefined || commandAddressesBot || repliesToBot || mentionsBot,
    raw: update,
  };
}

export { conversationKey };
