import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';

import { InputFile } from 'grammy';
import type { Api } from 'grammy';
import {
  conversationKey,
  ConversationClaims,
  decodeTransportParams,
  matchManifest,
  RuntimeClient,
  RuntimeJobLoop,
} from '@flowcastle/sdk-runtime';
import type { JsonObject, JsonValue, RuntimeJob, RuntimeJobAck, RuntimeManifest, RuntimeUpdate } from '@flowcastle/sdk-runtime';
import { SDK_VERSION } from './version';

const SAFE_METHODS = new Set([
  'sendMessage', 'sendPhoto', 'sendDocument', 'sendVideo', 'sendVideoNote', 'sendAnimation',
  'sendAudio', 'sendVoice', 'sendSticker', 'sendMediaGroup', 'sendContact', 'sendDice', 'sendLocation',
  'sendPoll', 'sendVenue', 'sendInvoice', 'createInvoiceLink', 'editMessageText', 'editMessageMedia',
  'editMessageReplyMarkup', 'editMessageCaption', 'deleteMessage', 'answerCallbackQuery',
  'answerPreCheckoutQuery', 'sendChatAction', 'restrictChatMember', 'banChatMember', 'unbanChatMember',
  'getChatMember', 'pinChatMessage', 'unpinChatMessage', 'getMe', 'refundStarPayment',
]);
const LIFECYCLE_METHODS = new Set(['getUpdates', 'setWebhook', 'deleteWebhook', 'close', 'logOut']);
const BUILT_IN_CAPABILITIES = [
  'telegram.bot_api',
  'telegram.send_message',
  'telegram.inline_keyboard',
  'telegram.media',
  'telegram.payments',
  ...[...SAFE_METHODS].map((method) => `transport.telegram.bot_api.${method}`),
];

type RawMethod = Api['raw'];
type JsonParams = Record<string, unknown>;

function isObject(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value); }
function jsonValue(value: unknown): JsonValue {
  const serialized = JSON.stringify(value);
  if (serialized === undefined) return null;
  return JSON.parse(serialized) as JsonValue;
}

function paramsForGrammy(value: JsonObject): JsonParams {
  return decodeTransportParams(value, (file) => new InputFile(Buffer.from(file.bytes), file.filename)) as JsonParams;
}

function applySessionClaim(claims: ConversationClaims, job: RuntimeJob): RuntimeJobAck {
  const active = job.params.active;
  const key = typeof job.params.conversationKey === 'string'
    ? job.params.conversationKey
    : job.conversationKey ?? job.chatKey;
  const generation = typeof job.params.generation === 'number' ? job.params.generation : 0;
  if (key === undefined || typeof active !== 'boolean') return { id: job.id, leaseToken: job.leaseToken, ok: false, errorCode: 400, errorDescription: 'invalid session state job' };
  if (!active) { claims.clear(key, generation); return { id: job.id, leaseToken: job.leaseToken, ok: true }; }
  const expiresAt = typeof job.params.expiresAt === 'number' ? job.params.expiresAt : Date.now() + 30 * 60_000;
  const kinds = Array.isArray(job.params.kinds) ? job.params.kinds.filter((kind): kind is string => typeof kind === 'string') : ['flow'];
  claims.set({ conversationKey: key, generation, kinds, expiresAt });
  return { id: job.id, leaseToken: job.leaseToken, ok: true };
}

/** Executes a safe, explicit Telegram method set. Lifecycle token/webhook methods are permanently denied. */
export class GrammyRuntimeJobExecutor {
  public constructor(
    private readonly api: Api,
    private readonly claims: ConversationClaims,
    private readonly jobContext: AsyncLocalStorage<string>,
    private readonly onError: (error: unknown) => void,
  ) {}

