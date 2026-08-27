import { AsyncLocalStorage } from 'node:async_hooks';

import type { Context, MiddlewareFn, Telegram } from 'telegraf';
import { RuntimeClient, TelegramPrivacyFilter } from '@flowcastle/sdk-runtime';
import type { JsonObject, TelegramPrivacyOptions } from '@flowcastle/sdk-runtime';

import type { SdkLiveAgentRequestEvent, SdkOutgoingEvent } from './events';
import { JobPuller } from './jobs';
import { LiveAgentWindow } from './live-agent';
import { TelegrafRuntime, toRuntimeUpdate } from './runtime';
import type { TelegrafRuntimeOptions } from './runtime';
import { Transport } from './transport';

export type {
  SdkEvent,
  SdkUpdateEvent,
  SdkOutgoingEvent,
  SdkGoalEvent,
  SdkIdentifyEvent,
  SdkLiveAgentRequestEvent,
} from './events';
export { SDK_VERSION } from './version';
export { TelegrafRuntime, TelegrafRuntimeJobExecutor, toRuntimeUpdate } from './runtime';
export type { TelegrafRuntimeOptions } from './runtime';
export type {
  MessageContentMode,
  TelegramContactField,
  TelegramMessageContentOptions,
  TelegramPrivacyOptions,
  TelegramTextField,
  TelegramTextTransformContext,
  TelegramTextTransformer,
} from '@flowcastle/sdk-runtime';

const DEFAULT_API_URL = 'https://my.flowcastle.ai';
const DEFAULT_FLUSH_INTERVAL_MS = 3_000;
const DEFAULT_MAX_BATCH_SIZE = 20;
const MAX_BATCH_SIZE = 50;
const DEFAULT_LIVE_AGENT_WINDOW_MS = 30 * 60_000;
const MAX_LIVE_AGENT_NOTE_LENGTH = 500;

export interface FlowCastleOptions {
  apiKey: string;
  apiUrl?: string;
  privacy?: TelegramPrivacyOptions;
  /** @deprecated Use `privacy.messageContent` instead. */
  redactText?: boolean;
  flushIntervalMs?: number;
  maxBatchSize?: number;
  onError?: (error: unknown) => void;
  pullJobs?: boolean;
  liveAgentWindowMs?: number;
  /** Enables FlowCastle's opt-in server-side proxy runtime. */
  runtime?: TelegrafRuntimeOptions;
}

export interface FlowCastleCtx {
  goal(key: string, props?: Record<string, unknown>): void;
  identify(props: Record<string, unknown>): void;
  requestLiveAgent(options?: { note?: string }): void;
  readonly isLiveAgentActive: boolean;
  runFlow(flowKey: string, options?: { inputs?: Record<string, unknown> }): Promise<{ executionId: string; acceptedAt?: number }>;
}

/** Context flavour installed by the middleware for the current update. */
export type FlowCastleFlavor<C extends Context> = C & { flowcastle: FlowCastleCtx };

export interface FlowCastleMiddleware<C extends Context> extends MiddlewareFn<C> {
  flush(): Promise<void>;
  ready(): Promise<void>;
  destroy(): void;
  /**
   * Wrap a Telegraf transport before `bot.launch()` to observe calls made outside
   * middleware too. The middleware installs this wrapper lazily for
   * `ctx.telegram`; explicit installation is recommended for `bot.telegram`
   * calls made before the first incoming update.
   */
  wrapTelegram(telegram: Telegram): void;
}

