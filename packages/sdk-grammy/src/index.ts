import { AsyncLocalStorage } from 'node:async_hooks';

import type { Context, MiddlewareFn, NextFunction, Transformer } from 'grammy';

import type { SdkLiveAgentRequestEvent, SdkOutgoingEvent } from './events';
import { JobPuller } from './jobs';
import { LiveAgentWindow } from './live-agent';
import { GrammyRuntime, toRuntimeUpdate } from './runtime';
import { Transport } from './transport';
import type { GrammyRuntimeOptions } from './runtime';
import { RuntimeClient, TelegramPrivacyFilter } from '@flowcastle/sdk-runtime';
import type { JsonObject, TelegramPrivacyOptions } from '@flowcastle/sdk-runtime';

export type {
  SdkEvent,
  SdkUpdateEvent,
  SdkOutgoingEvent,
  SdkGoalEvent,
  SdkIdentifyEvent,
  SdkLiveAgentRequestEvent,
} from './events';
export { SDK_VERSION } from './version';
export { GrammyRuntime, GrammyRuntimeJobExecutor, toRuntimeUpdate } from './runtime';
export type { GrammyRuntimeOptions } from './runtime';
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
const DEFAULT_FLUSH_INTERVAL_MS = 3000;
const DEFAULT_MAX_BATCH_SIZE = 20;
const MAX_BATCH_SIZE_CLAMP = 50;
const DEFAULT_LIVE_AGENT_WINDOW_MS = 30 * 60 * 1000;
const MAX_LIVE_AGENT_NOTE_LENGTH = 500;

export interface FlowCastleOptions {
  /** FlowCastle SDK key (`fc_sdk_…`). */
  apiKey: string;
  /** Ingest base URL. Default `https://my.flowcastle.ai`. */
  apiUrl?: string;
  /**
   * Local, framework-neutral controls for Telegram profile fields and message
   * content sent to FlowCastle. Passing an empty object enables privacy-first
   * defaults; omitting it preserves the pre-policy SDK behavior.
   */
  privacy?: TelegramPrivacyOptions;
  /**
   * Strip message content before buffering. Deprecated: use
   * `privacy.messageContent`. Ignored when `privacy` is configured.
   * @deprecated
   */
  redactText?: boolean;
  /** Flush cadence in ms. Default `3000`. */
  flushIntervalMs?: number;
  /** Events per flush before an eager flush; hard-clamped to `50`. Default `20`. */
  maxBatchSize?: number;
  /** Observability hook for internal failures. Default: silent no-op. */
  onError?: (error: unknown) => void;
  /**
   * Pull and execute outbound delivery jobs (e.g. Live Chat agent replies) from
   * FlowCastle through the host bot's own Telegram connection. Default `true`.
   * The plugin only ever executes a hardcoded allowlist of methods
   * (`sendMessage`, `sendPhoto`, `sendDocument`, `sendChatAction`,
   * `answerCallbackQuery`) and refuses anything else. Set `false` to disable.
   */
  pullJobs?: boolean;
  /**
   * How long (ms) a chat stays flagged live-agent-active locally after
   * `requestLiveAgent()` or a delivered agent reply, governing
   * `ctx.flowcastle.isLiveAgentActive`. Best-effort/optimistic — see that
   * getter's docs. Default `1800000` (30 min).
   */
  liveAgentWindowMs?: number;
  /**
   * Enables FlowCastle's server-side flow proxy. The runtime protocol itself is
   * library-neutral; this option only supplies the grammY adapter. It is opt-in
   * to preserve the observation-only behavior of existing integrations.
   */
  runtime?: GrammyRuntimeOptions;
}

/** Injected onto `ctx.flowcastle` for the duration of an update. */
export interface FlowCastleCtx {
  /** Record a goal for the current user/chat. */
  goal(key: string, props?: Record<string, unknown>): void;
  /** Set contact traits for the current user. No-op (reported) if there is no `ctx.from`. */
  identify(props: Record<string, unknown>): void;
  /**
   * Escalate the current conversation to a human agent in FlowCastle Live Chat.
   * Enqueues a `live_agent_request` event and optimistically flags this chat
   * live-agent-active locally (see {@link isLiveAgentActive}). No-op (reported)
   * if there is no `ctx.from`. `note` is clamped to 500 chars.
   */
  requestLiveAgent(opts?: { note?: string }): void;
  /**
   * Best-effort, OPTIMISTIC hint: is a human agent currently handling this chat?
   *
   * Backed by a local, per-plugin time window that is opened by
   * `requestLiveAgent()` and refreshed by delivered agent replies — NOT by the
   * authoritative server-side state (a future iteration may sync that down). Use
   * it to suppress your own auto-replies while a human is engaged, accepting
   * that it can be stale in either direction. `false` when there is no
   * `ctx.chat`.
   */
  readonly isLiveAgentActive: boolean;
  /** Start a FlowCastle flow explicitly from customer code. Resolves when accepted. */
  runFlow(flowKey: string, options?: { inputs?: Record<string, unknown> }): Promise<{ executionId: string; acceptedAt?: number }>;
}