  public async execute(job: RuntimeJob): Promise<RuntimeJobAck> {
    const operation = job.operation ?? job.method;
    if (job.kind === 'session_state'
      || (job.kind === 'control' && operation === 'conversation_claim')) {
      return applySessionClaim(this.claims, job);
    }
    if (operation === undefined || LIFECYCLE_METHODS.has(operation) || !SAFE_METHODS.has(operation)) {
      this.onError(new Error(`FlowCastle: refused disallowed runtime method '${operation ?? 'unknown'}'`));
      return {
        id: job.id,
        leaseToken: job.leaseToken,
        ok: false,
        error: { code: 400, description: 'method not allowed' },
        errorCode: 400,
        errorDescription: 'method not allowed',
      };
    }
    try {
      const result = await this.jobContext.run(
        job.id,
        () => this.dispatch(operation as keyof RawMethod, paramsForGrammy(job.params)),
      );
      return { id: job.id, leaseToken: job.leaseToken, ok: true, result: jsonValue(result) };
    } catch (error) {
      const description = isObject(error) && typeof error.description === 'string' ? error.description : error instanceof Error ? error.message : 'telegram method failed';
      const errorCode = isObject(error) && typeof error.error_code === 'number' ? error.error_code : undefined;
      this.onError(error);
      return {
        id: job.id,
        leaseToken: job.leaseToken,
        ok: false,
        error: { ...(errorCode === undefined ? {} : { code: errorCode }), description },
        ...(errorCode === undefined ? {} : { errorCode }),
        errorDescription: description,
      };
    }
  }

  // Each case is a deliberately explicit typed entrypoint: the server can never dynamically access bot APIs.
  private async dispatch(method: keyof RawMethod, params: JsonParams): Promise<unknown> {
    switch (method) {
      case 'sendMessage': return this.api.raw.sendMessage(params as Parameters<RawMethod['sendMessage']>[0]);
      case 'sendPhoto': return this.api.raw.sendPhoto(params as Parameters<RawMethod['sendPhoto']>[0]);
      case 'sendDocument': return this.api.raw.sendDocument(params as Parameters<RawMethod['sendDocument']>[0]);
      case 'sendVideo': return this.api.raw.sendVideo(params as Parameters<RawMethod['sendVideo']>[0]);
      case 'sendVideoNote': return this.api.raw.sendVideoNote(params as Parameters<RawMethod['sendVideoNote']>[0]);
      case 'sendAnimation': return this.api.raw.sendAnimation(params as Parameters<RawMethod['sendAnimation']>[0]);
      case 'sendAudio': return this.api.raw.sendAudio(params as Parameters<RawMethod['sendAudio']>[0]);
      case 'sendVoice': return this.api.raw.sendVoice(params as Parameters<RawMethod['sendVoice']>[0]);
      case 'sendSticker': return this.api.raw.sendSticker(params as Parameters<RawMethod['sendSticker']>[0]);
      case 'sendMediaGroup': return this.api.raw.sendMediaGroup(params as Parameters<RawMethod['sendMediaGroup']>[0]);
      case 'sendContact': return this.api.raw.sendContact(params as Parameters<RawMethod['sendContact']>[0]);
      case 'sendDice': return this.api.raw.sendDice(params as Parameters<RawMethod['sendDice']>[0]);
      case 'sendLocation': return this.api.raw.sendLocation(params as Parameters<RawMethod['sendLocation']>[0]);
      case 'sendPoll': return this.api.raw.sendPoll(params as Parameters<RawMethod['sendPoll']>[0]);
      case 'sendVenue': return this.api.raw.sendVenue(params as Parameters<RawMethod['sendVenue']>[0]);
      case 'sendInvoice': return this.api.raw.sendInvoice(params as Parameters<RawMethod['sendInvoice']>[0]);
      case 'createInvoiceLink': return this.api.raw.createInvoiceLink(params as Parameters<RawMethod['createInvoiceLink']>[0]);
      case 'editMessageText': return this.api.raw.editMessageText(params as Parameters<RawMethod['editMessageText']>[0]);
      case 'editMessageMedia': return this.api.raw.editMessageMedia(params as Parameters<RawMethod['editMessageMedia']>[0]);
      case 'editMessageReplyMarkup': return this.api.raw.editMessageReplyMarkup(params as Parameters<RawMethod['editMessageReplyMarkup']>[0]);
      case 'editMessageCaption': return this.api.raw.editMessageCaption(params as Parameters<RawMethod['editMessageCaption']>[0]);
      case 'deleteMessage': return this.api.raw.deleteMessage(params as Parameters<RawMethod['deleteMessage']>[0]);
      case 'answerCallbackQuery': return this.api.raw.answerCallbackQuery(params as Parameters<RawMethod['answerCallbackQuery']>[0]);
      case 'answerPreCheckoutQuery': return this.api.raw.answerPreCheckoutQuery(params as Parameters<RawMethod['answerPreCheckoutQuery']>[0]);
      case 'sendChatAction': return this.api.raw.sendChatAction(params as Parameters<RawMethod['sendChatAction']>[0]);
      case 'restrictChatMember': return this.api.raw.restrictChatMember(params as Parameters<RawMethod['restrictChatMember']>[0]);
      case 'banChatMember': return this.api.raw.banChatMember(params as Parameters<RawMethod['banChatMember']>[0]);
      case 'unbanChatMember': return this.api.raw.unbanChatMember(params as Parameters<RawMethod['unbanChatMember']>[0]);
      case 'getChatMember': return this.api.raw.getChatMember(params as Parameters<RawMethod['getChatMember']>[0]);
      case 'pinChatMessage': return this.api.raw.pinChatMessage(params as Parameters<RawMethod['pinChatMessage']>[0]);
      case 'unpinChatMessage': return this.api.raw.unpinChatMessage(params as Parameters<RawMethod['unpinChatMessage']>[0]);
      case 'getMe': return this.api.raw.getMe();
      case 'refundStarPayment': return this.api.raw.refundStarPayment(params as Parameters<RawMethod['refundStarPayment']>[0]);
      default: throw new Error(`FlowCastle: unsupported safe method '${String(method)}'`);
    }
  }
}