interface CallOutcome {
  ok: boolean;
  result?: unknown;
  errorCode?: number;
  errorDescription?: string;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function clampBatchSize(value: number): number {
  if (!Number.isFinite(value) || value < 1) return 1;
  return Math.min(Math.floor(value), MAX_BATCH_SIZE);
}

function normalizeUrl(value: string): string { return value.replace(/\/+$/, ''); }

function extractChatId(payload: unknown): number | string | undefined {
  if (!isObject(payload)) return undefined;
  const value = payload.chat_id;
  return typeof value === 'number' || typeof value === 'string' ? value : undefined;
}

function extractMessageId(result: unknown): number | undefined {
  return isObject(result) && typeof result.message_id === 'number' ? result.message_id : undefined;
}

function errorDetails(error: unknown): Pick<CallOutcome, 'errorCode' | 'errorDescription'> {
  if (!isObject(error)) return {};
  return {
    ...(typeof error.error_code === 'number' ? { errorCode: error.error_code } : {}),
    ...(typeof error.description === 'string' ? { errorDescription: error.description } : {}),
  };
}

async function outgoingEvent(
  method: string,
  payload: unknown,
  outcome: CallOutcome,
  privacy: TelegramPrivacyFilter,
  updateId: number | undefined,
  jobId: string | undefined,
): Promise<SdkOutgoingEvent> {
  const event: SdkOutgoingEvent = { type: 'outgoing', at: Date.now(), method, ok: outcome.ok };
  const chatId = extractChatId(payload);
  if (chatId !== undefined) event.chatId = chatId;
  if (updateId !== undefined) event.correlationUpdateId = updateId;
  if (jobId !== undefined) event.correlationJobId = jobId;
  if (outcome.errorCode !== undefined) event.errorCode = outcome.errorCode;
  if (outcome.errorDescription !== undefined) event.errorDescription = outcome.errorDescription;
  const sanitized = await privacy.sanitizeOutgoingPayload(payload);
  if (sanitized !== undefined) event.payload = sanitized;
  const messageId = extractMessageId(outcome.result);
  if (messageId !== undefined) event.result = { messageId };
  return event;
}

/**
 * Observe a Telegraf Telegram instance by replacing its single `callApi`
 * gateway. This is intentionally an opt-in public wrapper because Telegraf
 * middleware does not receive the `Telegraf` instance and cannot see calls made
 * through `bot.telegram` before the first update. The wrapper preserves the
 * original resolved value and rejection exactly.
 */
function observeTelegram(
  telegram: Telegram,
  installed: WeakSet<object>,
  transport: Transport,
  privacy: TelegramPrivacyFilter,
  onError: (error: unknown) => void,
  correlation: AsyncLocalStorage<number>,
  jobContext: AsyncLocalStorage<string>,
): void {
  if (installed.has(telegram)) return;
  installed.add(telegram);
  const original = telegram.callApi.bind(telegram) as unknown as (...args: unknown[]) => Promise<unknown>;
  const observed = async (...args: unknown[]): Promise<unknown> => {
    const method = typeof args[0] === 'string' ? args[0] : 'unknown';
    const payload = args[1];
    const updateId = correlation.getStore();
    const jobId = jobContext.getStore();
    try {
      const result = await original(...args);
      try {
        transport.enqueue(await outgoingEvent(method, payload, { ok: true, result }, privacy, updateId, jobId));
      } catch (error) {
        onError(error);
      }
      return result;
    } catch (error) {
      try {
        transport.enqueue(await outgoingEvent(method, payload, { ok: false, ...errorDetails(error) }, privacy, updateId, jobId));
      } catch (bookkeepingError) {
        onError(bookkeepingError);
      }
      throw error;
    }
  };
  Object.defineProperty(telegram, 'callApi', { configurable: true, writable: true, value: observed });
}

function asJsonObject(value: unknown): JsonObject {
  if (!isObject(value)) throw new Error('FlowCastle: current update is not serializable');
  return value as unknown as JsonObject;
}

/**
 * FlowCastle Telegraf middleware. It observes every incoming update, injects
 * `ctx.flowcastle`, and only consumes an update when an enabled runtime claim or
 * manifest trigger owns it. All other middleware continues normally.
 */
export function flowcastle<C extends Context>(options: FlowCastleOptions): FlowCastleMiddleware<C> {
  const apiUrl = normalizeUrl(options.apiUrl ?? DEFAULT_API_URL);
  const onError = options.onError ?? (() => undefined);
  const privacy = new TelegramPrivacyFilter(options.privacy, onError, options.privacy === undefined && (options.redactText ?? false));
  const transport = new Transport({
    apiKey: options.apiKey,
    apiUrl,
    flushIntervalMs: options.flushIntervalMs ?? DEFAULT_FLUSH_INTERVAL_MS,
    maxBatchSize: clampBatchSize(options.maxBatchSize ?? DEFAULT_MAX_BATCH_SIZE),
    onError,
  });
  const runtimeEnabled = options.runtime?.enabled ?? false;
  const correlation = new AsyncLocalStorage<number>();
  const jobContext = new AsyncLocalStorage<string>();
  const liveAgentWindow = new LiveAgentWindow(options.liveAgentWindowMs ?? DEFAULT_LIVE_AGENT_WINDOW_MS);
  const runtime = runtimeEnabled
    ? new TelegrafRuntime(new RuntimeClient({ apiKey: options.apiKey, apiUrl, onError }), options.runtime ?? {}, jobContext, onError)
    : undefined;
  const puller = (options.pullJobs ?? true) && !runtimeEnabled
    ? new JobPuller({ apiKey: options.apiKey, apiUrl, onError, jobContext, onJobDelivered: (chatId) => liveAgentWindow.touch(chatId) })
    : undefined;
  const installed = new WeakSet<object>();

  if (options.redactText !== undefined && options.privacy !== undefined) {
    try { onError(new Error('FlowCastle: redactText is deprecated and ignored because privacy is configured')); } catch { /* no-op */ }
  }

  const wrapTelegram = (telegram: Telegram): void => {
    observeTelegram(telegram, installed, transport, privacy, onError, correlation, jobContext);
    puller?.setTelegram(telegram);
    runtime?.attach(telegram);
  };

  const middleware: MiddlewareFn<C> = async (ctx, next): Promise<void> => {
    const run = async (): Promise<void> => {
      let sanitizedUpdate: JsonObject | undefined;
      try {
        wrapTelegram(ctx.telegram);
        sanitizedUpdate = await privacy.sanitizeUpdate(asJsonObject(ctx.update));
        const flowcastleContext: FlowCastleCtx = {
          goal(key, props): void {
            try {
              transport.enqueue({ type: 'goal', at: Date.now(), key, telegramUserId: ctx.from?.id, chatId: ctx.chat?.id, props, correlationUpdateId: correlation.getStore() });
            } catch (error) { onError(error); }
          },
          identify(props): void {
            const from = ctx.from;
            if (from === undefined) {
              onError(new Error('FlowCastle: identify() called without ctx.from; skipping'));
              return;
            }
            transport.enqueue({ type: 'identify', at: Date.now(), telegramUserId: from.id, props, correlationUpdateId: correlation.getStore() });
          },
          requestLiveAgent(request): void {
            const from = ctx.from;
            if (from === undefined) {
              onError(new Error('FlowCastle: requestLiveAgent() called without ctx.from; skipping'));
              return;
            }
            const event: SdkLiveAgentRequestEvent = { type: 'live_agent_request', at: Date.now(), telegramUserId: from.id };
            if (ctx.chat?.id !== undefined) {
              event.chatId = ctx.chat.id;
              liveAgentWindow.touch(ctx.chat.id);
            }
            if (request?.note !== undefined) event.note = request.note.slice(0, MAX_LIVE_AGENT_NOTE_LENGTH);
            transport.enqueue(event);
          },
          get isLiveAgentActive(): boolean {
            return ctx.chat?.id === undefined ? false : liveAgentWindow.isActive(ctx.chat.id);
          },
          async runFlow(flowKey, runOptions): Promise<{ executionId: string; acceptedAt?: number }> {
            if (runtime === undefined) {
              const error = new Error('FlowCastle: runFlow() requires runtime.enabled: true');
              onError(error);
              throw error;
            }
            if (flowKey.length === 0) throw new Error('FlowCastle: flowKey must be a non-empty string');
            if (sanitizedUpdate === undefined) throw new Error('FlowCastle: current update could not be sanitized');
            return runtime.runFlow(flowKey, runOptions?.inputs as JsonObject | undefined, sanitizedUpdate);
          },
        };
        Object.defineProperty(ctx, 'flowcastle', { configurable: true, value: flowcastleContext });
      } catch (error) {
        onError(error);
      }

      if (runtime !== undefined && sanitizedUpdate !== undefined && runtime.shouldHandle(toRuntimeUpdate(sanitizedUpdate, ctx.botInfo))) {
        await runtime.ingestMatched(sanitizedUpdate);
        return;
      }
      if (sanitizedUpdate !== undefined) {
        transport.enqueue({ type: 'update', at: Date.now(), update: sanitizedUpdate });
      }
      await next();
    };
    const updateId = ctx.update.update_id;
    if (typeof updateId === 'number') await correlation.run(updateId, run);
    else await run();
  };

  return Object.assign(middleware, {
    flush: (): Promise<void> => transport.flush(),
    ready: async (): Promise<void> => {
      await runtime?.refreshManifest();
      await runtime?.refreshClaims();
    },
    destroy: (): void => {
      transport.destroy();
      puller?.destroy();
      runtime?.destroy();
    },
    wrapTelegram,
  });
}