/** Context flavor adding `ctx.flowcastle`. Install with `Bot<FlowCastleFlavor<Context>>`. */
export type FlowCastleFlavor<C extends Context> = C & { flowcastle: FlowCastleCtx };

/**
 * The middleware returned by {@link flowcastle}. It is a plain grammY
 * `MiddlewareFn` with two extra maintenance methods for the host:
 * - `flush()` — force-ship buffered events now (also used by tests);
 * - `ready()` — refresh the optional proxy-runtime manifest before polling;
 * - `destroy()` — stop the flush timer, detach the exit handler, and stop the
 *   job-pull loop (aborting any in-flight long-poll).
 */
export interface FlowCastleMiddleware<C extends Context> {
  (ctx: C, next: NextFunction): Promise<void>;
  flush(): Promise<void>;
  /** Preload the optional FlowCastle proxy manifest without delaying bot startup. */
  ready(): Promise<void>;
  destroy(): void;
}

function clampBatchSize(value: number): number {
  if (!Number.isFinite(value) || value < 1) {
    return 1;
  }
  return Math.min(Math.floor(value), MAX_BATCH_SIZE_CLAMP);
}

function normalizeUrl(url: string): string {
  return url.replace(/\/+$/, '');
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function extractChatId(payload: unknown): number | string | undefined {
  if (isObject(payload) && 'chat_id' in payload) {
    const value = payload.chat_id;
    if (typeof value === 'number' || typeof value === 'string') {
      return value;
    }
  }
  return undefined;
}

function extractMessageId(result: unknown): number | undefined {
  if (isObject(result) && typeof result.message_id === 'number') {
    return result.message_id;
  }
  return undefined;
}

async function buildOutgoingEvent(
  method: string,
  payload: unknown,
  outcome: { ok: boolean; errorCode?: number; errorDescription?: string; result?: unknown },
  privacyFilter: TelegramPrivacyFilter,
  correlationUpdateId: number | undefined,
  correlationJobId: string | undefined,
): Promise<SdkOutgoingEvent> {
  const event: SdkOutgoingEvent = {
    type: 'outgoing',
    at: Date.now(),
    method,
    ok: outcome.ok,
  };
  if (correlationUpdateId !== undefined) {
    event.correlationUpdateId = correlationUpdateId;
  }
  if (correlationJobId !== undefined) {
    event.correlationJobId = correlationJobId;
  }
  const chatId = extractChatId(payload);
  if (chatId !== undefined) {
    event.chatId = chatId;
  }
  if (outcome.errorCode !== undefined) {
    event.errorCode = outcome.errorCode;
  }
  if (outcome.errorDescription !== undefined) {
    event.errorDescription = outcome.errorDescription;
  }
  const sanitized = await privacyFilter.sanitizeOutgoingPayload(payload);
  if (sanitized !== undefined) {
    event.payload = sanitized;
  }
  const messageId = extractMessageId(outcome.result);
  if (messageId !== undefined) {
    event.result = { messageId };
  }
  return event;
}

/**
 * grammY API transformer: observes every outgoing Bot API call and its result.
 * Observation-only — the original result is returned and any error is rethrown
 * unchanged. Privacy transformation runs before enqueue and may add bounded
 * latency when an async `transformText` callback is configured.
 */
function createTransformer(
  transport: Transport,
  privacyFilter: TelegramPrivacyFilter,
  onError: (error: unknown) => void,
  correlation: AsyncLocalStorage<number>,
  jobContext: AsyncLocalStorage<string>,
): Transformer {
  const transformer: Transformer = async (prev, method, payload, signal) => {
    // Snapshot the correlated ids before awaiting; the stores are read
    // synchronously so concurrent updates/jobs never cross-contaminate.
    const correlationUpdateId = correlation.getStore();
    const correlationJobId = jobContext.getStore();
    let response: Awaited<ReturnType<typeof prev>>;
    try {
      response = await prev(method, payload, signal);
    } catch (error) {
      // Network/HTTP failure (grammY `HttpError`) or a GrammyError-shaped throw.
      try {
        let errorCode: number | undefined;
        let errorDescription: string | undefined;
        if (isObject(error)) {
          if (typeof error.error_code === 'number') {
            errorCode = error.error_code;
          }
          if (typeof error.description === 'string') {
            errorDescription = error.description;
          }
        }
        transport.enqueue(
          await buildOutgoingEvent(
            method,
            payload,
            { ok: false, errorCode, errorDescription },
            privacyFilter,
            correlationUpdateId,
            correlationJobId,
          ),
        );
      } catch (bookkeepingError) {
        onError(bookkeepingError);
      }
      throw error;
    }

    try {
      if (response.ok) {
        transport.enqueue(
          await buildOutgoingEvent(
            method,
            payload,
            { ok: true, result: response.result },
            privacyFilter,
            correlationUpdateId,
            correlationJobId,
          ),
        );
      } else {
        transport.enqueue(
          await buildOutgoingEvent(
            method,
            payload,
            { ok: false, errorCode: response.error_code, errorDescription: response.description },
            privacyFilter,
            correlationUpdateId,
            correlationJobId,
          ),
        );
      }
    } catch (bookkeepingError) {
      onError(bookkeepingError);
    }

    return response;
  };
  return transformer;
}

/**
 * FlowCastle grammY plugin. Observes incoming updates and outgoing Bot API calls,
 * batches them, and ships them to FlowCastle. It never throws into the middleware
 * chain and always calls `next()`.
 *
 * ```ts
 * bot.use(flowcastle({ apiKey: 'fc_sdk_…' }));
 * ```
 */
export function flowcastle<C extends Context>(options: FlowCastleOptions): FlowCastleMiddleware<C> {
  const apiUrl = normalizeUrl(options.apiUrl ?? DEFAULT_API_URL);
  const flushIntervalMs = options.flushIntervalMs ?? DEFAULT_FLUSH_INTERVAL_MS;
  const maxBatchSize = clampBatchSize(options.maxBatchSize ?? DEFAULT_MAX_BATCH_SIZE);
  const onError = options.onError ?? ((): void => undefined);
  const privacyFilter = new TelegramPrivacyFilter(
    options.privacy,
    onError,
    options.privacy === undefined && (options.redactText ?? false),
  );

  if (options.redactText !== undefined && options.privacy !== undefined) {
    try {
      onError(new Error('FlowCastle: redactText is deprecated and ignored because privacy is configured'));
    } catch {
      // Observability hooks never affect SDK initialization.
    }
  }

  const runtimeEnabled = options.runtime?.enabled ?? false;
  // Proxy mode owns the leased-job loop so a job is never executed twice by the
  // legacy live-chat puller and the v2 runtime client.
  const pullJobs = (options.pullJobs ?? true) && !runtimeEnabled;
  const liveAgentWindowMs = options.liveAgentWindowMs ?? DEFAULT_LIVE_AGENT_WINDOW_MS;

  const transport = new Transport({ apiKey: options.apiKey, apiUrl, flushIntervalMs, maxBatchSize, onError });

  // Per-plugin-instance, best-effort local record of which chats have a human
  // agent engaged, powering `ctx.flowcastle.isLiveAgentActive`. Opened by
  // requestLiveAgent() and refreshed by delivered agent-reply jobs (below).
  const liveAgentWindow = new LiveAgentWindow(liveAgentWindowMs);

  // Per-plugin-instance causal correlation: holds the `update_id` currently
  // being handled so the transformer (and goal/identify) can stamp it. Kept
  // per-instance so two coexisting plugins never read each other's store.
  const correlation = new AsyncLocalStorage<number>();

  // Per-plugin-instance job scope: holds the id of the delivery job currently
  // executing so the transformer can stamp `correlationJobId` on the outgoing
  // event it produces (Live Chat echo-loop guard).
  const jobContext = new AsyncLocalStorage<string>();

  const runtime = runtimeEnabled
    ? new GrammyRuntime(new RuntimeClient({ apiKey: options.apiKey, apiUrl, onError }), options.runtime ?? {}, jobContext, onError)
    : undefined;

  // Phase-2 pull channel. Idle until it receives the grammY Api (first update).
  // A delivered agent reply refreshes the live-agent window for its chat.
  const puller = pullJobs
    ? new JobPuller({
        apiKey: options.apiKey,
        apiUrl,
        onError,
        jobContext,
        onJobDelivered: (chatId): void => liveAgentWindow.touch(chatId),
      })
    : undefined;

  // One transformer per Api instance, installed lazily on first update.
  const transformerInstalled = new WeakSet<object>();

  const middleware = async (ctx: C, next: NextFunction): Promise<void> => {
    // Pre-bookkeeping + the host chain run inside the correlation scope so every
    // outgoing call caused by this update carries its `update_id`.
    const run = async (): Promise<void> => {
      let flowcastleUpdate: JsonObject | undefined;
      try {
        const api = ctx.api;
        if (!transformerInstalled.has(api)) {
          transformerInstalled.add(api);
          api.config.use(createTransformer(transport, privacyFilter, onError, correlation, jobContext));
          // Capture the same Api the transformer is on, so executed jobs are
          // observed as normal outgoing events (and start the pull loop).
          puller?.setApi(api);
          runtime?.attach(api);
        }

        const rawUpdate: unknown = ctx.update;
        if (!isObject(rawUpdate)) throw new Error('FlowCastle: current update is not serializable');
        flowcastleUpdate = await privacyFilter.sanitizeUpdate(rawUpdate as JsonObject);

        const flowcastleCtx: FlowCastleCtx = {
          goal(key: string, props?: Record<string, unknown>): void {
            try {
              transport.enqueue({
                type: 'goal',
                at: Date.now(),
                key,
                telegramUserId: ctx.from?.id,
                chatId: ctx.chat?.id,
                props,
                correlationUpdateId: correlation.getStore(),
              });
            } catch (error) {
              onError(error);
            }
          },
          identify(props: Record<string, unknown>): void {
            try {
              const from = ctx.from;
              if (from == null) {
                onError(new Error('FlowCastle: identify() called without ctx.from; skipping'));
                return;
              }
              transport.enqueue({
                type: 'identify',
                at: Date.now(),
                telegramUserId: from.id,
                props,
                correlationUpdateId: correlation.getStore(),
              });
            } catch (error) {
              onError(error);
            }
          },
          requestLiveAgent(opts?: { note?: string }): void {
            try {
              const from = ctx.from;
              if (from == null) {
                onError(new Error('FlowCastle: requestLiveAgent() called without ctx.from; skipping'));
                return;
              }
              const chatId = ctx.chat?.id;
              const event: SdkLiveAgentRequestEvent = {
                type: 'live_agent_request',
                at: Date.now(),
                telegramUserId: from.id,
              };
              if (chatId !== undefined) {
                event.chatId = chatId;
              }
              if (opts?.note != null) {
                // Date.now() below is fine: this runs in the plugin runtime, not a
                // workflow script.
                event.note = opts.note.slice(0, MAX_LIVE_AGENT_NOTE_LENGTH);
              }
              transport.enqueue(event);
              // Optimistically open the local live-agent window for this chat.
              if (chatId !== undefined) {
                liveAgentWindow.touch(chatId);
              }
            } catch (error) {
              onError(error);
            }
          },
          // Best-effort/optimistic: reads the local window, NOT authoritative
          // server state. See the FlowCastleCtx docs for the caveat.
          get isLiveAgentActive(): boolean {
            const chatId = ctx.chat?.id;
            if (chatId === undefined) {
              return false;
            }
            return liveAgentWindow.isActive(chatId);
          },
          async runFlow(flowKey: string, runOptions?: { inputs?: Record<string, unknown> }): Promise<{ executionId: string; acceptedAt?: number }> {
            if (runtime === undefined) {
              const error = new Error('FlowCastle: runFlow() requires runtime.enabled: true');
              onError(error);
              throw error;
            }
            if (typeof flowKey !== 'string' || flowKey.length === 0) throw new Error('FlowCastle: flowKey must be a non-empty string');
            if (flowcastleUpdate === undefined) throw new Error('FlowCastle: current update could not be sanitized');
            return runtime.runFlow(flowKey, runOptions?.inputs as JsonObject | undefined, flowcastleUpdate);
          },
        };

        (ctx as FlowCastleFlavor<C>).flowcastle = flowcastleCtx;
      } catch (error) {
        // Plugin bookkeeping must never break or delay host handlers.
        onError(error);
      }

      // A claimed runtime update is deliberately consumed; unmatched updates
      // preserve the original observation-only middleware behavior.
      if (runtime !== undefined && flowcastleUpdate !== undefined && runtime.shouldHandle(toRuntimeUpdate(flowcastleUpdate, ctx.me))) {
        await runtime.ingestMatched(flowcastleUpdate);
        return;
      }

      if (flowcastleUpdate !== undefined) {
        transport.enqueue({ type: 'update', at: Date.now(), update: flowcastleUpdate });
      }

      // Always run the host chain for observe/unmatched updates; never wrapped in our try/catch.
      await next();
    };

    const updateId: unknown = (ctx.update as { update_id?: unknown }).update_id;
    if (typeof updateId === 'number') {
      await correlation.run(updateId, run);
    } else {
      await run();
    }
  };

  const enriched: FlowCastleMiddleware<C> = Object.assign(middleware, {
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
  });

  return enriched;
}