export interface GrammyRuntimeOptions { enabled?: boolean; capabilities?: string[]; instanceId?: string; }

export class GrammyRuntime {
  public readonly claims = new ConversationClaims();
  private manifest: RuntimeManifest | undefined;
  private loop: RuntimeJobLoop | undefined;
  private api: Api | undefined;
  private heartbeatTimer: ReturnType<typeof setInterval> | undefined;
  private manifestTimer: ReturnType<typeof setInterval> | undefined;
  private claimTimer: ReturnType<typeof setInterval> | undefined;
  private claimCursor: string | undefined;
  private readonly instanceId: string;

  public constructor(private readonly client: RuntimeClient, private readonly options: GrammyRuntimeOptions, private readonly jobContext: AsyncLocalStorage<string>, private readonly onError: (error: unknown) => void) {
    this.instanceId = options.instanceId ?? randomUUID();
  }

  private capabilities(): string[] { return [...new Set([...BUILT_IN_CAPABILITIES, ...(this.options.capabilities ?? [])])]; }

  public attach(api: Api): void {
    this.api = api;
    if (this.loop === undefined) {
      this.loop = new RuntimeJobLoop({ apiKey: this.client.headers().Authorization.replace('Bearer ', ''), apiUrl: this.client.baseUrl(), onError: this.onError, capabilities: this.capabilities(), executor: new GrammyRuntimeJobExecutor(api, this.claims, this.jobContext, this.onError) });
      this.loop.start();
      void this.refreshManifest();
      void this.refreshClaims();
      void this.sendHeartbeat();
      this.heartbeatTimer = setInterval(() => { void this.sendHeartbeat(); }, 30_000);
      this.manifestTimer = setInterval(() => { void this.refreshManifest(); }, 25_000);
      this.claimTimer = setInterval(() => { void this.refreshClaims(); }, 2_000);
      if (typeof this.heartbeatTimer.unref === 'function') this.heartbeatTimer.unref();
      if (typeof this.manifestTimer.unref === 'function') this.manifestTimer.unref();
      if (typeof this.claimTimer.unref === 'function') this.claimTimer.unref();
    }
  }

  public async refreshManifest(): Promise<void> { const result = await this.client.fetchManifest(); if (result.manifest !== undefined) this.manifest = result.manifest; }
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
  public destroy(): void {
    this.loop?.stop();
    if (this.heartbeatTimer !== undefined) clearInterval(this.heartbeatTimer);
    if (this.manifestTimer !== undefined) clearInterval(this.manifestTimer);
    if (this.claimTimer !== undefined) clearInterval(this.claimTimer);
  }
  public shouldHandle(update: RuntimeUpdate): boolean { return matchManifest(this.manifest, this.claims, update).matched; }
  public async ingestMatched(update: JsonObject): Promise<boolean> { return this.client.ingest({ type: 'update', at: Date.now(), handled: true, update }); }
  public async runFlow(flowKey: string, inputs: JsonObject | undefined, update: JsonObject): Promise<{ executionId: string; acceptedAt?: number }> { return this.client.runFlow({ flowKey, inputs, update }); }
  public async heartbeat(instanceId: string, botId?: number, username?: string): Promise<boolean> {
    if (botId === undefined) return false;
    return this.client.heartbeat({
      instanceId,
      client: { name: 'grammy', version: SDK_VERSION },
      identity: {
        platform: 'telegram',
        accountId: String(botId),
        ...(username === undefined ? {} : { username }),
      },
      capabilities: this.capabilities(),
    });
  }

  private async sendHeartbeat(): Promise<void> {
    if (this.api === undefined) return;
    try {
      const me = await this.api.raw.getMe();
      await this.heartbeat(this.instanceId, me.id, me.username);
    } catch (error) { this.onError(error); }
  }
}

export function toRuntimeUpdate(
  update: JsonObject,
  botIdentity?: { id?: string | number; username?: string },
): RuntimeUpdate {
  const message = isObject(update.message) ? update.message : isObject(update.edited_message) ? update.edited_message : undefined;
  const callback = isObject(update.callback_query) ? update.callback_query : undefined;
  const callbackMessage = callback !== undefined && isObject(callback.message) ? callback.message : undefined;
  const messageChat = message !== undefined && isObject(message.chat)
    ? message.chat
    : callbackMessage !== undefined && isObject(callbackMessage.chat) ? callbackMessage.chat : undefined;
  const sender = message !== undefined && isObject(message.from) ? message.from : callback !== undefined && isObject(callback.from) ? callback.from : undefined;
  const text = message !== undefined && typeof message.text === 'string' ? message.text : undefined;
  const match = text?.match(/^\/([^\s@]+)(?:@([^\s]+))?(?:\s+([\s\S]*))?$/);
  const chatType = messageChat !== undefined && ['private', 'group', 'supergroup', 'channel'].includes(String(messageChat.type))
    ? messageChat.type as RuntimeUpdate['chatType']
    : undefined;
  const commandTarget = match?.[2]?.toLocaleLowerCase();
  const botUsername = botIdentity?.username?.replace(/^@/, '').toLocaleLowerCase();
  const reply = message !== undefined && isObject(message.reply_to_message) ? message.reply_to_message : undefined;
  const replyFrom = reply !== undefined && isObject(reply.from) ? reply.from : undefined;
  const repliesToBot = botIdentity?.id !== undefined && replyFrom !== undefined
    && (typeof replyFrom.id === 'number' || typeof replyFrom.id === 'string')
    && String(replyFrom.id) === String(botIdentity.id);
  const mentionsBot = botUsername !== undefined && text?.toLocaleLowerCase().includes(`@${botUsername}`) === true;
  const commandAddressesBot = match !== undefined && (commandTarget === undefined || botUsername === undefined || commandTarget === botUsername);
  const addressed = chatType === 'private' || callback !== undefined || commandAddressesBot || repliesToBot || mentionsBot;
  return {
    ...(typeof update.update_id === 'number' ? { updateId: update.update_id } : {}),
    ...(messageChat !== undefined && (typeof messageChat.id === 'number' || typeof messageChat.id === 'string') ? { chatId: messageChat.id } : callback !== undefined && isObject(callback.message) && isObject(callback.message.chat) && (typeof callback.message.chat.id === 'number' || typeof callback.message.chat.id === 'string') ? { chatId: callback.message.chat.id } : {}),
    ...(sender !== undefined && (typeof sender.id === 'number' || typeof sender.id === 'string') ? { actorId: sender.id } : {}),
    ...(chatType === undefined ? {} : { chatType }),
    ...(text === undefined ? {} : { text }),
    ...(match === null || match === undefined ? {} : { command: match[1], ...(match[3] === undefined ? {} : { commandPayload: match[3] }) }),
    ...(callback !== undefined && typeof callback.data === 'string' ? { callbackData: callback.data } : {}),
    addressed,
    raw: update,
  };
}

export { conversationKey };
